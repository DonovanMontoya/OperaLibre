//! Works: the book behind the file.
//!
//! Book identity is byte identity. Two copies of *The Odyssey* — one downloaded
//! from Audible, one uploaded from a personal archive, one a different
//! translation with a different ISBN — are three unrelated books to the scanner,
//! because they are three unrelated sets of bytes. That is the right answer for
//! playback, where a position in one file means nothing in another. It is the
//! wrong answer for a reading history, where all three are *The Odyssey*.
//!
//! A [`Work`] sits above those editions and collects them. Progress stays keyed
//! by book, always; a work is a view, never a replacement. Linking is additive
//! and reversible, and an uncertain match becomes a [`WorkSuggestion`] for an
//! administrator rather than a silent merge — crossing two books' histories is
//! not a mistake a reading log can recover from.
//!
//! Matching runs in tiers, strongest first:
//!
//! 1. **Manual** — an administrator said so. Always wins.
//! 2. **ASIN** — Audible's product id. Exact, and shared by every download of
//!    the same title.
//! 3. **ISBN** — the print id, where a file carries one.
//! 4. **Title, author, and duration** — normalized title and author with
//!    runtimes within [`DURATION_TOLERANCE`]. The duration check is what keeps
//!    an abridged reading, a dramatization, and a full translation apart when
//!    they all agree on title and author.
//!
//! A title-and-author agreement whose durations disagree is exactly the case
//! worth a human glance, so it is suggested and not merged.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path as FsPath;

use serde::{Deserialize, Serialize};

/// How far two runtimes may differ and still be taken for the same reading.
/// Editions of one recording vary by a few minutes of front and back matter;
/// an abridgement is shorter by a third or more. Fifteen percent sits in the
/// empty space between those.
pub const DURATION_TOLERANCE: f64 = 0.15;

/// A book, as distinct from any particular recording of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub id: String,
    /// Display title and author, taken from the first edition seen and left
    /// alone afterwards so a badly tagged import cannot rename the work.
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default)]
    pub asins: Vec<String>,
    #[serde(default)]
    pub isbns: Vec<String>,
    /// Normalized `title|author` keys this work is known by. More than one
    /// accumulates when editions disagree about punctuation or subtitles.
    #[serde(default)]
    pub keys: Vec<String>,
    /// Representative runtime, used for the fuzzy tier. Holds the longest
    /// edition seen: an unabridged recording is the better reference point,
    /// since a shorter one is what the tolerance is meant to catch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    /// Every edition ever linked, including ones no longer on disk. Never
    /// pruned — a deleted book is the whole reason this record exists.
    #[serde(default)]
    pub book_ids: Vec<String>,
    /// Editions an administrator attached by hand. Checked before anything else
    /// and never overridden by a heuristic.
    #[serde(default)]
    pub manual_book_ids: Vec<String>,
    /// Editions an administrator detached. A book listed here is never
    /// re-linked to this work by any tier, so a rejected suggestion stays
    /// rejected across rescans.
    #[serde(default)]
    pub excluded_book_ids: Vec<String>,
    pub created_at_ms: u64,
}

/// A match that was close enough to notice and not close enough to act on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSuggestion {
    pub book_id: String,
    pub work_id: String,
    pub book_title: String,
    pub work_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_duration_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_duration_seconds: Option<f64>,
    pub reason: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkStore {
    #[serde(default)]
    pub works: Vec<Work>,
    /// Uncertain matches awaiting an administrator. Rebuilt on each scan, so a
    /// suggestion disappears once its book does.
    #[serde(default)]
    pub suggestions: Vec<WorkSuggestion>,
}

/// Which tier claimed an edition, so the caller can log it and the admin UI can
/// explain itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchTier {
    Manual,
    Asin,
    Isbn,
    TitleAuthorDuration,
    New,
}

/// What the scanner knows about one edition when it asks for a work.
#[derive(Debug, Clone, Default)]
pub struct EditionCandidate {
    pub book_id: String,
    pub title: String,
    pub author: Option<String>,
    pub asin: Option<String>,
    pub isbn: Option<String>,
    pub duration_seconds: Option<f64>,
}

/// Strips case, punctuation, and articles so two spellings of a title compare
/// equal. Deliberately the same shape of normalization the Libation matcher
/// uses, extended with leading-article removal because "The Odyssey" and
/// "Odyssey" are one book.
pub fn normalize_key(value: &str) -> String {
    let cleaned = value
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>();
    let mut words = cleaned.split_whitespace().collect::<Vec<_>>();
    if let Some(first) = words.first()
        && matches!(*first, "the" | "a" | "an")
        && words.len() > 1
    {
        words.remove(0);
    }
    words.join(" ")
}

