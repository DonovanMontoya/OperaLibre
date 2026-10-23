import type { ShelfLayout } from "./shelfSort";
import { runMarkedViewTransition } from "./viewTransition.ts";

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
  const document = root.ownerDocument;
  const view = document.defaultView;
  const shouldAnimate = !!view
    && root.classList.contains("platform-ios")
    && !view.matchMedia("(prefers-reduced-motion: reduce)").matches
    && !!document.querySelector(".native-shell:is(.tab-shelf, .tab-reading)");
  if (!shouldAnimate) {
    update();
    return;
  }
  runMarkedViewTransition(root, "shelfTransition", `${from}-${to}`, update);
}
