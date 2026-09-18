import assert from "node:assert/strict";
import test from "node:test";
import { applyDeviceFold } from "../src/deviceFold.ts";

function fakeRoot() {
  const properties = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => void properties.set(name, value),
      removeProperty: (name: string) => void properties.delete(name)
    }
  };
  return { root: root as unknown as HTMLElement, dataset: root.dataset, properties };
}

test("publishes the posture, axis, and fold rect", () => {
  const { root, dataset, properties } = fakeRoot();
  applyDeviceFold(root, {
    posture: "half-open",
    angle: 110,
    fold: { x: 0, y: 320, width: 951, height: 24, axis: "horizontal", active: true }
  });
  assert.equal(dataset.foldPosture, "half-open");
  assert.equal(dataset.foldAxis, "horizontal");
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
