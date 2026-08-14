//! MP4 "faststart" maintenance.
//!
//! An MP4/M4B file written without `-movflags +faststart` keeps its `moov`
//! index *after* the audio data, so a player has to fetch the end of the file
//! (or, over a slow link, most of it) before it can start. Rewriting the
//! container fixes that without touching the audio itself.
//!
//! Conversion is never done in place. Each candidate is remuxed with `-c copy`
//! into a temporary file, verified (box order, size, duration, stream and
//! chapter layout), and only then swapped over the original with an atomic
//! rename. A hard link keeps the original reachable until the swap succeeds,
//! so a crash mid-conversion can never leave a book missing.

use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;

use rand::RngExt;

/// Extensions that use the ISO base media container — the only ones where a
/// faststart layout means anything. MP3/FLAC/OGG stream from byte zero.
const MP4_EXTENSIONS: &[&str] = &["m4a", "m4b", "mp4"];

/// Prefix shared by the temporary and backup files conversion creates. Library
/// scans skip it, so a half-written remux is never mistaken for a book.
pub const TEMP_PREFIX: &str = ".operalibre-faststart-";

/// A conversion is refused unless the volume keeps this much room beyond the
/// copy it is about to write.
pub const MIN_FREE_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;

/// Guards against walking a pathological file forever.
const MAX_BOXES: usize = 4_096;

/// A verified remux must stay within this fraction of the source duration.
const DURATION_TOLERANCE_SECONDS: f64 = 1.0;

pub fn is_mp4_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MP4_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
}

/// True for the temporary and backup files this module writes beside a book.
pub fn is_work_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(TEMP_PREFIX))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// `moov` comes before `mdat`: the file streams from the first bytes.
    Faststart,
    /// `mdat` comes before `moov`: worth converting.
    Trailing,
    /// Not an MP4 container, or one whose box structure did not add up.
    /// Never converted — a file we cannot read confidently is left alone.
    Unknown,
}

pub fn inspect(path: &Path) -> io::Result<Layout> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    inspect_boxes(&mut file, size)
}

/// Walks the top-level box chain far enough to learn whether `moov` precedes
/// `mdat`. Only box headers are read, so the cost is a handful of seeks even
/// on a multi-gigabyte file.
pub fn inspect_boxes<R: Read + Seek>(reader: &mut R, size: u64) -> io::Result<Layout> {
    let mut offset = 0_u64;
    let mut seen_mdat = false;

    for index in 0..MAX_BOXES {
        if offset.saturating_add(8) > size {
            break;
        }
        reader.seek(SeekFrom::Start(offset))?;
        let mut header = [0_u8; 8];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error),
        }

        let mut header_len = 8_u64;
        let mut box_size = u64::from(u32::from_be_bytes([
            header[0], header[1], header[2], header[3],
        ]));
        let box_type = [header[4], header[5], header[6], header[7]];

        // The first box of an ISO base media file is `ftyp`. Anything else
        // means this is not a container we should be rewriting.
        if index == 0 && &box_type != b"ftyp" {
            return Ok(Layout::Unknown);
        }
        if !box_type.iter().all(|byte| byte.is_ascii_graphic()) {
            return Ok(Layout::Unknown);
        }

        if box_size == 1 {
            let mut extended = [0_u8; 8];
            match reader.read_exact(&mut extended) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                    return Ok(Layout::Unknown);
                }
                Err(error) => return Err(error),
            }
            box_size = u64::from_be_bytes(extended);
            header_len = 16;
        } else if box_size == 0 {
            // A zero size means "runs to the end of the file".
            box_size = size - offset;
        }

        // A box that claims to be shorter than its own header, or to run past
        // the end of the file, means a truncated or corrupt file.
        if box_size < header_len || offset.saturating_add(box_size) > size {
            return Ok(Layout::Unknown);
        }

        match &box_type {
            b"moov" => {
                return Ok(if seen_mdat {
                    Layout::Trailing
                } else {
                    Layout::Faststart
                });
            }
            b"mdat" => seen_mdat = true,
            _ => {}
        }

        offset += box_size;
    }

    // Media data with no index behind it is not a file to rewrite.
    Ok(Layout::Unknown)
}

