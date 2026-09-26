import assert from "node:assert/strict";
import { it } from "node:test";
import type { Book as EpubBook, Contents } from "epubjs";
import type { Chapter } from "../src/types.ts";
import { findIllustrationGaps, illustrationGapAt, imageCfiOnPage } from "../src/readerIllustrationGaps.ts";

it("acknowledges a visible image even when the page's text bounds stop before its CFI", () => {
  const cfi = "epubcfi(/6/20!/4/10/2)";
  const viewport = { left: 0, right: 320, top: 50, bottom: 550 };
  let rectangle = { left: 976, right: 1264, top: 0, bottom: 420, width: 288, height: 420 };
  let frame = { left: -960, top: 50 };
  const image = { nodeType: 1, localName: "img", getBoundingClientRect: () => rectangle };
  const contents = {
    cfiBase: "/6/20", range: () => ({ startContainer: image }),
    document: { defaultView: { frameElement: { getBoundingClientRect: () => frame } } }
  } as unknown as Contents;
  assert.equal(imageCfiOnPage([contents], cfi, viewport), true);
  assert.equal(imageCfiOnPage([contents], "epubcfi(/6/22!/4/10/2)", viewport), false);
  // The prior page remains off-screen after the text reflows.
  frame = { left: -640, top: 50 };
  assert.equal(imageCfiOnPage([contents], cfi, viewport), false);
  frame = { left: -960, top: 600 };
  assert.equal(imageCfiOnPage([contents], cfi, viewport), false);
  rectangle = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  assert.equal(imageCfiOnPage([contents], cfi, viewport), false);
  assert.equal(imageCfiOnPage([], cfi, viewport), false);
});

function chapter(startSeconds: number): Chapter {
  return { id: String(startSeconds), title: "Chapter", trackId: "audio", trackIndex: 0, startSeconds, endSeconds: null, source: "embedded" };
}

function headingBody() {
  return {
    nodeType: 1, localName: "body",
    childNodes: [{ nodeType: 1, localName: "section", childNodes: [
      { nodeType: 1, localName: "header", childNodes: [{ nodeType: 1, localName: "img", childNodes: [] }] },
      { nodeType: 3, textContent: "Chapter prose inside the same outer container as its heading image." }
    ] }],
    children: [{ matches: () => false, querySelector: () => ({}), textContent: "" }],
    textContent: "",
    querySelector: () => ({})
  };
}

it("targets the named heading image after a decorative flourish", async () => {
  const ornament = { getAttribute: () => "flourish" };
  const heading = { getAttribute: () => "Chapter Seven" };
  const body = { ...headingBody(), querySelectorAll: () => [ornament, heading] };
  const section = { href: "chapter.xhtml", index: 0, document: { body }, load: async () => undefined,
    cfiFromElement: (element: unknown) => element === heading ? "heading-cfi" : "ornament-cfi" };
  const book = { spine: { get: () => section }, load: async () => undefined } as unknown as EpubBook;
  const gaps = await findIllustrationGaps(book, [{ startSeconds: 13, endSeconds: 18, href: section.href, text: "The first sentence." }], [{ ...chapter(0), title: "Dedication" }, { ...chapter(8), title: "Chapter 7 - A New Beginning" }]);
  assert.equal(illustrationGapAt(gaps, 9)?.cfi, "heading-cfi");
  assert.equal(illustrationGapAt(gaps, 9)?.startSeconds, 8);
});

