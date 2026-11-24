// On-device speech recognition for follow-along sync, using NVIDIA Parakeet
// models through sherpa-onnx. The server runs `plan` once per book to learn
// which models suit this machine, then keeps one `serve` process per model
// and sends it each recognition window, so the model is loaded once for the
// book. `transcribe` does one file by hand. Both write the word timeline
// shape Echogarden writes, so the server reads either recognizer the same
// way. Echogarden still does forced alignment, language detection, and
// recognition in other languages.
//
//   node recognize.mjs plan <output.json> [--language=en] [--gpu]
//   node recognize.mjs serve --model=<id> [--idle=<seconds>]
//   node recognize.mjs transcribe <audio> <output.json> --model=<id>
//   node recognize.mjs fetch <id> <directory>
//   node recognize.mjs probe <id> [--provider=cuda]
//   node recognize.mjs check
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const GIB = 1024 ** 3;

export const FAST = 'parakeet-tdt-110m';
export const ACCURATE = 'parakeet-tdt-0.6b-v2';
// The larger model again, with the unquantized weights a graphics card needs.
export const ACCURATE_GPU = 'parakeet-tdt-0.6b-v2-gpu';

// The larger model stamps each word one 80 ms encoder frame before the small
// model does. Measured against the ends of pauses in narration, its words began
// a median 60 to 80 ms early and the small model's within 60 ms, with the
// quantized and the unquantized weights alike. Its times are moved one frame later.
const ACCURATE_CLOCK_OFFSET = 0.08;

