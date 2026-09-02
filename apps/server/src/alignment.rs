//! Readalong sync-map support: EPUB text extraction, echogarden timeline
//! parsing, and conversion into the `.sync.json` sidecar format that maps
//! audiobook timestamps to EPUB text locations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;

/// Version 1 carried sentences only. Version 2 adds the map's precision and
/// optional word timings inside each sentence; a version 1 file still reads.
pub const SYNC_MAP_VERSION: u32 = 2;

/// How the map's timings were produced, which decides how the reader shows
/// them: a forced alignment can drive a word marker, an estimate only a
/// soft sentence marker.
pub const PRECISION_SENTENCE: &str = "sentence";
pub const PRECISION_ESTIMATED: &str = "estimated";

/// The `.sync.json` sidecar format. Fragments are sentence-level spans of the
/// audiobook mapped to a spine document (`href`, as written in the OPF
/// manifest) and the sentence text to locate inside that document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMap {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    /// `sentence` for a forced alignment, `estimated` for an interpolation.
    /// Absent in version 1 files, which were always aligned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision: Option<String>,
    /// For an estimate: how many audio chapters were pinned to a table of
    /// contents entry. Zero means the whole book was interpolated in one
    /// piece, which drifts more.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_count: Option<usize>,
    /// For an estimate: how many listener-placed anchors ("Sync here")
    /// re-timed the text inside its chapters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_anchor_count: Option<usize>,
    pub fragments: Vec<SyncFragment>,
}

impl SyncMap {
    #[cfg(test)]
    pub fn is_estimated(&self) -> bool {
        self.precision.as_deref() == Some(PRECISION_ESTIMATED)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFragment {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub href: String,
    pub text: String,
    /// Word timings inside `text`, when the aligner produced them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<WordTiming>,
}

/// `[startSeconds, endSeconds, offsetUtf16, lengthUtf16]`: a word's span in
/// the audio and its span inside the fragment text. Offsets are UTF-16 code
/// units because the reader is JavaScript. A compact array rather than an
/// object because a long book has a hundred thousand of these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WordTiming(pub f64, pub f64, pub u32, pub u32);

// ---------------------------------------------------------------------------
// EPUB parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SpineSection {
    /// Manifest href exactly as written in the OPF (relative to the OPF dir).
    pub href: String,
    /// Plain text extracted from the document, whitespace-collapsed with
    /// paragraph breaks as `\n\n`.
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct TocEntry {
    pub title: String,
    pub spine_index: usize,
}

#[derive(Debug)]
pub struct EpubDocument {
    pub sections: Vec<SpineSection>,
    pub toc: Vec<TocEntry>,
    /// Pictures declared in the manifest. Used to tell an illustrated
    /// supplement from a text.
    pub image_count: usize,
}

pub fn parse_epub(bytes: &[u8]) -> anyhow::Result<EpubDocument> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;

    let container = read_zip_text(&mut archive, "META-INF/container.xml")
        .ok_or_else(|| anyhow::anyhow!("EPUB is missing META-INF/container.xml"))?;
    let opf_path = find_tags(&container, "rootfile")
        .iter()
        .find_map(|tag| attr_value(tag, "full-path"))
        .ok_or_else(|| anyhow::anyhow!("EPUB container.xml has no rootfile full-path"))?;
    let opf = read_zip_text(&mut archive, &opf_path)
        .ok_or_else(|| anyhow::anyhow!("EPUB package document `{opf_path}` was not found"))?;
    let opf_dir = parent_dir(&opf_path);

    struct ManifestItem {
        href: String,
        media_type: String,
        properties: String,
    }
    let mut manifest = HashMap::new();
    for tag in find_tags(&opf, "item") {
        let (Some(id), Some(href)) = (attr_value(&tag, "id"), attr_value(&tag, "href")) else {
            continue;
        };
        manifest.insert(
            id,
            ManifestItem {
                href,
                media_type: attr_value(&tag, "media-type").unwrap_or_default(),
                properties: attr_value(&tag, "properties").unwrap_or_default(),
            },
        );
    }

    let mut sections = Vec::new();
    let mut section_paths = HashMap::new();
    for tag in find_tags(&opf, "itemref") {
        let Some(idref) = attr_value(&tag, "idref") else {
            continue;
        };
        if attr_value(&tag, "linear").as_deref() == Some("no") {
            continue;
        }
        let Some(item) = manifest.get(&idref) else {
            continue;
        };
        if !item.media_type.contains("html") {
            continue;
        }
        let document_path = resolve_href(&opf_dir, &item.href);
        let Some(document) = read_zip_text(&mut archive, &document_path) else {
            continue;
        };
        let text = html_to_text(&document);
        section_paths.insert(document_path, sections.len());
        sections.push(SpineSection {
            href: item.href.clone(),
            text,
        });
    }

    // Table of contents: prefer the EPUB 3 nav document, fall back to NCX.
    let mut toc_links = Vec::new();
    let nav_item = manifest
        .values()
        .find(|item| item.properties.split_whitespace().any(|p| p == "nav"));
    if let Some(nav_item) = nav_item {
        let nav_path = resolve_href(&opf_dir, &nav_item.href);
        if let Some(nav_document) = read_zip_text(&mut archive, &nav_path) {
            let nav_dir = parent_dir(&nav_path);
            toc_links = parse_nav_links(&nav_document, &nav_dir);
        }
    }
    if toc_links.is_empty() {
        let ncx_item = manifest
            .values()
            .find(|item| item.media_type == "application/x-dtbncx+xml");
        if let Some(ncx_item) = ncx_item {
            let ncx_path = resolve_href(&opf_dir, &ncx_item.href);
            if let Some(ncx_document) = read_zip_text(&mut archive, &ncx_path) {
                let ncx_dir = parent_dir(&ncx_path);
                toc_links = parse_ncx_links(&ncx_document, &ncx_dir);
            }
        }
    }

    let toc = toc_links
        .into_iter()
        .filter_map(|(path, title)| {
            let spine_index = *section_paths.get(&path)?;
            Some(TocEntry { title, spine_index })
        })
        .collect();
    let image_count = manifest
        .values()
        .filter(|item| item.media_type.starts_with("image/"))
        .count();

    Ok(EpubDocument {
        sections,
        toc,
        image_count,
    })
}

fn read_zip_text<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    path: &str,
) -> Option<String> {
    let index = archive
        .index_for_name(path)
        .or_else(|| archive.index_for_name(&percent_decode(path)))?;
    let mut file = archive.by_index(index).ok()?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).ok()?;
    Some(contents)
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(index) => path[..index].to_string(),
        None => String::new(),
    }
}

/// Resolves a (possibly percent-encoded) href relative to a base directory
/// inside the zip, normalizing `.` and `..` segments and stripping fragments.
fn resolve_href(base_dir: &str, href: &str) -> String {
    let href = href.split(['#', '?']).next().unwrap_or("");
    let href = percent_decode(href);
    let mut segments: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };
    for segment in href.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Minimal XML/HTML helpers (attribute scanning, no full parser)
// ---------------------------------------------------------------------------

/// Returns the attribute region of each `<name ...>` tag occurrence.
///
/// Case-insensitive scanning throughout this module uses `to_ascii_lowercase`
/// (never `to_lowercase`): the lowered copy must stay byte-for-byte aligned
/// with the original so offsets found in one can slice the other, and Unicode
/// case folding can change byte lengths (e.g. `İ`).
fn find_tags(xml: &str, name: &str) -> Vec<String> {
    let mut results = Vec::new();
    let lower = xml.to_ascii_lowercase();
    let mut search_from = 0;
    let open = format!("<{name}");
    while let Some(found) = lower[search_from..].find(&open) {
        let start = search_from + found;
        let after = start + open.len();
        let boundary = lower.as_bytes().get(after).copied();
        // Require a tag boundary so `<item` doesn't match `<itemref`.
        if !matches!(
            boundary,
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/') | Some(b'>')
        ) {
            search_from = after;
            continue;
        }
        let Some(end) = xml[after..].find('>') else {
            break;
        };
        results.push(xml[after..after + end].trim_end_matches('/').to_string());
        search_from = after + end + 1;
    }
    results
}

fn attr_value(tag_body: &str, name: &str) -> Option<String> {
    let lower = tag_body.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(found) = lower[search_from..].find(name) {
        let start = search_from + found;
        // Attribute name must start at a boundary and be followed by `=`.
        let boundary_ok =
            start == 0 || matches!(lower.as_bytes()[start - 1], b' ' | b'\t' | b'\n' | b'\r');
        let rest = tag_body[start + name.len()..].trim_start();
        if boundary_ok && rest.starts_with('=') {
            let rest = rest[1..].trim_start();
            let quote = rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let inner = &rest[1..];
                let end = inner.find(quote)?;
                return Some(decode_entities(&inner[..end]));
            }
        }
        search_from = start + name.len();
    }
    None
}

const BLOCK_TAGS: &[&str] = &[
    "p",
    "div",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "tr",
    "blockquote",
    "section",
    "article",
    "aside",
    "figure",
    "figcaption",
    "header",
    "footer",
    "hr",
    "table",
    "ul",
    "ol",
    "dd",
    "dt",
    "nav",
    "title",
];

