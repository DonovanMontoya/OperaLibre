#!/usr/bin/env python3
"""Prepare synthetic fixtures or build the standalone simulator measurement app."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PLAYER = REPO / 'apps/web/ios/App/App/AudiobookPlayer.swift'
COMPACTOR = REPO / 'apps/server/src/compact_audio.rs'


def run(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


def compact_fixture(root, source, output, compactor, label):
    snapshot = root / f'{label}-source.rs'
    snapshot.write_bytes(compactor.read_bytes())
    wrapper = root / f'{label}.rs'
    wrapper.write_text(f'''#[path={json.dumps(str(snapshot))}] mod compact_audio;
fn main() {{
    let args: Vec<_> = std::env::args().collect();
    let mut file = std::fs::File::open(&args[1]).unwrap();
    let metadata = file.metadata().unwrap();
    let header = compact_audio::cached_header(&mut file, &metadata).expect("compact fixture");
    let mut output = std::fs::File::create(&args[2]).unwrap();
    std::io::Write::write_all(&mut output, &header.bytes).unwrap();
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(header.bytes.len() as u64 + header.removed)).unwrap();
    std::io::copy(&mut file, &mut output).unwrap();
}}
''')
    run('rustc', '-O', '--edition', '2024', wrapper, '-o', root / label)
    run(root / label, source, output)
    return hashlib.sha256(snapshot.read_bytes()).hexdigest()


def prepare(args):
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'hls').mkdir()
    if args.source:
        shutil.copyfile(args.source, root / 'flat.m4a')
        args.duration = float(run('ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                  '-of', 'default=nw=1:nk=1', root / 'flat.m4a'))
    elif args.continuous:
        run('ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
            f'anoisesrc=color=pink:sample_rate=44100:duration={args.duration}:seed=47',
            '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', root / 'flat.m4a')
    else:
        run('ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
            'anoisesrc=color=pink:sample_rate=44100:duration=30:seed=47',
            '-ac', '1', '-c:a', 'aac', '-b:a', '64k', root / 'seed.m4a')
        run('ffmpeg', '-v', 'error', '-stream_loop', str(args.duration // 30 - 1),
            '-i', root / 'seed.m4a', '-map', '0:a', '-c', 'copy', '-t', args.duration,
            '-movflags', '+faststart', root / 'flat.m4a')
    if args.embedded_cover:
        run('ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
            'color=c=black:s=1200x1200,noise=alls=100:allf=u:all_seed=47',
            '-frames:v', '1', '-q:v', '3', root / 'cover.jpg')
        run('ffmpeg', '-v', 'error', '-i', root / 'flat.m4a', '-i', root / 'cover.jpg',
            '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic',
            '-movflags', '+faststart', root / 'covered.m4a')
        (root / 'covered.m4a').replace(root / 'flat.m4a')
    hashes = [run('ffmpeg', '-v', 'error', '-i', root / 'flat.m4a', '-map', '0:a', '-c', 'copy',
                  '-f', 'hash', '-hash', 'sha256', '-')]
    if args.transport == 'bootstrap':
        run('ffmpeg', '-v', 'error', '-i', root / 'flat.m4a', '-map', '0:a', '-c', 'copy',
            '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
            '-hls_segment_type', 'fmp4', root / 'hls/book.m3u8')
        if hashes[0] != run('ffmpeg', '-v', 'error', '-i', root / 'hls/book.m3u8', '-map', '0:a',
                            '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'):
            raise RuntimeError('Encoded audio payloads differ')
    else:
        # The HTTP fixture shares its router with HLS tests; no fragments are
        # needed when testing ordinary MP4 transports.
        (root / 'hls/book.m3u8').write_text(f'#EXTM3U\n#EXTINF:{args.duration},\nbook0.m4s\n')
    decoded_hash = None
    compactor_hash = None
    baseline_hash = None
    if args.transport in ['compact', 'packet']:
        if args.transport == 'packet':
            packet_source = REPO / 'apps/server/src/packet_audio.rs'
            wrapper = root / 'packet.rs'
            wrapper.write_text(f'''#[path={json.dumps(str(packet_source))}] mod packet_audio;
fn main() {{
    let args: Vec<_> = std::env::args().collect();
    let mut file = std::fs::File::open(&args[1]).unwrap();
    let plan = packet_audio::PacketAudio::open(&mut file).expect("packet fixture");
    let mut output = std::fs::File::create(&args[2]).unwrap();
    let mut offset = 0;
    while offset < plan.length {{
        let n = 65536.min((plan.length - offset) as usize);
        std::io::Write::write_all(&mut output, &plan.read(&mut file, offset, n).unwrap()).unwrap();
        offset += n as u64;
    }}
}}
''')
            run('rustc', '-O', '--edition', '2024', wrapper, '-o', root / 'packet')
            run(root / 'packet', root / 'flat.m4a', root / 'compact.m4a')
            compactor_hash = hashlib.sha256(packet_source.read_bytes()).hexdigest()
        else:
            compactor_hash = compact_fixture(root, root / 'flat.m4a', root / 'compact.m4a', COMPACTOR, 'compact')
        decoded = [run('ffmpeg', '-v', 'error', '-i', file, '-map', '0:a',
                       '-f', 'hash', '-hash', 'sha256', '-')
                   for file in [root / 'flat.m4a', root / 'compact.m4a']]
        if decoded[0] != decoded[1]:
            raise RuntimeError('Decoded compact audio differs')
        decoded_hash = decoded[0]
        if args.baseline_compactor:
            baseline_hash = compact_fixture(root, root / 'flat.m4a', root / 'baseline.m4a', args.baseline_compactor.resolve(), 'baseline')
            baseline_decoded = run('ffmpeg', '-v', 'error', '-i', root / 'baseline.m4a',
                                   '-map', '0:a', '-f', 'hash', '-hash', 'sha256', '-')
            if baseline_decoded != decoded_hash:
                raise RuntimeError('Decoded baseline audio differs')
            (root / 'flat.m4a').rename(root / 'source.m4a')
            (root / 'baseline.m4a').rename(root / 'flat.m4a')
    config = dict(pairs=args.pairs, positions=[0, args.duration // 2], speeds=[40, 4],
                  latencyMs=40, duration=args.duration, encodedAudioHash=hashes[0],
                  candidate=args.transport, rate=args.rate, gain=args.gain,
                  baseline='previous compact index' if args.baseline_compactor else 'original faststart',
                  baselineCompactorSHA256=baseline_hash, compactorSHA256=compactor_hash,
                  embeddedCoverBytes=(root / 'cover.jpg').stat().st_size if args.embedded_cover else 0,
                  decodedAudioHash=decoded_hash,
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
                BenchmarkCandidate=config.get('candidate', 'bootstrap'),
                BenchmarkBaseline=config.get('baseline', 'original faststart'),
                BenchmarkSpeeds=config['speeds'], BenchmarkRate=config.get('rate', 1),
                BenchmarkGain=config.get('gain', 1),
                BenchmarkMidpoint=float(config['positions'][1]))
    (app / 'Info.plist').write_bytes(plistlib.dumps(info))
    if (root / 'cover.jpg').exists():
        shutil.copyfile(root / 'cover.jpg', app / 'cover.jpg')
    run('xcrun', 'swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-ios17.0-simulator',
        '-sdk', run('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'),
        HERE / 'main.swift', HERE / 'Bootstrap.swift', PLAYER, PLAYER.with_name('PacketAudioAsset.swift'), '-o', app / 'StreamingBench')
    run('codesign', '--force', '--sign', '-', app)
    (root / 'build.json').write_text(json.dumps(dict(
        playerSHA256=hashlib.sha256(PLAYER.read_bytes()).hexdigest(),
        packetClientSHA256=hashlib.sha256(PLAYER.with_name('PacketAudioAsset.swift').read_bytes()).hexdigest(),
        packetServerSHA256=hashlib.sha256((REPO / 'apps/server/src/packet_audio.rs').read_bytes()).hexdigest(),
        compactorSHA256=hashlib.sha256(COMPACTOR.read_bytes()).hexdigest(),
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
    parser.add_argument('--embedded-cover', action='store_true')
    parser.add_argument('--baseline-compactor', type=Path)
    parser.add_argument('--rate', type=float, default=1)
    parser.add_argument('--gain', type=float, default=1)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--continuous', action='store_true')
    parser.add_argument('--transport', choices=['bootstrap', 'compact', 'packet'], default='bootstrap')
    args = parser.parse_args()
    if not 0.75 <= args.rate <= 2 or not 1 <= args.gain <= 4:
        parser.error('rate must be 0.75..2; gain must be 1..4')
    if args.duration < 120 or args.duration % 30 or not 1 <= args.pairs <= 20:
        parser.error('duration must be a multiple of 30 >=120; pairs must be 1..20')
    if args.baseline_compactor and args.transport != 'compact':
        parser.error('--baseline-compactor requires --transport compact')
    (prepare if args.action == 'prepare' else build)(args)
