import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.OPERALIBRE_GIFT_TEST_ORIGIN ?? "http://127.0.0.1:5199";

test("persistent recipient enrollment and receive retries use real Worker successors", { timeout: 25000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    for (const mode of ["resume", "restart", "lost-claim", "lost-claim-revoked", "revoked", "forged-offer", "cas-failure", "stalled-cas"]) {
      await t.test(mode, async () => {
        const page = await browser.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        try {
          await page.goto(`${origin}/test/gift-persistent-transport.html?case=${mode}`);
          await page.waitForFunction(() => document.documentElement.dataset.complete === "true", undefined, { timeout: 8000 });
          const result = await page.evaluate(() => window.persistentGiftResult);
          assert.deepEqual(errors, []);
          assert.equal(result.status, "done", JSON.stringify(result)); assert.deepEqual(result.errors, []);
          assert.deepEqual(result.preview, { routes: ["preview-read"], creates: 0, bytes: 0, recipientClaimed: false, producerClaimed: false, statePresent: false });
          assert.equal(result.previewFetches, mode === "restart" ? 2 : 1); assert.equal(result.creates, 1);
          assert.equal(result.transportInstances, mode === "restart" ? 2 : 1);
          assert.equal(result.authenticatedPreviewRequests, mode === "restart" ? 1 : 0);
          assert.equal(result.seedWrites, mode === "cas-failure" ? 0 : 1);
          assert.equal(result.gateClosed, true); assert.equal(result.lockReleased, true); assert.equal(result.linkUnchanged, true);
          assert.equal(result.persistedBeforeClaim, true); assert.equal(result.pendingBeforeResume, true);
          assert.equal(result.claimBodiesIdentical, true);
          assert.equal(result.cachedSuccessors, result.successorRequests);
          assert.equal(result.missingSecretDenied, result.successorRequests);
          assert.deepEqual(result.linkProbe, ["revoked", "cas-failure"].includes(mode) ? null : { generation: 0, ready: 403, session: 403, poll: 403, preview: 403, authorizedSession: 200 });
          const succeeds = mode === "resume" || mode === "restart" || mode === "lost-claim" || mode === "stalled-cas";
          assert.equal(result.imports, succeeds ? 1 : 0); assert.equal(result.receipts, succeeds ? 1 : 0);
          assert.equal(result.digestVerified, succeeds); assert.equal(result.archiveMatches, succeeds);
          if (succeeds) {
            assert.equal(result.stagedBytes, result.archiveSize); assert.equal(result.currentSessionStatus, 200); assert.equal(result.initialSessionStatus, 403);
            assert.deepEqual(result.events, ["state-seeded", "digest-verified", "verified-receipt", "receipt-confirmed", "import"]);
            assert.deepEqual(result.checkpoints.map(item => item.outcome), ["failed", "success"]);
            assert.equal(result.checkpoints[0].imports, 0); assert.equal(result.checkpoints[0].digestVerified, false);
            for (const attempt of result.attempts) { assert.equal(attempt.proofVerified, true); assert.equal(attempt.remoteDescriptions, 1); }
          } else {
            assert.equal(result.stagedBytes, 0); assert.deepEqual(result.persistedOffsets, []);
            assert.ok(result.checkpoints.every(item => item.outcome === "failed" && item.imports === 0));
          }
          if (mode === "resume" || mode === "restart") {
            assert.deepEqual(result.attempts.map(item => [item.generation, item.offset]), [[1, 0], [2, 8]]);
            assert.equal(result.attempts[0].confirmed, false); assert.equal(result.attempts[1].confirmed, true);
            assert.equal(result.attempts[0].deliveredBytes, 8); assert.equal(result.checkpoints[0].bytes, 8);
            assert.equal(result.attempts[1].deliveredBytes, result.archiveSize - 8);
            assert.equal(result.oldPreviewStatus, 403); assert.equal(result.successorRequests, 2); assert.equal(result.recoveryClaimRequests, 1);
            if (mode === "restart") { assert.equal(result.currentPreviewStatus, 200); assert.equal(result.restartPreviewSafe, true); }
          } else if (mode === "stalled-cas") {
            assert.equal(result.initialCASStalls, 1); assert.equal(result.abortedLockReleased, true);
            assert.equal(result.lateCommitObserved, true); assert.equal(result.lateSecretRetained, true);
            assert.equal(result.checkpoints[0].bytes, 0); assert.equal(result.checkpoints[0].recoveryClaimRequests, 0);
            assert.equal(result.checkpoints[0].successorRequests, 0);
            assert.equal(result.recoveryClaimRequests, 1); assert.equal(result.successorRequests, 1);
            assert.deepEqual(result.attempts.map(item => [item.generation, item.offset]), [[1, 0]]);
          } else if (mode.startsWith("lost-claim")) {
            assert.equal(result.lostResponses, 1); assert.equal(result.recoveryClaimRequests, 2);
            assert.equal(result.checkpoints[0].bytes, 0); assert.equal(result.checkpoints[0].successorRequests, 0);
            assert.equal(result.successorRequests, mode === "lost-claim" ? 1 : 0);
            assert.deepEqual(result.attempts.map(item => [item.generation, item.offset]), mode === "lost-claim" ? [[1, 0]] : []);
          } else if (mode === "forged-offer") {
            assert.equal(result.successorRequests, 1); assert.equal(result.attempts.length, 1);
            assert.equal(result.attempts[0].remoteDescriptions, 0); assert.equal(result.attempts[0].proofVerified, false); assert.equal(result.attempts[0].deliveredBytes, 0);
          } else {
            assert.equal(result.attempts.length, 0); assert.equal(result.successorRequests, 0);
            assert.equal(result.recoveryClaimRequests, mode === "cas-failure" ? 0 : 1);
          }
        } finally { await page.close(); }
      });
    }
  } finally { await browser.close(); }
});
