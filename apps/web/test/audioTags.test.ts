import assert from "node:assert/strict";
import test from "node:test";
import { bytesSource, readAudioFileTags, rangeSource } from "../src/audioTags.ts";

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Box types are latin-1, so `©nam` has to become the single byte 0xA9. */
function latin1(value: string) {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0) & 0xff));
}

function u8(value: number) {
  return Uint8Array.from([value]);
}

function u16(value: number) {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number) {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u64(value: number) {
  return concat(u32(Math.floor(value / 2 ** 32)), u32(value >>> 0));
}

function box(type: string, ...payload: Uint8Array[]) {
  const body = concat(...payload);
  return concat(u32(body.length + 8), latin1(type), body);
}

function dataAtom(type: number, payload: Uint8Array) {
  return box("data", u32(type), u32(0), payload);
}

function textItem(type: string, value: string) {
  return box(type, dataAtom(1, encoder.encode(value)));
}

function freeformItem(name: string, value: string) {
  return box(
    "----",
    box("mean", u32(0), encoder.encode("com.apple.iTunes")),
    box("name", u32(0), encoder.encode(name)),
    dataAtom(1, encoder.encode(value))
  );
}

const PNG_COVER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function ilst(...items: Uint8Array[]) {
  return box(
    "udta",
    box("meta", u32(0), box("hdlr", u32(0), u32(0), latin1("mdir"), latin1("appl"), u32(0), u32(0), u8(0)), box("ilst", ...items))
  );
}

function mvhd(timescale: number, duration: number) {
  return box("mvhd", u32(0), u32(0), u32(0), u32(timescale), u32(duration), new Uint8Array(80));
}

test("an m4b's iTunes atoms become book metadata", async () => {
  const file = concat(
    box("ftyp", latin1("M4B "), u32(0), latin1("M4B mp42isom")),
    box(
      "moov",
      mvhd(1_000, 3_600_000),
      ilst(
        textItem("©nam", "The Hobbit"),
        textItem("©ART", "J. R. R. Tolkien"),
        textItem("©alb", "The Hobbit"),
        textItem("©gen", "Fantasy, Adventure"),
        textItem("©day", "2012-07-17"),
        textItem("desc", "<p>A hobbit leaves home.<br />He returns changed.</p>"),
        freeformItem("NARRATOR", "Rob Inglis"),
        freeformItem("ASIN", "B0036I52HK"),
        box("trkn", dataAtom(0, concat(u16(0), u16(3), u16(9), u16(0)))),
        box("covr", dataAtom(14, PNG_COVER))
      )
    )
  );

  const tags = await readAudioFileTags(bytesSource(file));
  assert.ok(tags);
  assert.equal(tags.title, "The Hobbit");
  assert.equal(tags.author, "J. R. R. Tolkien");
  assert.equal(tags.narrator, "Rob Inglis");
  assert.equal(tags.album, "The Hobbit");
  assert.equal(tags.description, "A hobbit leaves home.\nHe returns changed.");
  assert.deepEqual(tags.genres, ["Fantasy", "Adventure"]);
  assert.equal(tags.publishedDate, "2012-07-17");
  assert.equal(tags.asin, "B0036I52HK");
  assert.equal(tags.trackNumber, 3);
  assert.equal(tags.durationSeconds, 3_600);
  assert.equal(tags.cover?.contentType, "image/png");
  assert.deepEqual(tags.cover?.bytes, PNG_COVER);
  assert.ok(tags.rawFields.some((field) => field.key === "NARRATOR" && field.value === "Rob Inglis"));
});

test("tag descriptions cannot reconstruct HTML from encoded or malformed markup", async () => {
  for (const description of [
    "&lt;scrip&lt;script&gt;ignored&lt;/script&gt;t&gt;alert(1)&lt;/script&gt;",
    "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;"
  ]) {
    const file = concat(
      box("ftyp", latin1("M4B ")),
      box("moov", mvhd(1_000, 1_000), ilst(textItem("©nam", "Volume &lt; 2"), textItem("desc", description)))
    );

    const tags = await readAudioFileTags(bytesSource(file));
    assert.ok(tags);
    assert.equal(tags.title, "Volume < 2");
    assert.doesNotMatch(tags.description ?? "", /[<>]/);
  }
});

test("the composer is read as the narrator only when another tag names the author", async () => {
  const withTags = async (...items: Uint8Array[]) => {
    const file = concat(box("ftyp", latin1("M4B ")), box("moov", mvhd(1_000, 1_000), ilst(...items)));
    return readAudioFileTags(bytesSource(file));
  };

  // The AAX-rip convention: artist is the author, composer the narrator.
  const rip = await withTags(textItem("©ART", "Naomi Novik"), textItem("©wrt", "Julia Emelin"));
  assert.equal(rip?.author, "Naomi Novik");
  assert.equal(rip?.narrator, "Julia Emelin");

  // A file whose only credit is a composer means it as the author.
  const composerOnly = await withTags(textItem("©wrt", "Naomi Novik"));
  assert.equal(composerOnly?.author, "Naomi Novik");
  assert.equal(composerOnly?.narrator, null);
});

test("QuickTime-style meta boxes with no version and flags still parse", async () => {
  const quickTimeUdta = box(
    "udta",
    box("meta", box("hdlr", u32(0), u32(0), latin1("mdir"), latin1("appl"), u32(0), u32(0), u8(0)), box("ilst", textItem("©nam", "Dune")))
  );
  const file = concat(box("ftyp", latin1("M4A ")), box("moov", mvhd(1_000, 1_000), quickTimeUdta));

  const tags = await readAudioFileTags(bytesSource(file));
  assert.equal(tags?.title, "Dune");
});

test("Nero chapter lists are read from udta/chpl", async () => {
  const chapter = (title: string, seconds: number) =>
    concat(u64(seconds * 10_000_000), u8(encoder.encode(title).length), encoder.encode(title));
  const file = concat(
    box("ftyp", latin1("M4B ")),
    box(
      "moov",
      mvhd(1_000, 60_000),
      box(
        "udta",
        box("chpl", u8(1), new Uint8Array(3), u32(0), u8(2), chapter("Opening", 0), chapter("The Road", 30))
      )
    )
  );

  const tags = await readAudioFileTags(bytesSource(file));
  assert.deepEqual(tags?.chapters, [
    { title: "Opening", startSeconds: 0 },
    { title: "The Road", startSeconds: 30 }
  ]);
});

test("QuickTime chapter tracks are followed into the media data", async () => {
  const titles = ["Chapter One", "Chapter Two", "Chapter Three"];
  const samples = titles.map((title) => concat(u16(encoder.encode(title).length), encoder.encode(title)));
  const sampleSizes = samples.map((sample) => sample.length);
  const mdat = box("mdat", ...samples);

  // The chapter track's sample offsets are absolute, so the media data has to
  // be placed before `moov` is built.
  const ftyp = box("ftyp", latin1("M4B "));
  const mdatDataOffset = ftyp.length + 8;

  const timescale = 600;
  const stbl = box(
    "stbl",
    box("stts", u32(0), u32(1), u32(titles.length), u32(timescale * 10)),
    box("stsc", u32(0), u32(1), u32(1), u32(titles.length), u32(1)),
    box("stsz", u32(0), u32(0), u32(titles.length), ...sampleSizes.map(u32)),
    box("stco", u32(0), u32(1), u32(mdatDataOffset))
  );
  const chapterTrack = box(
    "trak",
    box("tkhd", u32(0), u32(0), u32(0), u32(2), new Uint8Array(60)),
    box("mdia", box("mdhd", u32(0), u32(0), u32(0), u32(timescale), u32(0), u32(0)), box("minf", stbl))
  );
  const audioTrack = box(
    "trak",
    box("tkhd", u32(0), u32(0), u32(0), u32(1), new Uint8Array(60)),
    box("tref", box("chap", u32(2)))
  );
  const file = concat(ftyp, mdat, box("moov", mvhd(1_000, 30_000), audioTrack, chapterTrack));

  const tags = await readAudioFileTags(bytesSource(file));
  assert.deepEqual(tags?.chapters, [
    { title: "Chapter One", startSeconds: 0 },
    { title: "Chapter Two", startSeconds: 10 },
    { title: "Chapter Three", startSeconds: 20 }
  ]);
});

test("files with no metadata boxes import without tags rather than failing", async () => {
  const file = concat(box("ftyp", latin1("M4B ")), box("moov", mvhd(1_000, 5_000)));
  const tags = await readAudioFileTags(bytesSource(file));
  assert.ok(tags);
  assert.equal(tags.title, null);
  assert.equal(tags.cover, null);
  assert.deepEqual(tags.chapters, []);
  assert.equal(tags.durationSeconds, 5);
});

test("unknown containers report no tags at all", async () => {
  assert.equal(await readAudioFileTags(bytesSource(encoder.encode("not an audio file at all"))), null);
  assert.equal(await readAudioFileTags(bytesSource(new Uint8Array(0))), null);
});

function id3Frame(id: string, ...payload: Uint8Array[]) {
  const body = concat(...payload);
  return concat(latin1(id), u32(body.length), u16(0), body);
}

function syncSafe(value: number) {
  return Uint8Array.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f
  ]);
}

