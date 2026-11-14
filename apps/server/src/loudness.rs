//! Loudness analysis: finds books that were mastered badly and works out a
//! playback gain that brings them back to a comfortable level.
//!
//! The audio files are only ever read. A background pass after each library
//! scan decodes a few short windows spread across every track with ffmpeg's
//! `ebur128` and `astats` filters, stores the measurements per book, and the
//! book API turns them into flags and a suggested gain. Without ffmpeg the
//! pass never runs and books simply carry no analysis.
//!
//! The measurements, not the verdicts, are stored, so the thresholds below can
//! change without decoding anything again. `ANALYZER_VERSION` is for changes to
//! what is measured or how it is sampled.

use crate::*;
use rusqlite::params;
use std::sync::atomic::{AtomicBool, Ordering};

/// Raise when the sampling or measurement changes, so every book is measured
/// again on the next pass. Threshold changes do not need it.
pub(crate) const ANALYZER_VERSION: i64 = 1;

/// Speech target in LUFS. Audible and ACX deliveries sit around -18 to -20,
/// and -18 is where most well mastered narration lands.
pub(crate) const TARGET_LUFS: f64 = -18.0;

/// A book more than this far from the target gets a suggested gain. Closer
/// than that the difference is small next to how much narrators vary, and
/// leaving most books untouched keeps "Audio adjusted" meaningful.
pub(crate) const ADJUST_DEADBAND_LU: f64 = 3.0;

/// More than 6 LU below the target (quieter than -24 LUFS, past the ACX floor
/// of -23 dB RMS) is flagged as quiet.
pub(crate) const QUIET_BELOW_TARGET_LU: f64 = 6.0;

/// Tracks whose loudness differs by more than this are flagged as
/// inconsistent. Short samples of speech vary by a couple of LU on their own,
/// so the threshold sits well above that noise.
pub(crate) const INCONSISTENT_SPREAD_LU: f64 = 5.0;

/// A left/right RMS difference above this is flagged as lopsided. Around 3 dB
/// is where a voice audibly sits off centre on headphones.
pub(crate) const LOPSIDED_IMBALANCE_DB: f64 = 3.0;

/// Reported imbalance when one channel is silent: audio on one side only.
pub(crate) const ONE_SIDED_IMBALANCE_DB: f64 = 60.0;

/// The suggested gain never pushes the sampled true peak above this.
pub(crate) const TRUE_PEAK_CEILING_DBTP: f64 = -1.0;

/// Tracks shorter than this (credits, intros) are left out of the spread.
const SPREAD_MIN_TRACK_SECONDS: f64 = 60.0;

/// One sampled window. Thirty seconds is long enough for the ebur128 gate to
/// settle on speech.
const WINDOW_SECONDS: f64 = 30.0;

/// Windows a book gets in total, split across its tracks: six minutes of
/// audio for a single-file book.
const WINDOWS_PER_BOOK: usize = 12;

/// A book with more tracks than this has an evenly spaced subset sampled, one
/// window each, so a 200-file rip costs the same as a 24-file one.
const MAX_TRACKS_SAMPLED: usize = 24;

/// ebur128 reports this for a window with nothing above its absolute gate.
const SILENT_LUFS: f64 = -70.0;

const WINDOW_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AudioFlag {
    Quiet,
    Inconsistent,
    Lopsided,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Channel {
    Left,
    Right,
}

/// What a book's measurements say, as the book API reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioAnalysis {
    pub(crate) integrated_lufs: f64,
    pub(crate) true_peak_dbtp: f64,
    /// Loudest minus quietest track, for books with two or more full tracks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) track_spread_lu: Option<f64>,
    /// Absent for mono files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) channel_imbalance_db: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) louder_channel: Option<Channel>,
    pub(crate) flags: Vec<AudioFlag>,
    /// Linear multiplier toward the target, within the book volume range.
    /// `1.0` when the book needs nothing.
    pub(crate) suggested_gain: f64,
}

/// Raw measurements for one book, as stored.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Measurements {
    pub(crate) integrated_lufs: f64,
    pub(crate) true_peak_dbtp: f64,
    pub(crate) track_spread_lu: Option<f64>,
    /// Left minus right, in dB. Positive means the left side is louder.
    pub(crate) channel_balance_db: Option<f64>,
}

impl Measurements {
    pub(crate) fn classify(&self) -> AudioAnalysis {
        let mut flags = Vec::new();
        if self.integrated_lufs < TARGET_LUFS - QUIET_BELOW_TARGET_LU {
            flags.push(AudioFlag::Quiet);
        }
        if self
            .track_spread_lu
            .is_some_and(|spread| spread > INCONSISTENT_SPREAD_LU)
        {
            flags.push(AudioFlag::Inconsistent);
        }
        if self
            .channel_balance_db
            .is_some_and(|balance| balance.abs() > LOPSIDED_IMBALANCE_DB)
        {
            flags.push(AudioFlag::Lopsided);
        }
        AudioAnalysis {
            integrated_lufs: round_tenth(self.integrated_lufs),
            true_peak_dbtp: round_tenth(self.true_peak_dbtp),
            track_spread_lu: self.track_spread_lu.map(round_tenth),
            channel_imbalance_db: self
                .channel_balance_db
                .map(|value| round_tenth(value.abs())),
            louder_channel: self.channel_balance_db.and_then(|balance| {
                if balance > 0.0 {
                    Some(Channel::Left)
                } else if balance < 0.0 {
                    Some(Channel::Right)
                } else {
                    None
                }
            }),
            flags,
            suggested_gain: suggested_gain(self.integrated_lufs, self.true_peak_dbtp),
        }
    }
}

fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// The gain, in dB, that moves a book toward the target without letting its
/// true peak past the ceiling. Boosts are capped by peak headroom; a quiet
/// book that already peaks near full scale is left alone rather than cut.
pub(crate) fn suggested_gain_db(integrated_lufs: f64, true_peak_dbtp: f64) -> f64 {
    if !integrated_lufs.is_finite() {
        return 0.0;
    }
    let wanted = TARGET_LUFS - integrated_lufs;
    if wanted.abs() <= ADJUST_DEADBAND_LU {
        return 0.0;
    }
    let mut gain = wanted;
    if wanted > 0.0 {
        let headroom = if true_peak_dbtp.is_finite() {
            TRUE_PEAK_CEILING_DBTP - true_peak_dbtp
        } else {
            0.0
        };
        gain = wanted.min(headroom).max(0.0);
    }
    let min_db = 20.0 * BOOK_VOLUME_GAIN_MIN.log10();
    let max_db = 20.0 * BOOK_VOLUME_GAIN_MAX.log10();
    let gain = gain.clamp(min_db, max_db);
    // Half a decibel is below what anyone would notice, and reporting it as
    // an adjustment would only add noise.
    if gain.abs() < 0.5 { 0.0 } else { gain }
}

pub(crate) fn suggested_gain(integrated_lufs: f64, true_peak_dbtp: f64) -> f64 {
    let db = suggested_gain_db(integrated_lufs, true_peak_dbtp);
    if db == 0.0 {
        return BOOK_VOLUME_GAIN_DEFAULT;
    }
    clamp_book_volume_gain(10f64.powf(db / 20.0))
}

/// Where a book's playback gain came from, for the listener's own view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VolumeGainSource {
    /// No setting and nothing to correct: the file's own level.
    #[default]
    Default,
    /// The listener set this book's level themselves.
    Manual,
    /// The suggested gain from the analysis.
    Auto,
}

/// The gain a listener hears. Their own setting always wins; otherwise the
/// suggestion applies unless they switched it off for this book.
pub(crate) fn resolve_volume_gain(
    manual_gain: Option<f64>,
    auto_volume: bool,
    suggested_gain: Option<f64>,
) -> (f64, VolumeGainSource) {
    if let Some(gain) = manual_gain {
        return (clamp_book_volume_gain(gain), VolumeGainSource::Manual);
    }
    match suggested_gain {
        Some(gain) if auto_volume && gain != BOOK_VOLUME_GAIN_DEFAULT => {
            (clamp_book_volume_gain(gain), VolumeGainSource::Auto)
        }
        _ => (BOOK_VOLUME_GAIN_DEFAULT, VolumeGainSource::Default),
    }
}

/// What one ffmpeg run over one window reported.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WindowReport {
    pub(crate) integrated_lufs: f64,
    pub(crate) true_peak_dbtp: f64,
    /// Per-channel RMS level in dBFS; `None` for a silent channel.
    pub(crate) channel_rms_db: Vec<Option<f64>>,
}

/// Reads the `ebur128` summary and the `astats` per-channel block out of
/// ffmpeg's log. Only lines after the filters' own markers are read, so tags
/// printed with the input description cannot be mistaken for measurements.
pub(crate) fn parse_ffmpeg_report(log: &str) -> Option<WindowReport> {
    let mut integrated = None;
    let mut peak = None;
    let mut channels: Vec<Option<f64>> = Vec::new();
    let mut in_summary = false;
    let mut section = "";
    let mut astats_channel: Option<usize> = None;
    for line in log.lines() {
        if line.contains("Parsed_astats") {
            let Some((_, text)) = line.split_once("] ") else {
                continue;
            };
            let text = text.trim();
            if let Some(number) = text.strip_prefix("Channel:") {
                astats_channel = number.trim().parse::<usize>().ok();
            } else if text == "Overall" {
                astats_channel = None;
            } else if let (Some(channel), Some(value)) =
                (astats_channel, text.strip_prefix("RMS level dB:"))
                && channel >= 1
            {
                if channels.len() < channel {
                    channels.resize(channel, None);
                }
                channels[channel - 1] = parse_db(value);
            }
            continue;
        }
        if line.contains("Parsed_ebur128") && line.contains("Summary:") {
            in_summary = true;
            continue;
        }
        if !in_summary {
            continue;
        }
        let text = line.trim();
        match text {
            "Integrated loudness:" => section = "integrated",
            "Loudness range:" => section = "range",
            "True peak:" => section = "peak",
            _ => {}
        }
        if section == "integrated"
            && let Some(value) = text.strip_prefix("I:")
        {
            integrated = parse_db(value.trim_end_matches("LUFS"));
        } else if section == "peak"
            && let Some(value) = text.strip_prefix("Peak:")
        {
            peak = Some(parse_db(value.trim_end_matches("dBFS")).unwrap_or(f64::NEG_INFINITY));
        }
    }
    Some(WindowReport {
        integrated_lufs: integrated?,
        true_peak_dbtp: peak.unwrap_or(f64::NEG_INFINITY),
        channel_rms_db: channels,
    })
}

