import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeWordIndex,
  anchorOnPage,
  anchorAfterRelocation,
  describeCompanion,
  findActiveFragmentIndex,
  findTocHrefForChapterTitle,
  groupCompanions,
  hasExtras,
  parseReadalongLabel,
  readAlongMode,
  readalongMatchScore,
  shouldOpenPlayingChapter,
  syncMapPrecision
} from "../src/readalong.ts";
import type { Book, CompanionFile, SyncFragment, SyncMap } from "../src/types.ts";

describe("chapter labels", () => {
  it("reads numbers written as digits, words, or roman numerals", () => {
    assert.equal(parseReadalongLabel("Chapter 12: The Long Road").number, 12);
    assert.equal(parseReadalongLabel("Chapter 12: The Long Road").key, "the long road");
    assert.equal(parseReadalongLabel("Chapter Twelve: The Long Road").number, 12);
    assert.equal(parseReadalongLabel("Chapter twenty-two").number, 22);
    assert.equal(parseReadalongLabel("Chapter Twenty Two - Owls").number, 22);
    assert.equal(parseReadalongLabel("Chapter Twenty Two - Owls").key, "owls");
    assert.equal(parseReadalongLabel("Chapter XII").number, 12);
    assert.equal(parseReadalongLabel("XIV. The River").number, 14);
    assert.equal(parseReadalongLabel("XIV. The River").key, "the river");
    assert.equal(parseReadalongLabel("Seven: Nightfall").number, 7);
    assert.equal(parseReadalongLabel("03 - Owl Post").number, 3);
    assert.equal(parseReadalongLabel("Ch. 3 - Owl Post").number, 3);
    assert.equal(parseReadalongLabel("Ch. 3 - Owl Post").key, "owl post");
  });

  it("keeps lettered series such as interludes apart from chapters", () => {
    const spoken = parseReadalongLabel("Interlude I-3: The Rhythm of the Lost");
    assert.equal(spoken.number, 3);
    assert.equal(spoken.series, "i");
    assert.equal(spoken.key, "interlude the rhythm of the lost");
    const written = parseReadalongLabel("I-3. The Rhythm of the Lost");
    assert.equal(written.series, "i");
    assert.ok(readalongMatchScore(spoken, written) >= 70);
    assert.equal(readalongMatchScore(spoken, parseReadalongLabel("3. Momentum")), 0);
    assert.equal(parseReadalongLabel("Track-01").number, null);
  });

  it("does not mistake words for numbers", () => {
    assert.equal(parseReadalongLabel("Chapter Ivory").number, null);
    assert.equal(parseReadalongLabel("Chapter Mix").number, null);
    assert.equal(parseReadalongLabel("I Am Legend").number, null);
    assert.equal(parseReadalongLabel("Which 12 Days").number, null);
    assert.equal(parseReadalongLabel("Chapter IIII").number, null);
    assert.equal(parseReadalongLabel("Prologue").key, "prologue");
  });

  it("scores an audio chapter against a table of contents entry", () => {
    const target = parseReadalongLabel("Chapter One");
    assert.equal(readalongMatchScore(target, parseReadalongLabel("1. The Boy Who Lived")), 100);
    assert.equal(readalongMatchScore(target, parseReadalongLabel("Title Page")), 0);
    const named = parseReadalongLabel("03 - Owl Post");
    assert.equal(readalongMatchScore(named, parseReadalongLabel("Chapter 3: Owl Post")), 180);
  });

  it("picks the table-of-contents entry for the playing chapter", () => {
    const toc = [
      { href: "title.xhtml", label: "Title Page" },
      { href: "c1.xhtml", label: "One: The Meadow" },
      { href: "c2.xhtml", label: "Two: The River" }
    ];
    assert.equal(findTocHrefForChapterTitle(toc, "Chapter 2"), "c2.xhtml");
    assert.equal(findTocHrefForChapterTitle(toc, "The Meadow"), "c1.xhtml");
    assert.equal(findTocHrefForChapterTitle(toc, "End Credits"), null);
  });
});

