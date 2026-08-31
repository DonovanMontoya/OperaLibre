// Cross-device resume: one listener's position must follow them from the web
// player to the phone and back, without ever disturbing a live local session.
//
// These scenarios drive the client's real reconciliation functions
// (src/reliability.ts) against a model of the server's write-decision rules
// (apps/server/src/progress.rs, decide_progress_write). The model mirrors:
//   - stale-write guard          progress.rs (300s slack)
//   - unintentional regression   progress.rs (2s slack)
//   - suspect near-zero reset    progress.rs (60s / 300s)
//   - server-issued monotonic millisecond revisions
//
// The reported failure they guard against: web playback stopped at its final
// position, and the phone — foregrounded from the background rather than
// relaunched — kept playing from its own pre-background position. The restore
// effect deliberately runs once per book, so the foreground adoption path
// (adoptableServerProgress) is the only read that can pick up the web copy.

import assert from "node:assert/strict";
import test from "node:test";
import {
  NEAR_ZERO_PROGRESS_SECONDS,
  PROGRESS_RESET_GUARD_SECONDS,
  adoptableServerProgress,
  freshestProgress,
  isSuspectProgressReset,
  progressFromBookSummary,
  progressTimestamp,
  resolveProgressLocation
} from "../src/reliability.ts";
import type { Progress } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Server model (mirrors decide_progress_write in apps/server/src/progress.rs)
// ---------------------------------------------------------------------------

const STALE_SLACK_S = 300;
const REGRESSION_SLACK_S = 2;

type ServerWrite = {
  positionSeconds: number;
  bookPositionSeconds: number;
  trackId: string;
  updatedAtMs?: number;
  intentionalSeek?: boolean;
  intentionalRegression?: boolean;
};

class ServerModel {
  stored: Progress | null = null;
  private clockMs: number;
  constructor(nowMs: number) {
    this.clockMs = nowMs;
  }
  advance(seconds: number) {
    this.clockMs += seconds * 1000;
  }
  now() {
    return this.clockMs;
  }
  /** PUT /api/books/:id/progress → the saved (or kept) row, as the server's 200. */
  put(write: ServerWrite): Progress {
    const previous = this.stored;
    const incomingS =
      write.updatedAtMs !== undefined
        ? Math.min(write.updatedAtMs, this.clockMs) / 1000
        : undefined;
    if (previous && incomingS !== undefined) {
      const storedS = progressTimestamp(previous.updatedAt) / 1000;
      if (incomingS + STALE_SLACK_S < storedS) return previous; // Keep
    }
    if (previous) {
      if (
        !write.intentionalSeek &&
        write.bookPositionSeconds + REGRESSION_SLACK_S < previous.bookPositionSeconds
      ) {
        return previous; // Keep: unintentional regression
      }
      if (
        !write.intentionalRegression &&
        write.bookPositionSeconds < NEAR_ZERO_PROGRESS_SECONDS &&
        previous.bookPositionSeconds - write.bookPositionSeconds > PROGRESS_RESET_GUARD_SECONDS
      ) {
        return previous; // Keep: suspect reset
      }
    }
    const previousMs = previous ? progressTimestamp(previous.updatedAt) : 0;
    const saved: Progress = {
      bookId: BOOK.id,
      trackId: write.trackId,
      positionSeconds: write.positionSeconds,
      bookPositionSeconds: write.bookPositionSeconds,
      durationSeconds: BOOK.durationSeconds,
      updatedAt: String(Math.max(this.clockMs, previousMs + 1))
    };
    this.stored = saved;
    return saved;
  }
}

// ---------------------------------------------------------------------------
// Fixture: one book, three 3600s tracks.
// ---------------------------------------------------------------------------

const BOOK = {
  id: "book-1",
  durationSeconds: 10800,
  tracks: [
    { id: "t1", durationSeconds: 3600 },
    { id: "t2", durationSeconds: 3600 },
    { id: "t3", durationSeconds: 3600 }
  ]
};

const T0 = Date.parse("2026-08-27T08:00:00.000Z");

function clientProgress(bookPositionSeconds: number, atMs: number): Progress {
  const trackIndex = Math.min(2, Math.floor(bookPositionSeconds / 3600));
  return {
    bookId: BOOK.id,
    trackId: BOOK.tracks[trackIndex].id,
    positionSeconds: bookPositionSeconds - trackIndex * 3600,
    bookPositionSeconds,
    durationSeconds: BOOK.durationSeconds,
    updatedAt: new Date(atMs).toISOString()
  };
}

/**
 * The reported sequence, steps 1-2: the phone pauses at 1000s in the morning;
 * the web client then listens to 5000s and stops. Returns the server plus the
 * phone's local copies exactly as the app would have left them.
 */
