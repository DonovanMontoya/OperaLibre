//! Daily listening totals, streaks, profile stats, and the finish feed.

use crate::*;

const FINISH_FEED_PAGE: usize = 50;

/// Days with less listening than this do not count as active. Streaks and the
/// per-day average both use it, so a scattering of sub-minute days can neither
/// extend a streak nor dilute every other day's average.
const ACTIVE_DAY_MIN_SECONDS: f64 = 30.0;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinishFeedEntry {
    id: String,
    user_id: String,
    username: String,
    book_id: String,
    book_title: String,
    finished_at: String,
    unseen: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinishFeedResponse {
    entries: Vec<FinishFeedEntry>,
    unseen_count: usize,
    latest_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkFinishFeedSeenRequest {
    event_id: String,
}

pub(crate) async fn finish_feed(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<FinishFeedResponse>, ApiError> {
    if !auth.share_progress || !auth.notify_finishes {
        return Ok(Json(FinishFeedResponse {
            entries: Vec::new(),
            unseen_count: 0,
            latest_id: None,
        }));
    }
    let announcers: HashMap<String, String> = state
        .users
        .read()
        .await
        .users
        .iter()
        .filter(|user| user.share_progress && user.announce_finishes && user.id != auth.id)
        .map(|user| (user.id.clone(), user.username.clone()))
        .collect();
    let history = state.reading_history.read().await;
    let seen_index = history
        .finish_seen
        .get(&auth.id)
        .and_then(|id| history.completions.iter().position(|event| &event.id == id));
    let mut entries: Vec<_> = history
        .completions
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            let username = announcers.get(&event.user_id)?;
            if !can_access_book(&auth, &event.book_id) {
                return None;
            }
            Some(FinishFeedEntry {
                id: event.id.clone(),
                user_id: event.user_id.clone(),
                username: username.clone(),
                book_id: event.book_id.clone(),
                book_title: event.snapshot.title.clone(),
                finished_at: (event.finished_at_ms / 1_000).to_string(),
                unseen: seen_index.is_none_or(|seen| index > seen),
            })
        })
        .collect();
    entries.reverse();
    entries.truncate(FINISH_FEED_PAGE);
    let unseen_count = entries.iter().filter(|entry| entry.unseen).count();
    let latest_id = entries.first().map(|entry| entry.id.clone());
    Ok(Json(FinishFeedResponse {
        entries,
        unseen_count,
        latest_id,
    }))
}

pub(crate) async fn mark_finish_feed_seen(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<MarkFinishFeedSeenRequest>,
) -> Result<Json<FinishFeedResponse>, ApiError> {
    state
        .reading_history
        .mutate(|history| {
            let incoming = history
                .completions
                .iter()
                .position(|event| event.id == payload.event_id);
            let current = history
                .finish_seen
                .get(&auth.id)
                .and_then(|id| history.completions.iter().position(|event| &event.id == id));
            if matches!((incoming, current), (Some(next), Some(previous)) if next > previous)
                || matches!((incoming, current), (Some(_), None))
            {
                history
                    .finish_seen
                    .insert(auth.id.clone(), payload.event_id.clone());
            }
            Ok(())
        })
        .await?;
    finish_feed(State(state), Extension(auth)).await
}

pub(crate) const ACTIVITY_BASELINE_KEY: &str = "__operalibre_position_baseline__";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ActivityStore {
    pub(crate) by_user: HashMap<String, BTreeMap<String, f64>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileStatsQuery {
    /// The reader's offset from UTC in minutes, east positive. Streaks and the
    /// calendar are drawn against the reader's own days, not the server's.
    pub(crate) tz_offset_minutes: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileStats {
    pub(crate) total_hours_read: f64,
    pub(crate) books_finished: u32,
    pub(crate) total_tracks_completed: u32,
    pub(crate) current_streak_days: u32,
    pub(crate) longest_streak_days: u32,
    pub(crate) avg_daily_minutes: f64,
    pub(crate) last_listened_at: Option<String>,
    pub(crate) favorite_narrator: Option<String>,
    pub(crate) favorite_genre: Option<String>,
    pub(crate) days_active: u32,
    pub(crate) member_since: String,
    /// The first day the activity log recorded anything, so the client can say
    /// what window the listening total covers instead of implying all time.
    pub(crate) measuring_since: Option<String>,
    pub(crate) streak_calendar: Vec<StreakDay>,
    pub(crate) recent_books: Vec<RecentBook>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreakDay {
    pub(crate) date: String,
    pub(crate) minutes: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentBook {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) cover_art_url: Option<String>,
    pub(crate) hours_read: f64,
    pub(crate) finished: bool,
    pub(crate) updated_at: String,
}

/// Real UTC offsets span UTC-12 to UTC+14. Anything outside that is a broken
/// or hostile client and is treated as UTC rather than shifting the calendar.
pub(crate) fn sanitized_tz_offset_minutes(offset_minutes: Option<i32>) -> i64 {
    offset_minutes
        .filter(|minutes| (-12 * 60..=14 * 60).contains(minutes))
        .unwrap_or(0) as i64
}

pub(crate) fn today_ymd(tz_offset_minutes: i64) -> String {
    // Year-month-day in the listener's zone, no extra deps. Uses civil-date
    // conversion from days-since-epoch (1970-01-01) via Hinnant's algorithm.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0) as i64;
    days_to_ymd((now + tz_offset_minutes * 60).div_euclid(86_400))
}

pub(crate) fn days_to_ymd(days_since_epoch: i64) -> String {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
}

pub(crate) fn ymd_to_days(ymd: &str) -> Option<i64> {
    let mut parts = ymd.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj.rem_euclid(400);
    let m_adj = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * m_adj + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

pub(crate) async fn record_activity(
    state: &AppState,
    user_id: &str,
    delta_seconds: f64,
    tz_offset_minutes: i64,
) {
    let today = today_ymd(tz_offset_minutes);
    // Keep mutation and persistence under one lock. Otherwise two snapshots can
    // be written in reverse order and an older activity total can win on disk.
    let stored = state
        .activity
        .mutate(|activity| {
            let user_activity = activity.by_user.entry(user_id.to_string()).or_default();
            let entry = user_activity.entry(today).or_insert(0.0);
            *entry += delta_seconds;
            Ok(())
        })
        .await;
    if let Err(error) = stored {
        // The increment is dropped rather than kept only in memory: listening
        // totals that exist in the cache but not on disk reappear as a jump
        // backwards after any restart.
        tracing::warn!("failed to persist activity log: {}", error.message);
    }
}

pub(crate) async fn profile_stats(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<ProfileStatsQuery>,
) -> Result<Json<ProfileStats>, ApiError> {
    let tz_offset_minutes = sanitized_tz_offset_minutes(query.tz_offset_minutes);
    let today = ymd_to_days(&today_ymd(tz_offset_minutes)).unwrap_or(0);
    let library = state.library.read().await;
    let progress_map = state.progress.list_for_user(&auth.id).await?;
    let user_progress: Vec<(&String, &Progress)> = progress_map.iter().collect();

    // Headline numbers.
    let mut books_finished = 0u32;
    let mut total_tracks_completed = 0u32;
    let mut narrator_hours: HashMap<String, f64> = HashMap::new();
    let mut genre_hours: HashMap<String, f64> = HashMap::new();
    let mut last_updated: Option<String> = None;

    let mut book_lookup: HashMap<&str, &Book> = HashMap::new();
    for book in library.books.iter() {
        if can_access_book(&auth, &book.id) {
            book_lookup.insert(book.id.as_str(), book);
        }
    }

    let mut recent: Vec<RecentBook> = Vec::new();
    for (_, progress) in user_progress.iter() {
        if let Some(book) = book_lookup.get(progress.book_id.as_str()) {
            let summary = summarize_book_progress(book, progress);
            // How far into the book the reader has reached — the only per-book
            // signal there is, since the activity log records days and not
            // books. Good enough to rank narrators and genres and to caption a
            // shelf row; deliberately not added into the listening total.
            let hours = reached_position_seconds(book, progress) / 3600.0;
            let finished = matches!(summary.status, BookProgressStatus::Finished);
            if finished {
                books_finished += 1;
                total_tracks_completed += book.tracks.len() as u32;
            } else {
                let track_index = book
                    .tracks
                    .iter()
                    .position(|track| track.id == progress.track_id)
                    .unwrap_or(0);
                total_tracks_completed += track_index as u32;
            }
            if let Some(narrator) = book.narrator.as_ref() {
                *narrator_hours.entry(narrator.clone()).or_insert(0.0) += hours;
            }
            for genre in book.genres.iter() {
                *genre_hours.entry(genre.clone()).or_insert(0.0) += hours;
            }
            recent.push(RecentBook {
                id: book.id.clone(),
                title: book.title.clone(),
                cover_art_url: book.cover_art_url.clone(),
                hours_read: hours,
                finished,
                updated_at: progress.updated_at.clone(),
            });
            // Revisions are numeric, but legacy rows hold epoch seconds and
            // newer ones epoch milliseconds. Comparing the strings would order
            // a ten-digit revision against a thirteen-digit one by its leading
            // characters, so parse both to a common unit first.
            match &last_updated {
                Some(prev)
                    if progress_timestamp_seconds(prev)
                        >= progress_timestamp_seconds(&progress.updated_at) => {}
                _ => last_updated = Some(progress.updated_at.clone()),
            }
        }
    }

    recent.sort_by(|a, b| {
        progress_timestamp_seconds(&b.updated_at)
            .partial_cmp(&progress_timestamp_seconds(&a.updated_at))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    recent.truncate(6);

    // Activity-based numbers.
    let activity = state.activity.read().await;
    let user_activity = activity.by_user.get(&auth.id).cloned().unwrap_or_default();

    // Only ground actually covered while playing, summed from the per-day log.
    // Every second here came from a forward position move that the server could
    // match against elapsed wall-clock time, with deliberate seeks excluded —
    // so this is time spent listening, not how far into books the reader has
    // reached. Nothing estimates the era before the log existed; that history
    // is unmeasured, and `measuring_since` says so rather than guessing.
    let total_seconds_activity: f64 = user_activity.values().map(|seconds| seconds.max(0.0)).sum();
    let total_hours_read = total_seconds_activity / 3600.0;
    let measuring_since = user_activity
        .iter()
        .find(|(_, seconds)| **seconds > 0.0)
        .map(|(date, _)| date.clone());

    // "Per active day" must divide the same seconds it counts days for.
    let active_day_seconds: f64 = user_activity
        .values()
        .filter(|seconds| **seconds > ACTIVE_DAY_MIN_SECONDS)
        .sum();
    let days_active = user_activity
        .values()
        .filter(|seconds| **seconds > ACTIVE_DAY_MIN_SECONDS)
        .count() as u32;

    let avg_daily_minutes = if days_active > 0 {
        (active_day_seconds / 60.0) / days_active as f64
    } else {
        0.0
    };

    let (current_streak_days, longest_streak_days) = compute_streaks(&user_activity, today);
    let streak_calendar = build_streak_calendar(&user_activity, 8, today);

    let favorite_narrator = narrator_hours
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .filter(|(_, hours)| *hours > 0.05)
        .map(|(name, _)| name);
    let favorite_genre = genre_hours
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .filter(|(_, hours)| *hours > 0.05)
        .map(|(name, _)| name);

    let member_since = state
        .users
        .read()
        .await
        .users
        .iter()
        .find(|user| user.id == auth.id)
        .map(|user| user.created_at.clone())
        .unwrap_or_default();

    Ok(Json(ProfileStats {
        total_hours_read,
        books_finished,
        total_tracks_completed,
        current_streak_days,
        longest_streak_days,
        avg_daily_minutes,
        last_listened_at: last_updated,
        favorite_narrator,
        favorite_genre,
        days_active,
        member_since,
        measuring_since,
        streak_calendar,
        recent_books: recent,
    }))
}

pub(crate) fn compute_streaks(activity: &BTreeMap<String, f64>, today: i64) -> (u32, u32) {
    let mut active_days: Vec<i64> = activity
        .iter()
        .filter_map(|(date, seconds)| {
            if *seconds > ACTIVE_DAY_MIN_SECONDS {
                ymd_to_days(date)
            } else {
                None
            }
        })
        .collect();
    active_days.sort_unstable();
    active_days.dedup();

    if active_days.is_empty() {
        return (0, 0);
    }

    let mut longest = 1u32;
    let mut run = 1u32;
    for window in active_days.windows(2) {
        if window[1] - window[0] == 1 {
            run += 1;
            if run > longest {
                longest = run;
            }
        } else {
            run = 1;
        }
    }

    let last = *active_days.last().unwrap();
    let current = if today - last <= 1 {
        let mut run = 1u32;
        for window in active_days.windows(2).rev() {
            if window[1] - window[0] == 1 {
                run += 1;
            } else {
                break;
            }
        }
        run
    } else {
        0
    };

    (current, longest)
}

/// Monday-based weekday index for a day count since 1970-01-01, which was a
/// Thursday.
pub(crate) fn weekday_from_monday(days_since_epoch: i64) -> i64 {
    (days_since_epoch + 3).rem_euclid(7)
}

/// Whole calendar weeks ending with the week that contains today, so the grid
/// the client draws lines up under a fixed Monday-to-Sunday label column. The
/// tail of the current week is still in the future and simply reads as zero.
pub(crate) fn build_streak_calendar(
    activity: &BTreeMap<String, f64>,
    weeks: i64,
    today: i64,
) -> Vec<StreakDay> {
    let start = today - weekday_from_monday(today) - (weeks - 1) * 7;
    (0..weeks * 7)
        .map(|offset| {
            let date = days_to_ymd(start + offset);
            let seconds = activity.get(&date).copied().unwrap_or(0.0);
            StreakDay {
                date,
                minutes: seconds / 60.0,
            }
        })
        .collect()
}