// The models are NVIDIA releases under CC-BY-4.0, converted to ONNX (and,
// for the processor, quantized) by the sherpa-onnx project, which publishes
// these files. Each file is pinned by size and SHA-256.
export const MODELS = {
  // 137 MB. Ships inside the packaged add-on; only its archive is published.
  [FAST]: {
    languages: ['en'],
    archive: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2',
    archiveRoot: 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8',
    files: {
      'encoder.int8.onnx': { size: 131113202, sha256: '0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657' },
      'decoder.int8.onnx': { size: 3955863, sha256: 'f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19' },
      'joiner.int8.onnx': { size: 1411403, sha256: 'bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6' },
      'tokens.txt': { size: 9953, sha256: '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10' }
    }
  },
  // 661 MB. Downloaded the first time a machine with room for it syncs a book.
  [ACCURATE]: {
    languages: ['en'],
    clockOffset: ACCURATE_CLOCK_OFFSET,
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/84b478d541cdbf0c296a7ab5f1e20a6f8f998114/',
    files: {
      'encoder.int8.onnx': { size: 652282309, sha256: '92a10bd9c23936ea0566c29f963bc57c2a5df4261b6a8921c39abea66557ca8b' },
      'decoder.int8.onnx': { size: 7257753, sha256: '4d097bae3bac5c96018d5293ba39f1b657296102b142affda40378f38b020f41' },
      'joiner.int8.onnx': { size: 1739080, sha256: '77a29f3e5ac7d37074e0af465391b80f314015d5b97f0f90c6c7767f1d56f428' },
      'tokens.txt': { size: 9384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' }
    }
  },
  // 2.5 GB. Downloaded when the owner turns on GPU recognition and the card
  // can run it. Quantized weights run slower on a card than on the processor,
  // and the half-precision files overflow on CUDA, so these are full precision.
  [ACCURATE_GPU]: {
    languages: ['en'],
    clockOffset: ACCURATE_CLOCK_OFFSET,
    provider: 'cuda',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2/resolve/4d6040312214e0d95a267604214e60aac73c4f08/',
    files: {
      'encoder.onnx': { size: 41838346, sha256: '266d8e8177013abc20a65d5011a59a850e76bfaa876b33f8beb89ae73f81bb76' },
      'encoder.weights': { size: 2435420160, sha256: '90cd4bb6c9b60496d49be9bec3a844f4e9bf22c62a45ea93f391cc00f9a47cfe' },
      'decoder.onnx': { size: 28883664, sha256: '612105ff91f4854f981714e3a8dce1a9a3f99ee6aa96b9966dbbdac3cc09dd04' },
      'joiner.onnx': { size: 6907577, sha256: 'fc1f63b222b7a7327c378ed272206dc9c74cf34e64a9b0b9fbed4160f20e3c6c' },
      'tokens.txt': { size: 9384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' }
    }
  }
};

// The CUDA build of the speech runtime, published by the sherpa-onnx project
// for Linux x64. It replaces the libraries beside the npm package's addon, so
// its version must be the `sherpa-onnx-node` version in package.json. It uses
// the CUDA 12 and cuDNN 9 libraries the owner has installed; it brings none.
export const GPU_RUNTIME = {
  version: '2.0.1',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-linux-x64-gpu.tar.bz2',
  root: 'sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-linux-x64-gpu',
  size: 393636488,
  sha256: '2aa541a65c1e7d921a053283419b70b30c1f6ae0a0f52f64b947ebe88c5f2a77'
};

// The larger model holds about 1.5 GB while it runs. Machines with less
// memory than this keep the small model only.
export const ACCURATE_MIN_MEMORY = 6 * GIB;
// The larger model runs about a third as fast as the small one. A machine
// that runs the small model at least this many times faster than real time
// can lead with the larger one and still finish a window in seconds.
export const ACCURATE_FIRST_SPEED = 90;

/// Which models a book in `language` should use on a machine with this much
/// memory and this measured speed. `model: null` means none applies and the
/// server keeps its own recognizer. A graphics card that passed its trial run
/// leads with the larger model whatever the processor's speed.
export function choosePlan({ language, memoryBytes, speed, accurateAvailable, gpuAvailable = false }) {
  if (!MODELS[FAST].languages.includes(language)) return { model: null, retryModel: null };
  if (gpuAvailable) return { model: ACCURATE_GPU, retryModel: FAST };
  if (!accurateAvailable || memoryBytes < ACCURATE_MIN_MEMORY) return { model: FAST, retryModel: null };
  return speed >= ACCURATE_FIRST_SPEED
    ? { model: ACCURATE, retryModel: FAST }
    : { model: FAST, retryModel: ACCURATE };
}

/// One core stays free for playback. The encoder gains nothing past four
/// threads. Shorter pieces of audio need less memory at the same speed.
export function runtimeSettings({ cores, memoryBytes }) {
  return {
    threads: Math.max(1, Math.min(4, cores - 1)),
    chunkSeconds: memoryBytes < 3 * GIB ? 15 : 30
  };
}

export function machine() {
  const total = os.totalmem();
  // A container's memory limit, where there is one, is the real ceiling.
  const limit = process.constrainedMemory?.() ?? 0;
  return {
    cores: os.availableParallelism(),
    memoryBytes: limit > 0 && limit < total ? limit : total
  };
}

/// Where downloaded models and the speed measurement are kept. It is outside
/// the add-on folder so an add-on update keeps them and does not copy them
/// into its backup.
export function cacheDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.OPERALIBRE_READALONG_MODELS) return env.OPERALIBRE_READALONG_MODELS;
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'OperaLibre', 'readalong-models');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'OperaLibre', 'readalong-models');
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'operalibre', 'readalong-models');
}

async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

async function isInstalled(id, directory) {
  for (const [name, { size }] of Object.entries(MODELS[id].files)) {
    if ((await sizeOf(path.join(directory, name))) !== size) return false;
  }
  return true;
}