describe("sync maps", () => {
  const fragments: SyncFragment[] = [
    { startSeconds: 0, endSeconds: 2, href: "a", text: "One." },
    { startSeconds: 3, endSeconds: 5, href: "a", text: "Two.", words: [[3, 3.5, 0, 3], [4, 5, 4, 4]] },
    { startSeconds: 6, endSeconds: 8, href: "b", text: "Three." }
  ];

  it("keeps a fragment active through the pause before the next one", () => {
    assert.equal(findActiveFragmentIndex(fragments, -1), -1);
    assert.equal(findActiveFragmentIndex(fragments, 0), 0);
    assert.equal(findActiveFragmentIndex(fragments, 2.5), 0);
    assert.equal(findActiveFragmentIndex(fragments, 3), 1);
    assert.equal(findActiveFragmentIndex(fragments, 7), 2);
    assert.equal(findActiveFragmentIndex(fragments, 9), -1);
  });

  it("marks the narrated word until the next one begins", () => {
    assert.equal(activeWordIndex(fragments[0], 1), -1);
    assert.equal(activeWordIndex(fragments[1], 2.9), -1);
    assert.equal(activeWordIndex(fragments[1], 3), 0);
    assert.equal(activeWordIndex(fragments[1], 3.8), 0);
    assert.equal(activeWordIndex(fragments[1], 4.5), 1);
    assert.equal(activeWordIndex(fragments[1], 5.5), -1);
  });

  it("tells word, sentence, and estimated maps apart", () => {
    const base: SyncMap = { version: 2, fragments: [fragments[0]] };
    assert.equal(syncMapPrecision(null), null);
    assert.equal(syncMapPrecision({ ...base, fragments: [] }), null);
    assert.equal(syncMapPrecision(base), "sentence");
    assert.equal(syncMapPrecision({ ...base, fragments }), "word");
    assert.equal(syncMapPrecision({ ...base, precision: "estimated", fragments }), "estimated");
  });

  it("describes what the reader can do before and after the map loads", () => {
    const epub = { id: "e", fileName: "b.epub", extension: "epub", contentType: "", url: "" };
    assert.equal(readAlongMode({ readingFile: null, syncFile: null }), null);
    assert.equal(readAlongMode({ readingFile: { ...epub, extension: "pdf" }, syncFile: null }), "text");
    assert.equal(readAlongMode({ readingFile: epub, syncFile: null }), "chapter");
    assert.equal(
      readAlongMode({ readingFile: epub, syncFile: { fileName: "", source: "estimated", url: "" } }),
      "estimated"
    );
    assert.equal(
      readAlongMode({ readingFile: epub, syncFile: { fileName: "", source: "generated", url: "" } }),
      "sentence"
    );
    assert.equal(
      readAlongMode(
        { readingFile: epub, syncFile: { fileName: "", source: "generated", url: "" } },
        { version: 2, fragments }
      ),
      "word"
    );
  });
});

describe("companions", () => {
  const companion = (overrides: Partial<CompanionFile>): CompanionFile => ({
    id: "c",
    fileName: "file",
    extension: "pdf",
    contentType: "application/pdf",
    url: "/x",
    kind: "book",
    sizeBytes: 10,
    ...overrides
  });

  it("groups the text, the extras, and the pictures", () => {
    const book: Pick<Book, "companions" | "readingFile"> = {
      readingFile: null,
      companions: [
        companion({ id: "1", kind: "supplement" }),
        companion({ id: "2", kind: "book", extension: "epub" }),
        companion({ id: "3", kind: "image", extension: "png" })
      ]
    };
    const groups = groupCompanions(book);
    assert.deepEqual(groups.text.map((c) => c.id), ["2"]);
    assert.deepEqual(groups.supplements.map((c) => c.id), ["1"]);
    assert.deepEqual(groups.images.map((c) => c.id), ["3"]);
    assert.equal(hasExtras(book), true);
    assert.equal(hasExtras({ readingFile: null, companions: [companion({ kind: "book" })] }), false);
  });

  it("shows an older server's reading file as the book", () => {
    const groups = groupCompanions({
      readingFile: { id: "r", fileName: "b.epub", extension: "epub", contentType: "", url: "/r" },
      companions: undefined
    });
    assert.equal(groups.text.length, 1);
    assert.equal(groups.text[0].kind, "book");
  });

  it("describes a companion by what it holds", () => {
    assert.equal(
      describeCompanion(companion({ extension: "epub", textCharacters: 560_000 })),
      "EPUB · 100,000 words"
    );
    assert.equal(
      describeCompanion(companion({ kind: "supplement", imageCount: 14, pageCount: 12 })),
      "PDF · 14 pictures · 12 pages"
    );
    assert.equal(describeCompanion(companion({ kind: "supplement", pageCount: 1 })), "PDF · mostly pictures · 1 page");
    assert.equal(describeCompanion(companion({ unreadable: true })), "PDF · could not be inspected");
    assert.equal(describeCompanion(companion({ kind: "image", extension: "png" })), "PNG picture");
  });
});

