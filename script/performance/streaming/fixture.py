#!/usr/bin/env python3
"""Prepare synthetic fixtures or build the standalone simulator measurement app."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PLAYER = REPO / 'apps/web/ios/App/App/AudiobookPlayer.swift'


def run(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


def prepare(args):
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'hls').mkdir()
    run('ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
        'anoisesrc=color=pink:sample_rate=44100:duration=30:seed=47',
        '-ac', '1', '-c:a', 'aac', '-b:a', '64k', root / 'seed.m4a')
    run('ffmpeg', '-v', 'error', '-stream_loop', str(args.duration // 30 - 1),
        '-i', root / 'seed.m4a', '-map', '0:a', '-c', 'copy', '-t', args.duration,
        '-movflags', '+faststart', root / 'flat.m4a')
    run('ffmpeg', '-v', 'error', '-i', root / 'flat.m4a', '-map', '0:a', '-c', 'copy',
        '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
        '-hls_segment_type', 'fmp4', root / 'hls/book.m3u8')
    hashes = [run('ffmpeg', '-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy',
                  '-f', 'hash', '-hash', 'sha256', '-')
              for file in [root / 'flat.m4a', root / 'hls/book.m3u8']]
    if hashes[0] != hashes[1]:
        raise RuntimeError('Encoded audio payloads differ')
    config = dict(pairs=args.pairs, positions=[0, args.duration // 2], speeds=[40, 4],
                  latencyMs=40, duration=args.duration, encodedAudioHash=hashes[0],
                  ffmpeg=run('ffmpeg', '-version').splitlines()[0])
    (root / 'fixture.json').write_text(json.dumps(config, indent=2) + '\n')
    print(root)


def build(args):
    root = args.output.resolve()
    config = json.loads((root / 'fixture.json').read_text())
    base = json.loads((root / 'server.json').read_text())['base']
    app = root / 'StreamingBench.app'
    app.mkdir(exist_ok=False)
    info = dict(CFBundleIdentifier='com.operalibre.streamingbench', CFBundleName='StreamingBench',
                CFBundleExecutable='StreamingBench', CFBundlePackageType='APPL',
                CFBundleVersion='1', CFBundleShortVersionString='1.0', MinimumOSVersion='17.0',
                UIDeviceFamily=[1, 2], UILaunchScreen={}, UIBackgroundModes=['audio'],
                NSAppTransportSecurity={'NSAllowsArbitraryLoads': True},
                UIApplicationSceneManifest={'UIApplicationSupportsMultipleScenes': False},
                BenchmarkBase=base, BenchmarkPairs=config['pairs'],
                BenchmarkMidpoint=float(config['positions'][1]))
    (app / 'Info.plist').write_bytes(plistlib.dumps(info))
    run('xcrun', 'swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-ios17.0-simulator',
        '-sdk', run('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'),
        HERE / 'main.swift', HERE / 'Bootstrap.swift', PLAYER, '-o', app / 'StreamingBench')
    run('codesign', '--force', '--sign', '-', app)
    (root / 'build.json').write_text(json.dumps(dict(
        playerSHA256=hashlib.sha256(PLAYER.read_bytes()).hexdigest(),
        commit=run('git', '-C', REPO, 'rev-parse', 'HEAD'),
        xcode=run('xcodebuild', '-version'),
        harnessSHA256={file: hashlib.sha256((HERE / file).read_bytes()).hexdigest()
                       for file in ['main.swift', 'Bootstrap.swift', 'server.mjs', 'fixture.py']}), indent=2) + '\n')
    print(app)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'build'])
    parser.add_argument('output', type=Path)
    parser.add_argument('--duration', type=int, default=7200)
    parser.add_argument('--pairs', type=int, default=5)
    args = parser.parse_args()
    if args.duration < 120 or args.duration % 30 or not 1 <= args.pairs <= 20:
        parser.error('duration must be a multiple of 30 >=120; pairs must be 1..20')
    (prepare if args.action == 'prepare' else build)(args)
