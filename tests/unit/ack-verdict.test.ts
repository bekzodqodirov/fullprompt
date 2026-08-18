import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codesToUnmark } from '@/offline/ack-verdict';
import type { SyncAck } from '@/offline/scan-outbox';

/**
 * Every path that marks a code scanned needs a path that takes the mark back.
 *
 * The unload screen fills `done` the instant a code is scanned, because the
 * offline queue is the design. What was missing was the other direction: a
 * queue flushed after the logist pressed «Tushirish tugadi» is refused row by
 * row with `batch_not_unloading`, and the screen went on reading 150/150,
 * every lot line green, while those 150 cartons stood in the warehouse
 * recorded as missing in transit.
 */
const ack = (over: Partial<SyncAck>): SyncAck =>
  ({ clientEventUuid: 'u', result: 'ok', ...over }) as SyncAck;

describe('a refused scan stops being green', () => {
  it('takes back the codes the server refused, and only those', () => {
    expect(
      codesToUnmark([
        ack({ result: 'ok', scannedCode: 'A1' }),
        ack({ result: 'rejected', detail: 'batch_not_unloading', scannedCode: 'B2' }),
        ack({ result: 'unknown_code', scannedCode: 'C3' }),
        ack({ result: 'duplicate', scannedCode: 'D4' }),
        ack({ result: 'auto_transfer', scannedCode: 'E5' }),
      ]),
    ).toEqual(['B2', 'C3']);
  });

  it('leaves a not-on-plan scan alone — the operator is being asked, not refused', () => {
    expect(codesToUnmark([ack({ result: 'not_on_plan', scannedCode: 'F6' })])).toEqual([]);
  });

  it('a whole truck refused at once comes back as a whole truck', () => {
    const acks = Array.from({ length: 150 }, (_unused, i) =>
      ack({ result: 'rejected', detail: 'batch_not_unloading', scannedCode: `X${i}` }),
    );
    expect(codesToUnmark(acks)).toHaveLength(150);
  });

  it('an ack with no code cannot unmark anything, and says nothing rather than guessing', () => {
    expect(codesToUnmark([ack({ result: 'rejected' })])).toEqual([]);
  });
});

describe('the server names the code on every refusal', () => {
  // The predicate above is worth nothing if the acks arrive anonymous — which
  // is exactly how they used to arrive. Source-shape, because the refusals
  // are inside one transaction per input and a behavioural test would have to
  // stand a whole truck up to reach the last of them.
  const source = readFileSync('src/modules/wms/scanning/unload.ts', 'utf8');

  it('every rejected / unknown_code return carries scannedCode', () => {
    const returns = source.split(/return\s*\{/).slice(1);
    const refusals = returns.filter((body) => {
      const head = body.slice(0, body.indexOf('};') + 1);
      return /result:\s*'(rejected|unknown_code)'/.test(head);
    });
    expect(refusals.length, 'the refusals are still where this test thinks').toBeGreaterThan(4);
    for (const body of refusals) {
      const head = body.slice(0, body.indexOf('};') + 1);
      expect(head, `a refusal with no code: ${head.slice(0, 120)}`).toContain('scannedCode');
    }
  });
});
