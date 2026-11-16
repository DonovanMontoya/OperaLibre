//! The audio work behind voice replacement: cutting clips out of a book for
//! the provider, finding pauses to cut at, and writing a chapter again with
//! replaced stretches spliced in.
//!
//! A chapter is rewritten as a stream of samples between two ffmpeg
//! processes, so memory stays flat however long it is.
use crate::*;
use std::{ffi::OsString, pin::Pin, process::Stdio};
use tokio::io::{AsyncRead, AsyncWrite};

const FFMPEG_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// One stretch of one audio file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Piece {
    pub(crate) path: PathBuf,
    /// Within the file.
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
}

/// The files a stretch of the book's timeline covers. A chapter may run
/// across files.
pub(crate) fn pieces(
    tracks: &[(PathBuf, f64)],
    start_seconds: f64,
    end_seconds: f64,
) -> Vec<Piece> {
    let mut pieces = Vec::new();
    let mut track_start = 0.0;
    for (path, duration) in tracks {
        let track_end = track_start + duration;
        let from = start_seconds.max(track_start);
        let to = end_seconds.min(track_end);
        if to - from > 0.001 {
            pieces.push(Piece {
                path: path.clone(),
                start_seconds: from - track_start,
                end_seconds: to - track_start,
            });
        }
        track_start = track_end;
    }
    pieces
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AudioFormat {
    pub(crate) sample_rate: u32,
    pub(crate) channels: u16,
    pub(crate) bit_rate: u32,
}

impl AudioFormat {
    fn frame_bytes(self) -> usize {
        usize::from(self.channels) * 2
    }

    fn frames(self, seconds: f64) -> u64 {
        (seconds.max(0.0) * f64::from(self.sample_rate)).round() as u64
    }
}

/// How the book's audio is stored, so a rewritten chapter matches the ones
/// copied beside it. Without ffprobe, a format every player handles.
pub(crate) async fn probe(tools: &faststart::Tools, path: &FsPath) -> AudioFormat {
    let fallback = AudioFormat {
        sample_rate: 44_100,
        channels: 2,
        bit_rate: 128_000,
    };
    let Some(ffprobe) = &tools.ffprobe else {
        return fallback;
    };
    let output = Command::new(ffprobe)
        .kill_on_drop(true)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels,bit_rate",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .await;
    let Ok(output) = output else {
        return fallback;
    };
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    let stream = &value["streams"][0];
    let number = |name: &str| {
        stream[name]
            .as_u64()
            .or_else(|| stream[name].as_str()?.parse().ok())
    };
    AudioFormat {
        sample_rate: number("sample_rate")
            .map(|rate| rate as u32)
            .filter(|rate| (8_000..=96_000).contains(rate))
            .unwrap_or(fallback.sample_rate),
        channels: number("channels")
            .map(|channels| channels.clamp(1, 2) as u16)
            .unwrap_or(fallback.channels),
        bit_rate: number("bit_rate")
            .map(|rate| rate.clamp(48_000, 256_000) as u32)
            .unwrap_or(fallback.bit_rate),
    }
}

fn base_command(ffmpeg: &FsPath) -> Command {
    let mut command = Command::new(ffmpeg);
    command
        .kill_on_drop(true)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    command
}

/// Inputs for `pieces`, joined end to end into one audio stream labelled
/// `[a]`, with `filter` applied to it when given.
fn source_args(pieces: &[Piece], filter: Option<&str>) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for piece in pieces {
        args.push("-ss".into());
        args.push(format!("{:.3}", piece.start_seconds).into());
        args.push("-t".into());
        args.push(format!("{:.3}", piece.end_seconds - piece.start_seconds).into());
        args.push("-i".into());
        args.push(piece.path.as_os_str().into());
    }
    let mut graph: String = (0..pieces.len())
        .map(|input| format!("[{input}:a:0]"))
        .collect();
    graph.push_str(&format!("concat=n={}:v=0:a=1", pieces.len()));
    if let Some(filter) = filter {
        graph.push(',');
        graph.push_str(filter);
    }
    graph.push_str("[a]");
    args.push("-filter_complex".into());
    args.push(graph.into());
    args.push("-map".into());
    args.push("[a]".into());
    args
}

