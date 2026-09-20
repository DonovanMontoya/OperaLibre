import assert from "node:assert/strict";
import test from "node:test";
import { applyDeviceFold, isBookPosture, isFoldTransitionChange, resolveFoldLayoutState, type DeviceFoldState } from "../src/deviceFold.ts";

function fakeRoot() {
  const properties = new Map<string, string>();
  const attributes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    toggleAttribute: (name: string, force: boolean) => {
      if (force) attributes.add(name);
      else attributes.delete(name);
      return force;
    },
    style: {
      setProperty: (name: string, value: string) => void properties.set(name, value),
      removeProperty: (name: string) => void properties.delete(name)
    }
  };
  return { root: root as unknown as HTMLElement, dataset: root.dataset, properties, attributes };
}

test("publishes the posture, axis, and fold rect", () => {
  const { root, dataset, properties } = fakeRoot();
  applyDeviceFold(root, {
    posture: "half-open",
    angle: 110,
    horizontalSizeClass: "regular",
    verticalSizeClass: "regular",
    fold: { x: 0, y: 320, width: 951, height: 24, axis: "horizontal", active: true }
  });
  assert.equal(dataset.foldPosture, "half-open");
  assert.equal(dataset.foldAxis, "horizontal");
  assert.equal(dataset.horizontalSizeClass, "regular");
  assert.equal(dataset.verticalSizeClass, "regular");
  assert.equal(properties.get("--fold-y"), "320px");
  assert.equal(properties.get("--fold-height"), "24px");
});

test("clears the fold when the page no longer crosses one", () => {
  const { root, dataset, properties } = fakeRoot();
  applyDeviceFold(root, {
    posture: "half-open",
    fold: { x: 320, y: 0, width: 24, height: 951, axis: "vertical", active: true }
  });
  applyDeviceFold(root, { posture: "closed" });
  assert.equal(dataset.foldPosture, "closed");
  assert.equal(dataset.foldAxis, undefined);
  assert.equal(properties.size, 0);
});

test("leaves phones without a hinge untouched", () => {
  const { root, dataset } = fakeRoot();
  applyDeviceFold(root, { posture: "unknown" });
  assert.deepEqual(dataset, {});
});

test("layout follows the active region even when hinge status arrives separately", () => {
  const { root, attributes, properties } = fakeRoot();
  const state: DeviceFoldState = {
    posture: "unknown",
    fold: { x: 460, y: 0, width: 30, height: 660, axis: "vertical", active: true }
  };
  applyDeviceFold(root, state);
  assert.equal(attributes.has("data-fold-active"), true);
  assert.equal(isBookPosture(state), true);

  const inactive = { ...state, posture: "half-open" as const, fold: { ...state.fold!, active: false } };
  applyDeviceFold(root, inactive);
  assert.equal(attributes.has("data-fold-active"), true);
  assert.equal(isBookPosture(inactive), true);
  // The inner-display geometry remains available for the flat layout.
  assert.equal(properties.get("--fold-x"), "460px");
});

test("rotation and closing clear the book spread and fold displacement", () => {
  const { root, attributes } = fakeRoot();
  const state: DeviceFoldState = {
    posture: "half-open",
    fold: { x: 0, y: 460, width: 660, height: 30, axis: "horizontal", active: true }
  };
  applyDeviceFold(root, state);
  assert.equal(attributes.has("data-fold-active"), true);
  assert.equal(isBookPosture(state), false);
  const closed = { ...state, posture: "closed" as const };
  applyDeviceFold(root, closed);
  assert.equal(attributes.has("data-fold-active"), false);
  assert.equal(isBookPosture(closed), false);
  applyDeviceFold(root, { posture: "unknown" });
  assert.equal(attributes.has("data-fold-active"), false);
});

test("only structural posture changes animate", () => {
  const halfOpen: DeviceFoldState = {
    posture: "half-open",
    angle: 90,
    fold: { x: 0, y: 460, width: 669, height: 31, axis: "horizontal", active: true }
  };
  assert.equal(isFoldTransitionChange({ posture: "unknown" }, halfOpen), false);
  assert.equal(isFoldTransitionChange(halfOpen, { ...halfOpen, angle: 112 }), false);
  assert.equal(isFoldTransitionChange(halfOpen, { posture: "closed", angle: 0 }), true);
  assert.equal(isFoldTransitionChange(halfOpen, {
    ...halfOpen,
    fold: { ...halfOpen.fold!, x: 460, y: 0, width: 31, height: 669, axis: "vertical" }
  }), true);
});

test("closing angle anticipates the closed layout before the hinge reports closed", () => {
  const halfOpen: DeviceFoldState = {
    posture: "half-open",
    angle: 90,
    fold: { x: 0, y: 460, width: 669, height: 31, axis: "horizontal", active: true }
  };
  assert.equal(resolveFoldLayoutState(halfOpen, { posture: "half-open" }).posture, "half-open");
  assert.equal(resolveFoldLayoutState({ ...halfOpen, angle: 71 }, { posture: "half-open" }).posture, "half-open");
  assert.equal(resolveFoldLayoutState({ ...halfOpen, angle: 70 }, { posture: "half-open" }).posture, "closed");
  assert.equal(resolveFoldLayoutState({ ...halfOpen, angle: 12 }).posture, "closed");
  assert.equal(resolveFoldLayoutState({ posture: "closed", angle: 0 }).posture, "closed");
});

test("compact transition uses hysteresis while the hinge hovers near its cutoff", () => {
  const halfOpen: DeviceFoldState = {
    posture: "half-open",
    angle: 76,
    fold: { x: 0, y: 460, width: 669, height: 31, axis: "horizontal", active: true }
  };
  assert.equal(resolveFoldLayoutState(halfOpen, { posture: "half-open" }).posture, "half-open");
  assert.equal(resolveFoldLayoutState(halfOpen, { posture: "closed" }).posture, "closed");
  assert.equal(resolveFoldLayoutState({ ...halfOpen, angle: 83 }, { posture: "closed" }).posture, "half-open");
});
