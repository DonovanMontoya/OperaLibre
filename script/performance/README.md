# OperaLibre performance checks

This suite exercises production code and records repeatable workloads before an optimization.
Behavior assertions fail the command. Timings are observations, not CI speed limits.
No production server, account, library, or device installation is used.

## Run

From the repository root, after `npm ci`:

```sh
npx playwright install chromium webkit
npm run test:perf -- --label before       # web unit tests, real browser UI, real server router
npm run test:perf:ios -- --label native-before  # macOS + Xcode + installed iOS Simulator runtime
# Or all three, sequentially on a Mac:
npm run test:perf:all -- --label baseline
```

`test:perf:web` and `test:perf:server` run individual portions. Labels must be new;
existing baselines are never overwritten. Without a label, the runner uses a timestamp.
`PERF_BOOKS=2000 npm run test:perf -- --label large` changes web and server library sizes
(defaults: 1,000 web books, 200 server books; valid range 20–10,000).
The Rust fixture creates two small real WAV files per book in a temporary directory;
10,000 server books need roughly 3.2 GB of temporary space.

Results are under `output/performance/runs/<label>/` (gitignored):

- `run.json`: source revision, environment/tool versions, workload, check status, completion marker.
- `browser-results.json`: browser measurements and assertions; failure screenshots/traces in `browser/`.
- `server.json`: warmed samples, median/p95 handler time and full response sizes.
- `ios/*.xcresult`: native XCTest results, CPU/wall-clock/memory measurements.
- `ios/summary.json` and `ios/metrics.json`: native results exported for scripting.

Browser preview binds only to `127.0.0.1:4179` and refuses to reuse an existing server.
The iOS runner creates and deletes its own simulator and test-only Xcode project, compiling
`NativeAudio.swift`, `BackgroundDownloads.swift`, and `BackgroundDownloadPolicy.swift` directly.
It does not edit or install the shipping app. It selects an available iOS runtime; use
`PERF_IOS_DEVICE_TYPE` with a compatible simctl device type identifier to choose a model.
Generated projects and DerivedData stay with that run for investigation.
The first native build needs network access for the same pinned Capacitor Swift package as the app.

## Compare

```sh
# Make the optimization, then use the same machine, workload and commands.
npm run test:perf:all -- --label candidate
npm run perf:compare -- output/performance/runs/baseline output/performance/runs/candidate
```

The comparator refuses failed/incomplete runs and mismatched machine/tool/workload settings.
It compares common scenarios; negative changes mean lower timing or memory values.
Repeat each baseline/candidate at least three times with other builds, simulators, and apps idle.
Do not compare local timing to shared CI runners or treat a single small percentage change as proof.
The manually dispatched `Performance baseline` workflow runs the portable suite and retains artifacts;
iOS is a local Mac check. The workflow has not been dispatched as part of setup.

## What the suite proves

| Target | Production path | Behavior checks | Measurements |
| --- | --- | --- | --- |
| Browser | Optimized React/Vite build in Chromium desktop, iPhone-sized WebKit, iPad landscape WebKit | Exact shelf and search results, browsing creates no progress writes, real HTML audio advances during search, writes target the playing track, no unexpected API requests or uncaught page errors | Shelf-ready latency, six search latencies, playback frame intervals, API request counts |
| Server | Actual Axum router, authentication, scanned WAV catalogue, temporary SQLite | Existing HTTP contract suite, plus full/restricted/paged bodies, exact body-plus-pagination ETag, unchanged response is empty 304, progress changes invalidate tag | Five warmups + twenty serial samples per full/restricted/paged/304 request in release mode |
| Native iOS | Real Swift plugin methods, AVPlayer, Now Playing center, native download manager | Chapter metadata and artwork remain valid, changed cover sources replace the image; missing jobs fail and preserve the entire 200-job fixture | Repeated metadata/artwork completion and missing-job status queries using XCTest clock, CPU and memory metrics |

Browser API responses are deterministic fixtures, not a fake implementation of progress-write rules.
Server behavior is tested separately against real storage. Browser playback uses a generated WAV,
not synthetic `timeupdate` events. WebKit viewport tests do **not** emulate Capacitor, AVPlayer,
iOS background suspension, or physical-device audio. Native tests cover the actual plugin code
but do not constitute background audio, AirPods, network recovery, battery or thermal validation.
The native artwork completion probe has a 5 ms polling floor; use CPU/memory metrics and Instruments
for changes smaller than that. Browser timings include automation/assertion overhead, and frame
intervals include search/drawer interaction during playback; they are not React commit durations.

## When changing a hot path

1. Capture a baseline before editing production code.
2. Add a behavioral assertion only for a missing contract that the optimization could break.
3. Keep fixture sizes and measurement boundaries identical before and after.
4. Run the affected suite and compare repeated results; retain the artifacts.
5. For playback/storage changes, also run existing reliability/HTTP tests and verify pause,
   seek, background/foreground and offline restoration on the target device as applicable.

Coverage to extend with the optimization: artwork reload/fetch counts, a successful persisted
native download-recovery scenario for any new batched status API, and React profiling for shelf
memoization. Those are not claimed by the current timing measurements. Avoid adding a duplicate
server model or testing newly invented helpers that production never calls.
