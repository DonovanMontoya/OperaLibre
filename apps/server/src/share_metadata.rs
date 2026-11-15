//! Versioned public book metadata. Never serialize a Book wholesale: it also
//! carries private progress, server identities, URLs and arbitrary raw tags.
use crate::*;

pub(crate) const VERSION: u8 = 1;
pub(crate) const MAX_BYTES: usize = 256 * 1024;

pub(crate) fn with_alignment(
    bytes: Vec<u8>,
    alignment: Option<&crate::share_alignment::AlignmentMetadata>,
) -> anyhow::Result<Vec<u8>> {
    let Some(alignment) = alignment else {
        return Ok(bytes);
    };
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;
    value["alignment"] = serde_json::to_value(alignment)?;
    let bytes = serde_json::to_vec(&value)?;
    anyhow::ensure!(bytes.len() <= MAX_BYTES, "gift metadata exceeds size bound");
    Ok(bytes)
}
const MAX_TIMELINE: f64 = (366 * 24 * 60 * 60) as f64;

fn text(value: &str, maximum: usize) -> anyhow::Result<()> {
    anyhow::ensure!(
        value.chars().count() <= maximum
            && !value.chars().any(|character| character.is_ascii_control()
                && !matches!(character, '\t' | '\n' | '\r')),
        "gift metadata text exceeds bounds"
    );
    Ok(())
}
fn optional(value: &Option<String>, maximum: usize) -> anyhow::Result<()> {
    if let Some(value) = value {
        text(value, maximum)?;
    }
    Ok(())
}
fn genres(values: &[String]) -> anyhow::Result<()> {
    anyhow::ensure!(values.len() <= 64, "too many gift genres");
    for value in values {
        text(value, 256)?;
        anyhow::ensure!(!value.trim().is_empty(), "empty gift genre");
    }
    Ok(())
}

pub(crate) fn selected(book: &Book, selected_ids: &[String]) -> anyhow::Result<Vec<u8>> {
    text(&book.title, 1024)?;
    anyhow::ensure!(!book.title.trim().is_empty(), "empty gift title");
    optional(&book.author, 1024)?;
    optional(&book.narrator, 1024)?;
    optional(&book.description, 32000)?;
    optional(&book.published_date, 256)?;
    optional(&book.asin, 256)?;
    genres(&book.genres)?;
    anyhow::ensure!(book.tags.len() <= 64, "too many gift tags");
    for tag in &book.tags {
        text(&tag.name, 256)?;
        anyhow::ensure!(!tag.name.trim().is_empty(), "empty gift tag");
        optional(&tag.position, 64)?;
    }
    let metadata = &book.metadata;
    for value in [
        &metadata.album,
        &metadata.subtitle,
        &metadata.publisher,
        &metadata.published_date,
        &metadata.language,
        &metadata.series,
        &metadata.series_position,
    ] {
        optional(value, 1024)?;
    }
    optional(&metadata.description, 32000)?;
    genres(&metadata.genres)?;
    let selected_ids: HashSet<&str> = selected_ids.iter().map(String::as_str).collect();
    anyhow::ensure!(selected_ids.len() <= 256, "too many selected gift assets");
    let mut tracks = Vec::new();
    let mut chapter_count = 0_usize;
    let mut duration = 0.0;
    for track in book
        .tracks
        .iter()
        .filter(|track| selected_ids.contains(track.id.as_str()))
    {
        anyhow::ensure!(tracks.len() < 256, "too many gift tracks");
        text(&track.file_name, 255)?;
        text(&track.title, 1024)?;
        anyhow::ensure!(!track.title.trim().is_empty(), "empty gift track title");
        anyhow::ensure!(
            track
                .duration_seconds
                .is_none_or(|value| value.is_finite() && value > 0.0 && value <= MAX_TIMELINE),
            "invalid gift track duration"
        );
        duration += track.duration_seconds.unwrap_or(0.0);
        anyhow::ensure!(duration <= MAX_TIMELINE, "gift timeline exceeds limit");
        chapter_count = chapter_count
            .checked_add(track.chapters.len())
            .ok_or_else(|| anyhow::anyhow!("gift chapter count overflow"))?;
        anyhow::ensure!(chapter_count <= 4096, "too many gift chapters");
        let mut chapters = Vec::new();
        let mut previous = 0.0;
        for chapter in &track.chapters {
            text(&chapter.title, 1024)?;
            anyhow::ensure!(!chapter.title.trim().is_empty(), "empty gift chapter title");
            anyhow::ensure!(
                chapter.start_seconds.is_finite()
                    && chapter.start_seconds >= previous
                    && chapter.start_seconds <= MAX_TIMELINE
                    && chapter.end_seconds.is_none_or(|end| end.is_finite()
                        && end >= chapter.start_seconds
                        && end <= MAX_TIMELINE)
                    && track
                        .duration_seconds
                        .is_none_or(|duration| chapter.start_seconds <= duration
                            && chapter.end_seconds.is_none_or(|end| end <= duration)),
                "invalid gift chapter span"
            );
            previous = chapter.start_seconds;
            chapters.push(serde_json::json!({"title":chapter.title,"startSeconds":chapter.start_seconds,"endSeconds":chapter.end_seconds}));
        }
        tracks.push(serde_json::json!({"fileName":track.file_name,"title":track.title,"index":tracks.len(),"durationSeconds":track.duration_seconds,"chapters":chapters}));
    }
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version":VERSION,"title":book.title,"author":book.author,"narrator":book.narrator,"description":book.description,
        "genres":book.genres,"tags":book.tags,"publishedDate":book.published_date,"asin":book.asin,
        "metadata":{"album":metadata.album,"subtitle":metadata.subtitle,"publisher":metadata.publisher,"publishedDate":metadata.published_date,"description":metadata.description,"language":metadata.language,"series":metadata.series,"seriesPosition":metadata.series_position,"genres":metadata.genres},
        "tracks":tracks,
    }))?;
    anyhow::ensure!(bytes.len() <= MAX_BYTES, "gift metadata exceeds size bound");
    Ok(bytes)
}
