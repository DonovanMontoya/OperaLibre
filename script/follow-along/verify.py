#!/usr/bin/env python3
"""Run every planned private sample and preserve failures for recurring audits."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import time

import audit
import corpus


def verify(plan, output, cli, ffmpeg='ffmpeg', reference=None, workers=2):
    books = corpus.load(plan)['books']
    if not books or len({b['id'] for b in books}) != len(books):
        raise ValueError('Plan needs nonempty unique book IDs')
    output.mkdir(parents=True, exist_ok=False)
    maps = output/'maps'; maps.mkdir()
    references = reference or output/'reference'
    if reference is None:
        references.mkdir()
    elif corpus.load(reference/'report.json')['planSha256'] != corpus.digest(plan):
        raise ValueError('Reference belongs to another plan')
    report = dict(startedAt=time.time(), planSha256=corpus.digest(plan),
                  source=corpus.source_identity(), books=[])
    corpus.save(output/'progress.json', report)

    def run(book):
        identity = book['id']
        row = dict(id=identity, title=book['title'])
        if reference is None:
            try:
                audit.reference(plan,references/identity,cli,[identity],ffmpeg)
            except Exception as error:
                row['referenceError'] = str(error)
        try:
            row['generation'] = corpus.run_plan(plan,maps/identity,cli,ffmpeg,[identity])['books'][0]
        except Exception as error:
            row['generationError'] = str(error)
        return row

    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = [pool.submit(run,book) for book in books]
        for future in as_completed(pending):
            row = future.result(); report['books'].append(row)
            corpus.save(output/'progress.json', report)
            print(f"{row['title']}: recorded",flush=True)
    if reference is None:
        merged = dict(kind='independent-ASR-reference',model='small.en',
                      planSha256=corpus.digest(plan),books=[])
        for book in books:
            path = references/book['id']/'report.json'
            if path.exists(): merged['books'].extend(corpus.load(path)['books'])
        corpus.save(references/'report.json',merged)
    try:
        result = audit.compare(plan,references,maps,output/'audit.json')
    except Exception as error:
        report.update(completedAt=time.time(),status='needs-review',auditError=str(error))
        corpus.save(output/'progress.json',report)
        return report
    # An interrupted generation cannot be rescued by a partial set of maps.
    generation_ok = all('generation' in b and b['generation']['status'] in ('passed','unverified')
                        and 'referenceError' not in b for b in report['books'])
    report.update(completedAt=time.time(),status='passed' if generation_ok and
                  all(b['status']=='passed' for b in result['books']) else 'needs-review')
    corpus.save(output/'progress.json',report)
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--cli',required=True)
    p.add_argument('--ffmpeg',default='ffmpeg')
    p.add_argument('--reference',type=Path)
    p.add_argument('--workers',type=int,choices=range(1,5),default=2)
    a=p.parse_args()
    result=verify(a.plan,a.output,a.cli,a.ffmpeg,a.reference,a.workers)
    return int(result['status']!='passed')

if __name__=='__main__': raise SystemExit(main())
