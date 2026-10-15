import { beforeEach, describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { __resetLifecycle, isBacklog, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __resetBacklog, coalesceBacklogLabels } from '@/modules/platform/telegram/backlog';

/**
 * The backlog line and the labels sent into the outage (Q5 a). A person who
 * saw no answer presses again: five «📋 Bugun» typed while the bot was down
 * are one request, and so are five /start — but a label or a command sent
 * AFTER the bot came back is always served.
 */
const BOOT = 2_000_000_000;
const ctxOf = (chat: number, text: string, date: number) =>
  ({ chat: { id: chat }, message: { text, date } }) as unknown as Context;

beforeEach(() => {
  __resetLifecycle();
  __resetBacklog();
});

/** How many of these messages reached the next handler. */
async function served(messages: Context[]): Promise<number> {
  const mw = coalesceBacklogLabels();
  let n = 0;
  for (const ctx of messages) {
    await mw(ctx, async () => {
      n += 1;
    });
  }
  return n;
}

describe('isBacklog', () => {
  it('nothing is backlog before the boot is marked (a test, a script)', () => {
    expect(isBacklog(1)).toBe(false);
  });
  it('before the boot is backlog; at or after it is not', () => {
    markBoot(new Date(BOOT * 1000));
    expect(isBacklog(BOOT - 1)).toBe(true);
    expect(isBacklog(BOOT)).toBe(false);
    expect(isBacklog(BOOT + 1)).toBe(false);
  });
});

describe('coalesceBacklogLabels', () => {
  beforeEach(() => markBoot(new Date(BOOT * 1000)));
  const early = BOOT - 60;

  it('the same label twice from one chat in the backlog: served once', async () => {
    expect(await served([ctxOf(1, '📋 Bugun', early), ctxOf(1, '📋 Bugun', early + 1)])).toBe(1);
  });

  it('commands too — /start twice is one, /start ad_x twice is one, the two are two', async () => {
    expect(await served([ctxOf(2, '/start', early), ctxOf(2, '/start', early)])).toBe(1);
    expect(await served([ctxOf(3, '/start ad_x', early), ctxOf(3, '/start ad_x', early)])).toBe(1);
    expect(await served([ctxOf(4, '/start', early), ctxOf(4, '/start ad_x', early)])).toBe(2);
  });

  it('another chat is its own', async () => {
    expect(await served([ctxOf(5, '📋 Bugun', early), ctxOf(6, '📋 Bugun', early)])).toBe(2);
  });

  it('a label or command sent after the boot is always served', async () => {
    expect(await served([ctxOf(7, '📋 Bugun', BOOT + 1), ctxOf(7, '📋 Bugun', BOOT + 2), ctxOf(7, '/start', BOOT + 3), ctxOf(7, '/start', BOOT + 4)])).toBe(4);
  });

  it('an ordinary backlog text is never coalesced — the ladder judges it', async () => {
    expect(await served([ctxOf(8, 'GS777', early), ctxOf(8, 'GS777', early)])).toBe(2);
  });
});
