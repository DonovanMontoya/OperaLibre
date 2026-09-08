import assert from "node:assert/strict";
import test from "node:test";
import { WebPlugin } from "@capacitor/core";

class EventPlugin extends WebPlugin {
  emitChange() {
    this.notifyListeners("change", {});
  }
}

test("repeated plugin cleanup preserves another component's listener", async () => {
  const plugin = new EventPlugin();
  const disposed = await plugin.addListener("change", () => assert.fail("disposed listener fired"));
  let notifications = 0;
  await plugin.addListener("change", () => { notifications += 1; });
  await disposed.remove();
  await disposed.remove();
  plugin.emitChange();
  assert.equal(notifications, 1);
  await plugin.removeAllListeners();
});