it("follows a chapter's trailing illustration before an unspoken part divider", async () => {
  const picture = { nodeType: 1, localName: "img", childNodes: [] };
  const sections = [
    { href: "before.xhtml", index: 0, load: async () => undefined,
      document: { body: { nodeType: 1, localName: "body", childNodes: [
        { nodeType: 1, localName: "img", childNodes: [] },
        { nodeType: 3, textContent: "The final sentence." }, picture
      ] } },
      cfiFromElement: (element: unknown) => element === picture ? "epubcfi(/6/2!/4/6)" : "wrong-heading"
    },
    { href: "part.xhtml", index: 1, load: async () => undefined, document: { body: headingBody() } },
    { href: "after.xhtml", index: 2, load: async () => undefined, document: { body: headingBody() } }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 9, href: "before.xhtml", text: "The final sentence." },
    { startSeconds: 75, endSeconds: 80, href: "after.xhtml", text: "Chapter prose." }
  ];
  const chapters = [{ ...chapter(10), title: "Part One: Illustration: A Study" }, chapter(70)];
  const gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.equal(illustrationGapAt(gaps, 30)?.href, "before.xhtml");
  assert.equal(illustrationGapAt(gaps, 30)?.cfi, "epubcfi(/6/2!/4/6)");
  assert.equal(illustrationGapAt(gaps, 71)?.href, "after.xhtml");
  assert.equal(illustrationGapAt(gaps, 71)?.heading, true);
});

it("shows an image-only spine page during an unmapped narrated interval", async () => {
  const picture = {
    href: "illustration.xhtml",
    index: 1,
    document: { body: { textContent: "", querySelector: () => ({}) } },
    load: async () => undefined
  };
  const sections = [
    { href: "before.xhtml", index: 0 },
    picture,
    { href: "after.xhtml", index: 2, prev: () => picture }
  ];
  const book = {
    spine: {
      get: (key: string | number) => sections.find((section) => section.href === key || section.index === key)
    },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 4, href: "before.xhtml", text: "Before." },
    { startSeconds: 74, endSeconds: 79, href: "after.xhtml", text: "After." }
  ];

  const gaps = await findIllustrationGaps(book, fragments);
  assert.deepEqual(gaps, [{ startSeconds: 9, endSeconds: 74, href: "illustration.xhtml" }]);
  assert.equal(illustrationGapAt(gaps, 8), null);
  assert.equal(illustrationGapAt(gaps, 10)?.href, "illustration.xhtml");
  assert.equal(illustrationGapAt(gaps, 74), null);
});

it("holds a closing illustration through the rest of its audio chapter", async () => {
  const picture = { nodeType: 1, localName: "img", childNodes: [] };
  const body = { nodeType: 1, localName: "body", childNodes: [
    { nodeType: 3, textContent: "The final sentence." }, picture
  ] as unknown[] };
  const section = { href: "chapter.xhtml", index: 0, document: { body }, load: async () => undefined,
    cfiFromElement: () => "closing-picture-cfi" };
  const book = { spine: { get: () => section }, load: async () => undefined } as unknown as EpubBook;
  const fragments = [{ startSeconds: 1, endSeconds: 10, href: section.href, text: "The final sentence." }];
  const chapters = [{ ...chapter(0), endSeconds: 45 }];
  let gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.equal(illustrationGapAt(gaps, 20)?.cfi, "closing-picture-cfi");
  assert.equal(illustrationGapAt(gaps, 44)?.cfi, "closing-picture-cfi");
  assert.equal(illustrationGapAt(gaps, 45), null);
  // A split audio chapter must not jump to the picture while prose remains.
  body.childNodes.push({ nodeType: 3, textContent: "More prose is still ahead." });
  gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.equal(illustrationGapAt(gaps, 20), null);
  // With two pictures there is no evidence for when to turn between them.
  body.childNodes.pop(); body.childNodes.push(picture);
  gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.equal(illustrationGapAt(gaps, 20), null);
});

