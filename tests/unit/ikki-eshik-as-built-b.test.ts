import { describe, expect, it } from 'vitest';
import { bodyOf, read } from '../fixtures/source-shape';
import { burstOwed, type BurstPayload } from '@/modules/platform/telegram/burst-wait';
import { materialSegments, type TableRef } from '@/modules/wms/calc/line-address';

/**
 * The as-built review's chat and burst fixes, the parts no handler test can
 * reach (docs/IKKI-ESHIK.md §1.4, §4.1): the boot asks for the bursts a dead
 * process owed BEFORE its first getUpdates, and only after both stores are
 * back in memory; `burstOwed` is the pure rule it asks; the material stage's
 * per-segment read places only what the whole-text rule placed.
 */

describe('the boot draws the owed bursts (as-built review BURST-8, DURABILITY-2)', () => {
  it('after both hydrates, before the first getUpdates, never a throw into the boot', () => {
    const boot = bodyOf(read('src/modules/platform/telegram/bot.ts'), 'export function startTelegramBot(');
    const hydrated = boot.indexOf('markIntakesHydrated();');
    const owed = boot.indexOf('drawOwedBursts(bot.api);');
    const polling = boot.indexOf('startPolling(30_000);', hydrated);
    expect(hydrated, 'the stores are marked hydrated').toBeGreaterThan(0);
    expect(owed, 'the owed bursts are drawn after the hydrate').toBeGreaterThan(hydrated);
    expect(polling, 'and before polling starts').toBeGreaterThan(owed);
    expect(boot.slice(hydrated, polling)).toMatch(/try \{\s*drawOwedBursts\(bot\.api\);\s*\} catch/u);
  });
});

describe('burstOwed (pure)', () => {
  const payload = (p: Partial<BurstPayload>): BurstPayload => ({
    id: 10,
    parts: [{ messageId: 10, forwarded: false, kind: 'photo', fileId: 'f', name: null, mime: null, size: null, text: null }],
    offerIds: [],
    aliasIds: [],
    open: true,
    taken: false,
    parkedNote: null,
    ...p,
  });
  const now = 1_000_000;
  it('a part no copy was drawn below, inside the window: owed', () => {
    expect(burstOwed({ payload: payload({}), expiresAt: now + 60 }, now)).toBe(true);
    expect(burstOwed({ payload: payload({ offerIds: [5] }), expiresAt: now + 60 }, now)).toBe(true);
  });
  it('drawn below its newest part, taken, empty, or past its window: not owed', () => {
    expect(burstOwed({ payload: payload({ offerIds: [11] }), expiresAt: now + 60 }, now)).toBe(false);
    expect(burstOwed({ payload: payload({ taken: true }), expiresAt: now + 60 }, now)).toBe(false);
    expect(burstOwed({ payload: payload({ parts: [] }), expiresAt: now + 60 }, now)).toBe(false);
    expect(burstOwed({ payload: payload({}), expiresAt: now }, now)).toBe(false);
  });
  it('an overflow part newer than the last copy is owed too', () => {
    expect(burstOwed({ payload: payload({ offerIds: [11], lastSeen: 12 }), expiresAt: now + 60 }, now)).toBe(true);
  });
});

describe('materialSegments places what the whole-text rule places (as-built review CHAT-2)', () => {
  const table: TableRef = {
    rows: [
      { no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] },
      { no: 2, index: 1, seq: null, name: 'Krossovka', needs: [] },
      { no: 3, index: 2, seq: null, name: 'Sumka', needs: [] },
    ],
    open: [],
    preferred: [],
    stage: 'material',
  };
  it('«3: 150 kg» is placed; «rahmat», «Sumka 80 kg», «1: Kurtka 300 dona» on row 2 are not', () => {
    const read = (text: string) => materialSegments(text, table).map((r) => [r.segment.raw, r.placed]);
    expect(read('3: 150 kg\nrahmat')).toEqual([
      ['3: 150 kg', true],
      ['rahmat', false],
    ]);
    expect(read('Sumka 80 kg')).toEqual([['Sumka 80 kg', false]]);
    expect(read('2: Kurtka 300 dona')).toEqual([['2: Kurtka 300 dona', false]]);
    expect(read('jami 3500 kg')).toEqual([['jami 3500 kg', true]]);
  });
});
