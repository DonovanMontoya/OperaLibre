import assert from "node:assert/strict";
import { test } from "node:test";
import { installPressGuard } from "../src/pressGuard.ts";

// A 100×60 button at the origin, with a child icon that can be the event target.
function fakeButton() {
  const button = {
    closest: () => button,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 60 }),
    contains: (node: unknown) => node === button || node === icon
  };
  const icon = { closest: () => button };
  return { button, icon };
}

function fire(root: EventTarget, type: string, target: unknown, init: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "target", { value: target });
  Object.assign(event, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 50, clientY: 30, ...init });
  root.dispatchEvent(event);
  return event;
}

function setup() {
  const root = new EventTarget();
  installPressGuard(root);
  let clicks = 0;
  root.addEventListener("click", () => { clicks += 1; });
  return { root, clicks: () => clicks };
}

test("a tap lifted on the button activates it", () => {
  const { root, clicks } = setup();
  const { icon } = fakeButton();
  fire(root, "pointerdown", icon);
  fire(root, "pointerup", icon, { clientX: 95, clientY: 55 });
  const click = fire(root, "click", icon);
  assert.equal(clicks(), 1);
  assert.equal(click.defaultPrevented, false);
});

test("sliding off the button before lifting cancels the press", () => {
  const { root, clicks } = setup();
  const { button } = fakeButton();
  fire(root, "pointerdown", button);
  fire(root, "pointerup", button, { clientX: 50, clientY: 140 });
  const click = fire(root, "click", button);
  assert.equal(clicks(), 0);
  assert.equal(click.defaultPrevented, true);
});

test("a lift just past the edge still counts as on the button", () => {
  const { root, clicks } = setup();
  const { button } = fakeButton();
  fire(root, "pointerdown", button);
  fire(root, "pointerup", button, { clientX: 108, clientY: 66 });
  fire(root, "click", button);
  assert.equal(clicks(), 1);
});

test("only the click from the abandoned press is dropped", () => {
  const { root, clicks } = setup();
  const { button } = fakeButton();
  fire(root, "pointerdown", button);
  fire(root, "pointerup", button, { clientX: 300, clientY: 30 });
  fire(root, "click", button);
  fire(root, "pointerdown", button);
  fire(root, "pointerup", button);
  fire(root, "click", button);
  assert.equal(clicks(), 1);
});

test("mouse presses are left to the browser", () => {
  const { root, clicks } = setup();
  const { button } = fakeButton();
  fire(root, "pointerdown", button, { pointerType: "mouse" });
  fire(root, "pointerup", button, { pointerType: "mouse", clientX: 300 });
  fire(root, "click", button);
  assert.equal(clicks(), 1);
});
