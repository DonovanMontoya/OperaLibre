/**
 * Read-along helpers shared by the reader pane and the library: chapter
 * label matching, sync-map lookups, and how a book's companions are
 * described to the listener. Pure functions, so they run in the test
 * runner without a browser.
 */
import type { Book, CompanionFile, SyncFragment, SyncMap } from "./types";

// ---------------------------------------------------------------------------
// Chapter labels
// ---------------------------------------------------------------------------

export type ParsedReadalongLabel = {
  number: number | null;
  /** The lettered series a number belongs to (`i` for an interlude written `I-3`); empty for chapters. */
  series: string;
  key: string;
};

export function normalizeReadalongText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const UNITS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen"
];
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

/** `one` … `ninety-nine`, hyphenated, in lower case. */
function parseNumberWords(token: string): number | null {
  const unit = UNITS.indexOf(token);
  if (unit >= 0) return unit;
  const [tens, rest] = token.split("-", 2);
  const tensValue = TENS[tens];
  if (tensValue === undefined) return null;
  if (rest === undefined) return tensValue;
  const restValue = UNITS.indexOf(rest);
  return restValue >= 1 && restValue <= 9 ? tensValue + restValue : null;
}

const ROMAN_TABLE: Array<[number, string]> = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
];

function romanNumeral(value: number) {
  let out = "";
  for (const [amount, letters] of ROMAN_TABLE) {
    while (value >= amount) {
      out += letters;
      value -= amount;
    }
  }
  return out;
}

/**
 * Uppercase roman numerals only, and only up to a plausible chapter count:
 * title case and long forms are far more likely to be words (`Mix`, `Dix`).
 */
function parseRomanNumeral(token: string): number | null {
  if (!/^[IVXLCDM]+$/.test(token)) return null;
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let index = 0; index < token.length; index += 1) {
    const value = values[token[index]];
    const next = index + 1 < token.length ? values[token[index + 1]] : 0;
    total += value < next ? -value : value;
  }
  return total > 0 && total <= 200 && romanNumeral(total) === token ? total : null;
}

/**
 * A chapter number at the start of `value` as digits, a roman numeral, or a
 * spelled-out English number, with the characters consumed. The token must
 * end at a word boundary so `Chapter Ivory` is not chapter four.
 */
function parseNumberToken(value: string): { number: number; consumed: number } | null {
  const digits = value.match(/^\d+/);
  if (digits) {
    const significant = digits[0].replace(/^0+/, "");
    // A digit run too long for a chapter number is a timestamp or an ISBN.
    if (significant.length > 9) return null;
    return { number: significant ? Number(significant) : 0, consumed: digits[0].length };
  }
  const word = value.match(/^[A-Za-z]+(?:-[A-Za-z]+)?/);
  if (!word) return null;
  const token = word[0];
  const roman = parseRomanNumeral(token);
  if (roman !== null) return { number: roman, consumed: token.length };
  const lower = token.toLowerCase();
  const second = value.slice(token.length).match(/^ ([A-Za-z]+)/);
  if (second) {
    const combined = parseNumberWords(`${lower}-${second[1].toLowerCase()}`);
    if (combined !== null) return { number: combined, consumed: token.length + second[0].length };
  }
  const single = parseNumberWords(lower);
  return single !== null ? { number: single, consumed: token.length } : null;
}

/**
 * Reads a chapter label into its number and its title, accepting every way a
 * publisher or narrator writes the number: `Chapter 12`, `Chapter Twelve`,
 * `Chapter XII`, `Ch. 12`, `12. The Long Road`, `Twelve: The Long Road`.
 * Mirrors the server's matcher so the reader and the sync generator agree.
 */
export function parseReadalongLabel(value: string): ParsedReadalongLabel {
  const lower = value.toLowerCase();
  let number: number | null = null;
  let remainder = value;
  // "Interlude I-3: Kaza" and "I-3. Kaza": a lettered series number.
  if (!lower.includes("chapter ")) {
    const series = value.match(/(?<![A-Za-z0-9])([A-Za-z]{1,3})-(\d+)(?![A-Za-z0-9])/);
    if (series && series.index !== undefined && series[2].replace(/^0+/, "").length <= 9) {
      const before = value.slice(0, series.index).replace(/[\s.:)\-–—]+$/, "");
      const after = value.slice(series.index + series[0].length).replace(/^[\s.:)\-–—]+/, "");
      return {
        number: Number(series[2]),
        series: series[1].toLowerCase(),
        key: normalizeReadalongText(`${before} ${after}`)
      };
    }
  }
  let prefixAt = lower.indexOf("chapter ");
  let prefixLength = "chapter ".length;
  if (prefixAt < 0) {
    if (lower.startsWith("ch. ")) {
      prefixAt = 0;
      prefixLength = 4;
    } else if (lower.startsWith("ch ")) {
      prefixAt = 0;
      prefixLength = 3;
    }
  }
  if (prefixAt >= 0) {
    const after = value.slice(prefixAt + prefixLength);
    const token = parseNumberToken(after);
    if (token) {
      number = token.number;
      remainder = after.slice(token.consumed).replace(/^\s*[.:)\-–—]*\s*/, "");
    }
  } else {
    const trimmed = value.replace(/^\s+/, "");
    const token = parseNumberToken(trimmed);
    if (token) {
      const rest = trimmed.slice(token.consumed).replace(/^\s+/, "");
      const separator = rest.match(/^[.:)\-–—]\s*/);
      if (separator) {
        number = token.number;
        remainder = rest.slice(separator[0].length);
      }
    }
  }
  return { number, series: "", key: normalizeReadalongText(remainder) };
}