fn parse_db(value: &str) -> Option<f64> {
    let value = value.trim();
    let value = value.split_whitespace().next().unwrap_or(value);
    if value == "-inf" {
        return None;
    }
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// One window to decode: a track, a start, a length.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlannedWindow {
    pub(crate) track: usize,
    pub(crate) start_seconds: f64,
    pub(crate) length_seconds: f64,
}

/// Spreads a book's windows across its tracks and across each track, keeping
/// clear of the first and last tenth where intros and credits live.
pub(crate) fn plan_windows(track_durations: &[Option<f64>]) -> Vec<PlannedWindow> {
    let count = track_durations.len();
    if count == 0 {
        return Vec::new();
    }
    let sampled: Vec<usize> = if count <= MAX_TRACKS_SAMPLED {
        (0..count).collect()
    } else {
        (0..MAX_TRACKS_SAMPLED)
            .map(|index| index * (count - 1) / (MAX_TRACKS_SAMPLED - 1))
            .collect()
    };
    let per_track = (WINDOWS_PER_BOOK / sampled.len()).max(1);
    let mut windows = Vec::new();
    for track in sampled {
        match track_durations[track].filter(|duration| duration.is_finite() && *duration > 0.0) {
            // Without a duration all that is safe is the start of the file.
            None => windows.push(PlannedWindow {
                track,
                start_seconds: 0.0,
                length_seconds: WINDOW_SECONDS,
            }),
            Some(duration) if duration <= WINDOW_SECONDS * per_track as f64 => {
                windows.push(PlannedWindow {
                    track,
                    start_seconds: 0.0,
                    length_seconds: duration,
                });
            }
            Some(duration) => {
                for index in 0..per_track {
                    let centre = duration * (0.1 + 0.8 * (index as f64 + 0.5) / per_track as f64);
                    let start =
                        (centre - WINDOW_SECONDS / 2.0).clamp(0.0, duration - WINDOW_SECONDS);
                    windows.push(PlannedWindow {
                        track,
                        start_seconds: start,
                        length_seconds: WINDOW_SECONDS,
                    });
                }
            }
        }
    }
    windows
}

/// A measured window together with where it came from.
#[derive(Debug, Clone)]
pub(crate) struct MeasuredWindow {
    pub(crate) track: usize,
    pub(crate) length_seconds: f64,
    pub(crate) report: WindowReport,
}

/// Loudness values average as energy, not as decibels.
fn energy_mean(values: impl Iterator<Item = (f64, f64)>) -> Option<f64> {
    let (mut energy, mut weight) = (0.0, 0.0);
    for (db, seconds) in values {
        energy += 10f64.powf(db / 10.0) * seconds;
        weight += seconds;
    }
    (weight > 0.0 && energy > 0.0).then(|| 10.0 * (energy / weight).log10())
}

/// Combines a book's windows into one set of measurements. `None` when every
/// window was silent: there is nothing to judge.
pub(crate) fn summarize(
    windows: &[MeasuredWindow],
    track_durations: &[Option<f64>],
) -> Option<Measurements> {
    let audible: Vec<&MeasuredWindow> = windows
        .iter()
        .filter(|window| window.report.integrated_lufs > SILENT_LUFS + 0.5)
        .collect();
    let integrated_lufs = energy_mean(
        audible
            .iter()
            .map(|window| (window.report.integrated_lufs, window.length_seconds)),
    )?;
    let true_peak_dbtp = windows
        .iter()
        .map(|window| window.report.true_peak_dbtp)
        .fold(f64::NEG_INFINITY, f64::max);

    let mut by_track: BTreeMap<usize, Vec<&MeasuredWindow>> = BTreeMap::new();
    for window in &audible {
        let long_enough = track_durations
            .get(window.track)
            .copied()
            .flatten()
            .is_none_or(|duration| duration >= SPREAD_MIN_TRACK_SECONDS);
        if long_enough {
            by_track.entry(window.track).or_default().push(window);
        }
    }
    let track_levels: Vec<f64> = by_track
        .values()
        .filter_map(|windows| {
            energy_mean(
                windows
                    .iter()
                    .map(|window| (window.report.integrated_lufs, window.length_seconds)),
            )
        })
        .collect();
    let track_spread_lu = (track_levels.len() >= 2).then(|| {
        let max = track_levels
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        let min = track_levels.iter().copied().fold(f64::INFINITY, f64::min);
        max - min
    });

    // Balance is judged only on stereo windows; a mono file has none.
    let stereo: Vec<&&MeasuredWindow> = audible
        .iter()
        .filter(|window| window.report.channel_rms_db.len() == 2)
        .collect();
    let channel_balance_db = if stereo.is_empty() {
        None
    } else {
        let power = |channel: usize| -> f64 {
            stereo
                .iter()
                .map(|window| {
                    window.report.channel_rms_db[channel].map_or(0.0, |db| 10f64.powf(db / 10.0))
                        * window.length_seconds
                })
                .sum()
        };
        let (left, right) = (power(0), power(1));
        match (left > 0.0, right > 0.0) {
            (true, true) => Some(
                (10.0 * (left / right).log10())
                    .clamp(-ONE_SIDED_IMBALANCE_DB, ONE_SIDED_IMBALANCE_DB),
            ),
            (true, false) => Some(ONE_SIDED_IMBALANCE_DB),
            (false, true) => Some(-ONE_SIDED_IMBALANCE_DB),
            (false, false) => None,
        }
    };

    Some(Measurements {
        integrated_lufs,
        true_peak_dbtp,
        track_spread_lu,
        channel_balance_db,
    })
}