/// The `title|author` key a work is looked up by. Author is included because
/// title alone collides constantly — every catalog has a dozen *Persuasion*s.
pub fn work_key(title: &str, author: Option<&str>) -> String {
    let title = normalize_key(title);
    match author {
        Some(author) if !normalize_key(author).is_empty() => {
            format!("{title}|{}", normalize_key(author))
        }
        _ => format!("{title}|"),
    }
}

/// Whether two runtimes are close enough to be the same reading.
///
/// An unknown duration on either side is not evidence of a match. Returning
/// `false` there sends the pair to the suggestion queue instead of merging on
/// title and author alone.
pub fn durations_agree(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) if left > 0.0 && right > 0.0 => {
            let longer = left.max(right);
            (left - right).abs() / longer <= DURATION_TOLERANCE
        }
        _ => false,
    }
}

impl WorkStore {
    /// Finds or creates the work for one edition.
    ///
    /// Returns the work id and the tier that claimed it. When a tier only
    /// half-matches, a suggestion is recorded and the edition still gets its
    /// own work: an unmerged history is recoverable, a wrongly merged one is
    /// not.
    pub fn resolve(
        &mut self,
        candidate: &EditionCandidate,
        now_ms: u64,
        new_id: impl FnOnce() -> String,
    ) -> (String, MatchTier) {
        if let Some(index) = self.manual_index(&candidate.book_id) {
            self.link(index, candidate);
            return (self.works[index].id.clone(), MatchTier::Manual);
        }

        if let Some((index, tier)) = self.heuristic_index(candidate) {
            self.link(index, candidate);
            return (self.works[index].id.clone(), tier);
        }

        self.note_near_misses(candidate, now_ms);

        let work = Work {
            id: new_id(),
            title: candidate.title.clone(),
            author: candidate.author.clone(),
            asins: candidate.asin.clone().into_iter().collect(),
            isbns: candidate.isbn.clone().into_iter().collect(),
            keys: vec![work_key(&candidate.title, candidate.author.as_deref())],
            duration_seconds: candidate.duration_seconds,
            book_ids: vec![candidate.book_id.clone()],
            manual_book_ids: Vec::new(),
            excluded_book_ids: Vec::new(),
            created_at_ms: now_ms,
        };
        let id = work.id.clone();
        self.works.push(work);
        (id, MatchTier::New)
    }

    fn manual_index(&self, book_id: &str) -> Option<usize> {
        self.works
            .iter()
            .position(|work| work.manual_book_ids.iter().any(|id| id == book_id))
    }

    fn heuristic_index(&self, candidate: &EditionCandidate) -> Option<(usize, MatchTier)> {
        let excluded = |work: &Work| work.excluded_book_ids.contains(&candidate.book_id);

        if let Some(asin) = candidate.asin.as_deref()
            && let Some(index) = self
                .works
                .iter()
                .position(|work| !excluded(work) && work.asins.iter().any(|known| known == asin))
        {
            return Some((index, MatchTier::Asin));
        }

        if let Some(isbn) = candidate.isbn.as_deref()
            && let Some(index) = self
                .works
                .iter()
                .position(|work| !excluded(work) && work.isbns.iter().any(|known| known == isbn))
        {
            return Some((index, MatchTier::Isbn));
        }

        let key = work_key(&candidate.title, candidate.author.as_deref());
        self.works
            .iter()
            .position(|work| {
                !excluded(work)
                    && work.keys.contains(&key)
                    && durations_agree(work.duration_seconds, candidate.duration_seconds)
            })
            .map(|index| (index, MatchTier::TitleAuthorDuration))
    }