async fn run(mut command: Command, doing: &str) -> anyhow::Result<std::process::Output> {
    let output = tokio::time::timeout(FFMPEG_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow::anyhow!("ffmpeg took too long to {doing}."))?
        .map_err(|error| anyhow::anyhow!("Could not run ffmpeg to {doing}: {error}"))?;
    anyhow::ensure!(
        output.status.success(),
        "ffmpeg could not {doing}: {}",
        text_tail(&String::from_utf8_lossy(&output.stderr), 600)
    );
    Ok(output)
}

/// A mono clip of the book for the provider or for listening to in the app.
/// The container follows `output`'s extension; FLAC and WAV need nothing
/// beyond ffmpeg itself.
pub(crate) async fn extract_clip(
    ffmpeg: &FsPath,
    pieces: &[Piece],
    output: &FsPath,
    sample_rate: u32,
) -> anyhow::Result<()> {
    anyhow::ensure!(!pieces.is_empty(), "That part of the book has no audio.");
    let mut command = base_command(ffmpeg);
    command
        .args(source_args(pieces, None))
        .args(["-ac", "1", "-ar"])
        .arg(sample_rate.to_string())
        .arg(output);
    run(command, "cut a clip from the book").await?;
    Ok(())
}

/// The filter that keeps only `stretches` of the audio it is given and closes
/// the gaps between them. Times are from the start of that audio. One input
/// is read once however many stretches there are: opening a long book once
/// per stretch would hold its whole index in memory each time.
fn only_filter(stretches: &[(f64, f64)]) -> String {
    let kept = stretches
        .iter()
        .map(|(start, end)| format!("between(t,{start:.3},{end:.3})"))
        .collect::<Vec<_>>()
        .join("+");
    // Small frames, so a stretch is cut to within a millisecond or two.
    format!("aresample=44100,asetnsamples=n=64:p=0,aselect='{kept}',asetpts=N/SR/TB")
}

/// A mono clip of only `stretches` of `pieces`, end to end. Times are from
/// the start of `pieces`.
pub(crate) async fn extract_stretches(
    ffmpeg: &FsPath,
    pieces: &[Piece],
    stretches: &[(f64, f64)],
    output: &FsPath,
    sample_rate: u32,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !pieces.is_empty() && !stretches.is_empty(),
        "That part of the book has no audio."
    );
    let mut command = base_command(ffmpeg);
    command
        .args(source_args(pieces, Some(&only_filter(stretches))))
        .args(["-ac", "1", "-ar"])
        .arg(sample_rate.to_string())
        .arg(output);
    run(command, "cut a clip from the book").await?;
    Ok(())
}

/// Pauses in the audio, as times from the start of `pieces`.
pub(crate) async fn silences(ffmpeg: &FsPath, pieces: &[Piece]) -> anyhow::Result<Vec<(f64, f64)>> {
    let mut command = Command::new(ffmpeg);
    command
        .kill_on_drop(true)
        .args(["-nostdin", "-hide_banner", "-loglevel", "info", "-nostats"])
        .args(source_args(pieces, Some("silencedetect=noise=-35dB:d=0.3")))
        .args(["-f", "null", "-"]);
    let output = run(command, "look for pauses").await?;
    Ok(parse_silences(&String::from_utf8_lossy(&output.stderr)))
}

fn parse_silences(log: &str) -> Vec<(f64, f64)> {
    let value_after = |line: &str, label: &str| -> Option<f64> {
        let rest = &line[line.find(label)? + label.len()..];
        rest.split_whitespace().next()?.parse().ok()
    };
    let mut found = Vec::new();
    let mut open = None;
    for line in log.lines() {
        if let Some(start) = value_after(line, "silence_start:") {
            open = Some(start.max(0.0));
        } else if let (Some(end), Some(start)) = (value_after(line, "silence_end:"), open.take())
            && end > start
        {
            found.push((start, end));
        }
    }
    found
}

/// How loud audio is on average, in decibels below full.
async fn mean_level(ffmpeg: &FsPath, input: Vec<OsString>) -> Option<f64> {
    let mut command = Command::new(ffmpeg);
    command
        .kill_on_drop(true)
        .args(["-nostdin", "-hide_banner", "-loglevel", "info", "-nostats"])
        .args(input)
        .args(["-f", "null", "-"]);
    let output = run(command, "measure how loud a clip is").await.ok()?;
    parse_mean_level(&String::from_utf8_lossy(&output.stderr))
}