/// A stored analysis. `measurements` is `None` when the book could not be
/// measured; the row still stops the same audio being retried every scan.
#[derive(Debug, Clone)]
pub(crate) struct StoredAnalysis {
    pub(crate) fingerprint: String,
    pub(crate) analyzer_version: i64,
    pub(crate) measurements: Option<Measurements>,
}

impl StoredAnalysis {
    /// The analysis for a book whose audio currently has `fingerprint`, or
    /// nothing when the audio changed since it was measured.
    pub(crate) fn current(&self, fingerprint: &str) -> Option<&Measurements> {
        if self.fingerprint != fingerprint || self.analyzer_version != ANALYZER_VERSION {
            return None;
        }
        self.measurements.as_ref()
    }
}

/// Analyses by book id, cached in memory and written through to the
/// `audio_analysis` table.
#[derive(Debug)]
pub(crate) struct AudioAnalysisStore {
    db: Database,
    cache: RwLock<HashMap<String, StoredAnalysis>>,
    requested: AtomicBool,
    running: AtomicBool,
}

impl AudioAnalysisStore {
    pub(crate) fn new(db: Database) -> Self {
        Self {
            db,
            cache: RwLock::new(HashMap::new()),
            requested: AtomicBool::new(false),
            running: AtomicBool::new(false),
        }
    }

    /// Fill the cache from the database. Called once at startup.
    pub(crate) async fn load(&self) -> Result<(), ApiError> {
        let rows = self
            .db
            .call(|connection| {
                let mut statement = connection.prepare(
                    "SELECT book_id, fingerprint, analyzer_version, integrated_lufs,
                            true_peak_dbtp, track_spread_lu, channel_balance_db
                     FROM audio_analysis",
                )?;
                let rows = statement.query_map([], |row| {
                    let integrated: Option<f64> = row.get(3)?;
                    let peak: Option<f64> = row.get(4)?;
                    let track_spread_lu = row.get(5)?;
                    let channel_balance_db = row.get(6)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        StoredAnalysis {
                            fingerprint: row.get(1)?,
                            analyzer_version: row.get(2)?,
                            measurements: integrated.map(|integrated_lufs| Measurements {
                                integrated_lufs,
                                true_peak_dbtp: peak.unwrap_or(f64::NEG_INFINITY),
                                track_spread_lu,
                                channel_balance_db,
                            }),
                        },
                    ))
                })?;
                rows.collect::<rusqlite::Result<HashMap<_, _>>>()
            })
            .await?;
        *self.cache.write().await = rows;
        Ok(())
    }

    /// Current analyses for the given books, as `(book_id, fingerprint)`.
    pub(crate) async fn current_for<'a>(
        &self,
        books: impl Iterator<Item = (&'a str, &'a str)>,
    ) -> HashMap<String, AudioAnalysis> {
        let cache = self.cache.read().await;
        books
            .filter_map(|(book_id, fingerprint)| {
                let measurements = cache.get(book_id)?.current(fingerprint)?;
                Some((book_id.to_string(), measurements.classify()))
            })
            .collect()
    }

    /// The fingerprint each book was last measured at by this analyzer.
    async fn measured_fingerprints(&self) -> HashMap<String, String> {
        self.cache
            .read()
            .await
            .iter()
            .filter(|(_, stored)| stored.analyzer_version == ANALYZER_VERSION)
            .map(|(book_id, stored)| (book_id.clone(), stored.fingerprint.clone()))
            .collect()
    }

    pub(crate) async fn record(
        &self,
        book_id: &str,
        analysis: StoredAnalysis,
        sampled_seconds: f64,
    ) -> Result<(), ApiError> {
        let (id, row) = (book_id.to_string(), analysis.clone());
        self.db
            .call(move |connection| {
                let measurements = row.measurements.as_ref();
                connection.execute(
                    "INSERT INTO audio_analysis (
                         book_id, fingerprint, analyzer_version, analyzed_at, sampled_seconds,
                         integrated_lufs, true_peak_dbtp, track_spread_lu, channel_balance_db
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT (book_id) DO UPDATE SET
                         fingerprint = excluded.fingerprint,
                         analyzer_version = excluded.analyzer_version,
                         analyzed_at = excluded.analyzed_at,
                         sampled_seconds = excluded.sampled_seconds,
                         integrated_lufs = excluded.integrated_lufs,
                         true_peak_dbtp = excluded.true_peak_dbtp,
                         track_spread_lu = excluded.track_spread_lu,
                         channel_balance_db = excluded.channel_balance_db",
                    params![
                        id,
                        row.fingerprint,
                        row.analyzer_version,
                        i64::try_from(unix_now_seconds()).unwrap_or(i64::MAX),
                        sampled_seconds,
                        measurements.map(|value| value.integrated_lufs),
                        measurements
                            .map(|value| value.true_peak_dbtp)
                            .filter(|value| value.is_finite()),
                        measurements.and_then(|value| value.track_spread_lu),
                        measurements.and_then(|value| value.channel_balance_db),
                    ],
                )?;
                Ok(())
            })
            .await?;
        self.cache
            .write()
            .await
            .insert(book_id.to_string(), analysis);
        Ok(())
    }

    /// Drop analyses for books no longer in the library.
    async fn prune(&self, present: &HashSet<String>) -> Result<(), ApiError> {
        let stale: Vec<String> = self
            .cache
            .read()
            .await
            .keys()
            .filter(|book_id| !present.contains(*book_id))
            .cloned()
            .collect();
        if stale.is_empty() {
            return Ok(());
        }
        let removed = stale.clone();
        self.db
            .call(move |connection| {
                let transaction = connection.transaction()?;
                for book_id in &removed {
                    transaction.execute(
                        "DELETE FROM audio_analysis WHERE book_id = ?1",
                        params![book_id],
                    )?;
                }
                transaction.commit()
            })
            .await?;
        let mut cache = self.cache.write().await;
        for book_id in stale {
            cache.remove(&book_id);
        }
        Ok(())
    }
}

