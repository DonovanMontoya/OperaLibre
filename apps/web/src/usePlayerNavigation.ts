import { flushSync } from "react-dom";
import type { Book } from "./types";
import { haptic } from "./native";
import type { NativePlayerSheet } from "./PlayerSheets";
import { isLeftEdgeBackSwipe } from "./nativeNavigation";
import { type NativeTab, shelfRetapped, spreadTab } from "./nativeTabs";
import { writeGamesEnabled } from "./gamePreferences";
import type { LibrarySource, ShelfLayout } from "./shelfSort";
import type { Dispatch, RefObject, SetStateAction } from "react";


export function usePlayerNavigation({
  bookDetailsSwipeStartRef,
  books,
  changeShelfLayout,
  chaptersOpen,
  gamesEnabled,
  isViewingPlayingBook,
  libraryPaneRef,
  librarySource,
  native,
  nativePlayerView,
  nativeTab,
  playbackBook,
  playerPaneRef,
  setChaptersOpen,
  setGamesEnabled,
  setLibrarySource,
  setNativePlayerSheet,
  setNativePlayerView,
  setNativeTab,
  setSelectedBookId,
  setShowChapterJumpTop,
  shelfLayout,
  shelfSpread,
  showChapterJumpTop,
  trackListSectionRef
}: {
  bookDetailsSwipeStartRef: RefObject<{ clientX: number; clientY: number; } | null>;
  books: Book[];
  changeShelfLayout: (next: ShelfLayout, animate?: boolean, update?: () => void) => void;
  chaptersOpen: boolean;
  gamesEnabled: boolean;
  isViewingPlayingBook: boolean;
  libraryPaneRef: RefObject<HTMLElement | null>;
  librarySource: LibrarySource;
  native: boolean;
  nativePlayerView: "details" | "now" | "chapters";
  nativeTab: NativeTab;
  playbackBook: Book | null;
  playerPaneRef: RefObject<HTMLElement | null>;
  setChaptersOpen: Dispatch<SetStateAction<boolean>>;
  setGamesEnabled: Dispatch<SetStateAction<boolean>>;
  setLibrarySource: Dispatch<SetStateAction<LibrarySource>>;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
  setNativePlayerView: Dispatch<SetStateAction<"details" | "now" | "chapters">>;
  setNativeTab: Dispatch<SetStateAction<NativeTab>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
  setShowChapterJumpTop: Dispatch<SetStateAction<boolean>>;
  shelfLayout: ShelfLayout;
  shelfSpread: boolean;
  showChapterJumpTop: boolean;
  trackListSectionRef: RefObject<HTMLElement | null>;
}) {
  // On the web, changing books or returning to Now Playing reshapes the page
  // as one surface, the way the Duo's posture changes do, with the cover
  // carried across. The native shells keep their own navigation motion.
  // Giving the Shelf the whole window, or the reading room its place back,
  // is a change of layout rather than a turn of the page. While
  // `data-web-shelf-resize` names the direction, the stylesheet uncovers
  // the wider shelf from the narrower one's edge (the two widths are
  // published as custom properties), the player page recedes behind it,
  // and the covers on screen travel to their new places on the shelf.
  function withWebViewTransition(update: () => void, { shelfResize = null as "open" | "close" | null } = {}) {
    const transitionDocument = document as Document & {
      startViewTransition?: (callback: () => void | Promise<void>) => { finished: Promise<unknown> };
    };
    if (
      native
      || !transitionDocument.startViewTransition
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      update();
      showNewPageFromTop();
      return;
    }
    // The page's sections rise in one after another when the app first
    // loads. Replayed inside a page turn they would still be arriving after
    // the turn has finished, and the heading — cover and all — would blink
    // in behind the cover that has just landed. From the first turn on, the
    // turn is the only motion.
    document.documentElement.dataset.webPageTurned = "";
    const root = document.documentElement;
    // WebKit does not carry a view transition of this size at frame rate: it
    // paints the live wall again on every frame and stalls into place. There
    // the layout changes at once and the arriving panes settle in with plain
    // animations, as the Shelf's popup does, under `data-web-shelf-arrive`.
    if (shelfResize && webkitBrowser()) {
      update();
      showNewPageFromTop();
      root.dataset.webShelfArrive = shelfResize;
      const pane = document.querySelector(".web-shell > .library-pane");
      const settle = () => {
        window.clearTimeout(fallback);
        delete root.dataset.webShelfArrive;
      };
      const fallback = window.setTimeout(settle, 600);
      pane?.addEventListener("animationend", settle, { once: true });
      return;
    }
    const shelfWidth = () => `${document.querySelector(".web-shell > .library-pane")?.getBoundingClientRect().width ?? 0}px`;
    const travelling = shelfResize ? nameShelfCoversOnScreen() : null;
    if (shelfResize) {
      root.dataset.webShelfResize = shelfResize;
      root.style.setProperty("--web-shelf-from", shelfWidth());
    }
    const transition = transitionDocument.startViewTransition(async () => {
      flushSync(update);
      // The old page has already been captured, so jumping is invisible;
      // a smooth scroll would instead drag the new page while it fades in.
      showNewPageFromTop();
      if (travelling) {
        nameShelfCoversOnScreen(travelling);
        root.style.setProperty("--web-shelf-to", shelfWidth());
      }
      // The wider shelf brings covers on screen that were never fetched,
      // and a wall captured before they arrive shows empty tiles that fill
      // in with a jolt once the motion ends.
      await Promise.all([coverPainted(playerPaneRef.current), travelling ? shelfCoversPainted() : undefined]);
    });
    if (shelfResize) {
      const settle = () => {
        delete root.dataset.webShelfResize;
        root.style.removeProperty("--web-shelf-from");
        root.style.removeProperty("--web-shelf-to");
        clearShelfCoverNames();
      };
      void transition.finished.then(settle, settle);
    }
  }

  function showNewPageFromTop() {
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function selectBook(book: Book) {
    showPlayer(() => selectBookOnPage(book));
  }

  // Keep the route and selection on the old page until its snapshot is taken.
  // Otherwise the destination player can paint before its slide begins.
  function showPlayer(update: () => void) {
    if (shelfLayout === "library") changeShelfLayout("split", true, update);
    else update();
  }

  function selectBookOnPage(book: Book) {
    setSelectedBookId(book.id);
    setNativePlayerView(book.id === playbackBook?.id ? "now" : "details");
    if (native) {
      setChaptersOpen(book.id === playbackBook?.id && book.chapters.length > 0);
      setShowChapterJumpTop(false);
      setNativeTab("shelf");
      setNativePlayerView("details");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function openBookDetails(bookId: string) {
    showPlayer(() => openBookDetailsOnPage(bookId));
  }

  function openBookDetailsOnPage(bookId: string) {
    setSelectedBookId(bookId);
    setNativePlayerView("details");
    if (native) {
      const book = books.find((candidate) => candidate.id === bookId);
      setChaptersOpen(bookId === playbackBook?.id && !!book?.chapters.length);
      setShowChapterJumpTop(false);
      haptic("light");
      setNativeTab("shelf");
      setNativePlayerView("details");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function returnToLibrary() {
    haptic("light");
    setNativePlayerView("now");
  }

  function openNativePlayerSheet(sheet: Exclude<NativePlayerSheet, null>) {
    haptic("light");
    setNativePlayerSheet(sheet);
  }

  function closeNativePlayerSheet() {
    haptic("light");
    setNativePlayerSheet(null);
  }

  function beginBookDetailsBackSwipe(event: React.TouchEvent<HTMLElement>) {
    if (!native || nativeTab !== "shelf" || nativePlayerView !== "details") {
      return;
    }
    const touch = event.touches[0];
    bookDetailsSwipeStartRef.current = touch
      ? { clientX: touch.clientX, clientY: touch.clientY }
      : null;
  }

  function finishBookDetailsBackSwipe(event: React.TouchEvent<HTMLElement>) {
    const start = bookDetailsSwipeStartRef.current;
    bookDetailsSwipeStartRef.current = null;
    const touch = event.changedTouches[0];
    if (
      native
      && nativeTab === "shelf"
      && nativePlayerView === "details"
      && start
      && touch
      && isLeftEdgeBackSwipe(start, touch)
    ) {
      returnToLibrary();
    }
  }

  function openPlaybackView(view: "now" | "details" | "chapters") {
    showPlayer(() => openPlaybackViewOnPage(view));
  }

  function openPlaybackViewOnPage(view: "now" | "details" | "chapters") {
    if (playbackBook) {
      setSelectedBookId(playbackBook.id);
    }
    setNativeTab("reading");
    setNativePlayerView(view);
    if (view === "chapters") {
      setChaptersOpen(true);
    }
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }

  function scrollToPlayer() {
    if (native) {
      haptic("light");
      openPlaybackView("now");
      return;
    }
    withWebViewTransition(() => {
      if (playbackBook) {
        setSelectedBookId(playbackBook.id);
      }
      setNativePlayerView("now");
    });
  }

  function handlePlayerPaneScroll(event: React.UIEvent<HTMLElement>) {
    if (!native || nativeTab !== "shelf" || nativePlayerView !== "details" || !chaptersOpen || !isViewingPlayingBook) {
      if (showChapterJumpTop) setShowChapterJumpTop(false);
      return;
    }
    const sectionTop = trackListSectionRef.current?.offsetTop ?? Number.POSITIVE_INFINITY;
    const threshold = sectionTop + 140;
    const shouldShow = event.currentTarget.scrollTop > threshold;
    if (shouldShow !== showChapterJumpTop) setShowChapterJumpTop(shouldShow);
  }

  function jumpToPlayerTop() {
    haptic("light");
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setShowChapterJumpTop(false);
  }

  function showYourLibrary() {
    setLibrarySource("local");
  }

  function openNativeTab(tab: NativeTab) {
    if (tab === "games" && !gamesEnabled) return;
    haptic("light");
    // Re-tapping the active Shelf tab is an escape hatch from the Audible
    // catalogue back to the listener's own library.
    if (tab === "shelf" && spreadTab(nativeTab, shelfSpread, shelfLayout) === "shelf" && librarySource !== "local") {
      showYourLibrary();
    }
    if (shelfRetapped(tab, nativeTab, shelfSpread, shelfLayout, nativePlayerView)) {
      libraryPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
    // Reading belongs to the playing book. A book browsed from the shelf stays
    // selected after its details page closes and must not follow into the tab.
    const update = () => {
      if (tab === "reading" && playbackBook) setSelectedBookId(playbackBook.id);
      setNativeTab(tab);
      if (tab === "reading" || tab === "shelf") setNativePlayerView("now");
    };
    if (tab === "shelf" && shelfSpread) changeShelfLayout("library", true, update);
    else if (tab === "reading") showPlayer(update);
    else update();
  }

  function toggleGamesEnabled() {
    const enabled = !gamesEnabled;
    writeGamesEnabled(enabled);
    setGamesEnabled(enabled);
    if (!enabled && nativeTab === "games") setNativeTab("shelf");
  }

  return {
    beginBookDetailsBackSwipe,
    closeNativePlayerSheet,
    finishBookDetailsBackSwipe,
    handlePlayerPaneScroll,
    jumpToPlayerTop,
    openBookDetails,
    openNativePlayerSheet,
    openNativeTab,
    openPlaybackView,
    returnToLibrary,
    scrollToPlayer,
    selectBook,
    showYourLibrary,
    toggleGamesEnabled,
    withWebViewTransition
  };
}

/**
 * Resolves once the page's large cover can be drawn, so the page turn
 * captures the new cover rather than an empty frame that fills in once the
 * turn has ended. A slow image is not worth holding the turn for: after a
 * moment the turn goes ahead and the cover arrives as it would have anyway.
 */
// A shelf resize carries each cover on screen to its new place on the other
// shelf. The rest of the collection, which the viewer cannot see, is left
// out of the snapshot, so a large library costs no more than a small one.
// After the update only the covers captured before it are named again: a
// cover with no place on the old shelf stays part of the wall and is
// uncovered with it, instead of arriving ahead of it over the reading room.
function nameShelfCoversOnScreen(among?: Set<string>): Set<string> {
  clearShelfCoverNames();
  const named = new Set<string>();
  const viewport = window.innerHeight;
  for (const row of document.querySelectorAll<HTMLElement>(".book-list .book-row[data-book-id]")) {
    const id = row.dataset.bookId ?? "";
    if (among && !among.has(id)) continue;
    const cover = row.querySelector<HTMLElement>(":scope > .cover-mark");
    if (!cover) continue;
    const box = cover.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= viewport) continue;
    cover.style.viewTransitionName = `shelf-cover-${id}`;
    named.add(id);
  }
  return named;
}

// Desktop Chromium also advertises AppleWebKit; see playbackGain.ts.
function webkitBrowser() {
  const ua = window.navigator?.userAgent ?? "";
  return /AppleWebKit/i.test(ua) && !/(?:Chrome|Chromium)\//i.test(ua);
}

function clearShelfCoverNames() {
  for (const cover of document.querySelectorAll<HTMLElement>(".book-list .cover-mark[style*='view-transition-name']")) {
    cover.style.viewTransitionName = "";
  }
}

function coverPainted(pane: HTMLElement | null) {
  return decoded([...(pane?.querySelectorAll<HTMLImageElement>("img.large-cover") ?? [])]);
}

function shelfCoversPainted() {
  const viewport = window.innerHeight;
  const covers = [...document.querySelectorAll<HTMLImageElement>(".book-list img.cover-mark")].filter((cover) => {
    const box = cover.getBoundingClientRect();
    return box.bottom > 0 && box.top < viewport;
  });
  return decoded(covers);
}

// Waits for the covers' pixels, but never long enough to be felt.
function decoded(covers: HTMLImageElement[]) {
  if (covers.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(covers.map((cover) => cover.decode().catch(() => undefined))).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 200))
  ]);
}