describe("remembered place", () => {
  // CFIs compared as plain numbers for the test.
  const compare = (a: string, b: string) => Number(a) - Number(b);
  const at = (anchor: string | null, start?: string, end?: string, restoring = false) =>
    anchorAfterRelocation(anchor, { start, end }, compare, restoring);

  it("keeps the anchor while the page still holds it", () => {
    assert.deepEqual(at("12", "10", "20"), { anchor: "12", arrived: true });
    assert.deepEqual(at("10", "10", "20"), { anchor: "10", arrived: true });
    assert.deepEqual(at("20", "10", "20"), { anchor: "20", arrived: true });
  });

  it("moves to the new page start once the reader leaves the page", () => {
    assert.deepEqual(at("12", "21", "30"), { anchor: "21", arrived: true });
    assert.deepEqual(at("12", "1", "9"), { anchor: "1", arrived: true });
  });

  it("ignores the pages passed through while restoring the place", () => {
    // Opening a chapter lands at its top before turning to the anchor.
    assert.deepEqual(at("120", "1", "9", true), { anchor: "120", arrived: false });
    assert.deepEqual(at("120", "60", "80", true), { anchor: "120", arrived: false });
    // Arriving ends the restore, and page turns count again.
    assert.deepEqual(at("120", "115", "125", true), { anchor: "120", arrived: true });
  });

  it("takes the page start when nothing is remembered or the comparison fails", () => {
    assert.deepEqual(at(null, "10", "20"), { anchor: "10", arrived: true });
    assert.deepEqual(at("12", "10", undefined), { anchor: "10", arrived: true });
    assert.deepEqual(at("12", undefined, undefined), { anchor: "12", arrived: false });
    const throwing = () => { throw new Error("bad cfi"); };
    assert.deepEqual(anchorAfterRelocation("12", { start: "10", end: "20" }, throwing), {
      anchor: "10",
      arrived: true
    });
    // A broken comparison must not strand the reader mid-restore either.
    assert.deepEqual(
      anchorAfterRelocation("12", { start: "10", end: "20" }, throwing, true),
      { anchor: "12", arrived: false }
    );
  });
});

describe("following the chapter being played", () => {
  it("opens the chapter when the narration moves to a new one", () => {
    assert.equal(shouldOpenPlayingChapter(true, "ch-4", "ch-3"), true);
    assert.equal(shouldOpenPlayingChapter(true, "ch-4", null), true);
  });

  it("leaves the page alone once that chapter has been opened", () => {
    assert.equal(shouldOpenPlayingChapter(true, "ch-4", "ch-4"), false);
  });

  it("stays where the listener is reading when following is off", () => {
    assert.equal(shouldOpenPlayingChapter(false, "ch-4", "ch-3"), false);
  });

  it("does nothing when no chapter is playing", () => {
    assert.equal(shouldOpenPlayingChapter(true, null, null), false);
  });
});

describe("is the remembered place on this page", () => {
  const compare = (a: string, b: string) => Number(a) - Number(b);

  it("knows a place inside, at the edges of, and outside the page", () => {
    assert.equal(anchorOnPage("12", { start: "10", end: "20" }, compare), true);
    assert.equal(anchorOnPage("10", { start: "10", end: "20" }, compare), true);
    assert.equal(anchorOnPage("20", { start: "10", end: "20" }, compare), true);
    assert.equal(anchorOnPage("9", { start: "10", end: "20" }, compare), false);
    assert.equal(anchorOnPage("21", { start: "10", end: "20" }, compare), false);
  });

  it("treats an unusable comparison as not on the page", () => {
    const throwing = () => { throw new Error("bad cfi"); };
    assert.equal(anchorOnPage("12", { start: "10", end: "20" }, throwing), false);
  });
});
