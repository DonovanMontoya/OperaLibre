#!/usr/bin/env python3
"""Private scheduled library regression worker (Linux/macOS, no production API)."""
import argparse
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import subprocess
import sys

from corpus import load, save


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',type=Path,required=True)
    args=p.parse_args(); config=load(args.config)
    root=args.config.resolve().parent
    os.umask(0o077)
    with (root/'library-worker.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print('A private library check is already running.'); return 0
        output=root/'scheduled'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        suites=[dict(name='library',plan=config['plan'],reference=config.get('reference')),
                *config.get('additionalSuites',[])]
        names=[s['name'] for s in suites]
        if len(set(names)) != len(names) or any(not n or not all(c.isalnum() or c in '-_' for c in n) for n in names):
            raise ValueError('Suite names must be unique directory names')
        output.mkdir(parents=True)
        env=os.environ.copy()
        if config.get('node'): env['PATH']=str(Path(config['node']).parent)+os.pathsep+env['PATH']
        if config.get('cargoTarget'): env['CARGO_TARGET_DIR']=config['cargoTarget']
        report=dict(status='running',output=str(output),suites=[])
        save(root/'latest-scheduled.json',report)
        exit_code=0
        for suite in suites:
            destination=output/suite['name']
            command=[sys.executable,str(Path(config['source'])/'script/follow-along/verify.py'),
                     '--plan',suite['plan'],'--output',str(destination),'--cli',config['cli'],
                     '--ffmpeg',config.get('ffmpeg','ffmpeg'),'--workers',str(config.get('workers',1))]
            if suite.get('reference'): command.extend(['--reference',suite['reference']])
            result=subprocess.run(command,env=env)
            if result.returncode and not exit_code: exit_code=result.returncode
            report['suites'].append(dict(name=suite['name'],output=str(destination),exitCode=result.returncode,
                                        status='passed' if result.returncode==0 else 'needs-review'))
            save(root/'latest-scheduled.json',report)
        report.update(status='passed' if exit_code==0 else 'needs-review',exitCode=exit_code)
        save(root/'latest-scheduled.json',report)
        return exit_code

if __name__=='__main__': raise SystemExit(main())
