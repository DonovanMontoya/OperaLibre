# Follow-along test environments

## What runs automatically

`Follow-along regression` runs on relevant PR changes. It executes the corpus
runner's contract tests and the production EPUB reader in Chromium and WebKit.
There are no retries that turn a failed first attempt green. Screenshots, traces,
and JSON results are uploaded on failures. Existing server CI runs the synthetic
windowed aligner tests, including outages, duplicate anchors, revised wording,
EPUB-only passages, audio-only passages, invalid clocks, and repeated recovery.

Every Monday, and on manual workflow dispatch, the real-audio job synthesizes
original speech with espeak-ng and sends it through the production recognizer
and forced aligner. Cases include clean speech, silence, noise, and simultaneous
printed/narrated edition additions. Sentence boundaries come from separately
synthesized audio segments, not from the recognizer being tested. Its onset
tolerance is 0.75 seconds for synthetic speech; this is not a claim about natural
audiobook word accuracy. A clean scope or eligible shared passage must reach 97%;
unmatched material must not receive a forced highlight.

The weekly schedule starts once this workflow reaches the default branch.

## Run locally

```sh
npm ci
npx playwright install chromium webkit
npm run test:follow
```

This runs corpus contracts, deterministic server window tests, and browsers.
For just browsers: `npm run test:follow -w @operalibre/web`.
For real speech, install ffmpeg, espeak-ng, and the pinned add-on:

```sh
npm ci --prefix addons/readalong-sync
npm run test:follow:audio -- --output output/follow-along/audio-001 \
  --cli addons/readalong-sync/node_modules/.bin/echogarden
```

Use a new output directory every time. Test servers bind loopback and the Rust
probe creates an isolated temporary application state. No production API,
account, listening progress, or sync map is modified.

## Private book corpus

Keep owned EPUB/audio and all generated excerpts outside Git and public CI.
The corpus runner is Python standard library code. Run it on the machine that
can read the library; copy the checked-out source there or use an isolated
checkout. The worker needs Rust, ffmpeg, and the pinned sync add-on.

```sh
python3 script/follow-along/corpus.py inventory \
  --library /path/to/owned-books --output /private/tests/catalog.json
python3 script/follow-along/corpus.py plan \
  --catalog /private/tests/catalog.json --output /private/tests/plan-001
python3 script/follow-along/corpus.py run \
  --plan /private/tests/plan-001/plan.json --output /private/tests/run-001 \
  --cli /path/to/echogarden --labels /private/tests/labels.json
```

Inventory pairs exact filenames first, then a sole sibling audio file. Inspect
the proposed pairs and edition metadata before marking a book `holdout` or
`development` in the private catalog. Ambiguous pairs remain blocked. Multi-file
audiobooks need an explicitly prepared single-file fixture; they are not guessed.

Planning uses a fixed seed and picks scopes across the beginning, middle, and end
before seeing alignment results. It bounds section duration to avoid transcribing
whole long books. `--books ID ...`, `--scopes N`, and `--max-seconds N` narrow the
run. A blocked chapter match is a reported failure, never silently omitted.

The frozen plan retains the source hashes and scope inventory. Each run records
current source hashes, input hashes, labels hash, raw maps, recognition output,
and logs. The plan's `attempts/` ledger preserves the first attempt even if it
fails or the process is interrupted. Reuse that plan for regressions. Once a book
has informed a fix, change its catalog role to development for future plans; a
first-recorded receipt alone does not establish that a book was truly unseen.

Exit codes: **0** all selected cases passed; **1** failure or blocked input;
**2** structurally valid but no independent accuracy labels. Missing labels must
never make a benchmark green. Reports distinguish structural validity from
verified matching accuracy. Failed or interrupted books stay in the report.

### Independent labels and edition differences

The labels file maps book ID, then scope index, to an array:

```json
{
  "book-id": {
    "3": [
      {"kind":"prose","at":125.5,"href":"chapter.xhtml","text":"An independently checked sentence.","startSeconds":123.2,"toleranceSeconds":0.5},
      {"kind":"unmatched","at":132.0,"reason":"Audio-only paragraph in the older recording; checked against both editions"},
      {"kind":"hold","at":140.0}
    ]
  }
}
```

Create labels from listening and EPUB inspection, or independently constructed
synthetic audio. Do not derive expected timestamps from the map under test.
Every eligible prose label counts in the denominator, including missing matches.
`unmatched` requires a reason and asserts no fragment covers that audio; it covers
genuine edition differences. `hold` additionally requires recovery metadata and
tests recognized uncertainty. Neither category is a timing success. Wrong matches
in these intervals fail the run. Image visibility is checked in the browser layer,
not inferred from a map's structural validity.

For anthologies and revised editions, label shared passages on both sides of each
addition, deletion, changed paragraph, or reordered section. Reordered text must
not pull the reader backward to an already consumed passage. Where no trustworthy
forward match exists, holding is the correct result. Never add title-specific
production offsets or waive a mismatched passage without independently checking it.

## Device and long-session environment

Start Vite and open `/test/follow-along/reader.html?recovery` in simulator Safari
or a device browser. The same generated EPUB and production reader are used by
the automated suite. Buttons expose the uncertain interval and recovered sentence.
Without `?recovery`, the fixture has two consecutive narrated image pages.

Chromium/WebKit tests cover all Follow modes, two outages, backward seeks, manual
Follow, map replacement, reopening, viewport changes, and a real HTML media clock
with pause/resume and speed changes. They do not replace a packaged-client run.

For a release candidate, use an isolated test account/library in the packaged app
and record results for: screen locking, background/foreground, Bluetooth changes,
offline reopening, repeated app termination, 0.75x–3x speed, and a long listening
session. Assert the correct shared passage resumes, manual Follow stays off,
and listening progress survives. Hardware Bluetooth/audio interruptions require
a physical device; do not mark them passed from simulator or browser results.

Server CI also interrupts and fails generation, verifies the old map remains
intact, and retries successfully. Offline persistence tests preserve recovery
metadata and reject stale asynchronous writes. Existing lifecycle tests cover
progress persistence; run `npm run test:lifecycle` for the isolated server/crash
environment. Complete packaged-device verification separately before making
release-level claims.
