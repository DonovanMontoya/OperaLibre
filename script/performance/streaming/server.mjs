import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function parsePlaylist(text) {
  let time = 0;
  let duration;
  const segments = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).replace(/,$/, ''));
    else if (line && !line.startsWith('#')) {
      if (!/^book\d+\.m4s$/.test(line) || !Number.isFinite(duration) || duration <= 0) throw Error('Invalid fixture playlist');
      segments.push({ name: line, start: time, end: time + duration });
      time += duration;
      duration = undefined;
    }
  }
  if (!segments.length) throw Error('Empty playlist');
  return segments;
}

export function openingSegments(segments, target) {
  if (!Number.isFinite(target) || target < 0 || target >= segments.at(-1).end) throw Error('Invalid position');
  const index = segments.findIndex(segment => segment.end > target);
  // Include decoder preroll and the next fragment when seeking near a boundary.
  return segments.slice(Math.max(0, index - 1), index + 2).map(segment => segment.name);
}

export function validateResults(rows, config, complete = true) {
  const keys = new Set();
  const ids = new Set();
  for (const row of rows) {
    if (!/^[\w-]{1,80}$/.test(row.id) || ids.has(row.id)) throw Error('Invalid or repeated sample id');
    ids.add(row.id);
    if (!config.speeds.includes(row.mbps) || !config.positions.includes(row.target) || !['flat', 'bootstrap'].includes(row.kind) || !Number.isInteger(row.index) || row.index < 0 || row.index >= config.pairs) throw Error('Unexpected sample');
    const key = `${row.mbps}/${row.target}/${row.index}/${row.kind}`;
    if (keys.has(key)) throw Error('Repeated scenario');
    keys.add(key);
    if (row.error) throw Error(`Sample failed: ${row.error}`);
    for (const metric of ['startMs', 'firstAdvanceMs', 'advanceMs']) if (!Number.isFinite(row[metric]) || row[metric] <= 0) throw Error(`Missing ${metric}`);
    if (row.firstAdvanceMs < row.startMs || row.advanceMs < row.firstAdvanceMs) throw Error('Invalid timing order');
    const seek = row.target === 0 ? config.positions[1] : config.positions[1] / 2;
    if (!Number.isFinite(row.position) || row.position <= row.target + 0.15 || !row.pausePassed || !row.seekPlaybackPassed || !Number.isFinite(row.seekPosition) || Math.abs(row.seekPosition - seek) > 0.05 || !Number.isFinite(row.checkpointPosition) || Math.abs(row.checkpointPosition - seek) > 0.05) throw Error('Playback/checkpoint assertion failed');
    if (!row.network?.bytes || !row.network?.requests?.length) throw Error('No remote work recorded');
  }
  if (complete && rows.length !== config.pairs * config.speeds.length * config.positions.length * 2) throw Error('Incomplete run');
}

export async function startServer(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json')));
  const playlist = fs.readFileSync(path.join(root, 'hls/book.m3u8'), 'utf8');
  const segments = parsePlaylist(playlist);
  const allowed = new Set(['flat.m4a', 'hls/init.mp4', ...segments.map(s => `hls/${s.name}`)]);
  const token = crypto.randomBytes(24).toString('hex');
  const runs = new Map();
  const rows = [];
  const resultPath = path.join(root, 'results.json');
  if (fs.existsSync(resultPath)) throw Error('Use a fresh output directory; results already exist');
  const total = config.pairs * config.speeds.length * config.positions.length * 2;
  const save = () => {
    let complete = false;
    try { validateResults(rows, config); complete = true; } catch {}
    fs.writeFileSync(`${resultPath}.tmp`, JSON.stringify({ config, rows, complete }, null, 2));
    fs.renameSync(`${resultPath}.tmp`, resultPath);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith(`/${token}/`)) { res.writeHead(404).end(); return; }
      const route = url.pathname.slice(token.length + 2);
      if (route === 'result' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 16384) { res.writeHead(413).end(); return; } }
        const row = JSON.parse(body);
        const run = runs.get(row.id);
        row.network = run ? { bytes: run.bytes, requests: run.requests } : null;
        // Preserve failed samples too, but never label the run complete on failure.
        rows.push(row);
        try { validateResults(rows, config, false); } catch (error) { save(); res.writeHead(422).end(error.message); return; }
        save();
        console.log(`Recorded ${rows.length}/${total}`);
        res.end('ok'); return;
      }
      const match = /^run\/(40|4)\/([\w-]{1,80})\/(.+)$/.exec(route);
      if (req.method !== 'GET' || !match) { res.writeHead(404).end(); return; }
      const [, speed, id, relative] = match;
      if (!runs.has(id)) {
        if (runs.size >= total) { res.writeHead(429).end(); return; }
        runs.set(id, { bytes: 0, requests: [], next: 0 });
      }
      const run = runs.get(id);
      let source;
      let length;
      let headers = { 'Cache-Control': 'no-store' };
      let status = 200;
      const bootstrap = /^bootstrap-(\d+)\.json$/.exec(relative);
      if (bootstrap) {
        const target = Number(bootstrap[1]);
        if (!config.positions.includes(target)) { res.writeHead(400).end(); return; }
        const manifest = playlist.replace('#EXTM3U\n', `#EXTM3U\n#EXT-X-START:TIME-OFFSET=${target},PRECISE=YES\n`);
        const files = { 'book.m3u8': Buffer.from(manifest).toString('base64'), 'init.mp4': fs.readFileSync(path.join(root, 'hls/init.mp4')).toString('base64') };
        for (const name of openingSegments(segments, target)) files[name] = fs.readFileSync(path.join(root, 'hls', name)).toString('base64');
        const body = zlib.gzipSync(Buffer.from(JSON.stringify(files)));
        length = body.length;
        source = (async function* () { for (let i = 0; i < body.length; i += 16384) yield body.subarray(i, i + 16384); })();
        headers = { ...headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' };
      } else {
        if (!allowed.has(relative)) { res.writeHead(404).end(); return; }
        const file = path.join(root, relative);
        const size = fs.statSync(file).size;
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (req.headers.range && !range) { res.writeHead(416).end(); return; }
        const start = range ? Number(range[1]) : 0;
        const end = Math.min(size - 1, range?.[2] ? Number(range[2]) : size - 1);
        if (start > end) { res.writeHead(416).end(); return; }
        length = end - start + 1;
        source = fs.createReadStream(file, { start, end, highWaterMark: 16384 });
        res.on('close', () => source.destroy());
        headers = { ...headers, 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes' };
        if (range) { status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`; }
      }
      run.requests.push({ relative, range: req.headers.range ?? null, length });
      res.writeHead(status, { ...headers, 'Content-Length': length });
      await delay(config.latencyMs);
      for await (const chunk of source) {
        run.next = Math.max(run.next, performance.now()) + chunk.length / (Number(speed) * 1e6 / 8) * 1000;
        await delay(Math.max(0, run.next - performance.now()));
        if (res.destroyed) break;
        run.bytes += chunk.length;
        if (!res.write(chunk)) await new Promise(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done); res.once('close', done);
        });
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      console.error(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/${token}`;
  fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify({ base, pid: process.pid }));
  return { server, base };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? '');
  const { server } = await startServer(root);
  console.log('Fixture server ready; server.json contains the local address. Stop with Ctrl-C.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.closeAllConnections(); server.close();
  });
}
