import { afterEach, describe, expect, it } from 'vitest';
import { endIntake, migrateIntakeState, startIntake } from '@/modules/platform/telegram/calc-store';
import type { IntakeState } from '@/modules/platform/telegram/calc-intake';

/**
 * The two collection fields Ikki eshik's file rule writes (docs/IKKI-ESHIK.md
 * §1.2.5): `fileTotals` (what a packing list GAVE) and `fileNotes` (what the
 * bot decided about a file when it arrived). Inert in kernel K — nothing
 * reads them yet — but a collection is durable for 24 hours, so one opened
 * before the deploy is hydrated WITHOUT them and must read null / [], never
 * undefined, through the one function the hydrate runs (`migrateIntakeState`).
 */
const chat = BigInt(-7_700_000_001);
afterEach(() => endIntake(chat));

describe('a new collection', () => {
  it('opens with no file totals and no file notes', () => {
    const state = startIntake(chat, 'rastamojka', { staffId: 'staff-1' });
    expect(state.fileTotals).toBeNull();
    expect(state.fileNotes).toEqual([]);
  });
});

describe('a row hydrated from before the fields existed', () => {
  it('reads null and [] — and a stored value always wins', () => {
    const fresh = startIntake(chat, 'rastamojka', { staffId: 'staff-1' });
    const old = { ...fresh } as Partial<IntakeState>;
    delete old.fileTotals;
    delete old.fileNotes;
    const migrated = migrateIntakeState(old as IntakeState);
    expect(migrated.fileTotals).toBeNull();
    expect(migrated.fileNotes).toEqual([]);
    // Nothing else is touched.
    expect({ ...migrated, fileTotals: undefined, fileNotes: undefined }).toEqual({
      ...fresh,
      fileTotals: undefined,
      fileNotes: undefined,
    });

    const kept = {
      weightKg: 3500,
      volumeM3: 28,
      weightNetto: false,
      label: 'packing.xlsx',
      at: { material: 1, files: 2 },
    };
    const stored = migrateIntakeState({ ...fresh, fileTotals: kept, fileNotes: ['📄 «packing.xlsx» — o‘sha tovarlar'] });
    expect(stored.fileTotals).toEqual(kept);
    expect(stored.fileNotes).toEqual(['📄 «packing.xlsx» — o‘sha tovarlar']);
  });
});