/// Extracts readable text from an (X)HTML document: skips head/script/style,
/// collapses whitespace, and inserts paragraph breaks at block elements.
pub fn html_to_text(document: &str) -> String {
    let body = document
        .to_ascii_lowercase()
        .find("<body")
        .map(|index| document[index..].to_string())
        .unwrap_or_else(|| document.to_string());

    let mut out = String::new();
    let mut pending_break = false;
    let mut pending_space = false;
    let mut chars = body.char_indices().peekable();
    let bytes = body.as_str();

    while let Some((index, ch)) = chars.next() {
        if ch != '<' {
            for piece in decode_entity_at(bytes, index, &mut chars, ch).chars() {
                if piece.is_whitespace() {
                    pending_space = true;
                } else {
                    if pending_break && !out.is_empty() {
                        out.push_str("\n\n");
                    } else if pending_space && !out.is_empty() && !out.ends_with('\n') {
                        out.push(' ');
                    }
                    pending_break = false;
                    pending_space = false;
                    out.push(piece);
                }
            }
            continue;
        }

        // Comments.
        if bytes[index..].starts_with("<!--") {
            if let Some(end) = bytes[index..].find("-->") {
                skip_to(&mut chars, index + end + 3);
                continue;
            }
            break;
        }

        let Some(end) = bytes[index..].find('>') else {
            break;
        };
        let tag = &bytes[index + 1..index + end];
        let tag_name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_lowercase();

        // Skip container elements whose text should never be narrated.
        if !tag.starts_with('/') && matches!(tag_name.as_str(), "script" | "style" | "head") {
            let close = format!("</{tag_name}");
            let search_start = index + end + 1;
            if let Some(close_at) = bytes[search_start..].to_ascii_lowercase().find(&close) {
                let after_close = search_start + close_at;
                if let Some(close_end) = bytes[after_close..].find('>') {
                    skip_to(&mut chars, after_close + close_end + 1);
                    continue;
                }
            }
        }

        if BLOCK_TAGS.contains(&tag_name.as_str()) {
            pending_break = true;
        }
        skip_to(&mut chars, index + end + 1);
    }

    out
}

fn skip_to(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>, target: usize) {
    while let Some((index, _)) = chars.peek() {
        if *index >= target {
            break;
        }
        chars.next();
    }
}

/// If `ch` starts an entity reference, consumes it and returns the decoded
/// text; otherwise returns `ch` itself.
fn decode_entity_at(
    bytes: &str,
    index: usize,
    chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>,
    ch: char,
) -> String {
    if ch != '&' {
        return ch.to_string();
    }
    let rest = &bytes[index..];
    let Some(end) = find_entity_terminator(rest) else {
        return ch.to_string();
    };
    let entity = &rest[..end + 1];
    let decoded = decode_entities(entity);
    if decoded == entity {
        return ch.to_string();
    }
    skip_to(chars, index + end + 1);
    decoded
}

/// Finds a `;` within the first 12 bytes (the longest entity we decode)
/// without byte-slicing, which could split a multi-byte character.
fn find_entity_terminator(value: &str) -> Option<usize> {
    value
        .char_indices()
        .take_while(|(index, _)| *index < 12)
        .find(|(_, ch)| *ch == ';')
        .map(|(index, _)| index)
}

fn decode_entities(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(end) = find_entity_terminator(rest) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let replacement = match name {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" => Some("'".to_string()),
            "nbsp" => Some(" ".to_string()),
            "hellip" => Some("…".to_string()),
            "mdash" => Some("—".to_string()),
            "ndash" => Some("–".to_string()),
            "lsquo" => Some("‘".to_string()),
            "rsquo" => Some("’".to_string()),
            "ldquo" => Some("“".to_string()),
            "rdquo" => Some("”".to_string()),
            _ => name
                .strip_prefix('#')
                .and_then(|digits| {
                    if let Some(hex) = digits.strip_prefix('x').or(digits.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        digits.parse::<u32>().ok()
                    }
                })
                .and_then(char::from_u32)
                .map(|c| c.to_string()),
        };
        match replacement {
            Some(replacement) => {
                out.push_str(&replacement);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_nav_links(document: &str, base_dir: &str) -> Vec<(String, String)> {
    // Restrict to the toc <nav> element when one is marked, otherwise use the
    // whole document.
    let lower = document.to_ascii_lowercase();
    let scope = lower
        .find("epub:type=\"toc\"")
        .or_else(|| lower.find("epub:type='toc'"))
        .and_then(|marker| {
            let nav_start = lower[..marker].rfind("<nav")?;
            let nav_end = lower[marker..].find("</nav")? + marker;
            Some(&document[nav_start..nav_end])
        })
        .unwrap_or(document);

    let mut links = Vec::new();
    let scope_lower = scope.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(found) = scope_lower[search_from..].find("<a") {
        let start = search_from + found;
        let boundary = scope_lower.as_bytes().get(start + 2).copied();
        if !matches!(
            boundary,
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'>')
        ) {
            search_from = start + 2;
            continue;
        }
        let Some(open_end) = scope[start..].find('>') else {
            break;
        };
        let tag_body = &scope[start + 2..start + open_end];
        let Some(close) = scope_lower[start + open_end..].find("</a") else {
            break;
        };
        let label = strip_tags(&scope[start + open_end + 1..start + open_end + close]);
        if let Some(href) = attr_value(tag_body, "href")
            && !label.is_empty()
        {
            links.push((resolve_href(base_dir, &href), label));
        }
        search_from = start + open_end + close;
    }
    links
}

fn parse_ncx_links(document: &str, base_dir: &str) -> Vec<(String, String)> {
    let mut links = Vec::new();
    let lower = document.to_ascii_lowercase();
    let mut last_label = String::new();
    let mut index = 0;
    while let Some(found) = lower[index..].find('<') {
        let start = index + found;
        if lower[start..].starts_with("<text") {
            let Some(open_end) = document[start..].find('>') else {
                break;
            };
            let content_start = start + open_end + 1;
            let Some(close) = lower[content_start..].find("</text") else {
                break;
            };
            last_label = strip_tags(&document[content_start..content_start + close]);
            index = content_start + close;
        } else if lower[start..].starts_with("<content") {
            let Some(open_end) = document[start..].find('>') else {
                break;
            };
            let tag_body = &document[start + 8..start + open_end];
            if let Some(src) = attr_value(tag_body, "src")
                && !last_label.is_empty()
            {
                links.push((resolve_href(base_dir, &src), last_label.clone()));
            }
            index = start + open_end;
        } else {
            index = start + 1;
        }
    }
    links
}

fn strip_tags(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Transcript building
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct TranscriptSection {
    pub href: String,
    pub start_utf16: u64,
    pub end_utf16: u64,
}

#[derive(Debug)]
pub struct Transcript {
    pub text: String,
    pub sections: Vec<TranscriptSection>,
}

/// Joins section texts with paragraph breaks, recording each section's UTF-16
/// offset range so aligned sentences can be mapped back to their document.
pub fn build_transcript(sections: &[SpineSection]) -> Transcript {
    let mut text = String::new();
    let mut ranges = Vec::new();
    let mut offset: u64 = 0;
    for section in sections {
        let body = section.text.trim();
        if body.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push_str("\n\n");
            offset += 2;
        }
        let length = body.encode_utf16().count() as u64;
        ranges.push(TranscriptSection {
            href: section.href.clone(),
            start_utf16: offset,
            end_utf16: offset + length,
        });
        text.push_str(body);
        offset += length;
    }
    Transcript {
        text,
        sections: ranges,
    }
}

impl Transcript {
    pub fn href_for_offset(&self, offset_utf16: u64) -> Option<&str> {
        let index = self
            .sections
            .partition_point(|section| section.end_utf16 <= offset_utf16);
        let section = self.sections.get(index)?;
        (offset_utf16 >= section.start_utf16).then_some(section.href.as_str())
    }
}

// ---------------------------------------------------------------------------
// Echogarden timeline parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub start_time: f64,
    #[serde(default)]
    pub end_time: f64,
    #[serde(default)]
    pub start_offset_utf16: Option<u64>,
    #[serde(default)]
    pub end_offset_utf16: Option<u64>,
    #[serde(default)]
    pub timeline: Option<Vec<TimelineEntry>>,
}

/// Accepts either a bare timeline array (what the echogarden CLI writes for
/// `.json` outputs) or an object with a `timeline` field.
pub fn parse_timeline(json: &str) -> anyhow::Result<Vec<TimelineEntry>> {
    if let Ok(entries) = serde_json::from_str::<Vec<TimelineEntry>>(json) {
        return Ok(entries);
    }
    #[derive(Deserialize)]
    struct Wrapper {
        timeline: Vec<TimelineEntry>,
    }
    Ok(serde_json::from_str::<Wrapper>(json)?.timeline)
}

fn collect_sentences<'a>(entries: &'a [TimelineEntry], out: &mut Vec<&'a TimelineEntry>) {
    for entry in entries {
        if entry.kind == "sentence" {
            out.push(entry);
        } else if let Some(children) = &entry.timeline {
            collect_sentences(children, out);
        }
    }
}

fn entry_offsets(entry: &TimelineEntry) -> (Option<u64>, Option<u64>) {
    if entry.start_offset_utf16.is_some() || entry.end_offset_utf16.is_some() {
        return (entry.start_offset_utf16, entry.end_offset_utf16);
    }
    let mut start = None;
    let mut end = None;
    if let Some(children) = &entry.timeline {
        for child in children {
            let (child_start, child_end) = entry_offsets(child);
            if start.is_none() {
                start = child_start;
            }
            if child_end.is_some() {
                end = child_end;
            }
        }
    }
    (start, end)
}

/// Converts an alignment timeline into sync fragments, shifting times by
/// `time_offset_seconds` (the containing track's start position in the book).
pub fn fragments_from_timeline(
    entries: &[TimelineEntry],
    transcript: &Transcript,
    time_offset_seconds: f64,
) -> Vec<SyncFragment> {
    let mut sentences = Vec::new();
    collect_sentences(entries, &mut sentences);
    if sentences.is_empty() {
        // Fall back to whatever top-level granularity the engine produced.
        sentences = entries.iter().collect();
    }

    let mut fragments = Vec::new();
    let mut search_cursor = TextCursor::new(&transcript.text);
    for sentence in sentences {
        let text = sentence
            .text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() || sentence.end_time <= sentence.start_time {
            continue;
        }
        let (start_offset, _) = entry_offsets(sentence);
        let href = start_offset
            .and_then(|offset| transcript.href_for_offset(offset))
            .or_else(|| {
                search_cursor
                    .find_utf16_offset(&text)
                    .and_then(|offset| transcript.href_for_offset(offset))
            });
        let Some(href) = href else {
            continue;
        };
        let words = word_timings(sentence, &text, time_offset_seconds);
        fragments.push(SyncFragment {
            start_seconds: time_offset_seconds + sentence.start_time,
            end_seconds: time_offset_seconds + sentence.end_time,
            href: href.to_string(),
            text,
            words,
        });
    }
    fragments
}