export function readalongMatchScore(target: ParsedReadalongLabel, item: ParsedReadalongLabel) {
  let score = 0;
  if (target.number !== null && item.number === target.number && item.series === target.series) {
    score += 100;
  }
  if (target.key && item.key) {
    if (target.key === item.key) {
      score += 80;
    } else if (target.key.includes(item.key) || item.key.includes(target.key)) {
      score += 45;
    } else {
      const targetWords = new Set(target.key.split(" ").filter((word) => word.length > 3));
      const sharedWords = item.key
        .split(" ")
        .filter((word) => word.length > 3 && targetWords.has(word)).length;
      score += Math.min(35, sharedWords * 10);
    }
  }
  return score;
}

export const LABEL_MATCH_THRESHOLD = 70;

/** The table-of-contents entry that best names the chapter being played. */
export function findTocHrefForChapterTitle<T extends { href: string; label: string }>(
  toc: T[],
  chapterTitle: string
) {
  const parsedTarget = parseReadalongLabel(chapterTitle);
  const ranked = toc
    .filter((item) => item.href)
    .map((item) => ({
      href: item.href,
      score: readalongMatchScore(parsedTarget, parseReadalongLabel(item.label))
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return best && best.score >= LABEL_MATCH_THRESHOLD ? best.href : null;
}

// ---------------------------------------------------------------------------
// Sync maps
// ---------------------------------------------------------------------------

export function hrefsMatch(displayedHref: string, fragmentHref: string) {
  const clean = (value: string) => {
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep as-is
    }
    return value.split(/[#?]/)[0].replace(/^\.?\//, "");
  };
  const a = clean(displayedHref);
  const b = clean(fragmentHref);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * The fragment being narrated at `seconds`, or -1 before the first one. A
 * fragment stays active through the silence before the next one so the
 * marker does not flicker off between sentences.
 */
export function findActiveFragmentIndex(fragments: SyncFragment[], seconds: number) {
  let low = 0;
  let high = fragments.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (fragments[mid].startSeconds <= seconds) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best < 0) {
    return -1;
  }
  const activeUntil = fragments[best + 1]?.startSeconds ?? fragments[best].endSeconds;
  return seconds < activeUntil ? best : -1;
}

/**
 * The word being narrated inside a fragment, or -1 when the position is
 * before the first timed word or the fragment carries no word timings. A
 * word stays marked until the next one begins.
 */
export function activeWordIndex(fragment: SyncFragment, seconds: number) {
  const words = fragment.words;
  if (!words || words.length === 0) return -1;
  let low = 0;
  let high = words.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid][0] <= seconds) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best < 0) return -1;
  const activeUntil = words[best + 1]?.[0] ?? Math.max(words[best][1], fragment.endSeconds);
  return seconds < activeUntil ? best : -1;
}

/**
 * The haystack index and this needle normalization must collapse text the
 * same way so indexOf offsets map back to DOM positions.
 */
export function normalizeSyncNeedle(value: string) {
  let out = "";
  let lastWasSpace = true;
  for (const ch of value) {
    if (ch === "­") {
      continue;
    }
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        out += " ";
        lastWasSpace = true;
      }
    } else {
      out += ch.toLowerCase();
      lastWasSpace = false;
    }
  }
  return out.trim();
}

export type SyncPrecision = "word" | "sentence" | "estimated";

/** What a loaded sync map can drive: a word marker, a sentence marker, or a soft estimate. */
export function syncMapPrecision(map: SyncMap | null | undefined): SyncPrecision | null {
  if (!map || map.fragments.length === 0) return null;
  if (map.precision === "estimated") return "estimated";
  return map.fragments.some((fragment) => fragment.words && fragment.words.length > 0)
    ? "word"
    : "sentence";
}

// ---------------------------------------------------------------------------
// What a book offers
// ---------------------------------------------------------------------------

export type ReadAlongMode = SyncPrecision | "chapter" | "text";

/**
 * How closely the reader can follow this book's audio, from what the book
 * response promises and, once loaded, what the sync map actually holds.
 */
export function readAlongMode(
  book: Pick<Book, "readingFile" | "syncFile">,
  map?: SyncMap | null
): ReadAlongMode | null {
  const file = book.readingFile;
  if (!file) return null;
  if (file.extension.toLowerCase() !== "epub") return "text";
  const precision = syncMapPrecision(map);
  if (precision) return precision;
  const source = book.syncFile?.source;
  if (source === "sidecar" || source === "generated") return "sentence";
  if (source === "estimated") return "estimated";
  return "chapter";
}