#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    /// Optional: without it a conversion is verified by container layout and
    /// size alone, which is weaker, so its absence is surfaced to the admin.
    pub ffprobe: Option<PathBuf>,
}

/// Resolves the configured or `PATH`-provided ffmpeg toolchain. Returns `None`
/// when ffmpeg is missing, which disables the whole feature.
pub fn discover_tools(ffmpeg: Option<PathBuf>, ffprobe: Option<PathBuf>) -> Option<Tools> {
    let ffmpeg = ffmpeg
        .filter(|path| path.is_file())
        .or_else(|| find_on_path(&["ffmpeg", "ffmpeg.exe"]))?;
    let ffprobe = ffprobe
        .filter(|path| path.is_file())
        .or_else(|| sibling_tool(&ffmpeg, "ffprobe"))
        .or_else(|| find_on_path(&["ffprobe", "ffprobe.exe"]));
    Some(Tools { ffmpeg, ffprobe })
}

fn find_on_path(candidates: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// ffprobe normally ships beside ffmpeg, including in the static builds people
/// unpack outside `PATH`.
fn sibling_tool(ffmpeg: &Path, name: &str) -> Option<PathBuf> {
    let parent = ffmpeg.parent()?;
    let suffix = if ffmpeg
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        ".exe"
    } else {
        ""
    };
    let path = parent.join(format!("{name}{suffix}"));
    path.is_file().then_some(path)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MediaSummary {
    pub duration_seconds: Option<f64>,
    pub audio_streams: usize,
    /// Cover art (and, in principle, real video). Counted separately from the
    /// data tracks, which the remux deliberately regenerates.
    pub video_streams: usize,
    pub chapters: usize,
}

/// Reads the stream/chapter layout of a file. `None` when ffprobe is absent or
/// its output could not be parsed.
pub fn probe(tools: &Tools, path: &Path) -> Option<MediaSummary> {
    let ffprobe = tools.ffprobe.as_ref()?;
    let output = Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-of")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg("-show_chapters")
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let streams = parsed
        .get("streams")
        .and_then(|value| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let duration_seconds = parsed
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| duration.as_str())
        .and_then(|duration| duration.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0);
    let count_of = |wanted: &str| {
        streams
            .iter()
            .filter(|stream| {
                stream
                    .get("codec_type")
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| value == wanted)
            })
            .count()
    };
    Some(MediaSummary {
        duration_seconds,
        audio_streams: count_of("audio"),
        video_streams: count_of("video"),
        chapters: parsed
            .get("chapters")
            .and_then(|value| value.as_array())
            .map(Vec::len)
            .unwrap_or(0),
    })
}

/// Why a candidate was rejected before or after the remux ran. Every variant
/// leaves the original file exactly as it was.
#[derive(Debug)]
pub enum ConversionError {
    /// The volume cannot hold a second copy of the file.
    NotEnoughSpace {
        needed_bytes: u64,
        available_bytes: u64,
    },
    /// ffmpeg exited non-zero.
    Remux { message: String },
    /// The remux finished but the result did not match the original.
    Verification { message: String },
    /// Something went wrong reading, writing, or renaming.
    Io(io::Error),
}

impl std::fmt::Display for ConversionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEnoughSpace {
                needed_bytes,
                available_bytes,
            } => write!(
                formatter,
                "not enough free space: needs {} MiB with {} MiB available",
                needed_bytes / (1024 * 1024),
                available_bytes / (1024 * 1024)
            ),
            Self::Remux { message } => write!(formatter, "ffmpeg failed: {message}"),
            Self::Verification { message } => {
                write!(formatter, "conversion rejected: {message}")
            }
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