fn parse_mean_level(log: &str) -> Option<f64> {
    let label = "mean_volume:";
    let rest = &log[log.rfind(label)? + label.len()..];
    rest.split_whitespace().next()?.parse().ok()
}

/// The gain that brings `clip` to the loudness of the stretch of the book it
/// replaces, so a new voice does not sit quieter or louder than the voices
/// around it. Nothing when either cannot be measured. With `only`, the clip
/// replaces just those stretches of `pieces`, and they are what is measured.
pub(crate) async fn matching_gain(
    ffmpeg: &FsPath,
    pieces: &[Piece],
    only: &[(f64, f64)],
    clip: &FsPath,
    format: AudioFormat,
) -> f64 {
    // Both are measured as they will be written: a mono clip loses three
    // decibels on its way into a stereo book.
    let measure = match format.channels {
        1 => "aformat=channel_layouts=mono,volumedetect",
        2 => "aformat=channel_layouts=stereo,volumedetect",
        _ => "volumedetect",
    };
    let original = if only.is_empty() {
        mean_level(ffmpeg, source_args(pieces, Some(measure))).await
    } else {
        let measured = format!("{},{measure}", only_filter(only));
        mean_level(ffmpeg, source_args(pieces, Some(&measured))).await
    };
    let replacement = mean_level(
        ffmpeg,
        vec!["-i".into(), clip.into(), "-af".into(), measure.into()],
    )
    .await;
    match (original, replacement) {
        (Some(wanted), Some(mean)) => gain_between(wanted, mean),
        _ => 0.0,
    }
}

fn gain_between(wanted_mean: f64, mean: f64) -> f64 {
    let gain = (wanted_mean - mean).clamp(-12.0, 12.0);
    // Too small to hear is not worth another filter in the chain.
    if gain.abs() < 0.5 { 0.0 } else { gain }
}

/// The filter that applies a gain. A generated voice often peaks at full
/// level while averaging quieter than a studio recording, so a raised clip
/// has its few loudest moments held back instead of clipping.
fn gain_filter(gain_db: f64) -> String {
    if gain_db > 0.0 {
        format!("volume={gain_db:.2}dB,alimiter=limit=0.9:level=false")
    } else {
        format!("volume={gain_db:.2}dB")
    }
}

/// Cuts `length` seconds into windows no longer than `max_seconds`, each cut
/// in the middle of the latest pause that keeps its window at least half
/// full. With no such pause, the cut falls where the window ends.
pub(crate) fn windows(length: f64, max_seconds: f64, silences: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut cuts = vec![0.0];
    let mut cursor = 0.0;
    while length - cursor > max_seconds {
        let cut = silences
            .iter()
            .map(|(start, end)| (start + end) / 2.0)
            .rfind(|middle| *middle > cursor + max_seconds / 2.0 && *middle <= cursor + max_seconds)
            .unwrap_or(cursor + max_seconds);
        cuts.push(cut);
        cursor = cut;
    }
    cuts.push(length);
    cuts.windows(2).map(|pair| (pair[0], pair[1])).collect()
}

/// What is left of `length` seconds once pauses of `min_pause` or longer are
/// taken out: the stretches with sound in them, each keeping `pad` seconds of
/// the quiet on either side. `min_pause` is more than twice `pad`, so no two
/// stretches meet.
pub(crate) fn spoken(
    length: f64,
    silences: &[(f64, f64)],
    min_pause: f64,
    pad: f64,
) -> Vec<(f64, f64)> {
    let mut found = Vec::new();
    let mut sound_from = 0.0_f64;
    for &(start, end) in silences {
        let start = start.clamp(0.0, length);
        let end = end.clamp(0.0, length);
        if end - start < min_pause {
            continue;
        }
        if start - sound_from > 0.01 {
            found.push(((sound_from - pad).max(0.0), start + pad));
        }
        sound_from = end;
    }
    if length - sound_from > 0.01 {
        found.push(((sound_from - pad).max(0.0), length));
    }
    found
}

