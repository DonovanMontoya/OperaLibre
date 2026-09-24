import { isBookPosture, useDeviceFold } from "./deviceFold";
import { attachEpubReadArchive, prepareEpubRead } from "./streamingEpub";
import { Capacitor } from "@capacitor/core";
import { classifyPageGesture, narrationTextOffset, pageTurnAtEdge } from "./readerPagination";
import { type AnnotationStore, type MarkedView, pruneUntrackedHighlights, removeHighlight } from "./readerAnnotations";
import {
  ALargeSmall,
  ChevronLeft,
  ChevronRight,
  List,
  ListMusic,
  LocateFixed,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Timer,
  Undo2,
  X
} from "lucide-react";
import type { Contents, Book as EpubBook, EpubCFI, Location, NavItem, Rendition } from "epubjs";
import {
  anchorAfterRelocation,
  anchorOnPage,
  findActiveFragmentIndex,
  findTocHrefForChapterTitle,
  hrefsMatch,
  normalizeSyncNeedle,
  readerStorageKey,
  repeatedNarratedPageTurn,
  shouldOpenPlayingChapter
} from "./readalong";
import {
  applyReaderThemeColors,
  currentAppPrefersDark,
  READER_THEME_CHOICES,
  type ReaderTheme,
  type ReaderThemeChoice,
  readReaderThemeChoice,
  resolveReaderTheme,
  watchAppPrefersDark,
  writeReaderThemeChoice
} from "./readerTheme";
import { readerDebugLog, shortCfi } from "./readerDebug";
import {
  READER_FONT_SCALE_MAX,
  READER_FONT_SCALE_MIN,
  readerFontScaleBucket,
  readStoredFontScale
} from "./readerFontScale";
import { canCatchUp, resolveListeningCfi } from "./readerCatchUp";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SyncFragment } from "./types";
import { readStoredValue, writeStoredValue } from "./appStorage";
import { useLandscapeOrientation, useWideSpreadWindow } from "./useOrientation";

function flattenToc(items: NavItem[], depth = 0): Array<NavItem & { depth: number }> {
  return items.flatMap((item) => [
    { ...item, depth },
    ...flattenToc(item.subitems ?? [], depth + 1)
  ]);
}

type EpubSyncTarget = {
  id: string;
  title: string;
};

type DocumentSearchIndex = {
  doc: Document;
  text: string;
  map: Array<{ node: Text; offset: number }>;
};

function buildDocumentSearchIndex(doc: Document): DocumentSearchIndex {
  const pieces: string[] = [];
  const map: Array<{ node: Text; offset: number }> = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let lastWasSpace = true;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const data = textNode.data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const ch = data[offset];
      if (ch === "\u00AD") {
        continue;
      }
      if (/\s/.test(ch)) {
        if (!lastWasSpace) {
          pieces.push(" ");
          map.push({ node: textNode, offset });
          lastWasSpace = true;
        }
      } else {
        for (const lower of ch.toLowerCase()) {
          pieces.push(lower);
          map.push({ node: textNode, offset });
        }
        lastWasSpace = false;
      }
    }
  }
  return { doc, text: pieces.join(""), map };
}

function findRangeInSearchIndex(index: DocumentSearchIndex, needle: string, fromOffset: number) {
  if (!needle) {
    return null;
  }
  let at = index.text.indexOf(needle, Math.min(fromOffset, index.text.length));
  if (at === -1) {
    at = index.text.indexOf(needle);
  }
  if (at === -1) {
    return null;
  }
  const start = index.map[at];
  const end = index.map[at + needle.length - 1];
  if (!start || !end) {
    return null;
  }
  const range = index.doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, Math.min(end.offset + 1, end.node.data.length));
  return { range, endOffset: at + needle.length };
}

type FragmentRange = { index: number; start: number; end: number };

/**
 * Where every fragment of the displayed document sits in its search index,
 * found in order so a repeated sentence lands on its own occurrence. Sorted
 * by position so a tap can be resolved with one scan.
 */
function locateFragments(index: DocumentSearchIndex, fragments: SyncFragment[], href: string): FragmentRange[] {
  const ranges: FragmentRange[] = [];
  let cursor = 0;
  fragments.forEach((fragment, position) => {
    if (!hrefsMatch(href, fragment.href)) {
      return;
    }
    const needle = normalizeSyncNeedle(fragment.text);
    if (!needle) {
      return;
    }
    let at = index.text.indexOf(needle, cursor);
    if (at === -1) {
      at = index.text.indexOf(needle);
      if (at === -1) {
        return;
      }
    }
    ranges.push({ index: position, start: at, end: at + needle.length });
    cursor = at + needle.length;
  });
  return ranges.sort((a, b) => a.start - b.start);
}

/** The fragment a tap at `position` belongs to: the last one that starts at or before it. */
function fragmentAtIndexPosition(ranges: FragmentRange[], position: number) {
  let best = -1;
  for (const range of ranges) {
    if (range.start > position) {
      break;
    }
    best = range.index;
  }
  return best;
}

/** The search-index position of a caret inside a text node, or -1. */
function indexPositionForCaret(index: DocumentSearchIndex, node: Node, offset: number) {
  if (node.nodeType !== Node.TEXT_NODE) {
    // A caret on an element: use its first text node.
    const walker = index.doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    if (!first) {
      return -1;
    }
    node = first;
    offset = 0;
  }
  let last = -1;
  for (let position = 0; position < index.map.length; position += 1) {
    const entry = index.map[position];
    if (entry.node !== node) {
      continue;
    }
    if (entry.offset >= offset) {
      return position;
    }
    last = position;
  }
  return last;
}

/** Whether a point lies on one of the text node's line boxes (with a little slack). */
function pointOnText(node: Node, x: number, y: number): boolean {
  const doc = node.ownerDocument;
  if (!doc || node.nodeType !== Node.TEXT_NODE) {
    return false;
  }
  const range = doc.createRange();
  range.selectNodeContents(node);
  const slack = 6;
  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left - slack && x <= rect.right + slack && y >= rect.top - slack && y <= rect.bottom + slack) {
      return true;
    }
  }
  return false;
}

