//! An OPDS 1.2 catalogue.
//!
//! OPDS is the closest thing to a lingua franca for "here is a shelf of
//! things you can fetch", and serving one costs almost nothing on top of the
//! library the server already has. Entries carry an acquisition link per
//! track, because an audiobook is a set of files rather than one document.
//!
//! Authentication is the server's own: an `Authorization: Bearer` header, or
//! the read-only `?token=` media credential. Readers that only speak HTTP
//! Basic are not supported — see the note on the module's routes.

use crate::*;

const OPDS_FEED_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=acquisition";
const OPDS_NAVIGATION_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=navigation";

/// Escape text for an XML text node or attribute.
pub(crate) fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        push_xml_escaped(&mut escaped, character);
    }
    escaped
}

/// XML 1.0 permits exactly these scalar ranges. Rust strings cannot contain
/// surrogates, but can contain the forbidden U+FFFE/U+FFFF.
fn push_xml_escaped(out: &mut String, character: char) {
    if !matches!(
        character,
        '\u{9}' | '\u{A}' | '\u{D}'
            | '\u{20}'..='\u{D7FF}'
            | '\u{E000}'..='\u{FFFD}'
            | '\u{10000}'..='\u{10FFFF}'
    ) {
        return;
    }
    match character {
        '&' => out.push_str("&amp;"),
        '<' => out.push_str("&lt;"),
        '>' => out.push_str("&gt;"),
        '"' => out.push_str("&quot;"),
        '\'' => out.push_str("&apos;"),
        character => out.push(character),
    }
}

/// How much escaped text to hand the spool at once. Each piece is checked
/// against the catalogue budgets before it is stored.
const XML_CHUNK: usize = 4096;

fn write_xml_escaped(spool: &mut CatalogueSpool, value: &str) -> Result<(), ApiError> {
    let mut buf = String::with_capacity(XML_CHUNK.min(value.len().saturating_add(8)));
    for character in value.chars() {
        push_xml_escaped(&mut buf, character);
        if buf.len() >= XML_CHUNK {
            spool.bytes(buf.as_bytes())?;
            buf.clear();
        }
    }
    if !buf.is_empty() {
        spool.bytes(buf.as_bytes())?;
    }
    Ok(())
}

/// `xml_escape` of the concatenation, after `trim`. Leading and trailing
/// whitespace are skipped while scanning, so a long description is not copied
/// or escaped in full before the spool can refuse it.
fn write_xml_escaped_trimmed(spool: &mut CatalogueSpool, parts: &[&str]) -> Result<(), ApiError> {
    let mut total = 0usize;
    let mut lead = 0usize;
    let mut leading = true;
    for part in parts {
        for character in part.chars() {
            total += 1;
            if leading {
                if character.is_whitespace() {
                    lead += 1;
                } else {
                    leading = false;
                }
            }
        }
    }
    if lead == total {
        return Ok(());
    }
    let mut trail = 0usize;
    'parts: for part in parts.iter().rev() {
        for character in part.chars().rev() {
            if !character.is_whitespace() {
                break 'parts;
            }
            trail += 1;
        }
    }
    let end = total.saturating_sub(trail);
    if end <= lead {
        return Ok(());
    }
    write_xml_escaped_range(spool, parts, lead, end)
}

fn write_xml_escaped_range(
    spool: &mut CatalogueSpool,
    parts: &[&str],
    start: usize,
    end: usize,
) -> Result<(), ApiError> {
    let mut index = 0usize;
    let mut buf = String::with_capacity(XML_CHUNK);
    for part in parts {
        for character in part.chars() {
            if index >= end {
                if !buf.is_empty() {
                    spool.bytes(buf.as_bytes())?;
                }
                return Ok(());
            }
            if index >= start {
                push_xml_escaped(&mut buf, character);
                if buf.len() >= XML_CHUNK {
                    spool.bytes(buf.as_bytes())?;
                    buf.clear();
                }
            }
            index += 1;
        }
    }
    if !buf.is_empty() {
        spool.bytes(buf.as_bytes())?;
    }
    Ok(())
}

fn write_book_summary(
    spool: &mut CatalogueSpool,
    narrator: Option<&str>,
    description: &str,
    track_count: usize,
    duration_seconds: Option<f64>,
) -> Result<(), ApiError> {
    let suffix = duration_seconds
        .map(|duration| format!("\n\n{track_count} tracks, {:.1} hours.", duration / 3600.0));
    let mut parts = Vec::with_capacity(5);
    if let Some(narrator) = narrator {
        parts.push("Narrated by ");
        parts.push(narrator);
        parts.push(".\n\n");
    }
    parts.push(description);
    if let Some(suffix) = &suffix {
        parts.push(suffix.as_str());
    }
    write_xml_escaped_trimmed(spool, &parts)
}

