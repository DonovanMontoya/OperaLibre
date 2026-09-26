#!/usr/bin/env python3
"""Record or replay private recognition by exact audio, model options and runtime identity.

Forced alignment always executes. Record mode always recognizes fresh audio;
replay mode is for isolating generator changes against unchanged model output.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli',type=Path,required=True)
    parser.add_argument('--identity',type=Path,required=True,help='Pinned runtime/model identity file')
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--mode',choices=['record','replay'],default='record')
    parser.add_argument('arguments',nargs=argparse.REMAINDER)
    args=parser.parse_args(); command=args.arguments
    if command[:1]==['--']: command=command[1:]
    cacheable=len(command)>=3 and command[0]=='transcribe' and all(
        option=='--overwrite' or option.startswith(('--engine=whisper','--whisper.model=','--language='))
        for option in command[3:])
    if not cacheable: return subprocess.run([str(args.cli),*command]).returncode
    identity=dict(audio=digest(command[1]),options=command[3:],runtime=digest(args.identity),cli=digest(args.cli))
    key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    os.umask(0o077); args.cache.mkdir(parents=True,exist_ok=True)
    record=args.cache/(key+'.json'); output=Path(command[2])
    if args.mode=='replay' and record.exists():
        value=json.loads(record.read_text()); raw=value['result']
        if value['identity']!=identity or hashlib.sha256(raw.encode()).hexdigest()!=value['resultSha256']:
            raise ValueError('Cached recognition integrity check failed')
        json.loads(raw)
        output.write_text(raw)
        print(f'Replayed unchanged recognition {key}',file=sys.stderr)
        return 0
    result=subprocess.run([str(args.cli),*command])
    if result.returncode==0:
        raw=output.read_text(); json.loads(raw)
        value=dict(identity=identity,result=raw,resultSha256=hashlib.sha256(raw.encode()).hexdigest())
        with tempfile.NamedTemporaryFile(mode='w',dir=args.cache,delete=False) as stream:
            json.dump(value,stream); temporary=Path(stream.name)
        try:
            try: os.link(temporary,record)
            except FileExistsError: pass  # Preserve the first output for this exact input.
        finally: temporary.unlink()
    return result.returncode

if __name__=='__main__': raise SystemExit(main())