impl From<io::Error> for ConversionError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Converted {
    pub before_bytes: u64,
    pub after_bytes: u64,
    /// False when ffprobe was unavailable, so only the container layout and
    /// size could be checked.
    pub duration_verified: bool,
}

/// Remuxes one file to a faststart layout and swaps it in.
///
/// Blocking: run this on a blocking task, not on a runtime worker.
pub fn convert_in_place(
    tools: &Tools,
    path: &Path,
    min_free_bytes: u64,
) -> Result<Converted, ConversionError> {
    let metadata = std::fs::metadata(path)?;
    let before_bytes = metadata.len();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));

    let available_bytes = fs2::available_space(parent)?;
    let needed_bytes = before_bytes.saturating_add(min_free_bytes);
    if available_bytes < needed_bytes {
        return Err(ConversionError::NotEnoughSpace {
            needed_bytes,
            available_bytes,
        });
    }

    let before = probe(tools, path);
    // The temporary file keeps the source extension so ffmpeg picks the same
    // muxer it would have used for the real name (`ipod` for m4a/m4b).
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    let token = work_token();
    let temp_path = parent.join(format!("{TEMP_PREFIX}{token}.{extension}"));
    let backup_path = parent.join(format!("{TEMP_PREFIX}backup-{token}"));

    let result = remux_and_swap(
        tools,
        path,
        &temp_path,
        &backup_path,
        before_bytes,
        before.as_ref(),
    );
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    // The backup only exists to survive a crash between the two renames; once
    // the swap has returned either way it is redundant.
    let _ = std::fs::remove_file(&backup_path);
    result
}

fn remux_and_swap(
    tools: &Tools,
    path: &Path,
    temp_path: &Path,
    backup_path: &Path,
    before_bytes: u64,
    before: Option<&MediaSummary>,
) -> Result<Converted, ConversionError> {
    let output = Command::new(&tools.ffmpeg)
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(path)
        // Audio and cover art are copied verbatim. Data tracks are left out on
        // purpose: an Audible-derived M4B carries its chapter list twice, once
        // as real chapters and once as a QuickTime `bin_data` text track that
        // the mp4/ipod muxer refuses to write back. `-map_chapters` rebuilds
        // that track from the chapter list, so nothing is lost.
        .arg("-map")
        .arg("0:a")
        .arg("-map")
        .arg("0:v?")
        .arg("-map_metadata")
        .arg("0")
        .arg("-map_chapters")
        .arg("0")
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg(temp_path)
        .output()?;
    if !output.status.success() {
        return Err(ConversionError::Remux {
            message: command_message(&output),
        });
    }

    let after_bytes = std::fs::metadata(temp_path)?.len();
    match inspect(temp_path)? {
        Layout::Faststart => {}
        layout => {
            return Err(ConversionError::Verification {
                message: format!("the converted file is not faststart ({layout:?})"),
            });
        }
    }
    let after = probe(tools, temp_path);
    verify(before_bytes, after_bytes, before, after.as_ref())?;

    // Preserve the original's permissions: the swapped-in file has to stay
    // readable by whoever could read the book before.
    if let Ok(metadata) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(temp_path, metadata.permissions());
    }

    // A hard link costs nothing and keeps the original content reachable if
    // the process dies during the rename below. Filesystems that refuse it
    // still get the atomic replace, just without the crash net.
    let linked = std::fs::hard_link(path, backup_path).is_ok();
    if let Err(error) = std::fs::rename(temp_path, path) {
        if linked && !path.exists() {
            let _ = std::fs::rename(backup_path, path);
        }
        return Err(ConversionError::Io(error));
    }

    Ok(Converted {
        before_bytes,
        after_bytes,
        duration_verified: before
            .and_then(|summary| summary.duration_seconds)
            .is_some()
            && after.and_then(|summary| summary.duration_seconds).is_some(),
    })
}

