import assert from "node:assert/strict";
import test from "node:test";

import { isLibationAdding } from "../src/libationState.ts";

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