fn write_opds_entry(
    spool: &mut CatalogueSpool,
    book: &Book,
    updated: &str,
    media_token: &str,
) -> Result<(), ApiError> {
    spool.begin_item();
    spool.bytes(b"  <entry>\n")?;
    spool.bytes(b"    <id>urn:operalibre:book:")?;
    write_xml_escaped(spool, &book.id)?;
    spool.bytes(b"</id>\n")?;
    spool.bytes(b"    <title>")?;
    write_xml_escaped(spool, &book.title)?;
    spool.bytes(b"</title>\n")?;
    spool.bytes(format!("    <updated>{updated}</updated>\n").as_bytes())?;
    if let Some(author) = &book.author {
        spool.bytes(b"    <author><name>")?;
        write_xml_escaped(spool, author)?;
        spool.bytes(b"</name></author>\n")?;
    }
    if let Some(published) = &book.published_date {
        spool.bytes(b"    <dc:issued>")?;
        write_xml_escaped(spool, published)?;
        spool.bytes(b"</dc:issued>\n")?;
    }
    for genre in &book.genres {
        spool.bytes(b"    <category term=\"")?;
        write_xml_escaped(spool, genre)?;
        spool.bytes(b"\"/>\n")?;
    }
    for tag in &book.tags {
        spool.bytes(b"    <category term=\"")?;
        write_xml_escaped(spool, &tag.name)?;
        spool.bytes(b"\" label=\"Tag\"/>\n")?;
    }
    // Narrator and length are what a listener actually chooses on, and OPDS
    // has nowhere structured to put either. Trim and escape the summary
    // without copying the description into one string.
    spool.bytes(b"    <summary type=\"text\">")?;
    write_book_summary(
        spool,
        book.narrator.as_deref(),
        book.description.as_deref().unwrap_or(""),
        book.track_count,
        book.duration_seconds,
    )?;
    spool.bytes(b"</summary>\n")?;
    if book.cover_art_url.is_some() {
        spool.bytes(b"    <link rel=\"http://opds-spec.org/image\" href=\"/api/books/")?;
        write_xml_escaped(spool, &book.id)?;
        spool.bytes(format!("/cover?token={media_token}\"/>\n").as_bytes())?;
    }
    for track in &book.tracks {
        spool.bytes(b"    <link rel=\"http://opds-spec.org/acquisition\" href=\"/api/books/")?;
        write_xml_escaped(spool, &book.id)?;
        spool.bytes(b"/tracks/")?;
        write_xml_escaped(spool, &track.id)?;
        spool.bytes(b"/stream?token=")?;
        spool.bytes(media_token.as_bytes())?;
        spool.bytes(b"\" type=\"")?;
        write_xml_escaped(spool, &media_content_type(FsPath::new(&track.file_name)))?;
        spool.bytes(b"\" title=\"")?;
        write_xml_escaped(spool, &track.title)?;
        spool.bytes(b"\"/>\n")?;
    }
    spool.bytes(b"  </entry>\n")?;
    spool.finish_item()
}

fn feed_response(body: String, content_type: &str) -> Result<Response, ApiError> {
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, "private, no-cache")
        .body(Body::from(body))?)
}

/// The catalogue root: one entry per shelf a reader can open.
pub(crate) async fn opds_root(
    Extension(auth): Extension<AuthUser>,
    Extension(session): Extension<CurrentSession>,
) -> Result<Response, ApiError> {
    let updated = rfc3339_utc(unix_now_seconds());
    let media_token = session.media_token.clone();
    let body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:operalibre:catalog</id>
  <title>OperaLibre</title>
  <updated>{updated}</updated>
  <author><name>OperaLibre</name></author>
  <link rel="self" href="/api/opds?token={media_token}" type="{OPDS_NAVIGATION_TYPE}"/>
  <link rel="start" href="/api/opds?token={media_token}" type="{OPDS_NAVIGATION_TYPE}"/>
  <entry>
    <id>urn:operalibre:catalog:all</id>
    <title>All audiobooks</title>
    <updated>{updated}</updated>
    <content type="text">Everything {username} can listen to.</content>
    <link rel="subsection" href="/api/opds/books?token={media_token}" type="{OPDS_FEED_TYPE}"/>
  </entry>
</feed>
"#,
        username = xml_escape(&auth.username)
    );
    feed_response(body, OPDS_NAVIGATION_TYPE)
}

