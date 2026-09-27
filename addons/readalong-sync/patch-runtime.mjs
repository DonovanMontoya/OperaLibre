import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Echogarden 3.3.0's timeline converter dereferences element zero of an empty
// word list. Silence must produce an empty timeline so the caller can recover.
export async function patchEmptyTimeline(file) {
  const source = await readFile(file, 'utf8');
  const original = 'let lastKnownTimestamp = wordTimelineWithOffsets?.[0].startTime ?? 0;';
  const fixed = 'let lastKnownTimestamp = wordTimelineWithOffsets?.[0]?.startTime ?? 0;';
  if (source.includes(fixed)) return;
  if (!source.includes(original)) throw new Error('Review the empty-timeline compatibility patch for this speech runtime version');
  await writeFile(file, source.replace(original, fixed));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await patchEmptyTimeline(path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules/echogarden/dist/utilities/Timeline.js'));
}
