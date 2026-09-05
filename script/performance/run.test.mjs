import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const jjRevision = 'a'.repeat(40), gitRevision = 'b'.repeat(40);
for (const scenario of [
  { name: 'Git-only CI checkout', git: `printf '${gitRevision}'`, expected: gitRevision },
  { name: 'failed jj command', jj: `printf '${jjRevision}'; exit 1`, git: `printf '${gitRevision}'`, expected: gitRevision },
  { name: 'Jujutsu working copy', jj: `printf '${jjRevision}'`, git: 'exit 1', expected: jjRevision },
  { name: 'neither VCS available' },
  { name: 'invalid revision output', jj: "printf 'invalid'", git: "printf 'invalid'" },
]) {
  test(scenario.name, () => {
    const root = mkdtempSync(join(tmpdir(), 'performance-runner-'));
    try {
      for (const path of ['script/performance', 'node_modules/@playwright/test', 'bin']) {
        mkdirSync(join(root, path), { recursive: true });
      }
      copyFileSync(new URL('./run.mjs', import.meta.url), join(root, 'script/performance/run.mjs'));
      writeFileSync(join(root, 'node_modules/@playwright/test/package.json'), '{"version":"test"}');
      // Keep the real runner and filesystem behavior; replace only external tools.
      for (const [name, body] of Object.entries({ cargo: 'exit 0', jj: scenario.jj, git: scenario.git })) {
        if (body) writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      }
      const result = spawnSync(process.execPath, [join(root, 'script/performance/run.mjs'), 'server', '--label', 'test'], {
        encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') },
      });
      const report = join(root, 'output/performance/runs/test/run.json');
      if (scenario.expected) {
        assert.equal(result.status, 0, result.stderr);
        const metadata = JSON.parse(readFileSync(report, 'utf8'));
        assert.equal(metadata.revision, scenario.expected);
        assert.equal(metadata.xcode, null);
        assert.equal(metadata.rust, null);
        assert.ok(metadata.completedAt);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Cannot record source revision: jj: .*; git:/);
        assert.equal(existsSync(report), false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
