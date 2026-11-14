# Native streaming benchmark

This standalone simulator app compares faststart M4A with an experimental bundled
HLS transport, the server's compact MP4 index, or native packet transport, using
the repository's current `AudiobookPlayer.swift` and `PacketAudioAsset.swift`.
Generated audio is the default; `--source` copies a chosen file into scratch state.

Requires an Apple Silicon Mac, Xcode with an iOS simulator, Python 3, Node 22+,
and ffmpeg on PATH. From the repository root:

```sh
python3 script/performance/streaming/fixture.py prepare /tmp/streaming-run
node script/performance/streaming/server.mjs /tmp/streaming-run
```

Keep that terminal running. In another terminal:

```sh
python3 script/performance/streaming/fixture.py build /tmp/streaming-run
xcrun simctl install booted /tmp/streaming-run/StreamingBench.app
```

Open **StreamingBench** on that simulator and tap **Run native streaming tests**.
When using T3, open the simulator with `device_open` and use its returned bound
CLI for app launch, taps, and screenshots. Wait for completion, then:

```sh
node script/performance/streaming/report.mjs /tmp/streaming-run/results.json
```

Stop the fixture server with Ctrl-C. Every run needs a new output directory;
the server refuses to overwrite results. `--duration 120 --pairs 1` on `prepare`
is a quick functional smoke test, not comparable performance evidence. The
standard run uses a two-hour file and five pairs per scenario (40 samples).

## What is measured

The fixture repeats seeded, 30-second mono AAC noise at nominal 64 kbps. The
baseline is faststart M4A. The candidate is one-second fragmented MP4 HLS, with
its full playlist, initialization segment, and opening fragments delivered in
one gzip JSON/base64 response. A test-only loopback proxy serves that bundle to
AVPlayer and forwards subsequent fragment requests. Resume selection uses
playlist timestamps, including a preceding and following fragment.

Each sample has a fresh URL, player, and candidate proxy. Pair order alternates.
The server imposes 40 ms before each response and a shared per-sample byte pace
of 40 or 4 Mbps. This is an application-level pacing model, not a WAN emulator:
it does not model loss, TLS, radio, server contention, or TCP congestion.

Timing begins before bundle acquisition/listener setup (or baseline load).
`startMs` measures AVPlayer's playing state; `firstAdvanceMs` measures its clock
moving at least 1 ms beyond the requested position. `advanceMs` waits for 150 ms
of progress. None measures acoustic onset. Pause, seek, resumed clock movement,
and recovery-checkpoint assertions must pass. Errors, incomplete scenarios,
duplicate samples, and samples without recorded remote bytes fail reporting.

Fixtures and HLS derivatives are prepared **before** timing. OS filesystem
caches are not flushed. Startup at zero and resume halfway through are tested;
this does not measure on-demand transcoding or cold derivative generation.
`fixture.json` records encoder/version and encoded packet hash; `build.json`
records Xcode, Git commit, and the production player source hash. Retain both
alongside `results.json`, which includes per-request byte/range accounting.
Results record simulator model/OS. Record host load when sharing results.
Byte accounting covers the entire sample, including its later seek, rather than
only the startup interval.

## Interpretation limits

Encoded packet hashes must agree, but this does **not** prove decoded timeline
identity. The original experiment observed a roughly 48 ms native duration
difference between M4A and HLS. The report prints observed durations; pause and
seek checks only establish each transport's own clock behavior. Do not treat
this benchmark as a production playback correctness gate or claim a universal
speedup from this synthetic file.

Production adoption requires timeline alignment, authenticated delivery,
failure fallback, stable playback-source identity, native recovery/lifecycle
integration, bounded resource handling, and broader real-book/device tests.
The proxy is deliberately a fixture-only implementation with no production
session or authorization integration. Its local server URL is compiled only
into the disposable benchmark app.

Run portable harness tests with:

```sh
node --test script/performance/streaming/server.test.mjs
```

## Compact MP4 indexes

Pass `--transport compact` to `fixture.py prepare` to compare ordinary faststart
with the server's compact sample-size table. This also requires Rust 1.89+.
Preparation compiles `apps/server/src/compact_audio.rs`, applies it to the fixture,
and verifies that the full decoded audio hashes agree. Build and run with the
same commands above. The build metadata records the compactor source hash.

The compact representation keeps timing tables, edit lists, and encoded audio,
and omits embedded cover art that the native player receives separately.
The index is prepared before measurement, matching a server cache hit; this does
not measure the server's initial index preparation, authentication, or disk I/O.
Keep these limits separate from a complete app tap-to-audio measurement.

Add `--embedded-cover` to prepare a seeded JPEG inside the MP4. This run also
requires the player to display separately supplied artwork after playback and
seek checks. The artwork check is outside the timed startup interval.

To compare two versions of the compactor, pass `--baseline-compactor /path/to/compact_audio.rs`
alongside `--transport compact`. Preparation applies both versions to the same
source, saves their exact source snapshots and hashes, and serves the baseline
as `flat.m4a`. The result config identifies which baseline was used.

## Native packet transport

Use `--transport packet` to prepare the server's virtual constant-packet MP4.
The HTTP fixture sends compressed bootstrap and bounded range windows through
the production native resource loader. It materializes a padded scratch file
for repeatable pacing; the production server generates windows directly from
the source without writing a derivative. Source construction and cache misses
are outside the fixture timing and must be measured separately.

`--continuous` encodes the full noise duration rather than looping a short seed.
`--source /path/book.m4b` copies real audio and derives its duration; protect the
scratch directory and do not publish private fixtures. `--rate 1.5 --gain 2`
exercises native time stretching and volume boost. The packet and compact modes
check full decoded FFmpeg hashes and skip generating unused HLS fragments.
For packet transport, AAC packet padding changes encoded-packet hashes; decoded
PCM equality, native priming, duration, and seeks must be checked separately.
Embedded chapter tracks can extend the original container slightly beyond its
audio; compare the audio frames as well as presentation duration.

For native failover checks, set `packetFailure` in a fresh fixture's JSON to
`unsupported` (bootstrap 404) or `revision` (range 409). The ordinary stream
remains available. These are functional checks: require the original resume
position, pause/seek/checkpoint assertions, and configured rate/boost to survive;
they are not speed measurements. Results record the failed request status.