/// Asks for an analysis pass. Passes never overlap; a request that lands
/// while one runs is picked up when it finishes. Does nothing without ffmpeg.
pub(crate) fn schedule_analysis(state: &AppState) {
    if state.faststart_tools.is_none() {
        return;
    }
    let store = state.audio_analysis.clone();
    store.requested.store(true, Ordering::SeqCst);
    if store.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            while store.requested.swap(false, Ordering::SeqCst) {
                run_pass(&state).await;
            }
            store.running.store(false, Ordering::SeqCst);
            if !store.requested.load(Ordering::SeqCst) || store.running.swap(true, Ordering::SeqCst)
            {
                return;
            }
        }
    });
}

struct Candidate {
    book_id: String,
    title: String,
    fingerprint: String,
    tracks: Vec<(PathBuf, Option<f64>)>,
}

/// Measures every book whose audio changed since it was last measured.
pub(crate) async fn run_pass(state: &AppState) {
    let Some(tools) = state.faststart_tools.clone() else {
        return;
    };
    let mut shutdown = state.shutdown.subscribe();
    // Read before the library lock rather than under it: catalogue requests
    // take the two in the other order.
    let measured = state.audio_analysis.measured_fingerprints().await;
    let (books, present) = {
        let library = state.library.read().await;
        if !library.catalogue_ready {
            return;
        }
        let books = library
            .books
            .iter()
            .filter(|book| {
                !book.audio_fingerprint.is_empty()
                    && measured.get(&book.id) != Some(&book.audio_fingerprint)
            })
            .map(|book| Candidate {
                book_id: book.id.clone(),
                title: book.title.clone(),
                fingerprint: book.audio_fingerprint.clone(),
                tracks: book
                    .tracks
                    .iter()
                    .filter_map(|track| {
                        library
                            .track_paths
                            .get(&track.id)
                            .map(|path| (path.clone(), track.duration_seconds))
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        let present = library.books.iter().map(|book| book.id.clone()).collect();
        (books, present)
    };
    if let Err(error) = state.audio_analysis.prune(&present).await {
        tracing::warn!("could not prune loudness analyses: {}", error.message);
    }
    for candidate in books {
        if candidate.tracks.is_empty() {
            continue;
        }
        let started = std::time::Instant::now();
        let outcome = tokio::select! {
            outcome = analyze_book(&tools, &candidate.tracks) => outcome,
            _ = shutdown.recv() => return,
        };
        let (measurements, sampled_seconds) = match outcome {
            Ok(result) => result,
            Err(error) => {
                // ffmpeg itself could not be started: stop rather than mark
                // every remaining book as unmeasurable.
                tracing::warn!("loudness analysis stopped: {error:#}");
                return;
            }
        };
        tracing::debug!(
            book = %candidate.title,
            elapsed_ms = started.elapsed().as_millis() as u64,
            sampled_seconds,
            measured = measurements.is_some(),
            "measured book loudness"
        );
        let stored = StoredAnalysis {
            fingerprint: candidate.fingerprint,
            analyzer_version: ANALYZER_VERSION,
            measurements,
        };
        if let Err(error) = state
            .audio_analysis
            .record(&candidate.book_id, stored, sampled_seconds)
            .await
        {
            tracing::warn!("could not store loudness analysis: {}", error.message);
            return;
        }
    }
}

/// How many windows decode at once. One on small machines; two where there
/// are cores to spare. Each ffmpeg is single-threaded and runs at the lowest
/// scheduling priority, so playback and scans always come first.
fn concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|cores| (cores.get() / 4).clamp(1, 2))
        .unwrap_or(1)
}

/// Measures one book. `Ok(None)` measurements mean the book was read but
/// nothing usable came back (undecodable or silent); `Err` means ffmpeg
/// could not run at all.
pub(crate) async fn analyze_book(
    tools: &faststart::Tools,
    tracks: &[(PathBuf, Option<f64>)],
) -> anyhow::Result<(Option<Measurements>, f64)> {
    let durations: Vec<Option<f64>> = tracks.iter().map(|(_, duration)| *duration).collect();
    let plan = plan_windows(&durations);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrency()));
    let mut tasks = tokio::task::JoinSet::new();
    for window in plan {
        let ffmpeg = tools.ffmpeg.clone();
        let path = tracks[window.track].0.clone();
        let semaphore = semaphore.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await;
            let report = measure_window(&ffmpeg, &path, &window).await;
            (window, report)
        });
    }
    let mut measured = Vec::new();
    let mut sampled_seconds = 0.0;
    while let Some(joined) = tasks.join_next().await {
        let (window, report) = joined?;
        match report {
            Ok(Some(report)) => {
                sampled_seconds += window.length_seconds;
                measured.push(MeasuredWindow {
                    track: window.track,
                    length_seconds: window.length_seconds,
                    report,
                });
            }
            Ok(None) => {}
            Err(error) => {
                tasks.abort_all();
                return Err(error);
            }
        }
    }
    Ok((summarize(&measured, &durations), sampled_seconds))
}