/// Gathers stretches, in order, into batches that each hold no more than
/// `max_seconds` of audio. A stretch longer than that is cut first.
pub(crate) fn batches(stretches: &[(f64, f64)], max_seconds: f64) -> Vec<Vec<(f64, f64)>> {
    let mut found: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut held = 0.0;
    for &(start, end) in stretches {
        let mut from = start;
        while end - from > 0.0005 {
            let to = end.min(from + max_seconds);
            if found.is_empty() || held + (to - from) > max_seconds {
                found.push(Vec::new());
                held = 0.0;
            }
            if let Some(batch) = found.last_mut() {
                batch.push((from, to));
            }
            held += to - from;
            from = to;
        }
    }
    found
}

pub(crate) struct Tags<'a> {
    pub(crate) title: &'a str,
    pub(crate) album: &'a str,
    pub(crate) author: Option<&'a str>,
    pub(crate) track: usize,
    pub(crate) track_count: usize,
}

fn tag_args(tags: &Tags<'_>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "-map_metadata".into(),
        "-1".into(),
        "-map_chapters".into(),
        "-1".into(),
    ];
    let mut tag = |name: &str, value: &str| {
        args.push("-metadata".into());
        args.push(format!("{name}={value}").into());
    };
    tag("title", tags.title);
    tag("album", tags.album);
    tag("track", &format!("{}/{}", tags.track, tags.track_count));
    if let Some(author) = tags.author {
        tag("artist", author);
        tag("album_artist", author);
    }
    args
}

/// Whether a chapter of this file can be copied out without re-encoding, and
/// the extension the copy takes.
pub(crate) fn copy_extension(source: &FsPath) -> Option<&'static str> {
    match source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("m4b" | "m4a" | "mp4") => Some("m4a"),
        Some("mp3") => Some("mp3"),
        _ => None,
    }
}

/// An untouched chapter, copied bit for bit into its own file.
pub(crate) async fn copy_section(
    ffmpeg: &FsPath,
    piece: &Piece,
    output: &FsPath,
    tags: &Tags<'_>,
) -> anyhow::Result<()> {
    let mut command = base_command(ffmpeg);
    command
        .arg("-ss")
        .arg(format!("{:.3}", piece.start_seconds))
        .arg("-t")
        .arg(format!("{:.3}", piece.end_seconds - piece.start_seconds))
        .arg("-i")
        .arg(&piece.path)
        .args(["-map", "0:a:0", "-c", "copy"])
        .args(tag_args(tags));
    if output
        .extension()
        .is_some_and(|extension| extension == "m4a")
    {
        command.args(["-movflags", "+faststart"]);
    }
    command.arg(output);
    run(command, "copy a chapter").await?;
    Ok(())
}

/// Puts the source's cover picture on a finished file, so the copy has the
/// book's cover. Without one, or when it does not fit, the file stays as is.
pub(crate) async fn attach_cover(ffmpeg: &FsPath, source: &FsPath, file: &FsPath) {
    let Some(extension) = file.extension().and_then(|extension| extension.to_str()) else {
        return;
    };
    let covered = file.with_extension(format!("cover.{extension}"));
    let mut command = base_command(ffmpeg);
    command
        .arg("-i")
        .arg(file)
        .arg("-i")
        .arg(source)
        .args([
            "-map",
            "0:a",
            "-map",
            "1:v:0",
            "-c",
            "copy",
            "-map_metadata",
            "0",
            // Or the first chapter's file would carry the whole book's marks.
            "-map_chapters",
            "-1",
        ])
        .args(["-disposition:v:0", "attached_pic"]);
    if extension == "m4a" {
        command.args(["-movflags", "+faststart"]);
    }
    command.arg(&covered);
    if run(command, "add the cover").await.is_ok() {
        let _ = fs::rename(&covered, file).await;
    } else {
        let _ = fs::remove_file(&covered).await;
    }
}

/// Audio that takes the place of a stretch of a chapter.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Insert {
    /// From the start of the chapter.
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
    pub(crate) clips: Vec<PathBuf>,
    /// Hold the replaced stretch's exact length, trimming or padding the
    /// clips. A changed voice keeps the original timing; newly spoken text
    /// runs as long as it runs.
    pub(crate) fit: bool,
    /// Decibels to raise the clips by, or lower them with a negative number.
    pub(crate) gain_db: f64,
    /// Its clip is the one the insert before it was reading, carried on from
    /// where that stopped. One clip made from several stretches of the book,
    /// with the pauses between them left out, goes back in this way.
    pub(crate) continues: bool,
}

