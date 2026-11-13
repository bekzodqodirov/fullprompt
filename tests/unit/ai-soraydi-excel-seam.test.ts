import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «AI so‘raydi», package P-excel, phase 4 — the SEAM between two files
 * (docs/AI-SORAYDI.md §3.2 X4). A row's packing survived one file end to end
 * (tests/integration/ai-soraydi-excel-seam.integration.test.ts); traced
 * further, it did NOT survive the commonest pair a Chinese factory sends —
 * an invoice of names, counts and money, and a packing list «CTNS | CTN SIZE |
 * G.W./CTN» of the same goods. The list was judged «o‘sha tovarlar», its
 * totals read, and its cartons and sizes — every factor of the cube — thrown
 * away with its rows: the cube was asked though both files had stated it.
 *
 * Now the packing list's row hands its PACKAGES to the goods row it met
 * (`packingCarries`, by the very meeting that made it a packing list of
 * these goods), and the kernel computes the goods row's figures from them —
 * whichever file came first, on a further sheet of one workbook, and from a
 * duplicate row of a second invoice. A brutto never becomes a goods row's
 * netto on the way (docs/IKKI-ESHIK.md §1.2.2): only a per-carton NETTO is
 * carried as a weight.
 *
 * The door end to end over real workbooks — the file door (`readIntakeFile`),
 * the reading (`analyzeCollected`, the model answering NOTHING), the table,
 * the landed notes.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => true,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { intakeNextStep } from '@/modules/platform/telegram/calc-dialog';
import { readIntakeFile } from '@/modules/platform/telegram/calc-files';
import { activeIntake, analyzeCollected, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { carriedPacking, packingCarries, positionalCarries } from '@/modules/platform/telegram/file-goods';
import { emptyPacking, type Packing } from '@/modules/wms/calc/carton-math';
import { factsVolumeM3, landingItems, type CalcGoodsFact, type CalcSection } from '@/modules/wms/calc/intake';
import { nameWordFor } from '@/modules/wms/calc/line-address';
import { resetReadingDrive } from '../fixtures/calc-read-drive';
import * as B from '../fixtures/fayl-books';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
let seq = 0;
const chats: bigint[] = [];

beforeAll(async () => {
  await import('@/modules/wms/calc/intake-manual');
  markIntakesHydrated();
});
beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
  model.analyze.mockImplementation(async () => ({ ok: true, facts: { goods: [], weightKg: null, volumeM3: null }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] }));
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

type R = (string | number | null)[];
const book = (header: (string | null)[], rows: R[]) => B.sheetsBook([['Sheet1', header, rows]]);

