// Generated original content; no private books, server, or saved user progress.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import { EpubReadalong } from '../../src/EpubReadalong';
import type { Chapter, SyncFragment, SyncMap } from '../../src/types';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
const sentence = Array.from({ length: 24 }, (_, i) => `Marker ${i + 1} follows the winding river past the old stone bridge`).join(', ') + '.';
const texts = [sentence, 'The lantern keeper opens the eastern gate and welcomes the travelers into the quiet courtyard.', 'Beyond the northern mountains the observatory records a different constellation every winter night.'];
const bounds = [[0, 30], [60, 80], [90, 120]];
const fragments: SyncFragment[] = texts.map((text, i) => ({
  startSeconds: bounds[i][0], endSeconds: bounds[i][1], href: `c${i + 1}.xhtml`, text,
  words: [...text.matchAll(/\S+/g)].map((match, word, all) => [
    bounds[i][0] + word * (bounds[i][1] - bounds[i][0]) / all.length,
    bounds[i][0] + (word + 1) * (bounds[i][1] - bounds[i][0]) / all.length,
    match.index!, match[0].length
  ])
}));
const map: SyncMap = { version: 2, precision: 'sentence', fragments,
  ...(params.has('recovery') ? { recoveryGaps: [{ startSeconds: 30, endSeconds: 60 }, { startSeconds: 80, endSeconds: 90 }] } : {}) };
const chapters: Chapter[] = [
  ['Chapter 1', 0, 30], ['Illustration: River map', 30, 45], ['Illustration: Observatory plan', 45, 60],
  ['Chapter 2', 60, 80], ['Interruption', 80, 90], ['Chapter 3', 90, 120]
].map(([title, startSeconds, endSeconds], i) => ({ id: String(i), title: String(title), startSeconds: Number(startSeconds), endSeconds: Number(endSeconds), trackId: 'fixture', trackIndex: 0, source: 'embedded' }));
const zip = new JSZip();
zip.file('mimetype', 'application/epub+zip');
zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
const spine = ['c1', 'image1', 'image2', 'c2', 'c3'];
zip.file('book.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">follow-regression</dc:identifier><dc:title>River Observatory</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${spine.map(id => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${spine.map(id => `<itemref idref="${id}"/>`).join('')}</spine></package>`);
zip.file('nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${[1, 2, 3].map(n => `<li><a href="c${n}.xhtml">Chapter ${n}</a></li>`).join('')}</ol></nav></body></html>`);
for (let i = 0; i < 3; i++) zip.file(`c${i + 1}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i + 1}</title></head><body><h1>Chapter ${i + 1}</h1><p>${texts[i]}</p></body></html>`);
for (const [i, label] of ['River map', 'Observatory plan'].entries()) zip.file(`image${i + 1}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${label}</title></head><body><svg xmlns="http://www.w3.org/2000/svg" aria-label="${label}" width="250" height="350" viewBox="0 0 250 350"><rect width="250" height="350" fill="${i ? '#c9d9a8' : '#9dc8da'}"/><path d="M50 0 Q230 180 50 350" fill="none" stroke="#123" stroke-width="12"/></svg></body></html>`);
const bytes = await zip.generateAsync({ type: 'arraybuffer' });
const loadSource = async () => bytes.slice(0);
localStorage.setItem('operalibre.readerFollow', '1');

export type FixtureControls = {
  position: number; setPosition(value: number): void; setLead(value: number): void;
  replaceMap(value: SyncMap): void; remount(): void; map: SyncMap;
  play(start: number, end: number, speed: number): Promise<void>; audio: HTMLAudioElement | null;
};
declare global { interface Window { followFixture: FixtureControls } }

function silentAudio() {
  const data = new ArrayBuffer(44 + 120 * 8000 * 2), v = new DataView(data);
  const str = (at: number, text: string) => [...text].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, data.byteLength - 8, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, data.byteLength - 44, true);
  return new Audio(URL.createObjectURL(new Blob([data], { type: 'audio/wav' })));
}
let audio: HTMLAudioElement | null = null;
function Fixture() {
  const [position, setPosition] = useState(1), [lead, setLead] = useState(0);
  const [currentMap, replaceMap] = useState(map), [epoch, setEpoch] = useState(0);
  window.followFixture = { position, setPosition, setLead, replaceMap, map: currentMap,
    remount: () => setEpoch(value => value + 1), audio,
    play: async (start, end, speed) => {
      audio?.pause(); audio = silentAudio(); audio.muted = true; audio.playbackRate = speed;
      await new Promise<void>(resolve => audio!.addEventListener('loadedmetadata', () => resolve(), { once: true }));
      audio.currentTime = start;
      audio.ontimeupdate = () => { setPosition(Math.min(audio!.currentTime, end)); if (audio!.currentTime >= end) audio!.pause(); };
      await audio.play();
    }
  };
  return <><div style={{ position: 'relative', zIndex: 2000 }}>
    <label>Test position<input type="number" value={position} onChange={event => setPosition(Number(event.target.value))} /></label>
    <button onClick={() => setPosition(35)}>Uncertain section</button><button onClick={() => setPosition(61)}>Recovered sentence</button>
  </div><EpubReadalong key={epoch} bookId="follow-regression" storageScope="follow-regression"
    title="River Observatory" url="/generated.epub" loadSource={loadSource} listeningChapter={null} syncTarget={null}
    syncFragments={currentMap.fragments} syncRecoveryGaps={currentMap.recoveryGaps} audioChapters={chapters}
    positionSeconds={position} followLeadSeconds={lead} onSeekTo={setPosition} /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
