import assert from "node:assert/strict";
import test from "node:test";
import { nativeTabItems, nativeTabSelection } from "../src/nativeTabs.ts";

test("native tabs keep Administration inside Settings and never need More", () => {
  for (const games of [false, true]) {
    for (const ledger of [false, true]) {
      const tabs = nativeTabItems(games, ledger, 0);
      assert.ok(tabs.length <= 5);
      assert.equal(tabs.some((tab) => tab.id === "admin"), false);
      assert.equal(tabs.at(-1)?.id, "settings");
      assert.equal(nativeTabSelection("admin", tabs), "settings");
      assert.equal(nativeTabSelection("games", tabs), games ? "games" : "shelf");
      assert.equal(nativeTabSelection("ledger", tabs), ledger ? "ledger" : "shelf");
    }
  }
  assert.deepEqual(nativeTabItems(true, true, 0).map((tab) => tab.id),
    ["shelf", "reading", "games", "ledger", "settings"]);
});

test("Shelf carries connection alerts and clears the badge after recovery", () => {
  assert.equal(nativeTabItems(false, false, 3)[0].badge, "3");
  assert.equal(nativeTabItems(false, false, 0)[0].badge, undefined);
});
