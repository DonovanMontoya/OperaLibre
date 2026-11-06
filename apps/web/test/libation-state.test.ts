import assert from "node:assert/strict";
import test from "node:test";

import { canCheckAudible, isLibationAdding } from "../src/libationState.ts";
import type { LibationAccount, LibationStatus } from "../src/types.ts";

test("a deliberately removed completed title returns to Download instead of Adding", () => {
  assert.equal(
    isLibationAdding({
      isLocal: false,
      confirmationPending: false,
      confirmationFailed: false
    }),
    false
  );
});

test("Adding is limited to a new completion awaiting local confirmation", () => {
  assert.equal(
    isLibationAdding({
      isLocal: false,
      confirmationPending: true,
      confirmationFailed: false
    }),
    true
  );
  assert.equal(
    isLibationAdding({
      isLocal: false,
      confirmationPending: true,
      confirmationFailed: true
    }),
    false
  );
});

const signedIn = { id: "a", authenticated: true, connectionState: "connected" } as LibationAccount;
const status = (overrides: Partial<LibationStatus> = {}) => ({
  enabled: true,
  accounts: [signedIn],
  pendingLogin: null,
  ...overrides
}) as LibationStatus;

test("refreshing Get books checks Audible when a signed-in account can", () => {
  assert.equal(canCheckAudible(status(), false), true);
  assert.equal(canCheckAudible(status({ accounts: [{ ...signedIn, authenticated: false }, signedIn] }), false), true);
});

test("refreshing Get books only rereads the list when Audible cannot be checked", () => {
  assert.equal(canCheckAudible(null, false), false);
  assert.equal(canCheckAudible(status({ enabled: false }), false), false);
  assert.equal(canCheckAudible(status(), true), false, "a check is already running");
  assert.equal(canCheckAudible(status({ accounts: [] }), false), false);
  assert.equal(canCheckAudible(status({ accounts: [{ ...signedIn, authenticated: false }] }), false), false);
  assert.equal(canCheckAudible(status({ pendingLogin: { sessionId: "s", profileId: "a", loginUrl: "", expiresAt: 0 } }), false), false);
  assert.equal(canCheckAudible(status({ accounts: [signedIn, { ...signedIn, id: "b", connectionState: "signing_in" }] }), false), false);
});
