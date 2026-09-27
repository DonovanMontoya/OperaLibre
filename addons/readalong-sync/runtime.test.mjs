import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wordTimelineToSegmentSentenceTimeline } from './node_modules/echogarden/dist/utilities/Timeline.js';

test('empty recognition returns no sentence instead of aborting the book', async () => {
  const result = await wordTimelineToSegmentSentenceTimeline([], '', 'en');
  assert.deepEqual(result.segmentTimeline, []);
});

test('ordinary recognized word clocks survive timeline conversion', async () => {
  const result = await wordTimelineToSegmentSentenceTimeline([
    { type: 'word', text: 'Hello', startTime: 2, endTime: 2.5, startOffsetUtf16: 0, endOffsetUtf16: 5 }
  ], 'Hello.', 'en');
  assert.equal(result.segmentTimeline.length, 1);
  assert.equal(result.segmentTimeline[0].startTime, 2);
  assert.equal(result.segmentTimeline[0].endTime, 2.5);
});
