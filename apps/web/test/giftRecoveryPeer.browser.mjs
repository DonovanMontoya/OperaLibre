import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.OPERALIBRE_GIFT_TEST_ORIGIN ?? "http://127.0.0.1:5199";

test("recovery uses Worker claim rotation, authenticated peer proof and verified receipt", { timeout: 20000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    for (const mode of ["success", "forged-offer", "revoked", "invalid-receipt", "corrupt-archive"]) {
      await t.test(mode, async () => {
        const page = await browser.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        try {
          await page.goto(`${origin}/test/gift-recovery-peer.html?case=${mode}`);
          await page.waitForFunction(() => document.documentElement.dataset.complete === "true", undefined, { timeout: 8000 });
          const result = await page.evaluate(() => window.recoveryResult);
          assert.deepEqual(errors, []);
          assert.notEqual(result.status, "fixture-error", result.error);
          assert.equal(result.status, mode === "success" ? "success" : "failed", JSON.stringify(result));
          assert.equal(result.gateClosed, true);
          assert.equal(result.generation, 1);
          assert.equal(result.readyOffset, result.prefixSize);
          assert.equal(result.readyPrefix, result.prefix);
          assert.equal(result.oldClaimStatus, 403);
          assert.equal(result.replayStatus, 403);
          assert.equal(result.lockReleased, true);
          assert.equal(result.peerClosed, true);
          if (mode === "forged-offer") {
            assert.equal(result.remoteDescriptions, 0); assert.equal(result.proofVerified, false);
            assert.equal(result.deliveredFrames, 0); assert.equal(result.appendedBytes, 0);
            assert.equal(result.digestVerified, false); assert.equal(result.receiptSent, false);
          } else {
            assert.equal(result.remoteDescriptions, 1); assert.equal(result.proofVerified, true);
            if (mode === "revoked") {
              assert.equal(result.revoked, true); assert.equal(result.deliveredFrames, 0);
              assert.equal(result.appendedBytes, 0); assert.equal(result.digestVerified, false); assert.equal(result.receiptSent, false);
            } else {
              assert.equal(result.deliveredFrames, 2);
              assert.equal(result.appendedBytes, result.archiveSize - result.prefixSize);
              assert.equal(result.digestVerified, mode !== "corrupt-archive");
              assert.equal(result.receiptSent, mode !== "corrupt-archive");
              assert.equal(result.confirmed, mode === "success");
            }
          }
          if (mode === "success") assert.deepEqual(result.events, ["proof-verified", "digest-verified", "verified-receipt", "receipt-confirmed", "completed"]);
        } finally { await page.close(); }
      });
    }
  } finally { await browser.close(); }
});