it("keeps a split chapter's earlier picture during its closing description without reopening the heading", async () => {
  const text = (textContent: string) => ({ nodeType: 3, textContent });
  const heading = { nodeType: 1, localName: "img", childNodes: [] };
  const picture = { nodeType: 1, localName: "img", childNodes: [] };
  const body = { nodeType: 1, localName: "body", childNodes: [heading, text("First sentence. "), picture, text("Last sentence. Later prose.")] as unknown[] };
  const section = { href: "chapter.xhtml", index: 0, document: { body }, load: async () => undefined,
    cfiFromElement: (element: unknown) => element === picture ? "picture-cfi" : "heading-cfi" };
  const book = { spine: { get: () => section }, load: async () => undefined } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 2, endSeconds: 6, href: section.href, text: "First sentence." },
    { startSeconds: 10, endSeconds: 15, href: section.href, text: "Last sentence." },
    { startSeconds: 40.2, endSeconds: 45, href: section.href, text: "Later prose." }
  ];
  const chapters = [{ ...chapter(0), title: "Chapter 7A" }, { ...chapter(40), title: "Chapter 7B", endSeconds: 50 }];
  let gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.equal(illustrationGapAt(gaps, 25)?.cfi, "picture-cfi");
  assert.equal(illustrationGapAt(gaps, 40.1)?.cfi, "picture-cfi");
  assert.ok(!gaps.some(gap => gap.heading && gap.startSeconds === 40));
  // Two figures inside part A cannot be assigned without stronger evidence.
  body.childNodes.splice(3, 0, { ...picture });
  gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.equal(illustrationGapAt(gaps, 25), null);
});

it("turns between a named part image and illustration within the same document", async () => {
  const part = { getAttribute: (name: string) => name === "alt" ? "Day Five: The travellers" : null };
  const map = { getAttribute: (name: string) => name === "alt" ? "A mountain map. Description: A winding path." : null };
  const sections = [
    { href: "before.xhtml", index: 0 },
    { href: "pictures.xhtml", index: 1, load: async () => undefined,
      document: { body: { textContent: "", querySelector: () => part, querySelectorAll: () => [part, map] } },
      cfiFromElement: (element: unknown) => element === part ? "part-cfi" : "map-cfi"
    },
    { href: "after.xhtml", index: 2 }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined,
    loaded: { navigation: Promise.resolve({ toc: [{ href: "pictures.xhtml", label: "Day Five" }] }) }
  } as unknown as EpubBook;
  const gaps = await findIllustrationGaps(book, [
    { startSeconds: 0, endSeconds: 4, href: "before.xhtml", text: "Before." },
    { startSeconds: 100, endSeconds: 110, href: "after.xhtml", text: "After." }
  ], [
    { ...chapter(10), title: "Day Five" },
    { ...chapter(25), title: "Day Five: Illustration: A mountain map" }, chapter(100)
  ]);
  assert.equal(illustrationGapAt(gaps, 12)?.cfi, "part-cfi");
  assert.equal(illustrationGapAt(gaps, 26)?.cfi, "map-cfi");
  assert.equal(illustrationGapAt(gaps, 99)?.cfi, "map-cfi");
});

it("turns through two narrated picture pages at audiobook chapter markers", async () => {
  const image = (href: string, index: number) => ({
    href, index,
    document: { body: { textContent: "", querySelector: () => ({}) } },
    load: async () => undefined
  });
  const sections = [
    { href: "before.html", index: 0 },
    image("part-title.html", 1),
    image("annotated-map.html", 2),
    { href: "after.html", index: 3 }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 4, href: "before.html", text: "Before." },
    { startSeconds: 184, endSeconds: 190, href: "after.html", text: "After." }
  ];
  const gaps = await findIllustrationGaps(book, fragments, [chapter(7), chapter(18), chapter(176)]);
  assert.deepEqual(gaps, [
    { startSeconds: 7, endSeconds: 18, href: "part-title.html" },
    { startSeconds: 18, endSeconds: 184, href: "annotated-map.html" }
  ]);
  assert.equal(illustrationGapAt(gaps, 17)?.href, "part-title.html");
  assert.equal(illustrationGapAt(gaps, 18)?.href, "annotated-map.html");
});