    /// Records the works this edition nearly joined: the title and author line
    /// up, the runtimes do not. Either it is a different abridgement — which is
    /// correctly a separate work — or a duration is missing or mistagged, which
    /// only a person can tell.
    fn note_near_misses(&mut self, candidate: &EditionCandidate, now_ms: u64) {
        let key = work_key(&candidate.title, candidate.author.as_deref());
        let mut found = Vec::new();
        for work in self.works.iter() {
            if work.excluded_book_ids.contains(&candidate.book_id) {
                continue;
            }
            if !work.keys.contains(&key) {
                continue;
            }
            if durations_agree(work.duration_seconds, candidate.duration_seconds) {
                continue;
            }
            let reason = match (work.duration_seconds, candidate.duration_seconds) {
                (Some(_), Some(_)) => "Same title and author, but the runtimes differ.",
                _ => "Same title and author, but a runtime is unknown.",
            };
            found.push(WorkSuggestion {
                book_id: candidate.book_id.clone(),
                work_id: work.id.clone(),
                book_title: candidate.title.clone(),
                work_title: work.title.clone(),
                book_duration_seconds: candidate.duration_seconds,
                work_duration_seconds: work.duration_seconds,
                reason: reason.to_string(),
                created_at_ms: now_ms,
            });
        }
        for suggestion in found {
            let already = self.suggestions.iter().any(|existing| {
                existing.book_id == suggestion.book_id && existing.work_id == suggestion.work_id
            });
            if !already {
                self.suggestions.push(suggestion);
            }
        }
    }

    /// Folds an edition's identifiers into the work it matched.
    fn link(&mut self, index: usize, candidate: &EditionCandidate) {
        let work = &mut self.works[index];
        if !work.book_ids.contains(&candidate.book_id) {
            work.book_ids.push(candidate.book_id.clone());
        }
        if let Some(asin) = candidate.asin.as_ref()
            && !work.asins.contains(asin)
        {
            work.asins.push(asin.clone());
        }
        if let Some(isbn) = candidate.isbn.as_ref()
            && !work.isbns.contains(isbn)
        {
            work.isbns.push(isbn.clone());
        }
        let key = work_key(&candidate.title, candidate.author.as_deref());
        if !work.keys.contains(&key) {
            work.keys.push(key);
        }
        // The longest edition is the reference runtime, so a later abridgement
        // is measured against the full recording rather than the other way
        // round.
        if let Some(duration) = candidate.duration_seconds
            && duration > work.duration_seconds.unwrap_or(0.0)
        {
            work.duration_seconds = Some(duration);
        }
    }

    /// Attaches an edition to a work by hand, detaching it from any other and
    /// clearing the suggestion that prompted the decision.
    pub fn link_manually(&mut self, book_id: &str, work_id: &str) -> bool {
        if !self.works.iter().any(|work| work.id == work_id) {
            return false;
        }
        for work in self.works.iter_mut() {
            work.manual_book_ids.retain(|id| id != book_id);
            if work.id != work_id {
                work.book_ids.retain(|id| id != book_id);
            }
        }
        if let Some(work) = self.works.iter_mut().find(|work| work.id == work_id) {
            work.manual_book_ids.push(book_id.to_string());
            work.excluded_book_ids.retain(|id| id != book_id);
            if !work.book_ids.iter().any(|id| id == book_id) {
                work.book_ids.push(book_id.to_string());
            }
        }
        self.suggestions
            .retain(|suggestion| suggestion.book_id != book_id);
        true
    }

    /// Rejects a suggested link for good. The exclusion is permanent so a
    /// rescan does not re-ask a question already answered.
    pub fn reject_suggestion(&mut self, book_id: &str, work_id: &str) -> bool {
        let Some(work) = self.works.iter_mut().find(|work| work.id == work_id) else {
            return false;
        };
        if !work.excluded_book_ids.iter().any(|id| id == book_id) {
            work.excluded_book_ids.push(book_id.to_string());
        }
        work.manual_book_ids.retain(|id| id != book_id);
        self.suggestions
            .retain(|suggestion| !(suggestion.book_id == book_id && suggestion.work_id == work_id));
        true
    }

    /// The work an edition belongs to, if any.
    pub fn work_for_book(&self, book_id: &str) -> Option<&Work> {
        self.works
            .iter()
            .find(|work| work.book_ids.iter().any(|id| id == book_id))
    }

    /// Book id to work id, as the index currently stands.
    ///
    /// Read paths resolve through this rather than trusting the work id frozen
    /// onto an old log row, so an administrator linking two editions merges the
    /// history those editions already accumulated.
    #[allow(dead_code)]
    pub fn book_to_work(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for work in self.works.iter() {
            for book_id in work.book_ids.iter() {
                map.insert(book_id.clone(), work.id.clone());
            }
        }
        map
    }

