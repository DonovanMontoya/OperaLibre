type PageTurnStorage = Pick<Storage, "getItem" | "setItem">;

const PAGE_TURN_ANIMATION_STORAGE_KEY = "operalibre.readerPageTurn";

export type PageTurnDirection = "next" | "prev";

/** On unless the reader has turned it off on this device. */
export function readPageTurnAnimation(storage?: PageTurnStorage): boolean {
  try {
    return (storage ?? window.localStorage).getItem(PAGE_TURN_ANIMATION_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writePageTurnAnimation(enabled: boolean, storage?: PageTurnStorage): void {
  try {
    (storage ?? window.localStorage).setItem(PAGE_TURN_ANIMATION_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Keep the in-memory choice usable when device storage is unavailable.
  }
}

type PageTurnTransition = {
  finished: Promise<unknown>;
  ready: Promise<unknown>;
  skipTransition(): void;
};

type PageTurnDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => PageTurnTransition;
};

let activePageTurn: PageTurnTransition | null = null;

// A chapter boundary loads a new document. The old page is held for it, but
// never long enough to leave the reader frozen if the turn fails to report.
const PAGE_TURN_MAX_HOLD_MS = 1500;

// The fold leans this share of the page's width either side of its middle,
// and the curled-over paper is drawn this much narrower than what it hides,
// as paper bending round shows less than its length. The stylesheet's
// keyframes cut the page along the same line.
const PAGE_CURL_LEAN = 0.07;
const PAGE_CURL_SHOWN = 0.8;
// How far the fold travels over a whole turn, as a share of the page's width:
// from just outside the free edge to just past the spine. A dragged turn
// keeps the fold this far along for a finger moved one page width.
const PAGE_CURL_TRAVEL = 1.16;

function pageTurnDocument(stage: HTMLElement): PageTurnDocument | null {
  const document = stage.ownerDocument as PageTurnDocument;
  const view = document.defaultView;
  return typeof document.startViewTransition === "function" && view
    && !view.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? document
    : null;
}

/**
 * Starts the transition a turn plays in. `turn` runs once the page as it was
 * has been captured; the motion begins when it reports the new page in place.
 */
function startPageTurn(
  document: PageTurnDocument,
  stage: HTMLElement,
  direction: PageTurnDirection,
  dragged: boolean,
  turn: () => PromiseLike<unknown> | null | undefined
): PageTurnTransition {
  const view = document.defaultView!;
  const root = document.documentElement;
  // The curl is drawn by the transition, which cannot see the reader's theme
  // or the page's shape. Hand it the paper colour, the angle of the lean, and
  // how far the folded-over paper moves for each percent the fold travels:
  // it is the page mirrored in the fold line, which is a fixed turn plus a
  // shift that grows with the fold's distance from the free edge.
  const page = stage.getBoundingClientRect();
  const lean = page.height > 0 ? Math.atan((2 * PAGE_CURL_LEAN * page.width) / page.height) : 0;
  const reach = 1 + PAGE_CURL_SHOWN;
  root.style.setProperty("--page-turn-lean", `${(lean * 180 / Math.PI).toFixed(3)}deg`);
  root.style.setProperty("--page-turn-across", (reach * Math.cos(lean) ** 2).toFixed(4));
  root.style.setProperty("--page-turn-down", `${(reach * Math.sin(lean) * Math.cos(lean) * page.width / 100).toFixed(3)}px`);
  root.style.setProperty("--page-turn-paper", view.getComputedStyle(stage).backgroundColor);
  root.dataset.pageTurn = direction;
  // A dragged turn is held still by the stylesheet and moved by the finger.
  if (dragged) {
    root.dataset.pageTurnDrag = "";
  } else {
    delete root.dataset.pageTurnDrag;
  }
  const transition = document.startViewTransition!(async () => {
    let hold = 0;
    try {
      await Promise.race([
        turn(),
        new Promise((resolve) => { hold = view.setTimeout(resolve, PAGE_TURN_MAX_HOLD_MS); })
      ]);
    } catch {
      // The page stays where it is; there is nothing to animate.
    } finally {
      view.clearTimeout(hold);
    }
  });
  activePageTurn = transition;
  const cleanUp = () => {
    // A second turn started mid-flight owns the attributes now.
    if (activePageTurn !== transition) return;
    activePageTurn = null;
    delete root.dataset.pageTurn;
    delete root.dataset.pageTurnDrag;
    root.style.removeProperty("--page-turn-lean");
    root.style.removeProperty("--page-turn-across");
    root.style.removeProperty("--page-turn-down");
    root.style.removeProperty("--page-turn-paper");
  };
  void transition.finished.then(cleanUp, cleanUp);
  return transition;
}

/**
 * Turns the page as paper: it peels back from its free edge along a leaning
 * fold, its pale underside folded over the part still lying flat, until the
 * page beneath is uncovered; turning back, it unfolds onto the page again.
 * The direction is published as `data-page-turn` for the stylesheet.
 *
 * epub.js turns a page by jumping its scroll position and then measures the
 * page to report the reading place. Moving the page itself would shift those
 * measurements mid-turn and could save the wrong place, so the motion plays
 * on view-transition snapshots while the real page is already where it ends.
 *
 * The page turns immediately, with no motion, when reduced motion is on or
 * the web view has no view transitions.
 */
export function runPageTurn(
  stage: HTMLElement,
  direction: PageTurnDirection,
  turn: () => PromiseLike<unknown> | null | undefined
): void {
  const document = pageTurnDocument(stage);
  if (!document) {
    void turn();
    return;
  }
  startPageTurn(document, stage, direction, false, turn);
}

/** Whether a turn here plays with motion; without it there is nothing to drag. */
export function pageTurnAnimates(stage: HTMLElement): boolean {
  return pageTurnDocument(stage) !== null;
}

export type PageTurnDrag = {
  /** The finger's travel in the turn's direction, as a share of the page width. */
  move(share: number): void;
  /** The finger lifts: the turn completes, or the page is laid back down. */
  release(complete: boolean): void;
};

/**
 * Begins a turn that follows the finger: the fold sits where the finger has
 * dragged it until the finger lifts, then runs on to finish the turn or back
 * to lay the page down again.
 *
 * The snapshots need the next page to exist, so the reader turns as the drag
 * begins and `undo` turns it back if the page is put down. The page as it was
 * stays over the reader until that is done, so nothing of it shows.
 *
 * Returns null, having done nothing, where a turn would play without motion.
 */
export function beginPageTurnDrag(
  stage: HTMLElement,
  direction: PageTurnDirection,
  turn: () => PromiseLike<unknown> | null | undefined,
  undo: () => PromiseLike<unknown> | null | undefined
): PageTurnDrag | null {
  const document = pageTurnDocument(stage);
  if (!document) return null;
  const view = document.defaultView!;

  let progress = 0;
  let animations: Animation[] | null = null;
  let released: boolean | null = null;
  let settling = false;
  let turned = false;

  const show = () => {
    for (const animation of animations ?? []) {
      const duration = Number(animation.effect?.getComputedTiming().duration) || 0;
      animation.currentTime = progress * duration;
    }
  };
  const settle = () => {
    if (settling || released === null || animations === null) return;
    settling = true;
    const complete = released;
    const finish = async () => {
      if (!complete && turned) {
        try {
          await Promise.race([
            undo(),
            new Promise((resolve) => { view.setTimeout(resolve, PAGE_TURN_MAX_HOLD_MS); })
          ]);
        } catch {
          // The reader is left on the page it turned to.
        }
        // The reader redraws the page a frame after it reports the turn.
        await new Promise((resolve) => { view.requestAnimationFrame(resolve); });
      }
      transition.skipTransition();
    };
    const from = progress;
    const to = complete ? 1 : 0;
    const duration = animations.length ? 140 + 280 * Math.abs(to - from) : 0;
    const startedAt = view.performance.now();
    const step = () => {
      const elapsed = duration > 0 ? Math.min(1, (view.performance.now() - startedAt) / duration) : 1;
      progress = from + (to - from) * (1 - (1 - elapsed) ** 3);
      show();
      if (elapsed < 1) {
        view.requestAnimationFrame(step);
      } else {
        void finish();
      }
    };
    step();
  };

  const transition = startPageTurn(document, stage, direction, true, () => {
    turned = true;
    return turn();
  });
  transition.ready.then(
    () => {
      animations = document.getAnimations().filter((animation) =>
        (animation.effect as KeyframeEffect | null)?.pseudoElement?.includes("(reader-page"));
      for (const animation of animations) animation.pause();
      show();
      settle();
    },
    () => {
      // The transition was abandoned before it could draw; nothing to move.
      animations = [];
      settle();
    }
  );

  return {
    move(share) {
      if (released !== null) return;
      progress = Math.max(0, Math.min(1, share / PAGE_CURL_TRAVEL));
      show();
    },
    release(complete) {
      if (released !== null) return;
      released = complete;
      settle();
    }
  };
}