it("follows two named image chapters when forced text timing hides their gaps", async () => {
  const image = (href: string, index: number) => ({
    href, index,
    document: { body: { textContent: "", querySelector: () => ({}) } },
    load: async () => undefined
  });
  const sections = [
    { href: "interlude.html", index: 0 },
    image("part-four.html", 1),
    image("glyphs.html", 2),
    { href: "next-chapter.html", index: 3 }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined,
    loaded: { navigation: Promise.resolve({ toc: [
      { href: "part-four.html", label: "Part Four: A Knowledge" },
      { href: "glyphs.html", label: "Alethi Glyphs Page 2" }
    ] }) }
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 9, href: "interlude.html", text: "The Sword." },
    { startSeconds: 15, endSeconds: 25, href: "next-chapter.html", text: "Forced alignment too early." },
    { startSeconds: 70, endSeconds: 80, href: "next-chapter.html", text: "Still in the glyphs audio." }
  ];
  const chapters = [
    { ...chapter(10), title: "Part Four: A Knowledge" },
    { ...chapter(24), title: "Part Four: A Knowledge: Alethi Glyphs Page 2" },
    { ...chapter(224), title: "Chapter 73" }
  ];

  const gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.deepEqual(gaps, [
    { startSeconds: 10, endSeconds: 24, href: "part-four.html" },
    { startSeconds: 24, endSeconds: 224, href: "glyphs.html" }
  ]);
  assert.equal(illustrationGapAt(gaps, 12)?.href, "part-four.html");
  assert.equal(illustrationGapAt(gaps, 30)?.href, "glyphs.html");
});

it("finds a narrated image between mapped snippets inside one EPUB section", async () => {
  const text = (value: string) => ({ nodeType: 3, textContent: value });
  const picture = { nodeType: 1, localName: "img", childNodes: [] };
  const body = {
    nodeType: 1, localName: "body",
    childNodes: [text("THE TEN ESSENCES AND THEIR HISTORICAL ASSOCIATIONS"), picture, text("The preceding list is imperfect.")]
  };
  const section = {
    href: "ars.html", index: 0,
    document: { body },
    load: async () => undefined,
    cfiFromElement: (element: unknown) => element === picture ? "epubcfi(/6/2!/4/2)" : ""
  };
  const book = {
    spine: { get: (key: string | number) => key === 0 || key === "ars.html" ? section : undefined },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 4, href: "ars.html", text: "THE TEN ESSENCES AND THEIR HISTORICAL ASSOCIATIONS" },
    { startSeconds: 204, endSeconds: 210, href: "ars.html", text: "The preceding list is imperfect." }
  ];
  assert.deepEqual(await findIllustrationGaps(book, fragments), [{
    startSeconds: 4, endSeconds: 204, href: "ars.html", cfi: "epubcfi(/6/2!/4/2)"
  }]);
  // A short diagram description still needs its picture, with no arbitrary
  // delay after the preceding prose ends.
  fragments[1].startSeconds = 16;
  fragments[1].endSeconds = 20;
  assert.deepEqual(await findIllustrationGaps(book, fragments), [{
    startSeconds: 4, endSeconds: 16, href: "ars.html", cfi: "epubcfi(/6/2!/4/2)"
  }]);
  body.childNodes = body.childNodes.filter((node) => node !== picture);
  assert.deepEqual(await findIllustrationGaps(book, fragments), []);
});

it("shows an image chapter heading at the audio marker despite an overlapping old fragment", async () => {
  const sections = [
    { href: "old.html", index: 0 },
    { href: "new.html", index: 1, document: { body: headingBody() }, load: async () => undefined }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 12, href: "old.html", text: "Old sentence." },
    { startSeconds: 16, endSeconds: 20, href: "new.html", text: "First body sentence." }
  ];
  assert.deepEqual(await findIllustrationGaps(book, fragments, [chapter(10)]), [
    { startSeconds: 10, endSeconds: 16, href: "new.html", heading: true }
  ]);
});

