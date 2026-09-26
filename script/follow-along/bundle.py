#!/usr/bin/env python3
"""Export the exact frozen windows for another private test worker, without whole audiobooks."""
import argparse
import copy
import os
from pathlib import Path
import shutil
import subprocess

from corpus import load, save, digest, audio_fingerprint


def export(plan_path, output, ffmpeg='ffmpeg', ffprobe='ffprobe'):
    os.umask(0o077); output=output.resolve(); output.mkdir(parents=True,exist_ok=False)
    plan=copy.deepcopy(load(plan_path)); plan['parentPlanSha256']=digest(plan_path); plan['bundleRoot']=str(output)
    for book in plan['books']:
        if book['status']!='planned': raise ValueError('Cannot bundle a blocked plan')
        folder=output/book['id']; folder.mkdir()
        book['sourceAudioSha256']=digest(book['audio'])
        book['originalAudio']=book['audio']
        source=Path(book['scopeManifest']).parent
        shutil.copyfile(source/'scopes.json',folder/'scopes.json')
        metadata=load(source/'input.json')
        duration=subprocess.check_output([ffprobe,'-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',book['audio']],text=True)
        metadata['audioDurationSeconds']=float(duration); save(folder/'input.json',metadata)
        shutil.copyfile(book['epub'],folder/'book.epub')
        book['epub']=str(folder/'book.epub'); book['scopeManifest']=str(folder/'scopes.json'); clips={}
        for index in book['scopes']:
            start,end=book['audioSamples'][str(index)]; path=folder/f'{index}.flac'
            subprocess.run([ffmpeg,'-nostdin','-v','error','-ss',str(start),'-i',book['audio'],
                            '-t',str(end-start),'-ac','1','-ar','16000','-sample_fmt','s16','-c:a','flac',str(path)],check=True)
            clips[str(index)]=dict(path=str(path),start=start,end=end,sha256=digest(path))
        book['audioClips']=clips; book['audio']=next(iter(clips.values()))['path']; book['audioCandidates']=[book['audio']]
        print(book['title']+': bundled unchanged frozen windows',flush=True)
    save(output/'plan.json',plan)
    return plan


def relocate(plan_path, output):
    if output.exists(): raise ValueError('Choose a new relocated plan path')
    plan=load(plan_path); old=Path(plan['bundleRoot']); root=plan_path.resolve().parent
    def moved(path): return str(root/Path(path).relative_to(old))
    for book in plan['books']:
        for key in ['epub','audio','scopeManifest']: book[key]=moved(book[key])
        book['audioCandidates']=[book['audio']]
        for clip in book['audioClips'].values(): clip['path']=moved(clip['path'])
        audio_fingerprint(book)
        if digest(book['epub'])!=book['epubSha256']: raise ValueError('Bundled EPUB changed')
    plan['bundleRoot']=str(root); plan['transportPlanSha256']=digest(plan_path)
    save(output,plan)
    return plan


def main():
    parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('export');p.add_argument('--plan',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--ffmpeg',default='ffmpeg');p.add_argument('--ffprobe',default='ffprobe')
    p=sub.add_parser('relocate');p.add_argument('--plan',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.command=='export': export(args.plan,args.output,args.ffmpeg,args.ffprobe)
    else: relocate(args.plan,args.output)

if __name__=='__main__': main()