/** The text position under a point in the reader document, on any browser. */
function caretAtPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const withCaret = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof withCaret.caretPositionFromPoint === "function") {
    const caret = withCaret.caretPositionFromPoint(x, y);
    return caret ? { node: caret.offsetNode, offset: caret.offset } : null;
  }
  if (typeof withCaret.caretRangeFromPoint === "function") {
    const range = withCaret.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** Marker colours for the narrated sentence, per reading theme. */
function sentenceHighlightStyle(theme: ReaderTheme) {
  // The night page is dark, so the marker must lighten instead of darken.
  return theme === "night"
    ? { fill: "#e8b64c", "fill-opacity": "0.4", "mix-blend-mode": "screen" }
    : { fill: "#d9a441", "fill-opacity": "0.32", "mix-blend-mode": "multiply" };
}

/** Erases narrated-sentence marks that a relayout drew twice and orphaned. */
function pruneReadalongMarks(rendition: Rendition) {
  const views = rendition.views() as unknown as MarkedView[] | { all(): MarkedView[] };
  pruneUntrackedHighlights(Array.isArray(views) ? views : views.all(), "readalong-highlight");
}

export function EpubReadalong({
  bookId,
  storageScope,
  title,
  url,
  loadSource,
  loadCachedSource,
  loadWholeFile,
  listeningChapter,
  syncTarget,
  syncFragments,
  positionSeconds,
  followLeadSeconds = 0,
  onSeekTo,
  immersive = false,
  onClose,
  chapterTitle = null,
  positionLabel = null,
  playback = null,
  onListen,
  syncTools = null,
  companionSwitcher = null
}: {
  bookId: string;
  storageScope: string;
  title: string;
  url: string;
  /** Reads the ebook, from the device when a copy is already there. */
  loadSource?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer | string>;
  loadCachedSource?: (signal?: AbortSignal) => Promise<ArrayBuffer | null>;
  loadWholeFile?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  listeningChapter: string | null;
  syncTarget: EpubSyncTarget | null;
  syncFragments: SyncFragment[] | null;
  positionSeconds: number;
  /** A small optional lead for switching to the next narrated sentence. */
  followLeadSeconds?: number;
  onSeekTo?: (seconds: number) => void;
  /** A full-screen reading surface with its own bars and sheets (the native app). */
  immersive?: boolean;
  onClose?: () => void;
  chapterTitle?: string | null;
  positionLabel?: string | null;
  /** Transport for the book being read, when it is the one playing. */
  playback?: {
    playing: boolean;
    speed: number;
    sleepRemaining: number;
    onToggle: () => void;
    onSkip: (delta: number) => void;
    /** Open the app's speed, sleep timer, or chapter sheet over the reader. */
    onOpen: (sheet: "speed" | "sleep" | "chapters") => void;
  } | null;
  /** Start playing this book, offered when it is not the one playing. */
  onListen?: () => void;
  /** App-level sync actions and notices, shown in the appearance sheet. */
  syncTools?: ReactNode;
  /** Switcher for the book's other files, shown in the contents sheet. */
  companionSwitcher?: ReactNode;
}) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const syncedTargetRef = useRef<string | null>(null);
  const epubCfiClassRef = useRef<typeof EpubCFI | null>(null);
  const searchIndexRef = useRef<DocumentSearchIndex | null>(null);
  const searchCursorRef = useRef(0);
  const fragmentRangesRef = useRef<{ doc: Document; href: string; ranges: FragmentRange[] } | null>(null);
  const highlightCfiRef = useRef<string | null>(null);
  const narratedRangeRef = useRef<{ index: DocumentSearchIndex; start: number; length: number; contents: Contents } | null>(null);
  const highlightThemeRef = useRef<ReaderTheme | null>(null);
  const highlightedFragmentRef = useRef(-1);
  const autoNavHrefRef = useRef<string | null>(null);
  const lastLocationRef = useRef<Location | null>(null);
  const locationRef = useRef<Location | null>(null);
  // The place being read, as a CFI: what the reader reopens to and turns
  // back to after a resize or reflow. It only moves once its page has gone
  // off screen, so a relayout that starts the same page a few words earlier
  // does not walk the remembered place backwards on every reopen.
  const anchorCfiRef = useRef<string | null>(null);
  // Chapter following clears the old CFI before epub.js reports the new one.
  // Relayouts in that gap must keep the requested chapter as their target.
  const pendingChapterHrefRef = useRef<string | null>(null);
  const pendingFollowTargetRef = useRef<{
    target: { href: string } | { cfi: string };
    retried: boolean;
  } | null>(null);
  // While the reader is putting the page back where it was — opening the
  // book, or laying it out again after a resize or a text-size change — it
  // passes through the pages between the top of the chapter and the
  // remembered place. Until it arrives, those pages must not be mistaken
  // for somewhere the listener turned to.
  const restoringUntilRef = useRef(0);
  // Set once the listener turns a page themselves: the reader stops putting
  // the page back and follows them instead.
  const handNavigatedRef = useRef(false);
  const readerNavigationVersionRef = useRef(0);
  const beginRestore = useCallback(() => {
    // A deadline, so a place that never resolves cannot freeze the anchor.
    restoringUntilRef.current = performance.now() + 5000;
  }, []);
  const syncFragmentsRef = useRef<SyncFragment[] | null>(syncFragments);
  const syncTargetRef = useRef<EpubSyncTarget | null>(syncTarget);
  const onSeekToRef = useRef(onSeekTo);
  const loadSourceRef = useRef(loadSource);
  const loadCachedSourceRef = useRef(loadCachedSource);
  const loadWholeFileRef = useRef(loadWholeFile);
  // Bumped whenever the page reflows (text size, zoom, window resize): the
  // markers were measured against the old layout and the narrated sentence
  // may have moved to another page.
  const [relayoutTick, setRelayoutTick] = useState(0);
  const handledRelayoutRef = useRef(0);
  const attachedDocsRef = useRef<WeakSet<Document>>(new WeakSet());
  const touchStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  // When a tap was handled on touchend, the click iOS may still send for it
  // must not be handled again.
  const lastTouchTapRef = useRef(0);
  const readerUrlRef = useRef(url);
  if (readerUrlRef.current !== url) {
    readerUrlRef.current = url;
    lastLocationRef.current = null;
    anchorCfiRef.current = null;
    pendingChapterHrefRef.current = null;
    pendingFollowTargetRef.current = null;
    restoringUntilRef.current = 0;
    handNavigatedRef.current = false;
  }
  syncFragmentsRef.current = syncFragments;
  syncTargetRef.current = syncTarget;
  onSeekToRef.current = onSeekTo;
  loadSourceRef.current = loadSource;
  loadCachedSourceRef.current = loadCachedSource;
  loadWholeFileRef.current = loadWholeFile;
  const [toc, setToc] = useState<Array<NavItem & { depth: number }>>([]);
  const [location, setLocation] = useState<Location | null>(null);
  const [activeHref, setActiveHref] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  // The book is still downloading or unpacking after a while: worth a word
  // to the listener, never a reason to give up on a slow connection.
  const [slowToOpen, setSlowToOpen] = useState(false);
  const [follow, setFollowState] = useState(() => readStoredValue("operalibre.readerFollow") !== "0");
  // Bumped when the listener explicitly asks to return. Follow may already be
  // on, so setting the same boolean is not enough to rerun navigation.
  const [followRequest, setFollowRequest] = useState(0);
  // Follow as of the latest decision rather than the latest render. A page
  // turned by hand stops following at once; an effect still holding the
  // rendered value must not move the page back before React catches up.
  const followRef = useRef(follow);
  // The page a narration turn last left from, and where it was sent. When
  // epub.js lands on that same page again the sentence sits on a page
  // boundary it cannot show, and asking again would only redraw the page on
  // every position update.
  const lastKeepRef = useRef<{ cfi: string; from: string; layout: number } | null>(null);
  const setFollow = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    if (typeof value === "boolean") {
      followRef.current = value;
    }
    setFollowState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      followRef.current = next;
      writeStoredValue("operalibre.readerFollow", next ? "1" : "0");
      return next;
    });
  }, []);
  const [readerThemeChoice, setReaderThemeChoice] = useState<ReaderThemeChoice>(() =>
    readReaderThemeChoice()
  );
  // Whether the app is in its dark look, for the auto theme; follows the
  // system theme and the iOS appearance setting while the reader is open.
  const [appDark, setAppDark] = useState(currentAppPrefersDark);
  useEffect(() => watchAppPrefersDark(setAppDark), []);
  const readerTheme = resolveReaderTheme(readerThemeChoice, appDark);
  // Held open like a book, the reader sets a page on each half, the gap
  // between them on the fold. The change re-lays the chapter out, so it turns
  // back to the remembered place the way a resize does.
  const deviceFold = useDeviceFold();
  const readerLandscape = useLandscapeOrientation();
  const fontScaleBucket = readerFontScaleBucket(
    deviceFold.posture,
    readerLandscape ? "landscape" : "portrait"
  );
  const [fontScale, setFontScale] = useState(() => readStoredFontScale(fontScaleBucket, readStoredValue));
  // The look a freshly opened book is styled with, and what the open one has
  // been given so far, so a change re-styles it exactly once.
  const readerThemeRef = useRef(readerTheme);
  readerThemeRef.current = readerTheme;
  const fontScaleRef = useRef(fontScale);
  fontScaleRef.current = fontScale;
  const appliedThemeRef = useRef<ReaderTheme | null>(null);
  const appliedFontScaleRef = useRef<number | null>(null);
  const fontScaleBucketRef = useRef(fontScaleBucket);
  const fontScaleBucketChanged = fontScaleBucketRef.current !== fontScaleBucket;
  // Closing, opening, or rotating swaps to that layout's remembered size,
  // rather than carrying whatever size the other layout was left at.
  useEffect(() => {
    if (fontScaleBucketRef.current === fontScaleBucket) return;
    fontScaleBucketRef.current = fontScaleBucket;
    setFontScale(readStoredFontScale(fontScaleBucket, readStoredValue));
  }, [fontScaleBucket]);
  const [focusMode, setFocusMode] = useState(false);
  // Full screen: the native reader always, the web reader in focus mode. The
  // bars fade out for reading and a tap on blank page brings them back.
  const fullscreen = immersive || focusMode;
  // Immersive is the native reader; only the web reader's focus mode borrows
  // the spread from a wide window.
  const webSpreadWindow = useWideSpreadWindow() && !immersive && !Capacitor.isNativePlatform();
  const bookSpread = fullscreen && (isBookPosture(deviceFold) || webSpreadWindow);
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!isReady || !rendition) return;
    const mode = bookSpread ? "always" : "none";
    if ((rendition.settings as { spread?: string }).spread === mode) return;
    const applySpread = () => {
      const anchor = anchorCfiRef.current;
      if (anchor) beginRestore();
      rendition.spread(mode, 0);
      // spread() takes the stage's new size but leaves the page it already
      // laid out at the old height. A fold changes both at once, and the
      // resize that follows then finds nothing to do, so the page would
      // overflow the stage. Lay it out again instead.
      rendition.clear();
      void rendition.display(pendingChapterHrefRef.current ?? anchor ?? undefined).catch(() => undefined);
      setRelayoutTick((tick) => tick + 1);
    };
    if (!webSpreadWindow) {
      applySpread();
      return;
    }
    // On the web the spread arrives with focus mode itself. Let the stage take
    // its full-screen size first, or the columns keep the old page height.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(applySpread);
    });
    return () => cancelAnimationFrame(frame);
  }, [beginRestore, bookSpread, isReady, webSpreadWindow]);
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const [chromeHidden, setChromeHidden] = useState(false);
  const chromeHiddenRef = useRef(chromeHidden);
  chromeHiddenRef.current = chromeHidden;
  const [sheet, setSheet] = useState<"contents" | "appearance" | null>(null);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const locationStorageKey = readerStorageKey(storageScope, bookId, "location");
  const openingPreferenceKey = `operalibre.reader.${storageScope}.opening`;
  const returnLocationKey = `${locationStorageKey}.return.${url.split("?")[0]}`;
  const [openAtListening, setOpenAtListening] = useState(() => readStoredValue(openingPreferenceKey) === "listening");
  // Freeze the launch decision. Later audio updates only refresh the manual action.
  const openingChoiceRef = useRef({
    enabled: openAtListening,
    chapter: listeningChapter,
    following: follow && (!!syncTarget || !!syncFragments?.length)
  });
  const [returnLocation, setReturnLocation] = useState(() => readStoredValue(returnLocationKey));
  const [catchUpCfi, setCatchUpCfi] = useState<string | null>(null);
  const [catchUpNotice, setCatchUpNotice] = useState("");
  const [offerOpeningPreference, setOfferOpeningPreference] = useState(false);
  const [catchUpBusy, setCatchUpBusy] = useState(false);
  const changeOpeningPreference = (enabled: boolean) => {
    setOpenAtListening(enabled);
    writeStoredValue(openingPreferenceKey, enabled ? "listening" : "reading");
    setOfferOpeningPreference(false);
  };
  const sheetRootRef = useRef<HTMLElement | null>(null);
  // A long table of contents opens on the chapter being read, not at the top.
  // The scroll runs after the sheet has settled to its card height and moves
  // only the sheet's own scrollbar (scrollIntoView would scroll ancestors and
  // make the sheet flash full-height as it opens).
  useEffect(() => {
    if (sheet !== "contents") {
      return;
    }
    const raf = requestAnimationFrame(() => {
      const root = sheetRootRef.current;
      const current = root?.querySelector<HTMLElement>(".epub-toc button.current");
      if (!root || !current) {
        return;
      }
      root.scrollTop = Math.max(0, current.offsetTop - root.clientHeight / 2 + current.offsetHeight / 2);
    });
    return () => cancelAnimationFrame(raf);
  }, [sheet]);

  // Following has taken ownership from the remembered reading page. The
  // relocation it causes establishes the new anchor, so neither the post-open
  // settling loop nor a restore still in progress pulls the reader back to
  // the saved place a moment later (and strands a chapter jump that is only
  // ever attempted once).
  const followTakesPage = useCallback((target: { href: string } | { cfi: string }) => {
    readerNavigationVersionRef.current += 1;
    pendingFollowTargetRef.current = { target, retried: false };
    anchorCfiRef.current = null;
    restoringUntilRef.current = 0;
  }, []);

  const resumeFollowing = useCallback(() => {
    readerDebugLog(`follow on at ${shortCfi(locationRef.current?.start?.cfi)}`);
    highlightedFragmentRef.current = -1;
    lastKeepRef.current = null;
    // A chapter jump that was pulled back or never landed must be retried:
    // asking to follow again is exactly the listener saying "take me there".
    autoNavHrefRef.current = null;
    // Let the chapter-sync effect re-open the playing chapter on the next run.
    syncedTargetRef.current = null;
    setFollow(true);
    setFollowRequest((request) => request + 1);
  },[setFollow]);

  const tapFragment = useCallback((fragment: SyncFragment) => {
    readerDebugLog(`tap seek ${Math.round(fragment.startSeconds)}s ${fragment.href}`);
    onSeekToRef.current?.(fragment.startSeconds);
    highlightedFragmentRef.current = -1;
    lastKeepRef.current = null;
    setFollow(true);
  },[setFollow]);

  // Turning a page by hand means the listener wants to read ahead (or
  // back); the narration marker must not drag the page away again until they
  // ask to return.
  const navigateByHand = useCallback((action: () => unknown) => {
    readerNavigationVersionRef.current += 1;
    pendingChapterHrefRef.current = null;
    pendingFollowTargetRef.current = null;
    // Chapter-level following pulls the page just as a sentence marker does,
    // so a page turned by hand has to stop that too, or the reader is
    // dragged back to the narrator's chapter on the next run.
    const followingNarration =
      (syncFragmentsRef.current?.length ?? 0) > 0 || !!syncTargetRef.current;
    if (followingNarration) {
      setFollow(false);
    }
    // The listener is driving now; where they stop is the remembered place.
    handNavigatedRef.current = true;
    restoringUntilRef.current = 0;
    readerDebugLog("hand");
    void action();
  },[setFollow]);

  const ensureSearchIndex = useCallback((doc: Document) => {
    if (!searchIndexRef.current || searchIndexRef.current.doc !== doc) {
      searchIndexRef.current = buildDocumentSearchIndex(doc);
      searchCursorRef.current = 0;
      fragmentRangesRef.current = null;
    }
    return searchIndexRef.current;
  }, []);

  // WKWebView does not deliver taps made on the epub iframe's own document to
  // its listeners, so in the full-screen reader an app-layer overlay catches
  // taps instead (the reader chrome, in this same layer, receives them
  // reliably). The overlay reports a page-relative x and the tapped point in
  // window coordinates; this resolves the point to a page turn, a sentence
  // seek, or a bar toggle.
  const handleOverlayTap = useCallback(
    (x: number, clientX: number, clientY: number) => {
      const rendition = renditionRef.current;
      const stageWidth = viewerRef.current?.getBoundingClientRect().width ?? 0;
      // The app-layer catcher can extend into the stage wrapper's safe-area
      // padding. Clamp that space to the page edge: otherwise a tap just past
      // the iframe is rejected as an edge turn, then translated into the
      // EPUB's next hidden column and mistaken for a sentence seek.
      const stageX = Math.max(0, Math.min(stageWidth, x));
      const edge = pageTurnAtEdge(stageX, stageWidth);
      if (edge === "prev") {
        navigateByHand(() => rendition?.prev());
        return;
      }
      if (edge === "next") {
        navigateByHand(() => rendition?.next());
        return;
      }
      // Middle: seek to the tapped sentence, if the tap landed on one.
      const contentsList = ([] as Contents[]).concat(
        (rendition?.getContents() as unknown as Contents[]) ?? []
      );
      const contents = contentsList.find((candidate) => candidate?.document?.body);
      const doc = contents?.document;
      const frame = doc?.defaultView?.frameElement as HTMLElement | undefined;
      const fragments = syncFragmentsRef.current;
      if (doc && frame && fragments && fragments.length > 0) {
        const frameBox = frame.getBoundingClientRect();
        const innerX = clientX - frameBox.left;
        const innerY = clientY - frameBox.top;
        const caret = caretAtPoint(doc, innerX, innerY);
        if (caret && pointOnText(caret.node, innerX, innerY)) {
          const index = ensureSearchIndex(doc);
          const position = indexPositionForCaret(index, caret.node, caret.offset);
          if (position >= 0) {
            const href = locationRef.current?.start?.href ?? "";
            if (
              !fragmentRangesRef.current ||
              fragmentRangesRef.current.doc !== doc ||
              fragmentRangesRef.current.href !== href
            ) {
              fragmentRangesRef.current = { doc, href, ranges: locateFragments(index, fragments, href) };
            }
            const fragmentIndex = fragmentAtIndexPosition(fragmentRangesRef.current.ranges, position);
            if (fragmentIndex >= 0) {
              tapFragment(fragments[fragmentIndex]);
              return;
            }
          }
        }
      }
      setChromeHidden((hidden) => !hidden);
    },
    [ensureSearchIndex, navigateByHand, tapFragment]
  );

  // A horizontal swipe on the overlay turns the page as well.
  const overlaySwipeRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const handleOverlayPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    overlaySwipeRef.current = { x: event.clientX, y: event.clientY, at: performance.now() };
    // Keep the lift on this layer even if the finger ends over the bars.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; the gesture still resolves where it lifts.
    }
  }, []);
  const handleOverlayPointerCancel = useCallback(() => {
    if (overlaySwipeRef.current) {
      readerDebugLog("gesture cancelled");
    }
    overlaySwipeRef.current = null;
  }, []);
  const handleOverlayPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = overlaySwipeRef.current;
      overlaySwipeRef.current = null;
      const rendition = renditionRef.current;
      const stage = viewerRef.current?.getBoundingClientRect();
      if (!start || !stage || stage.width === 0) {
        return;
      }
      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      const duration = performance.now() - start.at;
      const gesture = classifyPageGesture(deltaX, deltaY, duration);
      if (gesture === "next" || gesture === "prev") {
        navigateByHand(() => (gesture === "next" ? rendition?.next() : rendition?.prev()));
        return;
      }
      if (gesture === "tap") {
        handleOverlayTap(event.clientX - stage.left, event.clientX, event.clientY);
        return;
      }
      readerDebugLog(`gesture ignored dx=${Math.round(deltaX)} dy=${Math.round(deltaY)} ${Math.round(duration)}ms`);
    },
    [handleOverlayTap, navigateByHand]
  );

  useEffect(() => {
    if (!viewerRef.current) {
      return;
    }

    let cancelled = false;
    const debugLog = (entry: string) => {
      if (import.meta.env.DEV) {
        const debugWindow = window as unknown as { __operalibreReaderOpens?: string[] };
        debugWindow.__operalibreReaderOpens = [...(debugWindow.__operalibreReaderOpens ?? []), `${Math.round(performance.now())}:${entry}`];
      }
    };
    debugLog(`effect:${url.slice(-8)}:${locationStorageKey.slice(-12)}`);
    setToc([]);
    setLocation(null);
    setActiveHref("");
    setError(null);
    setErrorDetail(null);
    setIsReady(false);
    setSlowToOpen(false);
    syncedTargetRef.current = null;
    handNavigatedRef.current = false;
    searchIndexRef.current = null;
    searchCursorRef.current = 0;
    fragmentRangesRef.current = null;
    highlightCfiRef.current = null;
    narratedRangeRef.current = null;
    highlightedFragmentRef.current = -1;
    autoNavHrefRef.current = null;
    attachedDocsRef.current = new WeakSet();

    const abortController = new AbortController();
    let readyTimeout: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let book: EpubBook | null = null;
    let rendition: Rendition | null = null;
    let streamedAssets: ReturnType<typeof attachEpubReadArchive> | null = null;
    let displayRequested = false;
    const handleRelocated = (nextLocation: Location) => {
      lastLocationRef.current = nextLocation;
      locationRef.current = nextLocation;
      setLocation(nextLocation);
      setIsReady(true);
      if (import.meta.env.DEV) {
        const container = viewerRef.current?.querySelector<HTMLElement>(".epub-container");
        debugLog(
          `relocated:${nextLocation.start?.cfi}..${nextLocation.end?.cfi}:p${nextLocation.start?.displayed?.page}/${nextLocation.start?.displayed?.total}:sl${container?.scrollLeft}/${container?.clientWidth}/${container?.scrollWidth}:anchor=${anchorCfiRef.current}`
        );
      }
      const pendingChapter = pendingChapterHrefRef.current;
      if (pendingChapter) {
        // An old page may report while the requested chapter is loading.
        // It must not become the saved anchor for a subsequent relayout.
        if (!hrefsMatch(nextLocation.start?.href ?? "", pendingChapter)) return;
        pendingChapterHrefRef.current = null;
      }
      const EpubCfiClass = epubCfiClassRef.current;
      const pendingNavigation = pendingFollowTargetRef.current;
      const pendingFollow = pendingNavigation?.target;
      if (pendingFollow && followRef.current) {
        let arrived = false;
        if ("href" in pendingFollow) {
          arrived = hrefsMatch(nextLocation.start?.href ?? "", pendingFollow.href);
        } else if (EpubCfiClass && nextLocation.start?.cfi && nextLocation.end?.cfi) {
          try {
            const compare = new EpubCfiClass();
            arrived = compare.compare(pendingFollow.cfi, nextLocation.start.cfi) >= 0
              && compare.compare(pendingFollow.cfi, nextLocation.end.cfi) < 0;
          } catch {
            // A transient, incomplete location cannot acknowledge navigation.
          }
        }
        // A restore that was already running can report its old page after
        // Follow takes over. Do not adopt that page as the new reading anchor.
        if (!arrived) {
          // The stale restore can finish before Follow's first location report,
          // so its original display may never be acknowledged. Reassert the
          // destination once; retain the page-boundary loop guard if epub.js
          // cannot put that point on screen even after the retry.
          if (!pendingNavigation.retried) {
            pendingNavigation.retried = true;
            void rendition?.display("href" in pendingFollow ? pendingFollow.href : pendingFollow.cfi)
              .catch(() => undefined);
          }
          return;
        }
        pendingFollowTargetRef.current = null;
        // Only suppress a page correction that never arrived. Once it did,
        // a later stale restore must be allowed to request the same turn again.
        lastKeepRef.current = null;
        autoNavHrefRef.current = null;
      }
      const restoring = performance.now() < restoringUntilRef.current;
      const update = anchorAfterRelocation(
        anchorCfiRef.current,
        { start: nextLocation.start?.cfi, end: nextLocation.end?.cfi },
        (a, b) => (EpubCfiClass ? new EpubCfiClass().compare(a, b) : 0),
        restoring
      );
      if (update.arrived) {
        restoringUntilRef.current = 0;
      }
      readerDebugLog(
        `reloc ${restoring ? "restoring" : "settled"} p${nextLocation.start?.displayed?.page}/${nextLocation.start?.displayed?.total} start=${shortCfi(nextLocation.start?.cfi)} anchor=${shortCfi(anchorCfiRef.current)}->${shortCfi(update.anchor)}${update.arrived ? " arrived" : ""}`
      );
      if (update.anchor && update.anchor !== anchorCfiRef.current) {
        anchorCfiRef.current = update.anchor;
        writeStoredValue(locationStorageKey, update.anchor);
      }
    };

    // Tapping a sentence seeks the audio to it and resumes following. The
    // narrated sentence's own marker has its own click handler (an SVG
    // overlay), so clicks landing on that overlay are left to it.
    // The narrated sentence under a tap, if the tap landed on one.
    const fragmentUnderTap = (doc: Document, clientX: number, clientY: number): SyncFragment | null => {
      const fragments = syncFragmentsRef.current;
      if (!fragments || fragments.length === 0) {
        return null;
      }
      const caret = caretAtPoint(doc, clientX, clientY);
      // Caret lookup snaps to the nearest text; a tap in a margin must not
      // read as a tap on the closest sentence.
      if (!caret || !pointOnText(caret.node, clientX, clientY)) {
        return null;
      }
      const index = ensureSearchIndex(doc);
      const position = indexPositionForCaret(index, caret.node, caret.offset);
      if (position < 0) {
        return null;
      }
      const href = locationRef.current?.start?.href ?? "";
      if (
        !fragmentRangesRef.current ||
        fragmentRangesRef.current.doc !== doc ||
        fragmentRangesRef.current.href !== href
      ) {
        fragmentRangesRef.current = { doc, href, ranges: locateFragments(index, fragments, href) };
      }
      const fragmentIndex = fragmentAtIndexPosition(fragmentRangesRef.current.ranges, position);
      return fragmentIndex < 0 ? null : fragments[fragmentIndex];
    };
    const handleTap = (doc: Document, target: Element | null, clientX: number, clientY: number) => {
      if (target?.closest?.("a, button, input, textarea, select, svg")) {
        return;
      }
      // Full screen reads like a paper book: narrow outer margins turn it,
      // the text seeks to the tapped sentence, and a tap on nothing in
      // particular shows or hides the bars.
      if (fullscreenRef.current) {
        // The chapter is one wide, scrolled document; the visible page is
        // the stage's box in the app's own coordinates.
        const frame = doc.defaultView?.frameElement;
        const stage = viewerRef.current?.getBoundingClientRect();
        if (frame && stage && stage.width > 0) {
          const rawX = frame.getBoundingClientRect().left + clientX - stage.left;
          const x = Math.max(0, Math.min(stage.width, rawX));
          const edge = pageTurnAtEdge(x, stage.width);
          if (edge === "prev") {
            navigateByHand(() => rendition?.prev());
            return;
          }
          if (edge === "next") {
            navigateByHand(() => rendition?.next());
            return;
          }
        }
      }
      const fragment = fragmentUnderTap(doc, clientX, clientY);
      if (fragment) {
        tapFragment(fragment);
      } else if (fullscreenRef.current) {
        setChromeHidden((hidden) => !hidden);
      }
    };
    const handleContentClick = (event: MouseEvent) => {
      // A tap already handled on touchend; iOS may still send its click.
      if (performance.now() - lastTouchTapRef.current < 700) {
        return;
      }
      const doc = (event.target as Node | null)?.ownerDocument;
      if (doc) {
        handleTap(doc, event.target as Element | null, event.clientX, event.clientY);
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY, at: performance.now() } : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      event.preventDefault();
    };
    const handleTouchEnd = (event: TouchEvent) => {
      const start = touchStartRef.current;
      const touch = event.changedTouches[0];
      touchStartRef.current = null;
      if (!start || !touch) {
        return;
      }
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      const duration = performance.now() - start.at;
      const gesture = classifyPageGesture(deltaX, deltaY, duration);
      // iOS withholds the click for a touch whose move was cancelled (the
      // scroll lock above), and a finger rarely lands perfectly still, so a
      // tap is recognised here rather than waited for as a click.
      if (gesture === "tap") {
        const target = event.target as Element | null;
        if (target?.closest?.("a, button, input, textarea, select")) {
          return;
        }
        lastTouchTapRef.current = performance.now();
        const doc = (event.target as Node | null)?.ownerDocument;
        if (doc) {
          handleTap(doc, target, touch.clientX, touch.clientY);
        }
        return;
      }
      if (gesture === null) {
        readerDebugLog(`gesture ignored dx=${Math.round(deltaX)} dy=${Math.round(deltaY)} ${Math.round(duration)}ms`);
        return;
      }
      navigateByHand(() => (gesture === "next" ? rendition?.next() : rendition?.prev()));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        navigateByHand(() => rendition?.next());
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        navigateByHand(() => rendition?.prev());
      }
    };
    const attachToDocument = (doc: Document) => {
      if (attachedDocsRef.current.has(doc)) {
        return;
      }
      attachedDocsRef.current.add(doc);
      doc.addEventListener("click", handleContentClick);
      doc.addEventListener("touchstart", handleTouchStart, { passive: true });
      // A paginated chapter is one wide, column-laid-out document. iOS lets a
      // finger drag it sideways (and the page behind it) even with overflow
      // hidden, which tears the page mid-column whenever the reader isn't
      // actively snapping back to the narration. Pages turn by swipe or tap.
      doc.addEventListener("touchmove", handleTouchMove, { passive: false });
      doc.addEventListener("touchend", handleTouchEnd);
      doc.addEventListener("keydown", handleKeyDown);
    };
    const handleRendered = () => {
      debugLog("rendered");
      setIsReady(true);
      if (rendition) {
        pruneReadalongMarks(rendition);
        // A fold/resize can replace epub.js's page view after the resize
        // observer has already requested a marker redraw. Once the new view
        // actually exists, rerun the read-along effect so the still-active
        // sentence is painted into that view as well.
        if (highlightCfiRef.current) {
          setRelayoutTick((tick) => tick + 1);
        }
      }
      const contentsList = ([] as Contents[]).concat(
        (rendition?.getContents() as unknown as Contents[]) ?? []
      );
      for (const contents of contentsList) {
        if (contents?.document) {
          attachToDocument(contents.document);
        }
      }
    };

    // A resize clears epub.js's page and epub.js lays it out again only once
    // it has reported a location, which trails the first display by a frame.
    // A fold, rotation or late toolbar row in that frame would otherwise
    // leave the reader blank.
    const handleResized = () => {
      const reported = !!(rendition as unknown as { location?: { start?: unknown } } | null)?.location?.start;
      if (!displayRequested || cancelled || !rendition || reported) {
        return;
      }
      readerDebugLog(`resize before first location anchor=${shortCfi(anchorCfiRef.current)}`);
      if (anchorCfiRef.current) {
        beginRestore();
      }
      void rendition.display(pendingChapterHrefRef.current ?? anchorCfiRef.current ?? undefined).catch(() => undefined);
    };

    const openBook = async () => {
      try {
        const epubModule = await import("epubjs");
        const ePub = epubModule.default;
        epubCfiClassRef.current = epubModule.EpubCFI;
        if (cancelled || !viewerRef.current) {
          return;
        }

        readyTimeout = window.setTimeout(() => {
          if (!cancelled) {
            setSlowToOpen(true);
          }
        }, 12000);

        const source = loadSourceRef.current
          ? await loadSourceRef.current(url, abortController.signal)
          : url;
        const readCached = loadCachedSourceRef.current;
        const prepared = await prepareEpubRead(
          source, abortController.signal,
          readCached ? () => readCached(abortController.signal) : undefined,
          loadWholeFileRef.current
        );
        if (cancelled || !viewerRef.current) {
          prepared.archive?.destroy();
          return;
        }
        if (prepared.archive) {
          book = ePub({ replacements: "blobUrl" });
          streamedAssets = attachEpubReadArchive(book, prepared.archive);
          await book.open(new ArrayBuffer(0), "binary");
        } else {
          if (!prepared.data.byteLength) throw new Error("EPUB response was empty");
          book = ePub(prepared.data, { replacements: "blobUrl" });
        }
        await book.opened;
        if (cancelled || !viewerRef.current) {
          return;
        }

        rendition = book.renderTo(viewerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "none",
          manager: "default"
        });

        // Keep touch from scrolling the chapter document itself; navigation
        // is by page turn only.
        const readerLockRules = {
          html: { "touch-action": "none !important", "overscroll-behavior": "none !important" }
        };
        // One stylesheet for every look; the colours come from custom
        // properties set per theme (see applyReaderThemeColors).
        rendition.themes.register("operalibre", {
          body: {
            color: "var(--reader-ink) !important",
            background: "var(--reader-page) !important",
            "font-family": "Georgia, 'Times New Roman', serif !important",
            "line-height": "1.78 !important",
            padding: "0 5% !important",
            // The narrow phone column plus em-dash-joined words makes justified
            // text open large gaps between words; left align reads cleanly and
            // hyphenation keeps the ragged edge tidy.
            "text-align": "left !important",
            "-webkit-hyphens": "auto",
            hyphens: "auto"
          },
          p: {
            "margin-bottom": "1.15em !important",
            "text-align": "left !important",
            "-webkit-hyphens": "auto",
            hyphens: "auto"
          },
          "p, li, blockquote, div": { "text-align": "left !important" },
          a: { color: "var(--reader-link) !important" },
          img: { "max-width": "100% !important", height: "auto !important" },
          ...readerLockRules
        });

        // Style the pages before the first one is laid out. Applying the
        // theme and text size afterwards reflows the chapter under a stage
        // still scrolled to the old page, which then shows earlier words than
        // the remembered place, and that earlier page gets saved in its turn.
        rendition.themes.select("operalibre");
        applyReaderThemeColors(rendition.themes, readerThemeRef.current);
        rendition.themes.fontSize(`${fontScaleRef.current}%`);
        appliedThemeRef.current = readerThemeRef.current;
        appliedFontScaleRef.current = fontScaleRef.current;

        bookRef.current = book;
        renditionRef.current = rendition;
        rendition.on("relocated", handleRelocated);
        rendition.on("rendered", handleRendered);
        rendition.on("resized", handleResized);
        if (streamedAssets) {
          const assets = streamedAssets;
          // Streamed images and fonts load lazily in the page. If the network
          // drops before they arrive, lay the page out again from a local copy.
          rendition.hooks.content.register((contents: Contents) => {
            const assetFailed = () => {
              void assets.recoverAssets().then((recovered) => {
                if (!recovered || cancelled || !rendition) return;
                rendition.clear();
                void rendition.display(pendingChapterHrefRef.current ?? anchorCfiRef.current ?? locationRef.current?.start?.cfi ?? undefined);
              }).catch(() => undefined);
            };
            contents.document.addEventListener("error", (event) => {
              if ((event.target as Node | null)?.nodeType === Node.ELEMENT_NODE) assetFailed();
            }, true);
            contents.document.fonts?.addEventListener("loadingerror", assetFailed);
          });
        }
        if (import.meta.env.DEV) {
          // Inspectable from the console while developing the reader.
          const debugWindow = window as unknown as { __operalibreReader?: unknown; __operalibreReaderOpens?: string[] };
          debugWindow.__operalibreReader = { book, rendition };
          debugWindow.__operalibreReaderOpens = [...(debugWindow.__operalibreReaderOpens ?? []), `${Math.round(performance.now())}:${url.slice(-12)}`];
        }

        book.loaded.navigation
          .then((navigation) => {
            if (!cancelled) {
              setToc(flattenToc(navigation.toc));
            }
          })
          .catch(() => {
            if (!cancelled) {
              setToc([]);
            }
          });

        // Reopen where the listener left off; when narration is being
        // followed the marker moves the page again as soon as it is known.
        const savedLocation = readStoredValue(locationStorageKey);
        readerDebugLog(`stored=${shortCfi(savedLocation)} last=${shortCfi(lastLocationRef.current?.start?.cfi)}`);
        let startAt = anchorCfiRef.current ?? savedLocation;
        const originalLocation = startAt;
        const openingChoice = openingChoiceRef.current;
        // Consume this once, including failed matches and loads. Reflow never retries it.
        openingChoiceRef.current = { enabled: false, chapter: null, following: false };
        if (openingChoice.enabled && !openingChoice.following) {
          try {
            const navigation = await book.loaded.navigation;
            const target = await resolveListeningCfi(book, flattenToc(navigation.toc), openingChoice.chapter);
            if (cancelled) return;
            if (!handNavigatedRef.current && canCatchUp(startAt, target, (a, b) => new epubModule.EpubCFI().compare(a, b))) {
              writeStoredValue(returnLocationKey, startAt!);
              setReturnLocation(startAt);
              startAt = target;
              setCatchUpNotice(`Opened at ${openingChoice.chapter}.`);
            }
          } catch {
            // An unavailable chapter preserves the saved reading place.
          }
        }
        anchorCfiRef.current = startAt;
        debugLog(`display:${startAt}`);
        readerDebugLog(`open saved=${shortCfi(startAt)}`);
        if (startAt) {
          beginRestore();
        }
        displayRequested = true;
        try {
          await rendition.display(startAt ?? undefined);
          if (!cancelled && startAt && startAt !== originalLocation) writeStoredValue(locationStorageKey, startAt);
        } catch (error) {
          // A remembered place that no longer resolves (the file was
          // replaced) must not keep the book from opening at all.
          if (!startAt || cancelled) {
            throw error;
          }
          console.warn("EPUB remembered place could not be opened", error);
          readerDebugLog(`open failed ${String(error).slice(0, 60)}`);
          anchorCfiRef.current = originalLocation;
          setCatchUpNotice("");
          beginRestore();
          try {
            await rendition.display(originalLocation ?? undefined);
          } catch {
            anchorCfiRef.current = null;
            restoringUntilRef.current = 0;
            await rendition.display();
          }
        }
        // Keep the saved page as the reading anchor, but do not mark the
        // playing chapter handled. When Follow is on, chapter sync can move
        // there immediately while a sentence map is still loading; the map
        // refines the position afterward without delaying the first jump.
        // The chapter's pictures and web fonts arrive after the first
        // layout and push the text along, so the page epub.js first shows
        // for a remembered place is usually an earlier one. Check back while
        // the layout settles and turn to the place again if it has moved off
        // the page — unless the listener has started reading somewhere else.
        const restoreNavigationVersion = readerNavigationVersionRef.current;
        void (async () => {
          for (const delay of [300, 700, 1400, 2500]) {
            await new Promise((resolve) => window.setTimeout(resolve, delay));
            const anchor = anchorCfiRef.current;
            const EpubCfiClass = epubCfiClassRef.current;
            const page = locationRef.current;
            if (cancelled || handNavigatedRef.current || !anchor || !rendition
              || readerNavigationVersionRef.current !== restoreNavigationVersion) {
              return;
            }
            if (!EpubCfiClass || !page?.start?.cfi || !page.end?.cfi) {
              continue;
            }
            const compare = (a: string, b: string) => new EpubCfiClass().compare(a, b);
            if (anchorOnPage(anchor, { start: page.start.cfi, end: page.end.cfi }, compare)) {
              continue;
            }
            readerDebugLog(`settle back to ${shortCfi(anchor)} from ${shortCfi(page.start.cfi)}`);
            beginRestore();
            try {
              await rendition.display(anchor);
            } catch {
              return;
            }
          }
        })();
        if (!cancelled) {
          setIsReady(true);
          setSlowToOpen(false);
          setError(null);
          setErrorDetail(null);
          if (readyTimeout !== null) {
            window.clearTimeout(readyTimeout);
            readyTimeout = null;
          }
        }
      } catch (error) {
        if (!cancelled && !abortController.signal.aborted) {
          console.error("EPUB readalong failed", error);
          setError("This EPUB could not be opened inline.");
          setErrorDetail(error instanceof Error ? error.message : String(error));
        }
      }
    };

    resizeObserver = new ResizeObserver(() => {
      const bounds = viewerRef.current?.getBoundingClientRect();
      // epub.js only gains a view manager once it has attached; a resize
      // before then throws inside the observer callback.
      const attached = !!(rendition as unknown as { manager?: unknown } | null)?.manager;
      if (bounds && bounds.width > 0 && bounds.height > 0 && rendition && attached) {
        // epub.js re-lays the chapter out and turns to the given place; left
        // to itself it would turn to the old page's first words instead,
        // which lands a little earlier with every pass.
        debugLog(`resize:${Math.floor(bounds.width)}x${Math.floor(bounds.height)}:anchor=${anchorCfiRef.current}`);
        readerDebugLog(
          `resize ${Math.floor(bounds.width)}x${Math.floor(bounds.height)} anchor=${shortCfi(anchorCfiRef.current)}`
        );
        if (anchorCfiRef.current) {
          beginRestore();
        }
        (rendition as unknown as { resize(width: number, height: number, cfi?: string): void }).resize(
          Math.floor(bounds.width),
          Math.floor(bounds.height),
          pendingChapterHrefRef.current ?? anchorCfiRef.current ?? undefined
        );
        setRelayoutTick((tick) => tick + 1);
      }
    });
    resizeObserver.observe(viewerRef.current);
    void openBook();

    return () => {
      cancelled = true;
      pendingChapterHrefRef.current = null;
      pendingFollowTargetRef.current = null;
      debugLog("cleanup");
      readerDebugLog(`close anchor=${shortCfi(anchorCfiRef.current)}`);
      abortController.abort();
      if (readyTimeout !== null) {
        window.clearTimeout(readyTimeout);
      }
      resizeObserver?.disconnect();
      // epub.js teardown throws when a rendition is destroyed before it has
      // attached (the reader closed while the book was still opening), and a
      // throw here would unmount the whole app.
      try {
        rendition?.off("relocated", handleRelocated);
        rendition?.off("rendered", handleRendered);
        rendition?.off("resized", handleResized);
        rendition?.destroy();
      } catch (error) {
        console.warn("EPUB rendition teardown failed", error);
      }
      try {
        book?.destroy();
      } catch (error) {
        console.warn("EPUB book teardown failed", error);
      }
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [beginRestore, ensureSearchIndex, locationStorageKey, navigateByHand, returnLocationKey, tapFragment, url]);

  useEffect(() => {
    const book = bookRef.current;
    if (!isReady || !book) return;
    let cancelled = false;
    setCatchUpCfi(null);
    void resolveListeningCfi(book, toc, listeningChapter).then((target) => {
      if (!cancelled) setCatchUpCfi(target);
    }).catch(() => { /* A chapter that cannot be resolved is not offered. */ });
    return () => { cancelled = true; };
  }, [isReady, toc, listeningChapter]);

  const moveReaderTo = async (target: string, returning: boolean) => {
    const rendition = renditionRef.current;
    const previous = anchorCfiRef.current;
    if (!rendition || !previous || catchUpBusy) return;
    const navigationVersion = ++readerNavigationVersionRef.current;
    setCatchUpBusy(true);
    if (!returning) {
      writeStoredValue(returnLocationKey, previous);
      setReturnLocation(previous);
    }
    setFollow(false);
    handNavigatedRef.current = true;
    anchorCfiRef.current = target;
    beginRestore();
    try {
      await rendition.display(target);
      if (renditionRef.current !== rendition || readerNavigationVersionRef.current !== navigationVersion) return;
      writeStoredValue(locationStorageKey, target);
      setCatchUpNotice(returning ? "Returned to your previous reading place." : `Moved to ${listeningChapter}.`);
      setOfferOpeningPreference(!returning && !openAtListening);
    } catch {
      if (renditionRef.current !== rendition || readerNavigationVersionRef.current !== navigationVersion) return;
      anchorCfiRef.current = previous;
      beginRestore();
      await rendition.display(previous).catch(() => undefined);
      setCatchUpNotice("That place could not be opened. Your reading place is saved.");
    } finally {
      setCatchUpBusy(false);
    }
  };

  useEffect(() => {
    writeReaderThemeChoice(readerThemeChoice);
  }, [readerThemeChoice]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (isReady && rendition && appliedThemeRef.current !== readerTheme) {
      applyReaderThemeColors(rendition.themes, readerTheme);
      appliedThemeRef.current = readerTheme;
    }
  }, [isReady, readerTheme]);

  useEffect(() => {
    // The first render after a screen/orientation change still carries the
    // previous layout's size. Wait for its remembered value instead of
    // briefly saving or applying the old value under the new key.
    if (fontScaleBucketChanged) return;
    writeStoredValue(`operalibre.readerFontScale.${fontScaleBucket}`, String(fontScale));
    const rendition = renditionRef.current;
    if (!isReady || !rendition || appliedFontScaleRef.current === fontScale) {
      return;
    }
    appliedFontScaleRef.current = fontScale;
    rendition.themes.fontSize(`${fontScale}%`);
    readerDebugLog(`fontScale ${fontScale} anchor=${shortCfi(anchorCfiRef.current)}`);
    if (anchorCfiRef.current) {
      beginRestore();
    }
    // The chapter reflows at the new size while the stage stays scrolled to
    // the old page, which now holds different words. Lay the chapter out
    // afresh and turn to the place being read.
    rendition.clear();
    void rendition.display(pendingChapterHrefRef.current ?? anchorCfiRef.current ?? locationRef.current?.start?.cfi ?? undefined);
    setRelayoutTick((tick) => tick + 1);
  }, [beginRestore, fontScale, fontScaleBucket, fontScaleBucketChanged, isReady]);

  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (sheetRef.current) {
        setSheet(null);
      } else if (!immersive) {
        setFocusMode(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [fullscreen, immersive]);

  // Chapter-level sync: with no sentence map, follow keeps the reader on the
  // chapter being played. Turning a page (which clears follow) stops it, so a
  // listener can read ahead; turning follow back on re-opens the chapter.
  useEffect(() => {
    if (!syncTarget || !isReady || toc.length === 0) {
      return;
    }
    if (!followRef.current || !shouldOpenPlayingChapter(follow, syncTarget.id, syncedTargetRef.current)) {
      return;
    }
    const href = findTocHrefForChapterTitle(toc, syncTarget.title);
    if (!href) {
      return;
    }
    syncedTargetRef.current = syncTarget.id;
    // Following has taken ownership from the remembered reading page. Let the
    // relocation establish a new anchor in the narrated chapter so the
    // post-open settling loop cannot pull the reader back a moment later.
    anchorCfiRef.current = null;
    pendingChapterHrefRef.current = href;
    restoringUntilRef.current = 0;
    setActiveHref(href);
    readerDebugLog(`chapterJump ${href}`);
    void renditionRef.current?.display(href);
  }, [follow, followRequest, isReady, syncTarget, toc]);

  const fragmentIndex = useMemo(
    () =>
      syncFragments && syncFragments.length > 0
        ? findActiveFragmentIndex(syncFragments, positionSeconds, followLeadSeconds)
        : -1,
    [followLeadSeconds, positionSeconds, syncFragments]
  );

  const removeAnnotation = useCallback((cfi: string | null) => {
    const rendition = renditionRef.current;
    if (!rendition || !cfi) {
      return;
    }
    try {
      removeHighlight(rendition.annotations as unknown as AnnotationStore, cfi);
    } catch {
      // stale annotation already gone
    }
    pruneReadalongMarks(rendition);
  }, []);

  // Sentence-level readalong: highlight the fragment being narrated and keep
  // it on screen, following page turns and chapter boundaries.
  useEffect(() => {
    const rendition = renditionRef.current;
    const sentenceStyle = sentenceHighlightStyle(readerTheme);
    // followRef, not the follow state: a page turned by hand stops following
    // at once (see navigateByHand), but this effect can still re-run once
    // more — retriggered by the turn's own relocation — before React
    // re-renders with the new follow value. Reading the stale state here
    // would re-highlight and re-page to wherever the narration currently is,
    // which is exactly the jump a hand-turned page must not make.
    if (!followRef.current || !syncFragments || fragmentIndex < 0) {
      pendingFollowTargetRef.current = null;
      removeAnnotation(highlightCfiRef.current);
      highlightCfiRef.current = null;
      highlightedFragmentRef.current = -1;
      narratedRangeRef.current = null;
      return;
    }
    if (!isReady || !rendition || !location) {
      return;
    }
    if (highlightedFragmentRef.current !== fragmentIndex) {
      removeAnnotation(highlightCfiRef.current);
      highlightCfiRef.current = null;
      highlightThemeRef.current = null;
      narratedRangeRef.current = null;
      lastKeepRef.current = null;
    }
    const fragment = syncFragments[fragmentIndex];
    const currentHref = location.start?.href ?? "";
    if (!hrefsMatch(currentHref, fragment.href)) {
      if (autoNavHrefRef.current !== fragment.href && followRef.current) {
        autoNavHrefRef.current = fragment.href;
        highlightedFragmentRef.current = -1;
        readerDebugLog(`follow chapter ${fragment.href} at ${Math.round(positionSeconds)}s from ${shortCfi(location.start?.cfi)}`);
        followTakesPage({ href: fragment.href });
        void rendition.display(fragment.href);
      }
      return;
    }
    autoNavHrefRef.current = null;
    // Keep the spoken position visible even when a sentence spans pages.
    // The annotation remains sentence-wide; word timing only guides navigation.
    const spokenCfi = () => {
      const target = narratedRangeRef.current;
      if (!target) return highlightCfiRef.current;
      const rawOffset = narrationTextOffset(fragment, positionSeconds);
      const offset = normalizeSyncNeedle(fragment.text.slice(0, rawOffset) + "x").length - 1;
      const point = target.index.map[target.start + Math.min(offset, target.length - 1)];
      if (!point) return highlightCfiRef.current;
      try {
        const range = target.index.doc.createRange();
        range.setStart(point.node, point.offset);
        range.collapse(true);
        return target.contents.cfiFromRange(range);
      } catch {
        return highlightCfiRef.current;
      }
    };
    const keepOnPage = (cfi: string) => {
      const EpubCfiClass = epubCfiClassRef.current;
      if (!EpubCfiClass || !location.start?.cfi || !location.end?.cfi) {
        return;
      }
      try {
        const comparator = new EpubCfiClass();
        if (
          comparator.compare(cfi, location.end.cfi) >= 0 ||
          comparator.compare(cfi, location.start.cfi) < 0
        ) {
          const from = location.start.cfi;
          const last = lastKeepRef.current;
          if (!followRef.current || repeatedNarratedPageTurn(last, cfi, from, relayoutTick)) {
            return;
          }
          lastKeepRef.current = { cfi, from, layout: relayoutTick };
          readerDebugLog(`follow page ${shortCfi(cfi)} from ${shortCfi(from)}`);
          followTakesPage({ cfi });
          void rendition.display(cfi);
        }
      } catch {
        // invalid comparison; leave the page as-is
      }
    };
    if (highlightedFragmentRef.current === fragmentIndex) {
      const relaid = handledRelayoutRef.current !== relayoutTick;
      if ((highlightThemeRef.current !== readerTheme || relaid) && highlightCfiRef.current) {
        // Redraw against the current layout.
        removeAnnotation(highlightCfiRef.current);
        rendition.annotations.highlight(
          highlightCfiRef.current,
          {},
          () => tapFragment(fragment),
          "readalong-highlight",
          sentenceStyle
        );
        highlightThemeRef.current = readerTheme;
        handledRelayoutRef.current = relayoutTick;
      }
      if (highlightCfiRef.current) {
        keepOnPage(spokenCfi() ?? highlightCfiRef.current);
      }
      return;
    }
    handledRelayoutRef.current = relayoutTick;

    const contentsList = ([] as Contents[]).concat(
      (rendition.getContents() as unknown as Contents[]) ?? []
    );
    const contents = contentsList.find((candidate) => candidate?.document?.body);
    const doc = contents?.document;
    if (!contents || !doc) {
      return;
    }
    const index = ensureSearchIndex(doc);

    // Mark the fragment handled up front so a missing sentence doesn't retry
    // on every relocation.
    highlightedFragmentRef.current = fragmentIndex;
    narratedRangeRef.current = null;

    const needle = normalizeSyncNeedle(fragment.text);
    const found = findRangeInSearchIndex(index, needle, searchCursorRef.current);
    if (!found) {
      return;
    }
    searchCursorRef.current = found.endOffset;

    let cfi: string;
    try {
      cfi = contents.cfiFromRange(found.range);
    } catch {
      return;
    }
    rendition.annotations.highlight(
      cfi,
      {},
      () => tapFragment(fragment),
      "readalong-highlight",
      sentenceStyle
    );
    narratedRangeRef.current = { index, start: found.endOffset - needle.length, length: needle.length, contents };
    highlightCfiRef.current = cfi;
    highlightThemeRef.current = readerTheme;
    keepOnPage(spokenCfi() ?? cfi);
  }, [ensureSearchIndex, follow, followRequest, followTakesPage, fragmentIndex, isReady, location, positionSeconds, readerTheme, relayoutTick, removeAnnotation, syncFragments, tapFragment]);

  const percent = location?.start?.percentage;
  const locationLabel = Number.isFinite(percent ?? NaN)
    ? `${Math.round((percent ?? 0) * 100)}%`
    : isReady
      ? "Ready"
      : "Loading";
  const currentTocItem = useMemo(() => {
    const href = location?.start?.href;
    if (!href) {
      return null;
    }
    let match: (NavItem & { depth: number }) | null = null;
    for (const item of toc) {
      if (hrefsMatch(href, item.href)) {
        match = item;
      }
    }
    return match;
  }, [location, toc]);
  const selectedTocHref = currentTocItem?.href ?? activeHref;
  const hasSync = !!syncFragments && syncFragments.length > 0;
  // Chapter-sync books have no marker but still follow the narrated chapter,
  // so they get the same follow toggle.
  const canFollow = hasSync || !!syncTarget;
  const followLabel = "Following by sentence";
  const statusLabel = hasSync
    ? follow
      ? fragmentIndex >= 0
        ? `${followLabel} · ${locationLabel}`
        : `Waiting for narration · ${locationLabel}`
      : `Reading freely · ${locationLabel}`
    : syncTarget
      ? `Chapter sync · ${locationLabel}`
      : locationLabel;
  const awayFromNarration = hasSync && !follow && fragmentIndex >= 0;

  const pageInfo =
    location?.start?.displayed && location.start.displayed.total > 0
      ? `Page ${location.start.displayed.page} of ${location.start.displayed.total}`
      : null;
  const chapterLabel = chapterTitle ?? currentTocItem?.label?.trim() ?? null;
  const hint = awayFromNarration
    ? "Reading freely. The narration marker is off while you turn pages yourself."
    : "Tap any sentence to play from there. Turning a page pauses following.";
  const goToHref = (href: string) => {
    setActiveHref(href);
    syncedTargetRef.current = null;
    if (href) {
      navigateByHand(() => renditionRef.current?.display(href));
    }
  };
  const handleReaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      navigateByHand(() => renditionRef.current?.next());
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      navigateByHand(() => renditionRef.current?.prev());
    }
  };

  const themeOptions = (
    <div className="epub-theme-options" aria-label="Reading theme">
      {READER_THEME_CHOICES.map((choice) => (
        <button
          type="button"
          key={choice}
          className={readerThemeChoice === choice ? "selected" : ""}
          aria-pressed={readerThemeChoice === choice}
          onClick={() => setReaderThemeChoice(choice)}
          title={choice === "auto" ? `Follows the app: ${readerTheme} right now` : undefined}
        >
          {choice}
        </button>
      ))}
    </div>
  );
  const fontControls = (
    <div className="epub-font-controls">
      <button
        type="button"
        aria-label="Decrease reader text size"
        disabled={fontScale <= READER_FONT_SCALE_MIN}
        onClick={() => setFontScale((size) => Math.max(READER_FONT_SCALE_MIN, size - 10))}
      >
        <Minus size={15} />
      </button>
      <span aria-label={`Reader text size ${fontScale}%`}>Aa&nbsp; {fontScale}%</span>
      <button
        type="button"
        aria-label="Increase reader text size"
        disabled={fontScale >= READER_FONT_SCALE_MAX}
        onClick={() => setFontScale((size) => Math.min(READER_FONT_SCALE_MAX, size + 10))}
      >
        <Plus size={15} />
      </button>
    </div>
  );
  const followActionLabel = hasSync
    ? (follow ? "Stop following narration" : "Follow narration")
    : (follow ? "Stop following chapters" : "Follow chapters");
  const followButton = canFollow ? (
    <button
      type="button"
      className={`epub-tool-button ${follow ? "selected" : ""}`}
      onClick={() => (follow ? setFollow(false) : resumeFollowing())}
      aria-pressed={follow}
      aria-label={followActionLabel}
      title={followActionLabel}
    >
      <LocateFixed size={15} />
      <span>{hasSync ? "Follow" : "Chapter sync"}</span>
    </button>
  ) : null;
  // The page itself. It must keep its place in the tree between the inline
  // and full-screen layouts: epub.js is attached to this very element.
  const stage = (
    <div className="epub-stage" ref={viewerRef}>
      {fullscreen ? null : (
        <span className="epub-progress" style={{ width: `${Math.max(0, Math.min(100, (percent ?? 0) * 100))}%` }} />
      )}
      {!isReady && !error ? (
        <span className="epub-loading">
          {slowToOpen ? "Still opening the ebook… a large book takes a moment on a slow connection." : "Loading EPUB…"}
        </span>
      ) : null}
      {error ? (
        <span className="epub-error">
          {error}
          {errorDetail ? <small>{errorDetail}</small> : null}
        </span>
      ) : null}
    </div>
  );

  const reader = (
    <div
      className={`epub-reader theme-${readerTheme} ${fullscreen ? "fullscreen" : ""} ${immersive ? "immersive" : ""} ${fullscreen && chromeHidden ? "chrome-hidden" : ""}`}
      tabIndex={0}
      onKeyDown={handleReaderKeyDown}
    >
      {fullscreen ? (
        <header className="epub-topbar">
          <button
            type="button"
            className="epub-icon-button"
            onClick={() => (immersive ? onClose?.() : setFocusMode(false))}
            aria-label="Close the reader"
          >
            <X size={20} />
          </button>
          <div className="epub-topbar-title">
            <strong>{title}</strong>
            {chapterLabel ? <span>{chapterLabel}</span> : null}
          </div>
          <div className="epub-topbar-actions">
            {canFollow ? (
              <button
                type="button"
                className={`epub-icon-button ${follow ? "selected" : ""}`}
                onClick={() => (follow ? setFollow(false) : resumeFollowing())}
                aria-pressed={follow}
                aria-label={followActionLabel}
              >
                <LocateFixed size={19} />
              </button>
            ) : null}
            <button type="button" className="epub-icon-button" onClick={() => setSheet("contents")} aria-label="Contents">
              <List size={20} />
            </button>
            <button type="button" className="epub-icon-button" onClick={() => setSheet("appearance")} aria-label="Appearance and sync">
              <ALargeSmall size={22} />
            </button>
          </div>
        </header>
      ) : (
        <div className="epub-reader-chrome">
          <div className="epub-toolbar">
            <button
              type="button"
              onClick={() => navigateByHand(() => renditionRef.current?.prev())}
              aria-label="Previous page"
            >
              <ChevronLeft size={17} />
            </button>
            <div className="epub-location">
              <select
                aria-label={`${title} table of contents`}
                value={selectedTocHref}
                onChange={(event) => goToHref(event.currentTarget.value)}
              >
                <option value="">Contents</option>
                {toc.map((item) => (
                  <option key={`${item.href}-${item.label}`} value={item.href}>
                    {" ".repeat(item.depth * 2)}{item.label}
                  </option>
                ))}
              </select>
              <span className="epub-status" aria-live="polite">{statusLabel}</span>
            </div>
            <button
              type="button"
              onClick={() => navigateByHand(() => renditionRef.current?.next())}
              aria-label="Next page"
            >
              <ChevronRight size={17} />
            </button>
          </div>

          <div className="epub-preferences" aria-label="Reader appearance">
            {themeOptions}
            {fontControls}
            {followButton}
            <button
              type="button"
              className="epub-tool-button"
              onClick={() => setFocusMode(true)}
              aria-label="Open reader focus mode"
              title="Focus mode"
            >
              <Maximize2 size={15} />
              <span>Focus</span>
            </button>
          </div>
        </div>
      )}
      <div className="epub-catch-up" aria-label="Reading and listening place">
        {isReady && canCatchUp(anchorCfiRef.current, catchUpCfi, (a, b) => {
          const Cfi = epubCfiClassRef.current;
          return Cfi ? new Cfi().compare(a, b) : 0;
        }) ? (
          <button type="button" disabled={catchUpBusy} onClick={() => void moveReaderTo(catchUpCfi!, false)}>
            Go to listening chapter{listeningChapter ? ` · ${listeningChapter}` : ""}
          </button>
        ) : null}
        {returnLocation ? (
          <button type="button" disabled={!isReady || catchUpBusy} onClick={() => void moveReaderTo(returnLocation, true)}>
            Return to previous reading place
          </button>
        ) : null}
        {catchUpNotice ? <span role="status">{catchUpNotice}</span> : null}
        {offerOpeningPreference ? (
          <span>Open at your listening chapter next time? <button type="button" onClick={() => changeOpeningPreference(true)}>Yes</button> <button type="button" onClick={() => setOfferOpeningPreference(false)}>Not now</button></span>
        ) : null}
        {!fullscreen ? (
          <label>When opening <select value={openAtListening ? "listening" : "reading"} onChange={(event) => changeOpeningPreference(event.target.value === "listening")}>
            <option value="reading">Resume reading</option>
            <option value="listening">Open at listening chapter</option>
          </select></label>
        ) : null}
      </div>
      <div className="epub-stage-wrap">
        {stage}
        {fullscreen ? (
          <div
            className="epub-tapzones"
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
            onPointerCancel={handleOverlayPointerCancel}
            aria-hidden="true"
          >
            <span className="epub-tapzone epub-tapzone-prev" />
            <span className="epub-tapzone epub-tapzone-next" />
          </div>
        ) : null}
      </div>
      {fullscreen ? (
        <footer className="epub-bottombar">
          <div className="epub-pagebar" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, (percent ?? 0) * 100))}%` }} />
          </div>
          <div className="epub-pageinfo">
            <span>
              {hasSync
                ? follow
                  ? fragmentIndex >= 0
                    ? followLabel
                    : "Waiting for narration"
                  : "Reading freely"
                : syncTarget
                  ? follow
                    ? "Following by chapter"
                    : "Reading freely"
                  : locationLabel}
            </span>
            <span>{pageInfo ?? locationLabel}</span>
          </div>
          {playback ? (
            <div className="epub-audiobar">
              <button type="button" className="epub-icon-button epub-skip" onClick={() => playback.onSkip(-15)} aria-label="Back 15 seconds">
                <RotateCcw size={19} />
                <small>15</small>
              </button>
              <button
                type="button"
                className="epub-audiobar-play"
                onClick={playback.onToggle}
                aria-label={playback.playing ? "Pause" : "Play"}
              >
                {playback.playing ? <Pause size={22} /> : <Play size={22} />}
              </button>
              <button type="button" className="epub-icon-button epub-skip" onClick={() => playback.onSkip(30)} aria-label="Forward 30 seconds">
                <RotateCw size={19} />
                <small>30</small>
              </button>
              <div className="epub-audiobar-status" role="status">
                <span className="epub-audiobar-time">{positionLabel ?? ""}</span>
              </div>
              {/* The rest of the player without leaving the page: the app's own
                  speed, sleep, and chapter sheets open over the reader. */}
              <div className="epub-audiobar-extras">
                <button
                  type="button"
                  className="epub-icon-button epub-audiobar-speed"
                  onClick={() => playback.onOpen("speed")}
                  aria-label={`Playback speed, ${playback.speed}×`}
                >
                  <span>{playback.speed}×</span>
                </button>
                <button
                  type="button"
                  className="epub-icon-button"
                  onClick={() => playback.onOpen("sleep")}
                  aria-label={playback.sleepRemaining > 0 ? `Sleep timer, ${Math.ceil(playback.sleepRemaining / 60)} minutes left` : "Sleep timer"}
                >
                  <Timer size={18} />
                  {playback.sleepRemaining > 0 ? <small>{Math.ceil(playback.sleepRemaining / 60)}m</small> : null}
                </button>
                <button type="button" className="epub-icon-button" onClick={() => playback.onOpen("chapters")} aria-label="Chapters">
                  <ListMusic size={18} />
                </button>
              </div>
            </div>
          ) : onListen ? (
            <button type="button" className="epub-audiobar-listen" onClick={onListen}>
              <Play size={15} />
              <span>Listen while you read</span>
            </button>
          ) : null}
        </footer>
      ) : hasSync ? (
        // Guidance and the way back live in a bar under the page, never over
        // the words: a listener reading ahead must keep every line legible.
        <div className="epub-footer">
          <p className="epub-hint" role="status">{hint}</p>
          {awayFromNarration ? (
            <button type="button" className="epub-footer-action" onClick={resumeFollowing}>
              <Undo2 size={14} />
              <span>Return to narration</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {fullscreen && sheet ? (
        <div className="epub-sheet-layer" role="presentation">
          <button type="button" className="epub-sheet-scrim" aria-label="Close" onClick={() => setSheet(null)} />
          <section
            className="epub-sheet"
            ref={sheetRootRef}
            role="dialog"
            aria-modal="true"
            aria-label={sheet === "contents" ? "Contents" : "Appearance and sync"}
          >
            <div className="epub-sheet-grabber" aria-hidden="true" />
            {sheet === "contents" ? (
              <>
                <h3>Contents</h3>
                {toc.length === 0 ? (
                  <p className="epub-sheet-hint">This book has no table of contents.</p>
                ) : (
                  <ul className="epub-toc">
                    {toc.map((item) => {
                      const current = hrefsMatch(selectedTocHref, item.href);
                      return (
                        <li key={`${item.href}-${item.label}`} style={{ paddingLeft: `${item.depth * 16}px` }}>
                          <button
                            type="button"
                            className={current ? "current" : ""}
                            aria-current={current ? "location" : undefined}
                            onClick={() => {
                              goToHref(item.href);
                              setSheet(null);
                            }}
                          >
                            {item.label.trim()}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {companionSwitcher ? (
                  <>
                    <h3>Other files</h3>
                    {companionSwitcher}
                  </>
                ) : null}
              </>
            ) : (
              <>
                <h3>Appearance</h3>
                <div className="epub-sheet-row">{themeOptions}</div>
                <div className="epub-sheet-row">{fontControls}</div>
                <h3>When opening</h3>
                <label className="epub-sheet-row">Starting place
                  <select value={openAtListening ? "listening" : "reading"} onChange={(event) => changeOpeningPreference(event.target.value === "listening")}>
                    <option value="reading">Resume reading</option>
                    <option value="listening">Open at listening chapter</option>
                  </select>
                </label>
                <p className="epub-sheet-hint">Opens at the beginning of your listening chapter when it is ahead. Your previous page stays available. Follow is controlled separately. Saved for this account on this device.</p>
                {canFollow || syncTools ? (
                  <>
                    <h3>Narration</h3>
                    {canFollow ? (
                      <>
                        <div className="epub-sheet-row">{followButton}</div>
                        <p className="epub-sheet-hint">
                          {hasSync
                            ? hint
                            : "This book follows by chapter: the reader opens to the chapter being played. Turn following off to read ahead on your own."}
                        </p>
                      </>
                    ) : null}
                    {syncTools}
                  </>
                ) : null}
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
  return immersive ? createPortal(reader, document.body) : reader;
}
