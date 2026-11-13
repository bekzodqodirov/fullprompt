import { describe, expect, it } from 'vitest';
import { measureCandidates, type ChatMessage } from '@/modules/wms/agent/context';
import { parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { parseTableAnswer, type TableRef } from '@/modules/wms/calc/line-address';

/**
 * docs/AI-SORAYDI.md §3.1 T4 / T6 as sellers actually write the marks — the
 * review of release 1a as built (cluster «per-package marks and sizes»,
 * docs/AI-SORAYDI-REVIEW.md JN-7, JN-8, JN-11, JS-1, JS-2, JS-24 binding).
 * Each block names the finding it pins; every figure is worked by hand in the
 * comment beside it, never asked of the code (#166).
 */

/** The shipment's two totals as the typed reader states them. */
const totals = (text: string) => {
  const f = parseManualFacts(text, 'podklyuch');
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null };
};
const none = { kg: null, m3: null };

/** The one typed goods row a line gives. */
const row = (text: string) => {
  const goods = readGoodsLines(text);
  expect(goods, text).toHaveLength(1);
  return goods[0]!;
};

function msg(body: string): ChatMessage {
  return {
    ref: '#1',
    id: '00000000-0000-4000-8000-000000000001',
    tgMessageId: 1n,
    direction: 'in',
    body,
    media: null,
    fileName: null,
    sentAt: new Date('2026-11-12T10:00:00Z'),
    autoSent: false,
    editedAt: null,
  };
}
/** The AI sotuvchi's weight and cube references of ONE inbound message. */
const references = (body: string) => measureCandidates([msg(body)]).map(({ kind, value }) => ({ kind, value }));

describe('owner-1 — «1 ta karobka», «1 karobka = 15 kg», «1ctn=15kg» are ONE carton’s, beside another carton count', () => {
  it('the Uzbek counter «ta» after the «1»: 20 × 0.12 = 2.4 m³ on the row, no 0.12 m³ total', () => {
    // Was the shipment's 0.12 m³ under ✅ — one carton's cube pricing the road.
    // (The 300 kg is the one line's own, the shipment's as it always was.)
    expect(totals('Kurtka 300 dona, 300 kg, 20 ta karobka, 1 ta karobka 0.12 kub')).toEqual({ ...none, kg: 300 });
    expect(row('Kurtka 300 dona, 300 kg, 20 ta karobka, 1 ta karobka 0.12 kub')).toMatchObject({
      name: 'Kurtka',
      quantity: 300,
      weightKg: 300,
      volumeM3: 2.4,
    });
    // 20 × 15 = 300 kg.
    expect(totals('Kurtka 300 dona, 20 karobka, 1 ta karobka 15 kg')).toEqual(none);
    expect(row('Kurtka 300 dona, 20 karobka, 1 ta karobka 15 kg')).toMatchObject({ weightKg: 300 });
    expect(row('Kurtka 300 dona, 20 ta quti, 1 ta quti 15 kg')).toMatchObject({ name: 'Kurtka', weightKg: 300 });
  });

  it('«=» between the mark and its figure, Latin and Cyrillic, and the «=» leaves the name', () => {
    // 20 × 15 = 300 kg; 20 × 0.6 × 0.4 × 0.5 = 2.4 m³.
    expect(totals('Kurtka 300 dona, 20 karobka, 1 karobka = 15 kg, karobka o‘lchami 60x40x50 sm')).toEqual(none);
    expect(row('Kurtka 300 dona, 20 karobka, 1 karobka = 15 kg, karobka o‘lchami 60x40x50 sm')).toMatchObject({
      name: 'Kurtka',
      quantity: 300,
      weightKg: 300,
      volumeM3: 2.4,
    });
    expect(totals('Куртка 300 шт, 20 коробок, 1 коробка = 15 кг, размер коробки 60х40х50 см')).toEqual(none);
    expect(row('Куртка 300 шт, 20 коробок, 1 коробка = 15 кг, размер коробки 60х40х50 см')).toMatchObject({
      name: 'Куртка',
      weightKg: 300,
      volumeM3: 2.4,
    });
    // English: 20 × 0.12 = 2.4 m³; 20 × 15 = 300 kg.
    expect(row('Stul 40 pcs, 20 ctns, 1 ctn = 0.12 cbm')).toMatchObject({ name: 'Stul', quantity: 40, volumeM3: 2.4 });
    expect(row('Stul 40 pcs, 20 cartons, one carton = 15 kg')).toMatchObject({ name: 'Stul', weightKg: 300 });
  });

  it('a «1» welded to its noun: «1ctn=15kg», «1箱 15kg» — 20 × 15 = 300 kg', () => {
    expect(totals('Kurtka 300 dona, 20 ctns, 1ctn=15kg')).toEqual(none);
    expect(row('Kurtka 300 dona, 20 ctns, 1ctn=15kg')).toMatchObject({ name: 'Kurtka', weightKg: 300 });
    expect(row('折叠椅 200个 20箱 1箱 15kg')).toMatchObject({ name: '折叠椅', quantity: 200, weightKg: 300 });
  });

  it('ALONE the «1 ta karobka» is the count — one carton of 15 kg is the line’s 15 kg, as it always was', () => {
    expect(totals('Stul 1 ta karobka 15 kg')).toEqual({ ...none, kg: 15 });
    expect(totals('Stul 1 karobka 15 kg')).toEqual({ ...none, kg: 15 });
    // A word that only opens with the counter is no mark: «1 tabletka» is no package.
    expect(row('Tabletka 1 tabletka 0.5 kg 20 karobka')).toMatchObject({ weightKg: 0.5 });
  });

  it('as a totals answer it is one package’s figure — refused in the seller’s words, never «umumiy hajm 0.12»', () => {
    const table: TableRef = {
      rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] }],
      open: [{ totals: 'volumeM3' }],
      preferred: [{ totals: 'volumeM3' }],
      stage: 'review',
    };
    const [only] = parseTableAnswer('jami 20 ta karobka, 1 ta karobka 0.12 kub', table).segments;
    expect(only).toMatchObject({ totals: null, refused: { reason: 'totals_unit', left: [{ why: 'per_one', text: '1 ta karobka 0.12 kub' }] } });
  });

  it('the AI sotuvchi gets no reference from one carton’s figure (T16)', () => {
    expect(references('stul 20 ta karobka, 1 ta karobka 0.12 kub')).toEqual([]);
    expect(references('stul 20 karobka, 1 karobka = 0.12 kub')).toEqual([]);
    expect(references('stul 20 ctns, 1ctn=15kg')).toEqual([]);
    // The control the review ran: the bare form was already none.
    expect(references('stul 20 karobka, 1 karobka 0.12 kub')).toEqual([]);
  });
});
