import fs from 'node:fs';
import { validateResults } from './server.mjs';

const { config, rows, complete } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
validateResults(rows, config);
if (!complete) throw Error('Run not marked complete');
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
console.log('Prepared fixtures; simulated pacing; playback clock, not acoustic onset.');
console.log(`${config.pairs} pairs per scenario. Encoded payload: ${config.encodedAudioHash}`);
console.log(`Candidate: ${config.candidate ?? 'bootstrap'}`);
console.log(`Baseline: ${config.baseline ?? 'original faststart'}`);
for (const mbps of config.speeds) for (const target of config.positions) {
  const groups = ['flat', config.candidate ?? 'bootstrap'].map(kind => rows.filter(r => r.mbps === mbps && r.target === target && r.kind === kind));
  for (const metric of ['startMs', 'firstAdvanceMs']) {
    const values = groups.map(group => group.map(row => row[metric]));
    const medians = values.map(median);
    console.log(`${mbps} Mbps @${target}s ${metric}: ${medians.map(n => n.toFixed(2)).join(' -> ')} ms; ${(medians[0] / medians[1]).toFixed(2)}x; ranges ${values.map(v => `${Math.min(...v).toFixed(2)}..${Math.max(...v).toFixed(2)}`).join(' / ')}`);
  }
  console.log(`Observed durations (seconds): ${groups.map(g => [...new Set(g.map(r => r.duration))]).map(v => v.join(',')).join(' / ')}`);
}
console.log('Encoded packet equality does not establish decoded timeline equivalence. This is not production readiness evidence.');
