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
        output.parent.mkdir(exist_ok=True)
        command=[sys.executable,str(Path(config['source'])/'script/follow-along/verify.py'),
                 '--plan',config['plan'],'--output',str(output),'--cli',config['cli'],
                 '--ffmpeg',config.get('ffmpeg','ffmpeg'),'--workers',str(config.get('workers',1))]
        if config.get('reference'): command.extend(['--reference',config['reference']])
        env=os.environ.copy()
        if config.get('node'): env['PATH']=str(Path(config['node']).parent)+os.pathsep+env['PATH']
        if config.get('cargoTarget'): env['CARGO_TARGET_DIR']=config['cargoTarget']
        save(root/'latest-scheduled.json',dict(status='running',output=str(output)))
        result=subprocess.run(command,env=env)
        save(root/'latest-scheduled.json',dict(status='passed' if result.returncode==0 else 'needs-review',
                                             output=str(output),exitCode=result.returncode))
        return result.returncode

if __name__=='__main__': raise SystemExit(main())