/// The folder holding a complete copy of the model, or null. Files were
/// checked against their SHA-256 when they were fetched; here their sizes are.
export async function findModel(id, roots = [path.join(here, 'models'), cacheDir()]) {
  for (const root of roots) {
    const directory = path.join(root, id);
    if (await isInstalled(id, directory)) return directory;
  }
  return null;
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  const handle = await open(file);
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function verified(file, { size, sha256 }, what) {
  const actual = await sizeOf(file);
  if (actual !== size) throw new Error(`${what} is ${actual} bytes; expected ${size}.`);
  const digest = await sha256Of(file);
  if (digest !== sha256) throw new Error(`${what} does not match its pinned SHA-256.`);
}

/// Streams `url` to `destination` and keeps it only if it has the pinned size
/// and SHA-256, so an interrupted or altered download is never used.
export async function download(url, destination, expected) {
  const partial = `${destination}.part`;
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}.`);
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          hash.update(chunk);
          done(size > expected.size ? new Error(`${url} is larger than the pinned ${expected.size} bytes.`) : null, chunk);
        }
      }),
      createWriteStream(partial)
    );
    if (size !== expected.size) throw new Error(`${url} is ${size} bytes; expected ${expected.size}.`);
    if (hash.digest('hex') !== expected.sha256) throw new Error(`${url} does not match its pinned SHA-256.`);
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

function unpack(scratch, archive, what) {
  const unpacked = spawnSync('tar', ['-xjf', archive], { cwd: scratch, stdio: 'pipe' });
  if (unpacked.status !== 0) throw new Error(`Could not unpack ${what}: ${unpacked.error?.message ?? unpacked.stderr}`);
}

/// Fetches a model into `<root>/<id>` and returns that folder.
export async function fetchModel(id, root) {
  const model = MODELS[id];
  if (!model) throw new Error(`Unknown speech model: ${id}`);
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  if (model.base) {
    for (const [name, expected] of Object.entries(model.files)) {
      if ((await sizeOf(path.join(directory, name))) === expected.size) continue;
      await download(new URL(name, model.base).href, path.join(directory, name), expected);
    }
    return directory;
  }
  // An archive is unpacked by the system `tar`. This path serves packaging
  // and development checkouts; installed add-ons already contain the files.
  const scratch = await mkdtemp(path.join(root, '.fetch-'));
  try {
    const archive = path.join(scratch, 'model.tar.bz2');
    const response = await fetch(model.archive, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`${model.archive} answered ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    unpack(scratch, 'model.tar.bz2', model.archive);
    for (const [name, expected] of Object.entries(model.files)) {
      const source = path.join(scratch, model.archiveRoot, name);
      await verified(source, expected, `${id}/${name}`);
      await rename(source, path.join(directory, name));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return directory;
}

/// The folder of a model, downloaded to the cache first where it is missing.
/// `downloaded` is told the folder when that happened.
async function ensureModel(id, downloaded) {
  const found = await findModel(id);
  if (found) return found;
  const directory = await fetchModel(id, cacheDir());
  downloaded?.(directory);
  return directory;
}

/// Whether this machine could run the CUDA runtime at all: Linux x64 with
/// NVIDIA's driver loaded. Whether it does is settled by a trial run.
export function gpuSupported(platform = process.platform, arch = process.arch, driver = '/proc/driver/nvidia/version') {
  return platform === 'linux' && arch === 'x64' && existsSync(driver);
}

function gpuRuntimeDir() {
  return path.join(cacheDir(), `sherpa-onnx-cuda-${GPU_RUNTIME.version}`);
}

/// Downloads the CUDA runtime and lays it out as the npm packages are, with
/// the npm package's own addon beside the CUDA libraries, so it loads the way
/// the bundled runtime does. The marker file is written last.
async function installGpuRuntime() {
  const directory = gpuRuntimeDir();
  const marker = path.join(directory, 'installed.json');
  if (existsSync(marker)) return false;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const scratch = await mkdtemp(path.join(directory, '.fetch-'));
  try {
    await download(GPU_RUNTIME.url, path.join(scratch, 'runtime.tar.bz2'), GPU_RUNTIME);
    unpack(scratch, 'runtime.tar.bz2', 'the GPU speech runtime');
    const packages = path.join(directory, 'node_modules');
    const wrapper = path.dirname(require.resolve('sherpa-onnx-node/package.json'));
    const native = path.join(packages, 'sherpa-onnx-linux-x64');
    await cp(wrapper, path.join(packages, 'sherpa-onnx-node'), { recursive: true });
    await mkdir(native, { recursive: true });
    await copyFile(path.join(wrapper, '..', 'sherpa-onnx-linux-x64', 'sherpa-onnx.node'), path.join(native, 'sherpa-onnx.node'));
    const libraries = path.join(scratch, GPU_RUNTIME.root, 'lib');
    for (const name of await readdir(libraries)) {
      if (name.endsWith('.so')) await rename(path.join(libraries, name), path.join(native, name));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await writeFile(marker, `${JSON.stringify({ version: GPU_RUNTIME.version })}\n`);
  return true;
}

function loadSherpa(provider = 'cpu') {
  const sherpa =
    provider === 'cuda'
      ? createRequire(path.join(gpuRuntimeDir(), 'node_modules', 'index.js'))('sherpa-onnx-node')
      : require('sherpa-onnx-node');
  if (typeof sherpa?.OfflineRecognizer !== 'function') throw new Error('The speech runtime did not load.');
  return sherpa;
}

function createRecognizer(sherpa, id, directory, threads, provider = MODELS[id].provider ?? 'cpu') {
  const file = (part) => path.join(directory, Object.keys(MODELS[id].files).find((name) => name.startsWith(part) && name.endsWith('.onnx')));
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: file('encoder'), decoder: file('decoder'), joiner: file('joiner') },
      tokens: path.join(directory, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: threads,
      provider,
      debug: 0
    }
  });
}

