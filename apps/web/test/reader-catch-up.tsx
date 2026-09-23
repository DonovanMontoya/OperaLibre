// Browser fixture: npm run dev -w @operalibre/web, then /test/reader-catch-up.html.
// Uses the production reader and a generated EPUB; no server or personal library.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import { EpubReadalong } from "../src/EpubReadalong";
import "../src/styles.css";

const zip = new JSZip();
zip.file("mimetype", "application/epub+zip");
zip.file("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
zip.file("book.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">catch-up-fixture</dc:identifier><dc:title>Catch-up fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${[1, 2, 3].map(n => `<item id="c${n}" href="c${n}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${[1, 2, 3].map(n => `<itemref idref="c${n}"/>`).join("")}</spine></package>`);
zip.file("nav.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${[1, 2, 3].map(n => `<li><a href="c${n}.xhtml#start">Chapter ${n}</a></li>`).join("")}</ol></nav></body></html>`);
for (const n of [1, 2, 3]) zip.file(`c${n}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head><body><h1 id="start">Chapter ${n}</h1>${Array.from({ length: 30 }, (_, i) => `<p>Chapter ${n}, paragraph ${i + 1}. The reader keeps this page while the narrator continues along the river. Returning to an earlier passage should always be possible.</p>`).join("")}</body></html>`);
const bytes = await zip.generateAsync({ type: "arraybuffer" });

const params = new URLSearchParams(location.search);
const narration = params.has("narration");
const chapterSync = params.has("chapter-sync");
const immersive = params.has("immersive");
if (immersive) document.documentElement.classList.add("native-app");
const fragments = [
  { startSeconds: 0, endSeconds: 10, href: "c1.xhtml", text: "Chapter 1, paragraph 1." },
  { startSeconds: 10, endSeconds: 20, href: "c1.xhtml", text: "This sentence is absent from the EPUB." },
  { startSeconds: 20, endSeconds: 30, href: "c1.xhtml", text: "Chapter 1, paragraph 2." },
  { startSeconds: 30, endSeconds: 40, href: "c2.xhtml", text: "This chapter also lacks the narrated sentence." },
  { startSeconds: 40, endSeconds: 50, href: "c2.xhtml", text: "Chapter 2, paragraph 1." }
];

function Fixture() {
  const [open, setOpen] = useState(true);
  const [chapter, setChapter] = useState(2);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  return <>
    <button onClick={() => setOpen(!open)}>{open ? "Close ebook" : "Open ebook"}</button>
    <button onClick={() => setChapter(chapter === 2 ? 3 : 2)}>Advance audio ({chapter})</button>
    {narration && <label>Narration position<input type="number" value={position} onChange={event => setPosition(Number(event.target.value))} /></label>}
    {open && <EpubReadalong bookId="fixture" storageScope="catch-up-fixture" title="Catch-up fixture"
      immersive={immersive} onClose={() => setOpen(false)} positionLabel={`${position}s`}
      playback={immersive ? {
        playing, speed: 1, sleepRemaining: 0,
        onToggle: () => setPlaying(value => !value),
        onSkip: delta => setPosition(value => Math.max(0, value + delta)),
        onOpen: () => {}
      } : null}
      url="/fixture.epub" loadSource={async () => bytes.slice(0)} listeningChapter={`Chapter ${chapter}`}
      syncTarget={chapterSync
        ? { id: `chapter-${chapter}`, title: `Chapter ${chapter}` }
        : null}
      syncFragments={narration ? fragments : null} positionSeconds={position} onSeekTo={setPosition} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
