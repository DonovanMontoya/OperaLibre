import test from "node:test";
import assert from "node:assert/strict";
import { refreshLibroAccounts, refreshPurchaseSources } from "../src/purchaseRefresh.ts";

test("All accounts refresh waits for both providers even when one fails", async () => {
  const calls: string[] = [];
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const result = refreshPurchaseSources([
    async () => { calls.push("libro"); throw new Error("expired"); },
    async () => { calls.push("audible"); await pending; calls.push("audible finished"); }
  ]);
  const rejected = assert.rejects(result, /expired/);
  await Promise.resolve();
  assert.deepEqual(calls, ["libro", "audible"]);
  complete();
  await rejected;
  assert.deepEqual(calls, ["libro", "audible", "audible finished"]);
});

test("Connecting one Libro account ignores another account's expired token", async () => {
  const calls: string[] = [];
  await refreshLibroAccounts([{ email: "expired@example.test" }, { email: "new@example.test" }], async account => {
    calls.push(account.email);
    if (account.email.startsWith("expired")) throw new Error("expired token");
  }, " NEW@example.test ");
  assert.deepEqual(calls, ["new@example.test"]);
});

test("Refresh all Libro accounts retains successful refreshes after an account fails", async () => {
  const saved: string[] = [];
  await assert.rejects(refreshLibroAccounts([{ email: "expired" }, { email: "healthy" }], async account => {
    if (account.email === "expired") throw new Error("expired token");
    saved.push(account.email);
  }), /expired token/);
  assert.deepEqual(saved, ["healthy"]);
});
