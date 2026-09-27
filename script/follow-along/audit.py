#!/usr/bin/env python3
"""Independent ASR agreement audit, not human timing ground truth.

Reference generation only reads the frozen input plan and audio, never maps or
production recognition. Exact unique eight-word EPUB phrases provide checkable
text locations. Unresolved speech is reported separately, never called an
edition difference or silently counted as a successful match.
"""
import argparse
from collections import defaultdict
import math
import json
from pathlib import Path
import re
import subprocess

from corpus import load, save, digest, validate_map, audio_fingerprint

# Reference word clocks are ASR estimates. Keep the exact result, and gate a
# separately named bounded result; a half-second lag must still fail.
BOUNDARY_TOLERANCE_SECONDS = .15
WORD_ONSET_P95_LIMIT_SECONDS = .5


def tokens(text):
    return re.findall(r'\w+', text.casefold().replace('’', '').replace("'", ''))


def words(timeline):
    if isinstance(timeline,dict): timeline=timeline.get("timeline",[])
    result = []
    for entry in timeline:
        if entry.get('type') == 'word':
            a, b = entry.get('startTime'), entry.get('endTime')
            if not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or not (math.isfinite(a) and math.isfinite(b) and 0 <= a < b):
                continue
            for token in tokens(entry.get('text', '')):
                result.append({'text': token, 'start': a, 'end': b})
        else:
            result.extend(words(entry.get('timeline', [])))
    return result


