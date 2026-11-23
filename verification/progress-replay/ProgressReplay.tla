--------------------------- MODULE ProgressReplay ---------------------------
(***************************************************************************)
(* Offline progress replay between one listening device and the server,  *)
(* with a second device that can save in between.                         *)
(*                                                                         *)
(* One book. The device's localStorage journal (reliability.ts            *)
(* readProgressCheckpoint / writeProgressCheckpoint) is its only local     *)
(* copy. Three senders on the device replay it:                            *)
(*   lib   useLibrary.ts loadBooks: the reconnect replay chain             *)
(*   rst   usePlaybackRestore.ts: restoring the opened book                *)
(*   queue useProgressSync.ts persistProgress + flushProgressSaveQueue     *)
(* The server is progress.rs update_progress, whose decision runs inside   *)
(* storage.rs update_book's SQLite transaction, so it is one step.         *)
(*                                                                         *)
(* Each device step is the synchronous code between two awaits.            *)
(* Positions are whole numbers; time is one shared clock, so device and    *)
(* server timestamps compare as the code compares them when clocks agree.  *)
(***************************************************************************)
\* No Sequences: /statechart cannot read its module comments.
EXTENDS Naturals

CONSTANTS
    \* 0af3ac8c: progress.rs decide_progress_checkpoint orders a checkpoint
    \* by its {id, sequence} recording, and update_progress reports an exact
    \* retry as accepted. FALSE is the server before that commit.
    RecordingLineage,
    \* 4c7bd6f6: usePlaybackRestore.ts adopts the reply when the journal was
    \* already healed to it (journalHealed). FALSE is the restore before it.
    AdoptHealedJournal,
    \* 85fadfd4: usePlaybackRestore.ts adopts a journal healed while its own
    \* resend was lost. FALSE is the restore before it.
    AdoptHealedOnLostResend,
    \* useProgressSync.ts persistProgress returns early until restore has
    \* applied a position (restoredProgressBookId). FALSE removes that guard.
    GuardUnrestoredSave,
    MaxLoads,   \* loadBooks calls that reach the replay
    MaxEdits,   \* positions the listener records on this device
    MaxLosses   \* requests or replies the network drops

\* Positions. The server starts at Start; the journal holds Offline, recorded
\* while the device had no connection; the other device saves Other.
Start == 10
Offline == 12
Other == 30
\* Mirrors PROGRESS_NEAR_ZERO_SECONDS: a position this close to the start.
NearZero == 5

Senders == {"lib", "rst", "queue"}

(* A Progress value from types.ts. st is syncStatus: "pending" or "synced"   *)
(* for a journal copy, "server" for a server reply, "none" for null. upd is  *)
(* updatedAt, lt localUpdatedAt (0 = unset), base baseUpdatedAt, rid/seq the *)
(* recording, own localRecordingId (0 = unset), acc the reply's accepted.    *)
(* eid is a ghost: which listener edit this position is (0 = not this        *)
(* device's offline listening). No guard reads it.                           *)
None == [st |-> "none", pos |-> 0, upd |-> 0, lt |-> 0, base |-> 0,
         rid |-> 0, seq |-> 0, own |-> 0, acc |-> "undef", eid |-> 0]
Idle == [k |-> "idle", r |-> None]
\* A library replay's {attempted, saved, acknowledgements}; ok = FALSE is null.
NoResult == [ok |-> FALSE, att |-> None, saved |-> None, acks |-> <<>>, n |-> 0]

VARIABLES
    srv,        \* the stored progress row: at, pos, rid, seq, eid
    clock,
    otherAt,    \* when the other device saved (0 = not yet); it saves once
    committedEid, \* ghost: the newest listener edit the server ever stored
    nextRid,    \* reliability.ts newProgressRecording: a fresh recording id
    jr,         \* the journal
    player,     \* setPosition / restoredProgressBookId
    edits, losses,
    req, resp,  \* per sender: request on the wire, reply on the wire
    libPc, libGen, libActive, libQueued, libPrev, libCp, libAtt, libRes,
    rstPc, rstOwns, rstCancelled, rstWait, rstCp, rstLocal, rstOpt, rstNewer,
    queue, qPc, qAtt,
    srvOrphan, jrOrphan, rstCheck

vars == <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits, losses,
          req, resp, libPc, libGen, libActive, libQueued, libPrev, libCp, libAtt,
          libRes, rstPc, rstOwns, rstCancelled, rstWait, rstCp, rstLocal, rstOpt,
          rstNewer, queue, qPc, qAtt, srvOrphan, jrOrphan, rstCheck>>

-----------------------------------------------------------------------------
(* reliability.ts helpers, one operator each. *)

\* isSameProgressRevision
Same(l, r) == l.upd = r.upd /\ l.lt = r.lt /\ l.rid = r.rid /\ l.seq = r.seq
              /\ l.pos = r.pos

\* progressAfterSave: the reply wins only while the journal still holds the
\* copy that was sent. KeptLocal is the `!== saved` test callers make.
KeptLocal(local, attempted) ==
    ~(local.st = "none" \/ (attempted.st # "none" /\ Same(local, attempted)))
ProgressAfterSave(local, attempted, saved) ==
    IF KeptLocal(local, attempted) THEN local ELSE saved

\* ownedProgressRecording
Owned(p) == p.rid # 0 /\ p.rid = p.own

\* identifyProgressRecording; the caller advances nextRid when it is not owned.
Identify(p) ==
    IF Owned(p) THEN p ELSE [p EXCEPT !.rid = nextRid, !.seq = 1, !.own = nextRid]

\* pendingProgress for an automatic (not seek) checkpoint: the base is
\* inherited, never taken from a reply the engine has not adopted.
PendingProgress(pos, prev, t, eid) ==
    [st |-> "pending", pos |-> pos, upd |-> t, lt |-> t, base |-> prev.base,
     rid |-> IF Owned(prev) THEN prev.rid ELSE nextRid,
     seq |-> IF Owned(prev) THEN prev.seq + 1 ELSE 1,
     own |-> IF Owned(prev) THEN prev.rid ELSE nextRid,
     acc |-> "undef", eid |-> eid]

\* syncedProgress
Synced(saved, lt, attempted) ==
    [st |-> "synced", pos |-> saved.pos, upd |-> saved.upd, lt |-> lt,
     base |-> saved.upd, rid |-> saved.rid, seq |-> saved.seq,
     own |-> IF saved.acc = "yes" /\ saved.rid # 0 /\ attempted.st # "none"
                /\ saved.rid = attempted.own /\ saved.seq = attempted.seq
             THEN attempted.own ELSE 0,
     acc |-> "undef", eid |-> saved.eid]

\* rebasePendingProgress
RebaseApplies(local, attempted, saved) ==
    saved.acc = "yes" /\ local.st = "pending" /\ local.base = attempted.base
Rebase(local, attempted, saved) ==
    IF ~RebaseApplies(local, attempted, saved) THEN local
    ELSE [local EXCEPT
            !.base = saved.upd,
            !.seq = IF Owned(local) /\ saved.rid = local.rid /\ local.seq <= saved.seq
                    THEN saved.seq + 1 ELSE local.seq]

RECURSIVE RebaseFrom(_, _, _)
RebaseFrom(local, result, i) ==
    IF i > result.n THEN local
    ELSE RebaseFrom(Rebase(local, result.acks[i].att, result.acks[i].saved), result, i + 1)
\* usePlaybackRestore / useLibrary loop over replayed.acknowledgements
RebaseAll(local, result) == RebaseFrom(local, result, 1)

\* journalProgressAttempt: journal the wire identity unless the journal
\* changed since `observed` was read.
JournalAttempt(attempted, observed) ==
    ProgressAfterSave(jr, observed, attempted) = attempted

(* useProgressSync.ts storeCanonicalServerProgress(book, saved, attempted,    *)
(* journal). hasAtt says whether `attempted` was passed at all; `journal`     *)
(* defaults to `attempted`. Returns the journal it leaves behind.             *)
StoreCanonical(saved, hasAtt, attempted, journal) ==
    IF hasAtt /\ KeptLocal(jr, journal)
    THEN IF attempted.st # "none" THEN Rebase(jr, attempted, saved) ELSE jr
    ELSE LET ack == IF saved.acc = "yes"
                    THEN IF hasAtt /\ attempted.st # "none" THEN attempted ELSE jr
                    ELSE None
             recordedAt == IF ack.st # "none"
                           THEN IF ack.lt # 0 THEN ack.lt ELSE ack.upd
                           ELSE jr.lt
             canonical == Synced(saved, recordedAt, ack)
         IN IF saved.acc = "no" /\ jr.st # "none"
            THEN [canonical EXCEPT !.base = jr.base]
            ELSE canonical

\* The queued save it rebases alongside the journal.
QueueAfterCanonical(saved, hasAtt, attempted, journal) ==
    IF hasAtt /\ KeptLocal(jr, journal) /\ attempted.st # "none"
       /\ RebaseApplies(jr, attempted, saved) /\ queue.st # "none"
    THEN Rebase(queue, attempted, saved) ELSE queue

\* A server reply or getProgress body.
Reply(row, acc) ==
    [st |-> "server", pos |-> row.pos, upd |-> row.at, lt |-> 0, base |-> 0,
     rid |-> row.rid, seq |-> row.seq, own |-> 0, acc |-> acc, eid |-> row.eid]

\* A journal write that throws away this device's newest listening, which the
\* server never stored, although no other device saved after its base.
DropsEdit(old, new) ==
    old.st = "pending" /\ new.eid < old.eid /\ committedEid < old.eid
    /\ ~(otherAt > old.base)
TrackJournal == jrOrphan' = (jrOrphan \/ DropsEdit(jr, jr'))

-----------------------------------------------------------------------------
Init ==
    /\ srv = [at |-> 1, pos |-> Start, rid |-> 0, seq |-> 0, eid |-> 0]
    /\ clock = 2
    /\ otherAt = 0
    /\ committedEid = 0
    /\ nextRid = 2
    \* Listening recorded offline on top of revision 1, then the app closed.
    /\ jr = [st |-> "pending", pos |-> Offline, upd |-> 2, lt |-> 2, base |-> 1,
             rid |-> 1, seq |-> 1, own |-> 1, acc |-> "undef", eid |-> 1]
    /\ player = [pos |-> 0, restored |-> FALSE]
    /\ edits = 0
    /\ losses = 0
    /\ req = [s \in Senders |-> None]
    /\ resp = [s \in Senders |-> Idle]
    /\ libPc = "idle" /\ libGen = 0 /\ libActive = 0 /\ libQueued = FALSE
    /\ libPrev = NoResult /\ libCp = None /\ libAtt = None
    /\ libRes = [i \in 1..MaxLoads |-> [done |-> FALSE, res |-> NoResult]]
    /\ rstPc = "closed" /\ rstOwns = FALSE /\ rstCancelled = FALSE /\ rstWait = 0
    /\ rstCp = None /\ rstLocal = None /\ rstOpt = None /\ rstNewer = FALSE
    /\ queue = None /\ qPc = "idle" /\ qAtt = None
    /\ srvOrphan = FALSE /\ jrOrphan = FALSE /\ rstCheck = "none"

-----------------------------------------------------------------------------
(* Server: progress.rs update_progress. decide_progress_checkpoint and       *)
(* decide_progress_write run in storage.rs update_book's transaction; the     *)
(* `accepted` flag is computed from its result. One step.                    *)
Decide(cp) ==
    LET sameRecording == RecordingLineage /\ srv.rid # 0 /\ cp.rid # 0 /\ srv.rid = cp.rid
        continues == sameRecording /\ cp.seq > srv.seq
        keep == \/ (sameRecording /\ ~continues)          \* older or same edit
                \/ (cp.base # srv.at /\ ~continues)       \* another revision
                \* progress_write_is_unintentional_regression / _suspect_reset;
                \* the model has no deliberate seeks.
                \/ cp.pos < srv.pos
        stored == [at |-> clock + 1, pos |-> cp.pos,
                   rid |-> IF RecordingLineage THEN cp.rid ELSE 0,
                   seq |-> IF RecordingLineage THEN cp.seq ELSE 0, eid |-> cp.eid]
        row == IF keep THEN srv ELSE stored
        accepted == ~keep \/ (RecordingLineage /\ cp.rid # 0 /\ cp.rid = row.rid
                              /\ cp.seq = row.seq /\ row.pos = cp.pos)
    IN [keep |-> keep, row |-> row, accepted |-> accepted]

ServerHandles(s) ==
    /\ req[s] # None
    /\ LET d == Decide(req[s]) IN
       /\ srv' = d.row
       /\ clock' = IF d.keep THEN clock ELSE clock + 1
       /\ committedEid' = IF ~d.keep /\ req[s].eid > committedEid
                          THEN req[s].eid ELSE committedEid
       /\ resp' = [resp EXCEPT ![s] = [k |-> "reply",
                                        r |-> Reply(d.row, IF d.accepted THEN "yes" ELSE "no")]]
       /\ req' = [req EXCEPT ![s] = None]
       \* This device's newest listening refused although no other device
       \* saved after the revision it was recorded on.
       /\ srvOrphan' = (srvOrphan \/
            (d.keep /\ req[s].eid > committedEid /\ ~(otherAt > req[s].base)))
    /\ UNCHANGED <<otherAt, nextRid, jr, player, edits, losses, libPc, libGen,
                   libActive, libQueued, libPrev, libCp, libAtt, libRes, rstPc,
                   rstOwns, rstCancelled, rstWait, rstCp, rstLocal, rstOpt,
                   rstNewer, queue, qPc, qAtt, rstCheck>>
    /\ TrackJournal

\* saveProgress rejects: the request never arrived or its reply was lost.
NetworkDrops(s) ==
    /\ losses < MaxLosses
    /\ \/ /\ req[s] # None
          /\ req' = [req EXCEPT ![s] = None]
       \/ /\ resp[s].k = "reply"
          /\ req' = req
    /\ resp' = [resp EXCEPT ![s] = [k |-> "lost", r |-> None]]
    /\ losses' = losses + 1
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   libPc, libGen, libActive, libQueued, libPrev, libCp, libAtt,
                   libRes, rstPc, rstOwns, rstCancelled, rstWait, rstCp, rstLocal,
                   rstOpt, rstNewer, queue, qPc, qAtt, srvOrphan, rstCheck>>
    /\ TrackJournal

\* Another device listened further and saved against the current revision.
OtherDeviceSaves ==
    /\ otherAt = 0
    /\ srv' = [at |-> clock + 1, pos |-> Other, rid |-> 0, seq |-> 0, eid |-> 0]
    /\ otherAt' = clock + 1
    /\ clock' = clock + 1
    /\ UNCHANGED <<committedEid, nextRid, jr, player, edits, losses, req, resp,
                   libPc, libGen, libActive, libQueued, libPrev, libCp, libAtt,
                   libRes, rstPc, rstOwns, rstCancelled, rstWait, rstCp, rstLocal,
                   rstOpt, rstNewer, queue, qPc, qAtt, srvOrphan, rstCheck>>
    /\ TrackJournal

-----------------------------------------------------------------------------
(* Library reconnect replay: useLibrary.ts loadBooks. Each replay chains on  *)
(* the book's previous one (libraryProgressReplaysRef) and passes on its     *)
(* {attempted, saved, acknowledgements} result.                               *)

\* The listing arrives; register a replay unless restore owns the book.
LibLoad ==
    /\ libGen < MaxLoads
    /\ libGen' = libGen + 1
    /\ IF rstOwns
       THEN UNCHANGED <<libPc, libActive, libQueued, libPrev>>
       ELSE IF libPc = "idle"
            THEN /\ libPc' = "read" /\ libActive' = libGen + 1 /\ libPrev' = NoResult
                 /\ UNCHANGED libQueued
            ELSE /\ libQueued' = TRUE
                 /\ UNCHANGED <<libPc, libActive, libPrev>>
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   losses, req, resp, libCp, libAtt, libRes, rstPc, rstOwns,
                   rstCancelled, rstWait, rstCp, rstLocal, rstOpt, rstNewer, queue,
                   qPc, qAtt, srvOrphan, rstCheck>>
    /\ TrackJournal

LibCurrent == libActive = libGen   \* isCurrentRequest()
LibBails == ~LibCurrent \/ rstOwns

\* The replay settles with `result`; a registered successor starts from it.
LibFinish(result) ==
    /\ libRes' = [libRes EXCEPT ![libActive] = [done |-> TRUE, res |-> result]]
    /\ IF libQueued
       THEN /\ libPc' = "read" /\ libActive' = libActive + 1 /\ libPrev' = result
            /\ libQueued' = FALSE
       ELSE /\ libPc' = "idle" /\ UNCHANGED <<libActive, libPrev, libQueued>>

\* Up to `await getCachedProgress`: read the journal as `checkpoint`.
LibRead ==
    /\ libPc = "read"
    /\ IF LibBails
       THEN LibFinish(libPrev) /\ UNCHANGED libCp
       ELSE /\ libCp' = jr /\ libPc' = "send"
            /\ UNCHANGED <<libActive, libQueued, libPrev, libRes>>
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   losses, req, resp, libGen, libAtt, rstPc, rstOwns, rstCancelled,
                   rstWait, rstCp, rstLocal, rstOpt, rstNewer, queue, qPc, qAtt,
                   srvOrphan, rstCheck>>
    /\ TrackJournal

\* Up to `await saveProgress`: rebase on the chain's receipts, then send.
LibSend ==
    /\ libPc = "send"
    /\ LET prev == libPrev
           acked == prev.ok /\ prev.saved.acc = "yes" /\ ~KeptLocal(libCp, prev.att)
           local == RebaseAll(libCp, prev)
           attempted == Identify(local)
       IN
       IF LibBails
       THEN LibFinish(libPrev) /\ UNCHANGED <<jr, nextRid, req, libCp, libAtt, queue>>
       ELSE IF acked
       THEN \* An earlier replay in the chain already saved this copy.
            /\ jr' = StoreCanonical(prev.saved, TRUE, prev.att, libCp)
            /\ queue' = QueueAfterCanonical(prev.saved, TRUE, prev.att, libCp)
            /\ LibFinish(prev)
            /\ UNCHANGED <<nextRid, req, libCp, libAtt>>
       ELSE IF local.st # "pending"   \* progressNeedsSync
       THEN LibFinish(libPrev) /\ UNCHANGED <<jr, nextRid, req, libCp, libAtt, queue>>
       ELSE /\ nextRid' = IF Owned(local) THEN nextRid ELSE nextRid + 1
            /\ IF JournalAttempt(attempted, libCp)
               THEN jr' = attempted /\ libCp' = attempted
               ELSE UNCHANGED <<jr, libCp>>
            /\ libAtt' = attempted
            /\ req' = [req EXCEPT !["lib"] = attempted]
            /\ libPc' = "wait"
            /\ UNCHANGED <<libActive, libQueued, libPrev, libRes, queue>>
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, player, edits, losses, resp,
                   libGen, rstPc, rstOwns, rstCancelled, rstWait, rstCp, rstLocal,
                   rstOpt, rstNewer, qPc, qAtt, srvOrphan, rstCheck>>
    /\ TrackJournal

LibReply ==
    /\ libPc = "wait"
    /\ resp["lib"].k = "reply"
    /\ LET saved == resp["lib"].r
           \* Persist while this replay still owns the book's slot.
           owns == LibCurrent \/ ~libQueued
       IN /\ jr' = IF owns THEN StoreCanonical(saved, TRUE, libAtt, libCp) ELSE jr
          /\ queue' = IF owns THEN QueueAfterCanonical(saved, TRUE, libAtt, libCp) ELSE queue
          /\ LibFinish([ok |-> TRUE, att |-> libAtt, saved |-> saved, n |-> libPrev.n + 1,
                        acks |-> [i \in 1..(libPrev.n + 1) |->
                                    IF i <= libPrev.n THEN libPrev.acks[i]
                                    ELSE [att |-> libAtt, saved |-> saved]]])
    /\ resp' = [resp EXCEPT !["lib"] = Idle]
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, player, edits,
                   losses, req, libGen, libCp, libAtt, rstPc, rstOwns, rstCancelled,
                   rstWait, rstCp, rstLocal, rstOpt, rstNewer, qPc, qAtt, srvOrphan,
                   rstCheck>>
    /\ TrackJournal

LibLost ==
    /\ libPc = "wait"
    /\ resp["lib"].k = "lost"
    /\ LibFinish(libPrev)
    /\ resp' = [resp EXCEPT !["lib"] = Idle]
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   losses, req, libGen, libCp, libAtt, rstPc, rstOwns, rstCancelled,
                   rstWait, rstCp, rstLocal, rstOpt, rstNewer, queue, qPc, qAtt,
                   srvOrphan, rstCheck>>
    /\ TrackJournal

-----------------------------------------------------------------------------
(* Restore: usePlaybackRestore.ts, when the book is opened. *)

\* The effect runs: take ownership and capture the library's replay.
RstOpen ==
    /\ rstPc = "closed"
    /\ rstPc' = "optimistic"
    /\ rstOwns' = TRUE
    /\ rstWait' = IF libPc = "idle" THEN 0
                  ELSE IF libQueued THEN libActive + 1 ELSE libActive
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   losses, req, resp, libPc, libGen, libActive, libQueued, libPrev,
                   libCp, libAtt, libRes, rstCancelled, rstCp, rstLocal, rstOpt,
                   rstNewer, queue, qPc, qAtt, srvOrphan, rstCheck>>
    /\ TrackJournal

\* applyProgress; canonical copies are also stored as acknowledged.
Apply(target, canonical) ==
    /\ player' = [pos |-> target.pos, restored |-> TRUE]
    /\ jr' = IF canonical THEN StoreCanonical([target EXCEPT !.acc = "undef"], FALSE, None, None)
             ELSE jr

\* After the native-recovery and cache reads: stage the freshest copy.
RstOptimistic ==
    /\ rstPc = "optimistic"
    /\ rstCp' = jr /\ rstLocal' = jr /\ rstOpt' = jr
    /\ Apply(jr, jr.st = "synced")
    /\ rstPc' = IF rstWait # 0 THEN "awaitLib" ELSE "fetch"
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, edits, losses, req,
                   resp, libPc, libGen, libActive, libQueued, libPrev, libCp, libAtt,
                   libRes, rstOwns, rstCancelled, rstWait, rstNewer, queue, qPc, qAtt,
                   srvOrphan, rstCheck>>
    /\ TrackJournal

RstEnd(check) ==
    /\ rstPc' = "done"
    /\ rstOwns' = FALSE
    /\ rstCheck' = check

\* When restore ends on its own with no edit pending, nothing else in flight
\* and the journal at the server's newest revision, the player must be there.
SettleCheck(playerPos, journal, others) ==
    IF journal.st = "synced" /\ journal.upd = srv.at /\ others
    THEN IF playerPos = srv.pos THEN "ok" ELSE "stale"
    ELSE "unsettled"

\* `await libraryReplay`, then rebase on every receipt in its chain.
RstAfterLibrary ==
    /\ rstPc = "awaitLib"
    /\ libRes[rstWait].done
    /\ IF rstCancelled
       THEN RstEnd("cancelled") /\ UNCHANGED <<rstLocal, rstCp>>
       ELSE LET replayed == libRes[rstWait].res
                rebased == RebaseAll(rstLocal, replayed)
            IN /\ rstLocal' = rebased
               /\ rstCp' = IF rebased # rstLocal /\ jr.st = "synced"
                              /\ jr.upd = replayed.saved.upd
                           THEN jr ELSE rstCp
               /\ rstPc' = "fetch"
               /\ UNCHANGED <<rstOwns, rstCheck>>
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   losses, req, resp, libPc, libGen, libActive, libQueued, libPrev,
                   libCp, libAtt, libRes, rstCancelled, rstWait, rstOpt, rstNewer,
                   queue, qPc, qAtt, srvOrphan>>
    /\ TrackJournal

\* The final re-apply test at the end of the restore effect.
Reapply(target, corrected) ==
    corrected \/ target.upd > rstOpt.upd
    \/ (target # rstOpt /\ rstOpt.st = "pending" /\ ~rstNewer)

\* getProgress answers; either adopt the server or send the newer local copy.
RstFetch ==
    /\ rstPc = "fetch"
    /\ IF rstCancelled
       THEN /\ RstEnd("cancelled")
            /\ UNCHANGED <<jr, player, nextRid, req, rstCp, rstLocal, rstNewer, queue>>
       ELSE LET server == Reply(srv, "undef")
                newer == rstLocal.st = "pending"   \* progressNeedsSync
                sending == Identify(rstLocal)
            IN IF ~newer
               THEN LET healed == StoreCanonical(server, TRUE, rstLocal, rstLocal)
                        again == Reapply(server, FALSE)
                        finalJr == IF again
                                   THEN Synced([server EXCEPT !.acc = "undef"], healed.lt, None)
                                   ELSE healed
                        finalPos == IF again THEN server.pos ELSE player.pos
                    IN /\ jr' = finalJr
                       /\ player' = [pos |-> finalPos, restored |-> TRUE]
                       /\ queue' = QueueAfterCanonical(server, TRUE, rstLocal, rstLocal)
                       /\ RstEnd(SettleCheck(finalPos, finalJr,
                                             libPc = "idle" /\ qPc = "idle"))
                       /\ UNCHANGED <<nextRid, req, rstCp, rstLocal>>
                       /\ rstNewer' = FALSE
               ELSE /\ nextRid' = IF Owned(rstLocal) THEN nextRid ELSE nextRid + 1
                    /\ rstLocal' = sending
                    /\ IF JournalAttempt(sending, rstCp)
                       THEN jr' = sending /\ rstCp' = sending
                       ELSE UNCHANGED <<jr, rstCp>>
                    /\ req' = [req EXCEPT !["rst"] = sending]
                    /\ rstNewer' = TRUE
                    /\ rstPc' = "wait"
                    /\ UNCHANGED <<player, queue, rstOwns, rstCheck>>
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, edits, losses, resp, libPc,
                   libGen, libActive, libQueued, libPrev, libCp, libAtt, libRes,
                   rstCancelled, rstWait, rstOpt, qPc, qAtt, srvOrphan>>
    /\ TrackJournal

\* saveProgress answers the restore's own replay.
RstReply ==
    /\ rstPc = "wait"
    /\ resp["rst"].k = "reply"
    /\ resp' = [resp EXCEPT !["rst"] = Idle]
    /\ IF rstCancelled
       THEN RstEnd("cancelled") /\ UNCHANGED <<jr, player, queue>>
       ELSE LET saved == resp["rst"].r
                current == jr
                unchanged == ~KeptLocal(current, rstCp)
                journalHealed == AdoptHealedJournal /\ ~unchanged
                    /\ current.st = "synced" /\ current.upd = saved.upd
                    /\ current.pos = saved.pos
                corrected == saved.acc = "no" \/ saved.pos # rstLocal.pos
                adopt == unchanged \/ ~KeptLocal(current, rstLocal)
                afterStore == IF adopt
                              THEN StoreCanonical(saved, TRUE, rstLocal,
                                                  IF unchanged THEN rstCp ELSE rstLocal)
                              ELSE IF journalHealed THEN jr
                              ELSE StoreCanonical(saved, TRUE, rstLocal, rstLocal)
                queueAfter == IF adopt
                              THEN QueueAfterCanonical(saved, TRUE, rstLocal,
                                                       IF unchanged THEN rstCp ELSE rstLocal)
                              ELSE IF journalHealed THEN queue
                              ELSE QueueAfterCanonical(saved, TRUE, rstLocal, rstLocal)
                target == IF adopt \/ journalHealed THEN saved ELSE rstLocal
                canonical == adopt \/ journalHealed
                again == Reapply(target, (adopt \/ journalHealed) /\ corrected)
                finalJr == IF again /\ canonical
                           THEN Synced([target EXCEPT !.acc = "undef"], afterStore.lt, None)
                           ELSE afterStore
                finalPos == IF again THEN target.pos ELSE player.pos
            IN /\ jr' = finalJr
               /\ player' = [pos |-> finalPos, restored |-> TRUE]
               /\ queue' = queueAfter
               /\ RstEnd(SettleCheck(finalPos, finalJr,
                                     libPc = "idle" /\ qPc = "idle"))
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, edits, losses, req,
                   libPc, libGen, libActive, libQueued, libPrev, libCp, libAtt,
                   libRes, rstCancelled, rstWait, rstCp, rstLocal, rstOpt, rstNewer,
                   qPc, qAtt, srvOrphan>>
    /\ TrackJournal

RstLost ==
    /\ rstPc = "wait"
    /\ resp["rst"].k = "lost"
    /\ resp' = [resp EXCEPT !["rst"] = Idle]
    /\ IF rstCancelled
       THEN RstEnd("cancelled") /\ UNCHANGED player
       ELSE LET healed == AdoptHealedOnLostResend /\ jr.st = "synced"
                    /\ (rstCp.st # "synced" \/ jr.upd # rstCp.upd)
                target == IF healed THEN jr ELSE rstLocal
                again == Reapply(target, healed)
                finalPos == IF again THEN target.pos ELSE player.pos
            IN /\ player' = [pos |-> finalPos, restored |-> TRUE]
               /\ RstEnd(SettleCheck(finalPos, jr, libPc = "idle" /\ qPc = "idle"))
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, edits, losses,
                   req, libPc, libGen, libActive, libQueued, libPrev, libCp, libAtt,
                   libRes, rstCancelled, rstWait, rstCp, rstLocal, rstOpt, rstNewer,
                   queue, qPc, qAtt, srvOrphan>>
    /\ TrackJournal

-----------------------------------------------------------------------------
(* Listening on this device: useProgressSync.ts persistProgress. Touching    *)
(* playback (usePlaybackControls.ts markPlaybackTouched) bumps the action    *)
(* version, which cancels a running restore, and releases its ownership.     *)
ListenerRecords ==
    /\ edits < MaxEdits
    /\ GuardUnrestoredSave => player.restored
    /\ LET pos == player.pos + 1
           e == PendingProgress(pos, jr, clock + 1, edits + 2)
       IN /\ jr' = e
          /\ player' = [player EXCEPT !.pos = pos]
          /\ queue' = e
    /\ nextRid' = IF Owned(jr) THEN nextRid ELSE nextRid + 1
    /\ clock' = clock + 1
    /\ edits' = edits + 1
    /\ IF rstPc \in {"optimistic", "awaitLib", "fetch", "wait"}
       THEN rstCancelled' = TRUE /\ rstOwns' = FALSE
       ELSE UNCHANGED <<rstCancelled, rstOwns>>
    /\ UNCHANGED <<srv, otherAt, committedEid, losses, req, resp, libPc, libGen,
                   libActive, libQueued, libPrev, libCp, libAtt, libRes, rstPc,
                   rstWait, rstCp, rstLocal, rstOpt, rstNewer, qPc, qAtt, srvOrphan,
                   rstCheck>>
    /\ TrackJournal

\* flushProgressSaveQueue takes the queued entry off and sends it.
QueueSend ==
    /\ qPc = "idle"
    /\ queue # None
    /\ req' = [req EXCEPT !["queue"] = queue]
    /\ qAtt' = queue
    /\ queue' = None
    /\ qPc' = "wait"
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   losses, resp, libPc, libGen, libActive, libQueued, libPrev, libCp,
                   libAtt, libRes, rstPc, rstOwns, rstCancelled, rstWait, rstCp,
                   rstLocal, rstOpt, rstNewer, srvOrphan, rstCheck>>
    /\ TrackJournal

QueueReply ==
    /\ qPc = "wait"
    /\ resp["queue"].k = "reply"
    /\ LET saved == resp["queue"].r
       IN IF KeptLocal(jr, qAtt)
          THEN /\ jr' = Rebase(jr, qAtt, saved)
               /\ queue' = IF RebaseApplies(jr, qAtt, saved) /\ queue # None
                           THEN Rebase(queue, qAtt, saved) ELSE queue
          ELSE /\ jr' = StoreCanonical(saved, TRUE, qAtt, qAtt)
               /\ queue' = QueueAfterCanonical(saved, TRUE, qAtt, qAtt)
    /\ resp' = [resp EXCEPT !["queue"] = Idle]
    /\ qPc' = "idle"
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, player, edits,
                   losses, req, libPc, libGen, libActive, libQueued, libPrev, libCp,
                   libAtt, libRes, rstPc, rstOwns, rstCancelled, rstWait, rstCp,
                   rstLocal, rstOpt, rstNewer, qAtt, srvOrphan, rstCheck>>
    /\ TrackJournal

\* The drain's catch drops the entry; the journal keeps the edit.
QueueLost ==
    /\ qPc = "wait"
    /\ resp["queue"].k = "lost"
    /\ resp' = [resp EXCEPT !["queue"] = Idle]
    /\ qPc' = "idle"
    /\ UNCHANGED <<srv, clock, otherAt, committedEid, nextRid, jr, player, edits,
                   losses, req, libPc, libGen, libActive, libQueued, libPrev, libCp,
                   libAtt, libRes, rstPc, rstOwns, rstCancelled, rstWait, rstCp,
                   rstLocal, rstOpt, rstNewer, queue, qAtt, srvOrphan, rstCheck>>
    /\ TrackJournal

-----------------------------------------------------------------------------
Quiet == libPc = "idle" /\ rstPc \in {"closed", "done"} /\ qPc = "idle"
         /\ queue = None /\ \A s \in Senders : req[s] = None /\ resp[s] = Idle

Done == Quiet /\ rstPc = "done" /\ libGen = MaxLoads /\ UNCHANGED vars

Step ==
    \/ \E s \in Senders : ServerHandles(s) \/ NetworkDrops(s)
    \/ OtherDeviceSaves
    \/ LibLoad \/ LibRead \/ LibSend \/ LibReply \/ LibLost
    \/ RstOpen \/ RstOptimistic \/ RstAfterLibrary \/ RstFetch \/ RstReply \/ RstLost
    \/ ListenerRecords \/ QueueSend \/ QueueReply \/ QueueLost

Next == Step \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

\* A position this device recorded is never refused or overwritten unless
\* another device saved after the revision it was recorded on.
NoOrphanedEdit == ~srvOrphan /\ ~jrOrphan

\* When restore settles, the player shows the newest position the server
\* holds from any device.
PlayerShowsNewest == rstCheck # "stale"

\* NoOrphanedEdit limited to 0af3ac8c's own story: restore finished after a
\* message was lost, and later listening was refused.
NoOrphanAfterLostReply == ~(srvOrphan /\ losses = 1 /\ rstPc = "done" /\ ~rstCancelled)

\* No copy of the position falls to the start of the book: the listener never
\* seeks there in this model, so any such write is a reset.
NoResetToStart ==
    /\ srv.pos >= NearZero
    /\ (jr.st = "pending" => jr.pos >= NearZero)

TypeOK ==
    /\ libPc \in {"idle", "read", "send", "wait"}
    /\ rstPc \in {"closed", "optimistic", "awaitLib", "fetch", "wait", "done"}
    /\ qPc \in {"idle", "wait"}
    /\ rstCheck \in {"none", "ok", "stale", "unsettled", "cancelled"}
=============================================================================
