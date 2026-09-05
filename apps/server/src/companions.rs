//! Companion files beside an audiobook: discovery and classification.
//!
//! Audible-derived libraries often carry a PDF "supplement" — maps,
//! illustrations, recipes, a family tree — that is not the book's text at
//! all. Telling the book apart from the extras is what lets the reader offer
//! read-along for one and a gallery for the other, instead of presenting a
//! twelve-page picture PDF as the book.

use crate::*;

/// Text-bearing document types that can be shown in the reader pane.
pub(crate) const DOCUMENT_EXTENSIONS: &[&str] = &["epub", "html", "htm", "pdf", "txt"];
/// Loose pictures that get grouped into a gallery.
pub(crate) const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];
/// Loose art that names itself as the cover is artwork, not a companion.
const COVER_STEMS: &[&str] = &[
    "cover",
    "folder",
    "front",
    "back",
    "thumb",
    "thumbnail",
    "albumart",
    "artwork",
    "poster",
];
/// A narrator reads roughly 150 words a minute; at ~5.6 characters per word
/// including the space, that is about fourteen characters of source text a
/// second. Used to judge whether a document holds enough text to be the
/// book that the audio narrates.
const NARRATED_CHARACTERS_PER_SECOND: f64 = 14.0;
/// Below this share of the expected text a document is a supplement no
/// matter how it is otherwise shaped: a book of maps with captions can hold
/// a few thousand characters without being the book.
const BOOK_TEXT_RATIO: f64 = 0.12;
/// At or above this many characters a document is a book regardless of the
/// audio: nothing that long is a picture supplement.
const BOOK_TEXT_CHARACTERS: u64 = 20_000;
/// Without a known audio duration, this is the line between "some captions"
/// and "an actual text".
const BOOK_TEXT_CHARACTERS_WITHOUT_AUDIO: u64 = 3_000;
/// A floor under the ratio test so a two-line note beside a thirty-second
/// clip is not "the book". Scaled down for short audio, since a picture
/// book narrated in four minutes carries little text and all of it.
const MIN_BOOK_TEXT_CHARACTERS: u64 = 1_500;
const MIN_BOOK_TEXT_RATIO: f64 = 0.3;
/// PDF pages sampled for text and image counts. Sampling keeps a
/// thousand-page scan from stalling a library rescan; counts are scaled up
/// by the page ratio afterwards.
const PDF_SAMPLE_PAGES: usize = 24;
const PDF_TEXT_DECOMPRESSION_LIMIT: usize = 8 * 1024 * 1024;
const MAX_ANALYZED_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CompanionKind {
    /// The text of the book: what read-along follows.
    Book,
    /// A document that is mostly pictures: illustrations, maps, recipes.
    Supplement,
    /// A loose picture file in the book's folder.
    Image,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompanionFile {
    pub(crate) id: String,
    pub(crate) file_name: String,
    pub(crate) extension: String,
    pub(crate) content_type: String,
    pub(crate) url: String,
    pub(crate) kind: CompanionKind,
    pub(crate) size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) page_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) image_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) text_characters: Option<u64>,
    /// The document could not be opened, so the kind is a guess from its
    /// extension rather than its contents.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) unreadable: bool,
}

/// What a document looks like inside, independent of any audiobook.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct DocumentAnalysis {
    pub(crate) text_characters: u64,
    pub(crate) image_count: u32,
    pub(crate) page_count: Option<u32>,
    pub(crate) unreadable: bool,
}

/// An analysis keyed by the file it described, so a rescan re-reads only
/// documents that changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CachedAnalysis {
    pub(crate) len: u64,
    pub(crate) modified_unix: u64,
    pub(crate) analysis: DocumentAnalysis,
}

pub(crate) type AnalysisCache = HashMap<PathBuf, CachedAnalysis>;

pub(crate) fn is_document(path: &FsPath) -> bool {
    has_extension_in(path, DOCUMENT_EXTENSIONS)
}

