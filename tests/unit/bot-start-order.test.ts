import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * «A failed hydrate never starts polling early» (docs/SAKKIZ-R3.md §6.2.10,
 * regression-20, durability-11) — `startTelegramBot` itself, with grammy's
 * `Bot` stood in for so nothing polls Telegram: the waits' restore REJECTS at
 * once, the collections' restore resolves 200 ms later, and the first
 * `getUpdates` (grammy's `start`) must come after BOTH, the store marked
 * hydrated first, the rejection a log line and never an unhandled one.
 *
 * Here and not in bot-redelivery.integration (§6.3 names that file): this
 * needs grammy's `Bot` replaced, and that file's harness runs the real one.
 */
const seen = vi.hoisted(() => ({ order: [] as string[], intakesDone: 0, started: 0 }));

vi.mock('grammy', async (original) => {
  const real = await original<typeof import('grammy')>();
  class FakeBot {
    api = { config: { use: () => undefined } };
    constructor() {
      // Every registration (`use`, `on`, `command`, `callbackQuery`, `catch`…)
      // is accepted and chains; only `start` is observed.
      const proxy: unknown = new Proxy(this, {
        get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : () => proxy),
      });
      return proxy as FakeBot;
    }
    start() {
      seen.order.push('start');
      seen.started = Date.now();
      return new Promise(() => {});
    }
    isRunning() {
      return false;
    }
  }
  return { ...real, Bot: FakeBot };
});
vi.mock('@/modules/platform/telegram/waits', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/waits')>()),
  hydrateWaits: vi.fn(async () => {
    seen.order.push('waits rejected');
    throw new Error('waits table unreadable');
  }),
}));
vi.mock('@/modules/platform/telegram/calc-store', async (original) => {
  const real = await original<typeof import('@/modules/platform/telegram/calc-store')>();
  return {
    ...real,
    hydrateIntakes: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      seen.order.push('intakes restored');
      seen.intakesDone = Date.now();
      return 0;
    }),
    markIntakesHydrated: vi.fn(() => {
      seen.order.push('hydrated');
      real.markIntakesHydrated();
    }),
  };
});
vi.mock('@/modules/platform/telegram/lifecycle', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/lifecycle')>()),
  // No signal handlers on the test worker.
  installBotShutdown: vi.fn(),
}));
vi.mock('@/modules/platform/telegram/commands', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/commands')>()),
  ensureBotProfile: vi.fn(async () => {}),
}));

import { startTelegramBot } from '@/modules/platform/telegram/bot';
import { logger } from '@/modules/platform/logger';
import { setDurableIntakes } from '@/modules/platform/telegram/calc-store';
import { setDurableWaits } from '@/modules/platform/telegram/waits';

let savedToken: string | undefined;
let savedPolling: string | undefined;
beforeAll(() => {
  savedToken = process.env.TELEGRAM_BOT_TOKEN;
  savedPolling = process.env.TELEGRAM_POLLING;
  process.env.TELEGRAM_BOT_TOKEN = '7000003:START';
  delete process.env.TELEGRAM_POLLING;
});
afterAll(() => {
  setDurableWaits(false);
  setDurableIntakes(false);
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  if (savedPolling !== undefined) process.env.TELEGRAM_POLLING = savedPolling;
});

describe('the start waits for BOTH restores (regression-20, durability-11)', () => {
  it('the waits’ restore rejects, the collections’ resolves later: polling starts after both, the store marked first', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      startTelegramBot();
      await vi.waitFor(() => expect(seen.order).toContain('start'), { timeout: 3_000 });
      expect(seen.order).toEqual(['waits rejected', 'intakes restored', 'hydrated', 'start']);
      expect(seen.started).toBeGreaterThanOrEqual(seen.intakesDone);
      // The rejection is a log line — an unhandled one would fail this file.
      expect(warn.mock.calls.some((c) => c[1] === 'telegram waits not restored')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