export const READ_ALONG_MODE_LABELS: Record<ReadAlongMode, { title: string; detail: string }> = {
  word: {
    title: "Word-for-word sync",
    detail: "The narrated word is marked as you listen, and the page turns with the audio."
  },
  sentence: {
    title: "Sentence sync",
    detail: "The narrated sentence is highlighted, and the page turns with the audio."
  },
  estimated: {
    title: "Approximate sync",
    detail: "Sentences are timed from the chapter list, so the marker can run a few lines ahead or behind."
  },
  chapter: {
    title: "Chapter sync",
    detail: "The reader opens to the chapter being played."
  },
  text: {
    title: "Companion text",
    detail: "Read beside the audio. This format cannot follow playback."
  }
};

export type CompanionGroups = {
  text: CompanionFile[];
  supplements: CompanionFile[];
  images: CompanionFile[];
};

export function groupCompanions(book: Pick<Book, "companions" | "readingFile">): CompanionGroups {
  const companions = book.companions ?? [];
  const groups: CompanionGroups = { text: [], supplements: [], images: [] };
  for (const companion of companions) {
    if (companion.kind === "image") groups.images.push(companion);
    else if (companion.kind === "supplement") groups.supplements.push(companion);
    else groups.text.push(companion);
  }
  // A server released before companion classification still reports the
  // primary reading file; show it as the book.
  if (groups.text.length === 0 && book.readingFile && companions.length === 0) {
    groups.text.push({
      id: book.readingFile.id,
      fileName: book.readingFile.fileName,
      extension: book.readingFile.extension,
      contentType: book.readingFile.contentType,
      url: book.readingFile.url,
      kind: "book",
      sizeBytes: 0
    });
  }
  return groups;
}

/** The book has pictures or a supplement besides (or instead of) its text. */
export function hasExtras(book: Pick<Book, "companions" | "readingFile">) {
  const groups = groupCompanions(book);
  return groups.supplements.length > 0 || groups.images.length > 0;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

export function companionKindLabel(companion: CompanionFile) {
  if (companion.kind === "image") return "Picture";
  if (companion.kind === "supplement") return "Extras";
  return companion.extension.toLowerCase() === "epub" ? "Ebook" : "Text";
}

/** One line under a companion's name: its format and what it holds. */
export function describeCompanion(companion: CompanionFile) {
  const format = companion.extension.toUpperCase();
  if (companion.kind === "image") return `${format} picture`;
  const parts = [format];
  if (companion.unreadable) {
    parts.push("could not be inspected");
  } else if (companion.kind === "book") {
    // Characters counted with spaces; ~5.6 per English word.
    if (companion.textCharacters) parts.push(plural(Math.round(companion.textCharacters / 5.6), "word"));
  } else if (companion.imageCount) {
    parts.push(plural(companion.imageCount, "picture"));
  } else {
    parts.push("mostly pictures");
  }
  if (companion.pageCount) parts.push(plural(companion.pageCount, "page"));
  return parts.join(" · ");
}

/** Storage keys for per-book reader state, scoped to the server and account. */
export function readerStorageKey(scope: string, bookId: string, field: "location" | "open") {
  return `operalibre.reader.${scope}.${bookId}.${field}`;
}

/** The remembered place, and whether the reader has settled on it. */
export type AnchorUpdate = { anchor: string | null; arrived: boolean };

/**
 * Where the reader should reopen after a page of `page.start`…`page.end` is
 * shown.
 *
 * The remembered `anchor` stays while it is still on the page: page starts
 * move a little earlier with every relayout, and re-saving each start would
 * walk the place backwards one reopen at a time.
 *
 * While `restoring` — the book is opening, or the page is being laid out
 * again after a resize or a text-size change — the reader passes through
 * pages on its way back to the anchor, starting at the top of the chapter.
 * Those pages are not somewhere the listener went, so they must not become
 * the remembered place; adopting one would strand the reader there, and the
 * next relayout would restore that wrong place and keep it for good.
 *
 * Once the anchor is on the page again the reader has arrived, and ordinary
 * page turns move the anchor as usual.
 */
/** Whether the remembered place lies on the page now shown. */
export function anchorOnPage(
  anchor: string,
  page: { start: string; end: string },
  compare: (a: string, b: string) => number
): boolean {
  try {
    return compare(anchor, page.start) >= 0 && compare(anchor, page.end) <= 0;
  } catch {
    return false;
  }
}

export function anchorAfterRelocation(
  anchor: string | null,
  page: { start: string | undefined; end: string | undefined },
  compare: (a: string, b: string) => number,
  restoring = false
): AnchorUpdate {
  if (!page.start) return { anchor, arrived: false };
  if (!anchor || !page.end) return { anchor: page.start, arrived: true };
  if (anchorOnPage(anchor, { start: page.start, end: page.end }, compare)) {
    return { anchor, arrived: true };
  }
  if (restoring) return { anchor, arrived: false };
  return { anchor: page.start, arrived: true };
}

export function shouldOpenPlayingChapter(
  following: boolean,
  playingChapterId: string | null,
  handledChapterId: string | null
): boolean {
  if (!following || !playingChapterId) return false;
  return playingChapterId !== handledChapterId;
}