pub(crate) fn is_image(path: &FsPath) -> bool {
    if !has_extension_in(path, IMAGE_EXTENSIONS) {
        return false;
    }
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_ascii_lowercase())
        .unwrap_or_default();
    !COVER_STEMS.contains(&stem.as_str())
}

fn has_extension_in(path: &FsPath, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
}

/// Every companion candidate beside a book, documents and pictures alike,
/// in natural order.
///
/// A folder holds one book, so everything in it belongs to that book. A
/// single-file book shares `library_root` with every other one, so only
/// files whose stem matches the audio, the title, or the folder qualify.
pub(crate) fn discover_candidates(
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
) -> Vec<PathBuf> {
    let is_folder_book = group_key.is_dir();
    let Some(search_dir) = (if is_folder_book {
        Some(group_key.to_path_buf())
    } else {
        group_key.parent().map(FsPath::to_path_buf)
    }) else {
        return Vec::new();
    };
    let audio_stems = grouped_files
        .iter()
        .filter_map(|path| path.file_stem().and_then(|name| name.to_str()))
        .map(normalize_match_key)
        .collect::<Vec<_>>();
    let group_stem = group_key
        .file_stem()
        .and_then(|name| name.to_str())
        .map(normalize_match_key);
    let title_key = normalize_match_key(book_title);

    let mut candidates = WalkDir::new(&search_dir)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| is_document(path) || is_image(path))
        .filter(|path| {
            if is_folder_book {
                return true;
            }
            let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
                return false;
            };
            let stem_key = normalize_match_key(stem);
            Some(&stem_key) == group_stem.as_ref()
                || stem_key == title_key
                || audio_stems.iter().any(|audio_stem| audio_stem == &stem_key)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| natural_path_key(path));
    candidates
}

/// Reads a document to find out how much text and how many pictures it
/// holds. Pictures are never opened; their kind is fixed by extension.
pub(crate) fn analyze_document(path: &FsPath) -> DocumentAnalysis {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .unwrap_or_default();
    let too_large = std::fs::metadata(path)
        .map(|metadata| metadata.len() > MAX_ANALYZED_DOCUMENT_BYTES)
        .unwrap_or(true);
    if too_large {
        return DocumentAnalysis {
            unreadable: true,
            ..Default::default()
        };
    }
    let Ok(bytes) = std::fs::read(path) else {
        return DocumentAnalysis {
            unreadable: true,
            ..Default::default()
        };
    };
    match extension.as_str() {
        "epub" => analyze_epub(&bytes),
        "pdf" => analyze_pdf(&bytes),
        "html" | "htm" => DocumentAnalysis {
            text_characters: count_text(&alignment::html_to_text(&String::from_utf8_lossy(&bytes))),
            image_count: count_html_images(&String::from_utf8_lossy(&bytes)),
            page_count: None,
            unreadable: false,
        },
        "txt" => DocumentAnalysis {
            text_characters: count_text(&String::from_utf8_lossy(&bytes)),
            image_count: 0,
            page_count: None,
            unreadable: false,
        },
        _ => DocumentAnalysis {
            unreadable: true,
            ..Default::default()
        },
    }
}

fn count_text(text: &str) -> u64 {
    text.split_whitespace()
        .map(|word| word.chars().count() as u64 + 1)
        .sum::<u64>()
        .saturating_sub(1)
}

fn count_html_images(document: &str) -> u32 {
    let lower = document.to_ascii_lowercase();
    lower.matches("<img").count() as u32 + lower.matches("<svg").count() as u32
}

pub(crate) fn analyze_epub(bytes: &[u8]) -> DocumentAnalysis {
    match alignment::parse_epub(bytes) {
        Ok(epub) => DocumentAnalysis {
            text_characters: epub
                .sections
                .iter()
                .map(|section| count_text(&section.text))
                .sum(),
            image_count: epub.image_count as u32,
            page_count: None,
            unreadable: false,
        },
        Err(_) => DocumentAnalysis {
            unreadable: true,
            ..Default::default()
        },
    }
}

