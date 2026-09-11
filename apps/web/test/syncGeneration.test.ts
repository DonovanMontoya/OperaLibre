import assert from "node:assert/strict";
import { test } from "node:test";
import { hasPreciseSync, syncConfirmationMessage } from "../src/syncGeneration.ts";

function book(source: string | null) {
  return {
    title: "The Long Book",
    syncFile: source ? { source, fileName: "sync.json", url: "/sync.json" } : null
  };
}

test("generated and sidecar maps are precise syncs", () => {
  assert.equal(hasPreciseSync(book("generated")), true);
  assert.equal(hasPreciseSync(book("sidecar")), true);
  assert.equal(hasPreciseSync(book("estimated")), false);
  assert.equal(hasPreciseSync(book(null)), false);
});

test("the confirmation names the book and warns about the long rebuild", () => {
  const message = syncConfirmationMessage(book("generated"));
  assert.match(message, /^The Long Book already has/);
  assert.match(message, /can take a long time/);
  assert.match(message, /current sync needs replacing/);
});