fn collect_words<'a>(entry: &'a TimelineEntry, out: &mut Vec<&'a TimelineEntry>) {
    let Some(children) = &entry.timeline else {
        return;
    };
    for child in children {
        if child.kind == "word" {
            out.push(child);
        } else {
            collect_words(child, out);
        }
    }
}

/// Places the aligner's word entries inside the sentence text they came
/// from. Words are located in order, so a repeated word lands on its own
/// occurrence; an entry whose text cannot be found is left out rather than
/// guessed.
fn word_timings(sentence: &TimelineEntry, text: &str, time_offset_seconds: f64) -> Vec<WordTiming> {
    let mut words = Vec::new();
    collect_words(sentence, &mut words);
    let mut timings = Vec::with_capacity(words.len());
    let mut byte_cursor = 0usize;
    let mut utf16_cursor = 0u32;
    for word in words {
        let needle = word.text.trim();
        if needle.is_empty() || word.end_time <= word.start_time {
            continue;
        }
        let Some(found) = text[byte_cursor..].find(needle) else {
            continue;
        };
        let start = byte_cursor + found;
        utf16_cursor += text[byte_cursor..start].encode_utf16().count() as u32;
        let length = needle.encode_utf16().count() as u32;
        timings.push(WordTiming(
            round_millis(time_offset_seconds + word.start_time),
            round_millis(time_offset_seconds + word.end_time),
            utf16_cursor,
            length,
        ));
        utf16_cursor += length;
        byte_cursor = start + needle.len();
    }
    timings
}

fn round_millis(seconds: f64) -> f64 {
    (seconds * 1000.0).round() / 1000.0
}

/// Sequential text search that tracks UTF-16 offsets incrementally, used when
/// timeline entries carry no source offsets.
struct TextCursor<'a> {
    text: &'a str,
    byte_position: usize,
    utf16_position: u64,
}

impl<'a> TextCursor<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            byte_position: 0,
            utf16_position: 0,
        }
    }

    fn find_utf16_offset(&mut self, needle: &str) -> Option<u64> {
        let needle = needle.trim();
        if needle.is_empty() {
            return None;
        }
        let found = self.text[self.byte_position..]
            .find(needle)
            .map(|offset| self.byte_position + offset)
            .or_else(|| self.text.find(needle))?;
        if found < self.byte_position {
            self.byte_position = 0;
            self.utf16_position = 0;
        }
        self.utf16_position += self.text[self.byte_position..found].encode_utf16().count() as u64;
        let found_utf16 = self.utf16_position;
        self.byte_position = found + needle.len();
        self.utf16_position += needle.encode_utf16().count() as u64;
        Some(found_utf16)
    }
}

// ---------------------------------------------------------------------------
// Track-to-chapter scoping for multi-file books
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct TrackScope {
    pub track_index: usize,
    pub section_range: std::ops::Range<usize>,
}

/// The score at or above which two chapter labels are taken to name the
/// same chapter: an exact number, an exact title, or a strong combination.
pub const LABEL_MATCH_THRESHOLD: u32 = 70;

/// Maps each audio track to a run of spine sections by matching track titles
/// against the EPUB table of contents in order. A track that matches nothing
/// is left out of the result — its audio is not aligned — rather than
/// failing the whole book; the error is reserved for finding no chapter at
/// all.
pub fn build_track_scopes(
    track_titles: &[String],
    toc: &[TocEntry],
    section_count: usize,
) -> Result<Vec<TrackScope>, String> {
    if toc.is_empty() {
        return Err(
            "The EPUB has no usable table of contents to match audio tracks against.".to_string(),
        );
    }
    let targets = track_titles
        .iter()
        .map(|title| parse_label(title))
        .collect::<Vec<_>>();
    let items = toc
        .iter()
        .map(|entry| parse_label(&entry.title))
        .collect::<Vec<_>>();
    let starts = anchor_pairs(&match_in_order(&targets, &items), toc);
    if starts.is_empty() {
        return Err(
            "Could not match any audio track to a chapter in the EPUB's table of contents."
                .to_string(),
        );
    }

    Ok(starts
        .iter()
        .enumerate()
        .map(|(position, (track_index, start))| TrackScope {
            track_index: *track_index,
            section_range: *start
                ..starts
                    .get(position + 1)
                    .map(|(_, next_start)| *next_start)
                    .unwrap_or(section_count),
        })
        .collect())
}

/// Turns an in-order match into `(target index, spine index)` anchors whose
/// spine indices strictly increase. Several table-of-contents entries can
/// point into one spine document (a file holding many chapters, each behind
/// an anchor); the first such match keeps the whole document and the rest
/// fold into it, since a section cannot be split without positions the
/// table of contents does not carry.
pub fn anchor_pairs(matched: &[Option<usize>], toc: &[TocEntry]) -> Vec<(usize, usize)> {
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for (target_index, item) in matched.iter().enumerate() {
        let Some(item_index) = item else {
            continue;
        };
        let spine_index = toc[*item_index].spine_index;
        if pairs
            .last()
            .is_some_and(|(_, previous)| spine_index <= *previous)
        {
            continue;
        }
        pairs.push((target_index, spine_index));
    }
    pairs
}

/// Labels that name the book's apparatus rather than its text: an audiobook
/// opens with credits and an EPUB with a title page, and neither has a
/// counterpart on the other side.
fn is_apparatus(label: &ParsedLabel) -> bool {
    const APPARATUS: &[&str] = &[
        "cover",
        "title page",
        "title",
        "copyright",
        "copyright page",
        "dedication",
        "contents",
        "table of contents",
        "epigraph",
        "opening credits",
        "end credits",
        "credits",
        "about the author",
        "also by",
        "also by the author",
        "acknowledgments",
        "acknowledgements",
        "half title",
        "frontispiece",
        "maps",
        "map",
    ];
    label.number.is_none() && APPARATUS.contains(&label.key.as_str())
}

/// Pairs audio chapter labels with table-of-contents labels in order.
///
/// A monotonic alignment rather than a best-match-per-title: chapters are
/// read in order, so a duplicate title ("Interlude" three times) or a weak
/// match lands on the right occurrence. When nothing matches by name or
/// number and both sides list the same number of real chapters, the two are
/// paired by position — a book whose tracks are called `Track 07` still has
/// a seventh chapter.
pub fn match_in_order(targets: &[ParsedLabel], items: &[ParsedLabel]) -> Vec<Option<usize>> {
    let matched = align_labels(targets, items, LABEL_MATCH_THRESHOLD);
    let matched_count = matched.iter().flatten().count();
    if matched_count > 0 || targets.len() < 2 {
        return matched;
    }
    let target_chapters = targets
        .iter()
        .enumerate()
        .filter(|(_, label)| !is_apparatus(label))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let item_chapters = items
        .iter()
        .enumerate()
        .filter(|(_, label)| !is_apparatus(label))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if target_chapters.len() >= 2 && target_chapters.len() == item_chapters.len() {
        let mut ordinal = vec![None; targets.len()];
        for (target_index, item_index) in target_chapters.into_iter().zip(item_chapters) {
            ordinal[target_index] = Some(item_index);
        }
        return ordinal;
    }
    matched
}

/// Monotonic alignment of two label sequences that maximizes the summed
/// match score, counting only pairs at or above `min_score`. Standard
/// dynamic programming over (targets × items); both are chapter lists, so
/// the table is small.
pub fn align_labels(
    targets: &[ParsedLabel],
    items: &[ParsedLabel],
    min_score: u32,
) -> Vec<Option<usize>> {
    let rows = targets.len();
    let columns = items.len();
    let mut best = vec![vec![0u32; columns + 1]; rows + 1];
    // 0: leave the target unmatched, 1: skip the item, 2: pair them.
    let mut choice = vec![vec![0u8; columns + 1]; rows + 1];
    for row in 1..=rows {
        for column in 1..=columns {
            let mut score = best[row - 1][column];
            let mut how = 0u8;
            if best[row][column - 1] > score {
                score = best[row][column - 1];
                how = 1;
            }
            let pair = label_match_score(&targets[row - 1], &items[column - 1]);
            if pair >= min_score && best[row - 1][column - 1] + pair > score {
                score = best[row - 1][column - 1] + pair;
                how = 2;
            }
            best[row][column] = score;
            choice[row][column] = how;
        }
    }
    let mut matched = vec![None; rows];
    let (mut row, mut column) = (rows, columns);
    while row > 0 && column > 0 {
        match choice[row][column] {
            2 => {
                matched[row - 1] = Some(column - 1);
                row -= 1;
                column -= 1;
            }
            1 => column -= 1,
            _ => row -= 1,
        }
    }
    matched
}

#[derive(Debug)]
pub struct ParsedLabel {
    number: Option<u32>,
    /// The lettered series a number belongs to — `i` for an interlude
    /// written `I-3` — so interlude 3 never counts as chapter 3. Empty for
    /// plain chapter numbers.
    series: String,
    key: String,
}

fn normalize_label_text(value: &str) -> String {
    let mut out = String::new();
    let mut last_was_space = true;
    for ch in value.to_lowercase().chars() {
        if ch == '\u{2019}' || ch == '\'' {
            continue;
        }
        if ch == '&' {
            if !last_was_space {
                out.push(' ');
            }
            out.push_str("and");
            out.push(' ');
            last_was_space = true;
            continue;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_space = false;
        } else if !last_was_space {
            out.push(' ');
            last_was_space = true;
        }
    }
    out.trim().to_string()
}

