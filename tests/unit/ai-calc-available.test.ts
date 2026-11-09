import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * «Will the AI VED pass have a model today?» (docs/IKKI-ESHIK.md §3.1): a key
 * AND budget left — the table's «AI hisoblashda topadi» is a promise only
 * while both hold. The day's count is a stand-in; the key is the real
 * `aiConfigured()` over the environment.
 */
const setting = vi.hoisted(() => ({ value: '0' as string | Error }));
vi.mock('@/modules/platform/settings/service', () => ({
  getSetting: async () => {
    if (setting.value instanceof Error) throw setting.value;
    return setting.value;
  },
}));

import { readFileSync } from 'node:fs';
import { aiCalcAvailable, aiCalcStanding } from '@/modules/wms/calc/ai-cost';

const saved = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
  setting.value = '0';
});

describe('aiCalcAvailable', () => {
  it('no key → no model, whatever the budget', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await aiCalcAvailable()).toBe(false);
  });

  it('a key and no cap (an unset limit is no limit) → the model', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    setting.value = '0';
    expect(await aiCalcAvailable()).toBe(true);
  });

  it('an unreadable ledger is not a spent budget', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    setting.value = new Error('settings unreadable');
    expect(await aiCalcAvailable()).toBe(true);
  });
});

describe('aiCalcStanding — the landing pass reads the same rule', () => {
  it('an unreadable ledger is budget left for the pass too', async () => {
    setting.value = new Error('settings unreadable');
    expect(await aiCalcStanding(true)).toEqual({ hasKey: true, budgetLeft: Number.POSITIVE_INFINITY });
  });

  it('no key → no budget asked', async () => {
    setting.value = new Error('must not be read');
    expect(await aiCalcStanding(false)).toEqual({ hasKey: false, budgetLeft: 0 });
  });

  it('prefill asks aiCalcStanding, never the ledger bare (review PF-SPEC-4)', () => {
    const src = readFileSync('src/modules/wms/calc/prefill.ts', 'utf8');
    expect(src).toContain('await aiCalcStanding(deps.configured)');
    expect(src).not.toMatch(/aiCalcBudgetLeft\(/);
  });
});