/// Rejects any remux that does not look like the same audiobook. The original
/// is only replaced once every check here passes.
fn verify(
    before_bytes: u64,
    after_bytes: u64,
    before: Option<&MediaSummary>,
    after: Option<&MediaSummary>,
) -> Result<(), ConversionError> {
    let reject = |message: String| Err(ConversionError::Verification { message });

    if after_bytes == 0 {
        return reject("the converted file was empty".to_string());
    }
    // A remux moves bytes around; it does not shed half the file. This catches
    // a truncated write that still parsed.
    if after_bytes < before_bytes / 2 {
        return reject(format!(
            "the converted file is {after_bytes} bytes against {before_bytes} in the original"
        ));
    }

    let (Some(before), Some(after)) = (before, after) else {
        // No ffprobe: the layout check in the caller plus the size floor is
        // all the evidence available.
        return Ok(());
    };

    if after.audio_streams != before.audio_streams {
        return reject(format!(
            "audio stream count changed from {} to {}",
            before.audio_streams, after.audio_streams
        ));
    }
    if after.video_streams < before.video_streams {
        return reject(format!(
            "cover art or video streams dropped from {} to {}",
            before.video_streams, after.video_streams
        ));
    }
    if after.chapters < before.chapters {
        return reject(format!(
            "chapter count dropped from {} to {}",
            before.chapters, after.chapters
        ));
    }
    if let (Some(before_duration), Some(after_duration)) =
        (before.duration_seconds, after.duration_seconds)
    {
        let tolerance = DURATION_TOLERANCE_SECONDS.max(before_duration * 0.005);
        if (before_duration - after_duration).abs() > tolerance {
            return reject(format!(
                "duration changed from {before_duration:.1}s to {after_duration:.1}s"
            ));
        }
    } else if before.duration_seconds.is_some() {
        return reject("the converted file reported no duration".to_string());
    }

    Ok(())
}

fn command_message(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = stderr.trim();
    if text.is_empty() {
        format!("exit status {}", output.status)
    } else {
        text.lines().last().unwrap_or(text).to_string()
    }
}

fn work_token() -> String {
    let mut bytes = [0_u8; 8];
    rand::rng().fill(&mut bytes);
    format!("{:016x}", u64::from_le_bytes(bytes))
}

