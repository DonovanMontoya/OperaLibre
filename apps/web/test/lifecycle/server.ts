import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Book, Progress } from '../../src/types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function wav(seconds = 180) {
  const bytes = seconds * 8000 * 2;
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF'); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
  data.writeUInt32LE(bytes, 40);
  return data;
}

async function unusedPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export class AppServer {
  token = '';
  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  constructor(readonly directory: string, readonly url: string, private log: ReturnType<typeof createWriteStream>) {}

  async start() {
    const target = process.env.CARGO_TARGET_DIR
      ? resolve(root, process.env.CARGO_TARGET_DIR)
      : resolve(root, 'apps/server/target');
    const binary = resolve(target, 'debug', process.platform === 'win32' ? 'operalibre-server.exe' : 'operalibre-server');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('OPERALIBRE_') && !key.startsWith('LIBATION_')));
    const child = spawn(binary, [], {
      cwd: this.directory,
      env: { ...env, OPERALIBRE_SERVER_CONFIG: join(this.directory, 'server.config') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout?.pipe(this.log, { end: false });
    child.stderr?.pipe(this.log, { end: false });
    await expect.poll(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Fixture server exited: ${child.exitCode}`);
      return fetch(`${this.url}/api/health`).then(r => r.json()).then(r => r.ready).catch(() => false);
    }, { timeout: 15_000 }).toBe(true);
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM') {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await this.exited; } finally { clearTimeout(deadline); }
    this.child = null;
  }

  async restartAfterCrash() {
    // Only the fixture child is killed; accounts and library stay on disk.
    await this.stop('SIGKILL');
    await this.start();
  }

  async json<T>(path: string, method = 'GET', body?: unknown, token = this.token): Promise<T> {
    const response = await fetch(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }

  books() { return this.json<Book[]>('/api/books'); }
  progress(bookId: string) { return this.json<Progress | null>(`/api/books/${bookId}/progress`); }
}

export const test = base.extend<{ server: AppServer }>({
  server: async ({}, use, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'operalibre-lifecycle-'));
    const log = createWriteStream(testInfo.outputPath('server.log'));
    const port = await unusedPort();
    const server = new AppServer(directory, `http://127.0.0.1:${port}`, log);
    try {
      const audio = wav();
      for (const title of ['First Book', 'Second Book']) {
        const folder = join(directory, 'library', title);
        await mkdir(folder, { recursive: true });
        for (const track of ['01', '02']) await writeFile(join(folder, `${track} Track.wav`), audio);
      }
      await writeFile(join(directory, 'server.config'), [
        'deployment_mode = lan', 'host = 127.0.0.1', `port = ${port}`,
        'library_root = library', 'data_dir = data',
        `web_dist_dir = ${resolve(root, 'apps/web/dist')}`, 'libation_auto_refresh_hours = 0'
      ].join('\n'));
      await server.start();
      await use(server);
    } finally {
      await server.stop();
      log.end();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
export { expect };