it("turns from a narrated picture to its image chapter heading before the first mapped sentence", async () => {
  const picture = {
    href: "picture.html", index: 1,
    document: { body: { textContent: "", querySelector: () => ({}) } },
    load: async () => undefined
  };
  const sections = [
    { href: "old.html", index: 0 },
    picture,
    { href: "new.html", index: 2, document: { body: headingBody() }, load: async () => undefined }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 4, href: "old.html", text: "Old sentence." },
    { startSeconds: 74, endSeconds: 80, href: "new.html", text: "First body sentence." }
  ];
  assert.deepEqual(await findIllustrationGaps(book, fragments, [chapter(7), chapter(69)]), [
    { startSeconds: 7, endSeconds: 69, href: "picture.html" },
    { startSeconds: 69, endSeconds: 74, href: "new.html", heading: true }
  ]);
  assert.deepEqual(await findIllustrationGaps(book, fragments, [chapter(7)]), [
    { startSeconds: 7, endSeconds: 69, href: "picture.html" },
    { startSeconds: 69, endSeconds: 74, href: "new.html", heading: true }
  ]);
});

it("shows a brief image-only part page through the next chapter marker", async () => {
  const sections = [
    { href: "interlude.html", index: 0 },
    {
      href: "part04.html", index: 1,
      document: { body: { textContent: "", querySelector: () => ({}) } },
      load: async () => undefined
    },
    { href: "chapter88.html", index: 2, document: { body: headingBody() }, load: async () => undefined }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 4, href: "interlude.html", text: "This was her reward." },
    { startSeconds: 7.85, endSeconds: 10, href: "chapter88.html", text: "EIGHT YEARS AGO" }
  ];
  const gaps = await findIllustrationGaps(book, fragments, [chapter(7.31)]);
  assert.deepEqual(gaps, [
    { startSeconds: 4, endSeconds: 7.85, href: "part04.html", divider: true }
  ]);
  assert.equal(illustrationGapAt(gaps, 7.31)?.href, "part04.html");
  assert.equal(illustrationGapAt(gaps, 7.849)?.href, "part04.html");
  assert.equal(illustrationGapAt(gaps, 7.85), null);
});

it("uses a picture audio chapter when the map wrongly continues highlighting text", async () => {
  const picture = {
    href: "sketchbook.html", index: 1,
    document: { body: { textContent: "", querySelector: () => ({}) } },
    load: async () => undefined
  };
  const sections = [
    { href: "old.html", index: 0 },
    picture,
    { href: "new.html", index: 2, document: { body: headingBody() }, load: async () => undefined }
  ];
  const book = {
    spine: { get: (key: string | number) => sections.find((section) => section.href === key || section.index === key) },
    load: async () => undefined
  } as unknown as EpubBook;
  const fragments = [
    { startSeconds: 0, endSeconds: 5, href: "old.html", text: "Before." },
    { startSeconds: 8, endSeconds: 20, href: "new.html", text: "A sentence wrongly timed over the picture." },
    { startSeconds: 25, endSeconds: 70, href: "new.html", text: "Another sentence wrongly timed over the picture." },
    { startSeconds: 71, endSeconds: 80, href: "new.html", text: "After." }
  ];
  const chapters = [
    { ...chapter(10), title: "Shallan's Sketchbook: Honorspren" },
    { ...chapter(60), title: "Chapter 36" }
  ];
  const gaps = await findIllustrationGaps(book, fragments, chapters);
  assert.deepEqual(gaps, [
    { startSeconds: 10, endSeconds: 60, href: "sketchbook.html" },
    { startSeconds: 60, endSeconds: 71, href: "new.html", heading: true }
  ]);
  assert.equal(illustrationGapAt(gaps, 30)?.href, "sketchbook.html");
  assert.equal(illustrationGapAt(gaps, 65)?.href, "new.html");
});
