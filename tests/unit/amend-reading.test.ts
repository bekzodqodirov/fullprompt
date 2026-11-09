import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';

/**
 * The add collection's reading (docs/SAKKIZ-R3.md §9.4): what `analyzeCollected`
 * does with a top-up's material when the request's rows are KEPT — an add
 * collection's stored rows, or a returned request's seeded ones. The model is a
 * script; the question is what the collector makes of its answer, and what the
 * model is told about the rows already on the request.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));

import { analyzeCollected, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { seedRestatedNote } from '@/modules/platform/telegram/calc-intake';
import { knownGoodsText, KNOWN_GOODS_CHARS } from '@/modules/wms/calc/intake-ai';
import type { AmendBase, AmendBaseItem } from '@/modules/wms/calc/amend-types';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const item = (seq: number, over: Partial<AmendBaseItem> = {}): AmendBaseItem => ({
  itemId: id(seq),
  seq,
  name: `Tovar ${seq}`,
  quantity: null,
  weightKg: null,
  volumeM3: null,
  measureUnit: null,
  measureQty: null,
  tnvedCode: null,
  law: null,
  confirmed: false,
  ...over,
});

const base = (items: AmendBaseItem[]): AmendBase => ({
  requestId: id(99),
  cardLabel: 'B-000067',
  entityType: 'deal',
  entityId: id(98),
  leadOpen: null,
  section: 'rastamojka',
  clientLabel: 'GS777',
  openedRev: 0,
  items,
  weightKg: null,
  volumeM3: null,
  fromCity: null,
  toCity: null,
});

let seq = 0;
const chats: bigint[] = [];
function collection(opts: { amend?: AmendBase; seed?: Goods }, patch: Partial<IntakeState> = {}): IntakeState {
  seq += 1;
  const chatId = BigInt(-9_300_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { ai: true, staffId: 'staff-test', amend: opts.amend ?? null });
  const goods = opts.amend
    ? opts.amend.items.map((i) => ({ name: i.name, quantity: i.quantity, weightKg: i.weightKg, itemId: i.itemId, seq: i.seq }))
    : (opts.seed ?? []);
  return updateIntake(chatId, {
    stage: 'material',
    clientHintRaw: 'GS777',
    material: ['packing list B'],
    fileCount: 1,
    pdfs: [{ attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 4 }],
    facts: { goods, lineWeightsStated: true },
    ...(opts.seed ? { seed: opts.seed } : {}),
    ...patch,
  })!;
}

const reads = (goods: Goods) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => model.analyze.mockReset());
afterEach(() => {
  for (const chat of chats.splice(0)) endIntake(chat);
});

describe('the model is told the request’s rows — and to bring a stored good back WITH ITS OWN figures (adv-2)', () => {
  it('the block names the rows and asks for a restated good’s figures, so the conflict reaches the VED', async () => {
    model.analyze.mockResolvedValueOnce(reads([line('Kurtka', { quantity: 200 })]));
    const state = collection({ amend: base([item(1, { name: 'Kurtka', quantity: 300 })]) });
    const out = await analyzeCollected(state);
    expect(model.analyze.mock.calls[0]![0].requestGoods).toEqual(['Kurtka']);
    const block = knownGoodsText(['Kurtka'], KNOWN_GOODS_CHARS, 'request');
    // A model that obeys «НЕ повторяй» alone never returns factory B's 200,
    // and the three-way question is never asked.
    expect(block).toContain('укажи его в goods с этими цифрами из материала');
    // …and the line it brings back is the row's conflict, never a second row — never ASKED
    // since his 1a (docs/IKKI-ESHIK.md §1.1): the stored 300 stands, the file's 200 is the VED's
    // (it pinned `choice: null`, the question open).
    expect(out.conflicts).toEqual([
      { itemId: id(1), seq: 1, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: 'ved' },
    ]);
    expect(out.facts.goods?.filter((g) => !g.itemId)).toEqual([]);
  });
});

describe('a read line goes through the door before it is compared (spec-3)', () => {
  it('«CTN 50» against a 300-piece row is no piece conflict; «120 m2» against the pair is the pair', async () => {
    model.analyze.mockResolvedValueOnce(
      reads([line('Sumka', { quantity: 50, unit: 'karobka' }), line('Kafel', { quantity: 120, unit: 'm2' })]),
    );
    const state = collection({
      amend: base([item(1, { name: 'Sumka', quantity: 300 }), item(2, { name: 'Kafel', measureUnit: 'm2', measureQty: 120 })]),
    });
    const out = await analyzeCollected(state);
    expect(out.conflicts).toEqual([]);
  });
});

describe('a SEEDED collection (a returned request’s re-send) names a row read again with another figure (spec-2)', () => {
  it('«Sumka — 500 dona» against the seeded 300 → the row kept, the 500 named; never a silent 300', async () => {
    model.analyze.mockResolvedValueOnce(reads([line('Sumka', { quantity: 500 })]));
    const seed = [line('Sumka', { quantity: 300 })];
    const out = await analyzeCollected(collection({ seed }));
    expect(out.facts.goods).toEqual([line('Sumka', { quantity: 300 })]);
    expect(out.notes[0]).toBe(
      '⚠️ 1 ta qator so‘rovdagi bilan bir xil, lekin boshqa son bilan o‘qildi — so‘rovdagi qoldi: «Sumka» (faylda 500 dona). Fayldagi to‘g‘ri bo‘lsa, shu qatorga javob yozing.',
    );
    // The same figures read again are the row and say nothing.
    model.analyze.mockResolvedValueOnce(reads([line('Sumka', { quantity: 300 })]));
    const same = await analyzeCollected(collection({ seed }));
    expect(same.notes.some((n) => n.includes('so‘rovdagi qoldi'))).toBe(false);
  });

  it('the note’s words, capped at three names', () => {
    expect(seedRestatedNote([])).toBeNull();
    const four = ['A', 'B', 'C', 'D'].map((name) => ({ name, figures: [{ read: 2, unit: 'm3' }] }));
    expect(seedRestatedNote(four)).toBe(
      '⚠️ 4 ta qator so‘rovdagi bilan bir xil, lekin boshqa son bilan o‘qildi — so‘rovdagi qoldi: «A» (faylda 2 m³), «B» (faylda 2 m³), «C» (faylda 2 m³) va yana 1 ta. Fayldagi to‘g‘ri bo‘lsa, shu qatorga javob yozing.',
    );
  });
});
