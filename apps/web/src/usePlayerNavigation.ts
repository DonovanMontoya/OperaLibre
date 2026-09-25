import { flushSync } from "react-dom";
import type { Book } from "./types";
import { haptic } from "./native";
import type { NativePlayerSheet } from "./PlayerSheets";
import { isLeftEdgeBackSwipe } from "./nativeNavigation";
import type { NativeTab } from "./nativeTabs";
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
  showChapterJumpTop,
  trackListSectionRef
}: {
  bookDetailsSwipeStartRef: RefObject<{ clientX: number; clientY: number; } | null>;
  books: Book[];
  changeShelfLayout: (next: ShelfLayout) => void;
  chaptersOpen: boolean;
  gamesEnabled: boolean;
  isViewingPlayingBook: boolean;
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
  showChapterJumpTop: boolean;
  trackListSectionRef: RefObject<HTMLElement | null>;
}) {
  // On the web, changing books or returning to Now Playing reshapes the page
  // as one surface, the way the Duo's posture changes do, with the cover
  // carried across. The native shells keep their own navigation motion.
  function withWebViewTransition(update: () => void) {
    const transitionDocument = document as Document & {
      startViewTransition?: (callback: () => void | Promise<void>) => unknown;
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
    transitionDocument.startViewTransition(async () => {
      flushSync(update);
      // The old page has already been captured, so jumping is invisible;
      // a smooth scroll would instead drag the new page while it fades in.
      showNewPageFromTop();
      await coverPainted(playerPaneRef.current);
    });
  }

  function showNewPageFromTop() {
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function selectBook(book: Book) {
    if (shelfLayout === "library") changeShelfLayout("split");
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
    if (shelfLayout === "library") changeShelfLayout("split");
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
    if (shelfLayout === "library") changeShelfLayout("split");
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
    if (tab === "shelf" && nativeTab === "shelf" && librarySource !== "local") {
      showYourLibrary();
    }
    // Reading belongs to the playing book. A book browsed from the shelf stays
    // selected after its details page closes and must not follow into the tab.
    if (tab === "reading") {
      if (shelfLayout === "library") changeShelfLayout("split");
      if (playbackBook) setSelectedBookId(playbackBook.id);
    }
    setNativeTab(tab);
    if (tab === "reading" || tab === "shelf") setNativePlayerView("now");
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
function coverPainted(pane: HTMLElement | null) {
  const covers = [...(pane?.querySelectorAll<HTMLImageElement>("img.large-cover") ?? [])];
  if (covers.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(covers.map((cover) => cover.decode().catch(() => undefined))).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 200))
  ]);
}
