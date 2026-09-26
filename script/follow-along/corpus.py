#!/usr/bin/env python3
"""Private, repeatable corpus checks. Only reads source EPUB/audio files.

No account, server API, production database, or network access is needed.
Every plan and run has a new directory; failed first attempts remain recorded.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

REPO = Path(__file__).resolve().parents[2]
AUDIO = {'.m4b', '.m4a', '.mp3', '.flac', '.wav'}


def load(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    temporary.replace(path)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def source_identity():
    paths = [str(p.relative_to(REPO)) for p in sorted((REPO / 'apps/server/src').rglob('*.rs'))]
    paths += ['apps/server/Cargo.toml', 'apps/server/Cargo.lock',
              'addons/readalong-sync/package-lock.json', 'script/follow-along/corpus.py']
    return {path: digest(REPO / path) for path in paths}


def norm(text):
    return ' '.join(re.findall(r'\w+', text.casefold(), re.UNICODE))


def epub_metadata(path):
    with zipfile.ZipFile(path) as archive:
        container = ET.fromstring(archive.read('META-INF/container.xml'))
        opf = next(node.attrib['full-path'] for node in container.iter()
                   if node.tag.endswith('rootfile'))
        package = ET.fromstring(archive.read(opf))
        values = lambda tag: [node.text.strip() for node in package.iter()
                              if node.tag.rsplit('}', 1)[-1] == tag and node.text]
        return {'title': next(iter(values('title')), path.stem),
                'authors': values('creator'), 'languages': values('language'),
                'spineItems': sum(node.tag.endswith('itemref') for node in package.iter()),
                'images': sum(node.attrib.get('media-type', '').startswith('image/')
                              for node in package.iter())}


def inventory(library):
    root = Path(library).resolve()
    books = []
    for epub in sorted(root.rglob('*')):
        if epub.suffix.lower() != '.epub':
            continue
        candidates = sorted(p for p in epub.parent.iterdir() if p.suffix.lower() in AUDIO)
        exact = [p for p in candidates if norm(p.stem) == norm(epub.stem)]
        audio = exact[0] if len(exact) == 1 else candidates[0] if len(candidates) == 1 else None
        relative = str(epub.relative_to(root))
        row = {'id': hashlib.sha256(relative.encode()).hexdigest()[:12],
               'epub': str(epub), 'audio': str(audio) if audio else None,
               'audioCandidates': [str(p) for p in candidates], 'role': 'unclassified'}
        try:
            row.update(epub_metadata(epub))
            row['status'] = 'ready' if audio else 'ambiguous' if candidates else 'missing-audio'
        except (OSError, ValueError, zipfile.BadZipFile, ET.ParseError, StopIteration) as error:
            row.update(status='invalid-epub', error=str(error))
        books.append(row)
    return {'schema': 1, 'library': str(root), 'books': books}


def probe(book, output, *, cli=None, scopes=None, ffmpeg='ffmpeg', timeout=7200):
    # Do not inherit production configuration or another probe's settings.
    env = {k: v for k, v in os.environ.items() if not k.startswith(('OPERALIBRE_', 'LIBATION_'))}
    env.update(OPERALIBRE_PROBE_EPUB=book['epub'], OPERALIBRE_PROBE_AUDIO=book['audio'],
               OPERALIBRE_PROBE_FFMPEG=ffmpeg)
    if cli:
        env.update(OPERALIBRE_PROBE_CLI=str(Path(cli).resolve()),
                   OPERALIBRE_PROBE_OUTPUT=str(output.resolve()),
                   OPERALIBRE_PROBE_SCOPES=','.join(map(str, scopes)))
        test = 'manual_real_book_alignment_probe'
    else:
        env['OPERALIBRE_PROBE_MANIFEST'] = str((output / 'scopes.json').resolve())
        test = 'manual_real_book_scope_probe'
    with (output / 'probe.log').open('w') as log:
        subprocess.run(['cargo', 'test', '--locked', '--manifest-path',
                        str(REPO / 'apps/server/Cargo.toml'), test,
                        '--', '--ignored', '--nocapture'], cwd=REPO, env=env,
                       stdout=log, stderr=subprocess.STDOUT, timeout=timeout, check=True)


def select_scopes(scopes, seed, count=3, max_seconds=1800):
    eligible = [s for s in scopes if s['audioRange'] and
                30 <= s['audioRange'][1] - s['audioRange'][0] <= max_seconds
                and len(norm(s['mappedText']).split()) >= 40]
    rng = random.Random(seed)
    # Stratify before inspecting alignment results. Never pick only easy successes.
    chosen = []
    bins = min(count, len(eligible))
    for n in range(bins):
        group = eligible[n * len(eligible) // bins:(n + 1) * len(eligible) // bins]
        if group:
            chosen.append(rng.choice(group)['index'])
    return chosen


def prepare(catalog, output, ids, seed, count, max_seconds):
    output.mkdir(parents=True, exist_ok=False)
    selected = [b for b in catalog['books'] if not ids or b['id'] in ids]
    if not selected or (ids and set(ids) != {b['id'] for b in selected}):
        raise ValueError('No books or unknown book IDs')
    plan = {'schema': 1, 'seed': seed, 'source': source_identity(), 'books': []}
    save(output / 'plan.json', plan)
    for book in selected:
        row = dict(book)
        folder = output / book['id']
        folder.mkdir()
        try:
            if book['status'] != 'ready':
                raise ValueError(f"Book is {book['status']}")
            probe(book, folder)
            scopes = load(folder / 'scopes.json')
            indices = select_scopes(scopes, f"{seed}:{book['id']}", count, max_seconds)
            if not indices:
                raise ValueError('No bounded prose scopes; needs an explicit fixture')
            row.update(status='planned', scopes=indices,
                       scopeManifest=str((folder / 'scopes.json').resolve()),
                       epubSha256=digest(book['epub']))
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            row.update(status='blocked', error=str(error))
        plan['books'].append(row)
        save(output / 'plan.json', plan)
        print(f"{row.get('title', row['id'])}: {row['status']} {row.get('scopes', '')}", flush=True)
    return plan


def validate_map(value, scope):
    errors = []
    start, end = scope['audioRange']
    previous = start
    fragments = value.get('fragments', [])
    for i, fragment in enumerate(fragments):
        a, b = fragment['startSeconds'], fragment['endSeconds']
        if not all(math.isfinite(t) for t in (a, b)) or not start <= a < b <= end + .05 or a < previous:
            errors.append(f'fragment {i}: clock bounds/order')
        previous = a
        if fragment['href'] not in scope['hrefs']:
            errors.append(f'fragment {i}: outside chapter')
        if norm(fragment['text']) not in norm(scope['mappedText']):
            errors.append(f'fragment {i}: text absent from mapped scope')
        size = len(fragment['text'].encode('utf-16-le')) // 2
        for wa, wb, offset, length in fragment.get('words', []):
            if not (all(math.isfinite(t) for t in (wa, wb, offset, length)) and
                    a - .01 <= wa < wb <= b + .01 and
                    isinstance(offset, int) and isinstance(length, int) and
                    0 <= offset < offset + length <= size):
                errors.append(f'fragment {i}: word bounds')
    for gap in value.get('recoveryGaps', []):
        a, b = gap['startSeconds'], gap['endSeconds']
        if not all(math.isfinite(t) for t in (a, b)) or not start <= a < b <= end + .05:
            errors.append('recovery gap outside chapter')
        if any(f['startSeconds'] < b - .001 and f['endSeconds'] > a + .001 for f in fragments):
            errors.append('recovery gap overlaps trusted timing')
    if not fragments:
        errors.append('no usable fragments')
    return errors


def score_labels(value, labels):
    """Every labeled eligible sample is in the denominator, including missing matches.

    Labels must be made independently from audio/text, never copied from the map
    under test. Image page visibility belongs to the browser test layer.
    """
    if not labels:
        return {'status': 'unverified', 'reason': 'No independent labels'}
    checks = []
    for label in labels:
        t = label['at']
        gap = any(g['startSeconds'] <= t < g['endSeconds'] for g in value.get('recoveryGaps', []))
        candidates = [f for f in value['fragments'] if f['startSeconds'] <= t < f['endSeconds']]
        wrong_chapter = label['kind'] == 'prose' and any(f['href'] != label['href'] for f in candidates)
        if label['kind'] == 'hold':
            passed = gap and not candidates
        elif label['kind'] == 'unmatched':
            if not label.get('reason'):
                raise ValueError('Unmatched material needs an independently verified reason')
            passed = not candidates
        elif label['kind'] == 'prose':
            passed = not gap and len(candidates) == 1 and candidates[0]['href'] == label['href'] and norm(label['text']) in norm(candidates[0]['text'])
            if passed and 'startSeconds' in label:
                passed = abs(candidates[0]['startSeconds'] - label['startSeconds']) <= label.get('toleranceSeconds', .5)
        else:
            raise ValueError(f"Unsupported label kind: {label['kind']}")
        checks.append({'label': label, 'passed': passed, 'wrongChapter': wrong_chapter})
    prose = [c for c in checks if c['label']['kind'] == 'prose']
    accuracy = sum(c['passed'] for c in prose) / len(prose) if prose else None
    passed = (accuracy is not None and accuracy >= .97
              and not any(c['wrongChapter'] for c in checks)
              and all(c['passed'] for c in checks if c['label']['kind'] != 'prose'))
    return {'status': 'passed' if passed else 'failed', 'eligible': len(prose),
            'correct': sum(c['passed'] for c in prose), 'accuracy': accuracy, 'checks': checks}


def run_plan(plan_path, output, cli, ffmpeg, ids, labels_path=None):
    plan = load(plan_path)
    books = [b for b in plan['books'] if not ids or b['id'] in ids]
    if not books or (ids and set(ids) != {b['id'] for b in books}):
        raise ValueError('No books or unknown book IDs')
    output.mkdir(parents=True, exist_ok=False)
    labels = load(labels_path) if labels_path else {}
    report = {'schema': 1, 'startedAt': time.time(), 'source': source_identity(),
              'planSha256': digest(plan_path), 'labelsSha256': digest(labels_path) if labels_path else None, 'books': []}
    ledger = Path(plan_path).parent / 'attempts'
    ledger.mkdir(exist_ok=True)
    for book in books:
        row = {'id': book['id'], 'title': book.get('title'), 'status': 'running'}
        folder = output / book['id']
        folder.mkdir()
        report['books'].append(row)
        save(output / 'report.json', report)
        try:
            if book['status'] != 'planned':
                raise ValueError('Book was not successfully planned')
            if digest(book['epub']) != book['epubSha256']:
                raise ValueError('EPUB changed after planning')
            row['audioSha256'] = digest(book['audio'])
            # Exclusive first-attempt receipt survives crashes and failed runs.
            try:
                with (ledger / f"{book['id']}.json").open('x') as receipt:
                    json.dump({'run': str(output.resolve()), 'source': report['source'],
                               'audioSha256': row['audioSha256']}, receipt)
                row['attempt'] = 'first-recorded'
            except FileExistsError:
                row['attempt'] = 'repeat'
            row['role'] = book.get('role', 'unclassified')
            probe(book, folder, cli=cli, scopes=book['scopes'], ffmpeg=ffmpeg)
            scopes = {s['index']: s for s in load(book['scopeManifest'])}
            row['scopes'] = []
            for index in book['scopes']:
                value = load(folder / f'scope-{index}.json')
                errors = validate_map(value, scopes[index])
                quality = score_labels(value, labels.get(book['id'], {}).get(str(index), []))
                row['scopes'].append({'index': index, 'fragments': len(value['fragments']),
                                      'structuralErrors': errors, 'quality': quality})
            row['status'] = ('failed' if any(s['structuralErrors'] or s['quality']['status'] == 'failed' for s in row['scopes'])
                             else 'passed' if all(s['quality']['status'] == 'passed' for s in row['scopes']) else 'unverified')
        except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
            row.update(status='failed', error=str(error))
        save(output / 'report.json', report)
        print(f"{row['title']}: {row['status']}", flush=True)
    report['completedAt'] = time.time()
    save(output / 'report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    inv = commands.add_parser('inventory')
    inv.add_argument('--library', required=True)
    inv.add_argument('--output', type=Path, required=True)
    plan = commands.add_parser('plan')
    plan.add_argument('--catalog', type=Path, required=True)
    plan.add_argument('--output', type=Path, required=True)
    plan.add_argument('--books', nargs='+')
    plan.add_argument('--seed', default='follow-along-v1')
    plan.add_argument('--scopes', type=int, default=3)
    plan.add_argument('--max-seconds', type=float, default=1800)
    run = commands.add_parser('run')
    run.add_argument('--plan', type=Path, required=True)
    run.add_argument('--output', type=Path, required=True)
    run.add_argument('--cli', required=True)
    run.add_argument('--ffmpeg', default='ffmpeg')
    run.add_argument('--books', nargs='+')
    run.add_argument('--labels', type=Path)
    args = parser.parse_args()
    if args.command == 'inventory':
        if args.output.exists():
            raise ValueError('Catalog already exists; choose a fresh output')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        result = inventory(args.library)
        save(args.output, result)
        print(json.dumps({status: sum(b['status'] == status for b in result['books'])
                          for status in sorted({b['status'] for b in result['books']})}))
    elif args.command == 'plan':
        if args.scopes < 1 or args.max_seconds < 30:
            raise ValueError('Invalid sampling limits')
        result = prepare(load(args.catalog), args.output, args.books, args.seed, args.scopes, args.max_seconds)
        return int(any(b['status'] != 'planned' for b in result['books']))
    else:
        result = run_plan(args.plan, args.output, args.cli, args.ffmpeg, args.books, args.labels)
        # Unlabeled output is deliberately not a passing accuracy benchmark.
        return 1 if any(b['status'] == 'failed' for b in result['books']) else 2 if any(b['status'] == 'unverified' for b in result['books']) else 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
