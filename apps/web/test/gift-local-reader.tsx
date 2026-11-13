import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import { stageGiftImport, type NativeGiftAsset } from "../src/giftDeviceImport";
import { getDeviceBooks, DEVICE_USER } from "../src/localLibrary";
import { useReadalong } from "../src/useReadalong";
import { serverCapabilities } from "../src/serverCapabilities";
import { findActiveFragmentIndex } from "../src/readalong";
import { EpubReadalong } from "../src/EpubReadalong";
import type { Book } from "../src/types";
import "../src/styles.css";

declare global {
  interface Window {
    giftReaderFiles: Map<string, Uint8Array>;
    giftReaderStatus: { phase: string; error?: string; mapLoaded?: boolean; mapChecked?: boolean; fragment?: number; source?: string; following?: boolean; available?: boolean; otherAvailable?: boolean };
    giftReaderSeek(seconds: number): void;
    giftReaderClose(): void;
    giftReaderSlow: boolean;
    giftReaderReadStarted: boolean;
    giftReaderReadAborted: boolean;
  }
}
const id = "gift_reader_test", folder = `device-library/gift-${id}`;
const encode = (text: string) => new TextEncoder().encode(text);
const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, "0")).join("");
function wav(seconds: number) {
  const bytes = new Uint8Array(44 + 16000 * 2 * seconds), view = new DataView(bytes.buffer);
  bytes.set(encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set(encode("data"), 36); view.setUint32(40, bytes.length - 44, true);
  return bytes;
}
async function fixture() {
  if (new URLSearchParams(location.search).get("actual") === "1") {
    const selected = await (await fetch("/test/gift-alignment-actual.json")).json();
    const bytes = Uint8Array.from(atob(selected.archiveBase64), character => character.charCodeAt(0));
    const zip = await JSZip.loadAsync(bytes), assets = selected.assets as NativeGiftAsset[];
    const metadataJson = await zip.file(assets.find(asset => asset.kind === "metadata")!.name)!.async("string");
    const metadata = JSON.parse(metadataJson);
    const epubBytes = await zip.file(assets.find(asset => asset.kind === "ebook")!.name)!.async("uint8array");
    const extract = async () => {
      for (const asset of assets) {
        const content = await zip.file(asset.name)!.async("uint8array");
        if (content.length !== asset.size || await hash(content) !== asset.sha256) throw new Error("Invalid Rust archive receipt");
        window.giftReaderFiles.set(`${folder}/${asset.name}`, content);
      }
      return { directory: folder, metadataJson };
    };
    await stageGiftImport(localStorage, id, assets, { title: metadata.title, author: metadata.author, description: metadata.description }, extract);
    return { book: getDeviceBooks().find(book => book.id === `device:gift:${id}`)!, epubBytes };
  }
  const epub = new JSZip();
  epub.file("mimetype", "application/epub+zip", { compression: "STORE" });
  epub.file("META-INF/container.xml", '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  epub.file("OEBPS/content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">gift-test</dc:identifier><dc:title>Local gift</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="Text/one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="Text/two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  const xhtml = (text: string) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Local gift</title></head><body><p>${text}</p></body></html>`;
  epub.file("OEBPS/Text/one.xhtml", xhtml("First sentence."));
  epub.file("OEBPS/Text/two.xhtml", xhtml("Second sentence. Last sentence."));
  epub.file("OEBPS/nav.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="Text/one.xhtml">One</a></li><li><a href="Text/two.xhtml">Two</a></li></ol></nav></body></html>');
  const epubBytes = await epub.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const map = { version: 2, precision: "sentence", fragments: [
    { startSeconds: 0, endSeconds: 0.8, href: "Text/one.xhtml", text: "First sentence." },
    { startSeconds: 1.1, endSeconds: 1.8, href: "Text/two.xhtml", text: "Second sentence." },
    { startSeconds: 2, endSeconds: 2.8, href: "Text/two.xhtml", text: "Last sentence." },
  ] };
  const metadata = { version: 1, title: "Local gift", author: "Author", narrator: "Narrator", description: null, genres: [], tags: [], publishedDate: null, asin: null,
    metadata: { publisher: "Publisher", language: "en", genres: [] },
    tracks: [{ fileName: "one.wav", title: "One", index: 0, durationSeconds: 1, chapters: [] }, { fileName: "two.wav", title: "Two", index: 1, durationSeconds: 2, chapters: [] }],
    alignment: { assetName: "alignment.sync.json", ebookAssetName: "book.epub", audioAssetNames: ["one.wav", "two.wav"], timeline: "book", precision: "sentence" } };
  const metadataJson = JSON.stringify(metadata);
  const payloads = new Map<string, { kind: NativeGiftAsset["kind"]; bytes: Uint8Array }>([
    ["book.epub", { kind: "ebook", bytes: epubBytes }], ["one.wav", { kind: "audio", bytes: wav(1) }], ["two.wav", { kind: "audio", bytes: wav(2) }],
    ["alignment.sync.json", { kind: "alignment", bytes: encode(JSON.stringify(map)) }], ["metadata.json", { kind: "metadata", bytes: encode(metadataJson) }],
  ]);
  const assets = await Promise.all([...payloads].map(async ([name, { kind, bytes }]) => ({ name, kind, size: bytes.length, sha256: await hash(bytes) })));
  // Exercise actual ZIP entry/receipt bytes; only the OS commit itself is a
  // test boundary. Production plugins perform their own no-follow commit.
  const archive = new JSZip(); for (const [name, entry] of payloads) archive.file(name, entry.bytes);
  const zip = await JSZip.loadAsync(await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  const extract = async () => {
    for (const asset of assets) {
      const bytes = await zip.file(asset.name)!.async("uint8array");
      if (bytes.length !== asset.size || await hash(bytes) !== asset.sha256) throw new Error("Invalid fixture receipt");
      window.giftReaderFiles.set(`${folder}/${asset.name}`, bytes);
    }
    return { directory: folder, metadataJson };
  };
  await stageGiftImport(localStorage, id, assets, { title: "Local gift", author: "Author", description: null }, extract);
  const failure = new URLSearchParams(location.search).get("failure");
  if (failure === "cancelled") window.giftReaderSlow = true;
  if (failure === "tampered") window.giftReaderFiles.set(`${folder}/alignment.sync.json`, new Uint8Array(payloads.get("alignment.sync.json")!.bytes.length));
  if (failure === "missing") window.giftReaderFiles.delete(`${folder}/alignment.sync.json`);
  return { book: getDeviceBooks().find(book => book.id === `device:gift:${id}`)!, epubBytes };
}

function Reader({ book, epubBytes }: { book: Book; epubBytes: Uint8Array }) {
  const [position, setPosition] = useState(0.2);
  window.giftReaderSeek = setPosition;
  const reader = useReadalong({ capabilities: serverCapabilities("operalibre", DEVICE_USER, { local: true }), currentUser: DEVICE_USER, demoMode: false, followSyncEnabled: true, isOperaLibre: false, isViewingPlayingBook: true, loadBooks: async () => {}, localMode: true, native: true, readalongEnabled: true, selectedBook: book, selectedBookId: book.id, setNativePlayerView: () => {}, setNativeTab: () => {}, setSelectedBookId: () => {}, setSyncConfirmationBook: () => {} });
  window.giftReaderClose = () => reader.setReadalongOpen(false);
  useEffect(() => { reader.setReadalongOpen(true); }, []);
  const fragments = reader.selectedSyncFragments;
  window.giftReaderStatus = { phase: "ready", mapLoaded: !!fragments?.length, mapChecked: reader.localSyncMapChecked, following: reader.narrationFollowActive, available: reader.sentenceFollowAvailable, otherAvailable: reader.sentenceFollowAvailableForBook({ ...book, id: "device:gift:another_gift____" }), fragment: fragments ? findActiveFragmentIndex(fragments, position) : -1, source: book.source };
  return <main><p id="gift-reader-mode">{reader.selectedReadAlongMode}</p><p id="gift-reader-publisher">{book.metadata.publisher}</p>{reader.activeCompanionUrl ? <EpubReadalong bookId={book.id} title={book.title} storageScope="standalone-gift-test" url={reader.activeCompanionUrl} loadSource={async () => Uint8Array.from(epubBytes).buffer} listeningChapter={null} syncTarget={null} syncFragments={fragments} positionSeconds={position} /> : <p>Opening local EPUB…</p>}</main>;
}
window.giftReaderStatus = { phase: "importing" };
void fixture().then(({ book, epubBytes }) => createRoot(document.getElementById("root")!).render(<Reader book={book} epubBytes={epubBytes} />)).catch(error => { window.giftReaderStatus = { phase: "failed", error: error.message }; document.getElementById("root")!.textContent = error.message; });
