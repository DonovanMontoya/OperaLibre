// Exercise the production selector; do not duplicate its pause/recovery rules.
import { readFileSync } from 'node:fs';
import { findActiveFragmentIndex } from '../../apps/web/src/readalong.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.times.map(time =>
  findActiveFragmentIndex(input.fragments, time, 0, input.recoveryGaps)
)));