/// Groups the model's word pieces into words. A piece that opens a word
/// starts with a space. A word ends where its last spoken piece does, so
/// trailing punctuation does not stretch it.
export function wordsFromTokens(tokens, timestamps, durations = []) {
  const words = [];
  let word = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace('▁', ' ');
    const start = timestamps[index] ?? word?.endTime ?? 0;
    const end = durations[index] > 0 ? start + durations[index] : (timestamps[index + 1] ?? start + 0.08);
    if (!word || token.startsWith(' ')) {
      word = { text: token.trim(), startTime: start, endTime: end };
      words.push(word);
    } else {
      word.text += token;
      if (/[\p{L}\p{N}]/u.test(token)) word.endTime = end;
    }
  }
  return words.filter((entry) => entry.text !== '');
}

/// Cuts `samples` into pieces of about `chunkSeconds`, moving each cut to the
/// quietest moment within two seconds so it falls between words where it can.
/// Returns the sample index of every boundary, from 0 to the end.
export function chunkBounds(samples, sampleRate, chunkSeconds) {
  const count = Math.max(1, Math.ceil(samples.length / (chunkSeconds * sampleRate)));
  const piece = samples.length / count;
  const frame = Math.max(1, Math.round(0.1 * sampleRate));
  const hop = Math.max(1, Math.round(0.02 * sampleRate));
  const reach = 2 * sampleRate;
  const bounds = [0];
  for (let index = 1; index < count; index += 1) {
    const nominal = Math.round(piece * index);
    const from = Math.max(bounds[index - 1] + frame, nominal - reach);
    const to = Math.min(samples.length - frame, nominal + reach);
    const centre = nominal - Math.floor(frame / 2);
    let best = centre;
    let quietest = Infinity;
    for (let at = from; at <= to; at += hop) {
      let energy = 0;
      for (let k = at; k < at + frame; k += 1) energy += samples[k] * samples[k];
      // Among equally quiet moments, the one nearest the even cut.
      if (energy < quietest || (energy === quietest && Math.abs(at - centre) < Math.abs(best - centre))) {
        quietest = energy;
        best = at;
      }
    }
    bounds.push(best + Math.floor(frame / 2));
  }
  bounds.push(samples.length);
  return bounds;
}

// Audio heard on each side of a piece, so its first and last words have context.
const CONTEXT_SECONDS = 1.5;
// The speech runtime aborts the whole process on audio shorter than half of
// one 10 ms frame. Nothing this short holds a word, so it is not decoded.
const MIN_PIECE_SECONDS = 0.1;

