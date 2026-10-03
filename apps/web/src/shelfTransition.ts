import { flushSync } from "react-dom";
import type { ShelfLayout } from "./shelfSort";

type ShelfViewTransition = { finished: Promise<unknown> };

let activeShelfTransition: ShelfViewTransition | null = null;

/**
 * Runs an iPad Shelf layout change as one motion: the page being put away
 * turns or slides out of the spread while the other sweeps across it. The
 * direction is published as `data-shelf-transition` for the stylesheet.
 *
 * The change applies immediately, with no motion, when reduced motion is on,
 * when WebKit has no view transitions, or when the spread is not the page on
 * screen, where the animation would play over an unrelated tab change.
 */
export function runShelfLayoutTransition(
  root: HTMLElement,
  from: ShelfLayout,
  to: ShelfLayout,
  update: () => void
): void {
  const document = root.ownerDocument as (Document & {
    startViewTransition?: (update: () => void | Promise<void>) => ShelfViewTransition;
  }) | null;
  const view = document?.defaultView;
  const shouldAnimate = !!document?.startViewTransition
    && !!view
    && root.classList.contains("platform-ios")
    && !view.matchMedia("(prefers-reduced-motion: reduce)").matches
    && !!document.querySelector(".native-shell:is(.tab-shelf, .tab-reading)");
  if (!shouldAnimate) {
    update();
    return;
  }

  root.dataset.shelfTransition = `${from}-${to}`;
  // React would otherwise commit after WebKit takes the new snapshot, and the
  // spread would jump to its new layout once the animation had finished.
  const transition = document.startViewTransition(() => flushSync(update));
  activeShelfTransition = transition;
  const cleanUp = () => {
    // A second change started mid-flight owns the attribute now.
    if (activeShelfTransition !== transition) return;
    activeShelfTransition = null;
    delete root.dataset.shelfTransition;
  };
  void transition.finished.then(cleanUp, cleanUp);
}