pub(crate) fn analyze_pdf(bytes: &[u8]) -> DocumentAnalysis {
    let Ok(document) = lopdf::Document::load_mem(bytes) else {
        return DocumentAnalysis {
            unreadable: true,
            ..Default::default()
        };
    };
    let pages = document.get_pages();
    let page_count = pages.len();
    if page_count == 0 {
        return DocumentAnalysis {
            text_characters: 0,
            image_count: 0,
            page_count: Some(0),
            unreadable: false,
        };
    }
    // Sample pages spread through the document so a text book with a
    // pictorial frontispiece, or an atlas with a written introduction,
    // is judged on the whole rather than on its first pages.
    let sample_count = page_count.min(PDF_SAMPLE_PAGES);
    let mut sampled_text: u64 = 0;
    let mut sampled_images: u64 = 0;
    let mut sampled = 0usize;
    for sample in 0..sample_count {
        let page_number = ((sample * page_count) / sample_count + 1) as u32;
        let Some(page_id) = pages.get(&page_number).copied() else {
            continue;
        };
        sampled += 1;
        if let Ok(text) =
            document.extract_text_with_limit(&[page_number], PDF_TEXT_DECOMPRESSION_LIMIT)
        {
            sampled_text += count_text(&text);
        }
        if let Ok(images) = document.get_page_images(page_id) {
            sampled_images += images.len() as u64;
        }
    }
    if sampled == 0 {
        return DocumentAnalysis {
            text_characters: 0,
            image_count: 0,
            page_count: Some(page_count as u32),
            unreadable: true,
        };
    }
    let scale = page_count as f64 / sampled as f64;
    DocumentAnalysis {
        text_characters: (sampled_text as f64 * scale).round() as u64,
        image_count: (sampled_images as f64 * scale).round() as u32,
        page_count: Some(page_count as u32),
        unreadable: false,
    }
}

/// Decides what a document is to the listener.
///
/// The question is not "does this have text" but "is this the text the
/// narrator is reading": a picture PDF still carries captions, and a short
/// children's book carries little text but is still the book, so the test is
/// against how much text the audio's length implies.
pub(crate) fn classify(
    analysis: &DocumentAnalysis,
    extension: &str,
    audio_duration_seconds: Option<f64>,
) -> CompanionKind {
    if IMAGE_EXTENSIONS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(extension))
    {
        return CompanionKind::Image;
    }
    if analysis.unreadable {
        // Not knowing is not evidence of pictures. Offer it as the book and
        // let the reader decide; a wrong "extras" label would hide a book.
        return CompanionKind::Book;
    }
    let characters = analysis.text_characters;
    if characters >= BOOK_TEXT_CHARACTERS {
        return CompanionKind::Book;
    }
    match audio_duration_seconds.filter(|duration| *duration > 0.0) {
        Some(duration) => {
            let expected = duration * NARRATED_CHARACTERS_PER_SECOND;
            let ratio = characters as f64 / expected;
            let floor = MIN_BOOK_TEXT_CHARACTERS.min((expected * MIN_BOOK_TEXT_RATIO) as u64);
            if ratio >= BOOK_TEXT_RATIO && characters >= floor {
                CompanionKind::Book
            } else {
                CompanionKind::Supplement
            }
        }
        None => {
            if characters >= BOOK_TEXT_CHARACTERS_WITHOUT_AUDIO {
                CompanionKind::Book
            } else {
                CompanionKind::Supplement
            }
        }
    }
}

/// Looks up or computes analyses for every path, reading only files the
/// cache has not seen at this size and modification time. Documents are
/// independent, so they fan out across the pool.
pub(crate) fn analyze_all(paths: &[PathBuf], cache: &AnalysisCache) -> AnalysisCache {
    use rayon::prelude::*;
    paths
        .par_iter()
        .filter(|path| is_document(path))
        .filter_map(|path| {
            let metadata = std::fs::metadata(path).ok()?;
            let len = metadata.len();
            let modified_unix = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            if let Some(cached) = cache.get(path)
                && cached.len == len
                && cached.modified_unix == modified_unix
            {
                return Some((path.clone(), cached.clone()));
            }
            Some((
                path.clone(),
                CachedAnalysis {
                    len,
                    modified_unix,
                    analysis: analyze_document(path),
                },
            ))
        })
        .collect()
}

