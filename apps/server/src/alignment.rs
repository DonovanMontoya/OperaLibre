//! Readalong sync-map support: EPUB text extraction, echogarden timeline
//! parsing, and conversion into the `.sync.json` sidecar format that maps
//! audiobook timestamps to EPUB text locations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;

pub const SYNC_MAP_VERSION: u32 = 1;

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
    pub fragments: Vec<SyncFragment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFragment {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub href: String,
    pub text: String,
}

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

    Ok(EpubDocument { sections, toc })
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
fn find_tags(xml: &str, name: &str) -> Vec<String> {
    let mut results = Vec::new();
    let lower = xml.to_lowercase();
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
    let lower = tag_body.to_lowercase();
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
        .to_lowercase()
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
            if let Some(close_at) = bytes[search_start..].to_lowercase().find(&close) {
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
    let Some(end) = rest[..rest.len().min(12)].find(';') else {
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

fn decode_entities(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
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
    let lower = document.to_lowercase();
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
    let scope_lower = scope.to_lowercase();
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
    let lower = document.to_lowercase();
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
        fragments.push(SyncFragment {
            start_seconds: time_offset_seconds + sentence.start_time,
            end_seconds: time_offset_seconds + sentence.end_time,
            href: href.to_string(),
            text,
        });
    }
    fragments
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

/// Maps each audio track to a run of spine sections by fuzzy-matching track
/// titles against the EPUB table of contents. Mirrors the chapter matching
/// used by the web reader. Returns an error message describing the first
/// track that could not be matched confidently.
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
    let parsed_toc: Vec<(usize, ParsedLabel)> = toc
        .iter()
        .map(|entry| (entry.spine_index, parse_label(&entry.title)))
        .collect();

    let mut starts = Vec::with_capacity(track_titles.len());
    for (track_index, title) in track_titles.iter().enumerate() {
        let target = parse_label(title);
        let best = parsed_toc
            .iter()
            .map(|(spine_index, label)| (*spine_index, label_match_score(&target, label)))
            .max_by_key(|(_, score)| *score);
        match best {
            Some((spine_index, score)) if score >= 70 => starts.push((track_index, spine_index)),
            _ => {
                return Err(format!(
                    "Could not match audio track `{title}` to a chapter in the EPUB's table of contents."
                ));
            }
        }
    }

    for window in starts.windows(2) {
        if window[1].1 <= window[0].1 {
            return Err(
                "Audio tracks matched EPUB chapters out of order; cannot scope the alignment."
                    .to_string(),
            );
        }
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

#[derive(Debug)]
pub struct ParsedLabel {
    number: Option<u32>,
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

pub fn parse_label(value: &str) -> ParsedLabel {
    let lower = value.to_lowercase();
    let mut number = None;
    let mut remainder = value.to_string();

    if let Some(found) = lower.find("chapter ") {
        let after = &value[found + "chapter ".len()..];
        let digits: String = after
            .trim_start_matches('0')
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let has_digits = after.chars().any(|c| c.is_ascii_digit())
            && after
                .chars()
                .take_while(|c| *c == '0' || c.is_ascii_digit())
                .count()
                > 0;
        if has_digits {
            number = if digits.is_empty() {
                Some(0)
            } else {
                digits.parse::<u32>().ok()
            };
            let consumed = after
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .map(char::len_utf8)
                .sum::<usize>();
            remainder = after[consumed..]
                .trim_start()
                .trim_start_matches(['.', ':', ')', '-', '–', '—'])
                .trim_start()
                .to_string();
        }
    } else {
        let trimmed = value.trim_start();
        let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            let rest = trimmed[digits.len()..].trim_start();
            if let Some(rest) = rest
                .strip_prefix(['.', ':', ')', '-', '–', '—'])
                .map(str::trim_start)
            {
                number = digits
                    .trim_start_matches('0')
                    .parse::<u32>()
                    .ok()
                    .or(Some(0));
                remainder = rest.to_string();
            }
        }
    }

    ParsedLabel {
        number,
        key: normalize_label_text(&remainder),
    }
}

pub fn label_match_score(target: &ParsedLabel, item: &ParsedLabel) -> u32 {
    let mut score = 0;
    if let (Some(target_number), Some(item_number)) = (target.number, item.number)
        && target_number == item_number
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_test_epub() -> Vec<u8> {
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
                    br#"<html><head><title>Ignored</title><style>p{}</style></head>
                    <body><h1>Chapter 1</h1><p>The meadow was quiet. Bees drifted between flowers.</p></body></html>"#,
                )
                .unwrap();
            writer.start_file("OEBPS/text/ch2.xhtml", options).unwrap();
            writer
                .write_all(
                    br#"<html><body><h1>Chapter 2</h1><p>The river ran fast &amp; cold.</p></body></html>"#,
                )
                .unwrap();
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

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
            fragments: vec![SyncFragment {
                start_seconds: 1.5,
                end_seconds: 3.25,
                href: "text/ch1.xhtml".into(),
                text: "Hello.".into(),
            }],
        };
        let json = serde_json::to_string(&map).unwrap();
        let parsed: SyncMap = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.fragments[0].href, "text/ch1.xhtml");
        assert!(json.contains("startSeconds"));
    }
}
