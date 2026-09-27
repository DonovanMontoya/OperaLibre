#!/usr/bin/env python3
"""Private scheduled library regression worker (Linux/macOS, no production API)."""
import argparse
from datetime import datetime, timezone
import fcntl
import io
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

from corpus import load, save


def refresh_source(config, root, env):
    """Archive a trusted merged revision; preserve the bootstrap until it lands."""
    tracking=config.get('sourceTracking')
    if not tracking: return config, dict(mode='pinned',source=config['source'])
    minimum=tracking['minimumRevision']; ref=tracking.get('ref','main')
    if not re.fullmatch(r'[0-9a-f]{40}',minimum) or ref.startswith('-'):
        raise ValueError('Tracking requires a full minimum revision and a branch name')
    cache=root/'source-cache.git'
    if not cache.exists(): subprocess.run(['git','init','--bare',str(cache)],check=True,env=env)
    git=['git','--git-dir='+str(cache)]
    subprocess.run([*git,'fetch','--no-tags','--',tracking['repository'],ref],check=True,env=env)
    revision=subprocess.check_output([*git,'rev-parse','FETCH_HEAD'],text=True,env=env).strip()
    known=subprocess.run([*git,'cat-file','-e',minimum+'^{commit}'],capture_output=True,env=env)
    if known.returncode:
        if known.returncode != 128: raise RuntimeError('Cannot inspect minimum tracked revision')
        return config,dict(mode='awaiting-merge',revision=revision,minimumRevision=minimum)
    ancestry=subprocess.run([*git,'merge-base','--is-ancestor',minimum,revision],env=env)
    if ancestry.returncode == 1:
        return config,dict(mode='awaiting-merge',revision=revision,minimumRevision=minimum)
    if ancestry.returncode: raise RuntimeError('Cannot establish tracked source ancestry')
    source=root/'sources'/revision
    if not source.exists():
        source.parent.mkdir(exist_ok=True)
        data=subprocess.check_output([*git,'archive',revision],env=env)
        with tempfile.TemporaryDirectory(dir=source.parent) as directory:
            staging=Path(directory)/'source';staging.mkdir()
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                archive.extractall(staging,filter='data')
            staging.rename(source)
    runtime=source/'addons/readalong-sync'
    ready=runtime/'.private-runtime-ready'
    if not ready.exists():
        subprocess.run(['npm','ci','--prefix',str(runtime)],check=True,env=env)
        subprocess.run(['npm','test','--prefix',str(runtime)],check=True,env=env)
        ready.write_text(revision+'\n')
    return dict(config,source=str(source),cli=str(runtime/'node_modules/.bin/echogarden')),dict(mode='tracked',revision=revision,ref=ref)


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
        try:
            config,report['sourceSelection']=refresh_source(config,root,env)
        except Exception as error:
            report.update(status='needs-review',exitCode=1,sourceError=str(error))
            save(root/'latest-scheduled.json',report)
            return 1
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
