import { describe, expect, it } from 'vitest';
import { membershipSettled, serialMembership } from '@/modules/platform/telegram/price-channel-handlers';

/**
 * The price channel's membership updates, in update order (Q5 a): the
 * backlog arrives in a burst now, and «joined» then «left» run out of order
 * leave a live row for somebody who left. Still off the poller — and drained
 * by the stop.
 */
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('serialMembership', () => {
  it('finishes in submission order even when the first is the slower one', async () => {
    const done: string[] = [];
    serialMembership(async () => {
      await tick(40);
      done.push('joined');
    });
    serialMembership(async () => {
      await tick(1);
      done.push('left');
    });
    await membershipSettled();
    expect(done).toEqual(['joined', 'left']);
  });

  it('a throwing update does not stop the next one', async () => {
    const done: string[] = [];
    serialMembership(async () => {
      throw new Error('telegram said no');
    });
    serialMembership(async () => {
      done.push('next');
    });
    await membershipSettled();
    expect(done).toEqual(['next']);
  });

  it('membershipSettled resolves only after everything queued so far', async () => {
    let finished = 0;
    for (let i = 0; i < 3; i += 1) {
      serialMembership(async () => {
        await tick(5);
        finished += 1;
      });
    }
    await membershipSettled();
    expect(finished).toBe(3);
  });
});