def reference_checks(recognized, sections, offset):
    n = 8
    phrases = {tuple(w['text'] for w in recognized[i:i+n]) for i in range(len(recognized)-n+1)}
    locations = defaultdict(list)
    for section_index, section in enumerate(sections):
        own = tokens(section['text'])
        for at in range(len(own)-n+1):
            phrase = tuple(own[at:at+n])
            if phrase in phrases:
                locations[phrase].append((section_index, at + n // 2))
    checks = []
    for i in range(len(recognized)-n+1):
        phrase = tuple(w['text'] for w in recognized[i:i+n])
        found = locations.get(phrase, [])
        if len(found) != 1:
            continue
        section, token = found[0]
        w = recognized[i+n//2]
        checks.append({'at': offset + (w['start'] + w['end']) / 2,
                       'referenceStart': offset + w['start'], 'referenceEnd': offset + w['end'],
                       'section': section, 'href': sections[section]['href'], 'token': token,
                       'phrase': ' '.join(phrase)})
    return checks


def reader_selection(value, checks):
    result=subprocess.run(['node','--experimental-strip-types','--no-warnings',str(Path(__file__).with_name('reader-selection.mjs'))],
        input=json.dumps(dict(fragments=value['fragments'],recoveryGaps=value.get('recoveryGaps'),times=[c['at'] for c in checks])),
        text=True,capture_output=True,check=True,timeout=30)
    return json.loads(result.stdout)


def nearby_reader_selection(value, checks):
    offsets=(-BOUNDARY_TOLERANCE_SECONDS,0,BOUNDARY_TOLERANCE_SECONDS)
    expanded=[dict(c,at=c['at']+offset) for c in checks for offset in offsets]
    indices=reader_selection(value,expanded)
    return [indices[i:i+3] for i in range(0,len(indices),3)]


def score(value, checks, sections, selected=None, nearby=None):
    positions = {}
    for index, fragment in enumerate(value['fragments']):
        needle = tokens(fragment['text']); matches = []
        if not needle:
            positions[index] = []; continue
        for si, section in enumerate(sections):
            if section['href'] != fragment['href']: continue
            own = tokens(section['text'])
            for at in range(len(own)-len(needle)+1):
                if own[at:at+len(needle)] == needle: matches.append((si, at, at+len(needle)))
        positions[index] = matches
    # Short repeated utterances need neighboring map context, just as the
    # reader needs it to locate their DOM range. Never use reference labels to
    # choose an occurrence, and leave unresolved repetitions unverified.
    unique = {i:p[0] for i,p in positions.items() if len(p)==1}
    previous = None
    following = {}
    next_unique = None
    for i in reversed(range(len(value['fragments']))):
        following[i]=next_unique
        if i in unique: next_unique=unique[i]
    for i in range(len(value['fragments'])):
        if len(positions[i]) > 1:
            after=following[i]
            positions[i]=[p for p in positions[i]
                          if (previous is None or (p[0],p[1]) >= (previous[0],previous[2]))
                          and (after is None or (p[0],p[2]) <= (after[0],after[1]))]
        if len(positions[i])==1: previous=positions[i][0]
    results = []
    for check_index, check in enumerate(checks):
        active = [(i, f) for i, f in enumerate(value['fragments']) if f['startSeconds'] <= check['at'] < f['endSeconds']]
        correct = [(i, f, start) for i, f in active for si, start, end in positions[i]
                   if si == check['section'] and start <= check['token'] < end]
        sentence = len(active) == 1 and len(correct) == 1 and len(positions[active[0][0]]) == 1
        word_error = None
        if sentence:
            _, fragment, start = correct[0]
            # UTF-16 offsets are the reader's actual indexing contract.
            encoded = fragment['text'].encode('utf-16-le')
            for a, b, off, size in fragment.get('words', []):
                before = encoded[:off*2].decode('utf-16-le')
                own = encoded[off*2:(off+size)*2].decode('utf-16-le')
                at = start + len(tokens(before))
                if at <= check['token'] < at + len(tokens(own)):
                    word_error = abs(a - check['referenceStart']); break
        reader_correct = None; reader_wrong_chapter = False
        if selected is not None:
            index=selected[check_index]
            reader_correct = index >= 0 and len(positions[index]) == 1 and any(
                si == check['section'] and start <= check['token'] < end for si,start,end in positions[index])
            reader_wrong_chapter = index >= 0 and value['fragments'][index]['href'] != check['href']
        bounded_correct=None
        if nearby is not None:
            uncertain=any(g['startSeconds'] <= check['at'] < g['endSeconds'] for g in value.get('recoveryGaps',[]))
            bounded_correct=not uncertain and any(index >= 0 and len(positions[index])==1 and any(
                si==check['section'] and start <= check['token'] < end for si,start,end in positions[index])
                for index in nearby[check_index])
        results.append(dict(check, sentenceCorrect=sentence, readerCorrect=reader_correct,
                            boundedReaderCorrect=bounded_correct,
                            readerWrongChapter=reader_wrong_chapter,
                            wrongChapter=any(f['href'] != check['href'] for _, f in active), wordStartError=word_error))
    errors = sorted(r['wordStartError'] for r in results if r['wordStartError'] is not None)
    eligible = len(results); correct = sum(r['sentenceCorrect'] for r in results)
    accuracy = correct / eligible if eligible else None
    reader_correct=sum(r['readerCorrect'] is True for r in results) if selected is not None else None
    reader_accuracy=reader_correct/eligible if reader_correct is not None and eligible else None
    agreement=reader_accuracy if selected is not None else accuracy
    bounded_correct=sum(r['boundedReaderCorrect'] is True for r in results) if nearby is not None else None
    bounded_accuracy=bounded_correct/eligible if bounded_correct is not None and eligible else None
    p95=errors[min(len(errors)-1,math.ceil(len(errors)*.95)-1)] if errors else None
    if nearby is not None: agreement=bounded_accuracy
    timing_ok=nearby is None or (len(errors) >= eligible*.9 and p95 is not None and p95 <= WORD_ONSET_P95_LIMIT_SECONDS)
    return {'readerCorrect':reader_correct,'readerAgreement':reader_accuracy,
            'boundedReaderCorrect':bounded_correct,'boundedReaderAgreement':bounded_accuracy,
            'boundaryToleranceSeconds':BOUNDARY_TOLERANCE_SECONDS if nearby is not None else 0,
            'status': 'insufficient-reference' if eligible < 20 else 'passed' if agreement >= .97 and timing_ok and not any(r['wrongChapter'] or r['readerWrongChapter'] for r in results) else 'failed',
            'eligible': eligible, 'correct': correct, 'sentenceAgreement': accuracy,
            'wrongChapterChecks': sum(r['wrongChapter'] for r in results),
            'readerWrongChapterChecks': sum(r['readerWrongChapter'] for r in results),
            'timedWordChecks':len(errors), 'timedWordCoverage':len(errors)/eligible if eligible else None,
            'wordStartMedianSeconds': errors[len(errors)//2] if errors else None,
            'wordStartP95Seconds':p95,
            'checks': results}


def reference(plan_path, output, cli, ids, ffmpeg):
    plan = load(plan_path); output.mkdir(parents=True, exist_ok=False)
    report = {'kind': 'independent-ASR-reference', 'model': 'small.en', 'planSha256': digest(plan_path), 'auditSha256': digest(__file__), 'books': []}
    save(output/'report.json', report)
    selected = [b for b in plan['books'] if not ids or b['id'] in ids]
    if not selected or ids and set(ids) != {b['id'] for b in selected}: raise ValueError('Unknown book IDs')
    for book in selected:
        row = {'id': book['id'], 'inputSha256': digest(Path(book['scopeManifest']).parent/'input.json'), **audio_fingerprint(book), 'scopes': []}; report['books'].append(row)
        folder = output/book['id']; folder.mkdir()
        scopes = {s['index']: s for s in load(book['scopeManifest'])}
        for index in book.get('scopes', []):
            a, b = book.get('audioSamples', {}).get(str(index), scopes[index]['audioRange'])
            # Freeze a minute near the middle; long samples cross the production
            # window boundary. Guard both ends against cut-off speech.
            duration = min(60, max(0, b-a-10)); start = (a+b-duration)/2
            if duration < 15: continue
            wav = folder/f'{index}.wav'; target = folder/f'{index}.json'
            clip=book.get('audioClips',{}).get(str(index))
            audio=clip['path'] if clip else book['audio']
            local_start=start-clip['start'] if clip else start
            subprocess.run([ffmpeg,'-nostdin','-v','error','-ss',str(local_start),'-i',audio,'-t',str(duration),'-map','0:a:0','-vn','-ac','1','-ar','16000',str(wav)],check=True)
            with (folder/f'{index}.log').open('w') as log:
                subprocess.run([cli,'transcribe',str(wav),str(target),'--engine=whisper','--whisper.model=small.en','--language=en','--overwrite'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=1800)
            row['scopes'].append({'index':index,'start':start,'duration':duration,'wavSha256':digest(wav),'referenceSha256':digest(target)})
            save(output/'report.json', report)
    return report


def markdown_report(result):
    def percent(value): return f'{value:.1%}' if value is not None else 'unverified'
    def cell(value): return str(value).replace('|', '\\|').replace('\n', ' ')
    books=result['books']
    lines=['# Private library follow-along audit', '',
           f"{sum(b['status']=='passed' for b in books)}/{len(books)} books pass every sampled scope.", '',
           'Automated agreement with independent ASR references; not human ground truth, '
           'whole-book coverage, or a guarantee for unseen books. Unrecognized speech remains unverified.', '',
           f"Boundary budget: {result['boundaryToleranceSeconds']*1000:.0f} ms. "
           f"Word-onset p95 limit: {result['wordOnsetP95LimitSeconds']*1000:.0f} ms. "
           'Wrong-chapter checks fail regardless of aggregate accuracy.', '',
           '| Book | Result | Checked words | Exact reader agreement | Within boundary budget |',
           '| --- | --- | ---: | ---: | ---: |']
    for book in books:
        lines.append(f"| {cell(book['title'])} | {book['status']} | {book.get('eligible',0)} | "
                     f"{percent(book.get('readerAgreement'))} | {percent(book.get('boundedReaderAgreement'))} |")
    lines += ['', '## Sample details', '',
              'Reference coverage is the proportion of recognized words located by unique EPUB phrases. '
              'It is not the proportion of the entire book verified. All planned samples are listed, including missing ones.', '',
              '| Book / scope | Result | Reference coverage | Word clocks checked | Word-onset p95 | Wrong chapters (map / reader) |',
              '| --- | --- | ---: | ---: | ---: | ---: |']
    for book in books:
        if book.get('error'): lines += [f"| {cell(book['title'])} | {cell(book['error'])} | — | — | — | — |"]
        for scope in book['scopes']:
            p95=scope.get('wordStartP95Seconds')
            timing=f'{p95*1000:.0f} ms' if p95 is not None else 'unverified'
            wrong=f"{scope.get('wrongChapterChecks',0)} / {scope.get('readerWrongChapterChecks',0)}"
            lines.append(f"| {cell(book['title'])} / {scope['index']} | {scope['status']} | "
                         f"{percent(scope.get('referenceCoverage'))} | {percent(scope.get('timedWordCoverage'))} | {timing} | {wrong} |")
    return '\n'.join(lines)+'\n'


def compare(plan_path, reference_path, run, output):
    if output.exists() or output.with_suffix('.md').exists(): raise ValueError('Choose a new report path')
    plan = load(plan_path); ref = load(reference_path/'report.json')
    if ref['planSha256'] != digest(plan_path): raise ValueError('Reference belongs to another plan')
    result = {'kind':'automated-independent-ASR-agreement', 'auditSha256':digest(__file__), 'readerSourceSha256':digest(Path(__file__).resolve().parents[2]/'apps/web/src/readalong.ts'), 'boundaryToleranceSeconds':BOUNDARY_TOLERANCE_SECONDS, 'wordOnsetP95LimitSeconds':WORD_ONSET_P95_LIMIT_SECONDS, 'planSha256':digest(plan_path), 'limitation':'Shared recognizer family; not human ground truth or a population accuracy guarantee.', 'books':[]}
    for book in plan['books']:
        row = {'id':book['id'],'title':book['title'],'scopes':[]}; result['books'].append(row)
        try:
            if book.get('status') != 'planned':
                row.update(status='blocked-plan'); continue
            source = Path(book['scopeManifest']).parent/'input.json'
            sections = load(source)['sections']
            reference_book = next((b for b in ref['books'] if b['id']==book['id']), None)
            if reference_book is None:
                row.update(status='missing-reference'); continue
            if reference_book.get('inputSha256') and reference_book['inputSha256'] != digest(source):
                row.update(status='changed-reference-input'); continue
            if reference_book.get('audioSha256'):
                current_audio=audio_fingerprint(book)
                if reference_book['audioSha256'] != current_audio['audioSha256'] or (
                    reference_book.get('clipSha256') and reference_book['clipSha256'] != current_audio.get('clipSha256')):
                    row.update(status='changed-reference-audio'); continue
            scoped = {s['index']:s for s in load(book['scopeManifest'])}
            for index in book['scopes']:
                scope = next((s for s in reference_book['scopes'] if s['index']==index),None)
                if scope is None:
                    row['scopes'].append({'index':index,'status':'missing-reference-scope'}); continue
                matches=list(run.glob(f'**/{book["id"]}/scope-{index}.json'))
                if len(matches)!=1:
                    row['scopes'].append({'index':index,'status':'missing-or-ambiguous-map'}); continue
                references=list(reference_path.glob(f'**/{book["id"]}/{index}.json'))
                if len(references)!=1 or digest(references[0]) != scope['referenceSha256']:
                    row['scopes'].append({'index':index,'status':'missing-or-changed-reference'}); continue
                raw=words(load(references[0]))
                checks=reference_checks(raw,sections,scope['start'])
                value=load(matches[0])
                bounds=dict(scoped[index])
                bounds['audioRange']=book.get('audioSamples',{}).get(str(index),bounds['audioRange'])
                errors=validate_map(value,bounds)
                own=score(value,checks,sections,reader_selection(value,checks),nearby_reader_selection(value,checks))
                own['structuralErrors']=errors
                if errors: own['status']='invalid-map'
                own.update(index=index,recognizedWords=len(raw),referenceCoverage=len(checks)/max(1,len(raw)-7))
                if own['status']=='passed' and own['referenceCoverage'] < .5:
                    own['status']='insufficient-reference'
                row['scopes'].append(own)
            row['eligible']=sum(s.get('eligible',0) for s in row['scopes'])
            row['correct']=sum(s.get('correct',0) for s in row['scopes'])
            row['readerCorrect']=sum(s.get('readerCorrect',0) for s in row['scopes'])
            row['readerAgreement']=row['readerCorrect']/row['eligible'] if row['eligible'] else None
            row['boundedReaderCorrect']=sum(s.get('boundedReaderCorrect',0) for s in row['scopes'])
            row['boundedReaderAgreement']=row['boundedReaderCorrect']/row['eligible'] if row['eligible'] else None
            row['sentenceAgreement']=row['correct']/row['eligible'] if row['eligible'] else None
            row['status']='passed' if row['scopes'] and all(s['status']=='passed' for s in row['scopes']) else 'needs-review'
        except Exception as error:
            row.update(status='audit-error',error=str(error))
    save(output,result)
    output.with_suffix('.md').write_text(markdown_report(result))
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='command',required=True)
    r=sub.add_parser('reference');r.add_argument('--plan',type=Path,required=True);r.add_argument('--output',type=Path,required=True);r.add_argument('--cli',required=True);r.add_argument('--books',nargs='+');r.add_argument('--ffmpeg',default='ffmpeg')
    c=sub.add_parser('compare');c.add_argument('--plan',type=Path,required=True);c.add_argument('--reference',type=Path,required=True);c.add_argument('--run',type=Path,required=True);c.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    if a.command=='reference': reference(a.plan,a.output,a.cli,a.books,a.ffmpeg);return 0
    report=compare(a.plan,a.reference,a.run,a.output)
    return int(any(b['status']!='passed' for b in report['books']))

if __name__=='__main__': raise SystemExit(main())