/// Builds the companion list for one book from its analyzed candidates.
pub(crate) fn describe(
    book_id: &str,
    candidates: &[PathBuf],
    analyses: &AnalysisCache,
    audio_duration_seconds: Option<f64>,
) -> Vec<(CompanionFile, PathBuf)> {
    candidates
        .iter()
        .filter_map(|path| {
            let extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("")
                .to_lowercase();
            let file_name = path.file_name().and_then(|name| name.to_str())?.to_string();
            let id = stable_id(&path.to_string_lossy());
            let (analysis, len) = match analyses.get(path) {
                Some(cached) => (cached.analysis.clone(), cached.len),
                None => (
                    DocumentAnalysis::default(),
                    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
                ),
            };
            let kind = classify(&analysis, &extension, audio_duration_seconds);
            let is_document = kind != CompanionKind::Image;
            let content_type = if extension == "epub" {
                "application/epub+zip".to_string()
            } else {
                mime_guess::from_path(path)
                    .first_or_octet_stream()
                    .to_string()
            };
            Some((
                CompanionFile {
                    url: format!("/api/books/{book_id}/companions/{id}"),
                    id,
                    file_name,
                    extension,
                    content_type,
                    kind,
                    size_bytes: len,
                    page_count: analysis.page_count.filter(|_| is_document),
                    image_count: is_document.then_some(analysis.image_count),
                    text_characters: is_document.then_some(analysis.text_characters),
                    unreadable: is_document && analysis.unreadable,
                },
                path.clone(),
            ))
        })
        .collect()
}

/// The companion that read-along follows: the first book-kind document,
/// preferring the format that can be synced. Falls back to an unreadable
/// document rather than a picture supplement.
pub(crate) fn primary_reading_file(companions: &[CompanionFile]) -> Option<&CompanionFile> {
    const PREFERENCE: &[&str] = &["epub", "html", "htm", "txt", "pdf"];
    let mut books = companions
        .iter()
        .filter(|companion| companion.kind == CompanionKind::Book)
        .collect::<Vec<_>>();
    books.sort_by_key(|companion| {
        PREFERENCE
            .iter()
            .position(|extension| *extension == companion.extension)
            .unwrap_or(PREFERENCE.len())
    });
    books.first().copied()
}

/// A page of the test PDF: a line of text, or one picture and nothing else.
#[cfg(test)]
#[derive(Clone, Copy)]
pub(crate) enum PdfPage {
    Text,
    Image,
}