    /// Drops works that no longer mean anything: no edition on the server, no
    /// listening session, and no completion.
    ///
    /// A work exists to hold a history together across editions, so a work that
    /// holds a history is never touched however long its books have been gone —
    /// that is precisely the case the index was built for. What this removes is
    /// the residue of churn: a book scanned in, resolved to a work, and deleted
    /// before anybody played it.
    ///
    /// Returns how many were removed.
    #[allow(dead_code)]
    pub fn prune_unused(
        &mut self,
        present_book_ids: &HashSet<String>,
        book_ids_with_history: &HashSet<String>,
        work_ids_with_history: &HashSet<String>,
    ) -> usize {
        let before = self.works.len();
        self.works.retain(|work| {
            if work_ids_with_history.contains(&work.id) {
                return true;
            }
            // A manual decision is a person's work and is never discarded.
            if !work.manual_book_ids.is_empty() || !work.excluded_book_ids.is_empty() {
                return true;
            }
            work.book_ids.iter().any(|book_id| {
                present_book_ids.contains(book_id) || book_ids_with_history.contains(book_id)
            })
        });
        let removed = before - self.works.len();
        if removed > 0 {
            let surviving = self
                .works
                .iter()
                .map(|work| work.id.clone())
                .collect::<HashSet<_>>();
            self.suggestions
                .retain(|suggestion| surviving.contains(&suggestion.work_id));
        }
        removed
    }

    /// Drops suggestions naming books that are no longer in the library, so the
    /// admin queue reflects what is actually on disk.
    pub fn prune_suggestions(&mut self, present_book_ids: &HashSet<String>) {
        self.suggestions
            .retain(|suggestion| present_book_ids.contains(&suggestion.book_id));
    }
}