/// "Chapter 000" is chapter zero, not a parse failure. A digit run too long
/// for `u32` is no chapter number at all — timestamp- or ISBN-like digits
/// must not read as chapter zero, or they would out-score a genuine prologue
/// in the exact-number match.
fn parse_chapter_number(digits: &str) -> Option<u32> {
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Some(0);
    }
    significant.parse::<u32>().ok()
}

const LABEL_SEPARATORS: [char; 6] = ['.', ':', ')', '-', '–', '—'];

/// Reads a chapter label into its number and its title.
///
/// The number can be written any way a publisher or narrator writes it —
/// `Chapter 12`, `Chapter Twelve`, `Chapter XII`, `Ch. 12`, `12. The Long
/// Road`, `Twelve: The Long Road` — because the audio's chapter list and the
/// EPUB's table of contents rarely agree on the spelling.
pub fn parse_label(value: &str) -> ParsedLabel {
    let lower = value.to_ascii_lowercase();
    let mut number = None;
    let mut remainder = value.to_string();

    // "Interlude I-3: Kaza" and "I-3. Kaza": a lettered series number.
    if !lower.contains("chapter ")
        && let Some((series, parsed, start, end)) = find_series_number(value)
    {
        let after = value[end..]
            .trim_start()
            .trim_start_matches(LABEL_SEPARATORS)
            .trim_start();
        let before = value[..start]
            .trim_end()
            .trim_end_matches(LABEL_SEPARATORS)
            .trim_end();
        return ParsedLabel {
            number: Some(parsed),
            series,
            key: normalize_label_text(&format!("{before} {after}")),
        };
    }

    let prefix = lower
        .find("chapter ")
        .map(|at| (at, "chapter ".len()))
        .or_else(|| {
            ["ch. ", "ch "]
                .iter()
                .find(|prefix| lower.starts_with(*prefix))
                .map(|prefix| (0, prefix.len()))
        });
    if let Some((found, prefix_len)) = prefix {
        let after = &value[found + prefix_len..];
        if let Some((parsed, consumed)) = parse_number_token(after) {
            number = Some(parsed);
            remainder = after[consumed..]
                .trim_start()
                .trim_start_matches(LABEL_SEPARATORS)
                .trim_start()
                .to_string();
        }
    } else {
        let trimmed = value.trim_start();
        if let Some((parsed, consumed)) = parse_number_token(trimmed) {
            let rest = trimmed[consumed..].trim_start();
            if let Some(rest) = rest.strip_prefix(LABEL_SEPARATORS).map(str::trim_start) {
                number = Some(parsed);
                remainder = rest.to_string();
            }
        }
    }

    ParsedLabel {
        number,
        series: String::new(),
        key: normalize_label_text(&remainder),
    }
}

/// A token of one to three letters, a hyphen, and digits — `I-3`, `E-12` —
/// standing alone in the label. Returns the lower-cased letters, the number,
/// and the token's byte range.
fn find_series_number(value: &str) -> Option<(String, u32, usize, usize)> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_alphabetic() {
            index += 1;
            continue;
        }
        let letters_start = index;
        while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
            index += 1;
        }
        let letters = index - letters_start;
        let at_boundary = letters_start == 0 || !bytes[letters_start - 1].is_ascii_alphanumeric();
        if (1..=3).contains(&letters) && at_boundary && index < bytes.len() && bytes[index] == b'-'
        {
            let digits_start = index + 1;
            let mut digits_end = digits_start;
            while digits_end < bytes.len() && bytes[digits_end].is_ascii_digit() {
                digits_end += 1;
            }
            let ends_cleanly =
                digits_end == bytes.len() || !bytes[digits_end].is_ascii_alphanumeric();
            if digits_end > digits_start
                && ends_cleanly
                && let Some(number) = parse_chapter_number(&value[digits_start..digits_end])
            {
                return Some((
                    value[letters_start..index].to_ascii_lowercase(),
                    number,
                    letters_start,
                    digits_end,
                ));
            }
        }
        // Skip the rest of an alphanumeric run so a token is only tried from
        // its start.
        while index < bytes.len() && bytes[index].is_ascii_alphanumeric() {
            index += 1;
        }
    }
    None
}

/// A chapter number at the start of `value` as digits, a roman numeral, or
/// a spelled-out English number, with the byte length consumed. The token
/// must end at a word boundary so `Chapter Ivory` is not chapter four.
fn parse_number_token(value: &str) -> Option<(u32, usize)> {
    let digits: String = value.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        return parse_chapter_number(&digits).map(|number| (number, digits.len()));
    }
    let word_end = value
        .char_indices()
        .find(|(_, c)| !(c.is_alphabetic() || *c == '-'))
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    let token = &value[..word_end];
    if token.is_empty() {
        return None;
    }
    if let Some(number) = parse_roman_numeral(token) {
        return Some((number, token.len()));
    }
    let lower = token.to_ascii_lowercase();
    // "twenty two" with a space: the two-word form must be tried first, or
    // "twenty" alone would claim the match.
    let rest = &value[word_end..];
    if let Some(rest) = rest.strip_prefix(' ') {
        let second_end = rest
            .char_indices()
            .find(|(_, c)| !c.is_alphabetic())
            .map(|(index, _)| index)
            .unwrap_or(rest.len());
        let second = rest[..second_end].to_ascii_lowercase();
        if !second.is_empty()
            && let Some(number) = parse_number_words(&format!("{lower}-{second}"))
        {
            return Some((number, word_end + 1 + second_end));
        }
    }
    parse_number_words(&lower).map(|number| (number, token.len()))
}

/// Uppercase roman numerals only, and only up to a plausible chapter count:
/// title case and long forms are far more likely to be words (`Mix`, `Dix`).
fn parse_roman_numeral(token: &str) -> Option<u32> {
    if token.is_empty() || !token.chars().all(|c| "IVXLCDM".contains(c)) {
        return None;
    }
    let value_of = |c: char| match c {
        'I' => 1,
        'V' => 5,
        'X' => 10,
        'L' => 50,
        'C' => 100,
        'D' => 500,
        _ => 1000,
    };
    let chars: Vec<char> = token.chars().collect();
    let mut total = 0u32;
    for (index, c) in chars.iter().enumerate() {
        let value = value_of(*c);
        let next = chars.get(index + 1).map(|c| value_of(*c)).unwrap_or(0);
        if value < next {
            total = total.checked_sub(value)?;
        } else {
            total += value;
        }
    }
    // Round-trip through the canonical spelling so `IIII` and `VX` are
    // rejected rather than read as some number.
    (total > 0 && total <= 200 && roman_numeral(total) == token).then_some(total)
}

fn roman_numeral(mut value: u32) -> String {
    const TABLE: &[(u32, &str)] = &[
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut out = String::new();
    for (amount, letters) in TABLE {
        while value >= *amount {
            out.push_str(letters);
            value -= amount;
        }
    }
    out
}

/// `one` … `ninety-nine`, hyphenated, in lower case.
fn parse_number_words(token: &str) -> Option<u32> {
    const UNITS: &[&str] = &[
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: &[(&str, u32)] = &[
        ("twenty", 20),
        ("thirty", 30),
        ("forty", 40),
        ("fifty", 50),
        ("sixty", 60),
        ("seventy", 70),
        ("eighty", 80),
        ("ninety", 90),
    ];
    if let Some(position) = UNITS.iter().position(|unit| *unit == token) {
        return Some(position as u32);
    }
    let (tens, unit) = match token.split_once('-') {
        Some((tens, unit)) => (tens, Some(unit)),
        None => (token, None),
    };
    let tens_value = TENS
        .iter()
        .find(|(word, _)| *word == tens)
        .map(|(_, value)| *value)?;
    match unit {
        None => Some(tens_value),
        Some(unit) => UNITS[1..10]
            .iter()
            .position(|word| *word == unit)
            .map(|position| tens_value + position as u32 + 1),
    }
}

pub fn label_match_score(target: &ParsedLabel, item: &ParsedLabel) -> u32 {
    let mut score = 0;
    if let (Some(target_number), Some(item_number)) = (target.number, item.number)
        && target_number == item_number
        && target.series == item.series
    {
        score += 100;
    }
    if !target.key.is_empty() && !item.key.is_empty() {
        if target.key == item.key {
            score += 80;
        } else if target.key.contains(&item.key) || item.key.contains(&target.key) {
            score += 45;
        } else {
            let target_words: std::collections::HashSet<&str> = target
                .key
                .split(' ')
                .filter(|word| word.len() > 3)
                .collect();
            let shared = item
                .key
                .split(' ')
                .filter(|word| word.len() > 3 && target_words.contains(word))
                .count() as u32;
            score += (shared * 10).min(35);
        }
    }
    score
}

// ---------------------------------------------------------------------------
// Estimated sync maps
// ---------------------------------------------------------------------------

/// One chapter of the audio, in book-absolute seconds.
#[derive(Debug, Clone)]
pub struct AudioChapter {
    pub title: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sentence {
    pub href: String,
    pub text: String,
    pub paragraph_start: bool,
}

/// Splits a section's extracted text into sentences. Every piece is a
/// verbatim, whitespace-collapsed substring of the document, which is what
/// lets the reader find it again on the page.
pub fn split_sentences(href: &str, text: &str) -> Vec<Sentence> {
    let mut out = Vec::new();
    for paragraph in text.split("\n\n") {
        let paragraph = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
        if paragraph.is_empty() {
            continue;
        }
        let mut paragraph_start = true;
        for sentence in split_paragraph(&paragraph) {
            out.push(Sentence {
                href: href.to_string(),
                text: sentence,
                paragraph_start,
            });
            paragraph_start = false;
        }
    }
    out
}

/// Cuts a paragraph after a terminator (and any closing quote or bracket
/// that follows it) when whitespace comes next. `3.5` and `e.g.` are not cut
/// because no space follows the stop; `Mr. Smith` is, which only makes one
/// sentence into two short ones.
fn split_paragraph(paragraph: &str) -> Vec<String> {
    let chars: Vec<char> = paragraph.chars().collect();
    let mut sentences = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < chars.len() {
        if matches!(chars[index], '.' | '!' | '?' | '…') {
            let mut end = index + 1;
            while end < chars.len()
                && matches!(
                    chars[end],
                    '.' | '!' | '?' | '"' | '\'' | '”' | '’' | ')' | ']' | '»'
                )
            {
                end += 1;
            }
            if end >= chars.len() || chars[end].is_whitespace() {
                let sentence: String = chars[start..end].iter().collect();
                let sentence = sentence.trim();
                if !sentence.is_empty() {
                    sentences.push(sentence.to_string());
                }
                start = end;
                index = end;
                continue;
            }
        }
        index += 1;
    }
    let tail: String = chars[start..].iter().collect();
    let tail = tail.trim();
    if !tail.is_empty() {
        sentences.push(tail.to_string());
    }
    sentences
}

// ---------------------------------------------------------------------------
// Reading model: how long a narrator spends on text
// ---------------------------------------------------------------------------

/// What in a stretch of text costs a narrator time.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TextFeatures {
    /// UTF-16 units of text.
    pub chars: f64,
    pub sentences: f64,
    pub paragraphs: f64,
    /// Units of text inside spoken lines, which narrators pace differently.
    pub dialogue_chars: f64,
}

impl TextFeatures {
    fn add(&mut self, other: &TextFeatures) {
        self.chars += other.chars;
        self.sentences += other.sentences;
        self.paragraphs += other.paragraphs;
        self.dialogue_chars += other.dialogue_chars;
    }
}

#[cfg(test)]
pub fn sentence_features_for_test(sentence: &Sentence) -> TextFeatures {
    sentence_features(sentence)
}

fn sentence_features(sentence: &Sentence) -> TextFeatures {
    let chars = sentence.text.encode_utf16().count() as f64;
    let dialogue = sentence
        .text
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '"' | '“' | '‘' | '\'' | '«' | '—'));
    TextFeatures {
        chars,
        sentences: 1.0,
        paragraphs: if sentence.paragraph_start { 1.0 } else { 0.0 },
        dialogue_chars: if dialogue { chars } else { 0.0 },
    }
}