/// Recognizes `samples` piece by piece and returns one segment per piece, each
/// holding its words with times from the start of the audio. `clockOffset`
/// is added to every time, for a model whose clock runs early.
export function recognize(recognizer, samples, sampleRate, chunkSeconds, clockOffset = 0) {
  const bounds = chunkBounds(samples, sampleRate, chunkSeconds);
  const context = Math.round(CONTEXT_SECONDS * sampleRate);
  const segments = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const [coreStart, coreEnd] = [bounds[index], bounds[index + 1]];
    const from = Math.max(0, coreStart - context);
    const to = Math.min(samples.length, coreEnd + context);
    if (to - from < MIN_PIECE_SECONDS * sampleRate) continue;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: samples.subarray(from, to) });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const offset = from / sampleRate + clockOffset;
    const last = index + 2 === bounds.length;
    // A word heard in two overlapping pieces belongs to the one its middle is in.
    const words = wordsFromTokens(result.tokens ?? [], result.timestamps ?? [], result.durations ?? [])
      .map((word) => ({ ...word, startTime: word.startTime + offset, endTime: word.endTime + offset }))
      .filter((word) => {
        const middle = ((word.startTime + word.endTime) / 2) * sampleRate;
        return (middle >= coreStart || index === 0) && (middle < coreEnd || last);
      });
    if (words.length > 0) segments.push(words);
  }
  return segments;
}

const rounded = (seconds) => Math.round(seconds * 1000) / 1000;

export function timelineFrom(segments) {
  return segments.map((words) => ({
    type: 'segment',
    text: words.map((word) => word.text).join(' '),
    startTime: rounded(words[0].startTime),
    endTime: rounded(words.at(-1).endTime),
    timeline: words.map((word) => ({
      type: 'word',
      text: word.text,
      startTime: rounded(word.startTime),
      endTime: rounded(word.endTime)
    }))
  }));
}

async function isMonoPcmWave(file) {
  const handle = await open(file);
  try {
    const header = Buffer.alloc(36);
    await handle.read(header, 0, 36, 0);
    return (
      header.toString('latin1', 0, 4) === 'RIFF' &&
      header.toString('latin1', 8, 16) === 'WAVEfmt ' &&
      header.readUInt16LE(20) === 1 &&
      header.readUInt16LE(22) === 1 &&
      header.readUInt16LE(34) === 16
    );
  } finally {
    await handle.close();
  }
}

/// The server sends 16 kHz mono WAV. Anything else is converted first with
/// the add-on's own ffmpeg.
async function readAudio(sherpa, file) {
  if (await isMonoPcmWave(file)) return sherpa.readWave(file);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'operalibre-recognize-'));
  try {
    const converted = path.join(scratch, 'audio.wav');
    const ffmpeg = spawnSync(
      require('ffmpeg-static'),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', converted],
      { stdio: 'pipe' }
    );
    if (ffmpeg.status !== 0) throw new Error(`Could not read ${file}: ${ffmpeg.error?.message ?? ffmpeg.stderr}`);
    return sherpa.readWave(converted, false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/// How many times faster than real time this machine runs the small model on
/// a piece of the usual length. The encoder dominates and costs the same for
/// any audio, so quiet noise stands in for speech. A short first run loads
/// the model; the better of two timed runs ignores a busy moment.
export function measureSpeed(recognizer) {
  const sampleRate = 16000;
  const seconds = 30;
  const samples = new Float32Array(sampleRate * seconds);
  let seed = 1;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    samples[index] = (seed / 0x7fffffff - 0.5) * 0.02;
  }
  const decode = (audio) => {
    const started = performance.now();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: audio });
    recognizer.decode(stream);
    return performance.now() - started;
  };
  decode(samples.subarray(0, sampleRate));
  return seconds / (Math.min(decode(samples), decode(samples)) / 1000);
}

