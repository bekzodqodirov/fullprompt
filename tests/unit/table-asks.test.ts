import { describe, expect, it } from 'vitest';
import { applyPacking, emptyPacking, type Packing } from '@/modules/wms/calc/carton-math';
import { intakeTableText, tableAsksOf, type AskedQuestion, type CalcFacts, type CalcGoodsFact, type TableInput } from '@/modules/wms/calc/intake';
import { readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { nameWordFor, parseTableAnswer } from '@/modules/wms/calc/line-address';
import { answeredRow } from '@/modules/wms/calc/row-answer';
import { packingAsks, ROW_ASKS_MAX } from '@/modules/wms/calc/table-asks';

/**
 * What the table ASKS beyond a missing figure, and how it says what the bot
 * computed (docs/AI-SORAYDI.md §3.0 «the kernel's minimal draw»; review JB-6,
 * JS-7): pure, every literal by hand.
 */
const pack = (over: Partial<Packing>, from: Packing['from'] = 'ai'): Packing => ({ ...emptyPacking(from), ...over });
const box = { l: 60, w: 40, h: 50, unit: 'cm' as const, of: 'package' as const };
const read = (row: CalcGoodsFact): CalcGoodsFact => applyPacking(row).line;

function input(over: Partial<TableInput> & { facts: CalcFacts }): TableInput {
  return {
    section: 'rastamojka',
    laws: new Map(),
    clientLabel: null,
    fileCount: 0,
    ambiguous: [],
    amend: null,
    tail: '',
    nameWord: nameWordFor,
    ...over,
  };
}
const table = (over: Partial<TableInput> & { facts: CalcFacts }) => intakeTableText(input(over));
const totals = { weightKg: 300, volumeM3: 2.4 };

describe('a figure the BOT multiplied is marked, and the mark is explained once', () => {
  it('20 karobka × 60×40×50 sm × 15 kg: «2.4 m³*», «300 kg*» and one legend line', () => {
    // 20 × 0.12 = 2.4 m³; 20 × 15 = 300 kg (said netto, so no kind is asked).
    const row = read({ name: 'Stul', quantity: 40, packing: pack({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'net', size: box }) });
    const text = table({ facts: { ...totals, goods: [row] } });
    expect(text).toContain('✅ 1. Stul — 40 dona · 300 kg* · 2.4 m³*');
    expect(text).toContain('* — bot hisoblagan (karobka soni × bittasiniki).');
    expect(text.match(/bot hisoblagan/g)).toHaveLength(1);
    // Nothing is in doubt: the table is complete.
    expect(text).toContain('✅ Ma’lumot to‘liq');
  });

  // Check crit-2: a bare «A x B unit» is the line's own product (JN-8 (c),
  // binding) — and it was drawn «1. Stul — 300 kg» as if he had typed 300.
  it('a product the LINE wrote — «Stul 20 x 15 kg» — is marked «300 kg*» and said as written, not as cartons', () => {
    // 20 × 15 = 300 kg; 20 × 24 = 480 dona. No carton count: the legend says so.
    const [stul] = readGoodsLines('Stul 20 x 15 kg');
    const [kurtka] = readGoodsLines('Kurtka 20*24 dona');
    const text = table({ facts: { ...totals, goods: [stul!, kurtka!] } });
    expect(text).toContain('1. Stul — 300 kg*');
    expect(text).toContain('2. Kurtka — 480 dona*');
    expect(text).toContain('* — bot hisoblagan (yozilgan ko‘paytmadan).');
    // Beside a carton product both ways are said, in one line.
    const carton = read({ name: 'Shim', packing: pack({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'net' }) });
    const both = table({ facts: { ...totals, goods: [stul!, carton] } });
    expect(both).toContain('* — bot hisoblagan (karobka soni × bittasiniki, yoki yozilgan ko‘paytmadan).');
    // A later pass of the carton arithmetic keeps the mark, and a figure he changes loses it.
    expect(read(stul!)).toMatchObject({ weightKg: 300, derived: { product: { weightKg: { value: 300, how: '20 × 15 kg' } } } });
    expect(table({ facts: { ...totals, goods: [{ ...stul!, weightKg: 280 }] } })).not.toContain('*');
  });

  it('a row nobody computed carries no mark and the table no legend', () => {
    const text = table({ facts: { ...totals, goods: [{ name: 'Kurtka', quantity: 300, weightKg: 300 }] } });
    expect(text).toContain('✅ 1. Kurtka — 300 dona · 300 kg');
    expect(text).not.toContain('*');
    expect(text).not.toContain('hisoblagan');
  });

  it('a stated figure REPLACED by the product is said on its own line, with the way back', () => {
    // A FILE's row: 0.083 m³ in the row's volume, 30 cartons of 0.083 m³ each → 30 × 0.083 = 2.49.
    const row = read({ name: 'Sumka', quantity: 60, weightKg: 300, volumeM3: 0.083, packing: pack({ cartons: 30, m3PerCarton: 0.083 }, 'file') });
    expect(row.volumeM3).toBe(2.49);
    const text = table({ facts: { weightKg: 300, volumeM3: 2.49, goods: [row] } });
    expect(text).toContain('2.49 m³*');
    expect(text).toContain('♻️ 1-qator: hajm 0.083 m³ bitta karobkaniki ekan — 30 × 0.083 m³ = 2.49 m³ deb olindi. Noto‘g‘ri bo‘lsa yozing: «1: 0.083 m³».');
  });

  it('a size with no unit taken as centimetres is said — one line for all such rows', () => {
    const bare = { l: 60, w: 40, h: 50, unit: null, of: 'package' as const };
    const rows = [
      read({ name: 'Stul', quantity: 40, weightKg: 100, packing: pack({ cartons: 20, size: bare }) }),
      read({ name: 'Stol', quantity: 10, weightKg: 200, packing: pack({ cartons: 10, size: bare }) }),
    ];
    const text = table({ facts: { weightKg: 300, volumeM3: 3.6, goods: rows } });
    expect(text).toContain('📐 1–2-qator: o‘lcham birligi yozilmagan — sm deb olindi.');
  });

  it('a per-carton weight nobody called netto or brutto: ONE grouped line, never a question per row', () => {
    const rows = [
      read({ name: 'Stul', quantity: 40, volumeM3: 1, packing: pack({ cartons: 20, kgPerCarton: 15 }) }),
      read({ name: 'Stol', quantity: 10, volumeM3: 1, packing: pack({ cartons: 10, kgPerCarton: 30 }) }),
    ];
    const text = table({ facts: { weightKg: 600, volumeM3: 2, goods: rows } });
    expect(text).toContain('⚖️ 1–2-qator: karobka og‘irligi netto yoki brutto ekani yozilmagan — sof og‘irligi boshqa bo‘lsa yozing.');
    expect(text).not.toContain('↳ ❓');
    expect(text).toContain('✅ Ma’lumot to‘liq');
  });
});

describe('a doubt of the arithmetic is asked under its row and holds «to‘liq»', () => {
  // The model's own contradiction: 0.083 m³ on the row AND 0.083 m³ per carton × 30.
  const doubted = () => read({ name: 'Sumka', quantity: 60, weightKg: 300, volumeM3: 0.083, packing: pack({ cartons: 30, m3PerCarton: 0.083 }) });

  it('«bitta karobkanikimi yoki hammasinikimi?» — the row is ⚠️, the closing asks, the ✅ line is gone', () => {
    const text = table({ facts: { weightKg: 300, volumeM3: 2.49, goods: [doubted()] } });
    expect(text).toContain('⚠️ 1. Sumka — 60 dona · 300 kg · 0.083 m³');
    expect(text).toContain(
      '   ↳ ❓ 0.083 m³ — bitta karobkanikimi yoki hammasinikimi? Hammasiniki bo‘lsa «1: 0.083 m³», bittasiniki bo‘lsa «1: 2.49 m³» deb yozing.',
    );
    expect(text).not.toContain('Ma’lumot to‘liq');
    expect(text).toContain('❓ 1 ta savol javobsiz — javobini yozing.');
    // The example is the QUESTION's own — never «Yiwu → Toshkent» on a job whose route nobody asked (JB-6).
    expect(text).toContain('✍️ Javobni shunday yozing: «1: 2.49 m³».');
    expect(text).not.toContain('Yiwu');
    // A hold takes the LINE away, never the way out: the VED line still stands.
    expect(text).toContain('«✅ Tasdiqlash» ni hozir ham bosishingiz mumkin');
  });

  it('the answer the question TEACHES is read by the answer parser, and it closes the question', () => {
    const row = doubted();
    const facts = { weightKg: 300, volumeM3: 2.49, goods: [row] };
    const asks = tableAsksOf(input({ facts }));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ row: 1, holds: true, example: '1: 2.49 m³' });
    // Both taught forms parse as row 1's volume.
    for (const [typed, value] of [['1: 2.49 m³', 2.49], ['1: 0.083 m³', 0.083]] as const) {
      const rows = [{ no: 1, index: 0, seq: null, name: 'Sumka', needs: [] }];
      const parsed = parseTableAnswer(typed, { rows, open: [], preferred: [], stage: 'review' });
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]).toMatchObject({ at: { line: 1 }, answer: { kind: 'figures', figures: { volumeM3: value } } });
      const his = answeredRow({ ...row, volumeM3: value }, { volumeM3: value });
      const after = table({ facts: { ...facts, volumeM3: value, goods: [his] } });
      expect(after).not.toContain('↳ ❓');
      expect(after).toContain('✅ Ma’lumot to‘liq');
    }
  });

  it('a stated figure the cartons do not explain: both are named, with both ways to answer', () => {
    // 3 m³ typed, 20 × 0.12 = 2.4 from the size.
    const row = read({ name: 'Stul', quantity: 40, weightKg: 300, volumeM3: 3, packing: pack({ cartons: 20, size: box }, 'typed') });
    const text = table({ facts: { weightKg: 300, volumeM3: 3, goods: [row] } });
    expect(text).toContain(
      '   ↳ ❓ 3 m³ yozilgan, karobkalar bo‘yicha 2.4 m³ chiqadi (20 × 60×40×50 sm) — qaysi biri to‘g‘ri? Yozing: «1: 2.4 m³» yoki «1: 3 m³».',
    );
    expect(text).not.toContain('Ma’lumot to‘liq');
  });

  it('a missing figure beside a question keeps today’s words — the question is one more ↳ under its row', () => {
    const rows = [doubted(), { name: 'Shapka' }];
    const text = table({ facts: { weightKg: 300, volumeM3: 2.49, goods: rows } });
    expect(text).toContain('⚠️ 1 ta qatorda ma’lumot yetishmayapti.');
    expect(text).toContain('↳ ❓ 0.083 m³');
    expect(text).toContain('✍️ Bir xabarda istalgan qatorni to‘ldiring: «2: 30 dona»');
  });

  it('a size with no unit the bot can trust computes NOTHING, is asked, and holds «to‘liq» until the row has its cube (JN-3)', () => {
    const noUnit = { l: 600, w: 400, h: 500, unit: null, of: 'package' as const }; // 600 is no centimetre carton
    const row = read({ name: 'Stanok', quantity: 2, weightKg: 300, packing: pack({ cartons: 2, size: noUnit }) });
    expect(row.volumeM3 ?? null).toBeNull();
    const text = table({ facts: { weightKg: 300, volumeM3: 1, goods: [row] } });
    expect(text).toContain('⚠️ 1. Stanok — 2 dona · 300 kg');
    expect(text).toContain('   ↳ ❓ o‘lcham 600×400×500 — birligi yozilmagan (sm? mm?), hajm hisoblanmadi. Qator hajmini yozing: «1: … m³».');
    expect(text).not.toContain('Ma’lumot to‘liq');
    // 600 × 400 × 500 mm = 0.12 m³ a carton × 2 = 0.24 — typed by the seller.
    const his = answeredRow({ ...row, volumeM3: 0.24 }, { volumeM3: 0.24 });
    const after = table({ facts: { weightKg: 300, volumeM3: 1, goods: [his] } });
    expect(after).not.toContain('↳ ❓');
    expect(after).toContain('✅ Ma’lumot to‘liq');
  });

  it('a size beside a carton count that NOBODY said is the carton’s: asked whose it is, never multiplied (PR-12)', () => {
    const unowned = { l: 60, w: 40, h: 50, unit: 'cm' as const, of: null };
    const row = read({ name: 'Stol', quantity: 10, weightKg: 300, packing: pack({ cartons: 10, size: unowned }) });
    expect(row.volumeM3 ?? null).toBeNull();
    const text = table({ facts: { weightKg: 300, volumeM3: 1, goods: [row] } });
    expect(text).toContain('   ↳ ❓ o‘lcham 60×40×50 sm — karobkanikimi yoki tovarning o‘zinikimi, yozilmagan; hajm hisoblanmadi. Qator hajmini yozing: «1: … m³».');
    expect(text).not.toContain('Ma’lumot to‘liq');
  });

  it(`at most ${ROW_ASKS_MAX} questions stand under one row`, () => {
    const many: CalcGoodsFact = { name: 'X', quantity: 7, weightKg: 9, volumeM3: 3, measureUnit: 'm2', measureQty: 5, packing: pack({ cartons: 20, pcsPerCarton: 2, kgPerCarton: 15, kgPerCartonKind: 'net', size: box }, 'typed') };
    const asks = packingAsks([{ no: 1, index: 0 }], [many]);
    expect(asks.length).toBeLessThanOrEqual(ROW_ASKS_MAX);
    expect(asks.length).toBeGreaterThanOrEqual(2);
  });

  it('the plain «🧮» summary asks NOTHING (docs/IKKI-ESHIK.md §2.1): no ❓, and the marks stay', () => {
    const text = table({ plain: true, facts: { weightKg: 300, volumeM3: 2.49, goods: [doubted()] }, aiQuestions: [{ about: null, kind: 'what_goods', text: 'Nima tovar?' }] });
    expect(text).not.toContain('❓');
    expect(text).not.toContain('AI so‘raydi');
    expect(tableAsksOf(input({ plain: true, facts: { goods: [doubted()] } }))).toEqual([]);
  });
});