/// Decodes one window to nowhere and reads the measurements from the log.
/// `Ok(None)` is a file ffmpeg could not read or measure.
async fn measure_window(
    ffmpeg: &FsPath,
    path: &FsPath,
    window: &PlannedWindow,
) -> anyhow::Result<Option<WindowReport>> {
    let mut command = Command::new(ffmpeg);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-threads")
        .arg("1")
        .arg("-ss")
        .arg(format!("{:.3}", window.start_seconds))
        .arg("-t")
        .arg(format!("{:.3}", window.length_seconds))
        .arg("-i")
        .arg(path)
        .arg("-map")
        .arg("0:a:0")
        .arg("-vn")
        .arg("-sn")
        .arg("-dn")
        .arg("-af")
        .arg("ebur128=peak=true:framelog=verbose,astats")
        .arg("-f")
        .arg("null")
        .arg("-");
    let child = command
        .spawn()
        .map_err(|error| anyhow::anyhow!("could not run ffmpeg: {error}"))?;
    lower_priority(child.id());
    let output = match tokio::time::timeout(WINDOW_TIMEOUT, child.wait_with_output()).await {
        Ok(output) => output?,
        Err(_) => return Ok(None),
    };
    if !output.status.success() {
        return Ok(None);
    }
    Ok(parse_ffmpeg_report(&String::from_utf8_lossy(
        &output.stderr,
    )))
}

/// Puts an analysis ffmpeg at the lowest CPU priority. Renicing after spawn
/// leaves a moment at normal priority, which costs nothing here.
#[cfg(unix)]
fn lower_priority(pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: setpriority only reads its arguments; a stale pid fails
        // with ESRCH and is ignored.
        unsafe {
            libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, 19);
        }
    }
}

