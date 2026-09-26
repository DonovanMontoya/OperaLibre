//! Readalong sync-map support: EPUB text extraction, echogarden timeline
//! parsing, and conversion into the `.sync.json` sidecar format that maps
//! audiobook timestamps to EPUB text locations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;

/// Version 1 carried sentences only. Version 2 adds the map's precision and
/// optional word timings inside each sentence; a version 1 file still reads.
pub const SYNC_MAP_VERSION: u32 = 2;

/// How the map's timings were produced. Only a forced alignment is ever
/// served, so this is always `sentence`.
pub const PRECISION_SENTENCE: &str = "sentence";

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
    /// `sentence` for a forced alignment. Absent in version 1 files, which
    /// were always aligned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision: Option<String>,
    pub fragments: Vec<SyncFragment>,
    /// Audio whose text could not be established. The reader must hold its
    /// place here rather than interpret the silence in the map as a picture.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recovery_gaps: Vec<RecoveryGap>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryGap {
    pub start_seconds: f64,
    pub end_seconds: f64,
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
    /// Sections whose first visible content is an image, potentially a
    /// narrated chapter title that is absent from the extracted text.
    pub leading_image_sections: Vec<usize>,
    /// Pictures declared in the manifest. Used to tell an illustrated
    /// supplement from a text.
    pub image_count: usize,
    /// `dc:language` from the package metadata, lowercased, when present.
    pub language: Option<String>,
}

#[cfg(test)]
pub fn parse_epub(bytes: &[u8]) -> anyhow::Result<EpubDocument> {
    parse_epub_archive(&mut zip::ZipArchive::new(std::io::Cursor::new(bytes))?)
}

/// Parses an EPUB straight from disk. Only the entries the reader needs are
/// decompressed, so the file is never held in memory whole.
pub fn parse_epub_file(path: &std::path::Path) -> anyhow::Result<EpubDocument> {
    parse_epub_archive(&mut zip::ZipArchive::new(std::fs::File::open(path)?)?)
}

pub fn parse_epub_archive<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> anyhow::Result<EpubDocument> {
    let mut remaining = 64 * 1024 * 1024;

    let container = read_zip_text(archive, "META-INF/container.xml", &mut remaining)?
        .ok_or_else(|| anyhow::anyhow!("EPUB is missing META-INF/container.xml"))?;
    let opf_path = find_tags(&container, "rootfile")
        .iter()
        .find_map(|tag| attr_value(tag, "full-path"))
        .ok_or_else(|| anyhow::anyhow!("EPUB container.xml has no rootfile full-path"))?;
    let opf = read_zip_text(archive, &opf_path, &mut remaining)?
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
    let mut leading_image_sections = Vec::new();
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
        let Some(document) = read_zip_text(archive, &document_path, &mut remaining)? else {
            continue;
        };
        let text = html_to_text(&document);
        if starts_with_image(&document) {
            leading_image_sections.push(sections.len());
        }
        section_paths.insert(document_path, sections.len());
        sections.push(SpineSection {
            href: item.href.clone(),
            text,
        });
        // A separately narrated illustration may be the last element of a
        // prose document rather than a separate spine item. Empty logical
        // sections let its audio have a boundary without moving any text or
        // changing the href used by sentence highlights.
        for _ in 0..trailing_image_count(&document) {
            sections.push(SpineSection {
                href: item.href.clone(),
                text: String::new(),
            });
        }
    }

    // Prefer EPUB 3 labels, but recover documents omitted from its TOC
    // when the older NCX still lists them.
    let mut toc_links = Vec::new();
    let nav_item = manifest
        .values()
        .find(|item| item.properties.split_whitespace().any(|p| p == "nav"));
    if let Some(nav_item) = nav_item {
        let nav_path = resolve_href(&opf_dir, &nav_item.href);
        if let Some(nav_document) = read_zip_text(archive, &nav_path, &mut remaining)? {
            let nav_dir = parent_dir(&nav_path);
            toc_links = parse_nav_links(&nav_document, &nav_dir);
        }
    }
    {
        let ncx_item = manifest
            .values()
            .find(|item| item.media_type == "application/x-dtbncx+xml");
        if let Some(ncx_item) = ncx_item {
            let ncx_path = resolve_href(&opf_dir, &ncx_item.href);
            if let Some(ncx_document) = read_zip_text(archive, &ncx_path, &mut remaining)? {
                let ncx_dir = parent_dir(&ncx_path);
                for link in parse_ncx_links(&ncx_document, &ncx_dir) {
                    if !toc_links.iter().any(|(path, _)| *path == link.0) {
                        toc_links.push(link);
                    }
                }
            }
        }
    }

    let mut toc: Vec<_> = toc_links
        .into_iter()
        .filter_map(|(path, title)| {
            let spine_index = *section_paths.get(&path)?;
            Some(TocEntry { title, spine_index })
        })
        .collect();
    toc.sort_by_key(|entry| entry.spine_index);
    let image_count = manifest
        .values()
        .filter(|item| item.media_type.starts_with("image/"))
        .count();

    let language = element_text(&opf, "dc:language")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    Ok(EpubDocument {
        sections,
        toc,
        leading_image_sections,
        language,
        image_count,
    })
}

fn starts_with_image(document: &str) -> bool {
    let lower = document.to_ascii_lowercase();
    let Some(body) = lower
        .find("<body")
        .and_then(|start| lower[start..].find('>').map(|end| start + end + 1))
    else {
        return false;
    };
    let first_image = ["<img", "<svg"]
        .iter()
        .filter_map(|tag| lower[body..].find(tag))
        .min();
    first_image.is_some_and(|offset| {
        html_to_text(&document[body..body + offset])
            .trim()
            .is_empty()
    })
}