describe('a name the model gave a PICTURE is its guess', () => {
  it('the row is marked 📷 and the mark is explained once', () => {
    const rows: CalcGoodsFact[] = [
      { name: 'Stul ofis uchun', nameFrom: 'photo', quantity: 20, weightKg: 100 },
      { name: 'Kurtka', quantity: 300, weightKg: 200 },
    ];
    const text = table({ facts: { ...totals, goods: rows } });
    expect(text).toContain('✅ 1. 📷 Stul ofis uchun — 20 dona · 100 kg');
    expect(text).toContain('✅ 2. Kurtka — 300 dona · 200 kg');
    expect(text).toContain('📷 — nomi rasmdan olingan (AI taxmini): noto‘g‘ri bo‘lsa to‘g‘risini «➕ Yana ma’lumot» bilan yozing.');
  });
});

describe('the model’s questions stand above the closing, each by its good’s NAME', () => {
  const goods: CalcGoodsFact[] = [{ name: 'Stul ofis uchun', quantity: 20, weightKg: 100 }];
  const asked: AskedQuestion[] = [
    { about: 'Stul ofis uchun', kind: 'material', text: 'Nimadan — plastikmi, metallmi?' },
    { about: null, kind: 'other', text: 'Yuk qaysi shahardan?' },
  ];

  it('a block «🤖 AI so‘raydi» with how to answer; a «material» question does not hold «to‘liq»', () => {
    const text = table({ facts: { ...totals, goods }, aiQuestions: asked });
    const block = [
      '🤖 AI so‘raydi:',
      '❓ «Stul ofis uchun»: Nimadan — plastikmi, metallmi?',
      '❓ Yuk qaysi shahardan?',
      'Javobini «➕ Yana ma’lumot» bilan yozib yuboring — AI qayta o‘qiydi.',
      '',
      '✅ Ma’lumot to‘liq. Tasdiqlaysizmi?',
    ].join('\n');
    expect(text).toContain(block);
    // No row number of the model's survives: the name is the address.
    expect(text).not.toMatch(/❓ \d+-qator/);
  });

  it('«what are these goods?» HOLDS the «to‘liq» line', () => {
    const text = table({ facts: { ...totals, goods }, aiQuestions: [{ about: null, kind: 'what_goods', text: 'Yopiq karobkalarda nima bor?' }] });
    expect(text).toContain('❓ Yopiq karobkalarda nima bor?');
    expect(text).not.toContain('Ma’lumot to‘liq');
    expect(text).toContain('❓ 1 ta savol javobsiz — javobini yozing.');
    expect(text).toContain('«✅ Tasdiqlash» ni hozir ham bosishingiz mumkin');
  });

  it('on the AI door the block stands in the table’s LAST block, above its closing', () => {
    const text = table({ facts: { ...totals, goods: [{ ...goods[0]!, tnvedCode: '9401310000', tnvedSource: 'row' }] }, aiQuestions: asked, ai: { available: true, last: [] } });
    const at = text.indexOf('🤖 AI so‘raydi:');
    expect(at).toBeGreaterThan(text.indexOf('Umumiy:'));
    expect(text.indexOf('✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, AI hisoblaydi.')).toBeGreaterThan(at);
  });

  it('collecting again (the marker) the table asks nothing — «Bo‘ldi» re-reads everything', () => {
    const text = table({ facts: { ...totals, goods }, aiQuestions: asked, ai: { available: true, last: [] }, marker: '⬇️ Yangi ma’lumot qo‘shildi' });
    expect(text).not.toContain('AI so‘raydi');
  });

  it('a package’s own ask (`TableInput.asks`) is drawn by the same place: under its row, or above the closing', () => {
    const text = table({
      facts: { ...totals, goods },
      asks: [
        { id: 'x:1', row: 1, text: 'artikul «XJ-200» — bu nima tovar?', holds: true, example: '1: stul' },
        { id: 'x:2', row: null, text: 'Rasmdagi tovar ro‘yxatda yo‘q — qo‘shilsinmi?', holds: false },
        { id: 'x:3', row: 9, text: 'bu qator jadvalda yo‘q', holds: false },
      ],
    });
    expect(text).toContain('⚠️ 1. Stul ofis uchun — 20 dona · 100 kg\n   ↳ ❓ artikul «XJ-200» — bu nima tovar?');
    expect(text).toContain('❓ Rasmdagi tovar ro‘yxatda yo‘q — qo‘shilsinmi?\n❓ bu qator jadvalda yo‘q');
    expect(text).toContain('✍️ Javobni shunday yozing: «1: stul».');
    expect(text).not.toContain('Ma’lumot to‘liq');
  });
});
