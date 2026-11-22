use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub(crate) const DURATION_TOLERANCE: f64 = 0.15;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Work {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) asins: Vec<String>,
    #[serde(default)]
    pub(crate) isbns: Vec<String>,
    #[serde(default)]
    pub(crate) keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) duration_seconds: Option<f64>,
    #[serde(default)]
    pub(crate) book_ids: Vec<String>,
    #[serde(default)]
    pub(crate) manual_book_ids: Vec<String>,
    #[serde(default)]
    pub(crate) excluded_book_ids: Vec<String>,
    pub(crate) created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkSuggestion {
    pub(crate) book_id: String,
    pub(crate) work_id: String,
    pub(crate) book_title: String,
    pub(crate) work_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) book_duration_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) work_duration_seconds: Option<f64>,
    pub(crate) reason: String,
    pub(crate) created_at_ms: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkStore {
    #[serde(default)]
    pub(crate) works: Vec<Work>,
    #[serde(default)]
    pub(crate) suggestions: Vec<WorkSuggestion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MatchTier {
    Manual,
    Asin,
    Isbn,
    TitleAuthorDuration,
    New,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct EditionCandidate {
    pub(crate) book_id: String,
    pub(crate) title: String,
    pub(crate) author: Option<String>,
    pub(crate) asin: Option<String>,
    pub(crate) isbn: Option<String>,
    pub(crate) duration_seconds: Option<f64>,
}

pub(crate) fn normalize_key(value: &str) -> String {
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

pub(crate) fn work_key(title: &str, author: Option<&str>) -> String {
    let title = normalize_key(title);
    match author {
        Some(author) if !normalize_key(author).is_empty() => {
            format!("{title}|{}", normalize_key(author))
        }
        _ => format!("{title}|"),
    }
}

pub(crate) fn durations_agree(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) if left > 0.0 && right > 0.0 => {
            let longer = left.max(right);
            (left - right).abs() / longer <= DURATION_TOLERANCE
        }
        _ => false,
    }
}

impl WorkStore {
    pub(crate) fn resolve(
        &mut self,
        candidate: &EditionCandidate,
        now_ms: u64,
        new_id: impl FnOnce() -> String,
    ) -> (String, MatchTier) {
        if let Some(index) = self
            .works
            .iter()
            .position(|work| work.book_ids.contains(&candidate.book_id))
        {
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
        if let Some(duration) = candidate.duration_seconds
            && duration > work.duration_seconds.unwrap_or(0.0)
        {
            work.duration_seconds = Some(duration);
        }
    }

    pub(crate) fn link_manually(&mut self, book_id: &str, work_id: &str) -> bool {
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

    pub(crate) fn reject_suggestion(&mut self, book_id: &str, work_id: &str) -> bool {
        let Some(work) = self.works.iter_mut().find(|work| work.id == work_id) else {
            return false;
        };
        if !work.excluded_book_ids.iter().any(|id| id == book_id) {
            work.excluded_book_ids.push(book_id.to_string());
        }
        work.manual_book_ids.retain(|id| id != book_id);
        work.book_ids.retain(|id| id != book_id);
        self.suggestions
            .retain(|suggestion| !(suggestion.book_id == book_id && suggestion.work_id == work_id));
        true
    }

    pub(crate) fn work_for_book(&self, book_id: &str) -> Option<&Work> {
        self.works
            .iter()
            .find(|work| work.book_ids.iter().any(|id| id == book_id))
    }

    pub(crate) fn book_to_work(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for work in self.works.iter() {
            for book_id in work.book_ids.iter() {
                map.insert(book_id.clone(), work.id.clone());
            }
        }
        map
    }

    pub(crate) fn prune_suggestions(&mut self, present_book_ids: &HashSet<String>) {
        self.suggestions
            .retain(|suggestion| present_book_ids.contains(&suggestion.book_id));
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

        let (resolved, tier) = store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(21_600.0)),
            2_000,
            &mut next_id,
        );
        assert_eq!(resolved, full);
        assert_eq!(tier, MatchTier::Manual);
    }

    #[test]
    fn rejecting_an_edition_a_heuristic_linked_detaches_it() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let (work, _) = store.resolve(
            &edition("book-1", "The Odyssey", "Homer", Some(46_920.0)),
            0,
            &mut next_id,
        );
        let (joined, tier) = store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(46_000.0)),
            1_000,
            &mut next_id,
        );
        assert_eq!(joined, work);
        assert_eq!(tier, MatchTier::TitleAuthorDuration);

        assert!(store.reject_suggestion("book-2", &work));
        assert!(
            store.work_for_book("book-2").is_none(),
            "a rejected edition stayed linked to the work"
        );
        assert_eq!(store.book_to_work().get("book-1"), Some(&work));

        let (own, tier) = store.resolve(
            &edition("book-2", "The Odyssey", "Homer", Some(46_000.0)),
            2_000,
            &mut next_id,
        );
        assert_ne!(own, work);
        assert_eq!(tier, MatchTier::New);
        assert!(store.suggestions.is_empty());
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
    fn a_work_keeps_editions_that_have_left_the_library() {
        let mut store = WorkStore::default();
        let mut next_id = ids();
        let mut first = edition("book-1", "The Odyssey", "Homer", Some(46_920.0));
        first.asin = Some("B002V1A0WE".to_string());
        store.resolve(&first, 0, &mut next_id);

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
