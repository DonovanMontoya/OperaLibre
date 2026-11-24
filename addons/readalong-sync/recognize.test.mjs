import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACCURATE,
  ACCURATE_FIRST_SPEED,
  ACCURATE_GPU,
  ACCURATE_MIN_MEMORY,
  FAST,
  GPU_RUNTIME,
  REPLY,
  cacheDir,
  choosePlan,
  chunkBounds,
  download,
  gpuSupported,
  recognize,
  runtimeSettings,
  serveRequests,
  timelineFrom,
  trialFailure,
  wordsFromTokens
} from './recognize.mjs';

const GIB = 1024 ** 3;

test('a small server gets the small model alone', () => {
  assert.deepEqual(
    choosePlan({ language: 'en', memoryBytes: 2 * GIB, speed: 8, accurateAvailable: true }),
    { model: FAST, retryModel: null }
  );
});

test('an ordinary server leads with the small model and keeps the larger one for hard passages', () => {
  assert.deepEqual(
    choosePlan({ language: 'en', memoryBytes: 16 * GIB, speed: ACCURATE_FIRST_SPEED - 1, accurateAvailable: true }),
    { model: FAST, retryModel: ACCURATE }
  );
});

test('a fast server leads with the larger model', () => {
  assert.deepEqual(
    choosePlan({ language: 'en', memoryBytes: ACCURATE_MIN_MEMORY, speed: ACCURATE_FIRST_SPEED, accurateAvailable: true }),
    { model: ACCURATE, retryModel: FAST }
  );
});

test('the larger model is left out when it could not be downloaded', () => {
  assert.deepEqual(
    choosePlan({ language: 'en', memoryBytes: 64 * GIB, speed: 500, accurateAvailable: false }),
    { model: FAST, retryModel: null }
  );
});

test('other languages and undetected ones stay with the server\'s recognizer', () => {
  for (const language of ['de', 'es', undefined]) {
    assert.deepEqual(
      choosePlan({ language, memoryBytes: 64 * GIB, speed: 500, accurateAvailable: true, gpuAvailable: true }),
      { model: null, retryModel: null }
    );
  }
});

test('a graphics card that passed its trial leads with the larger model on any processor', () => {
  assert.deepEqual(
    choosePlan({ language: 'en', memoryBytes: 8 * GIB, speed: 5, accurateAvailable: false, gpuAvailable: true }),
    { model: ACCURATE_GPU, retryModel: FAST }
  );
});

test('the GPU runtime is the same version as the bundled one whose addon it borrows', async () => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(GPU_RUNTIME.version, manifest.dependencies['sherpa-onnx-node']);
  assert.ok(GPU_RUNTIME.url.includes(`/v${GPU_RUNTIME.version}/`));
});

test('GPU recognition is only attempted on 64-bit Linux with the NVIDIA driver loaded', () => {
  const present = fileURLToPath(import.meta.url);
  assert.equal(gpuSupported('linux', 'x64', present), true);
  assert.equal(gpuSupported('linux', 'x64', `${present}.missing`), false);
  assert.equal(gpuSupported('linux', 'arm64', present), false);
  assert.equal(gpuSupported('win32', 'x64', present), false);
  assert.equal(gpuSupported('darwin', 'arm64', present), false);
});

