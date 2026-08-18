import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A reply the customer already has must reach the CRM thread whatever the
 * database does in between.
 *
 * The listener sends, then does TWO writes: `markSent` settles the queue row,
 * `recordSent` writes the thread's copy — and Telegram will not echo a
 * message sent on this same connection (round 53), so that second write is
 * the only record the reply has. The audit found the gap: when `markSent`
 * threw on a db blip, the catch returned before the echo block, and the
 * retry re-ran `markSent` ALONE — the outbox read «sent», the bubble
 * vanished, and the thread never got the message.
 *
 * Source-shape, because the failing ingredient is a database that dies
 * between two specific statements, and the file is a gramjs shell around
 * pure functions tested elsewhere. Three facts pin the order:
 */
describe('the send bookkeeping cannot lose the echo', () => {
  const source = readFileSync('scripts/tg-listen.ts', 'utf8');

  it('the echo is built BEFORE the first database write', () => {
    const echoBuilt = source.indexOf('const echo = result?.id');
    const firstWrite = source.indexOf('await markSent(job.id');
    expect(echoBuilt, 'the echo exists').toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(0);
    expect(echoBuilt, 'built before markSent can throw').toBeLessThan(firstWrite);
  });

  it('the unsettled fact CARRIES the echo', () => {
    expect(source).toMatch(/unsettled = \{ id: job\.id, tgMessageId, echo \}/);
  });

  it('the unsettled retry writes the echo too, not only the queue row', () => {
    const retry = source.slice(
      source.indexOf('if (unsettled) {'),
      source.indexOf('if (unrecorded) {'),
    );
    expect(retry, 'the retry block exists').toContain('markSent(unsettled.id');
    expect(retry, 'and hands the echo on').toContain('recordSent(');
  });
});
