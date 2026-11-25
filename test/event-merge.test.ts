import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergeEvents } from '../web/src/mergeEvents.ts';
import type { RunEvent } from '../web/src/api.ts';

test('overlapping and out-of-order polls show each event once in sequence', () => {
  const event = (seq: number): RunEvent => ({ seq, ts: '2026-01-01T00:00:00Z', type: 'agent.progress', message: String(seq) });
  const first = mergeEvents([], [event(1), event(2), event(4)]);
  const overlap = mergeEvents(first, [event(1), event(2), event(3)]);
  assert.deepEqual(overlap.map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.deepEqual(mergeEvents(overlap, [event(4), event(5)]).map((entry) => entry.seq), [1, 2, 3, 4, 5]);
});