function runWebSession() {
  const server = new ServerModel(T0);

  // Phone session: periodic saves up to 1000s, then pause and background.
  let phoneLocal: Progress | null = null;
  for (let position = 250; position <= 1000; position += 250) {
    server.advance(250);
    phoneLocal = clientProgress(position, server.now());
    server.put({ ...phoneLocal, updatedAtMs: server.now() });
  }
  const phoneCheckpoint = phoneLocal!;

  // Hours later: web resumes from the server copy and listens to 5000s.
  server.advance(4 * 3600);
  let webFinal: Progress | null = null;
  for (let position = 1000; position <= 5000; position += 500) {
    server.advance(500);
    webFinal = clientProgress(position, server.now());
    const saved = server.put({ ...webFinal, updatedAtMs: server.now() });
    assert.equal(
      saved.bookPositionSeconds,
      position,
      "a healthy-clock periodic web write must be accepted"
    );
  }

  server.advance(1800); // the web client closed half an hour ago
  return { server, phoneCheckpoint, webFinal: webFinal! };
}

test("a cold iOS launch reconciles to the web client's final position", () => {
  const { server, phoneCheckpoint, webFinal } = runWebSession();

  // The restore effect's inputs: local copies, the cached library summary,
  // and the live /progress fetch.
  const freshestLocal = freshestProgress(phoneCheckpoint);
  const listedStale = progressFromBookSummary(BOOK.id, {
    status: "inProgress",
    bookPositionSeconds: phoneCheckpoint.bookPositionSeconds,
    durationSeconds: BOOK.durationSeconds,
    updatedAt: phoneCheckpoint.updatedAt
  });
  const optimistic = isSuspectProgressReset(freshestLocal, listedStale)
    ? listedStale
    : freshestProgress(freshestLocal, listedStale);
  assert.equal(
    optimistic?.bookPositionSeconds,
    1000,
    "before the server answers, the phone optimistically shows its own copy"
  );

  const lastKnownServer = server.stored ?? listedStale;
  const localIsNewer =
    !!freshestLocal &&
    !isSuspectProgressReset(freshestLocal, lastKnownServer) &&
    (!lastKnownServer ||
      progressTimestamp(freshestLocal.updatedAt) > progressTimestamp(lastKnownServer.updatedAt));
  assert.equal(localIsNewer, false, "the phone's pre-background copy is older than the server's");

  const target = localIsNewer ? freshestLocal : lastKnownServer ?? freshestLocal;
  assert.deepEqual(
    resolveProgressLocation(BOOK.tracks, target),
    { trackId: "t2", positionSeconds: 1400 },
    "cold launch resumes at the web client's final position (5000s into the book)"
  );
  assert.equal(target!.bookPositionSeconds, webFinal.bookPositionSeconds);
});

test("a warm iOS resume adopts the web client's final position while idle", () => {
  const { server, phoneCheckpoint, webFinal } = runWebSession();

  // The app returns to the foreground paused and untouched. The foreground
  // adoption path fetches /progress and adopts the strictly newer server copy.
  const adopted = adoptableServerProgress(freshestProgress(phoneCheckpoint), server.stored);
  assert.equal(adopted, server.stored, "the foregrounded idle session adopts the server copy");
  assert.deepEqual(
    resolveProgressLocation(BOOK.tracks, adopted),
    { trackId: "t2", positionSeconds: 1400 },
    "the paused player now shows the web client's final position"
  );

  // A subsequent deliberate seek on the phone therefore starts from the web
  // position, so scrubbing to reorient can no longer erase the web progress.
  server.advance(30);
  const afterSeek = server.put({
    ...clientProgress(webFinal.bookPositionSeconds - 30, server.now()),
    updatedAtMs: server.now(),
    intentionalSeek: true,
    intentionalRegression: true
  });
  assert.equal(afterSeek.bookPositionSeconds, webFinal.bookPositionSeconds - 30);
});

test("foreground adoption never disturbs a session that is already current", () => {
  const { server, webFinal } = runWebSession();

  // The same device that made the final web write foregrounds again: its
  // healed checkpoint carries the server's own revision, so nothing is
  // adopted and the paused player does not twitch.
  const healedCheckpoint = server.stored!;
  assert.equal(adoptableServerProgress(healedCheckpoint, server.stored), null);

  // A device that listened offline past the server copy also stays put; its
  // local position is newer and the library reconcile will push it instead.
  const offlineAhead = clientProgress(
    webFinal.bookPositionSeconds + 900,
    progressTimestamp(server.stored!.updatedAt) + 600_000
  );
  assert.equal(adoptableServerProgress(offlineAhead, server.stored), null);
});

test("the server keeps the web position against a stale device's automatic writes", () => {
  const { server, webFinal } = runWebSession();

  // A device that missed the foreground adoption (offline fetch, race) and
  // plays from its stale position cannot roll the server back: periodic
  // writes are unflagged and the regression guard keeps the web copy.
  server.advance(60);
  const kept = server.put({
    ...clientProgress(1060, server.now()),
    updatedAtMs: server.now()
  });
  assert.equal(kept.bookPositionSeconds, webFinal.bookPositionSeconds);
});
