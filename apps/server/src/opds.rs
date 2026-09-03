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
        // XML 1.0 permits exactly these scalar ranges. Rust strings cannot
        // contain surrogates, but can contain the forbidden U+FFFE/U+FFFF.
        if !matches!(
            character,
            '\u{9}' | '\u{A}' | '\u{D}'
                | '\u{20}'..='\u{D7FF}'
                | '\u{E000}'..='\u{FFFD}'
                | '\u{10000}'..='\u{10FFFF}'
        ) {
            continue;
        }
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            character => escaped.push(character),
        }
    }
    escaped
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
    Extension(session): Extension<SessionToken>,
) -> Result<Response, ApiError> {
    let updated = rfc3339_utc(unix_now_seconds());
    let media_token = media_token_for_session(&session.0);
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
    Extension(session): Extension<SessionToken>,
) -> Result<Response, ApiError> {
    ensure_startup_scan_finished(&state).await?;
    let books = books_with_progress(&state, &auth).await?;
    let updated = rfc3339_utc(unix_now_seconds());
    let media_token = media_token_for_session(&session.0);
    let mut body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:operalibre:catalog:all</id>
  <title>All audiobooks</title>
  <updated>{updated}</updated>
  <author><name>OperaLibre</name></author>
  <link rel="self" href="/api/opds/books?token={media_token}" type="{OPDS_FEED_TYPE}"/>
  <link rel="start" href="/api/opds?token={media_token}" type="{OPDS_NAVIGATION_TYPE}"/>
"#
    );

    for book in &books {
        body.push_str("  <entry>\n");
        body.push_str(&format!(
            "    <id>urn:operalibre:book:{}</id>\n",
            xml_escape(&book.id)
        ));
        body.push_str(&format!("    <title>{}</title>\n", xml_escape(&book.title)));
        body.push_str(&format!("    <updated>{updated}</updated>\n"));
        if let Some(author) = &book.author {
            body.push_str(&format!(
                "    <author><name>{}</name></author>\n",
                xml_escape(author)
            ));
        }
        if let Some(published) = &book.published_date {
            body.push_str(&format!(
                "    <dc:issued>{}</dc:issued>\n",
                xml_escape(published)
            ));
        }
        for genre in &book.genres {
            body.push_str(&format!("    <category term=\"{}\"/>\n", xml_escape(genre)));
        }
        // Narrator and length are what a listener actually chooses on, and
        // OPDS has nowhere structured to put either.
        let mut summary = book.description.clone().unwrap_or_default();
        if let Some(narrator) = &book.narrator {
            summary = format!("Narrated by {narrator}.\n\n{summary}");
        }
        if let Some(duration) = book.duration_seconds {
            summary = format!(
                "{summary}\n\n{} tracks, {:.1} hours.",
                book.track_count,
                duration / 3600.0
            );
        }
        body.push_str(&format!(
            "    <summary type=\"text\">{}</summary>\n",
            xml_escape(summary.trim())
        ));
        if book.cover_art_url.is_some() {
            body.push_str(&format!(
                "    <link rel=\"http://opds-spec.org/image\" href=\"/api/books/{}/cover?token={}\"/>\n",
                xml_escape(&book.id),
                media_token
            ));
        }
        for track in &book.tracks {
            body.push_str(&format!(
                "    <link rel=\"http://opds-spec.org/acquisition\" href=\"/api/books/{}/tracks/{}/stream?token={}\" type=\"{}\" title=\"{}\"/>\n",
                xml_escape(&book.id),
                xml_escape(&track.id),
                media_token,
                xml_escape(&media_content_type(FsPath::new(&track.file_name))),
                xml_escape(&track.title)
            ));
        }
        body.push_str("  </entry>\n");
    }

    body.push_str("</feed>\n");
    feed_response(body, OPDS_FEED_TYPE)
}
