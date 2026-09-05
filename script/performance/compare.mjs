import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: npm run perf:compare -- BEFORE_DIR AFTER_DIR');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function metrics(directory) {
  const run = read(resolve(directory, 'run.json'));
  if (!run.completedAt || !Object.keys(run.checks).length || Object.values(run.checks).some(check => check !== 'passed')) {
    throw new Error(`Run is incomplete or failed: ${directory}`);
  }
  const values = {};
  const serverFile = resolve(directory, 'server.json');
  if (existsSync(serverFile)) {
    const server = read(serverFile);
    for (const sample of server.measurements) {
      values[`server/${server.books}/${sample.scenario}/medianMs`] = sample.medianMs;
      values[`server/${server.books}/${sample.scenario}/p95Ms`] = sample.p95Ms;
    }
  }
  const browserFile = resolve(directory, 'browser-results.json');
  if (existsSync(browserFile)) {
    const visit = suite => {
      for (const spec of suite.specs ?? []) for (const test of spec.tests) {
        for (const result of test.results) for (const attachment of result.attachments ?? []) {
          if (attachment.name !== 'measurements') continue;
          const data = JSON.parse(attachment.body
            ? Buffer.from(attachment.body, 'base64').toString()
            : readFileSync(attachment.path, 'utf8'));
          const prefix = `browser/${data.books}/${data.project}`;
          values[`${prefix}/shelfReadyMs`] = data.shelfReadyMs;
          const sorted = [...data.searchTimesMs].sort((a,b) => a-b);
          values[`${prefix}/searchMedianMs`] = (sorted[2] + sorted[3]) / 2;
          if (data.playbackFramesMs?.length) {
            const frames = [...data.playbackFramesMs].sort((a,b) => a-b);
            values[`${prefix}/frameP95Ms`] = frames[Math.ceil(frames.length * .95)-1];
          }
        }
      }
      for (const child of suite.suites ?? []) visit(child);
    };
    visit(read(browserFile));
  }
  const nativeFile = resolve(directory, 'ios/metrics.json');
  if (existsSync(nativeFile)) {
    const summary = read(resolve(directory, 'ios/summary.json'));
    const device = summary.devicesAndConfigurations[0].device;
    run.nativeDevice = `${device.modelName}/${device.osVersion}/${device.architecture}`;
    for (const test of read(nativeFile)) for (const sample of test.testRuns) for (const metric of sample.metrics) {
      const mean = metric.measurements.reduce((sum,value) => sum+value, 0) / metric.measurements.length;
      values[`ios/${test.testIdentifier}/${metric.displayName} (${metric.unitOfMeasurement})`] = mean;
    }
  }
  return { run, values };
}
const before = metrics(beforePath), after = metrics(afterPath);
for (const key of ['platform','arch','os','cpu','node','rust','books','playwright','xcode']) {
  if (before.run[key] !== after.run[key]) throw new Error(`Incomparable ${key}: ${before.run[key]} vs ${after.run[key]}`);
}
if (before.run.nativeDevice && after.run.nativeDevice && before.run.nativeDevice !== after.run.nativeDevice) {
  throw new Error('Native simulator models or OS versions differ');
}
const rows = Object.keys(before.values).filter(key => key in after.values).map(key => ({
  metric: key, before: before.values[key].toFixed(3), after: after.values[key].toFixed(3),
  change: before.values[key] === 0 ? 'n/a' : `${((after.values[key]-before.values[key])/Math.abs(before.values[key])*100).toFixed(1)}%`,
}));
if (!rows.length) throw new Error('No comparable timing measurements; inspect native .xcresult bundles in Xcode.');
console.table(rows);
console.log('Negative changes mean lower values (time or memory). Repeat runs on an idle machine; these are observations, not pass/fail thresholds.');