fn trailing_image_count(document: &str) -> usize {
    let lower = document.to_ascii_lowercase();
    let Some(body) = lower.find("<body") else {
        return 0;
    };
    let count = ["<img", "<svg"]
        .iter()
        .flat_map(|tag| {
            lower[body..]
                .match_indices(tag)
                .map(move |(at, _)| (body + at, tag.len()))
        })
        .filter(|(at, length)| {
            matches!(
                lower.as_bytes().get(at + length),
                Some(b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/')
            ) && html_to_text(&document[*at..]).trim().is_empty()
        })
        .count();
    // The existing section already represents the first picture on an
    // image-only page. Additional figures may have their own audio markers.
    if html_to_text(document).trim().is_empty() {
        count.saturating_sub(1)
    } else {
        count
    }
}

/// Text content of the first `<name>...</name>` element, if any.
fn element_text(xml: &str, name: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let start = lower.find(&open)?;
    let body_start = start + lower[start..].find('>')? + 1;
    let body_end = body_start + lower[body_start..].find(&close)?;
    Some(strip_tags(&xml[body_start..body_end]))
}

fn read_zip_text<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    path: &str,
    remaining: &mut u64,
) -> anyhow::Result<Option<String>> {
    let Some(index) = archive
        .index_for_name(path)
        .or_else(|| archive.index_for_name(&percent_decode(path)))
    else {
        return Ok(None);
    };
    let file = archive.by_index(index)?;
    // Count every read, including repeated spine references to the same entry.
    let limit = (*remaining).min(8 * 1024 * 1024);
    anyhow::ensure!(file.size() <= limit, "EPUB text exceeds the reading limit.");
    let mut contents = String::new();
    file.take(limit + 1).read_to_string(&mut contents)?;
    anyhow::ensure!(
        contents.len() as u64 <= limit,
        "EPUB text exceeds the reading limit."
    );
    *remaining -= contents.len() as u64;
    Ok(Some(contents))
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
    /// Consume narration printed in an image without emitting a highlight
    /// for text that the EPUB DOM cannot contain.
    pub fn prepend_unmapped(&mut self, heading: &str) {
        // EPUB contents often abbreviate an interlude as I-3; the narrator
        // says "Interlude three". Feed the spoken label to the aligner so
        // those title words cannot consume the first prose sentence.
        let expanded;
        let heading = if let Some((series, number, start, end)) = find_series_number(heading)
            && series == "i"
            && heading[..start].trim().is_empty()
        {
            expanded = format!("Interlude {number}{}", &heading[end..]);
            expanded.as_str()
        } else {
            heading
        };
        let prefix = format!("{}.\n\n", heading.trim().trim_end_matches(['.', '!', '?']));
        let length = prefix.encode_utf16().count() as u64;
        for section in &mut self.sections {
            section.start_utf16 += length;
            section.end_utf16 += length;
        }
        self.sections.insert(
            0,
            TranscriptSection {
                href: String::new(),
                start_utf16: 0,
                end_utf16: length,
            },
        );
        self.text.insert_str(0, &prefix);
    }

    pub fn href_for_offset(&self, offset_utf16: u64) -> Option<&str> {
        let index = self
            .sections
            .partition_point(|section| section.end_utf16 <= offset_utf16);
        let section = self.sections.get(index)?;
        (offset_utf16 >= section.start_utf16).then_some(section.href.as_str())
    }

    /// Keep additional narration (for example an inline diagram description)
    /// in the aligner's input, without assigning it to visible EPUB prose.
    /// Unique phrases must bracket a sentence boundary in the text and a
    /// substantial run of extra recognized speech in the audio.
    pub fn include_unmapped_narration(&mut self, recognized: &[RecognizedWord]) -> usize {
        const CONTEXT: usize = 3;
        let words = transcript_words(&self.text, 0, self.len_utf16());
        let mut audio_phrases = HashMap::new();
        for (index, run) in recognized.windows(CONTEXT).enumerate() {
            let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
            audio_phrases
                .entry(key)
                .and_modify(|value| *value = None)
                .or_insert(Some(index));
        }
        let mut text_counts = HashMap::new();
        for run in words.windows(CONTEXT) {
            let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
            *text_counts.entry(key).or_insert(0usize) += 1;
        }
        let scripted_phrases = words
            .windows(ANCHOR_NGRAM)
            .map(|run| {
                run.iter()
                    .map(|word| word.text.as_str())
                    .collect::<Vec<_>>()
            })
            .collect::<std::collections::HashSet<_>>();
        let mut insertions = Vec::new();
        for run in words.windows(CONTEXT * 2) {
            if !run[CONTEXT - 1].sentence_final {
                continue;
            }
            let left: Vec<&str> = run[..CONTEXT]
                .iter()
                .map(|word| word.text.as_str())
                .collect();
            let right: Vec<&str> = run[CONTEXT..]
                .iter()
                .map(|word| word.text.as_str())
                .collect();
            if text_counts.get(&left) != Some(&1) || text_counts.get(&right) != Some(&1) {
                continue;
            }
            let (Some(Some(left)), Some(Some(right))) =
                (audio_phrases.get(&left), audio_phrases.get(&right))
            else {
                continue;
            };
            let start = left + CONTEXT;
            if !(6..=128).contains(&right.saturating_sub(start)) {
                continue;
            }
            let extra = &recognized[start..*right];
            // A recognizer can repeat a real passage with slightly different
            // word splitting. Do not mistake that duplicate scripted speech
            // for a new description merely because the boundary match is unique.
            if extra.windows(ANCHOR_NGRAM).any(|run| {
                scripted_phrases.contains(
                    &run.iter()
                        .map(|word| word.text.as_str())
                        .collect::<Vec<_>>(),
                )
            }) {
                continue;
            }
            let duration = extra.last().unwrap().end_time - extra[0].start_time;
            if !duration.is_finite()
                || duration < 3.0
                || extra
                    .windows(2)
                    .any(|pair| pair[0].start_time > pair[1].start_time)
            {
                continue;
            }
            let offset = run[CONTEXT].start_utf16;
            if self
                .href_for_offset(run[CONTEXT - 1].start_utf16)
                .filter(|href| !href.is_empty())
                != self.href_for_offset(offset)
            {
                continue;
            }
            let text = extra
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            insertions.push((offset, format!("{text}.\n\n")));
        }
        let count = insertions.len();
        for (offset, text) in insertions.into_iter().rev() {
            let length = text.encode_utf16().count() as u64;
            self.text
                .insert_str(utf16_to_byte_index(&self.text, offset), &text);
            let mut sections = Vec::new();
            for mut section in self.sections.drain(..) {
                if section.start_utf16 >= offset {
                    section.start_utf16 += length;
                    section.end_utf16 += length;
                } else if section.end_utf16 > offset {
                    sections.push(TranscriptSection {
                        href: section.href.clone(),
                        start_utf16: section.start_utf16,
                        end_utf16: offset,
                    });
                    section.start_utf16 = offset + length;
                    section.end_utf16 += length;
                }
                sections.push(section);
            }
            sections.push(TranscriptSection {
                href: String::new(),
                start_utf16: offset,
                end_utf16: offset + length,
            });
            sections.sort_by_key(|section| section.start_utf16);
            self.sections = sections;
        }
        count
    }

    /// Additional narration after the final sentence needs no following text
    /// anchor. Only call this for the actual end of an alignment scope, never
    /// for a window whose recognizer looked beyond its audio cut.
    fn trailing_narration_start(&self, recognized: &[RecognizedWord]) -> Option<usize> {
        let words = transcript_words(&self.text, 0, self.len_utf16());
        if words.len() < ANCHOR_NGRAM {
            return None;
        }
        let tail = &words[words.len() - ANCHOR_NGRAM..];
        if self
            .href_for_offset(tail[0].start_utf16)
            .is_none_or(str::is_empty)
        {
            return None;
        }
        let key = tail
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>();
        let matching = recognized
            .windows(ANCHOR_NGRAM)
            .enumerate()
            .filter(|(_, run)| {
                run.iter()
                    .map(|word| word.text.as_str())
                    .eq(key.iter().copied())
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matching.len() != 1
            || words
                .windows(ANCHOR_NGRAM)
                .filter(|run| {
                    run.iter()
                        .map(|word| word.text.as_str())
                        .eq(key.iter().copied())
                })
                .count()
                != 1
        {
            return None;
        }
        let extra = &recognized[matching[0] + ANCHOR_NGRAM..];
        if !(6..=512).contains(&extra.len()) {
            return None;
        }
        let duration = extra.last().unwrap().end_time - extra[0].start_time;
        if !duration.is_finite()
            || duration < 3.0
            || extra
                .windows(2)
                .any(|pair| pair[0].start_time > pair[1].start_time)
        {
            return None;
        }
        let phrases = words
            .windows(ANCHOR_NGRAM)
            .map(|run| {
                run.iter()
                    .map(|word| word.text.as_str())
                    .collect::<Vec<_>>()
            })
            .collect::<std::collections::HashSet<_>>();
        if extra.windows(ANCHOR_NGRAM).any(|run| {
            phrases.contains(
                &run.iter()
                    .map(|word| word.text.as_str())
                    .collect::<Vec<_>>(),
            )
        }) {
            return None;
        }
        Some(matching[0] + ANCHOR_NGRAM)
    }

    pub fn narrated_text_end(&self, recognized: &[RecognizedWord]) -> Option<f64> {
        let start = self.trailing_narration_start(recognized)?;
        let end = recognized[start - 1].end_time;
        (end.is_finite() && end > 0.0).then_some(end)
    }

    pub fn include_unmapped_trailing_narration(&mut self, recognized: &[RecognizedWord]) -> usize {
        let Some(start) = self.trailing_narration_start(recognized) else {
            return 0;
        };
        let extra = &recognized[start..];
        let offset = self.len_utf16();
        self.text.push_str("\n\n");
        self.text.push_str(
            &extra
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        );
        self.text.push('.');
        self.sections.push(TranscriptSection {
            href: String::new(),
            start_utf16: offset,
            end_utf16: self.len_utf16(),
        });
        1
    }

    /// Leave edition-only sentences unmatched when unique spoken phrases on
    /// either side are adjacent in the audio. Preserve UTF-16 offsets so the
    /// remaining text still maps to the original EPUB sections.
    pub fn mask_unspoken_sentences(&mut self, recognized: &[RecognizedWord]) -> usize {
        const CONTEXT: usize = 3;
        let words = transcript_words(&self.text, 0, self.len_utf16());
        let mut text_phrases = HashMap::new();
        for (index, run) in words.windows(CONTEXT).enumerate() {
            let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
            text_phrases
                .entry(key)
                .and_modify(|value| *value = None)
                .or_insert(Some(index));
        }
        let mut audio_phrases = HashMap::new();
        for run in recognized.windows(CONTEXT) {
            let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
            *audio_phrases.entry(key).or_insert(0usize) += 1;
        }
        let mut ranges = Vec::new();
        for run in recognized.windows(CONTEXT * 2) {
            let left: Vec<&str> = run[..CONTEXT]
                .iter()
                .map(|word| word.text.as_str())
                .collect();
            let right: Vec<&str> = run[CONTEXT..]
                .iter()
                .map(|word| word.text.as_str())
                .collect();
            if audio_phrases.get(&left) != Some(&1) || audio_phrases.get(&right) != Some(&1) {
                continue;
            }
            let (Some(Some(left)), Some(Some(right))) =
                (text_phrases.get(&left), text_phrases.get(&right))
            else {
                continue;
            };
            let after_left = left + CONTEXT;
            let missing = right.saturating_sub(after_left);
            // Require whole sentences and too little elapsed audio to contain
            // their words, even at eight words per second. Recognition failure
            // across a real spoken passage leaves time between the anchors.
            let silence = run[CONTEXT].start_time - run[CONTEXT - 1].end_time;
            if !(6..=128).contains(&missing)
                || !words[after_left - 1].sentence_final
                || !words[right - 1].sentence_final
                || !silence.is_finite()
                || !(0.0..=1.5).contains(&silence)
                || missing as f64 <= (silence + 0.25) * 8.0
            {
                continue;
            }
            let start = words[after_left].start_utf16;
            let end = words[*right].start_utf16;
            // Never infer an omission across a document boundary or over an
            // unmapped heading. Those regions have separate audio semantics.
            if self.href_for_offset(start).filter(|href| !href.is_empty())
                != self.href_for_offset(end.saturating_sub(1))
            {
                continue;
            }
            ranges.push((start, end));
        }
        ranges.sort_unstable();
        ranges.dedup();
        for &(start, end) in ranges.iter().rev() {
            let start_byte = utf16_to_byte_index(&self.text, start);
            let end_byte = utf16_to_byte_index(&self.text, end);
            self.text
                .replace_range(start_byte..end_byte, &" ".repeat((end - start) as usize));
        }
        ranges.len()
    }

    pub fn len_utf16(&self) -> u64 {
        self.text.encode_utf16().count() as u64
    }

    /// The stretch of text between two UTF-16 offsets as a transcript of its
    /// own, with section ranges rebased so an aligner's offsets into the
    /// window map straight back to documents.
    pub fn window(&self, start_utf16: u64, end_utf16: u64) -> Transcript {
        let end_utf16 = end_utf16.max(start_utf16);
        let start_byte = utf16_to_byte_index(&self.text, start_utf16);
        let end_byte = utf16_to_byte_index(&self.text, end_utf16);
        let sections = self
            .sections
            .iter()
            .filter(|section| section.end_utf16 > start_utf16 && section.start_utf16 < end_utf16)
            .map(|section| TranscriptSection {
                href: section.href.clone(),
                start_utf16: section.start_utf16.max(start_utf16) - start_utf16,
                end_utf16: section.end_utf16.min(end_utf16) - start_utf16,
            })
            .collect();
        Transcript {
            text: self.text[start_byte..end_byte].to_string(),
            sections,
        }
    }
}

/// Byte index of the character that starts at a UTF-16 offset (or the end of
/// the text when the offset lies beyond it).
pub fn utf16_to_byte_index(text: &str, offset_utf16: u64) -> usize {
    let mut seen = 0u64;
    for (byte_index, ch) in text.char_indices() {
        if seen >= offset_utf16 {
            return byte_index;
        }
        seen += ch.len_utf16() as u64;
    }
    text.len()
}

/// First non-whitespace UTF-16 offset at or after `offset_utf16`.
pub fn skip_whitespace_utf16(text: &str, offset_utf16: u64) -> u64 {
    let start = utf16_to_byte_index(text, offset_utf16);
    let mut offset = offset_utf16;
    for ch in text[start..].chars() {
        if !ch.is_whitespace() {
            break;
        }
        offset += ch.len_utf16() as u64;
    }
    offset
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

/// Recover a one-word utterance that the forced aligner collapsed to zero
/// duration, but only when unique surrounding recognition phrases locate it
/// near the aligner's own position. Missing or ambiguous speech stays unmapped.
pub fn recover_zero_duration_sentences(
    entries: &mut [TimelineEntry],
    transcript: &str,
    recognized: &[RecognizedWord],
) {
    let words = transcript_words(transcript, 0, transcript.encode_utf16().count() as u64);
    fn visit(
        entries: &mut [TimelineEntry],
        words: &[TranscriptWord],
        recognized: &[RecognizedWord],
    ) {
        for entry in entries {
            if entry.kind != "sentence" {
                if let Some(children) = &mut entry.timeline {
                    visit(children, words, recognized);
                }
                continue;
            }
            if entry.end_time != entry.start_time || entry.text.split_whitespace().count() != 1 {
                continue;
            }
            let Some(offset) = entry_offsets(entry).0 else {
                continue;
            };
            let token = normalize_word(&entry.text);
            let Some(index) = words.iter().position(|word| {
                word.start_utf16 <= offset && offset < word.end_utf16 && word.text == token
            }) else {
                continue;
            };
            let mut candidate = None;
            let mut ambiguous = false;
            for start in index.saturating_sub(ANCHOR_NGRAM - 1)..=index {
                let Some(context) = words.get(start..start + ANCHOR_NGRAM) else {
                    continue;
                };
                let matches = recognized
                    .windows(ANCHOR_NGRAM)
                    .enumerate()
                    .filter(|(_, run)| {
                        run.iter()
                            .map(|w| &w.text)
                            .eq(context.iter().map(|w| &w.text))
                    })
                    .map(|(at, _)| at + index - start)
                    .collect::<Vec<_>>();
                if matches.len() != 1
                    || words
                        .windows(ANCHOR_NGRAM)
                        .filter(|run| {
                            run.iter()
                                .map(|w| &w.text)
                                .eq(context.iter().map(|w| &w.text))
                        })
                        .count()
                        != 1
                {
                    continue;
                }
                if candidate.is_some_and(|previous| previous != matches[0]) {
                    ambiguous = true;
                    break;
                }
                candidate = Some(matches[0]);
            }
            let Some(word) = candidate.filter(|_| !ambiguous).map(|at| &recognized[at]) else {
                continue;
            };
            if !word.start_time.is_finite()
                || !word.end_time.is_finite()
                || word.start_time < 0.0
                || word.end_time <= word.start_time
                || word.end_time - word.start_time > 2.0
                || (word.start_time - entry.start_time).abs() > 2.0
            {
                continue;
            }
            entry.start_time = word.start_time;
            entry.end_time = word.end_time;
            if let Some(children) = &mut entry.timeline {
                for child in children
                    .iter_mut()
                    .filter(|child| child.kind == "word" && normalize_word(&child.text) == token)
                {
                    child.start_time = word.start_time;
                    child.end_time = word.end_time;
                }
            }
        }
    }
    visit(entries, &words, recognized);
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
        if href.is_empty() {
            continue;
        }
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
// Windowed alignment anchors
// ---------------------------------------------------------------------------
//
// The forced aligner holds a whole input in memory and, given more text than
// speech (or the reverse), spreads the mismatch evenly across the input rather
// than parking it at one end. Long audio is therefore aligned in windows whose
// text is known exactly: a speech recognizer transcribes the window, runs of
// recognized words are located in the transcript, and the last confident
// match at a sentence end becomes the window's boundary. Recognizer word
// timings are only trusted at those anchors; the forced aligner produces the
// sentence timings in between.

/// A recognizer word, normalized for matching against transcript tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedWord {
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
}

/// Every `word` entry of a recognizer timeline, in order, with punctuation
/// and case removed. Words that normalize to nothing are dropped.
pub fn recognized_words(entries: &[TimelineEntry]) -> Vec<RecognizedWord> {
    let mut out = Vec::new();
    collect_recognized_words(entries, &mut out);
    out
}

fn collect_recognized_words(entries: &[TimelineEntry], out: &mut Vec<RecognizedWord>) {
    for entry in entries {
        if entry.kind == "word" {
            let text = normalize_word(&entry.text);
            if !text.is_empty() {
                out.push(RecognizedWord {
                    text,
                    start_time: entry.start_time,
                    end_time: entry.end_time,
                });
            }
        } else if let Some(children) = &entry.timeline {
            collect_recognized_words(children, out);
        }
    }
}

/// Lowercases and keeps only letters and digits, so `“Kaladin,”` in the
/// transcript and `kaladin` from the recognizer compare equal.
fn normalize_word(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

struct TranscriptWord {
    text: String,
    start_utf16: u64,
    end_utf16: u64,
    /// The token closes a sentence: it ends in terminal punctuation (allowing
    /// closing quotes or brackets after it) or is followed by a line break.
    sentence_final: bool,
}

/// Whitespace-delimited tokens of `text` that lie wholly inside the UTF-16
/// range `[start, start + max_len)`.
fn transcript_words(text: &str, start_utf16: u64, max_len_utf16: u64) -> Vec<TranscriptWord> {
    let limit = start_utf16.saturating_add(max_len_utf16);
    let mut words = Vec::new();
    let mut offset = 0u64;
    let mut current = String::new();
    let mut current_end = 0u64;
    let flush =
        |current: &mut String, end: u64, followed_by_break: bool, out: &mut Vec<TranscriptWord>| {
            if current.is_empty() {
                return;
            }
            let normalized = normalize_word(current);
            let trimmed = current.trim_end_matches(|ch: char| {
                matches!(ch, '”' | '’' | '"' | '\'' | ')' | ']' | '»' | '」' | '』')
            });
            let sentence_final =
                followed_by_break || trimmed.ends_with(['.', '!', '?', '…', '。', '！', '？']);
            if !normalized.is_empty() {
                out.push(TranscriptWord {
                    text: normalized,
                    start_utf16: end - current.encode_utf16().count() as u64,
                    end_utf16: end,
                    sentence_final,
                });
            }
            current.clear();
        };
    for ch in text.chars() {
        let width = ch.len_utf16() as u64;
        if offset >= limit {
            // A token cut by the limit is unusable, and `current` is one.
            current.clear();
            break;
        }
        if offset >= start_utf16 {
            if ch.is_whitespace() {
                flush(
                    &mut current,
                    current_end,
                    ch == '\n' || ch == '\r',
                    &mut words,
                );
            } else {
                current.push(ch);
                current_end = offset + width;
            }
        }
        offset += width;
    }
    flush(&mut current, current_end, true, &mut words);
    words
}

/// UTF-16 offset just past the last sentence-final token that ends at or
/// before `target_utf16`, falling back to the last whole token, then to
/// `target_utf16` itself. Used to exercise transcript boundary handling.
#[cfg(test)]
pub fn sentence_end_before(text: &str, start_utf16: u64, target_utf16: u64) -> u64 {
    let words = transcript_words(text, start_utf16, target_utf16.saturating_sub(start_utf16));
    words
        .iter()
        .rev()
        .find(|word| word.sentence_final)
        .or(words.last())
        .map(|word| word.end_utf16)
        .unwrap_or(target_utf16)
}

/// Retry bounded recognition when it repeats itself or skips a large stretch
/// of otherwise anchored text. A forced aligner cannot repair that evidence.
pub fn recognition_needs_retry(recognized: &[RecognizedWord], text: &str) -> bool {
    if recognized.len() < 20 {
        return text.split_whitespace().take(20).count() == 20;
    }
    let mut repetitions = HashMap::new();
    for run in recognized.windows(4) {
        let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
        let count = repetitions.entry(key).or_insert(0usize);
        *count += 1;
        if *count >= 4 {
            return true;
        }
    }
    let chain = recognition_anchor_chain(recognized, text);
    if chain.len() * 4 < recognized.len().saturating_sub(ANCHOR_NGRAM) {
        return true;
    }
    chain.windows(2).any(|pair| {
        let audio_words = pair[1].0 - pair[0].0;
        let text_words = pair[1].1 - pair[0].1;
        text_words >= 16 && text_words > audio_words * 2
    })
}

/// Comparable evidence when retrying the same audio with shorter windows.
pub fn recognition_anchor_count(recognized: &[RecognizedWord], text: &str) -> usize {
    recognition_anchor_chain(recognized, text).len()
}

fn recognition_anchor_chain(recognized: &[RecognizedWord], text: &str) -> Vec<(usize, usize)> {
    let words = transcript_words(text, 0, text.encode_utf16().count() as u64);
    let mut phrases = HashMap::new();
    for (index, run) in words.windows(ANCHOR_NGRAM).enumerate() {
        let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
        phrases
            .entry(key)
            .and_modify(|value| *value = None)
            .or_insert(Some(index));
    }
    let matches: Vec<_> = recognized
        .windows(ANCHOR_NGRAM)
        .enumerate()
        .filter_map(|(index, run)| {
            let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
            Some((index, (*phrases.get(&key)?)?))
        })
        .collect();
    longest_increasing_chain(&matches)
}

const ANCHOR_NGRAM: usize = 5;

/// A complete sentence backed by a unique, longer phrase after alignment loss.
/// These bounds select audio/text for a fresh forced alignment; they are not
/// used as an interpolated timing map.
#[derive(Debug, PartialEq)]
pub struct RecoveryAnchor {
    pub text_start_utf16: u64,
    pub text_end_utf16: u64,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// Search only forward from the last trusted text position. Repeated phrases,
/// partial sentences, and invalid recognizer clocks cannot restart following.
pub fn find_recovery_anchor(
    recognized: &[RecognizedWord],
    text: &str,
    cursor: u64,
    duration: f64,
) -> Option<RecoveryAnchor> {
    const CONTEXT: usize = ANCHOR_NGRAM * 2;
    // Include consumed text when checking uniqueness, so a repeated earlier
    // line cannot masquerade as a new occurrence later in the same scope.
    let words = transcript_words(text, 0, u64::MAX);
    let mut phrases = HashMap::new();
    for (index, run) in words.windows(CONTEXT).enumerate() {
        let key: Vec<_> = run.iter().map(|word| word.text.as_str()).collect();
        phrases
            .entry(key)
            .and_modify(|at| *at = None)
            .or_insert(Some(index));
    }
    let mut occurrences = HashMap::new();
    for run in recognized.windows(CONTEXT) {
        let key: Vec<_> = run.iter().map(|word| word.text.as_str()).collect();
        *occurrences.entry(key).or_insert(0usize) += 1;
    }
    for (audio_index, run) in recognized.windows(CONTEXT).enumerate() {
        let key: Vec<_> = run.iter().map(|word| word.text.as_str()).collect();
        let Some(Some(index)) = phrases.get(&key).copied() else {
            continue;
        };
        if words[index].start_utf16 < cursor
            || occurrences.get(&key) != Some(&1)
            || (index > 0 && !words[index - 1].sentence_final)
        {
            continue;
        }
        let Some(last) = words[index..]
            .iter()
            .take(80)
            .position(|word| word.sentence_final)
        else {
            continue;
        };
        let count = CONTEXT.max(last + 1);
        let (Some(script), Some(speech)) = (
            words.get(index..index + count),
            recognized.get(audio_index..audio_index + count),
        ) else {
            continue;
        };
        if !script
            .iter()
            .map(|word| &word.text)
            .eq(speech.iter().map(|word| &word.text))
            || speech.iter().any(|word| {
                !word.start_time.is_finite()
                    || !word.end_time.is_finite()
                    || word.start_time < 0.0
                    || word.end_time <= word.start_time
                    || word.end_time > duration
            })
            || speech.windows(2).any(|pair| {
                pair[1].start_time < pair[0].start_time || pair[1].end_time < pair[0].end_time
            })
        {
            continue;
        }
        let start_seconds = speech[0].start_time;
        let end_seconds = speech[last].end_time;
        if !(0.5..=60.0).contains(&(end_seconds - start_seconds)) {
            continue;
        }
        return Some(RecoveryAnchor {
            text_start_utf16: words[index].start_utf16,
            text_end_utf16: words[index + last].end_utf16,
            start_seconds,
            end_seconds,
        });
    }
    None
}

/// A later sentence match cannot justify force-aligning a substantial missing
/// prefix. Small recognition mistakes near the opening retain the normal path.
pub fn recognition_misses_opening(recognized: &[RecognizedWord], text: &str) -> bool {
    recognition_anchor_chain(recognized, text)
        .first()
        .is_some_and(|(_, word)| *word >= 32)
}

pub fn recognition_misses_ending(recognized: &[RecognizedWord], text: &str) -> bool {
    let count = transcript_words(text, 0, u64::MAX).len();
    recognition_anchor_chain(recognized, text)
        .last()
        .is_some_and(|(_, word)| count.saturating_sub(word + ANCHOR_NGRAM) >= 32)
}

/// Where a recognized window can be tied to the transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowAnchor {
    /// Seconds of unscripted audio at the start of the window (a narrated
    /// heading, an image description), or zero. Only set when the first
    /// scripted words were recognized after the window opened.
    pub lead_in_seconds: f64,
    /// The last confident sentence boundary inside the window.
    pub end: Option<WindowEnd>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowEnd {
    /// Seconds into the window at which the sentence-final word ends.
    pub seconds: f64,
    /// Absolute UTF-16 offset in the transcript just past that word.
    pub text_end_utf16: u64,
}

/// Ties a window's recognized words to the transcript from
/// `text_start_utf16` onward (looking at most `text_len_utf16` ahead). Runs
/// of `ANCHOR_NGRAM` words that occur once in that stretch are matched, the
/// longest monotonic chain of matches is kept, and the latest chained word
/// that closes a sentence no later than `latest_seconds` becomes the end.
pub fn find_window_anchor(
    recognized: &[RecognizedWord],
    transcript_text: &str,
    text_start_utf16: u64,
    text_len_utf16: u64,
    latest_seconds: f64,
) -> WindowAnchor {
    let words = transcript_words(transcript_text, text_start_utf16, text_len_utf16);
    let mut grams: HashMap<Vec<&str>, Option<usize>> = HashMap::new();
    for (index, run) in words.windows(ANCHOR_NGRAM).enumerate() {
        let key = run.iter().map(|word| word.text.as_str()).collect();
        grams
            .entry(key)
            .and_modify(|seen| *seen = None)
            .or_insert(Some(index));
    }
    let matches: Vec<(usize, usize)> = recognized
        .windows(ANCHOR_NGRAM)
        .enumerate()
        .filter_map(|(recognized_index, run)| {
            let key: Vec<&str> = run.iter().map(|word| word.text.as_str()).collect();
            let word_index = (*grams.get(&key)?)?;
            Some((recognized_index, word_index))
        })
        .collect();
    let chain = longest_increasing_chain(&matches);

    // The first five-word match can begin a few words into the transcript
    // when recognition misspells a name near the start. Keep looking for a
    // shorter match to the transcript's opening before that anchor. Otherwise
    // the forced aligner spreads a narrated image heading across the first
    // real text sentences.
    let lead_in_seconds = chain
        .first()
        .and_then(|(recognized_index, word_index)| {
            if *word_index == 0 {
                return Some(recognized[*recognized_index].start_time.max(0.0));
            }
            if *word_index > ANCHOR_NGRAM || *recognized_index < 2 {
                return None;
            }
            for length in (2..=(*word_index).min(*recognized_index)).rev() {
                for start in (0..=*recognized_index - length).rev() {
                    if recognized[start..start + length]
                        .iter()
                        .map(|word| word.text.as_str())
                        .eq(words[..length].iter().map(|word| word.text.as_str()))
                    {
                        return Some(recognized[start].start_time.max(0.0));
                    }
                }
            }
            None
        })
        .unwrap_or(0.0);

    let end = chain
        .iter()
        .rev()
        .find_map(|(recognized_index, word_index)| {
            (0..ANCHOR_NGRAM).rev().find_map(|k| {
                let word = &words[word_index + k];
                let seconds = recognized[recognized_index + k].end_time;
                (word.sentence_final && seconds <= latest_seconds).then_some(WindowEnd {
                    seconds,
                    text_end_utf16: word.end_utf16,
                })
            })
        });

    WindowAnchor {
        lead_in_seconds,
        end,
    }
}

/// Longest subsequence of `matches` (already ordered by recognizer position)
/// whose transcript positions strictly increase. Drops matches that would
/// require the narrator to jump backwards or forwards through the text.
fn longest_increasing_chain(matches: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; matches.len()];
    for (index, (_, word_index)) in matches.iter().enumerate() {
        let position = tails.partition_point(|&tail| matches[tail].1 < *word_index);
        if position == tails.len() {
            tails.push(index);
        } else {
            tails[position] = index;
        }
        previous[index] = (position > 0).then(|| tails[position - 1]);
    }
    let mut chain = Vec::new();
    let mut cursor = tails.last().copied();
    while let Some(index) = cursor {
        chain.push(matches[index]);
        cursor = previous[index];
    }
    chain.reverse();
    chain
}

// ---------------------------------------------------------------------------
// Track-to-chapter scoping for multi-file books
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct TrackScope {
    pub track_index: usize,
    pub section_range: std::ops::Range<usize>,
}

/// A matched embedded-audio chapter (or consecutive A/B parts) and its EPUB
/// sections. The exclusive chapter end preserves the full audio interval.
#[derive(Debug, PartialEq)]
pub struct ChapterScope {
    pub chapter_index: usize,
    pub chapter_end_index: usize,
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

/// Maps embedded audiobook chapters to EPUB chapter runs. Unmatched material
/// at either edge and reordered apparatus are allowed, but a prose gap
/// between matched chapters is rejected: assigning that EPUB text to either
/// neighbour would recreate the drift that chapter scoping is meant to stop.
///
/// At least two chapters must match. A single match does not create useful
/// reset points and is too weak a signal to justify slicing the source audio.
#[cfg(test)]
pub fn build_chapter_scopes(
    chapter_titles: &[String],
    toc: &[TocEntry],
    section_count: usize,
) -> Result<Vec<ChapterScope>, String> {
    build_grouped_chapter_scopes(chapter_titles, toc, section_count, None)
}

pub fn build_chapter_scopes_with_sections(
    chapter_titles: &[String],
    toc: &[TocEntry],
    sections: &[SpineSection],
) -> Result<Vec<ChapterScope>, String> {
    build_grouped_chapter_scopes(chapter_titles, toc, sections.len(), Some(sections))
}

fn build_grouped_chapter_scopes(
    chapter_titles: &[String],
    toc: &[TocEntry],
    section_count: usize,
    sections: Option<&[SpineSection]>,
) -> Result<Vec<ChapterScope>, String> {
    let labels = chapter_titles
        .iter()
        .map(|title| parse_label(title))
        .collect::<Vec<_>>();
    let items = toc
        .iter()
        .map(|entry| parse_label(&entry.title))
        .collect::<Vec<_>>();
    let mut titles = Vec::new();
    let mut groups = Vec::new();
    let mut index = 0;
    while index < labels.len() {
        let label = &labels[index];
        let mut end = index + 1;
        // Only explicit consecutive A/B/... parts of one numbered chapter,
        // whose EPUB has an unsplit label. Distinct EPUB A/B chapters retain
        // their own boundaries, as do repeated or missing part labels.
        if label.number.is_some()
            && label.series.is_empty()
            && label.key == "a"
            && items.iter().any(|item| {
                item.number == label.number && item.series.is_empty() && item.key.is_empty()
            })
            && !items.iter().any(|item| {
                item.number == label.number
                    && item.series.is_empty()
                    && item.key.len() == 1
                    && item.key.as_bytes()[0].is_ascii_alphabetic()
            })
        {
            while end < labels.len() && end - index < 26 {
                let next = &labels[end];
                let suffix = char::from(b'a' + (end - index) as u8).to_string();
                if next.number != label.number || !next.series.is_empty() || next.key != suffix {
                    break;
                }
                end += 1;
            }
        }
        titles.push(if end > index + 1 {
            format!("Chapter {}", label.number.unwrap())
        } else {
            chapter_titles[index].clone()
        });
        groups.push(index..end);
        index = end;
    }
    let mut scopes = build_chapter_scopes_inner(&titles, toc, section_count, sections)?;
    for scope in &mut scopes {
        let group = &groups[scope.chapter_index];
        scope.chapter_index = group.start;
        scope.chapter_end_index = group.end;
    }
    Ok(scopes)
}

fn build_chapter_scopes_inner(
    chapter_titles: &[String],
    toc: &[TocEntry],
    section_count: usize,
    sections: Option<&[SpineSection]>,
) -> Result<Vec<ChapterScope>, String> {
    if toc.is_empty() {
        return Err(
            "The EPUB has no usable table of contents to match audio chapters against.".to_string(),
        );
    }

    let targets = chapter_titles
        .iter()
        .map(|title| parse_label(title))
        .collect::<Vec<_>>();
    // Some publishers put illustration links after the main chapter list in
    // the NCX even though their EPUB pages occur between those chapters.
    let mut ordered_toc = toc.iter().collect::<Vec<_>>();
    ordered_toc.sort_by_key(|entry| entry.spine_index);
    let items = ordered_toc
        .iter()
        .map(|entry| parse_label(&entry.title))
        .collect::<Vec<_>>();
    let mut matched = match_in_order(&targets, &items)
        .into_iter()
        .map(|index| index.map(|index| ordered_toc[index].spine_index))
        .collect::<Vec<_>>();

    // A narrated picture without a contents entry can still have one
    // unambiguous image-only spine section between its matched neighbours.
    if let Some(sections) = sections {
        let known = matched
            .iter()
            .enumerate()
            .filter_map(|(index, spine)| spine.map(|spine| (index, spine)))
            .collect::<Vec<_>>();
        for pair in known.windows(2) {
            let (before_chapter, before_spine) = pair[0];
            let (after_chapter, after_spine) = pair[1];
            if after_chapter <= before_chapter + 1 || after_spine <= before_spine + 1 {
                continue;
            }
            let missing = (before_chapter + 1..after_chapter).collect::<Vec<_>>();
            if !missing.iter().all(|index| {
                parse_label(&chapter_titles[*index])
                    .key
                    .split(' ')
                    .any(|word| {
                        matches!(
                            word,
                            "map" | "sketchbook" | "folio" | "glyphs" | "illustration" | "notebook"
                        )
                    })
            }) {
                continue;
            }
            let image_sections = (before_spine + 1..after_spine)
                .filter(|index| {
                    sections
                        .get(*index)
                        .is_some_and(|section| section.text.trim().is_empty())
                })
                .collect::<Vec<_>>();
            // A trailing figure can be followed by an unspoken part divider.
            // Prefer the exact run of figures attached to the preceding text
            // over treating that divider as another narrated illustration.
            let trailing = image_sections
                .iter()
                .copied()
                .filter(|index| sections[*index].href == sections[before_spine].href)
                .collect::<Vec<_>>();
            let mut pictures = if trailing.len() == missing.len() {
                trailing
            } else {
                image_sections
            };
            if pictures.len() != missing.len() {
                // One narration can cover an entire image-only document,
                // including its part heading and the following illustration.
                pictures.dedup_by(|right, left| sections[*right].href == sections[*left].href);
            }
            if pictures.len() == missing.len() {
                for (chapter, spine) in missing.into_iter().zip(pictures) {
                    matched[chapter] = Some(spine);
                }
            }
        }
    }

    let matched_indices = matched
        .iter()
        .enumerate()
        .filter_map(|(index, spine)| spine.map(|spine| (index, spine)))
        .collect::<Vec<_>>();
    if matched_indices.len() < 2 {
        return Err("Fewer than two embedded audio chapters matched the EPUB.".to_string());
    }
    if matched_indices
        .windows(2)
        .any(|pair| pair[0].1 >= pair[1].1)
    {
        return Err(
            "Embedded chapters share or reverse EPUB documents; use whole-track alignment."
                .to_string(),
        );
    }

    let first = matched_indices.first().expect("checked above").0;
    let last = matched_indices.last().expect("checked above").0;
    if let Some((index, _)) = matched.iter().enumerate().find(|(index, spine)| {
        *index > first
            && *index < last
            && spine.is_none()
            && !(targets[*index].number.is_none()
                && matches!(
                    targets[*index].key.as_str(),
                    "acknowledgments"
                        | "acknowledgements"
                        | "about the author"
                        | "credits"
                        | "opening credits"
                        | "closing credits"
                        | "end credits"
                ))
    }) {
        return Err(format!(
            "Embedded audio chapter `{}` could not be matched between two matched chapters.",
            chapter_titles[index]
        ));
    }

    // The last chapter ends where the next table-of-contents entry begins,
    // not at the end of the spine: back matter such as "About the Author" is
    // not narrated, and the aligner would spread it over the closing audio.
    let last_spine = matched_indices.last().expect("checked above").1;
    let trailing_end = toc
        .iter()
        .map(|entry| entry.spine_index)
        .filter(|spine_index| *spine_index > last_spine)
        .min()
        .unwrap_or(section_count)
        .min(section_count);

    Ok(matched_indices
        .iter()
        .enumerate()
        .map(|(position, (chapter_index, start))| {
            let next_start = matched_indices
                .get(position + 1)
                .map(|(_, next_start)| *next_start)
                .unwrap_or(trailing_end);
            // An unspoken acknowledgments page can sit after a dedication
            // in print but be read at the end of the audiobook. Do not force
            // that intervening apparatus into the preceding chapter's audio.
            let end = toc
                .iter()
                .filter(|entry| {
                    let label = parse_label(&entry.title);
                    entry.spine_index > *start
                        && entry.spine_index < next_start
                        && label.number.is_none()
                        && matches!(
                            label.key.as_str(),
                            "acknowledgments"
                                | "acknowledgements"
                                | "about the author"
                                | "copyright"
                                | "copyright page"
                                | "table of contents"
                                | "contents"
                        )
                })
                .map(|entry| entry.spine_index)
                .min()
                .unwrap_or(next_start);
            ChapterScope {
                chapter_index: *chapter_index,
                chapter_end_index: *chapter_index + 1,
                section_range: *start..end,
            }
        })
        .collect())
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

    // Publishers also spell the interlude series out: "Interludes:
    // Interlude 3: A Visitor" is the same identity as "I-3. A Visitor".
    if !lower.contains("chapter ")
        && let Some(at) = lower.rfind("interlude ")
        && (at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric())
        && let Some((parsed, consumed)) = parse_number_token(&value[at + 10..])
    {
        let rest = value[at + 10 + consumed..].trim_start();
        if rest.is_empty() || rest.starts_with(LABEL_SEPARATORS) {
            return ParsedLabel {
                number: Some(parsed),
                series: "i".to_string(),
                key: normalize_label_text(rest.trim_start_matches(LABEL_SEPARATORS).trim_start()),
            };
        }
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
            if rest.is_empty() {
                number = Some(parsed);
                remainder.clear();
            } else if trimmed.as_bytes()[0].is_ascii_digit()
                && trimmed[consumed..].starts_with(char::is_whitespace)
            {
                number = Some(parsed);
                remainder = rest
                    .trim_start_matches(LABEL_SEPARATORS)
                    .trim_start()
                    .to_string();
            } else if let Some(rest) = rest.strip_prefix(LABEL_SEPARATORS).map(str::trim_start) {
                number = Some(parsed);
                remainder = rest.to_string();
            }
        }
    }

    // Embedded chapter titles may carry a part label before the chapter
    // number: "Part Four: A Knowledge: 74. A Symbol".
    if number.is_none()
        && let Some((_, tail)) = value.rsplit_once(':')
    {
        let tail = tail.trim_start();
        if let Some((parsed, consumed)) = parse_number_token(tail) {
            let rest = tail[consumed..].trim_start();
            if let Some(rest) = rest.strip_prefix(LABEL_SEPARATORS).map(str::trim_start) {
                number = Some(parsed);
                remainder = rest.to_string();
            }
        }
    }

    // Audiobook chapter metadata commonly prefixes individual interludes
    // (`Interlude I-1: Puuli`) while the EPUB TOC uses only the interlude code
    // (`I-1. Puuli`). The prefix carries no identity and otherwise prevents an
    // exact title match.
    let remainder_lower = remainder.to_ascii_lowercase();
    if let Some(after) = remainder_lower
        .strip_prefix("interlude ")
        .or_else(|| remainder_lower.strip_prefix("interlude:"))
    {
        let prefix_bytes = remainder.len() - after.len();
        remainder = remainder[prefix_bytes..].trim_start().to_string();
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
    let mut total = 0i64;
    for (index, c) in chars.iter().enumerate() {
        let value = value_of(*c);
        let next = chars.get(index + 1).map(|c| value_of(*c)).unwrap_or(0);
        if value < next {
            total = total.checked_sub(value)?;
        } else {
            total = total.checked_add(value)?;
        }
    }
    // Round-trip through the canonical spelling so `IIII` and `VX` are
    // rejected rather than read as some number.
    let total = u32::try_from(total).ok()?;
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
        } else if target.key.ends_with(&format!(" {}", item.key)) && item.key.len() >= 8 {
            // Embedded audio labels often include a part title before the
            // EPUB's chapter title: "Part Four: A Knowledge: 74. A Symbol".
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
    #[test]
    fn ncx_fills_missing_nav_documents_without_replacing_nav_labels() {
        use std::io::{Read, Write};
        let bytes = super::build_test_epub();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut output = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let name = entry.name().to_string();
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            if name.ends_with(".opf") {
                text = text.replace("</manifest>", "<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/></manifest>");
            }
            if name == "OEBPS/nav.xhtml" {
                text = "<nav epub:type=\"toc\"><a href=\"text/ch1.xhtml\">Chapter 1: Preferred</a></nav>".into();
            }
            output
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            output.write_all(text.as_bytes()).unwrap();
        }
        output
            .start_file("OEBPS/toc.ncx", zip::write::SimpleFileOptions::default())
            .unwrap();
        output.write_all(br#"<ncx><navMap><navPoint><navLabel><text>Old name</text></navLabel><content src="text/ch1.xhtml"/></navPoint><navPoint><navLabel><text>Chapter 2</text></navLabel><content src="text/ch2.xhtml"/></navPoint></navMap></ncx>"#).unwrap();
        let epub = parse_epub(&output.finish().unwrap().into_inner()).unwrap();
        assert_eq!(epub.toc.len(), 2);
        assert_eq!(epub.toc[0].title, "Chapter 1: Preferred");
        assert_eq!(epub.toc[1].title, "Chapter 2");
        assert_eq!(epub.toc[1].spine_index, 1);
    }

    #[test]
    fn numbered_titles_allow_whitespace_but_not_partial_words() {
        let label = parse_label("16 The Crossing");
        assert_eq!(label.number, Some(16));
        assert_eq!(label.key, "the crossing");
        assert_eq!(parse_label("16th Crossing").number, None);
        assert_eq!(parse_label("Seven Swans").number, None);
    }

    #[test]
    fn split_audio_parts_share_only_an_unsplit_epub_chapter() {
        let titles = [
            "Chapter 1",
            "Chapter 2A",
            "Chapter 2B",
            "Chapter 2C",
            "Chapter 3",
        ]
        .map(str::to_string);
        let toc = ["Chapter 1", "Chapter 2", "Chapter 3"]
            .iter()
            .enumerate()
            .map(|(spine_index, title)| TocEntry {
                title: title.to_string(),
                spine_index,
            })
            .collect::<Vec<_>>();
        let scopes = build_chapter_scopes(&titles, &toc, 3).unwrap();
        assert_eq!(
            scopes
                .iter()
                .map(|s| (
                    s.chapter_index,
                    s.chapter_end_index,
                    s.section_range.clone()
                ))
                .collect::<Vec<_>>(),
            vec![(0, 1, 0..1), (1, 4, 1..2), (4, 5, 2..3)]
        );
        let split_toc = titles
            .iter()
            .enumerate()
            .map(|(spine_index, title)| TocEntry {
                title: title.clone(),
                spine_index,
            })
            .collect::<Vec<_>>();
        let scopes = build_chapter_scopes(&titles, &split_toc, 5).unwrap();
        assert_eq!(scopes.len(), 5);
        assert!(
            scopes
                .iter()
                .all(|s| s.chapter_end_index == s.chapter_index + 1)
        );
        let missing_part =
            ["Chapter 1", "Chapter 2A", "Chapter 2C", "Chapter 3"].map(str::to_string);
        assert!(build_chapter_scopes(&missing_part, &toc, 3).is_err());
    }

    #[test]
    fn reordered_apparatus_does_not_expand_adjacent_audio_scopes() {
        let titles = [
            "Dedication",
            "Chapter 1",
            "Chapter 2",
            "Acknowledgments",
            "About the Author",
        ]
        .map(str::to_string);
        let toc = [
            "Dedication",
            "Acknowledgments",
            "Chapter 1",
            "Chapter 2",
            "About the Author",
        ]
        .iter()
        .enumerate()
        .map(|(spine_index, title)| TocEntry {
            title: title.to_string(),
            spine_index,
        })
        .collect::<Vec<_>>();
        let scopes = build_chapter_scopes(&titles, &toc, 5).unwrap();
        assert_eq!(scopes[0].section_range, 0..1);
        assert_eq!(scopes.len(), 4);
        assert!(!scopes.iter().any(|s| s.chapter_index == 3));
    }

    #[test]
    fn epub_text_budget_counts_repeated_reads() {
        let bytes = super::build_test_epub();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut remaining = 512;
        super::read_zip_text(&mut archive, "OEBPS/text/ch1.xhtml", &mut remaining).unwrap();
        assert!(remaining < 512);
        remaining = 1;
        assert!(
            super::read_zip_text(&mut archive, "OEBPS/text/ch1.xhtml", &mut remaining).is_err()
        );
    }
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
    fn abbreviated_image_interludes_use_the_spoken_label() {
        let mut transcript = build_transcript(&[SpineSection {
            href: "interlude.xhtml".into(),
            text: "The visitor locked the door.".into(),
        }]);
        transcript.prepend_unmapped("I-3: A Visitor");
        assert_eq!(
            transcript.text,
            "Interlude 3: A Visitor.\n\nThe visitor locked the door."
        );
        let offset = transcript.sections[1].start_utf16;
        assert_eq!(transcript.href_for_offset(offset - 1), Some(""));
        assert_eq!(transcript.href_for_offset(offset), Some("interlude.xhtml"));
    }

    #[test]
    fn image_headings_consume_audio_without_becoming_text_highlights() {
        assert!(starts_with_image(
            "<html><head><title>Book</title></head><body><p><img src='title.jpg'/></p><p>Text</p></body></html>"
        ));
        assert!(!starts_with_image(
            "<body><h1>Chapter one</h1><img src='decoration.jpg'/></body>"
        ));
        let mut transcript = build_transcript(&[SpineSection {
            href: "chapter.xhtml".into(),
            text: "I approach this project with inspiration renewed.".into(),
        }]);
        transcript.prepend_unmapped("47. A Cage Forged of Spirits");
        let first_text = transcript.sections[1].start_utf16;
        let entries = vec![
            TimelineEntry {
                kind: "sentence".into(),
                text: "47. A Cage Forged of Spirits.".into(),
                start_time: 0.5,
                end_time: 5.5,
                start_offset_utf16: Some(0),
                end_offset_utf16: Some(first_text - 2),
                timeline: None,
            },
            TimelineEntry {
                kind: "sentence".into(),
                text: "I approach this project with inspiration renewed.".into(),
                start_time: 6.0,
                end_time: 10.0,
                start_offset_utf16: Some(first_text),
                end_offset_utf16: Some(transcript.len_utf16()),
                timeline: None,
            },
        ];
        let fragments = fragments_from_timeline(&entries, &transcript, 100.0);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].href, "chapter.xhtml");
        assert_eq!(fragments[0].start_seconds, 106.0);
        let mut without_offsets = entries;
        for entry in &mut without_offsets {
            entry.start_offset_utf16 = None;
            entry.end_offset_utf16 = None;
        }
        let fallback = fragments_from_timeline(&without_offsets, &transcript, 100.0);
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].text, fragments[0].text);
        assert_eq!(fallback[0].start_seconds, 106.0);
        let window = transcript.window(first_text, transcript.len_utf16());
        assert_eq!(window.href_for_offset(0), Some("chapter.xhtml"));
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
    fn chapter_scopes_allow_unmatched_edge_credits() {
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
            "Closing Credits".to_string(),
        ];

        assert_eq!(
            build_chapter_scopes(&titles, &toc, 3).unwrap(),
            vec![
                ChapterScope {
                    chapter_index: 1,
                    chapter_end_index: 2,
                    section_range: 1..2,
                },
                ChapterScope {
                    chapter_index: 2,
                    chapter_end_index: 3,
                    section_range: 2..3,
                },
            ]
        );
    }

    #[test]
    fn embedded_chapters_match_repeated_titles_in_order() {
        let titles = ["Interlude", "Chapter 2", "Interlude", "Chapter 4"]
            .map(str::to_string)
            .to_vec();
        let toc = titles
            .iter()
            .enumerate()
            .map(|(spine_index, title)| TocEntry {
                title: title.clone(),
                spine_index,
            })
            .collect::<Vec<_>>();
        let scopes = build_chapter_scopes(&titles, &toc, 4).unwrap();
        assert_eq!(
            scopes
                .iter()
                .map(|scope| (scope.chapter_index, scope.section_range.clone()))
                .collect::<Vec<_>>(),
            vec![(0, 0..1), (1, 1..2), (2, 2..3), (3, 3..4)]
        );
        let shared = toc
            .into_iter()
            .map(|entry| TocEntry {
                spine_index: 0,
                ..entry
            })
            .collect::<Vec<_>>();
        assert!(build_chapter_scopes(&titles, &shared, 1).is_err());
    }

    #[test]
    fn spelled_interlude_numbers_match_the_lettered_series() {
        let audio = parse_label("Interludes: Interlude 3: A Visitor");
        assert_eq!(
            label_match_score(&audio, &parse_label("I-3. A Visitor")),
            180
        );
        assert_eq!(label_match_score(&audio, &parse_label("Chapter 3")), 0);
        assert_eq!(parse_label("Interlude Three: A Visitor").number, Some(3));
        assert_eq!(parse_label("An Interlude Three Wishes").number, None);
    }

    #[test]
    fn trailing_figures_have_audio_boundaries_without_moving_prose() {
        let epub = parse_epub(&build_test_epub_with_text(
            "<h1>Chapter 1</h1><p>The meadow was quiet.</p><figure><img src='map.png'/></figure>",
            "<h1>Chapter 2</h1><p>The river ran fast.</p>",
        ))
        .unwrap();
        assert_eq!(epub.sections.len(), 3);
        assert_eq!(epub.sections[0].href, epub.sections[1].href);
        assert!(epub.sections[1].text.is_empty());
        assert_eq!(epub.toc[1].spine_index, 2);
        let scopes = build_chapter_scopes_with_sections(
            &[
                "Chapter 1".into(),
                "Illustration: The Meadow".into(),
                "Chapter 2".into(),
            ],
            &epub.toc,
            &epub.sections,
        )
        .unwrap();
        assert_eq!(
            scopes
                .iter()
                .map(|scope| scope.section_range.clone())
                .collect::<Vec<_>>(),
            vec![0..1, 1..2, 2..3]
        );
        assert_eq!(
            build_transcript(&epub.sections).text,
            "Chapter 1\n\nThe meadow was quiet.\n\nChapter 2\n\nThe river ran fast."
        );
        for html in [
            "<body><img src='heading.png'/><p>Spoken prose.</p></body>",
            "<body><img src='only-picture.png'/></body>",
            "<body><p>Before.</p><img src='inline.png'/><p>After.</p></body>",
        ] {
            assert_eq!(trailing_image_count(html), 0);
        }
    }

    #[test]
    fn image_only_documents_allow_combined_or_separate_narration() {
        let epub = parse_epub(&build_test_epub_with_text(
            "<img src='part.png'/><img src='map.png'/>",
            "<p>The river ran fast.</p>",
        ))
        .unwrap();
        assert_eq!(epub.sections.len(), 3);
        let separate = build_chapter_scopes_with_sections(
            &[
                "Chapter 1".into(),
                "Illustration: Map".into(),
                "Chapter 2".into(),
            ],
            &epub.toc,
            &epub.sections,
        )
        .unwrap();
        assert_eq!(separate[0].section_range, 0..1);
        assert_eq!(separate[1].section_range, 1..2);
        let combined = build_chapter_scopes_with_sections(
            &["Chapter 1".into(), "Chapter 2".into()],
            &epub.toc,
            &epub.sections,
        )
        .unwrap();
        assert_eq!(combined[0].section_range, 0..2);
    }

    #[test]
    fn chapter_scopes_reject_an_unmatched_interior_chapter() {
        let toc = vec![
            TocEntry {
                title: "Chapter 1".into(),
                spine_index: 0,
            },
            TocEntry {
                title: "Chapter 2".into(),
                spine_index: 1,
            },
            TocEntry {
                title: "Chapter 3".into(),
                spine_index: 2,
            },
        ];
        let titles = vec![
            "Chapter 1".to_string(),
            "An unrelated interlude".to_string(),
            "Chapter 3".to_string(),
        ];

        assert!(build_chapter_scopes(&titles, &toc, 3).is_err());
    }

    #[test]
    fn chapter_scopes_keep_narrated_images_between_prefixed_audio_chapters() {
        let titles = [
            "Part Three: 46. The Weight of the Tower",
            "Part Three: Annotated Map of the War in Emul",
            "Part Three: 47. A Cage Forged of Spirits",
            "Part Four: A Knowledge",
            "Part Four: A Knowledge: Alethi Glyphs Page 2",
            "Part Four: A Knowledge: 73. Which Master to Follow",
            "Part Four: A Knowledge: 74. A Symbol",
        ]
        .map(str::to_string);
        // The publisher lists the glyph page after the main chapters even
        // though its spine section belongs between the part title and 73.
        let toc = [
            ("46. The Weight of the Tower", 0),
            ("47. A Cage Forged of Spirits", 2),
            ("Part Four: A Knowledge", 3),
            ("73. Which Master to Follow", 5),
            ("74. A Symbol", 6),
            ("Alethi Glyphs Page 2", 4),
        ]
        .map(|(title, spine_index)| TocEntry {
            title: title.into(),
            spine_index,
        });
        let sections = (0..7)
            .map(|index| SpineSection {
                href: format!("{index}.xhtml"),
                text: if matches!(index, 1 | 3 | 4) {
                    String::new()
                } else {
                    "Chapter text.".into()
                },
            })
            .collect::<Vec<_>>();

        let scopes = build_chapter_scopes_with_sections(&titles, &toc, &sections).unwrap();
        assert_eq!(scopes.len(), 7);
        for (index, scope) in scopes.iter().enumerate() {
            assert_eq!(scope.chapter_index, index);
            assert_eq!(scope.section_range, index..index + 1);
        }
    }

    #[test]
    fn chapter_scopes_require_multiple_reset_points() {
        let toc = vec![TocEntry {
            title: "Chapter 1".into(),
            spine_index: 0,
        }];
        let titles = vec!["Chapter 1".to_string()];

        assert!(build_chapter_scopes(&titles, &toc, 1).is_err());
    }

    #[test]
    fn bare_contents_numbers_match_spoken_chapter_labels() {
        let toc = ["Prologue", "1", "2", "3", "Epilogue"]
            .iter()
            .enumerate()
            .map(|(spine_index, title)| TocEntry {
                title: (*title).into(),
                spine_index,
            })
            .collect::<Vec<_>>();
        let titles = [
            "Prologue",
            "Chapter One",
            "Chapter Two",
            "Chapter Three",
            "Epilogue",
        ]
        .map(str::to_string);
        let scopes = build_chapter_scopes(&titles, &toc, 5).unwrap();
        assert_eq!(scopes.len(), 5);
        for (index, scope) in scopes.iter().enumerate() {
            assert_eq!(scope.section_range, index..index + 1);
        }
        for label in ["7", "VII", "Seven"] {
            assert_eq!(parse_label(label).number, Some(7));
        }
        assert!(parse_label("Seven Swans").number.is_none());
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
    fn the_last_chapter_scope_stops_at_the_next_toc_entry() {
        let toc = vec![
            TocEntry {
                title: "Chapter 1".into(),
                spine_index: 0,
            },
            TocEntry {
                title: "Chapter 2".into(),
                spine_index: 1,
            },
            TocEntry {
                title: "About the Author".into(),
                spine_index: 3,
            },
        ];
        let titles = vec!["Chapter 1".to_string(), "Chapter 2".to_string()];

        let scopes = build_chapter_scopes(&titles, &toc, 5).unwrap();

        assert_eq!(scopes[1].section_range, 1..3);
    }

    fn spoken(words: &str, start_time: f64) -> Vec<RecognizedWord> {
        words
            .split_whitespace()
            .enumerate()
            .map(|(index, word)| RecognizedWord {
                text: normalize_word(word),
                start_time: start_time + index as f64 * 0.5,
                end_time: start_time + index as f64 * 0.5 + 0.4,
            })
            .collect()
    }

    #[test]
    fn recovery_restarts_at_a_complete_unique_sentence_after_unknown_text() {
        let prefix = "A café🦉 passage is missing from this edition. ";
        let sentence = "A lantern flickered beside the empty railway station.";
        let following = "Several travellers waited quietly for the morning train.";
        let text = format!("{prefix}{sentence} {following}");
        let recognized = spoken(
            &format!("unexpected noises continue {sentence} {following}"),
            2.0,
        );
        let anchor = find_recovery_anchor(&recognized, &text, 0, 30.0).unwrap();
        assert_eq!(
            anchor.text_start_utf16,
            prefix.encode_utf16().count() as u64
        );
        assert_eq!(
            anchor.text_end_utf16,
            format!("{prefix}{sentence}").encode_utf16().count() as u64
        );
        assert_eq!(anchor.start_seconds, 3.5);
        assert!((anchor.end_seconds - 7.4).abs() < 1e-9);
        // An already-consumed sentence cannot drag recovery backwards.
        assert!(find_recovery_anchor(&recognized, &text, anchor.text_end_utf16, 30.0).is_none());
    }

    #[test]
    fn recovery_rejects_ambiguous_phrases_and_untrustworthy_clocks() {
        let text = "A lantern flickered beside the empty railway station. Several travellers waited quietly for the morning train.";
        let recognized = spoken(text, 1.0);
        assert!(find_recovery_anchor(&recognized, text, 0, 30.0).is_some());
        assert!(find_recovery_anchor(&recognized, &format!("{text} {text}"), 0, 30.0).is_none());
        assert!(
            find_recovery_anchor(
                &recognized,
                &format!("{text} {text}"),
                text.encode_utf16().count() as u64,
                30.0
            )
            .is_none()
        );
        let repeated = [recognized.clone(), spoken(text, 12.0)].concat();
        assert!(find_recovery_anchor(&repeated, text, 0, 30.0).is_none());
        for invalid in [f64::NAN, -1.0, 100.0] {
            let mut bad = recognized.clone();
            bad[3].end_time = invalid;
            assert!(find_recovery_anchor(&bad, text, 0, 30.0).is_none());
        }
        assert!(find_recovery_anchor(&recognized[..9], text, 0, 30.0).is_none());
    }

    #[test]
    fn unreliable_recognition_requests_a_bounded_retry() {
        let tokens = (0..60)
            .map(|index| format!("word{index}"))
            .collect::<Vec<_>>();
        let text = tokens.join(" ");
        assert!(!recognition_needs_retry(&spoken(&text, 0.0), &text));
        let skipped = tokens[..15]
            .iter()
            .chain(&tokens[45..])
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(recognition_needs_retry(&spoken(&skipped, 0.0), &text));
        assert!(recognition_needs_retry(
            &spoken(&"this phrase keeps repeating ".repeat(6), 0.0),
            &text
        ));
        assert!(recognition_needs_retry(&[], &text));
        let mut names = tokens;
        names[10] = "misspelled".into();
        names[30] = "anothername".into();
        assert!(!recognition_needs_retry(
            &spoken(&names.join(" "), 0.0),
            &text
        ));
        assert!(!recognition_needs_retry(
            &spoken("A short sentence.", 0.0),
            "A short sentence."
        ));
    }

    #[test]
    fn zero_duration_interjection_requires_unique_nearby_spoken_context() {
        let text = "Someone reached the open door. But— Another visitor crossed the courtyard.";
        let offset = text.find("But").unwrap() as u64;
        let json = format!(
            r#"[{{"type":"sentence","text":"But—","startTime":2.7,"endTime":2.7,"startOffsetUtf16":{offset}}}]"#
        );
        let mut timeline = parse_timeline(&json).unwrap();
        let recognized = spoken(text, 0.0);
        recover_zero_duration_sentences(&mut timeline, text, &recognized);
        assert_eq!((timeline[0].start_time, timeline[0].end_time), (2.5, 2.9));
        for speech in [
            spoken(&text.replace("But— ", ""), 0.0),
            spoken(text, 30.0),
            spoken(&format!("{text} {text}"), 0.0),
        ] {
            let mut timeline = parse_timeline(&json).unwrap();
            recover_zero_duration_sentences(&mut timeline, text, &speech);
            assert_eq!(timeline[0].start_time, timeline[0].end_time);
        }
    }

    #[test]
    fn trailing_description_keeps_prose_and_unicode_offsets_unchanged() {
        let text = "The café🦉 was quiet. Then we returned to the river.";
        let extra = "an illustration shows a wooden bridge crossing a wide river beside tall trees";
        let mut transcript = build_transcript(&[SpineSection {
            href: "chapter.xhtml".into(),
            text: text.into(),
        }]);
        let recognition = spoken(&format!("{text} {extra}"), 0.0);
        assert_eq!(
            transcript.include_unmapped_trailing_narration(&recognition),
            1
        );
        let mapped = &transcript.sections[0];
        assert_eq!(mapped.start_utf16, 0);
        assert_eq!(mapped.end_utf16, text.encode_utf16().count() as u64);
        assert_eq!(&transcript.text[..text.len()], text);
        assert_eq!(transcript.href_for_offset(mapped.end_utf16 + 2), Some(""));
        assert_eq!(
            transcript.include_unmapped_trailing_narration(&recognition),
            0
        );
        let mut without_punctuation = build_transcript(&[SpineSection {
            href: "chapter.xhtml".into(),
            text: "They returned to the café. THE END".into(),
        }]);
        assert_eq!(
            without_punctuation.include_unmapped_trailing_narration(&spoken(
                &format!("They returned to the café. THE END {extra}"),
                0.0
            )),
            1
        );
        for speech in [
            format!("{text} a brief noise"),
            format!("{text} {extra} Then we returned to the river."),
            format!("The café was quiet. Then we returned somewhere else. {extra}"),
        ] {
            let mut transcript = build_transcript(&[SpineSection {
                href: "chapter.xhtml".into(),
                text: text.into(),
            }]);
            assert_eq!(
                transcript.include_unmapped_trailing_narration(&spoken(&speech, 0.0)),
                0
            );
            assert_eq!(transcript.text, text);
        }
    }

    #[test]
    fn additional_narration_is_unmapped_and_preserves_unicode_text_locations() {
        let before = "The café doors stood open.";
        let after = "We walked into the quiet courtyard.";
        let extra = "this picture shows a river winding around the valley";
        let mut transcript = build_transcript(&[SpineSection {
            href: "chapter.xhtml".into(),
            text: format!("{before} {after}"),
        }]);
        let recognized = spoken(&format!("{before} {extra} {after}"), 0.0);
        assert_eq!(transcript.include_unmapped_narration(&recognized), 1);
        let unmapped = &transcript.sections[1];
        assert_eq!(transcript.href_for_offset(unmapped.start_utf16), Some(""));
        let after_offset = transcript.text[..transcript.text.find(after).unwrap()]
            .encode_utf16()
            .count() as u64;
        assert_eq!(
            transcript.href_for_offset(after_offset),
            Some("chapter.xhtml")
        );
        assert_eq!(
            &transcript.text[utf16_to_byte_index(&transcript.text, after_offset)..],
            after
        );
        assert_eq!(transcript.include_unmapped_narration(&recognized), 0);
    }

    #[test]
    fn isolated_recognition_errors_preserve_all_scripted_text() {
        let text = (0..16).map(|index| format!(
            "Visitor{index} reached the café🦉 before sunrise. The quiet room held parcel{index} beside the window."
        )).collect::<Vec<_>>().join("\n\n");
        let full = spoken(&text, 0.0);
        for index in 0..full.len() {
            for substitute in [false, true] {
                let mut recognized = full.clone();
                if substitute {
                    recognized[index].text = "misheard".into();
                } else {
                    recognized.remove(index);
                }
                let mut transcript = build_transcript(&[SpineSection {
                    href: "chapter.xhtml".into(),
                    text: text.clone(),
                }]);
                assert_eq!(
                    transcript.mask_unspoken_sentences(&recognized),
                    0,
                    "word {index}, substitute {substitute}"
                );
                assert_eq!(
                    transcript.include_unmapped_narration(&recognized),
                    0,
                    "word {index}, substitute {substitute}"
                );
                assert_eq!(transcript.text, text);
            }
        }
    }

    #[test]
    fn multiple_narrated_insertions_preserve_every_mapped_character() {
        let text = "The café🦉 doors stood open. We walked into the quiet courtyard. The stairway ended beside the tower. A visitor greeted us from the balcony.";
        let speech = "The café🦉 doors stood open. this diagram shows a river curving around the distant valley We walked into the quiet courtyard. The stairway ended beside the tower. another illustration shows the narrow stairs rising beside a stone wall A visitor greeted us from the balcony.";
        let mut transcript = build_transcript(&[SpineSection {
            href: "chapter.xhtml".into(),
            text: text.into(),
        }]);
        let recognition = spoken(speech, 0.0);
        assert_eq!(transcript.include_unmapped_narration(&recognition), 2);
        let mapped = transcript
            .sections
            .iter()
            .filter(|section| !section.href.is_empty())
            .map(|section| {
                &transcript.text[utf16_to_byte_index(&transcript.text, section.start_utf16)
                    ..utf16_to_byte_index(&transcript.text, section.end_utf16)]
            })
            .collect::<String>();
        assert_eq!(mapped, text);
        assert_eq!(transcript.include_unmapped_narration(&recognition), 0);
        assert_eq!(transcript.mask_unspoken_sentences(&recognition), 0);
    }

    #[test]
    fn extra_speech_requires_unique_phrases_and_a_sentence_boundary() {
        for (text, speech) in [
            (
                "The first door stood open. We went inside together.",
                "The first door stood open. briefly then We went inside together.",
            ),
            (
                "The first door stood open and we went inside together.",
                "The first door stood open this picture shows a river winding around the valley and we went inside together.",
            ),
            (
                "The first door stood open. We went inside together. We went inside together.",
                "The first door stood open. this picture shows a river winding around the valley We went inside together. We went inside together.",
            ),
            (
                "The tower stood above the mountain. Something’s wrong with my powers she whispered softly.",
                "The tower stood above the mountain. some things wrong with my powers she whispered softly and could not understand it somethings wrong with my powers she whispered softly.",
            ),
        ] {
            let mut transcript = build_transcript(&[SpineSection {
                href: "chapter.xhtml".into(),
                text: text.into(),
            }]);
            assert_eq!(
                transcript.include_unmapped_narration(&spoken(speech, 0.0)),
                0
            );
            assert_eq!(transcript.text, text);
        }
        let mut transcript = build_transcript(&[
            SpineSection {
                href: "before.xhtml".into(),
                text: "The first door stood open.".into(),
            },
            SpineSection {
                href: "after.xhtml".into(),
                text: "We went inside together.".into(),
            },
        ]);
        assert_eq!(transcript.include_unmapped_narration(&spoken("The first door stood open. this picture shows a river winding around the valley We went inside together.", 0.0)), 0);
    }

    /// Check saved probe windows for additional narration without rerunning
    /// recognition. Fixtures remain private and outside the source tree.
    #[test]
    #[ignore = "manual cached-recognition probe"]
    fn manual_cached_narration_probe() {
        let directory =
            std::path::PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_CACHE").unwrap());
        let mut checked = 0;
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy();
            if !name.starts_with("alignment-") || !name.ends_with(".json") {
                continue;
            }
            let recognition_path =
                path.with_file_name(name.replacen("alignment-", "recognition-", 1));
            if !recognition_path.exists() {
                continue;
            }
            let timeline = parse_timeline(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let mut sentences = Vec::new();
            collect_sentences(&timeline, &mut sentences);
            let text = sentences
                .iter()
                .map(|sentence| sentence.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let mut transcript = build_transcript(&[SpineSection {
                href: "probe.xhtml".into(),
                text,
            }]);
            let recognized = recognized_words(
                &parse_timeline(&std::fs::read_to_string(recognition_path).unwrap()).unwrap(),
            );
            let count = transcript.include_unmapped_narration(&recognized);
            if count > 0 {
                println!("{name}: {count} additional narration passage(s)");
            }
            if recognition_needs_retry(&recognized, &transcript.text) {
                println!("{name}: recognition still uncertain");
            }
            checked += 1;
        }
        assert!(checked > 0);
        println!("checked {checked} cached windows");
    }

    #[test]
    fn unspoken_sentences_keep_offsets_and_following_text() {
        let before = "The river reached the old bridge.";
        let absent = "An older edition added this entire explanation. Another unspoken line mentions café🦉.";
        let after = "Tomorrow we cross into the forest.";
        let mut transcript = build_transcript(&[SpineSection {
            href: "chapter.xhtml".into(),
            text: format!("{before} {absent} {after}"),
        }]);
        let length = transcript.len_utf16();
        let after_offset = transcript.text.find(after).unwrap();
        let after_utf16 = transcript.text[..after_offset].encode_utf16().count() as u64;
        let recognition = spoken(&format!("{before} {after}"), 0.0);
        assert_eq!(transcript.mask_unspoken_sentences(&recognition), 1);
        assert_eq!(transcript.len_utf16(), length);
        assert_eq!(
            transcript.href_for_offset(after_utf16),
            Some("chapter.xhtml")
        );
        assert_eq!(
            transcript
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            format!("{before} {after}")
        );
        assert_eq!(transcript.window(after_utf16, length).text, after);
    }

    #[test]
    fn uncertain_recognition_does_not_remove_spoken_text() {
        let text = "The river reached the old bridge. An older edition added this entire explanation. Tomorrow we cross into the forest.";
        let original = || {
            build_transcript(&[SpineSection {
                href: "chapter.xhtml".into(),
                text: text.into(),
            }])
        };
        let mut full = original();
        assert_eq!(full.mask_unspoken_sentences(&spoken(text, 0.0)), 0);
        let mut missing = spoken(
            "The river reached the old bridge. Tomorrow we cross into the forest.",
            0.0,
        );
        for word in &mut missing[6..] {
            word.start_time += 5.0;
            word.end_time += 5.0;
        }
        let mut gap = original();
        assert_eq!(gap.mask_unspoken_sentences(&missing), 0);
        assert_eq!(gap.text, text);
        let mut repeated = original();
        let repeated_audio = spoken(
            "The river reached the old bridge. Tomorrow we cross into the forest. Tomorrow we cross into the forest.",
            0.0,
        );
        assert_eq!(repeated.mask_unspoken_sentences(&repeated_audio), 0);
        let mut partial = build_transcript(&[SpineSection {
            href: "chapter.xhtml".into(),
            text: text.replace("bridge.", "bridge,"),
        }]);
        assert_eq!(
            partial.mask_unspoken_sentences(&spoken(
                "The river reached the old bridge. Tomorrow we cross into the forest.",
                0.0
            )),
            0
        );
    }

    #[test]
    fn omissions_do_not_cross_documents_or_unmapped_headings() {
        let mut transcript = build_transcript(&[
            SpineSection {
                href: "a.xhtml".into(),
                text: "The river reached the old bridge. An older edition added".into(),
            },
            SpineSection {
                href: "b.xhtml".into(),
                text: "this entire explanation. Tomorrow we cross into the forest.".into(),
            },
        ]);
        let recognition = spoken(
            "The river reached the old bridge. Tomorrow we cross into the forest.",
            0.0,
        );
        assert_eq!(transcript.mask_unspoken_sentences(&recognition), 0);
        let mut heading = build_transcript(&[SpineSection {
            href: "b.xhtml".into(),
            text: "Tomorrow we cross into the forest.".into(),
        }]);
        heading.prepend_unmapped(
            "The river reached the old bridge. An older edition added this entire explanation",
        );
        assert_eq!(heading.mask_unspoken_sentences(&recognition), 0);
    }

    /// UTF-16 offset just past the first occurrence of `needle`.
    fn utf16_end_of(needle: &str) -> u64 {
        let end = WINDOW_TEXT.find(needle).unwrap() + needle.len();
        WINDOW_TEXT[..end].encode_utf16().count() as u64
    }

    const WINDOW_TEXT: &str = "The cat sat on the mat and looked at the dog. \
The dog barked loudly at the cat! “Go away,” said the cat.\n\n\
Then it rained for the rest of the day and everyone went inside.";

    #[test]
    fn window_anchor_skips_a_narrated_heading_and_ends_at_a_sentence() {
        // Ten unscripted words, then the transcript read verbatim.
        let recognized = spoken(
            "A rough map of the battle annotated by the general. \
The cat sat on the mat and looked at the dog. The dog barked loudly at the cat. \
Go away said the cat. Then it rained for the rest of the day",
            0.0,
        );

        let anchor = find_window_anchor(&recognized, WINDOW_TEXT, 0, 1000, 100.0);

        assert!((anchor.lead_in_seconds - 5.0).abs() < 1e-9);
        let end = anchor.end.unwrap();
        assert_eq!(end.text_end_utf16, utf16_end_of("said the cat."));
        // "cat." is recognized word 32 (10 unscripted + 11 + 7 + 5 words
        // before it): it ends at 32 * 0.5 + 0.4.
        assert!((end.seconds - 16.4).abs() < 1e-9);
    }

    #[test]
    fn window_anchor_skips_an_image_heading_when_a_name_is_misrecognized() {
        let transcript = "EIGHT YEARS AGO\n\nGavilar was starting to look worn. \
Dalinar stood at the back of the room.";
        let recognized = spoken(
            "Part four names chapter voices eight years ago Gavallar was starting \
to look worn Dalinar stood at the back of the room",
            0.0,
        );

        let anchor = find_window_anchor(&recognized, transcript, 0, 1000, 100.0);

        // The first five-word match begins at "was", but the three opening
        // words were recognized just before the misspelled name.
        assert!((anchor.lead_in_seconds - 2.5).abs() < 1e-9);
        assert!(anchor.end.is_some());
    }

    #[test]
    fn window_anchor_respects_the_latest_time_and_needs_a_sentence_end() {
        let recognized = spoken(
            "The cat sat on the mat and looked at the dog. \
The dog barked loudly at the cat. Go away said the cat.",
            0.0,
        );

        // Only the first sentence ends early enough.
        let anchor = find_window_anchor(&recognized, WINDOW_TEXT, 0, 1000, 6.0);
        let end = anchor.end.unwrap();
        assert_eq!(end.text_end_utf16, utf16_end_of("dog."));

        // Nothing ends by 3 s.
        assert!(
            find_window_anchor(&recognized, WINDOW_TEXT, 0, 1000, 3.0)
                .end
                .is_none()
        );
    }

    #[test]
    fn window_anchor_ignores_unrelated_speech() {
        let recognized = spoken("music plays and a narrator hums a tune for a while", 0.0);
        let anchor = find_window_anchor(&recognized, WINDOW_TEXT, 0, 1000, 100.0);
        assert_eq!(anchor.lead_in_seconds, 0.0);
        assert!(anchor.end.is_none());
    }

    #[test]
    fn window_anchor_starts_from_the_text_cursor() {
        let cursor = utf16_end_of("said the cat.\n\n");
        let recognized = spoken(
            "then it rained for the rest of the day and everyone went inside",
            2.0,
        );

        let anchor = find_window_anchor(&recognized, WINDOW_TEXT, cursor, 1000, 100.0);

        assert!((anchor.lead_in_seconds - 2.0).abs() < 1e-9);
        assert_eq!(
            anchor.end.unwrap().text_end_utf16,
            WINDOW_TEXT.encode_utf16().count() as u64
        );
    }

    #[test]
    fn sentence_end_before_prefers_terminal_punctuation() {
        let target = utf16_end_of("barked ");
        assert_eq!(
            sentence_end_before(WINDOW_TEXT, 0, target),
            utf16_end_of("dog.")
        );
        // No sentence end inside the range: the last whole word wins.
        assert_eq!(
            sentence_end_before(WINDOW_TEXT, 0, "The cat sat on".len() as u64),
            "The cat sat".len() as u64
        );
    }

    #[test]
    fn transcript_window_rebases_section_offsets() {
        let sections = vec![
            SpineSection {
                href: "a.html".into(),
                text: "Alpha beta.".into(),
            },
            SpineSection {
                href: "b.html".into(),
                text: "Gamma délta.".into(),
            },
        ];
        let transcript = build_transcript(&sections);
        let start = "Alpha ".encode_utf16().count() as u64;
        let end = "Alpha beta.\n\nGamma dél".encode_utf16().count() as u64;

        let window = transcript.window(start, end);

        assert_eq!(window.text, "beta.\n\nGamma dél");
        assert_eq!(window.href_for_offset(0), Some("a.html"));
        assert_eq!(window.href_for_offset(4), Some("a.html"));
        assert_eq!(window.href_for_offset(5), None);
        assert_eq!(window.href_for_offset(7), Some("b.html"));
        assert_eq!(window.href_for_offset(15), Some("b.html"));
        assert_eq!(window.href_for_offset(16), None);
        assert_eq!(skip_whitespace_utf16(&transcript.text, 11), 13);
    }

    #[test]
    fn sync_map_round_trips() {
        let map = SyncMap {
            version: SYNC_MAP_VERSION,
            generator: Some("echogarden".into()),
            generated_at: None,
            precision: Some(PRECISION_SENTENCE.into()),
            recovery_gaps: vec![RecoveryGap {
                start_seconds: 3.25,
                end_seconds: 12.0,
            }],
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
        assert_eq!(parsed.recovery_gaps, map.recovery_gaps);
        assert!(json.contains("startSeconds"));
        assert!(json.contains("\"words\":[[1.5,3.25,0,5]]"));
    }

    /// Maps written before precision and word timings existed still load.
    #[test]
    fn a_version_one_sync_map_still_reads() {
        let json = r#"{"version":1,"generator":"echogarden","fragments":[
            {"startSeconds":1.0,"endSeconds":2.0,"href":"a.xhtml","text":"Hi."}]}"#;
        let parsed: SyncMap = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.fragments.len(), 1);
        assert!(parsed.fragments[0].words.is_empty());
        assert!(parsed.precision.is_none());
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
    fn subtractive_roman_chapters_round_trip() {
        for number in 1..=200 {
            let roman = roman_numeral(number);
            assert_eq!(parse_roman_numeral(&roman), Some(number), "{roman}");
        }
        for invalid in ["IIII", "VX", "IC", "Mix", "CCI"] {
            assert_eq!(parse_roman_numeral(invalid), None, "{invalid}");
        }
    }

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
        let prefixed = parse_label("Part Four: A Knowledge: 74. A Symbol");
        assert_eq!(prefixed.number, Some(74));
        assert_eq!(prefixed.key, "a symbol");
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
}