#[cfg(not(unix))]
fn lower_priority(_pid: Option<u32>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn measurements(integrated: f64, peak: f64) -> Measurements {
        Measurements {
            integrated_lufs: integrated,
            true_peak_dbtp: peak,
            track_spread_lu: None,
            channel_balance_db: None,
        }
    }

    #[test]
    fn a_book_near_the_target_is_left_alone() {
        for integrated in [-21.0, -18.0, -15.0] {
            assert_eq!(suggested_gain_db(integrated, -10.0), 0.0, "{integrated}");
        }
        let analysis = measurements(-19.0, -3.0).classify();
        assert_eq!(analysis.suggested_gain, 1.0);
        assert!(analysis.flags.is_empty());
    }

    #[test]
    fn a_quiet_book_is_flagged_and_lifted_to_the_target() {
        let analysis = measurements(-30.0, -20.0).classify();
        assert_eq!(analysis.flags, vec![AudioFlag::Quiet]);
        assert!((suggested_gain_db(-30.0, -20.0) - 12.0).abs() < 1e-9);
        assert!((analysis.suggested_gain - 10f64.powf(12.0 / 20.0)).abs() < 1e-9);
    }

    #[test]
    fn a_boost_stops_where_the_true_peak_would_pass_the_ceiling() {
        // Wants +12 dB, but the peak at -6 dBTP leaves only 5 dB of room.
        assert!((suggested_gain_db(-30.0, -6.0) - 5.0).abs() < 1e-9);
        // A quiet book that already peaks above the ceiling is not cut.
        assert_eq!(suggested_gain_db(-30.0, 0.5), 0.0);
        // Under half a decibel of headroom is not worth reporting.
        assert_eq!(suggested_gain_db(-30.0, -1.3), 0.0);
        // An unmeasured peak gives no headroom to spend.
        assert_eq!(suggested_gain_db(-30.0, f64::NEG_INFINITY), 0.0);
    }

    #[test]
    fn the_gain_stays_inside_the_book_volume_range() {
        // -60 LUFS wants +42 dB; the book volume ceiling is 16x (+24 dB).
        let gain = suggested_gain(-60.0, -80.0);
        assert_eq!(gain, BOOK_VOLUME_GAIN_MAX);
        // A very loud book wants -12 dB; the floor is 0.5x (about -6 dB).
        let gain = suggested_gain(-6.0, 0.0);
        assert_eq!(gain, BOOK_VOLUME_GAIN_MIN);
        // A moderately loud book is cut, and a cut ignores peak headroom.
        assert!((suggested_gain_db(-13.0, -0.2) + 5.0).abs() < 1e-9);
        assert_eq!(suggested_gain(f64::NAN, -3.0), 1.0);
    }

    #[test]
    fn inconsistent_and_lopsided_books_are_flagged() {
        let analysis = Measurements {
            integrated_lufs: -18.0,
            true_peak_dbtp: -3.0,
            track_spread_lu: Some(6.2),
            channel_balance_db: Some(-4.0),
        }
        .classify();
        assert_eq!(
            analysis.flags,
            vec![AudioFlag::Inconsistent, AudioFlag::Lopsided]
        );
        assert_eq!(analysis.channel_imbalance_db, Some(4.0));
        assert_eq!(analysis.louder_channel, Some(Channel::Right));

        let balanced = Measurements {
            integrated_lufs: -18.0,
            true_peak_dbtp: -3.0,
            track_spread_lu: Some(4.9),
            channel_balance_db: Some(2.9),
        }
        .classify();
        assert!(balanced.flags.is_empty());
    }

    #[test]
    fn the_listeners_own_level_always_wins() {
        assert_eq!(
            resolve_volume_gain(Some(1.0), true, Some(4.0)),
            (1.0, VolumeGainSource::Manual)
        );
        assert_eq!(
            resolve_volume_gain(Some(2.0), false, Some(4.0)),
            (2.0, VolumeGainSource::Manual)
        );
        assert_eq!(
            resolve_volume_gain(None, true, Some(4.0)),
            (4.0, VolumeGainSource::Auto)
        );
        assert_eq!(
            resolve_volume_gain(None, false, Some(4.0)),
            (1.0, VolumeGainSource::Default)
        );
        assert_eq!(
            resolve_volume_gain(None, true, Some(1.0)),
            (1.0, VolumeGainSource::Default)
        );
        assert_eq!(
            resolve_volume_gain(None, true, None),
            (1.0, VolumeGainSource::Default)
        );
        assert_eq!(
            resolve_volume_gain(Some(400.0), true, None),
            (BOOK_VOLUME_GAIN_MAX, VolumeGainSource::Manual)
        );
    }

    const LOG: &str = "\
Input #0, wav, from 'x.wav':
  Metadata:
    comment         : I: -5.0 LUFS
[Parsed_astats_1 @ 0x1] Channel: 1
[Parsed_astats_1 @ 0x1] Peak level dB: -28.063603
[Parsed_astats_1 @ 0x1] RMS level dB: -31.073990
[Parsed_astats_1 @ 0x1] Channel: 2
[Parsed_astats_1 @ 0x1] RMS level dB: -inf
[Parsed_astats_1 @ 0x1] Overall
[Parsed_astats_1 @ 0x1] RMS level dB: -34.084290
[Parsed_ebur128_0 @ 0x2] Summary:

  Integrated loudness:
    I:         -31.8 LUFS
    Threshold: -41.8 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -51.8 LUFS

  True peak:
    Peak:      -28.1 dBFS
";

    #[test]
    fn ffmpeg_reports_are_read_from_the_filter_output_only() {
        let report = parse_ffmpeg_report(LOG).unwrap();
        assert_eq!(report.integrated_lufs, -31.8);
        assert_eq!(report.true_peak_dbtp, -28.1);
        assert_eq!(report.channel_rms_db, vec![Some(-31.07399), None]);
        assert!(parse_ffmpeg_report("Input #0\n  Metadata:\n    I: -5.0 LUFS\n").is_none());
    }

    #[test]
    fn windows_are_spread_across_tracks_within_the_budget() {
        let single = plan_windows(&[Some(36_000.0)]);
        assert_eq!(single.len(), WINDOWS_PER_BOOK);
        assert!(single[0].start_seconds >= 3_600.0 - WINDOW_SECONDS);
        assert!(single.last().unwrap().start_seconds <= 32_400.0);
        assert!(
            single
                .windows(2)
                .all(|pair| pair[0].start_seconds < pair[1].start_seconds)
        );

        let four = plan_windows(&[Some(3_000.0); 4]);
        assert_eq!(four.len(), 12);
        assert!((0..4).all(|track| four.iter().filter(|w| w.track == track).count() == 3));

        let many = plan_windows(&vec![Some(1_800.0); 200]);
        assert_eq!(many.len(), MAX_TRACKS_SAMPLED);
        assert_eq!(many.first().unwrap().track, 0);
        assert_eq!(many.last().unwrap().track, 199);

        let short = plan_windows(&[Some(12.0), None]);
        assert_eq!(short[0].length_seconds, 12.0);
        assert_eq!(short[0].start_seconds, 0.0);
        assert_eq!(short[1].start_seconds, 0.0);
        assert!(plan_windows(&[]).is_empty());
    }

    fn window(track: usize, lufs: f64, channels: Vec<Option<f64>>) -> MeasuredWindow {
        MeasuredWindow {
            track,
            length_seconds: 30.0,
            report: WindowReport {
                integrated_lufs: lufs,
                true_peak_dbtp: lufs + 15.0,
                channel_rms_db: channels,
            },
        }
    }

    #[test]
    fn windows_combine_by_energy_and_skip_silence() {
        let durations = [Some(600.0), Some(600.0), Some(20.0)];
        let windows = vec![
            window(0, -20.0, vec![Some(-22.0), Some(-22.0)]),
            window(0, -20.0, vec![Some(-22.0), Some(-22.0)]),
            window(1, -26.0, vec![Some(-28.0), Some(-28.0)]),
            // A silent window is ignored for loudness.
            window(1, SILENT_LUFS, vec![None, None]),
            // A credits track shorter than a minute is left out of the spread.
            window(2, -40.0, vec![Some(-42.0), Some(-42.0)]),
        ];
        let summary = summarize(&windows, &durations).unwrap();
        assert!((summary.track_spread_lu.unwrap() - 6.0).abs() < 1e-9);
        // Energy mean of -20, -20, -26, -40 is well above the dB mean.
        assert!(summary.integrated_lufs > -22.5 && summary.integrated_lufs < -21.5);
        assert_eq!(summary.true_peak_dbtp, -5.0);
        assert!(summary.channel_balance_db.unwrap().abs() < 1e-9);

        let left_only = vec![window(0, -25.0, vec![Some(-25.0), None])];
        let summary = summarize(&left_only, &[Some(600.0)]).unwrap();
        assert_eq!(summary.channel_balance_db, Some(ONE_SIDED_IMBALANCE_DB));
        assert_eq!(summary.track_spread_lu, None);

        let mono = vec![window(0, -25.0, vec![Some(-25.0)])];
        assert_eq!(
            summarize(&mono, &[Some(600.0)]).unwrap().channel_balance_db,
            None
        );
        assert!(summarize(&[window(0, SILENT_LUFS, vec![None, None])], &[None]).is_none());
    }

    #[tokio::test]
    async fn stored_analyses_survive_a_restart_and_follow_the_fingerprint() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("operalibre.db");
        let measured = measurements(-30.0, -20.0);
        {
            let store = AudioAnalysisStore::new(Database::open(&path).unwrap());
            for (book, measurements) in [("quiet", Some(measured.clone())), ("broken", None)] {
                store
                    .record(
                        book,
                        StoredAnalysis {
                            fingerprint: "v1".into(),
                            analyzer_version: ANALYZER_VERSION,
                            measurements,
                        },
                        30.0,
                    )
                    .await
                    .unwrap();
            }
        }
        let store = AudioAnalysisStore::new(Database::open(&path).unwrap());
        store.load().await.unwrap();
        let current = store
            .current_for([("quiet", "v1"), ("broken", "v1")].into_iter())
            .await;
        assert_eq!(current.len(), 1);
        assert_eq!(current["quiet"], measured.classify());
        // An unmeasurable book is not retried until its audio changes.
        let measured = store.measured_fingerprints().await;
        assert_eq!(measured.get("broken").map(String::as_str), Some("v1"));
        assert!(!measured.contains_key("new"));
        assert!(
            store
                .current_for([("quiet", "v2")].into_iter())
                .await
                .is_empty()
        );

        store
            .prune(&HashSet::from(["broken".to_string()]))
            .await
            .unwrap();
        assert!(!store.measured_fingerprints().await.contains_key("quiet"));
    }

    /// Generates short WAVs with ffmpeg and measures them for real. Skipped
    /// where ffmpeg is not installed, since the feature is disabled there.
    #[tokio::test]
    async fn generated_fixtures_are_measured_and_classified() {
        let Some(tools) = faststart::discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        // Pink noise is closer to speech than a sine for the K-weighting.
        let make = |name: &str, filter: &str| {
            let path = root.path().join(name);
            let status = std::process::Command::new(&tools.ffmpeg)
                .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"])
                .args(["-f", "lavfi", "-i", "anoisesrc=d=40:c=pink:r=44100:a=0.5"])
                .args(["-af", filter, "-ac", "2"])
                .arg(&path)
                .status()
                .unwrap();
            assert!(status.success());
            path
        };
        let normal = make("normal.wav", "volume=0dB,pan=stereo|c0=c0|c1=c0");
        let quiet = make("quiet.wav", "volume=-16dB,pan=stereo|c0=c0|c1=c0");
        let left = make("left.wav", "pan=stereo|c0=c0|c1=0*c0");

        let measure = |path: PathBuf| {
            let tools = tools.clone();
            async move {
                analyze_book(&tools, &[(path, Some(40.0))])
                    .await
                    .unwrap()
                    .0
                    .unwrap()
            }
        };
        let normal = measure(normal).await;
        let quiet = measure(quiet).await;
        let left = measure(left).await;

        let normal_analysis = normal.classify();
        assert!(
            !normal_analysis.flags.contains(&AudioFlag::Quiet),
            "{normal:?}"
        );
        assert!(normal.channel_balance_db.unwrap().abs() < 0.5, "{normal:?}");

        let quiet_analysis = quiet.classify();
        assert!(
            quiet_analysis.flags.contains(&AudioFlag::Quiet),
            "{quiet:?}"
        );
        assert!(quiet_analysis.suggested_gain > 1.0, "{quiet:?}");
        // The boost never pushes the measured peak past the ceiling.
        let boosted_peak = quiet.true_peak_dbtp + 20.0 * quiet_analysis.suggested_gain.log10();
        assert!(boosted_peak <= TRUE_PEAK_CEILING_DBTP + 1e-6, "{quiet:?}");
        assert!((normal.integrated_lufs - quiet.integrated_lufs - 16.0).abs() < 1.0);

        let left_analysis = left.classify();
        assert!(
            left_analysis.flags.contains(&AudioFlag::Lopsided),
            "{left:?}"
        );
        assert_eq!(left_analysis.louder_channel, Some(Channel::Left));
        assert_eq!(
            left_analysis.channel_imbalance_db,
            Some(ONE_SIDED_IMBALANCE_DB)
        );
    }

    /// A file ffmpeg cannot decode is recorded as unmeasurable, not retried
    /// and not an error.
    #[tokio::test]
    async fn an_unreadable_file_yields_no_measurements() {
        let Some(tools) = faststart::discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("broken.mp3");
        std::fs::write(&path, b"not audio at all").unwrap();
        let (measurements, sampled) = analyze_book(&tools, &[(path, Some(100.0))]).await.unwrap();
        assert!(measurements.is_none());
        assert_eq!(sampled, 0.0);
    }

    #[tokio::test]
    async fn a_missing_ffmpeg_is_an_error_not_an_unmeasurable_book() {
        let tools = faststart::Tools {
            ffmpeg: PathBuf::from("/nonexistent/operalibre-test-ffmpeg"),
            ffprobe: None,
        };
        let result = analyze_book(&tools, &[(PathBuf::from("/tmp/x.mp3"), Some(10.0))]).await;
        assert!(result.is_err());
    }
}
