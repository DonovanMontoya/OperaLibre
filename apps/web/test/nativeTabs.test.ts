import assert from "node:assert/strict";
import test from "node:test";
import { nativeTabItems, fullShelfMustYield, nativeTabSelection, spreadTab } from "../src/nativeTabs.ts";

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

test("on the iPad spread, Shelf is the collection alone and Reading is the spread", () => {
  // A book opened from the collection uses the shelf route but shows beside it.
  assert.equal(spreadTab("shelf", true, "split"), "reading");
  assert.equal(spreadTab("shelf", true, "player"), "reading");
  assert.equal(spreadTab("reading", true, "library"), "shelf");
  assert.equal(spreadTab("shelf", true, "library"), "shelf");
  assert.equal(spreadTab("games", true, "library"), "games");
});

test("without the spread, each route is its own tab", () => {
  assert.equal(spreadTab("shelf", false, "split"), "shelf");
  assert.equal(spreadTab("reading", false, "split"), "reading");
});

test("the full shelf gives way to anything shown on the player page", () => {
  // Playing from the shelf and opening a companion set the route without going through the tab bar.
  assert.equal(fullShelfMustYield("reading", "now", "library"), true);
  assert.equal(fullShelfMustYield("shelf", "details", "library"), true);
  assert.equal(fullShelfMustYield("shelf", "now", "library"), false);
  assert.equal(fullShelfMustYield("reading", "now", "split"), false);
  assert.equal(fullShelfMustYield("reading", "now", "player"), false);
});