test('a trial run passes only when the card really did the work', () => {
  assert.equal(trialFailure({ status: 0, stderr: '' }), null);
  // What the runtime prints when it quietly uses the processor instead.
  const missing =
    'session.cc:AppendCudaProviderV2:198 Failed to enable CUDA: provider_bridge_ort.cc:1988 [ONNXRuntimeError] : 1 : FAIL : ' +
    'Failed to load library /cache/libonnxruntime_providers_cuda.so with error: libcublasLt.so.12: cannot open shared object file: No such file or directory\n' +
    '. Available providers: CUDAExecutionProvider, CPUExecutionProvider, . Fallback to cpu\n';
  assert.match(trialFailure({ status: 0, stderr: missing }), /^libcublasLt\.so\.12: cannot open shared object file\. NVIDIA's CUDA 12 and cuDNN 9/);
  const tooNew =
    '\u001b[1;31m2026-11-24 [E:onnxruntime:, cuda_call.cc:148 CudaCall] CUDNN failure 5003: CUDNN_STATUS_EXECUTION_FAILED_CUDART ; GPU=0\u001b[m\n' +
    'c-api.cc:SherpaOnnxCreateOfflineRecognizer:719 Failed to create OfflineRecognizer\n';
  assert.match(trialFailure({ status: 1, stderr: tooNew }), /^cuDNN failed with CUDNN_STATUS_EXECUTION_FAILED_CUDART\. Cards older than the RTX 20 series/);
  assert.equal(trialFailure({ status: 1, stderr: 'first\n\n  CUDA out of memory  \n' }), 'CUDA out of memory');
  assert.equal(trialFailure({ status: null, error: new Error('spawnSync node ETIMEDOUT'), stderr: '' }), 'spawnSync node ETIMEDOUT');
});

test('one core is left for playback and small machines use shorter pieces', () => {
  assert.deepEqual(runtimeSettings({ cores: 1, memoryBytes: 1 * GIB }), { threads: 1, chunkSeconds: 15 });
  assert.deepEqual(runtimeSettings({ cores: 4, memoryBytes: 4 * GIB }), { threads: 3, chunkSeconds: 30 });
  assert.deepEqual(runtimeSettings({ cores: 32, memoryBytes: 64 * GIB }), { threads: 4, chunkSeconds: 30 });
});

test('downloaded models are kept outside the add-on on every platform', () => {
  assert.equal(cacheDir({ OPERALIBRE_READALONG_MODELS: '/models' }, 'linux', '/home/a'), '/models');
  assert.equal(cacheDir({}, 'linux', '/home/a'), '/home/a/.local/share/operalibre/readalong-models');
  assert.equal(cacheDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/a'), '/data/operalibre/readalong-models');
  assert.equal(
    cacheDir({}, 'darwin', '/Users/a'),
    '/Users/a/Library/Application Support/OperaLibre/readalong-models'
  );
  assert.equal(
    cacheDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'),
    path.join('C:\\Users\\a\\AppData\\Local', 'OperaLibre', 'readalong-models')
  );
});

test('word pieces become words that end where speech does', () => {
  const words = wordsFromTokens(
    [' But', ' A', 'd', 'el', 'ine', ' c', 'ross', 'es', ',', ' the', ' ro', 'om', '.'],
    [0.08, 0.24, 0.32, 0.4, 0.64, 0.72, 0.8, 0.88, 0.96, 1.12, 1.28, 1.36, 1.6],
    [0.16, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.16, 0.16, 0.08, 0.16, 0.4]
  );
  assert.deepEqual(
    words.map((word) => [word.text, word.startTime, Number(word.endTime.toFixed(2))]),
    [
      ['But', 0.08, 0.24],
      ['Adeline', 0.24, 0.72],
      ['crosses,', 0.72, 0.96],
      ['the', 1.12, 1.28],
      ['room.', 1.28, 1.52]
    ]
  );
});

test('word pieces without durations end at the next piece', () => {
  const words = wordsFromTokens([' one', ' two'], [0.5, 0.9]);
  assert.deepEqual(words[0], { text: 'one', startTime: 0.5, endTime: 0.9 });
  assert.equal(words[1].startTime, 0.9);
});

// Constant tone with silent gaps at the given seconds.
function toneWithPauses(seconds, sampleRate, pauses) {
  const samples = new Float32Array(seconds * sampleRate).fill(0.2);
  for (const [from, to] of pauses) samples.fill(0, from * sampleRate, to * sampleRate);
  return samples;
}

test('audio is cut in a nearby pause instead of mid-word', () => {
  const sampleRate = 1000;
  const samples = toneWithPauses(90, sampleRate, [[28.6, 29], [61, 61.5]]);
  const bounds = chunkBounds(samples, sampleRate, 30);
  assert.equal(bounds.length, 4);
  assert.equal(bounds[0], 0);
  assert.equal(bounds.at(-1), samples.length);
  assert.ok(bounds[1] > 28.6 * sampleRate && bounds[1] < 29 * sampleRate, `first cut at ${bounds[1]}`);
  assert.ok(bounds[2] > 61 * sampleRate && bounds[2] < 61.5 * sampleRate, `second cut at ${bounds[2]}`);
});

test('audio without a pause is cut evenly and short audio is not cut', () => {
  const sampleRate = 1000;
  const bounds = chunkBounds(new Float32Array(70 * sampleRate).fill(0.2), sampleRate, 30);
  assert.equal(bounds.length, 4);
  for (const [index, cut] of bounds.slice(1, -1).entries()) {
    assert.ok(Math.abs(cut - ((index + 1) * 70 * sampleRate) / 3) <= 0.1 * sampleRate, `cut ${index} at ${cut}`);
  }
  assert.deepEqual(chunkBounds(new Float32Array(12 * sampleRate), sampleRate, 30), [0, 12 * sampleRate]);
});

test('a word heard by two overlapping pieces is kept once, with book-relative times', () => {
  const sampleRate = 1000;
  const samples = toneWithPauses(60, sampleRate, [[29.9, 30.1]]);
  // Stands in for the model: every piece "hears" one word per second of the
  // audio it was given, named for its absolute second.
  const pieces = [];
  const recognizer = {
    createStream: () => ({
      acceptWaveform({ samples: piece }) {
        this.from = piece.byteOffset / Float32Array.BYTES_PER_ELEMENT / sampleRate;
        this.seconds = piece.length / sampleRate;
        pieces.push([this.from, this.from + this.seconds]);
      }
    }),
    decode() {},
    getResult(stream) {
      const tokens = [];
      const timestamps = [];
      const first = Math.ceil(stream.from);
      for (let second = first; second + 0.5 <= stream.from + stream.seconds; second += 1) {
        tokens.push(` w${second}`);
        timestamps.push(second - stream.from);
      }
      return { tokens, timestamps, durations: tokens.map(() => 0.5) };
    }
  };
  const segments = recognize(recognizer, samples, sampleRate, 30);
  assert.equal(pieces.length, 2);
  assert.ok(pieces[0][1] > 31 && pieces[1][0] < 29, 'pieces overlap around the cut');
  const words = segments.flat();
  assert.deepEqual(
    words.map((word) => word.text),
    Array.from({ length: 60 }, (_, second) => `w${second}`)
  );
  assert.ok(words.every((word) => Math.abs(word.startTime - Number(word.text.slice(1))) < 1e-6));

  // A model whose clock runs early has every time moved later, and still
  // gives each word to one piece only.
  const shifted = recognize(recognizer, samples, sampleRate, 30, 0.08).flat();
  assert.deepEqual(shifted.map((word) => word.text), words.map((word) => word.text));
  assert.ok(shifted.every((word, index) => Math.abs(word.startTime - words[index].startTime - 0.08) < 1e-6));
});

test('audio too short to hold a word is never handed to the model, which would abort on it', () => {
  const recognizer = {
    createStream() {
      throw new Error('the model was given audio it aborts on');
    }
  };
  for (const samples of [0, 26, 79, 1599]) {
    assert.deepEqual(recognize(recognizer, new Float32Array(samples), 16000, 30), []);
  }
});

test('the timeline has the segment and word shape the server reads', () => {
  const timeline = timelineFrom([
    [
      { text: 'Hello,', startTime: 1.00049, endTime: 1.4 },
      { text: 'world.', startTime: 1.5, endTime: 2.12345 }
    ]
  ]);
  assert.deepEqual(timeline, [
    {
      type: 'segment',
      text: 'Hello, world.',
      startTime: 1,
      endTime: 2.123,
      timeline: [
        { type: 'word', text: 'Hello,', startTime: 1, endTime: 1.4 },
        { type: 'word', text: 'world.', startTime: 1.5, endTime: 2.123 }
      ]
    }
  ]);
  assert.deepEqual(timelineFrom([]), []);
});

test('a download is kept only when it matches its pinned size and checksum', async (t) => {
  const body = Buffer.from('model bytes');
  const server = http.createServer((request, response) => {
    if (request.url === '/missing') {
      response.writeHead(404).end();
    } else {
      response.end(body);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recognize-test-'));
  t.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const sha256 = createHash('sha256').update(body).digest('hex');
  const file = path.join(directory, 'model.onnx');

  await assert.rejects(download(`${url}/model`, file, { size: body.length, sha256: 'a'.repeat(64) }), /SHA-256/);
  await assert.rejects(download(`${url}/model`, file, { size: body.length - 1, sha256 }), /larger than/);
  await assert.rejects(download(`${url}/model`, file, { size: body.length + 1, sha256 }), /expected/);
  await assert.rejects(download(`${url}/missing`, file, { size: body.length, sha256 }), /404/);
  assert.deepEqual(await readdir(directory), []);

  await download(`${url}/model`, file, { size: body.length, sha256 });
  assert.deepEqual(await readFile(file), body);
  assert.deepEqual(await readdir(directory), ['model.onnx']);
});

function replies(output) {
  return output
    .read()
    .toString()
    .split('\n')
    .filter((line) => line.startsWith(REPLY))
    .map((line) => JSON.parse(line.slice(REPLY.length)));
}

test('a serving recognizer answers each request and keeps going after one fails', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen = [];
  const serving = serveRequests(
    input,
    output,
    async (audio, timeline) => {
      seen.push([audio, timeline]);
      if (audio === 'broken.wav') throw new Error('Could not read broken.wav');
      // The speech runtime writes to the same stream, without a newline.
      output.write('runtime chatter');
    },
    { leave: () => assert.fail('left while there was work') }
  );
  input.write('{"audio":"one.wav","output":"one.json"}\n\n{"audio":"broken.wav","output":"two.json"}\n');
  input.end('{"audio":"three.wav","output":"three.json"}\n');
  await serving;

  assert.deepEqual(seen, [['one.wav', 'one.json'], ['broken.wav', 'two.json'], ['three.wav', 'three.json']]);
  assert.deepEqual(replies(output), [{ ok: true }, { ok: false, error: 'Could not read broken.wav' }, { ok: true }]);
});

test('a serving recognizer leaves when no request comes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let left = 0;
  const serving = serveRequests(input, output, async () => {}, {
    idleMs: 20,
    leave: () => {
      left += 1;
      input.end();
    }
  });
  input.write('{"audio":"one.wav","output":"one.json"}\n');
  await serving;

  assert.equal(left, 1);
  assert.deepEqual(replies(output), [{ ok: true }]);
});