/// Removes temporary and backup files a previous run left behind after a
/// crash. Only called with the conversion lock held, so anything matching is
/// known to be stale.
pub fn sweep_work_files(directory: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() && is_work_file(&path) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn box_bytes(kind: &[u8; 4], payload_len: usize) -> Vec<u8> {
        let size = (8 + payload_len) as u32;
        let mut bytes = size.to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend(std::iter::repeat_n(0_u8, payload_len));
        bytes
    }

    fn layout_of(bytes: Vec<u8>) -> Layout {
        let size = bytes.len() as u64;
        inspect_boxes(&mut Cursor::new(bytes), size).expect("inspection should not fail")
    }

    #[test]
    fn moov_before_mdat_is_faststart() {
        let mut bytes = box_bytes(b"ftyp", 16);
        bytes.extend(box_bytes(b"moov", 32));
        bytes.extend(box_bytes(b"mdat", 64));
        assert_eq!(layout_of(bytes), Layout::Faststart);
    }

    #[test]
    fn moov_after_mdat_needs_conversion() {
        let mut bytes = box_bytes(b"ftyp", 16);
        bytes.extend(box_bytes(b"free", 8));
        bytes.extend(box_bytes(b"mdat", 64));
        bytes.extend(box_bytes(b"moov", 32));
        assert_eq!(layout_of(bytes), Layout::Trailing);
    }

    #[test]
    fn sixty_four_bit_mdat_size_is_followed() {
        let mut bytes = box_bytes(b"ftyp", 16);
        // size == 1 means the real length follows the type as a u64.
        bytes.extend(1_u32.to_be_bytes());
        bytes.extend_from_slice(b"mdat");
        bytes.extend((16_u64 + 40).to_be_bytes());
        bytes.extend(std::iter::repeat_n(0_u8, 40));
        bytes.extend(box_bytes(b"moov", 24));
        assert_eq!(layout_of(bytes), Layout::Trailing);
    }

    #[test]
    fn a_file_without_moov_is_left_alone() {
        let mut bytes = box_bytes(b"ftyp", 16);
        bytes.extend(box_bytes(b"mdat", 64));
        assert_eq!(layout_of(bytes), Layout::Unknown);
    }

    #[test]
    fn non_mp4_bytes_are_left_alone() {
        let bytes = b"ID3\x04\x00\x00\x00\x00\x00\x00some mp3 payload".to_vec();
        assert_eq!(layout_of(bytes), Layout::Unknown);
    }

    #[test]
    fn a_truncated_box_is_left_alone() {
        let mut bytes = box_bytes(b"ftyp", 16);
        // Claims far more payload than the file actually holds.
        bytes.extend(4096_u32.to_be_bytes());
        bytes.extend_from_slice(b"mdat");
        bytes.extend(std::iter::repeat_n(0_u8, 16));
        assert_eq!(layout_of(bytes), Layout::Unknown);
    }

    #[test]
    fn a_zero_sized_box_runs_to_the_end() {
        let mut bytes = box_bytes(b"ftyp", 16);
        bytes.extend(0_u32.to_be_bytes());
        bytes.extend_from_slice(b"mdat");
        bytes.extend(std::iter::repeat_n(0_u8, 32));
        assert_eq!(layout_of(bytes), Layout::Unknown);
    }

    #[test]
    fn only_mp4_family_extensions_are_candidates() {
        assert!(is_mp4_file(Path::new("/books/one.m4b")));
        assert!(is_mp4_file(Path::new("/books/one.M4A")));
        assert!(is_mp4_file(Path::new("/books/one.mp4")));
        assert!(!is_mp4_file(Path::new("/books/one.mp3")));
        assert!(!is_mp4_file(Path::new("/books/one.flac")));
    }

    #[test]
    fn work_files_are_recognised() {
        assert!(is_work_file(Path::new(&format!(
            "/books/{TEMP_PREFIX}abc.m4b"
        ))));
        assert!(is_work_file(Path::new(&format!(
            "/books/{TEMP_PREFIX}backup-abc"
        ))));
        assert!(!is_work_file(Path::new("/books/real.m4b")));
    }

    #[test]
    fn verification_rejects_a_truncated_result() {
        let error = verify(1_000_000, 10_000, None, None).expect_err("should reject");
        assert!(matches!(error, ConversionError::Verification { .. }));
    }

    #[test]
    fn verification_rejects_lost_chapters() {
        let before = MediaSummary {
            duration_seconds: Some(3600.0),
            audio_streams: 1,
            video_streams: 1,
            chapters: 24,
        };
        let after = MediaSummary {
            chapters: 0,
            ..before
        };
        let error =
            verify(1_000_000, 990_000, Some(&before), Some(&after)).expect_err("should reject");
        assert!(matches!(error, ConversionError::Verification { .. }));
    }

    #[test]
    fn verification_rejects_a_changed_duration() {
        let before = MediaSummary {
            duration_seconds: Some(3600.0),
            audio_streams: 1,
            video_streams: 0,
            chapters: 0,
        };
        let after = MediaSummary {
            duration_seconds: Some(3400.0),
            ..before
        };
        let error =
            verify(1_000_000, 990_000, Some(&before), Some(&after)).expect_err("should reject");
        assert!(matches!(error, ConversionError::Verification { .. }));
    }

    #[test]
    fn verification_accepts_an_identical_remux() {
        let before = MediaSummary {
            duration_seconds: Some(3600.0),
            audio_streams: 1,
            video_streams: 1,
            chapters: 24,
        };
        let after = MediaSummary {
            duration_seconds: Some(3600.2),
            ..before
        };
        verify(1_000_000, 1_000_120, Some(&before), Some(&after)).expect("should accept");
    }

    /// Builds an M4B with the stream layout Audible-derived books actually
    /// have: AAC audio, the QuickTime `bin_data` chapter text track, embedded
    /// cover art, and real chapters.
    fn write_audiobook_fixture(tools: &Tools, path: &Path) {
        let metadata_path = path.with_extension("ffmetadata");
        std::fs::write(
            &metadata_path,
            ";FFMETADATA1\ntitle=Test Book\n\n\
             [CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=One\n\n\
             [CHAPTER]\nTIMEBASE=1/1000\nSTART=3000\nEND=6000\ntitle=Two\n",
        )
        .unwrap();
        let created = Command::new(&tools.ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=6",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=64x64:d=1",
                "-i",
            ])
            .arg(&metadata_path)
            .args([
                "-map",
                "0:a",
                "-map",
                "1:v",
                "-map_metadata",
                "2",
                "-c:a",
                "aac",
                "-c:v",
                "mjpeg",
                "-frames:v",
                "1",
                "-disposition:v",
                "attached_pic",
            ])
            .arg(path)
            .status()
            .expect("ffmpeg should run");
        assert!(created.success());
        std::fs::remove_file(metadata_path).unwrap();
    }

    /// The layout that first broke conversion: the mp4/ipod muxer cannot copy
    /// the `bin_data` chapter text track back, so it is dropped and rebuilt
    /// from the chapter list instead.
    #[test]
    fn a_book_with_a_chapter_text_track_and_cover_art_converts() {
        let Some(tools) = discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("book.m4b");
        write_audiobook_fixture(&tools, &book);

        let before = probe(&tools, &book).expect("ffprobe should describe the fixture");
        assert_eq!(before.chapters, 2);
        assert_eq!(before.video_streams, 1);
        assert_eq!(inspect(&book).unwrap(), Layout::Trailing);

        convert_in_place(&tools, &book, 0).expect("conversion should succeed");
        assert_eq!(inspect(&book).unwrap(), Layout::Faststart);

        let after = probe(&tools, &book).expect("ffprobe should describe the result");
        assert_eq!(after.chapters, before.chapters);
        assert_eq!(after.audio_streams, before.audio_streams);
        assert_eq!(after.video_streams, before.video_streams);
    }

    /// End to end against the real toolchain. Skipped where ffmpeg is not
    /// installed, since the feature is disabled there anyway.
    #[test]
    fn a_real_file_is_converted_in_place_and_keeps_its_audio() {
        let Some(tools) = discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("book.m4b");
        let created = Command::new(&tools.ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-c:a",
                "aac",
            ])
            .arg(&book)
            .status()
            .expect("ffmpeg should run");
        assert!(created.success());

        // ffmpeg writes a trailing moov unless asked for faststart.
        assert_eq!(inspect(&book).unwrap(), Layout::Trailing);
        let before = probe(&tools, &book);

        let converted = convert_in_place(&tools, &book, 0).expect("conversion should succeed");
        assert!(converted.after_bytes > 0);
        assert_eq!(inspect(&book).unwrap(), Layout::Faststart);

        if let (Some(before), Some(after)) = (before, probe(&tools, &book)) {
            assert!(converted.duration_verified);
            let (Some(before_duration), Some(after_duration)) =
                (before.duration_seconds, after.duration_seconds)
            else {
                panic!("both files should report a duration");
            };
            assert!((before_duration - after_duration).abs() < 0.1);
            assert_eq!(before.audio_streams, after.audio_streams);
        }

        // Nothing is left beside the book: the temporary remux was renamed
        // over it and the crash-safety hard link was dropped.
        let leftovers = std::fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| is_work_file(&entry.path()))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_full_volume_is_refused_before_anything_is_written() {
        let Some(tools) = discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("book.m4b");
        std::fs::write(&book, b"pretend audiobook").unwrap();

        let error = convert_in_place(&tools, &book, u64::MAX / 2).expect_err("should refuse");
        assert!(matches!(error, ConversionError::NotEnoughSpace { .. }));
        assert_eq!(std::fs::read(&book).unwrap(), b"pretend audiobook");
    }
}
