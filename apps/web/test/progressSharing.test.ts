import assert from "node:assert/strict";
import test from "node:test";
import {
  isAnnouncingFinishes,
  isNotifiedOfFinishes,
  isSharingProgress,
  supportsFinishFeed
} from "../src/sharingSettings.ts";
import type { AuthUser } from "../src/types.ts";

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "reader",
    username: "elena",
    isAdmin: false,
    isOwner: false,
    canApproveLibationRequests: false,
    allowedBookIds: null,
    libationAccess: "approval",
    shareProgress: true,
    announceFinishes: true,
    notifyFinishes: true,
    createdAt: "0",
    ...overrides
  };
}

test("a server that sends the finish settings supports the feed", () => {
  assert.equal(supportsFinishFeed(user()), true);
  // Off is still support — it is a stored answer, not a missing field.
  assert.equal(
    supportsFinishFeed(user({ announceFinishes: false, notifyFinishes: false })),
    true
  );
});

test("a server that omits the finish settings predates the feed", () => {
  // The server sends both as plain booleans and never omits them once the
  // feature exists, so absence is exact rather than a guess.
  const older = user();
  delete older.announceFinishes;
  delete older.notifyFinishes;
  assert.equal(supportsFinishFeed(older), false);
});

test("neither finish setting reads as on against a server without the feed", () => {
  // The bell and the two switches hang off these. Defaulting them to on the
  // way shareProgress does would leave a permanently empty bell and a pair of
  // switches that will not stay where they are put.
  const older = user();
  delete older.announceFinishes;
  delete older.notifyFinishes;
  assert.equal(isAnnouncingFinishes(older), false);
  assert.equal(isNotifiedOfFinishes(older), false);
  // Progress sharing itself still defaults to on, which is a separate feature.
  const oldest = user({ shareProgress: undefined });
  assert.equal(isSharingProgress(oldest), true);
});

test("both finish settings default to on where the server has the feed", () => {
  assert.equal(isAnnouncingFinishes(user()), true);
  assert.equal(isNotifiedOfFinishes(user()), true);
});

test("each finish setting can be turned off on its own", () => {
  assert.equal(isAnnouncingFinishes(user({ announceFinishes: false })), false);
  assert.equal(isNotifiedOfFinishes(user({ announceFinishes: false })), true);
  assert.equal(isNotifiedOfFinishes(user({ notifyFinishes: false })), false);
  assert.equal(isAnnouncingFinishes(user({ notifyFinishes: false })), true);
});

test("withdrawing from sharing withdraws from finishes too", () => {
  // Sharing stays the master switch, and stays reciprocal.
  const quiet = user({ shareProgress: false });
  assert.equal(isAnnouncingFinishes(quiet), false);
  assert.equal(isNotifiedOfFinishes(quiet), false);
});