/// The speed is measured once per machine and speech runtime and then kept:
/// a book resumed after a restart must get the plan it started with. Without
/// somewhere to keep it, the machine is treated as an ordinary one.
async function knownSpeed(sherpa, directory, settings) {
  const version = require('sherpa-onnx-node/package.json').version;
  const key = [version, os.cpus()[0]?.model ?? '', machine().cores, settings.threads].join('|');
  const file = path.join(cacheDir(), 'calibration.json');
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.key === key && Number.isFinite(saved.speed)) return saved.speed;
  } catch {
    // Not measured yet.
  }
  const speed = measureSpeed(createRecognizer(sherpa, FAST, directory, settings.threads));
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ key, speed })}\n`);
  } catch {
    return 0;
  }
  return speed;
}

const firstLine = (error) => String(error?.message ?? error).split('\n')[0];

/// Why a trial run failed, or null when it passed. The CUDA runtime answers
/// a missing or failing library by quietly using the processor and saying so
/// on stderr, so that message is a failure too.
export function trialFailure({ status, error, stderr = '' }) {
  const text = String(stderr).replace(/\u001b\[[0-9;]*m/g, '');
  if (status === 0 && !error && !/fallback to cpu/i.test(text)) return null;
  const missing = text.match(/with error: (.+?: cannot open shared object file)/);
  if (missing) return `${missing[1]}. NVIDIA's CUDA 12 and cuDNN 9 libraries must be installed where the server can load them.`;
  const cudnn = text.match(/CUDNN failure \d+: (\w+)/);
  if (cudnn) {
    const old = cudnn[1] === 'CUDNN_STATUS_EXECUTION_FAILED_CUDART' ? ' Cards older than the RTX 20 series need cuDNN 9.10 or older.' : '';
    return `cuDNN failed with ${cudnn[1]}.${old}`;
  }
  const last = text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
  return (last ?? error?.message ?? `the trial run ended with status ${status}`).slice(0, 300);
}

/// Loads a model in a process of its own and runs it on a piece of the usual
/// length, so a card that cannot hold the model fails here and not mid-book.
function trial(id, provider) {
  return trialFailure(
    spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), 'probe', id, ...(provider ? [`--provider=${provider}`] : [])],
      { encoding: 'utf8', timeout: 10 * 60 * 1000 }
    )
  );
}

/// Gets GPU recognition ready and proves it works. Returns why it cannot be
/// used, or null when the card is ready.
async function prepareGpu(notes) {
  if (!gpuSupported()) return 'it needs an NVIDIA card and its driver on 64-bit Linux.';
  if (await installGpuRuntime()) notes.push(`Downloaded the GPU speech runtime to ${gpuRuntimeDir()}.`);
  // The small model is already here, so a missing CUDA library is found
  // before the 2.5 GB model is downloaded.
  const libraries = trial(FAST, 'cuda');
  if (libraries) return libraries;
  await ensureModel(ACCURATE_GPU, (directory) => notes.push(`Downloaded the GPU speech model to ${directory}.`));
  return trial(ACCURATE_GPU);
}

async function plan(language, gpu) {
  if (!MODELS[FAST].languages.includes(language)) return { model: null, retryModel: null };
  const hardware = machine();
  const settings = runtimeSettings(hardware);
  let speed;
  try {
    speed = await knownSpeed(loadSherpa(), await ensureModel(FAST), settings);
  } catch (error) {
    return {
      model: null,
      retryModel: null,
      note: `The add-on's Parakeet recognizer cannot run on this server, so this book uses whisper: ${firstLine(error)}`
    };
  }
  const roomy = hardware.memoryBytes >= ACCURATE_MIN_MEMORY;
  const notes = [];
  let gpuAvailable = false;
  if (gpu) {
    let reason;
    try {
      reason = roomy ? await prepareGpu(notes) : `the server has less than ${ACCURATE_MIN_MEMORY / GIB} GB of memory.`;
    } catch (error) {
      reason = firstLine(error);
    }
    gpuAvailable = !reason;
    if (reason) notes.push(`GPU recognition is turned on but cannot be used, so this book uses the processor: ${reason}`);
  }
  let accurateAvailable = false;
  if (roomy && !gpuAvailable) {
    try {
      await ensureModel(ACCURATE, (directory) => notes.push(`Downloaded the larger English speech model to ${directory}.`));
      accurateAvailable = true;
    } catch (error) {
      notes.push(`The larger speech model could not be downloaded: ${firstLine(error)}`);
    }
  }
  return {
    ...choosePlan({ language, memoryBytes: hardware.memoryBytes, speed, accurateAvailable, gpuAvailable }),
    ...(notes.length > 0 ? { note: notes.join('\n') } : {}),
    speed: Math.round(speed),
    ...settings
  };
}