type Pcm = Pin<Box<dyn AsyncRead + Send>>;

/// A decoder's output that stops the decoder when dropped.
struct ChildPcm {
    _child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
}

impl AsyncRead for ChildPcm {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(context, buffer)
    }
}

fn decode(mut command: Command, format: AudioFormat) -> anyhow::Result<Pcm> {
    command
        .args(["-f", "s16le", "-ac"])
        .arg(format.channels.to_string())
        .arg("-ar")
        .arg(format.sample_rate.to_string())
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("stdout was piped");
    Ok(Box::pin(ChildPcm {
        _child: child,
        stdout,
    }))
}

/// A chapter written again with `inserts` in place of what they cover.
pub(crate) async fn splice_section(
    ffmpeg: &FsPath,
    pieces: &[Piece],
    inserts: &[Insert],
    format: AudioFormat,
    output: &FsPath,
    tags: &Tags<'_>,
) -> anyhow::Result<()> {
    anyhow::ensure!(!pieces.is_empty(), "That chapter has no audio.");
    let mut source = base_command(ffmpeg);
    source.args(source_args(pieces, None));
    let original = decode(source, format)?;

    let mut encoder = base_command(ffmpeg);
    encoder
        .args(["-f", "s16le", "-ac"])
        .arg(format.channels.to_string())
        .arg("-ar")
        .arg(format.sample_rate.to_string())
        .args(["-i", "-", "-c:a", "aac", "-b:a"])
        .arg(format.bit_rate.to_string())
        .args(tag_args(tags))
        .args(["-movflags", "+faststart"])
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut encoder = encoder.spawn()?;
    let mut stdin = encoder.stdin.take().expect("stdin was piped");
    let spliced = splice(original, &mut stdin, format, inserts, |clip, gain_db| {
        let mut command = base_command(ffmpeg);
        command.arg("-i").arg(clip).args(["-map", "0:a:0"]);
        if gain_db != 0.0 {
            command.arg("-af").arg(gain_filter(gain_db));
        }
        decode(command, format)
    })
    .await;
    // Closing its input is what lets the encoder finish the file.
    drop(stdin);
    let finished = tokio::time::timeout(FFMPEG_TIMEOUT, encoder.wait_with_output())
        .await
        .map_err(|_| anyhow::anyhow!("ffmpeg took too long to write a chapter."))??;
    spliced?;
    anyhow::ensure!(
        finished.status.success(),
        "ffmpeg could not write a chapter: {}",
        text_tail(&String::from_utf8_lossy(&finished.stderr), 600)
    );
    Ok(())
}

