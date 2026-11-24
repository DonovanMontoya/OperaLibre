---
name: verify-progress-replay
description: Model-check offline progress replay between devices and the server with TLA+. Use when a change touches how a saved listening position is replayed, accepted, refused, rebased or restored, including progress.rs decide_progress_checkpoint or update_progress, storage.rs update_book, reliability.ts progress helpers, useLibrary's reconnect replay, usePlaybackRestore, useProgressSync's save queue or markPlaybackTouched, or anything under verification/progress-replay.
published: false
---

# Verify progress replay

`verification/progress-replay/ProgressReplay.tla` is a TLA+ model of one book's
listening position moving between this device's localStorage journal, the
server, and a second device. TLC checks every order of the steps below within
small bounds. Tests check the orders someone thought of; this checks the rest.

## The rules

| Invariant | Plain rule | Harm when broken |
| --- | --- | --- |
| `NoOrphanedEdit` | A position this device recorded is never refused by the server or overwritten in the journal unless another device saved after the revision it was recorded on. | Listening is silently lost; the listener lands back where they were. |
| `PlayerShowsNewest` | When restore settles with the journal at the server's newest revision, the player shows that position. If the resend is lost after the journal is healed, the player and journal use the newest revision restore saw. | The player sits on a stale position and the next listening is built on it. |
| `NoOrphanAfterLostReply` | `NoOrphanedEdit` limited to 0af3ac8c's story: a restore whose save committed but whose reply was lost, followed by refused listening. Checked only on the pre-fix switch. | As for `NoOrphanedEdit`. |
| `NoResetToStart` | Neither the server nor a pending journal copy falls to the start of the book, since the listener never seeks there in the model. | A 0:00 write replaces real progress. |

Never weaken a rule or shrink a bound to make a check pass.

## Run it

```sh
verification/run.sh
```

It downloads `tla2tools.jar` 1.7.4 once, checks its sha256, and runs every
config. It needs Java 11 or later; set `JAVA` to a java binary when the one on
`PATH` does not run. The whole check takes under a minute. CI runs the same
script in the `formal` job whenever a file in the coverage record or under
`verification/` changes.

| Config | Switches | Expected |
| --- | --- | --- |
| `current.cfg` | the code at the sync commit | passes |
| `reliable-network.cfg` | current code, no lost messages | passes |
| `prefix-0af3ac8c.cfg` | `RecordingLineage = FALSE` | breaks `NoOrphanedEdit` (shortest path: reply still in flight) |
| `prefix-0af3ac8c-lost-reply.cfg` | `RecordingLineage = FALSE` | breaks `NoOrphanAfterLostReply` (the reply is lost) |
| `prefix-4c7bd6f6.cfg` | `AdoptHealedJournal = FALSE`, no lost messages | breaks `PlayerShowsNewest` |
| `prefix-85fadfd4.cfg` | `AdoptHealedOnLostResend = FALSE` | breaks `PlayerShowsNewest` (the restore's resend is lost) |
| `prefix-b151c503.cfg` | `PreferNewestOnLostResend = FALSE` | breaks `PlayerShowsNewest` (the healed journal is older than the restore fetch) |
| `unrestored-save.cfg` | `GuardUnrestoredSave = FALSE` | breaks `NoResetToStart` |

The runner fails when a config that must break a rule passes, when a passing
config breaks one, and on any other TLC error such as a deadlock. The current configuration allows
two library loads, two listener edits, one lost request or reply, two saves
from the other device, and one restore.

## Read a result

Read every result with the `/statechart` skill. Point it at a copy of the
model and the config in a scratch folder outside the repository. It reports
each broken rule as its shortest path in plain words. Then tell the path in the
code's words using the action names below. Do not draw conclusions from TLC's
raw state dumps.

A broken rule is a bug only when the real code repeats the path. Replay it in
`apps/web/test/progressReconciliation.test.ts`'s hook harness, one step per
action. The tests "a rejected library replay cannot authorize native recovery
over another revision" and "restore adopts the server after the journal was
healed while its replay was rejected" show how to hold a request open, heal the
journal mid-flight, and fail or answer a save. Server steps are
`decide_progress_checkpoint` cases in `apps/server/src/unit_tests.rs`. If the
code does not repeat the path, the model is wrong: fix the model, not the rule.

## Coverage record

Synced with the code at `617dcbf5a10d72eb6d510fef8e9315f3878a7141`.

| Model action or operator | Code |
| --- | --- |
| `Decide`, `ServerHandles` | `apps/server/src/progress.rs` `update_progress`, `decide_progress_checkpoint`, `decide_progress_write` (regression and reset guards, `next_progress_timestamp`); `apps/server/src/storage.rs` `update_book` (one transaction, so one step) |
| `Same`, `KeptLocal`, `ProgressAfterSave` | `apps/web/src/reliability.ts` `isSameProgressRevision`, `progressAfterSave` |
| `Owned`, `Identify`, `PendingProgress`, `Synced` | `reliability.ts` `ownedProgressRecording`, `identifyProgressRecording`, `pendingProgress`, `syncedProgress` |
| `RebaseApplies`, `Rebase`, `RebaseAll` | `reliability.ts` `rebasePendingProgress` and the loops over `acknowledgements` |
| `JournalAttempt` | `reliability.ts` `journalProgressAttempt` |
| `StoreCanonical`, `QueueAfterCanonical` | `apps/web/src/useProgressSync.ts` `storeCanonicalServerProgress` |
| `LibLoad`, `LibRead`, `LibSend`, `LibReply`, `LibLost` | `apps/web/src/useLibrary.ts` `loadBooks`, the per-book replay chained through `libraryProgressReplaysRef` |
| `RstOpen`, `RstOptimistic`, `RstAfterLibrary`, `RstFetch`, `RstReply`, `RstLost`, `Reapply` | `apps/web/src/usePlaybackRestore.ts`, the restore effect and its final `applyProgress` test |
| `ListenerRecords` | `useProgressSync.ts` `persistProgress`; `apps/web/src/usePlaybackControls.ts` `markPlaybackTouched` (cancels restore) |
| `QueueSend`, `QueueReply`, `QueueLost` | `useProgressSync.ts` `flushProgressSaveQueue` |

Each device action is the synchronous code between two `await`s. When the
coverage changes, update `FORMAL_INPUTS` in `script/ci/select_checks.py`.

## When the covered code changes

1. Find the actions that map to the changed functions in the coverage record.
2. Make the same change to those actions, keeping their step boundaries at the
   code's `await`s. A new `await` is a new step.
3. Run `verification/run.sh`. A newly broken rule is a bug until a replay in the
   test harness shows the model is wrong.
4. Move the sync commit above forward only after you have confirmed that the
   model describes the code at the new commit.

## Left out

Native recovery, the IndexedDB cache and device mirror as separate copies (the
journal is the only local copy, so 5f126ccb's earlier on-disk base cannot be
reached); deliberate seeks, `intentionalRegression` and seek intents; clock
skew and the legacy timestamp path; foreground adoption
(`adoptNewerServerProgress`) and the overruled marker; `getProgress` failures;
more than one restore or book; legacy journals without `syncStatus`; the
library listing summary; finished state and completion writes. A pass covers
the model at these bounds, not the app.