#[allow(dead_code)]
pub async fn load_works(path: &FsPath) -> io::Result<WorkStore> {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents).unwrap_or_else(|error| {
            // A work store is a derived index: every link it holds can be
            // rebuilt by the next scan. Losing it costs suggestions and manual
            // decisions, which is bad, but it must never take the server down.
            tracing::warn!("could not parse the work store, starting a new one: {error}");
            WorkStore::default()
        })),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(WorkStore::default()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> impl FnMut() -> String {
        let mut counter = 0;
        move || {
            counter += 1;
            format!("work-{counter}")
        }
    }

    fn edition(
        book_id: &str,
        title: &str,
        author: &str,
        duration: Option<f64>,
    ) -> EditionCandidate {
        EditionCandidate {
            book_id: book_id.to_string(),
            title: title.to_string(),
            author: Some(author.to_string()),
            asin: None,
            isbn: None,
            duration_seconds: duration,
        }
    }

    #[test]
    fn leading_articles_and_punctuation_do_not_split_a_title() {
        assert_eq!(normalize_key("The Odyssey"), normalize_key("Odyssey"));
        assert_eq!(normalize_key("Moby-Dick"), normalize_key("Moby Dick"));
        assert_eq!(normalize_key("  A  Tale  "), normalize_key("Tale"));
    }

    #[test]
    fn a_redownload_with_the_same_asin_rejoins_its_work() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let mut first = edition("book-1", "The Odyssey", "Homer", Some(46_920.0));
        first.asin = Some("B002V1A0WE".to_string());
        let (work_id, tier) = store.resolve(&first, 0, &mut next_id);
        assert_eq!(tier, MatchTier::New);

        // Re-downloaded later: new bytes, new book id, same Audible product.
        let mut again = edition("book-2", "The Odyssey", "Homer", Some(46_920.0));
        again.asin = Some("B002V1A0WE".to_string());
        let (rejoined, tier) = store.resolve(&again, 1_000, &mut next_id);
        assert_eq!(rejoined, work_id);
        assert_eq!(tier, MatchTier::Asin);
        assert_eq!(store.works.len(), 1);
        assert_eq!(
            store
                .work_for_book("book-1")
                .expect("work exists")
                .book_ids
                .len(),
            2,
            "both editions hang off the one work"
        );
    }

    #[test]
    fn an_archived_upload_rejoins_on_title_author_and_runtime() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let (work_id, _) = store.resolve(
            &edition("book-1", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        // Same recording, different container, uploaded under a different name.
        let (rejoined, tier) = store.resolve(
            &edition("book-2", "Odyssey", "Homer", Some(47_500.0)),
            1_000,
            &mut next_id,
        );
        assert_eq!(rejoined, work_id);
        assert_eq!(tier, MatchTier::TitleAuthorDuration);
    }

    #[test]
    fn an_abridgement_stays_its_own_work_and_is_only_suggested() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let (full, _) = store.resolve(
            &edition("book-1", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        let (short, tier) = store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            1_000,
            &mut next_id,
        );
        assert_ne!(short, full);
        assert_eq!(tier, MatchTier::New);
        assert_eq!(store.suggestions.len(), 1);
        assert_eq!(store.suggestions[0].book_id, "book-2");
        assert_eq!(store.suggestions[0].work_id, full);
    }

    #[test]
    fn an_unknown_runtime_is_never_merged_on_title_alone() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        store.resolve(
            &edition("book-1", "Persuasion", "Jane Austen", Some(30_000.0)),
            0,
            &mut next_id,
        );
        let (_, tier) = store.resolve(
            &edition("book-2", "Persuasion", "Jane Austen", None),
            1_000,
            &mut next_id,
        );
        assert_eq!(tier, MatchTier::New);
        assert_eq!(store.suggestions.len(), 1);
    }

    #[test]
    fn a_manual_link_survives_a_rescan_and_beats_the_heuristics() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let (full, _) = store.resolve(
            &edition("book-1", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            1_000,
            &mut next_id,
        );
        assert!(store.link_manually("book-2", &full));
        assert!(store.suggestions.is_empty());

        // The next scan sees the same two editions and must respect the choice.
        let (resolved, tier) = store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            2_000,
            &mut next_id,
        );
        assert_eq!(resolved, full);
        assert_eq!(tier, MatchTier::Manual);
    }

    #[test]
    fn a_rejected_suggestion_is_never_asked_again() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let (full, _) = store.resolve(
            &edition("book-1", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            1_000,
            &mut next_id,
        );
        assert!(store.reject_suggestion("book-2", &full));
        assert!(store.suggestions.is_empty());

        store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            2_000,
            &mut next_id,
        );
        assert!(
            store.suggestions.is_empty(),
            "a rejected pairing must not come back"
        );
    }

    #[test]
    fn pruning_drops_churn_and_keeps_anything_with_a_history() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let (read, _) = store.resolve(
            &edition("read-book", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        let (deleted_but_finished, _) = store.resolve(
            &edition("gone-book", "Moby Dick", "Melville", Some(90_000.0)),
            0,
            &mut next_id,
        );
        let (never_touched, _) = store.resolve(
            &edition("churn-book", "Some Import", "Nobody", Some(1_000.0)),
            0,
            &mut next_id,
        );

        // Only the first book is still on the server. The second is gone but was
        // finished. The third was scanned in and deleted before anybody played it.
        let present = HashSet::from(["read-book".to_string()]);
        let books_with_history = HashSet::from(["read-book".to_string()]);
        let works_with_history = HashSet::from([deleted_but_finished.clone()]);

        let removed = store.prune_unused(&present, &books_with_history, &works_with_history);
        assert_eq!(removed, 1);
        assert!(store.works.iter().any(|work| work.id == read));
        assert!(
            store
                .works
                .iter()
                .any(|work| work.id == deleted_but_finished),
            "a work holding a completion must survive its book being deleted"
        );
        assert!(!store.works.iter().any(|work| work.id == never_touched));
    }

    #[test]
    fn pruning_never_discards_an_administrators_decision() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let (full, _) = store.resolve(
            &edition("book-1", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            0,
            &mut next_id,
        );
        store.link_manually("book-2", &full);

        // Neither book is on the server any more and nothing was ever played.
        let removed = store.prune_unused(&HashSet::new(), &HashSet::new(), &HashSet::new());
        assert_eq!(removed, 1, "only the work holding no decision is dropped");
        assert!(store.works.iter().any(|work| work.id == full));
    }

    #[test]
    fn pruning_clears_suggestions_pointing_at_removed_works() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        store.resolve(
            &edition("book-1", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            0,
            &mut next_id,
        );
        assert_eq!(store.suggestions.len(), 1);

        store.prune_unused(&HashSet::new(), &HashSet::new(), &HashSet::new());
        assert!(store.works.is_empty());
        assert!(
            store.suggestions.is_empty(),
            "a suggestion cannot outlive the work it names"
        );
    }

    #[test]
    fn a_work_keeps_editions_that_have_left_the_library() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let mut first = edition("book-1", "The Odyssey", "Homer", Some(46_920.0));
        first.asin = Some("B002V1A0WE".to_string());
        store.resolve(&first, 0, &mut next_id);

        // book-1 is deleted from disk; a later scan only sees the new copy.
        let mut second = edition("book-2", "The Odyssey", "Homer", Some(46_920.0));
        second.asin = Some("B002V1A0WE".to_string());
        store.resolve(&second, 1_000, &mut next_id);

        let work = store.work_for_book("book-2").expect("work exists");
        assert!(
            work.book_ids.iter().any(|id| id == "book-1"),
            "the departed edition must stay on the work so its history still rolls up"
        );
    }
}