/// Seconds a narrator spends per unit of text. The defaults are a typical
/// audiobook pace — about 150 words a minute with a beat at every full stop
/// and a longer one at every paragraph. `fit` calibrates them to one book's
/// narrator from its chapters' known lengths.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadingModel {
    pub char_seconds: f64,
    pub sentence_seconds: f64,
    pub paragraph_seconds: f64,
    /// Seconds per character of dialogue on top of (or, negative, instead
    /// of) the plain rate.
    pub dialogue_char_seconds: f64,
}

impl Default for ReadingModel {
    fn default() -> Self {
        Self {
            char_seconds: 1.0 / 14.0,
            sentence_seconds: 0.45,
            paragraph_seconds: 0.9,
            dialogue_char_seconds: 0.0,
        }
    }
}

/// Fewer chapters than this and a fit is more noise than narrator.
const MIN_FIT_SAMPLES: usize = 8;

impl ReadingModel {
    pub fn seconds(&self, features: &TextFeatures) -> f64 {
        (self.char_seconds * features.chars
            + self.sentence_seconds * features.sentences
            + self.paragraph_seconds * features.paragraphs
            + self.dialogue_char_seconds * features.dialogue_chars)
            .max(0.05)
    }

    fn as_array(&self) -> [f64; 4] {
        [
            self.char_seconds,
            self.sentence_seconds,
            self.paragraph_seconds,
            self.dialogue_char_seconds,
        ]
    }

    /// Least squares over `(text, seconds)` samples — one per audio chapter
    /// pinned to its text — pulled gently toward the defaults so a book with
    /// a few odd chapters (credits folded into one, a map page into another)
    /// cannot produce a nonsense pace. Every rate is then clamped to what a
    /// human narrator can do.
    pub fn fit(samples: &[(TextFeatures, f64)]) -> ReadingModel {
        let prior = ReadingModel::default();
        let usable = samples
            .iter()
            .filter(|(features, seconds)| features.chars > 0.0 && *seconds > 0.0)
            .collect::<Vec<_>>();
        if usable.len() < MIN_FIT_SAMPLES {
            return prior;
        }
        let rows = usable
            .iter()
            .map(|(features, seconds)| {
                (
                    [
                        features.chars,
                        features.sentences,
                        features.paragraphs,
                        features.dialogue_chars,
                    ],
                    *seconds,
                )
            })
            .collect::<Vec<_>>();
        let prior_values = prior.as_array();
        // Ridge toward the prior. Each rate's pull is a small share of that
        // feature's own energy in the data, so an error of `d` in the rate
        // costs the same whether it comes from the data or from the prior,
        // and the strength does not depend on units.
        const PRIOR_SHARE: f64 = 0.03;
        let mut normal = [[0.0f64; 4]; 4];
        let mut rhs = [0.0f64; 4];
        for (x, y) in &rows {
            for i in 0..4 {
                rhs[i] += x[i] * y;
                for j in 0..4 {
                    normal[i][j] += x[i] * x[j];
                }
            }
        }
        for i in 0..4 {
            let energy = rows.iter().map(|(x, _)| x[i] * x[i]).sum::<f64>();
            let pull = PRIOR_SHARE * energy.max(1.0);
            normal[i][i] += pull;
            rhs[i] += pull * prior_values[i];
        }
        let Some(solution) = solve_4x4(normal, rhs) else {
            return prior;
        };
        ReadingModel {
            char_seconds: solution[0].clamp(0.045, 0.12),
            sentence_seconds: solution[1].clamp(0.0, 1.5),
            paragraph_seconds: solution[2].clamp(0.0, 3.0),
            dialogue_char_seconds: solution[3].clamp(-0.03, 0.03),
        }
    }
}

