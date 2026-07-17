import assert from "node:assert/strict";
import test from "node:test";
import { deviceBookMatchesServer, progressTimestamp, serverStorageKey } from "../src/reliability.ts";

test("offline storage keys are isolated by server and type", () => {
  const first = serverStorageKey("operalibre", "http://books-a.local:4000");
  const second = serverStorageKey("operalibre", "http://books-b.local:4000");
  const jellyfin = serverStorageKey("jellyfin", "http://books-a.local:4000");
  assert.notEqual(first, second);
  assert.notEqual(first, jellyfin);
  assert.equal(first, serverStorageKey("operalibre", "HTTP://BOOKS-A.LOCAL:4000"));
});

test("legacy epoch and ISO progress timestamps compare consistently", () => {
  assert.equal(progressTimestamp("1752195600"), 1_752_195_600_000);
  assert.equal(progressTimestamp("2025-07-11T01:00:00Z"), 1_752_195_600_000);
  assert.equal(progressTimestamp("invalid"), 0);
});

test("device books reconcile only with equivalent server books", () => {
  assert.equal(
    deviceBookMatchesServer(
      { title: "The Odyssey: An Audiobook", trackCount: 4 },
      { title: "the odyssey—an audiobook", trackCount: 4 }
    ),
    true
  );
  assert.equal(
    deviceBookMatchesServer(
      { title: "The Odyssey", trackCount: 1 },
      { title: "The Odyssey", trackCount: 12 }
    ),
    false
  );
});