/// Copies `original` to `out`, swapping each insert's stretch for its clips.
/// Inserts are in order and do not overlap.
async fn splice<W, F>(
    mut original: Pcm,
    out: &mut W,
    format: AudioFormat,
    inserts: &[Insert],
    open_clip: F,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
    F: Fn(&FsPath, f64) -> anyhow::Result<Pcm>,
{
    let frame = format.frame_bytes() as u64;
    let mut position = 0u64;
    // The clip last read, for an insert that carries on with it.
    let mut carried: Option<Pcm> = None;
    for insert in inserts {
        let start = format.frames(insert.start_seconds).max(position);
        let end = format.frames(insert.end_seconds).max(start);
        let kept = pump(
            &mut original,
            Some(&mut *out),
            Some((start - position) * frame),
        )
        .await?;
        if kept < (start - position) * frame {
            // The audio ended before this insert's place.
            return Ok(());
        }
        let room = (end - start) * frame;
        let mut written = 0u64;
        for clip in &insert.clips {
            let limit = insert.fit.then(|| room - written);
            let mut clip = match carried.take() {
                Some(open) if insert.continues => open,
                _ => open_clip(clip, insert.gain_db)?,
            };
            let copied = pump(&mut clip, Some(&mut *out), limit).await?;
            // A clip ends on a whole sample or the channels would swap.
            let stray = copied % frame;
            if stray != 0 {
                out.write_all(&vec![0u8; (frame - stray) as usize]).await?;
            }
            written += copied + (frame - stray) % frame;
            carried = Some(clip);
        }
        if insert.fit && written < room {
            pump(
                &mut tokio::io::repeat(0),
                Some(&mut *out),
                Some(room - written),
            )
            .await?;
        }
        pump(&mut original, None::<&mut W>, Some(room)).await?;
        position = end;
    }
    pump(&mut original, Some(out), None).await?;
    Ok(())
}

/// Moves up to `limit` bytes from `from`, to `to` or nowhere. Returns how
/// many there were.
async fn pump<R, W>(from: &mut R, mut to: Option<&mut W>, limit: Option<u64>) -> anyhow::Result<u64>
where
    R: AsyncRead + Unpin + ?Sized,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; 64 * 1024];
    let mut moved = 0u64;
    loop {
        let want = match limit {
            Some(limit) => (limit - moved).min(buffer.len() as u64) as usize,
            None => buffer.len(),
        };
        if want == 0 {
            return Ok(moved);
        }
        let read = from.read(&mut buffer[..want]).await?;
        if read == 0 {
            return Ok(moved);
        }
        if let Some(to) = to.as_mut() {
            to.write_all(&buffer[..read]).await?;
        }
        moved += read as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_follow_a_stretch_across_files() {
        let tracks = vec![
            (PathBuf::from("a.m4b"), 100.0),
            (PathBuf::from("b.m4b"), 100.0),
        ];
        let found = pieces(&tracks, 80.0, 150.0);
        let spans: Vec<(&str, f64, f64)> = found
            .iter()
            .map(|piece| {
                (
                    piece.path.to_str().unwrap(),
                    piece.start_seconds,
                    piece.end_seconds,
                )
            })
            .collect();
        assert_eq!(spans, [("a.m4b", 80.0, 100.0), ("b.m4b", 0.0, 50.0)]);
        assert!(pieces(&tracks, 200.0, 260.0).is_empty());
    }

    #[test]
    fn a_new_voice_is_brought_to_the_level_of_the_one_it_replaces() {
        let log = "[Parsed_volumedetect_0 @ 0x1] n_samples: 882000\n\
                   [Parsed_volumedetect_0 @ 0x1] mean_volume: -27.4 dB\n\
                   [Parsed_volumedetect_0 @ 0x1] max_volume: -8.1 dB\n";
        assert_eq!(parse_mean_level(log), Some(-27.4));
        assert_eq!(parse_mean_level("no audio here"), None);
        // Quieter than the original: raised to meet it, with its peaks held.
        assert_eq!(gain_between(-21.0, -27.0), 6.0);
        assert!(gain_filter(6.0).contains("alimiter"));
        // Louder is lowered, a wild difference is held back, a small one left.
        assert_eq!(gain_between(-27.0, -21.0), -6.0);
        assert_eq!(gain_filter(-6.0), "volume=-6.00dB");
        assert_eq!(gain_between(-10.0, -40.0), 12.0);
        assert_eq!(gain_between(-21.0, -21.3), 0.0);
    }

    #[test]
    fn pauses_are_read_from_ffmpeg_and_windows_cut_inside_them() {
        let log = "[silencedetect @ 0x1] silence_start: 99.5\n\
                   [silencedetect @ 0x1] silence_end: 100.5 | silence_duration: 1\n\
                   [silencedetect @ 0x1] silence_start: 230\n\
                   [silencedetect @ 0x1] silence_end: 231 | silence_duration: 1\n\
                   [silencedetect @ 0x1] silence_start: 500\n";
        let found = parse_silences(log);
        assert_eq!(found, [(99.5, 100.5), (230.0, 231.0)]);
        // The first cut takes the later pause; nothing after it has one, so
        // the rest is cut by length.
        assert_eq!(
            windows(700.0, 270.0, &found),
            [(0.0, 230.5), (230.5, 500.5), (500.5, 700.0)]
        );
        assert_eq!(windows(120.0, 270.0, &found), [(0.0, 120.0)]);
    }

    #[test]
    fn long_pauses_are_left_out_and_what_is_said_is_gathered_into_requests() {
        let pauses = [(0.0, 1.0), (4.0, 4.2), (6.0, 8.0), (19.0, 20.0)];
        // The short pause stays inside its stretch. The long ones go, each
        // leaving a little of its quiet on the stretches around it.
        let kept = spoken(20.0, &pauses, 0.5, 0.1);
        assert_eq!(kept, [(0.9, 6.1), (7.9, 19.1)]);
        assert_eq!(spoken(5.0, &[], 0.5, 0.1), [(0.0, 5.0)]);
        assert!(spoken(5.0, &[(0.0, 5.0)], 0.5, 0.1).is_empty());

        assert_eq!(
            batches(&[(0.0, 4.0), (5.0, 9.0), (10.0, 13.0)], 8.0),
            [vec![(0.0, 4.0), (5.0, 9.0)], vec![(10.0, 13.0)]]
        );
        // A stretch too long for one request is cut.
        assert_eq!(
            batches(&[(0.0, 20.0)], 8.0),
            [vec![(0.0, 8.0)], vec![(8.0, 16.0)], vec![(16.0, 20.0)]]
        );
    }

    /// Mono 16-bit audio at ten samples a second, each sample carrying `value`.
    fn tone(samples: usize, value: i16) -> Vec<u8> {
        std::iter::repeat_n(value.to_le_bytes(), samples)
            .flatten()
            .collect()
    }

    #[tokio::test]
    async fn inserts_replace_their_stretch_and_keep_or_change_its_length() {
        let format = AudioFormat {
            sample_rate: 10,
            channels: 1,
            bit_rate: 64_000,
        };
        let clips: HashMap<&str, Vec<u8>> = HashMap::from([
            ("short", tone(5, 2)),
            ("long", tone(30, 3)),
            // Half a sample too many, as a damaged decode might leave.
            ("ragged", [tone(4, 4), vec![9]].concat()),
            // Twenty samples that count up from ten.
            (
                "counted",
                (10..30i16).flat_map(i16::to_le_bytes).collect::<Vec<u8>>(),
            ),
        ]);
        let run = |inserts: Vec<Insert>| {
            let clips = clips.clone();
            async move {
                let original: Pcm = Box::pin(std::io::Cursor::new(tone(100, 1)));
                let mut out = Vec::new();
                splice(original, &mut out, format, &inserts, |clip, _| {
                    let bytes = clips[clip.to_str().unwrap()].clone();
                    Ok(Box::pin(std::io::Cursor::new(bytes)) as Pcm)
                })
                .await
                .unwrap();
                out.chunks(2)
                    .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
                    .collect::<Vec<_>>()
            }
        };
        let insert = |start: f64, end: f64, clip: &str, fit: bool| Insert {
            start_seconds: start,
            end_seconds: end,
            clips: vec![PathBuf::from(clip)],
            fit,
            gain_db: 0.0,
            continues: false,
        };

        // A fitted clip that runs short is padded and one that runs long is
        // trimmed, so everything after stays where it was.
        let fitted = run(vec![
            insert(1.0, 2.0, "short", true),
            insert(5.0, 6.0, "long", true),
        ])
        .await;
        assert_eq!(fitted.len(), 100);
        assert_eq!(&fitted[8..22], [1, 1, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 1, 1]);
        assert_eq!(&fitted[48..62], [1, 1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1]);

        // Newly spoken text takes the time it takes.
        let free = run(vec![insert(1.0, 2.0, "long", false)]).await;
        assert_eq!(free.len(), 120);
        assert_eq!(free[9..11], [1, 3]);
        assert_eq!(free[39..41], [3, 1]);

        // A clip never leaves the samples after it misaligned.
        let ragged = run(vec![insert(0.0, 1.0, "ragged", false)]).await;
        assert_eq!(ragged.len(), 95);
        assert_eq!(&ragged[..6], [4, 4, 4, 4, 9, 1]);

        // One clip made from two stretches goes back into both, the second
        // carrying on where the first stopped, with the pause between them
        // left as it was.
        let carried = run(vec![
            insert(1.0, 2.0, "counted", true),
            Insert {
                continues: true,
                ..insert(5.0, 6.0, "counted", true)
            },
        ])
        .await;
        assert_eq!(carried.len(), 100);
        assert_eq!(
            &carried[9..21],
            [1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 1]
        );
        assert_eq!(
            &carried[49..61],
            [1, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 1]
        );

        // An insert past the end of the audio changes nothing.
        assert_eq!(
            run(vec![insert(20.0, 21.0, "short", true)]).await,
            vec![1; 100]
        );
    }
}