/// A tiny valid PDF written with lopdf's own object model.
#[cfg(test)]
pub(crate) fn build_test_pdf(pages: &[PdfPage]) -> Vec<u8> {
    use lopdf::{Dictionary, Object, Stream, dictionary};
    let mut doc = lopdf::Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let image_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 2,
            "Height" => 2,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
        },
        vec![0u8, 255, 255, 0],
    ));
    let mut kids = Vec::new();
    for page in pages {
        let (resources, content): (Dictionary, String) = match page {
            PdfPage::Text => (
                dictionary! { "Font" => dictionary! { "F1" => font_id } },
                "BT /F1 12 Tf 72 700 Td (The meadow was quiet in the early morning light) Tj ET"
                    .to_string(),
            ),
            PdfPage::Image => (
                dictionary! { "XObject" => dictionary! { "Im1" => image_id } },
                "q 200 0 0 200 100 500 cm /Im1 Do Q".to_string(),
            ),
        };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        kids.push(Object::Reference(page_id));
    }
    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analysis(text_characters: u64, image_count: u32) -> DocumentAnalysis {
        DocumentAnalysis {
            text_characters,
            image_count,
            page_count: Some(12),
            unreadable: false,
        }
    }

    /// A twelve-page PDF of maps with captions must not become "the book" just
    /// because it holds some words.
    #[test]
    fn a_captioned_picture_pdf_beside_a_long_audiobook_is_a_supplement() {
        let ten_hours = Some(10.0 * 3600.0);
        assert_eq!(
            classify(&analysis(2_400, 18), "pdf", ten_hours),
            CompanionKind::Supplement
        );
        assert_eq!(
            classify(&analysis(0, 12), "pdf", ten_hours),
            CompanionKind::Supplement
        );
    }

    #[test]
    fn a_full_text_is_a_book_whatever_the_format() {
        let ten_hours = Some(10.0 * 3600.0);
        assert_eq!(
            classify(&analysis(480_000, 3), "epub", ten_hours),
            CompanionKind::Book
        );
        assert_eq!(
            classify(&analysis(480_000, 0), "pdf", ten_hours),
            CompanionKind::Book
        );
        assert_eq!(
            classify(&analysis(25_000, 0), "txt", None),
            CompanionKind::Book
        );
    }

    /// A picture book narrated in four minutes carries little text, and that
    /// little text is still the whole book.
    #[test]
    fn a_short_book_is_judged_against_its_short_audio() {
        let four_minutes = Some(240.0);
        assert_eq!(
            classify(&analysis(1_200, 14), "epub", four_minutes),
            CompanionKind::Book
        );
        assert_eq!(
            classify(&analysis(1_200, 14), "epub", Some(10.0 * 3600.0)),
            CompanionKind::Supplement
        );
    }

    #[test]
    fn pictures_are_pictures_and_unreadable_documents_stay_offered_as_books() {
        assert_eq!(classify(&analysis(0, 0), "jpg", None), CompanionKind::Image);
        let unreadable = DocumentAnalysis {
            unreadable: true,
            ..Default::default()
        };
        assert_eq!(
            classify(&unreadable, "pdf", Some(3600.0)),
            CompanionKind::Book
        );
    }

    #[test]
    fn loose_cover_art_is_not_a_companion() {
        assert!(!is_image(FsPath::new("/lib/Book/cover.jpg")));
        assert!(!is_image(FsPath::new("/lib/Book/Folder.JPG")));
        assert!(is_image(FsPath::new("/lib/Book/map-of-the-north.png")));
        assert!(is_document(FsPath::new("/lib/Book/Book.EPUB")));
        assert!(!is_document(FsPath::new("/lib/Book/Book.metadata.json")));
    }

    #[test]
    fn the_primary_reading_file_prefers_a_syncable_book_over_a_supplement() {
        let make = |extension: &str, kind: CompanionKind| CompanionFile {
            id: extension.to_string(),
            file_name: format!("book.{extension}"),
            extension: extension.to_string(),
            content_type: String::new(),
            url: String::new(),
            kind,
            size_bytes: 0,
            page_count: None,
            image_count: None,
            text_characters: None,
            unreadable: false,
        };
        let companions = vec![
            make("pdf", CompanionKind::Supplement),
            make("pdf", CompanionKind::Book),
            make("epub", CompanionKind::Book),
        ];
        assert_eq!(primary_reading_file(&companions).unwrap().extension, "epub");
        let only_extras = vec![
            make("pdf", CompanionKind::Supplement),
            make("jpg", CompanionKind::Image),
        ];
        assert!(primary_reading_file(&only_extras).is_none());
    }

    #[test]
    fn a_pdf_of_pictures_reads_as_pictures_and_a_pdf_of_text_reads_as_text() {
        let picture_pdf = build_test_pdf(&[PdfPage::Image; 6]);
        let analysis = analyze_pdf(&picture_pdf);
        assert!(!analysis.unreadable);
        assert_eq!(analysis.page_count, Some(6));
        assert_eq!(analysis.image_count, 6);
        assert_eq!(analysis.text_characters, 0);

        let text_pdf = build_test_pdf(&[PdfPage::Text; 3]);
        let analysis = analyze_pdf(&text_pdf);
        assert_eq!(analysis.page_count, Some(3));
        assert_eq!(analysis.image_count, 0);
        assert!(analysis.text_characters > 60, "{analysis:?}");
    }
}
