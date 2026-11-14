import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePlaylist, openingSegments, validateResults, startServer } from './server.mjs';

const playlist = '#EXTM3U\n#EXTINF:0.8,\nbook0.m4s\n#EXTINF:1.2,\nbook1.m4s\n#EXTINF:1,\nbook2.m4s\n#EXTINF:1,\nbook3.m4s\n';
const config = { speeds: [40, 4], positions: [0, 2], pairs: 1, latencyMs: 0 };
const sample = { id: 'sample', mbps: 40, target: 0, index: 0, kind: 'flat', startMs: 1, firstAdvanceMs: 2, advanceMs: 3, position: 0.2, pausePassed: true, seekPlaybackPassed: true, seekPosition: 2, checkpointPosition: 2, network: { bytes: 1, requests: [{}] } };

test('selects preroll/current/next using timestamps, including exact boundaries', () => {
  const segments = parsePlaylist(playlist);
  assert.deepEqual(openingSegments(segments, 0), ['book0.m4s', 'book1.m4s']);
  assert.deepEqual(openingSegments(segments, 2), ['book1.m4s', 'book2.m4s', 'book3.m4s']);
  assert.deepEqual(openingSegments(segments, 1.99), ['book0.m4s', 'book1.m4s', 'book2.m4s']);
  assert.throws(() => openingSegments(segments, 4));
  assert.throws(() => parsePlaylist('#EXTINF:1,\n../outside'));
});

test('failed, incomplete, duplicate and empty-work samples cannot pass', () => {
  validateResults([sample], config, false);
  assert.throws(() => validateResults([sample], { ...config, embeddedCoverBytes: 100 }, false));
  validateResults([{ ...sample, artworkPassed: true }], { ...config, embeddedCoverBytes: 100 }, false);
  assert.throws(() => validateResults([sample], config));
  assert.throws(() => validateResults([sample, sample], config, false));
  for (const patch of [{ error: 'timeout' }, { network: { bytes: 0 } }, { checkpointPosition: 0 }, { firstAdvanceMs: 0.5 }, { seekPlaybackPassed: false }]) {
    assert.throws(() => validateResults([{ ...sample, ...patch }], config, false));
  }
});

test('fixture server restricts paths, serves ranges and bundles, preserves failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-bench-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'hls'));
  await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify({ ...config, candidate: 'compact' }));
  await fs.writeFile(path.join(root, 'hls/book.m3u8'), playlist);
  for (const file of ['flat.m4a', 'compact.m4a', 'hls/init.mp4', ...[0, 1, 2, 3].map(i => `hls/book${i}.m4s`)]) await fs.writeFile(path.join(root, file), '0123456789');
  const { server, base } = await startServer(root);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const range = await fetch(`${base}/run/40/sample/flat.m4a`, { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await range.text(), '234');
  const compact = await fetch(`${base}/run/40/sample/compact.m4a`, { headers: { Range: 'bytes=2-4' } });
  assert.equal(compact.status, 206);
  assert.equal(await compact.text(), '234');
  assert.equal((await fetch(`${base}/run/40/sample/fixture.json`)).status, 404);
  const bundle = await (await fetch(`${base}/run/40/sample/bootstrap-2.json`)).json();
  assert.ok(Buffer.from(bundle['book.m3u8'], 'base64').toString().includes('TIME-OFFSET=2'));
  assert.ok(bundle['book1.m4s']);
  assert.equal(bundle['book0.m4s'], undefined);
  const result = await fetch(`${base}/result`, { method: 'POST', body: JSON.stringify({ ...sample, error: 'playback failed' }) });
  assert.equal(result.status, 422);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'results.json'))).complete, false);
});

test('report CLI accepts complete runs and rejects incomplete or failed runs', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = [];
  for (const mbps of config.speeds) for (const target of config.positions) for (const kind of ['flat', 'bootstrap']) {
    const seek = target === 0 ? 2 : 1;
    rows.push({ ...sample, id: `s${rows.length}`, mbps, target, kind, position: target + 0.2, seekPosition: seek, checkpointPosition: seek, duration: 4 });
  }
  const file = path.join(root, 'results.json');
  const report = new URL('./report.mjs', import.meta.url);
  const invoke = async data => {
    await fs.writeFile(file, JSON.stringify(data));
    return spawnSync(process.execPath, [report.pathname, file], { encoding: 'utf8' });
  };
  const success = await invoke({ config, rows, complete: true });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /firstAdvanceMs/);
  assert.match(success.stdout, /not production readiness/);
  const compactRows = rows.map(row => ({ ...row, kind: row.kind === 'bootstrap' ? 'compact' : row.kind }));
  const compact = await invoke({ config: { ...config, candidate: 'compact' }, rows: compactRows, complete: true });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /Candidate: compact/);
  assert.throws(() => validateResults(compactRows, config));
  assert.notEqual((await invoke({ config, rows: rows.slice(1), complete: true })).status, 0);
  assert.notEqual((await invoke({ config, rows, complete: false })).status, 0);
  rows[0].error = 'timeout';
  assert.notEqual((await invoke({ config, rows, complete: true })).status, 0);
});

test('packet windows are compressed, bounded, and revision-pinned', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'packet-bench-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'hls'));
  await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify({ ...config, candidate: 'packet' }));
  await fs.writeFile(path.join(root, 'hls/book.m3u8'), playlist);
  await fs.writeFile(path.join(root, 'compact.m4a'), '0123456789');
  const { server, base } = await startServer(root);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `${base}/run/40/sample/api/books/fixture/tracks/fixture/packet-stream`;
  const response = await fetch(`${endpoint}?op=bootstrap`);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  const bootstrap = await response.json();
  assert.equal(bootstrap.length, 10);
  assert.equal(Buffer.from(bootstrap.data, 'base64').toString(), '0123456789');
  const range = `${endpoint}?op=range&offset=3&count=4&revision=${bootstrap.revision}`;
  assert.equal(await (await fetch(range)).text(), '3456');
  assert.equal((await fetch(range.replace('count=4', 'count=65537'))).status, 400);
  assert.equal((await fetch(range.replace('offset=3', 'offset=9'))).status, 400);
  assert.equal((await fetch(range.replace(bootstrap.revision, 'stale'))).status, 400);
});