/// Gaussian elimination with partial pivoting; `None` for a singular system.
fn solve_4x4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> Option<[f64; 4]> {
    for column in 0..4 {
        let pivot =
            (column..4).max_by(|x, y| a[*x][column].abs().total_cmp(&a[*y][column].abs()))?;
        if a[pivot][column].abs() < 1e-12 {
            return None;
        }
        a.swap(column, pivot);
        b.swap(column, pivot);
        for row in column + 1..4 {
            let factor = a[row][column] / a[column][column];
            let pivot_row = a[column];
            for (k, value) in a[row].iter_mut().enumerate().skip(column) {
                *value -= factor * pivot_row[k];
            }
            b[row] -= factor * b[column];
        }
    }
    let mut x = [0.0; 4];
    for row in (0..4).rev() {
        let mut sum = b[row];
        for k in row + 1..4 {
            sum -= a[row][k] * x[k];
        }
        x[row] = sum / a[row][row];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

// ---------------------------------------------------------------------------
// Estimated sync maps
// ---------------------------------------------------------------------------

/// A stretch of audio pinned to a run of spine sections.
#[derive(Debug, Clone, PartialEq)]
pub struct EstimateAnchor {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub section_range: std::ops::Range<usize>,
}

/// A listener's correction: "this sentence is being read at this second".
/// Placed from the reader while listening, and kept with the book so every
/// later estimate is timed through it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualAnchor {
    pub href: String,
    pub text: String,
    pub seconds: f64,
}

/// Pins the audio's chapters to the EPUB's chapters. An audio chapter that
/// matches nothing (credits, an unnamed split) folds into the anchor before
/// it; table-of-contents entries between two matches fold into the earlier
/// one. With no match at all the whole book is one anchor, minus the
/// apparatus sections a narrator never reads.
pub fn estimate_anchors(
    epub: &EpubDocument,
    chapters: &[AudioChapter],
    book_duration_seconds: f64,
) -> (Vec<EstimateAnchor>, usize) {
    if !chapters.is_empty() && !epub.toc.is_empty() {
        let targets = chapters
            .iter()
            .map(|chapter| parse_label(&chapter.title))
            .collect::<Vec<_>>();
        let items = epub
            .toc
            .iter()
            .map(|entry| parse_label(&entry.title))
            .collect::<Vec<_>>();
        let pairs = anchor_pairs(&match_in_order(&targets, &items), &epub.toc);
        if !pairs.is_empty() {
            let book_end = chapters
                .last()
                .map(|chapter| chapter.end_seconds)
                .unwrap_or(book_duration_seconds)
                .max(book_duration_seconds);
            let anchors = pairs
                .iter()
                .enumerate()
                .map(|(position, (chapter_index, spine_index))| {
                    let next = pairs.get(position + 1);
                    EstimateAnchor {
                        start_seconds: chapters[*chapter_index].start_seconds,
                        end_seconds: next
                            .map(|(next_chapter, _)| chapters[*next_chapter].start_seconds)
                            .unwrap_or(book_end),
                        section_range: *spine_index
                            ..next
                                .map(|(_, next_spine)| *next_spine)
                                .unwrap_or(epub.sections.len()),
                    }
                })
                .collect::<Vec<_>>();
            let count = anchors.len();
            return (anchors, count);
        }
    }
    if book_duration_seconds <= 0.0 {
        return (Vec::new(), 0);
    }
    (
        vec![EstimateAnchor {
            start_seconds: 0.0,
            end_seconds: book_duration_seconds,
            section_range: 0..epub.sections.len(),
        }],
        0,
    )
}

/// Spine indices the table of contents labels as apparatus (title page,
/// copyright, contents), which the narrator does not read.
fn apparatus_sections(epub: &EpubDocument) -> std::collections::HashSet<usize> {
    epub.toc
        .iter()
        .filter(|entry| is_apparatus(&parse_label(&entry.title)))
        .map(|entry| entry.spine_index)
        .collect()
}

/// The chapter anchors with their sentences, and the narrator model fitted
/// to them. Shared by the estimate and by the diagnostics.
pub struct EstimatePlan {
    pub anchors: Vec<(EstimateAnchor, Vec<Sentence>)>,
    pub anchor_count: usize,
    pub model: ReadingModel,
}

pub fn plan_estimate(
    epub: &EpubDocument,
    chapters: &[AudioChapter],
    book_duration_seconds: f64,
) -> EstimatePlan {
    let (anchors, anchor_count) = estimate_anchors(epub, chapters, book_duration_seconds);
    let skipped = if anchor_count == 0 {
        apparatus_sections(epub)
    } else {
        Default::default()
    };
    let anchors = anchors
        .into_iter()
        .map(|anchor| {
            let sentences = anchor
                .section_range
                .clone()
                .filter(|index| !skipped.contains(index))
                .filter_map(|index| epub.sections.get(index))
                .flat_map(|section| split_sentences(&section.href, &section.text))
                .collect::<Vec<_>>();
            (anchor, sentences)
        })
        .collect::<Vec<_>>();
    let samples = anchors
        .iter()
        .map(|(anchor, sentences)| {
            let mut features = TextFeatures::default();
            for sentence in sentences {
                features.add(&sentence_features(sentence));
            }
            (features, anchor.end_seconds - anchor.start_seconds)
        })
        .collect::<Vec<_>>();
    let model = if anchor_count >= MIN_FIT_SAMPLES {
        ReadingModel::fit(&samples)
    } else {
        ReadingModel::default()
    };
    EstimatePlan {
        anchors,
        anchor_count,
        model,
    }
}

/// Times every sentence of the EPUB by interpolation: each anchor's audio
/// span is shared out among its sentences in proportion to the seconds the
/// narrator model gives them. Narration speed is steady enough within a
/// chapter that this lands within a few sentences of the truth — good enough
/// to keep the page and paragraph in step, not to mark a word — and a
/// listener's manual anchors split a chapter into shorter spans that drift
/// less.
pub fn estimate_sync_map(
    epub: &EpubDocument,
    chapters: &[AudioChapter],
    book_duration_seconds: f64,
    manual_anchors: &[ManualAnchor],
) -> Result<SyncMap, String> {
    let plan = plan_estimate(epub, chapters, book_duration_seconds);
    if plan.anchors.is_empty() {
        return Err("The book's length is unknown, so its text cannot be timed.".to_string());
    }
    let mut fragments = Vec::new();
    let mut manual_used = 0;
    for (anchor, sentences) in &plan.anchors {
        let span = anchor.end_seconds - anchor.start_seconds;
        if sentences.is_empty() || span <= 0.0 {
            continue;
        }
        // Listener anchors inside this chapter. Text order and time order
        // must agree; when two anchors contradict each other the newer tap
        // (later in the list) wins, since it is the listener's correction.
        let candidates = manual_anchors
            .iter()
            .filter(|pin| pin.seconds > anchor.start_seconds && pin.seconds < anchor.end_seconds)
            .filter_map(|pin| {
                sentences
                    .iter()
                    .position(|sentence| sentence.href == pin.href && sentence.text == pin.text)
                    .filter(|index| *index > 0)
                    .map(|index| (index, pin.seconds))
            })
            .collect::<Vec<_>>();
        let mut pins: Vec<(usize, f64)> = Vec::new();
        for (index, seconds) in candidates.into_iter().rev() {
            let consistent = pins.iter().all(|(other_index, other_seconds)| {
                index != *other_index
                    && seconds != *other_seconds
                    && ((index < *other_index) == (seconds < *other_seconds))
            });
            if consistent {
                pins.push((index, seconds));
            }
        }
        pins.sort_by_key(|pin| pin.0);
        manual_used += pins.len();
        let mut boundaries: Vec<(usize, f64)> = vec![(0, anchor.start_seconds)];
        boundaries.extend(pins);
        boundaries.push((sentences.len(), anchor.end_seconds));
        for window in boundaries.windows(2) {
            let (from, start) = window[0];
            let (to, end) = window[1];
            let slice = &sentences[from..to];
            let total: f64 = slice
                .iter()
                .map(|sentence| plan.model.seconds(&sentence_features(sentence)))
                .sum();
            let mut cursor = start;
            for sentence in slice {
                let duration =
                    (end - start) * plan.model.seconds(&sentence_features(sentence)) / total;
                fragments.push(SyncFragment {
                    start_seconds: round_millis(cursor),
                    end_seconds: round_millis(cursor + duration),
                    href: sentence.href.clone(),
                    text: sentence.text.clone(),
                    words: Vec::new(),
                });
                cursor += duration;
            }
        }
    }
    if fragments.is_empty() {
        return Err("No readable sentences were found in the EPUB.".to_string());
    }
    Ok(SyncMap {
        version: SYNC_MAP_VERSION,
        generator: Some("estimate".to_string()),
        generated_at: None,
        precision: Some(PRECISION_ESTIMATED.to_string()),
        anchor_count: Some(plan.anchor_count),
        manual_anchor_count: Some(manual_used),
        fragments,
    })
}

/// A two-chapter EPUB with a navigation document, for tests across the
/// crate: the alignment, the companion classifier, and the HTTP routes.
#[cfg(test)]
pub(crate) fn build_test_epub() -> Vec<u8> {
    build_test_epub_with_text(
        "<h1>Chapter 1</h1><p>The meadow was quiet. Bees drifted between flowers.</p>",
        "<h1>Chapter 2</h1><p>The river ran fast &amp; cold.</p>",
    )
}

#[cfg(test)]
pub(crate) fn build_test_epub_with_text(chapter_one: &str, chapter_two: &str) -> Vec<u8> {
    use std::io::Write;
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options: zip::write::SimpleFileOptions = Default::default();
        writer.start_file("mimetype", options).unwrap();
        writer.write_all(b"application/epub+zip").unwrap();
        writer
            .start_file("META-INF/container.xml", options)
            .unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0"?><container><rootfiles>
                <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                </rootfiles></container>"#,
            )
            .unwrap();
        writer.start_file("OEBPS/content.opf", options).unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0"?><package><manifest>
                <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
                <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
                <item id="css" href="style.css" media-type="text/css"/>
                <item id="map" href="images/map.png" media-type="image/png"/>
                </manifest><spine>
                <itemref idref="c1"/><itemref idref="c2"/>
                </spine></package>"#,
            )
            .unwrap();
        writer.start_file("OEBPS/nav.xhtml", options).unwrap();
        writer
            .write_all(
                br#"<html><body><nav epub:type="toc"><ol>
                <li><a href="text/ch1.xhtml">Chapter 1: The Meadow</a></li>
                <li><a href="text/ch2.xhtml">Chapter 2: The River</a></li>
                </ol></nav></body></html>"#,
            )
            .unwrap();
        writer.start_file("OEBPS/text/ch1.xhtml", options).unwrap();
        writer
            .write_all(
                format!(
                    "<html><head><title>Ignored</title><style>p{{}}</style></head><body>{chapter_one}</body></html>"
                )
                .as_bytes(),
            )
            .unwrap();
        writer.start_file("OEBPS/text/ch2.xhtml", options).unwrap();
        writer
            .write_all(format!("<html><body>{chapter_two}</body></html>").as_bytes())
            .unwrap();
        writer.finish().unwrap();
    }
    buffer.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_epub_spine_and_toc() {
        let epub = parse_epub(&build_test_epub()).unwrap();
        assert_eq!(epub.sections.len(), 2);
        assert_eq!(epub.sections[0].href, "text/ch1.xhtml");
        assert!(epub.sections[0].text.contains("The meadow was quiet."));
        assert!(!epub.sections[0].text.contains("Ignored"));
        assert!(!epub.sections[0].text.contains("p{}"));
        assert!(epub.sections[1].text.contains("fast & cold"));
        assert_eq!(epub.toc.len(), 2);
        assert_eq!(epub.toc[0].title, "Chapter 1: The Meadow");
        assert_eq!(epub.toc[1].spine_index, 1);
    }

    #[test]
    fn html_to_text_inserts_paragraph_breaks() {
        let text = html_to_text("<body><h1>Title</h1><p>One   two.</p><p>Three.</p></body>");
        assert_eq!(text, "Title\n\nOne two.\n\nThree.");
    }

    #[test]
    fn html_to_text_survives_multibyte_near_bare_ampersand() {
        // A bare `&` followed by multi-byte characters inside the entity
        // scan window must not split a UTF-8 character.
        let text = html_to_text("<body><p>Fish &— chips &“quoted” Ω&Ωμ; end</p></body>");
        assert!(text.contains("Fish"));
        assert!(text.contains("chips"));
        let text = html_to_text("<body><p>&abcdefghij—x</p></body>");
        assert!(text.contains("abcdefghij"));
    }

    #[test]
    fn html_to_text_keeps_offsets_with_unicode_case_folding() {
        // `İ` changes byte length under Unicode lowercasing; scanning must
        // stay aligned with the original bytes.
        let text = html_to_text(
            "<html><head><title>İİİİ</title></head><body><p>İstanbul is old.</p></body></html>",
        );
        assert!(text.contains("İstanbul is old."));
        assert!(!text.contains("İİİİ"));
    }

    #[test]
    fn parse_label_handles_unicode_titles() {
        let label = parse_label("İİİİ Chapter 4: Bosphorus");
        assert_eq!(label.number, Some(4));
        assert_eq!(label.key, "bosphorus");
    }

    #[test]
    fn transcript_maps_offsets_to_sections() {
        let sections = vec![
            SpineSection {
                href: "a.xhtml".into(),
                text: "Hello there.".into(),
            },
            SpineSection {
                href: "b.xhtml".into(),
                text: "General Kenobi.".into(),
            },
        ];
        let transcript = build_transcript(&sections);
        assert_eq!(transcript.text, "Hello there.\n\nGeneral Kenobi.");
        assert_eq!(transcript.href_for_offset(0), Some("a.xhtml"));
        assert_eq!(transcript.href_for_offset(11), Some("a.xhtml"));
        assert_eq!(transcript.href_for_offset(14), Some("b.xhtml"));
        assert_eq!(transcript.href_for_offset(100), None);
    }

    #[test]
    fn timeline_converts_to_fragments() {
        let json = r#"[
            { "type": "segment", "text": "Hello there.", "startTime": 0.0, "endTime": 2.0,
              "timeline": [
                { "type": "sentence", "text": "Hello there.", "startTime": 0.0, "endTime": 2.0,
                  "timeline": [
                    { "type": "word", "text": "Hello", "startTime": 0.0, "endTime": 1.0,
                      "startOffsetUtf16": 0, "endOffsetUtf16": 5 },
                    { "type": "word", "text": "there", "startTime": 1.0, "endTime": 2.0,
                      "startOffsetUtf16": 6, "endOffsetUtf16": 11 }
                  ] }
              ] },
            { "type": "segment", "text": "General Kenobi.", "startTime": 2.0, "endTime": 4.0,
              "timeline": [
                { "type": "sentence", "text": "General Kenobi.", "startTime": 2.0, "endTime": 4.0,
                  "timeline": [
                    { "type": "word", "text": "General", "startTime": 2.0, "endTime": 3.0,
                      "startOffsetUtf16": 14, "endOffsetUtf16": 21 }
                  ] }
              ] }
        ]"#;
        let entries = parse_timeline(json).unwrap();
        let sections = vec![
            SpineSection {
                href: "a.xhtml".into(),
                text: "Hello there.".into(),
            },
            SpineSection {
                href: "b.xhtml".into(),
                text: "General Kenobi.".into(),
            },
        ];
        let transcript = build_transcript(&sections);
        let fragments = fragments_from_timeline(&entries, &transcript, 10.0);
        assert_eq!(fragments.len(), 2);
        assert_eq!(fragments[0].href, "a.xhtml");
        assert_eq!(fragments[0].start_seconds, 10.0);
        assert_eq!(fragments[0].text, "Hello there.");
        assert_eq!(fragments[1].href, "b.xhtml");
        assert_eq!(fragments[1].end_seconds, 14.0);
    }

    #[test]
    fn timeline_fallback_uses_text_search() {
        let json = r#"[
            { "type": "sentence", "text": "General Kenobi.", "startTime": 0.0, "endTime": 2.0 }
        ]"#;
        let entries = parse_timeline(json).unwrap();
        let transcript = build_transcript(&[
            SpineSection {
                href: "a.xhtml".into(),
                text: "Hello there.".into(),
            },
            SpineSection {
                href: "b.xhtml".into(),
                text: "General Kenobi.".into(),
            },
        ]);
        let fragments = fragments_from_timeline(&entries, &transcript, 0.0);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].href, "b.xhtml");
    }

    #[test]
    fn timeline_fallback_advances_past_repeated_text() {
        let json = r#"[
            { "type": "sentence", "text": "The end.", "startTime": 0.0, "endTime": 1.0 },
            { "type": "sentence", "text": "The end.", "startTime": 1.0, "endTime": 2.0 }
        ]"#;
        let entries = parse_timeline(json).unwrap();
        let transcript = build_transcript(&[
            SpineSection {
                href: "a.xhtml".into(),
                text: "The end.".into(),
            },
            SpineSection {
                href: "b.xhtml".into(),
                text: "The end.".into(),
            },
        ]);
        let fragments = fragments_from_timeline(&entries, &transcript, 0.0);
        assert_eq!(fragments.len(), 2);
        assert_eq!(fragments[0].href, "a.xhtml");
        assert_eq!(fragments[1].href, "b.xhtml");
    }

    #[test]
    fn track_scopes_match_by_chapter_number_and_title() {
        let toc = vec![
            TocEntry {
                title: "Chapter 1: The Meadow".into(),
                spine_index: 1,
            },
            TocEntry {
                title: "Chapter 2: The River".into(),
                spine_index: 2,
            },
        ];
        let titles = vec!["01 - The Meadow".to_string(), "02 - The River".to_string()];
        let scopes = build_track_scopes(&titles, &toc, 4).unwrap();
        assert_eq!(
            scopes,
            vec![
                TrackScope {
                    track_index: 0,
                    section_range: 1..2
                },
                TrackScope {
                    track_index: 1,
                    section_range: 2..4
                },
            ]
        );
    }

    #[test]
    fn track_scopes_fail_without_confident_match() {
        let toc = vec![TocEntry {
            title: "Prologue".into(),
            spine_index: 0,
        }];
        let titles = vec!["Part 7".to_string()];
        assert!(build_track_scopes(&titles, &toc, 3).is_err());
    }

    #[test]
    fn parse_label_extracts_numbers() {
        let label = parse_label("Chapter 12: The Long Road");
        assert_eq!(label.number, Some(12));
        assert_eq!(label.key, "the long road");

        let label = parse_label("03 - Owl Post");
        assert_eq!(label.number, Some(3));
        assert_eq!(label.key, "owl post");
    }

    #[test]
    fn sync_map_round_trips() {
        let map = SyncMap {
            version: SYNC_MAP_VERSION,
            generator: Some("echogarden".into()),
            generated_at: None,
            precision: Some(PRECISION_SENTENCE.into()),
            anchor_count: None,
            manual_anchor_count: None,
            fragments: vec![SyncFragment {
                start_seconds: 1.5,
                end_seconds: 3.25,
                href: "text/ch1.xhtml".into(),
                text: "Hello.".into(),
                words: vec![WordTiming(1.5, 3.25, 0, 5)],
            }],
        };
        let json = serde_json::to_string(&map).unwrap();
        let parsed: SyncMap = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.fragments[0].href, "text/ch1.xhtml");
        assert_eq!(parsed.fragments[0].words, vec![WordTiming(1.5, 3.25, 0, 5)]);
        assert!(json.contains("startSeconds"));
        assert!(json.contains("\"words\":[[1.5,3.25,0,5]]"));
        assert!(!parsed.is_estimated());
    }

    /// Maps written before precision and word timings existed still load,
    /// and read as aligned rather than estimated.
    #[test]
    fn a_version_one_sync_map_still_reads() {
        let json = r#"{"version":1,"generator":"echogarden","fragments":[
            {"startSeconds":1.0,"endSeconds":2.0,"href":"a.xhtml","text":"Hi."}]}"#;
        let parsed: SyncMap = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.fragments.len(), 1);
        assert!(parsed.fragments[0].words.is_empty());
        assert!(parsed.precision.is_none());
        assert!(!parsed.is_estimated());
        assert!(!serde_json::to_string(&parsed).unwrap().contains("words"));
    }

    #[test]
    fn word_timings_are_placed_inside_the_sentence() {
        let json = r#"[
            { "type": "sentence", "text": "The end, the end.", "startTime": 0.0, "endTime": 2.0,
              "timeline": [
                { "type": "word", "text": "The", "startTime": 0.0, "endTime": 0.4 },
                { "type": "word", "text": "end", "startTime": 0.4, "endTime": 0.9 },
                { "type": "word", "text": "the", "startTime": 1.0, "endTime": 1.3 },
                { "type": "word", "text": "end", "startTime": 1.3, "endTime": 2.0 },
                { "type": "word", "text": "missing", "startTime": 2.0, "endTime": 2.5 }
              ] }
        ]"#;
        let entries = parse_timeline(json).unwrap();
        let transcript = build_transcript(&[SpineSection {
            href: "a.xhtml".into(),
            text: "The end, the end.".into(),
        }]);
        let fragments = fragments_from_timeline(&entries, &transcript, 100.0);
        assert_eq!(
            fragments[0].words,
            vec![
                WordTiming(100.0, 100.4, 0, 3),
                WordTiming(100.4, 100.9, 4, 3),
                WordTiming(101.0, 101.3, 9, 3),
                WordTiming(101.3, 102.0, 13, 3),
            ]
        );
    }

    /// Publishers and narrators spell chapter numbers every way there is.
    #[test]
    fn parse_label_reads_spelled_out_and_roman_numbers() {
        assert_eq!(
            parse_label("Chapter Twelve: The Long Road").number,
            Some(12)
        );
        assert_eq!(parse_label("Chapter twenty-two").number, Some(22));
        assert_eq!(parse_label("Chapter Twenty Two - Owls").number, Some(22));
        assert_eq!(parse_label("Chapter Twenty Two - Owls").key, "owls");
        assert_eq!(parse_label("Chapter XII").number, Some(12));
        assert_eq!(parse_label("XIV. The River").number, Some(14));
        assert_eq!(parse_label("XIV. The River").key, "the river");
        assert_eq!(parse_label("Seven: Nightfall").number, Some(7));
        assert_eq!(parse_label("Ch. 3 - Owl Post").number, Some(3));
        assert_eq!(parse_label("Ch. 3 - Owl Post").key, "owl post");
        assert_eq!(parse_label("Chapter Ivory").number, None);
        assert_eq!(parse_label("Chapter Mix").number, None);
        assert_eq!(parse_label("I Am Legend").number, None);
        assert_eq!(parse_label("Which 12 Days").number, None);
        assert_eq!(parse_label("Chapter IIII").number, None);
    }

    /// Interludes are numbered in their own series, and the narrator's
    /// "Interlude I-3" must meet the publisher's "I-3." without ever being
    /// taken for chapter three.
    #[test]
    fn parse_label_reads_lettered_series_numbers() {
        let spoken = parse_label("Interlude I-3: The Rhythm of the Lost");
        assert_eq!(spoken.number, Some(3));
        assert_eq!(spoken.series, "i");
        assert_eq!(spoken.key, "interlude the rhythm of the lost");
        let written = parse_label("I-3. The Rhythm of the Lost");
        assert_eq!(written.number, Some(3));
        assert_eq!(written.series, "i");
        assert_eq!(written.key, "the rhythm of the lost");
        assert!(label_match_score(&spoken, &written) >= LABEL_MATCH_THRESHOLD);
        let chapter_three = parse_label("3. Momentum");
        assert_eq!(chapter_three.series, "");
        assert_eq!(label_match_score(&spoken, &chapter_three), 0);
        assert_eq!(
            parse_label("Part 1: United - Chapter 003: Momentum").number,
            Some(3)
        );
        assert_eq!(parse_label("Track-01").number, None);
    }

    /// The same label three times must land on the right occurrence: the
    /// order of the audio is the order of the book.
    #[test]
    fn labels_align_in_order_across_repeated_titles() {
        let targets = [
            "Interlude",
            "Chapter 2",
            "Interlude",
            "Chapter 4",
            "Interlude",
        ]
        .iter()
        .map(|title| parse_label(title))
        .collect::<Vec<_>>();
        let items = [
            "Title Page",
            "Interlude",
            "Chapter 2",
            "Interlude",
            "Chapter 4",
            "Interlude",
        ]
        .iter()
        .map(|title| parse_label(title))
        .collect::<Vec<_>>();
        assert_eq!(
            align_labels(&targets, &items, LABEL_MATCH_THRESHOLD),
            vec![Some(1), Some(2), Some(3), Some(4), Some(5)]
        );
    }

    /// Tracks named `Track 01` share no words or numbers with the table of
    /// contents, but the book still has exactly that many chapters.
    #[test]
    fn unnamed_tracks_fall_back_to_matching_by_position() {
        let targets = [
            "Opening Credits",
            "Track 01",
            "Track 02",
            "Track 03",
            "End Credits",
        ]
        .iter()
        .map(|title| parse_label(title))
        .collect::<Vec<_>>();
        let items = ["Cover", "Copyright", "The Meadow", "The River", "The Sea"]
            .iter()
            .map(|title| parse_label(title))
            .collect::<Vec<_>>();
        assert_eq!(
            match_in_order(&targets, &items),
            vec![None, Some(2), Some(3), Some(4), None]
        );
        let fewer = ["Track 01", "Track 02"]
            .iter()
            .map(|title| parse_label(title))
            .collect::<Vec<_>>();
        assert_eq!(match_in_order(&fewer, &items), vec![None, None]);
    }

    #[test]
    fn track_scopes_skip_a_track_that_matches_nothing() {
        let toc = vec![
            TocEntry {
                title: "Chapter 1: The Meadow".into(),
                spine_index: 1,
            },
            TocEntry {
                title: "Chapter 2: The River".into(),
                spine_index: 2,
            },
        ];
        let titles = vec![
            "Opening Credits".to_string(),
            "01 - The Meadow".to_string(),
            "02 - The River".to_string(),
            "End Credits".to_string(),
        ];
        let scopes = build_track_scopes(&titles, &toc, 4).unwrap();
        assert_eq!(
            scopes,
            vec![
                TrackScope {
                    track_index: 1,
                    section_range: 1..2
                },
                TrackScope {
                    track_index: 2,
                    section_range: 2..4
                },
            ]
        );
    }

    #[test]
    fn sentences_split_on_stops_but_not_inside_numbers() {
        let sentences = split_sentences(
            "a.xhtml",
            "Chapter 1\n\nIt was 3.5 miles. \"Really?\" she asked… He nodded.\n\nThe end",
        );
        let texts = sentences
            .iter()
            .map(|sentence| sentence.text.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "Chapter 1",
                "It was 3.5 miles.",
                "\"Really?\"",
                "she asked…",
                "He nodded.",
                "The end"
            ]
        );
        assert!(sentences[0].paragraph_start);
        assert!(sentences[1].paragraph_start);
        assert!(!sentences[2].paragraph_start);
        assert!(sentences[5].paragraph_start);
    }

    /// The estimate pins each audio chapter to its chapter of text and shares
    /// the chapter's seconds among its sentences; credits with no text fold
    /// into the neighbouring chapter's span rather than breaking the map.
    #[test]
    fn an_estimated_map_follows_the_chapters_and_stays_monotonic() {
        let epub = parse_epub(&build_test_epub()).unwrap();
        let chapters = vec![
            AudioChapter {
                title: "Opening Credits".into(),
                start_seconds: 0.0,
                end_seconds: 5.0,
            },
            AudioChapter {
                title: "Chapter One".into(),
                start_seconds: 5.0,
                end_seconds: 65.0,
            },
            AudioChapter {
                title: "Chapter Two".into(),
                start_seconds: 65.0,
                end_seconds: 125.0,
            },
        ];
        let map = estimate_sync_map(&epub, &chapters, 125.0, &[]).unwrap();
        assert!(map.is_estimated());
        assert_eq!(map.anchor_count, Some(2));
        assert_eq!(map.manual_anchor_count, Some(0));
        assert_eq!(map.fragments[0].start_seconds, 5.0);
        assert_eq!(map.fragments[0].href, "text/ch1.xhtml");
        assert_eq!(map.fragments[0].text, "Chapter 1");
        let river = map
            .fragments
            .iter()
            .find(|fragment| fragment.href == "text/ch2.xhtml")
            .unwrap();
        assert_eq!(river.start_seconds, 65.0);
        for pair in map.fragments.windows(2) {
            assert!(pair[0].end_seconds <= pair[1].start_seconds + 0.001);
            assert!(pair[0].start_seconds < pair[0].end_seconds);
        }
        assert_eq!(map.fragments.last().unwrap().end_seconds, 125.0);
        for fragment in &map.fragments {
            assert!(fragment.words.is_empty());
        }
    }

    #[test]
    fn an_estimate_without_chapters_spreads_the_whole_book() {
        let epub = parse_epub(&build_test_epub()).unwrap();
        let map = estimate_sync_map(&epub, &[], 100.0, &[]).unwrap();
        assert_eq!(map.anchor_count, Some(0));
        assert_eq!(map.fragments[0].start_seconds, 0.0);
        assert_eq!(map.fragments.last().unwrap().end_seconds, 100.0);
        assert!(estimate_sync_map(&epub, &[], 0.0, &[]).is_err());
    }

    /// A listener who taps "this sentence is being read now" re-times the
    /// chapter through that point; a pin that runs backwards is ignored.
    #[test]
    fn a_manual_anchor_retimes_the_sentences_around_it() {
        let epub = parse_epub(&build_test_epub()).unwrap();
        let chapters = vec![AudioChapter {
            title: "Chapter One".into(),
            start_seconds: 0.0,
            end_seconds: 100.0,
        }];
        let plain = estimate_sync_map(&epub, &chapters, 100.0, &[]).unwrap();
        // Chapter one: "Chapter 1", "The meadow was quiet.", "Bees drifted between flowers."
        let bees = plain
            .fragments
            .iter()
            .find(|fragment| fragment.text.starts_with("Bees"))
            .unwrap();
        assert!(bees.start_seconds < 80.0, "{}", bees.start_seconds);
        let pinned = estimate_sync_map(
            &epub,
            &chapters,
            100.0,
            &[
                ManualAnchor {
                    href: "text/ch1.xhtml".into(),
                    text: "Bees drifted between flowers.".into(),
                    seconds: 80.0,
                },
                ManualAnchor {
                    href: "text/ch1.xhtml".into(),
                    text: "The meadow was quiet.".into(),
                    seconds: 90.0,
                },
            ],
        )
        .unwrap();
        // The two taps contradict each other (the meadow cannot be read
        // after the bees); the newer one, at 90 s, wins.
        assert_eq!(pinned.manual_anchor_count, Some(1));
        let meadow = pinned
            .fragments
            .iter()
            .find(|fragment| fragment.text.starts_with("The meadow"))
            .unwrap();
        assert_eq!(meadow.start_seconds, 90.0);
        let bees = pinned
            .fragments
            .iter()
            .find(|fragment| fragment.text.starts_with("Bees"))
            .unwrap();
        assert!(bees.start_seconds > 90.0);
        let alone = estimate_sync_map(
            &epub,
            &chapters,
            100.0,
            &[ManualAnchor {
                href: "text/ch1.xhtml".into(),
                text: "Bees drifted between flowers.".into(),
                seconds: 80.0,
            }],
        )
        .unwrap();
        let bees = alone
            .fragments
            .iter()
            .find(|fragment| fragment.text.starts_with("Bees"))
            .unwrap();
        assert_eq!(bees.start_seconds, 80.0);
        for pair in pinned.fragments.windows(2) {
            assert!(pair[0].end_seconds <= pair[1].start_seconds + 0.001);
        }
    }

    /// With enough chapters the pace is learned from the book; a synthetic
    /// narrator who takes long paragraph pauses is recovered, and an
    /// implausible fit is clamped rather than trusted.
    #[test]
    fn the_reading_model_is_fitted_from_chapter_lengths() {
        let truth = ReadingModel {
            char_seconds: 0.09,
            sentence_seconds: 0.3,
            paragraph_seconds: 2.0,
            dialogue_char_seconds: -0.01,
        };
        // Chapters that vary independently in length, sentence length,
        // paragraph length, and how much of them is dialogue.
        let mut seed: u64 = 12345;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 33) % 1000) as f64 / 1000.0
        };
        let samples = (0..60)
            .map(|_| {
                let chars = 5_000.0 + 20_000.0 * next();
                let features = TextFeatures {
                    chars,
                    sentences: chars / (40.0 + 60.0 * next()),
                    paragraphs: chars / (150.0 + 500.0 * next()),
                    dialogue_chars: chars * (0.05 + 0.6 * next()),
                };
                (features, truth.seconds(&features))
            })
            .collect::<Vec<_>>();
        let fitted = ReadingModel::fit(&samples);
        assert!(
            (fitted.char_seconds - truth.char_seconds).abs() < 0.01,
            "{fitted:?}"
        );
        assert!(
            (fitted.paragraph_seconds - truth.paragraph_seconds).abs() < 0.6,
            "{fitted:?}"
        );
        assert!(fitted.dialogue_char_seconds < 0.0, "{fitted:?}");
        assert_eq!(ReadingModel::fit(&samples[..3]), ReadingModel::default());
    }
}
