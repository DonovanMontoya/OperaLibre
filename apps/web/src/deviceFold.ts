import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useSyncExternalStore } from "react";

export type FoldPosture = "closed" | "half-open" | "flat" | "unknown";
export type FoldAxis = "vertical" | "horizontal";
export type DeviceFoldState = {
  posture: FoldPosture;
  /** Hinge angle in degrees, when the device reports one. */
  angle?: number;
  /** Where the fold crosses the page, in CSS pixels of the layout viewport. */
  fold?: { x: number; y: number; width: number; height: number; axis: FoldAxis; active: boolean };
};

interface DeviceFoldPlugin {
  getState(): Promise<DeviceFoldState>;
  addListener(event: "change", listener: (state: DeviceFoldState) => void): Promise<PluginListenerHandle>;
}
const DeviceFold = registerPlugin<DeviceFoldPlugin>("DeviceFold");

// The last state published, for layouts that must be told in script (the
// reader's page spread) rather than by the stylesheet.
let current: DeviceFoldState = { posture: "unknown" };
const listeners = new Set<() => void>();
type FoldViewTransition = { finished: Promise<unknown>; skipTransition?: () => void };
let activeFoldTransition: FoldViewTransition | null = null;
let fallbackTransitionTimer: number | null = null;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useDeviceFold(): DeviceFoldState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Half open with the hinge down the middle, like a book held open. */
export function isBookPosture(state: DeviceFoldState): boolean {
  return usesFoldLayout(state) && state.fold?.axis === "vertical";
}

export function usesFoldLayout(state: DeviceFoldState): boolean {
  return !!state.fold && state.posture !== "closed" && (state.posture === "half-open" || state.fold.active);
}

/** A posture or axis change redraws the surfaces; live hinge-angle updates do not. */
export function isFoldTransitionChange(previous: DeviceFoldState, next: DeviceFoldState): boolean {
  if (previous.posture === "unknown") return false;
  return previous.posture !== next.posture || previous.fold?.axis !== next.fold?.axis;
}

function publishDeviceFold(root: HTMLElement, state: DeviceFoldState): void {
  current = state;
  listeners.forEach((listener) => listener());
  const fold = state.fold;
  root.toggleAttribute("data-fold-active", usesFoldLayout(state));
  if (state.posture === "unknown" && !fold) {
    delete root.dataset.foldPosture;
  } else {
    root.dataset.foldPosture = state.posture;
  }
  if (!fold) {
    delete root.dataset.foldAxis;
    for (const name of ["x", "y", "width", "height"]) root.style.removeProperty(`--fold-${name}`);
    return;
  }
  root.dataset.foldAxis = fold.axis;
  root.style.setProperty("--fold-x", `${fold.x}px`);
  root.style.setProperty("--fold-y", `${fold.y}px`);
  root.style.setProperty("--fold-width", `${fold.width}px`);
  root.style.setProperty("--fold-height", `${fold.height}px`);
}

/**
 * Publish a foldable iPhone's posture on <html> so the stylesheet can split
 * screens across the fold: `data-fold-posture`, `data-fold-active`, `data-fold-axis`, and the
 * fold's rect as `--fold-x/-y/-width/-height`. Phones without a hinge report
 * nothing and keep their ordinary layout.
 */
export function applyDeviceFold(root: HTMLElement, state: DeviceFoldState): void {
  const previous = current;
  const document = root.ownerDocument;
  const view = document?.defaultView;
  const reducedMotion = view?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
  const shouldAnimate = !!document
    && !!view
    && root.classList?.contains("platform-ios")
    && !reducedMotion
    && isFoldTransitionChange(previous, state);

  if (!shouldAnimate) {
    publishDeviceFold(root, state);
    return;
  }

  const transitionDocument = document as Document & {
    startViewTransition?: (update: () => void) => FoldViewTransition;
  };
  if (transitionDocument.startViewTransition) {
    activeFoldTransition?.skipTransition?.();
    root.dataset.foldTransition = "view";
    const transition = transitionDocument.startViewTransition(() => publishDeviceFold(root, state));
    activeFoldTransition = transition;
    const cleanUp = () => {
      if (activeFoldTransition !== transition) return;
      activeFoldTransition = null;
      delete root.dataset.foldTransition;
    };
    void transition.finished.then(cleanUp, cleanUp);
    return;
  }

  publishDeviceFold(root, state);
  root.dataset.foldTransition = "fallback";
  if (fallbackTransitionTimer !== null) view?.clearTimeout(fallbackTransitionTimer);
  fallbackTransitionTimer = view?.setTimeout(() => {
    fallbackTransitionTimer = null;
    delete root.dataset.foldTransition;
  }, 300) ?? null;
}

export function installDeviceFold(root: HTMLElement): void {
  if (Capacitor.getPlatform() !== "ios" || !Capacitor.isPluginAvailable("DeviceFold")) return;
  void DeviceFold.addListener("change", (state) => applyDeviceFold(root, state));
  void DeviceFold.getState().then((state) => applyDeviceFold(root, state)).catch(() => undefined);
}
