import assert from "node:assert/strict";
import test from "node:test";
import {
  arrivedSince,
  finishAnnouncement,
  finishBannerText,
  finishedAgoLabel
} from "../src/finishFeed.ts";
import type { FinishEvent, FinishFeed } from "../src/types.ts";

function entry(id: string, overrides: Partial<FinishEvent> = {}): FinishEvent {
  return {
    id,
    userId: `user-${id}`,
    username: "Elena",
    bookId: `book-${id}`,
    bookTitle: "The Lantern Atlas",
    finishedAt: "2026-08-19T12:00:00Z",
    unseen: true,
    ...overrides
  };
}

function feed(entries: FinishEvent[]): FinishFeed {
  return {
    entries,
    unseenCount: entries.filter((item) => item.unseen).length,
    latestId: entries[0]?.id ?? null
  };
}

test("the first feed of a session announces nothing", () => {
  // Everything in it happened while the app was closed. Firing a banner per
  // backlog entry is the fastest way to make someone switch this off.
  assert.deepEqual(arrivedSince(null, feed([entry("a"), entry("b")])), []);
});

test("only entries that were not in the previous poll are announced", () => {
  const before = feed([entry("a")]);
  const after = feed([entry("b"), entry("a")]);
  assert.deepEqual(arrivedSince(before, after).map((item) => item.id), ["b"]);
});

test("an entry the viewer has already seen is not announced", () => {
  // Marked read on another device between polls.
  const before = feed([entry("a")]);
  const after = feed([entry("b", { unseen: false }), entry("a")]);
  assert.deepEqual(arrivedSince(before, after), []);
});

test("a poll that brings nothing new announces nothing", () => {
  const same = feed([entry("a"), entry("b")]);
  assert.deepEqual(arrivedSince(same, feed([entry("a"), entry("b")])), []);
});

test("an announcement names the person and the book", () => {
  assert.equal(
    finishAnnouncement(entry("a", { username: "Sam", bookTitle: "A Small Weather" })),
    "Sam finished A Small Weather"
  );
});

test("several finishes in one poll collapse into a single banner", () => {
  // A stack of banners for one refresh reads as a malfunction.
  assert.equal(finishBannerText([]), null);
  assert.equal(
    finishBannerText([entry("a", { username: "Sam", bookTitle: "Dune" })]),
    "Sam finished Dune"
  );
  assert.equal(
    finishBannerText([
      entry("a", { username: "Sam", bookTitle: "Dune" }),
      entry("b")
    ]),
    "Sam finished Dune, and 1 other finish"
  );
  assert.equal(
    finishBannerText([
      entry("a", { username: "Sam", bookTitle: "Dune" }),
      entry("b"),
      entry("c"),
      entry("d")
    ]),
    "Sam finished Dune, and 3 other finishes"
  );
});

test("the age of a finish reads coarsely", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");
  const ago = (iso: string) => finishedAgoLabel(iso, now);
  assert.equal(ago("2026-08-19T11:59:30Z"), "just now");
  assert.equal(ago("2026-08-19T11:30:00Z"), "30m ago");
  assert.equal(ago("2026-08-19T09:00:00Z"), "3h ago");
  assert.equal(ago("2026-08-17T12:00:00Z"), "2d ago");
  assert.equal(ago("2026-08-05T12:00:00Z"), "2w ago");
});

test("an unparseable timestamp reads as nothing rather than NaN", () => {
  assert.equal(finishedAgoLabel("not a date"), "");
});

test("the server's unix-seconds stamp is read, not just ISO", () => {
  // `finishedAt` is named for RFC 3339 but the server sends unix seconds in a
  // string, which Date.parse cannot read at all.
  const now = Date.parse("2026-08-19T12:00:00Z");
  const secondsAgo = String(Math.floor(now / 1000) - 3600);
  assert.equal(finishedAgoLabel(secondsAgo, now), "1h ago");
});