test("an mp3's ID3v2 frames become book metadata", async () => {
  const frames = concat(
    id3Frame("TIT2", u8(3), encoder.encode("Part One")),
    id3Frame("TALB", u8(3), encoder.encode("Piranesi")),
    id3Frame("TPE1", u8(3), encoder.encode("Susanna Clarke")),
    id3Frame("TCON", u8(3), encoder.encode("Fantasy")),
    id3Frame("TYER", u8(0), latin1("2020")),
    id3Frame("TRCK", u8(0), latin1("2/14")),
    id3Frame("TLEN", u8(0), latin1("5400000")),
    id3Frame("COMM", u8(3), latin1("eng"), u8(0), encoder.encode("The house is beautiful.")),
    id3Frame("TXXX", u8(3), encoder.encode("narrator"), u8(0), encoder.encode("Chiwetel Ejiofor")),
    id3Frame(
      "APIC",
      u8(0),
      latin1("image/png"),
      u8(0),
      u8(3),
      latin1("cover"),
      u8(0),
      PNG_COVER
    )
  );
  const file = concat(latin1("ID3"), u8(3), u8(0), u8(0), syncSafe(frames.length), frames);

  const tags = await readAudioFileTags(bytesSource(file));
  assert.ok(tags);
  assert.equal(tags.title, "Part One");
  assert.equal(tags.album, "Piranesi");
  assert.equal(tags.author, "Susanna Clarke");
  assert.equal(tags.narrator, "Chiwetel Ejiofor");
  assert.equal(tags.description, "The house is beautiful.");
  assert.deepEqual(tags.genres, ["Fantasy"]);
  assert.equal(tags.publishedDate, "2020");
  assert.equal(tags.trackNumber, 2);
  assert.equal(tags.durationSeconds, 5_400);
  assert.equal(tags.cover?.contentType, "image/png");
  assert.deepEqual(tags.cover?.bytes, PNG_COVER);
});

