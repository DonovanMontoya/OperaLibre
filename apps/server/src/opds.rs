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
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            // XML 1.0 forbids most control characters outright, and a stray
            // one from a mangled tag would make the whole feed unparseable.
            character
                if (character as u32) < 0x20
                    && character != '\n'
                    && character != '\t'
                    && character != '\r' => {}
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
pub(crate) async fn opds_root(Extension(auth): Extension<AuthUser>) -> Result<Response, ApiError> {
    let updated = rfc3339_utc(unix_now_seconds());
    let body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:operalibre:catalog</id>
  <title>OperaLibre</title>
  <updated>{updated}</updated>
  <author><name>OperaLibre</name></author>
  <link rel="self" href="/api/opds" type="{OPDS_NAVIGATION_TYPE}"/>
  <link rel="start" href="/api/opds" type="{OPDS_NAVIGATION_TYPE}"/>
  <entry>
    <id>urn:operalibre:catalog:all</id>
    <title>All audiobooks</title>
    <updated>{updated}</updated>
    <content type="text">Everything {username} can listen to.</content>
    <link rel="subsection" href="/api/opds/books" type="{OPDS_FEED_TYPE}"/>
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
) -> Result<Response, ApiError> {
    let books = books_with_progress(&state, &auth).await?;
    let updated = rfc3339_utc(unix_now_seconds());
    let mut body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:operalibre:catalog:all</id>
  <title>All audiobooks</title>
  <updated>{updated}</updated>
  <author><name>OperaLibre</name></author>
  <link rel="self" href="/api/opds/books" type="{OPDS_FEED_TYPE}"/>
  <link rel="start" href="/api/opds" type="{OPDS_NAVIGATION_TYPE}"/>
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
                "    <link rel=\"http://opds-spec.org/image\" href=\"/api/books/{}/cover\"/>\n",
                xml_escape(&book.id)
            ));
        }
        for track in &book.tracks {
            body.push_str(&format!(
                "    <link rel=\"http://opds-spec.org/acquisition\" href=\"/api/books/{}/tracks/{}/stream\" type=\"{}\" title=\"{}\"/>\n",
                xml_escape(&book.id),
                xml_escape(&track.id),
                xml_escape(&media_content_type(FsPath::new(&track.file_name))),
                xml_escape(&track.title)
            ));
        }
        body.push_str("  </entry>\n");
    }

    body.push_str("</feed>\n");
    feed_response(body, OPDS_FEED_TYPE)
}