/// One acquisition entry per book, with a link per track.
pub(crate) async fn opds_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Extension(session): Extension<CurrentSession>,
) -> Result<Response, ApiError> {
    ensure_startup_scan_finished(&state).await?;
    let lease = CatalogueLease::acquire(&state, &auth).await?;
    let library = state.library.clone().read_owned().await;
    let updated = rfc3339_utc(unix_now_seconds());
    let media_token = session.media_token.clone();
    tokio::task::spawn_blocking(move || {
        let mut spool = CatalogueSpool::new(lease)?;
        spool.bytes(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:operalibre:catalog:all</id>
  <title>All audiobooks</title>
  <updated>{updated}</updated>
  <author><name>OperaLibre</name></author>
  <link rel="self" href="/api/opds/books?token={media_token}" type="{OPDS_FEED_TYPE}"/>
  <link rel="start" href="/api/opds?token={media_token}" type="{OPDS_NAVIGATION_TYPE}"/>
"#
            )
            .as_bytes(),
        )?;
        for book in library
            .books
            .iter()
            .filter(|book| can_access_book(&auth, &book.id))
        {
            write_opds_entry(&mut spool, book, &updated, &media_token)?;
        }
        spool.bytes(b"</feed>\n")?;
        spool.response(OPDS_FEED_TYPE, None, None)
    })
    .await
    .map_err(|_| ApiError::internal("Catalogue generation was interrupted."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered_summary(
        narrator: Option<&str>,
        description: &str,
        track_count: usize,
        duration_seconds: Option<f64>,
    ) -> Vec<u8> {
        let mut spool = CatalogueSpool::new(lease_for_tests()).unwrap();
        write_book_summary(
            &mut spool,
            narrator,
            description,
            track_count,
            duration_seconds,
        )
        .unwrap();
        assert!(!spool.has_spilled());
        spool.resident().to_vec()
    }

    fn escaped_summary(
        narrator: Option<&str>,
        description: &str,
        track_count: usize,
        duration_seconds: Option<f64>,
    ) -> Vec<u8> {
        let mut summary = description.to_string();
        if let Some(narrator) = narrator {
            summary = format!("Narrated by {narrator}.\n\n{summary}");
        }
        if let Some(duration) = duration_seconds {
            summary = format!(
                "{summary}\n\n{track_count} tracks, {:.1} hours.",
                duration / 3600.0
            );
        }
        xml_escape(summary.trim()).into_bytes()
    }

    #[test]
    fn streamed_summaries_match_trimmed_xml_escape() {
        let cases = [
            (None, "  hello <world> & \"quotes\"  ", 1, None),
            (Some("Ann & Ben"), "  A tale.\n", 3, Some(7200.0)),
            (Some("Ann"), "   \n", 1, None),
            (Some("Ann"), "", 1, None),
            (None, "", 2, Some(1800.0)),
            (Some("Ann"), "   ", 4, Some(5400.0)),
            (None, "bell\u{7}here \u{FFFE}\u{FFFF}after  ", 1, None),
            (None, " \u{00A0}kept\u{00A0} ", 1, None),
        ];
        for (narrator, description, track_count, duration) in cases {
            assert_eq!(
                rendered_summary(narrator, description, track_count, duration),
                escaped_summary(narrator, description, track_count, duration),
                "{narrator:?} / {description:?} / {duration:?}"
            );
        }
    }

    #[test]
    fn an_oversized_summary_stops_inside_the_catalogue_budget() {
        let mut spool = CatalogueSpool::new(lease_for_tests()).unwrap();
        spool.begin_item();
        let description = "x".repeat(CATALOGUE_BOOK_BYTES as usize + 64 * 1024);
        let rejected =
            write_book_summary(&mut spool, Some("Narrator"), &description, 3, Some(7200.0))
                .unwrap_err();
        assert_eq!(rejected.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(spool.stored_bytes() <= CATALOGUE_BOOK_BYTES);
        assert!(spool.resident().len() as u64 <= CATALOGUE_BOOK_BYTES);
        assert!(spool.resident_capacity() <= CATALOGUE_MEMORY_LIMIT);
        assert!(!spool.has_spilled());
    }
}
