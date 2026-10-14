import assert from "node:assert/strict";
import test from "node:test";
import { AVATARS, avatarFor, hasChosenAvatar, supportsAvatars } from "../src/avatars.ts";

test("a picture can be chosen only where the server stores one", () => {
  // A server with pictures sends the field on every account, null when unset.
  assert.equal(supportsAvatars({ avatar: null }), true);
  assert.equal(supportsAvatars({ avatar: "owl" }), true);
  // Older servers, Jellyfin, and on-device libraries leave it out.
  assert.equal(supportsAvatars({}), false);
});

test("an account without a known picture shows its initial", () => {
  assert.equal(avatarFor({ username: "elena", avatar: "owl" })?.label, "Owl");
  assert.equal(avatarFor({ username: "elena", avatar: null }), null);
  assert.equal(avatarFor({ username: "elena" }), null);
  // Chosen in a newer app than this one.
  assert.equal(avatarFor({ username: "elena", avatar: "narwhal" }), null);
});

test("every picture has an id the server accepts and no other picture shares", () => {
  const ids = AVATARS.map((avatar) => avatar.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9-]{1,32}$/);
});

test("a picture this app cannot draw is still a choice that can be cleared", () => {
  assert.equal(avatarFor({ username: "elena", avatar: "narwhal" }), null);
  assert.equal(hasChosenAvatar({ avatar: "narwhal" }), true);
  assert.equal(hasChosenAvatar({ avatar: null }), false);
  assert.equal(hasChosenAvatar({}), false);
});
