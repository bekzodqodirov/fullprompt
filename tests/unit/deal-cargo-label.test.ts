import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dealCargoLabel, dealOptionLabel } from '@/modules/wms/deals/cargo-label';

/**
 * A deal code with its cargo beside it (owner, 2026-09-14).
 *
 * Two things are being pinned. The COMPOSER: which of the deal's two cargo
 * figures is printed, and that the estimated one is always marked. And the
 * WIRING: that all three pickers read the one composer — three hand-written
 * copies of one label is exactly what produced the report, since the mirror
 * picker has carried its cargo since #583 and these three never learned.
 */

const base = {
  receiptCount: 0,
  volumeM3: 0,
  weightKg: 0,
  quotedVolumeM3: null,
  quotedWeightKg: null,
  goods: null,
  goodsExtra: 0,
};

describe('dealCargoLabel', () => {
  it('prints the ARRIVED figures unmarked once a prixod exists', () => {
    expect(
      dealCargoLabel({
        ...base,
        receiptCount: 1,
        volumeM3: 5,
        weightKg: 200,
        quotedVolumeM3: 4,
        quotedWeightKg: 180,
        goods: 'oyinchoq',
      }),
    ).toBe('5.00 m³ · 200.0 kg · oyinchoq');
  });

  it('falls back to the QUOTE, and says so with ≈, while nothing has arrived', () => {
    const label = dealCargoLabel({
      ...base,
      quotedVolumeM3: 4,
      quotedWeightKg: 180,
      goods: 'oyinchoq',
    });
    expect(label).toBe('≈ 4.00 m³ · 180.0 kg · oyinchoq');
  });

  it('marks the WHOLE group, never one number', () => {
    // «≈ 4 m³ · 180 kg» must not read as a measured weight beside an
    // estimated cube: before a prixod exists every figure is the agreement.
    const label = dealCargoLabel({ ...base, quotedVolumeM3: 4, quotedWeightKg: 180 });
    expect(label.startsWith('≈ ')).toBe(true);
    expect(label.slice(2)).not.toContain('≈');
  });

  it('a prixod with no measured cargo still reads as the quote', () => {
    // A receipt exists but its lots carry no volume or weight — the arrived
    // branch would print «» and hide the deal the owner is trying to pick.
    expect(
      dealCargoLabel({ ...base, receiptCount: 1, quotedVolumeM3: 4, goods: 'sumka' }),
    ).toBe('≈ 4.00 m³ · sumka');
  });

  it('counts the other goods as +N', () => {
    expect(
      dealCargoLabel({ ...base, receiptCount: 1, volumeM3: 12, goods: 'oyinchoq', goodsExtra: 2 }),
    ).toBe('12.00 m³ · oyinchoq +2');
  });

  it('answers with nothing when the deal can say nothing', () => {
    expect(dealCargoLabel(base)).toBe('');
    expect(dealCargoLabel({ ...base, quotedVolumeM3: 0, quotedWeightKg: 0 })).toBe('');
  });
});

describe('dealOptionLabel', () => {
  it('leaves a bare code bare rather than printing empty brackets', () => {
    expect(dealOptionLabel({ code: 'B-000123', title: null, cargo: '' })).toBe('B-000123');
  });

  it('is the owner’s own shape', () => {
    expect(
      dealOptionLabel({ code: 'B-00123', title: null, cargo: '5.00 m³ · 200.0 kg · oyinchoq' }),
    ).toBe('B-00123 (5.00 m³ · 200.0 kg · oyinchoq)');
  });

  it('keeps the title where a deal has one', () => {
    expect(dealOptionLabel({ code: 'B-1', title: 'Yiwu', cargo: '2.00 m³' })).toBe(
      'B-1 — Yiwu (2.00 m³)',
    );
  });
});

/**
 * The wiring half. Behaviour cannot see this — a picker that hand-writes
 * `{deal.code}{deal.title}` renders perfectly well and simply says less.
 */
describe('every deal picker reads the one composer', () => {
  const PICKERS = [
    'src/app/(protected)/finance/[clientId]/tx-form.tsx',
    'src/app/(protected)/receipts/[id]/deal-link.tsx',
    'src/app/(protected)/receive/receive-wizard.tsx',
  ];

  it.each(PICKERS)('%s calls dealOptionLabel', (path) => {
    const src = readFileSync(path, 'utf8');
    // #494: prove the file still HAS a deal picker before judging its label.
    expect(src, `${path} no longer renders a deal <option>`).toMatch(/deal\.id/);
    // The CALL, not the import. The first version of this fence asserted the
    // bare name and stayed GREEN with the picker reverted to `{deal.code}` —
    // the word survived in the import line (#166: a red proof that will not
    // go red is evidence about the assertion).
    expect(src, `${path} imports the composer but does not call it`).toMatch(
      /\{dealOptionLabel\(deal\)\}/,
    );
  });

  it.each(PICKERS)('%s does not hand-write the code beside its title', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/\{deal\.code\}\s*\n\s*\{deal\.title/);
  });

  it('both list queries hang the cargo on, so no caller has to remember', () => {
    const src = readFileSync('src/modules/wms/deals/service.ts', 'utf8');
    const ledger = src.indexOf('export async function ledgerDealsForClient');
    const open = src.indexOf('export async function openDealsForClient');
    expect(ledger).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(-1);
    for (const [name, at] of [
      ['ledgerDealsForClient', ledger],
      ['openDealsForClient', open],
    ] as const) {
      const body = src.slice(at, at + 1400);
      expect(body, `${name} must return its rows through withCargo`).toContain('withCargo(rows)');
    }
  });
});
