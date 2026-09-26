#!/usr/bin/env python3
"""Generate original speech with independently known sentence boundaries.

Uses espeak-ng (Linux/macOS), ffmpeg, and the production alignment probe.
Run on a private worker or in the scheduled workflow; no library is needed.
"""
import argparse
import array
import html
from pathlib import Path
import random
import subprocess
import sys
import wave
import zipfile

from corpus import inventory, prepare, run_plan, save

SENTENCES = [
    'The lantern keeper opened the eastern gate before the travelers reached the quiet courtyard.',
    'A silver heron landed beside the wooden bridge and watched the river in silence.',
    'Beyond the northern mountains an observatory recorded a different constellation every winter night.',
    'The gardener carried a basket of yellow flowers through the narrow passage behind the kitchen.',
    'Under the old clock tower a musician practiced the melody that her grandmother remembered.',
    'Warm sunlight reached the workshop where a carpenter repaired the broken wheel of a wagon.',
    'Several children followed the winding path until they discovered a small fountain among the trees.',
    'The librarian found a folded letter between the final pages of an unfamiliar travel journal.',
    'Along the southern coast the fishing boats returned with bright flags fluttering above their sails.',
    'An engineer carefully measured the distance between the water channel and the foundations of the mill.',
    'The baker left a fresh loaf near the window while the market slowly filled with visitors.',
    'Outside the village a shepherd counted the animals resting beneath the branches of an ancient oak.',
    'A messenger arrived at the station carrying a sealed envelope and a small parcel wrapped in cloth.',
    'The astronomer adjusted the brass telescope until the distant planet became a clear circle of light.',
    'Behind the theater the actors gathered around a table to discuss the final scene of their play.',
    'The captain studied the coastal map before asking the crew to prepare for the morning departure.',
    'Deep inside the forest a narrow stream flowed over smooth stones and disappeared beneath a fallen tree.',
    'The painter mixed a little blue into the silver pigment and returned to the unfinished portrait.',
    'At the edge of the meadow a farmer repaired the fence while swallows circled overhead.',
    'The clockmaker opened the wooden case and listened carefully to the uneven rhythm of the mechanism.',
    'A quiet conversation continued in the greenhouse as rain began to fall against the glass roof.',
    'The young apprentice placed the finished bowl beside the others and waited for the teacher to speak.',
    'Near the western entrance a pair of travelers compared their notes about the road ahead.',
    'When the evening bells rang the last visitors crossed the square and walked toward their homes.'
]
ADDED_AUDIO = 'This older recording includes a separate account of the harbor festival that the revised printed edition omits entirely.'
ADDED_TEXT = 'A later printed edition adds an explanation of the mountain railway which the original narrator never recorded.'


def write_wav(path, frames, rate):
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        wav.writeframes(frames)


def make_epub(path, sections):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('mimetype', 'application/epub+zip')
        z.writestr('META-INF/container.xml', '<container><rootfile full-path="book.opf"/></container>')
        z.writestr('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">original-recovery-fixture</dc:identifier><dc:title>River Observatory</dc:title><dc:creator>Fixture</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>')
        z.writestr('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml">Chapter 1</a></li><li><a href="two.xhtml">Chapter 2</a></li></ol></nav></body></html>')
        for href, sentences in zip(['one.xhtml', 'two.xhtml'], sections):
            z.writestr(href, '<html xmlns="http://www.w3.org/1999/xhtml"><body>' + ''.join('<p>' + html.escape(s) + '</p>' for s in sentences) + '</body></html>')


def generate(output, tts, ffmpeg):
    output.mkdir(parents=True, exist_ok=False)
    speech = output / 'speech'; speech.mkdir()
    chunks = []
    rate = None
    for i, sentence in enumerate(SENTENCES + [ADDED_AUDIO]):
        path = speech / f'{i}.wav'
        subprocess.run([tts, '-v', 'en-us', '-s', '145', '-w', str(path), sentence], check=True)
        with wave.open(str(path), 'rb') as wav:
            assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
            if rate is None:
                rate = wav.getframerate()
            assert wav.getframerate() == rate
            chunks.append(wav.readframes(wav.getnframes()))
    labels = {}
    for variant in ['clean', 'silence-opening', 'noise-opening', 'different-editions']:
        folder = output / 'library' / variant; folder.mkdir(parents=True)
        printed = [list(SENTENCES[:12]), list(SENTENCES[12:])]
        if variant == 'different-editions':
            printed[1].insert(3, ADDED_TEXT)
        make_epub(folder / 'book.epub', printed)
        frames, expected, elapsed = [], {"0": [], "1": []}, 0.0
        second_start = None
        rng = random.Random(47)
        for i, sentence in enumerate(SENTENCES):
            if i == 12:
                second_start = elapsed
            own = expected[str(i // 12)]
            chunk = chunks[i]; duration = len(chunk) / (2 * rate)
            damaged = i < 8 and variant in ('silence-opening', 'noise-opening')
            if damaged:
                chunk = (bytes(len(chunk)) if variant == 'silence-opening' else
                         array.array('h', (rng.randint(-5000, 5000) for _ in range(len(chunk) // 2))).tobytes())
                own.append({'kind': 'hold', 'at': elapsed + duration / 2})
            else:
                own.append({'kind': 'prose', 'at': elapsed + duration / 2, 'href': 'one.xhtml' if i < 12 else 'two.xhtml', 'text': sentence,
                                 'startSeconds': elapsed, 'toleranceSeconds': .75})
            frames.append(chunk); elapsed += duration
            if variant == 'different-editions' and i == 5:
                extra = chunks[-1]; duration = len(extra) / (2 * rate)
                frames.append(extra)
                own.append({'kind': 'unmatched', 'at': elapsed + duration / 2, 'reason': 'Original synthetic narration contains a passage absent from the synthetic EPUB'})
                elapsed += duration
        write_wav(folder / 'source.wav', b''.join(frames), rate)
        metadata = folder / 'chapters.txt'
        metadata.write_text(f';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND={round(second_start * 1000)}\ntitle=Chapter 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART={round(second_start * 1000)}\nEND={round(elapsed * 1000)}\ntitle=Chapter 2\n')
        subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-i', str(folder / 'source.wav'), '-i', str(metadata),
                        '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', '-b:a', '96k', str(folder / 'book.m4b')], check=True)
        # Keep the uncompressed input outside the paired book directory.
        (folder / 'source.wav').replace(speech / f'{variant}.wav')
        labels[variant] = expected
    catalog = inventory(output / 'library')
    truth = {}
    for book in catalog['books']:
        book['role'] = 'synthetic'
        truth[book['id']] = labels[Path(book['epub']).parent.name]
    save(output / 'catalog.json', catalog); save(output / 'labels.json', truth)
    return catalog


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--tts', default='espeak-ng')
    p.add_argument('--ffmpeg', default='ffmpeg')
    p.add_argument('--cli', help='Generate fixtures only when omitted; otherwise exercise the real aligner')
    args = p.parse_args()
    catalog = generate(args.output, args.tts, args.ffmpeg)
    if not args.cli:
        return 0
    prepare(catalog, args.output / 'plan', None, 'synthetic-audio-v1', 2, 1800)
    report = run_plan(args.output / 'plan/plan.json', args.output / 'run', args.cli, args.ffmpeg, None, args.output / 'labels.json')
    return int(any(b['status'] != 'passed' for b in report['books']))


if __name__ == '__main__':
    sys.exit(main())
