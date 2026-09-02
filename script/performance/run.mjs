import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { cpus, platform, arch, release } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [scope = 'portable', ...args] = process.argv.slice(2);
if (!['portable', 'web', 'server', 'ios', 'all'].includes(scope)
    || (args.length && (args.length !== 2 || args[0] !== '--label'))) {
  throw new Error('Usage: run.mjs [portable|web|server|ios|all] [--label NAME]');
}
const label = args[1] ?? new Date().toISOString().replace(/[:.]/g, '-');
if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(label)) throw new Error('Invalid run label');
const output = resolve(root, 'output/performance/runs', label);
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output); // Refuse to overwrite a baseline.
const metadata = { schema: 1, scope, label, startedAt: new Date().toISOString(),
  platform: platform(), arch: arch(), os: release(), cpu: cpus()[0]?.model,
  node: process.version, playwright: JSON.parse(readFileSync(resolve(root, 'node_modules/@playwright/test/package.json'), 'utf8')).version, books: process.env.PERF_BOOKS ?? 'web=1000,server=200', checks: {} };
for (const [key, cmd] of [['xcode', ['xcodebuild', '-version']], ['revision', ['jj', 'log', '-r', '@', '--no-graph', '-T', 'commit_id']],
                         ['rust', ['rustc', '--version']]]) {
  metadata[key] = spawnSync(cmd[0], cmd.slice(1), { cwd: root, encoding: 'utf8' }).stdout?.trim();
}
const env = { ...process.env, PERF_OUTPUT_DIR: output, PERF_SERVER_OUTPUT: resolve(output, 'server.json') };
function run(name, command, argv) {
  console.log(`\n${name}: ${command} ${argv.join(' ')}\nArtifacts: ${output}`);
  const result = spawnSync(command, argv, { cwd: root, env, stdio: 'inherit' });
  metadata.checks[name] = result.status === 0 ? 'passed' : 'failed';
  writeFileSync(resolve(output, 'run.json'), JSON.stringify(metadata, null, 2));
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}
writeFileSync(resolve(output, 'run.json'), JSON.stringify(metadata, null, 2));
if (['portable','all','web'].includes(scope)) {
  run('web-unit', 'npm', ['test', '-w', '@operalibre/web']);
  run('web-browser', 'npm', ['run', 'test:perf', '-w', '@operalibre/web']);
}
if (['portable','all','server'].includes(scope)) {
  run('server-contracts', 'cargo', ['test', '--locked', '--release', '--manifest-path', 'apps/server/Cargo.toml',
    'http_tests::', '--', '--test-threads=1']);
  run('server', 'cargo', ['test', '--locked', '--release', '--manifest-path', 'apps/server/Cargo.toml',
    'library_performance_baseline', '--', '--ignored', '--nocapture', '--test-threads=1']);
}
if (['all','ios'].includes(scope)) {
  run('ios', 'python3', ['script/performance/ios.py']);
}
metadata.completedAt = new Date().toISOString();
writeFileSync(resolve(output, 'run.json'), JSON.stringify(metadata, null, 2));
console.log(`\nCompleted: ${output}`);