/** Files sent to a fresh AI-door collection, read, and the table drawn — as the bot does it. */
async function collect(section: CalcSection, files: [body: Buffer, name: string][]) {
  seq += 1;
  const chatId = BigInt(-9_476_500_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-as-seam', ai: true });
  updateIntake(chatId, { stage: 'material' });
  const said: string[] = [];
  for (const [body, name] of files) {
    const live = activeIntake(chatId)!;
    const answer = await readIntakeFile({ isPhoto: false, body, attachmentId: `as-seam-${seq}-${name}` }, name, B.XLSX, live);
    updateIntake(chatId, { ...answer.patch, fileCount: live.fileCount + 1 });
    said.push(answer.say ?? '');
  }
  const read = await analyzeCollected(activeIntake(chatId)!);
  updateIntake(chatId, { ...read, answered: undefined } as never);
  const state = activeIntake(chatId)!;
  const intake = await import('@/modules/wms/calc/intake');
  const table = intakeNextStep(state, new Map(), intake, { nameWord: nameWordFor, aiAvailable: true });
  return {
    said,
    state,
    goods: state.facts.goods ?? [],
    cube: factsVolumeM3(state.facts as never),
    notes: landingItems(state.facts as never).map((item) => item.note),
    table: table.text,
  };
}

const INVOICE = () =>
  book(['Description', 'QTY', 'Unit price (USD)', 'Amount (USD)'], [
    ['Office chair', 40, 10, 400],
    ['Desk', 10, 50, 500],
  ]);
const LIST = () =>
  book(['Description', 'QTY', 'CTNS', 'CTN SIZE (CM)', 'G.W./CTN (KG)'], [
    ['Office chair', 40, 20, '60*40*50', 15],
    ['Desk', 10, 10, '120*60*20', 30],
  ]);
/** By hand: 0.6 × 0.4 × 0.5 = 0.12 m³ × 20 = 2.4; 1.2 × 0.6 × 0.2 = 0.144 m³ × 10 = 1.44 — Σ 3.84 m³. */
const CUBES = [2.4, 1.44];
const rowOf = (table: string, name: string) => table.split('\n').find((l) => l.includes(name)) ?? '';

describe('an invoice and its packing list: the list’s packages reach the invoice’s rows', () => {
  it('the invoice first: each row’s cube computed from the list’s cartons and size, marked, said, and landed with its arithmetic', async () => {
    const got = await collect('podklyuch', [
      [await INVOICE(), 'ci.xlsx'],
      [await LIST(), 'pl.xlsx'],
    ]);
    // The goods are the invoice's: its names, its counts, its money.
    expect(got.goods.map((g) => [g.name, g.quantity, g.amount ?? null])).toEqual([
      ['Office chair', 40, 400],
      ['Desk', 10, 500],
    ]);
    expect(got.goods.map((g) => g.volumeM3)).toEqual(CUBES);
    // 2.4 + 1.44 = 3.84 m³ — stated in no cell of either file.
    expect(got.cube).toBe(3.84);
    expect(rowOf(got.table, 'Office chair')).toContain('2.4 m³*');
    expect(rowOf(got.table, 'Desk')).toContain('1.44 m³*');
    expect(got.table).toContain('* — bot hisoblagan');
    expect(got.table).toContain('✅ Hajm: 3.84 m³');
    // The receipt says what the list gave its rows — beside its totals sentence.
    expect(got.said[1]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
    expect(got.notes).toEqual([
      '📦 20 karobka · 60×40×50 sm — fayldan · hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³',
      '📦 10 karobka · 120×60×20 sm — fayldan · hajm hisoblangan: 10 × 120×60×20 sm = 1.44 m³',
    ]);
  });

  it('…and the list’s cartons’ GROSS is never an invoice row’s netto (docs/IKKI-ESHIK.md §1.2.2): the weight is still asked', async () => {
    const got = await collect('podklyuch', [
      [await INVOICE(), 'ci.xlsx'],
      [await LIST(), 'pl.xlsx'],
    ]);
    // 20 × 15 = 300 kg and 10 × 30 = 300 kg are BRUTTO: not written, not carried.
    expect(got.goods.map((g) => g.weightKg ?? null)).toEqual([null, null]);
    expect(got.goods.map((g) => g.packing?.kgPerCarton ?? null)).toEqual([null, null]);
    expect(got.table).not.toMatch(/\b300 kg\b/);
  });

  it('the list first, then the invoice: the same rows, the same cubes — the invoice takes the goods role AND the packages', async () => {
    const got = await collect('podklyuch', [
      [await LIST(), 'pl.xlsx'],
      [await INVOICE(), 'ci.xlsx'],
    ]);
    expect(got.goods.map((g) => [g.name, g.quantity, g.amount ?? null, g.volumeM3, g.weightKg ?? null])).toEqual([
      ['Office chair', 40, 400, 2.4, null],
      ['Desk', 10, 500, 1.44, null],
    ]);
    expect(got.cube).toBe(3.84);
    expect(got.said[1]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
  });

  it('a per-carton NETTO travels as a weight: 20 × 12 kg = 240 kg, the bot’s figure, marked — never «filled»', async () => {
    const got = await collect('rastamojka', [
      [await INVOICE(), 'ci.xlsx'],
      [await book(['Description', 'QTY', 'CTNS', 'N.W./CTN (KG)'], [['Office chair', 40, 20, 12], ['Desk', 10, 10, 25]]), 'pl.xlsx'],
    ]);
    // 20 × 12 = 240 kg; 10 × 25 = 250 kg — both netto.
    expect(got.goods.map((g) => [g.weightKg, g.derived?.weightKg ?? null])).toEqual([
      [240, '20 × 12 kg'],
      [250, '10 × 25 kg'],
    ]);
    expect(rowOf(got.table, 'Office chair')).toContain('240 kg*');
    // The netto fill did not claim them: a computed weight is the bot's, not the list's line.
    expect(got.said[1]).not.toContain('netto og‘irlik shu fayldan yozildi');
    expect(got.said[1]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
  });

  it('a netto the list’s LINE states is the file’s figure: filled, unmarked — and the packages agree with it', async () => {
    const got = await collect('rastamojka', [
      [await INVOICE(), 'ci.xlsx'],
      [await book(['Description', 'QTY', 'CTNS', 'N.W.(KG)', 'N.W./CTN (KG)'], [['Office chair', 40, 20, 240, 12], ['Desk', 10, 10, 250, 25]]), 'pl.xlsx'],
    ]);
    // 240 and 250 stand on the list's lines; 20 × 12 = 240 and 10 × 25 = 250 agree, so nothing is the bot's.
    expect(got.goods.map((g) => [g.weightKg, g.derived?.weightKg ?? null])).toEqual([
      [240, null],
      [250, null],
    ]);
    expect(rowOf(got.table, 'Office chair')).not.toContain('kg*');
    expect(got.said[1]).toContain('2 ta qatorga netto og‘irlik shu fayldan yozildi');
    expect(got.said[1]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
  });

  it('…and a list whose line disagrees with its own packages is ASKED, never settled by either', async () => {
    const got = await collect('rastamojka', [
      [await INVOICE(), 'ci.xlsx'],
      [await book(['Description', 'QTY', 'CTNS', 'N.W.(KG)', 'N.W./CTN (KG)'], [['Office chair', 40, 20, 260, 12], ['Desk', 10, 10, 250, 25]]), 'pl.xlsx'],
    ]);
    // The line says 260 kg, the packages 20 × 12 = 240: the line's 260 stands and the table asks.
    expect(got.goods[0]!.weightKg).toBe(260);
    expect(got.table).toContain('260 kg yozilgan, karobkalar bo‘yicha 240 kg chiqadi (20 × 12 kg) — qaysi biri to‘g‘ri?');
  });
});

describe('the packages go to the row the list NAMES, never to the first row with the same count (review excel-break-1)', () => {
  const TWINS = () =>
    book(['Description', 'QTY', 'Unit price (USD)', 'Amount (USD)'], [
      ['Office chair', 40, 10, 400],
      ['Desk', 40, 50, 2000],
    ]);
  const listOf = (desk: string, chair: string) =>
    book(['Description', 'QTY', 'CTNS', 'CTN SIZE (CM)', 'N.W./CTN (KG)'], [
      [desk, 40, 40, '120*60*10', 20],
      [chair, 40, 20, '60*40*50', 6],
    ]);

  it('two rows of 40 and a list sorted the other way: each row takes ITS packages, by name', async () => {
    const got = await collect('podklyuch', [
      [await TWINS(), 'ci.xlsx'],
      [await listOf('Desk', 'Office chair'), 'pl.xlsx'],
    ]);
    // By hand: the chair 20 × 0.6 × 0.4 × 0.5 = 20 × 0.12 = 2.4 m³ and 20 × 6 = 120 kg; the desk
    // 40 × 1.2 × 0.6 × 0.1 = 40 × 0.072 = 2.88 m³ and 40 × 20 = 800 kg.
    expect(got.goods.map((g) => [g.name, g.packing?.cartons ?? null, g.volumeM3, g.weightKg])).toEqual([
      ['Office chair', 20, 2.4, 120],
      ['Desk', 40, 2.88, 800],
    ]);
    expect(rowOf(got.table, 'Office chair')).toContain('2.4 m³*');
    expect(rowOf(got.table, 'Desk')).toContain('2.88 m³*');
    expect(got.said[1]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
  });

  it('…the same list in Chinese, where no name meets: the count names neither row — nothing carried, said, the cubes asked', async () => {
    const got = await collect('podklyuch', [
      [await TWINS(), 'ci.xlsx'],
      [await listOf('桌子', '办公椅'), 'pl.xlsx'],
    ]);
    expect(got.goods.map((g) => [g.name, g.packing ?? null, g.volumeM3 ?? null, g.weightKg ?? null])).toEqual([
      ['Office chair', null, null, null],
      ['Desk', null, null, null],
    ]);
    expect(got.said[1]).toContain('2 ta qatorniki olinmadi: nomi mos kelmadi, soni boshqa qatorniki bilan bir xil — qaysi qatorniki ekani aniq emas.');
    expect(got.said[1]).not.toContain('qatorga karobka ma’lumoti shu fayldan olindi');
    expect(got.table).not.toContain('m³*');
  });

  it('…while a Chinese list whose counts are each the only one of their value still carries: 40 and 10 name their rows', async () => {
    const got = await collect('podklyuch', [
      [await INVOICE(), 'ci.xlsx'],
      [await book(['Description', 'QTY', 'CTNS', 'CTN SIZE (CM)', 'G.W./CTN (KG)'], [['办公椅', 40, 20, '60*40*50', 15], ['桌子', 10, 10, '120*60*20', 30]]), 'pl.xlsx'],
    ]);
    expect(got.goods.map((g) => g.volumeM3)).toEqual(CUBES);
    expect(got.said[1]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
  });
});

describe('the goods row’s own weight KIND travels with the packages (review excel-break-2, JN-4)', () => {
  it('a G.W. invoice beside an N.W./CTN list: 264 kg brutto over 20 × 12 = 240 kg netto is a row, not a question', async () => {
    const got = await collect('rastamojka', [
      [await book(['Description', 'QTY', 'G.W.(KG)', 'Amount (USD)'], [['Office chair', 40, 264, 400], ['Desk', 10, 275, 500]]), 'ci.xlsx'],
      [await book(['Description', 'QTY', 'CTNS', 'N.W./CTN (KG)'], [['Office chair', 40, 20, 12], ['Desk', 10, 10, 25]]), 'pl.xlsx'],
    ]);
    // By hand: 20 × 12 = 240, and 264 is 10 % over it; 10 × 25 = 250, and 275 is 10 % over it — within
    // the 25 % a gross row may stand over its cartons' netto.
    expect(got.goods.map((g) => [g.weightKg, g.weightKind ?? null, g.packing?.kgPerCarton ?? null])).toEqual([
      [264, 'gross', 12],
      [275, 'gross', 25],
    ]);
    expect(got.table).not.toContain('qaysi biri to‘g‘ri?');
    expect(got.said[1]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
  });
});

describe('the kernel judges the invoice’s own figure against the carried packages, as any file’s', () => {
  const invoiceWith = (cbm: number) =>
    book(['Description', 'QTY', 'CBM', 'Amount (USD)'], [
      ['Office chair', 40, cbm, 400],
      ['Desk', 10, 1.44, 500],
    ]);

  it('the invoice’s 2.4 agrees: it stands, no «*» on it', async () => {
    const got = await collect('podklyuch', [
      [await invoiceWith(2.4), 'ci.xlsx'],
      [await LIST(), 'pl.xlsx'],
    ]);
    expect(got.goods.map((g) => [g.volumeM3, g.derived?.volumeM3 ?? null])).toEqual([
      [2.4, null],
      [1.44, null],
    ]);
    expect(rowOf(got.table, 'Office chair')).not.toContain('m³*');
  });

  it('the invoice’s 0.12 is ONE carton’s: replaced by 20 × 0.12 = 2.4, and the table says so on its «♻️» line', async () => {
    const got = await collect('podklyuch', [
      [await invoiceWith(0.12), 'ci.xlsx'],
      [await LIST(), 'pl.xlsx'],
    ]);
    expect(got.goods[0]).toMatchObject({ volumeM3: 2.4, derived: { replaced: { volumeM3: 0.12 } } });
    expect(got.table).toContain('♻️ 1-qator: hajm 0.12 m³ bitta karobkaniki ekan — 20 × 60×40×50 sm = 2.4 m³ deb olindi.');
  });

  it('the invoice’s 3 differs from the cartons’ 2.4: it stands, and the table asks which', async () => {
    const got = await collect('podklyuch', [
      [await invoiceWith(3), 'ci.xlsx'],
      [await LIST(), 'pl.xlsx'],
    ]);
    expect(got.goods[0]!.volumeM3).toBe(3);
    expect(got.table).toContain('3 m³ yozilgan, karobkalar bo‘yicha 2.4 m³ chiqadi (20 × 60×40×50 sm) — qaysi biri to‘g‘ri?');
    expect(got.table).not.toContain('✅ Ma’lumot to‘liq');
  });

  it('a row that states packages of its OWN keeps them: two packings are never merged here', async () => {
    const got = await collect('podklyuch', [
      [await book(['Description', 'QTY', 'CTNS', 'Amount (USD)'], [['Office chair', 40, 25, 400], ['Desk', 10, null, 500]]), 'ci.xlsx'],
      [await LIST(), 'pl.xlsx'],
    ]);
    // The chair's own 25 cartons stand (no size of its own: no cube); the desk had none and takes the list's.
    expect(got.goods.map((g) => [g.packing?.cartons ?? null, g.volumeM3 ?? null])).toEqual([
      [25, null],
      [10, 1.44],
    ]);
  });
});

describe('one workbook: an «Invoice» sheet and a «Packing» sheet of the same goods (a further sheet, §4.2)', () => {
  it('the packing sheet’s packages reach the invoice sheet’s rows, as a second file’s would', async () => {
    const body = await B.sheetsBook([
      ['Invoice', ['Description', 'QTY', 'Unit price (USD)', 'Amount (USD)'], [['Office chair', 40, 10, 400], ['Desk', 10, 50, 500]]],
      ['Packing', ['Description', 'QTY', 'CTNS', 'CTN SIZE (CM)', 'G.W./CTN (KG)'], [['Office chair', 40, 20, '60*40*50', 15], ['Desk', 10, 10, '120*60*20', 30]]],
    ]);
    const got = await collect('podklyuch', [[body, 'CI-PL.xlsx']]);
    expect(got.goods.map((g) => [g.name, g.quantity, g.volumeM3, g.weightKg ?? null])).toEqual([
      ['Office chair', 40, 2.4, null],
      ['Desk', 10, 1.44, null],
    ]);
    expect(got.cube).toBe(3.84);
    expect(got.said[0]).toContain('«Packing» varag‘i');
    expect(got.said[0]).toContain('2 ta qatorga karobka ma’lumoti shu fayldan olindi.');
  });
});

describe('a duplicate row of a second invoice carries its packages too (foldInvoice)', () => {
  it('«Office chair 40» twice — once bare, once with «CTNS | CTN SIZE»: one row, its cube computed', async () => {
    const got = await collect('podklyuch', [
      [await book(['Description', 'QTY', 'Amount (USD)'], [['Office chair', 40, 400]]), 'a.xlsx'],
      [await book(['Description', 'QTY', 'CTNS', 'CTN SIZE (CM)', 'Amount (USD)'], [['Office chair', 40, 20, '60*40*50', 400]]), 'b.xlsx'],
    ]);
    expect(got.goods.map((g) => [g.name, g.quantity, g.volumeM3])).toEqual([['Office chair', 40, 2.4]]);
  });
});

describe('carriedPacking / packingCarries — the rules, pure', () => {
  const pk = (over: Partial<Packing>): Packing => ({ ...emptyPacking('file'), ...over });
  const row = (over: Partial<CalcGoodsFact>): CalcGoodsFact => ({ name: 'Office chair', quantity: 40, weightKg: null, volumeM3: null, ...over });

  it('a gross or unsaid per-carton weight is left behind with its source; a netto travels', () => {
    const gross = carriedPacking(pk({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross', fromOf: { kgPerCarton: 'file', cartons: 'file' } }));
    expect(gross).toMatchObject({ cartons: 20, kgPerCarton: null, kgPerCartonKind: null, fromOf: { cartons: 'file' } });
    expect(gross?.fromOf && 'kgPerCarton' in gross.fromOf).toBe(false);
    expect(carriedPacking(pk({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: null }))?.kgPerCarton).toBeNull();
    expect(carriedPacking(pk({ cartons: 20, kgPerCarton: 12, kgPerCartonKind: 'net' }))).toMatchObject({ kgPerCarton: 12, kgPerCartonKind: 'net' });
    // A packing that was ONLY a brutto carries nothing at all.
    expect(carriedPacking(pk({ kgPerCarton: 15, kgPerCartonKind: 'gross' }))).toBeNull();
    expect(carriedPacking(null)).toBeNull();
  });

  it('no kernel handed in — a caller from before — carries nothing, the rows as they were', () => {
    const held = [row({})];
    const list = [row({ packing: pk({ cartons: 20 }) })];
    expect(packingCarries(held, [null], list, null)).toEqual({ goods: held, carried: 0, unplaced: 0 });
    expect(positionalCarries(held, list)).toEqual({ goods: held, carried: 0, unplaced: 0 });
  });

  it('the packages go onto the row the list’s row MET, through the kernel handed in', () => {
    const seen: CalcGoodsFact[] = [];
    const repack = (r: CalcGoodsFact) => {
      seen.push(r);
      return { ...r, note: 'repacked' };
    };
    const held = [row({ name: 'Desk', quantity: 10 }), row({})];
    const list = [row({ packing: pk({ cartons: 20 }) })];
    const out = packingCarries(held, [null, null], list, null, repack);
    expect(out.carried).toBe(1);
    expect(out.goods.map((g) => [g.name, g.note ?? null])).toEqual([
      ['Desk', null],
      ['Office chair', 'repacked'],
    ]);
    expect(seen.map((r) => r.packing?.cartons)).toEqual([20]);
  });

  it('by position, never across two counts that disagree', () => {
    const repack = (r: CalcGoodsFact) => r;
    const list = [row({ name: '椅子', quantity: 40, packing: pk({ cartons: 20 }) }), row({ name: '桌子', quantity: 11, packing: pk({ cartons: 10 }) })];
    const out = positionalCarries([row({}), row({ name: 'Desk', quantity: 10 })], list, repack);
    expect([out.carried, out.goods.map((g) => g.packing?.cartons ?? null)]).toEqual([1, [20, null]]);
  });
});