/// Loads a model and returns the function that recognizes one audio file
/// with it and writes the timeline.
async function openModel(id) {
  if (!MODELS[id]) throw new Error(`Unknown speech model: ${id}`);
  if (MODELS[id].provider === 'cuda') await installGpuRuntime();
  const sherpa = loadSherpa(MODELS[id].provider);
  const settings = runtimeSettings(machine());
  const recognizer = createRecognizer(sherpa, id, await ensureModel(id), settings.threads);
  return async (audio, output) => {
    const wave = await readAudio(sherpa, audio);
    const segments = recognize(recognizer, wave.samples, wave.sampleRate, settings.chunkSeconds, MODELS[id].clockOffset);
    await writeFile(output, JSON.stringify(timelineFrom(segments)));
  };
}

async function transcribe(audio, output, id) {
  await (await openModel(id))(audio, output);
}

// The speech runtime prints to stdout as well, so a reply is a line of its
// own that starts with this.
export const REPLY = '@operalibre-recognizer ';
// A recognizer with no work leaves after this long, so a model does not stay
// in memory, or on the graphics card, when the book has stopped needing it.
// A slow server can take a minute between windows. The server asks for a
// shorter wait for a model it uses only for retries.
const SERVE_IDLE_MS = 3 * 60_000;

/// Answers one request per line of `input`: `{"audio": ..., "output": ...}`
/// is handed to `work`, and the reply says whether the timeline was written.
/// A request that fails is answered and the next one is still served. Ends
/// when the input closes, or calls `leave` after `idleMs` without a request.
export async function serveRequests(input, output, work, { idleMs = SERVE_IDLE_MS, leave = () => process.exit(0) } = {}) {
  let idle = setTimeout(leave, idleMs);
  try {
    for await (const line of createInterface({ input })) {
      if (line.trim() === '') continue;
      clearTimeout(idle);
      let reply;
      try {
        const request = JSON.parse(line);
        await work(request.audio, request.output);
        reply = { ok: true };
      } catch (error) {
        reply = { ok: false, error: String(error?.message ?? error) };
      }
      output.write(`\n${REPLY}${JSON.stringify(reply)}\n`);
      idle = setTimeout(leave, idleMs);
    }
  } finally {
    clearTimeout(idle);
  }
}

/// Fails unless the small model loads and runs here. Packaging runs this so
/// a release never ships a recognizer that cannot start.
async function check() {
  const directory = await findModel(FAST);
  if (!directory) throw new Error(`${FAST} is not installed beside the recognizer.`);
  const recognizer = createRecognizer(loadSherpa(), FAST, directory, 1);
  recognize(recognizer, new Float32Array(16000), 16000, 30);
}

/// The trial run itself: loads an installed model and times it.
async function probe(id, provider = MODELS[id]?.provider ?? 'cpu') {
  const directory = MODELS[id] && (await findModel(id));
  if (!directory) throw new Error(`${id} is not installed.`);
  const recognizer = createRecognizer(loadSherpa(provider), id, directory, runtimeSettings(machine()).threads, provider);
  console.log(JSON.stringify({ speed: Math.round(measureSpeed(recognizer)) }));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const positional = rest.filter((argument) => !argument.startsWith('--'));
  const option = (name) => rest.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (command === 'plan' && positional.length === 1) {
    await writeFile(positional[0], JSON.stringify(await plan(option('language'), rest.includes('--gpu'))));
  } else if (command === 'serve' && positional.length === 0 && option('model')) {
    const idle = Number(option('idle'));
    await serveRequests(process.stdin, process.stdout, await openModel(option('model')), idle > 0 ? { idleMs: idle * 1000 } : {});
  } else if (command === 'transcribe' && positional.length === 2 && option('model')) {
    await transcribe(positional[0], positional[1], option('model'));
  } else if (command === 'fetch' && positional.length === 2) {
    await fetchModel(positional[0], positional[1]);
  } else if (command === 'probe' && positional.length === 1) {
    await probe(positional[0], option('provider'));
  } else if (command === 'check') {
    await check();
  } else {
    throw new Error('Usage: recognize.mjs plan <output.json> [--language=en] [--gpu] | serve --model=<id> [--idle=<seconds>] | transcribe <audio> <output.json> --model=<id> | fetch <id> <directory> | probe <id> [--provider=cuda] | check');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