test("a file server that answers 206 with the whole file is still read in slices", async () => {
  // WKWebView's asset handler can acknowledge a range and then send the file
  // from zero. Buffering that response would pull a whole audiobook into
  // memory and take the WebView's content process with it, so the body is
  // sliced from wherever Content-Range says it starts.
  const body = concat(
    box("ftyp", latin1("M4B ")),
    box("free", new Uint8Array(4_096)),
    box("moov", mvhd(1_000, 2_000), ilst(textItem("©nam", "Spinning Silver")))
  );
  const originalFetch = globalThis.fetch;
  let buffered = 0;
  globalThis.fetch = (async () => {
    buffered += 1;
    return new Response(body.slice(), {
      status: 206,
      headers: { "Content-Range": `bytes 0-${body.length - 1}/${body.length}` }
    });
  }) as typeof fetch;
  try {
    const tags = await readAudioFileTags(rangeSource("capacitor://localhost/_capacitor_file_/book.m4a"));
    assert.equal(tags?.title, "Spinning Silver");
    assert.ok(buffered > 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("range reads fall back to streaming when a server ignores Range", async () => {
  const body = concat(box("ftyp", latin1("M4B ")), box("moov", mvhd(1_000, 2_000), ilst(textItem("©nam", "Uprooted"))));
  const originalFetch = globalThis.fetch;
  let rangedRequests = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if ((init?.headers as Record<string, string>)?.Range) rangedRequests += 1;
    // A whole-body 200 is what a file server that does not honour Range sends.
    return new Response(body.slice(), { status: 200 });
  }) as typeof fetch;
  try {
    const tags = await readAudioFileTags(rangeSource("capacitor://localhost/_capacitor_file_/book.m4a", body.length));
    assert.equal(tags?.title, "Uprooted");
    assert.ok(rangedRequests > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** The chapter-track fixture from the QuickTime test, with the sample table counts pluggable. */
function quickTimeChapterFile(titles: string[], options: { counts?: number; co64?: boolean } = {}) {
  const samples = titles.map((title) => concat(u16(encoder.encode(title).length), encoder.encode(title)));
  const sampleSizes = samples.map((sample) => sample.length);
  const mdat = box("mdat", ...samples);
  const ftyp = box("ftyp", latin1("M4B "));
  const mdatDataOffset = ftyp.length + 8;
  const timescale = 600;
  const count = (real: number) => u32(options.counts ?? real);
  const stbl = box(
    "stbl",
    box("stts", u32(0), count(1), u32(titles.length), u32(timescale * 10)),
    box("stsc", u32(0), count(1), u32(1), u32(titles.length), u32(1)),
    box("stsz", u32(0), u32(0), count(titles.length), ...sampleSizes.map(u32)),
    options.co64
      ? box("co64", u32(0), count(1), u64(mdatDataOffset))
      : box("stco", u32(0), count(1), u32(mdatDataOffset))
  );
  const chapterTrack = box(
    "trak",
    box("tkhd", u32(0), u32(0), u32(0), u32(2), new Uint8Array(60)),
    box("mdia", box("mdhd", u32(0), u32(0), u32(0), u32(timescale), u32(0), u32(0)), box("minf", stbl))
  );
  const audioTrack = box(
    "trak",
    box("tkhd", u32(0), u32(0), u32(0), u32(1), new Uint8Array(60)),
    box("tref", box("chap", u32(2)))
  );
  return { file: concat(ftyp, mdat, box("moov", mvhd(1_000, 30_000), audioTrack, chapterTrack)), mdatDataOffset };
}

test("sample tables claiming billions of entries are clamped to their boxes", async () => {
  for (const co64 of [false, true]) {
    const { file } = quickTimeChapterFile(["One", "Two", "Three"], { counts: 0xffffffff, co64 });
    const started = Date.now();
    const tags = await readAudioFileTags(bytesSource(file));
    assert.ok(Date.now() - started < 2_000, "the parser must not walk the claimed entry count");
    // Every count is clamped to what its box holds, so the real table is still read.
    assert.deepEqual(tags?.chapters, [
      { title: "One", startSeconds: 0 },
      { title: "Two", startSeconds: 10 },
      { title: "Three", startSeconds: 20 }
    ]);
  }
});

test("a chunk's chapter samples are fetched with one read", async () => {
  const titles = ["Chapter One", "Chapter Two", "Chapter Three"];
  const { file, mdatDataOffset } = quickTimeChapterFile(titles);
  const mdatLength = titles.reduce((sum, title) => sum + 2 + title.length, 0);
  const inner = bytesSource(file);
  const mediaReads: number[] = [];
  const counting = {
    get size() {
      return inner.size;
    },
    read(offset: number, length: number) {
      if (offset >= mdatDataOffset && offset < mdatDataOffset + mdatLength) mediaReads.push(length);
      return inner.read(offset, length);
    }
  };
  const tags = await readAudioFileTags(counting);
  assert.equal(tags?.chapters.length, 3);
  assert.deepEqual(mediaReads, [mdatLength]);
});
