import { describe, expect, it } from 'vitest';
import {
  intakeTableText,
  NAME_ROWS_TRIED,
  tableOpenOf,
  tableRowsOf,
  type CalcFacts,
  type CalcSection,
  type TableAmend,
  type TableInput,
} from '@/modules/wms/calc/intake';
import { parseLineAnswer, parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { nameWordFor, parseTableAnswer } from '@/modules/wms/calc/line-address';
import { needLawOf, type NeedLaw } from '@/modules/wms/calc/needs';

/**
 * The table the seller reads after a reading and after every answer (his
 * 1.10 c, docs/SAKKIZ-R3.md §2.1) — pure, every literal by hand. It replaced
 * the summary, so what the summary's tests asserted is asserted here too
 * (§11: the weight's name, the summed cube, a total written two ways).
 */
const noLaws: ReadonlyMap<string, NeedLaw> = new Map();
const KROSSOVKA = needLawOf({ dutyMode: 'max', dutyUnit: 'juft', dutySpecific: 3, dutyFree: false });
const FUTBOLKA = needLawOf({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: 2, dutyFree: false });

function table(over: Partial<TableInput> & { facts: CalcFacts }): string {
  return intakeTableText({
    section: 'rastamojka',
    laws: noLaws,
    clientLabel: null,
    fileCount: 0,
    ambiguous: [],
    amend: null,
    tail: '',
    nameWord: nameWordFor,
    ...over,
  });
}

describe('the §2.1 table', () => {
  it('the example, literally', () => {
    const text = table({
      clientLabel: 'GS777 · Ali aka',
      fileCount: 2,
      laws: new Map([['6403990000', KROSSOVKA]]),
      facts: {
        volumeM3: 12,
        goods: [
          { name: 'Kurtka qishki', quantity: 300, weightKg: 150, tnvedCode: '6201400000' },
          { name: 'Krossovka', weightKg: 12.5, tnvedCode: '6403990000' },
          { name: 'Sumka', quantity: 50, weightKg: 20 },
          { name: 'Shapka' },
        ],
      },
    });
    // The cube is STATED here: a Σ from the lines would print each line's m³
    // on its row, which §2.1's example does not (the «qatorlardan» row is
    // its own case below) — and a stated cube is `volumeText`'s «kub».
    expect(text).toBe(
      [
        '🛃 Rastamojka',
        'Mijoz: GS777 · Ali aka',
        'Fayllar: 2',
        '',
        'Tovarlar (4):',
        '✅ 1. Kurtka qishki — 300 dona · 150 kg · 6201400000',
        '⚠️ 2. Krossovka — 12.5 kg · 6403990000',
        '   ↳ juft soni — boj kamida $3/juft',
        '✅ 3. Sumka — 50 dona · 20 kg',
        '⚠️ 4. Shapka',
        '   ↳ soni (dona) yoki sof og‘irligi (kg)',
        '',
        'Umumiy:',
        '⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan',
        '✅ Hajm: 12 kub',
        '',
        '⚠️ 2 ta qatorda va umumiyda ma’lumot yetishmayapti.',
        '✍️ Bir xabarda istalgan qatorni to‘ldiring: «2: 40 juft», «Shapka 30 dona» yoki «jami 3500 kg».',
        'Bir nechta bo‘lsa — har birini alohida satrga yozing (yoki «;» bilan).',
        'Bilmagan qatoringizni VED to‘ldiradi — «✅ Tasdiqlash» ni hozir ham bosishingiz mumkin.',
      ].join('\n'),
    );
  });

  it('a freight-only section draws its lines unmarked, with no ↳', () => {
    const text = table({
      section: 'yolkira',
      facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 3500, volumeM3: 12, goods: [{ name: 'Kurtka', quantity: 300 }, { name: 'Shim' }] },
    });
    expect(text).toContain('· 1. Kurtka — 300 dona');
    expect(text).toContain('· 2. Shim');
    expect(text).not.toContain('↳');
    expect(text).toContain('✅ Yo‘nalish: Yiwu → Toshkent');
    expect(text).toContain('✅ Ma’lumot to‘liq. Tasdiqlaysizmi?');
  });

  it('the closing line’s three forms, each with the «VED to‘ldiradi» line; and «to‘liq» when nothing is missing', () => {
    const vedLine = 'Bilmagan qatoringizni VED to‘ldiradi — «✅ Tasdiqlash» ni hozir ham bosishingiz mumkin.';
    const rows = table({ facts: { weightKg: 3500, volumeM3: 12, goods: [{ name: 'Kurtka' }, { name: 'Shim', quantity: 5 }] } });
    expect(rows).toContain('⚠️ 1 ta qatorda ma’lumot yetishmayapti.');
    expect(rows).toContain(vedLine);
    const totals = table({ facts: { volumeM3: 12, goods: [{ name: 'Kurtka', quantity: 3 }, { name: 'Shim', quantity: 5 }] } });
    expect(totals).toContain('⚠️ Umumiyda ma’lumot yetishmayapti.');
    expect(totals).toContain(vedLine);
    const both = table({ facts: { goods: [{ name: 'Kurtka' }, { name: 'Shim', quantity: 5 }] } });
    expect(both).toContain('⚠️ 1 ta qatorda va umumiyda ma’lumot yetishmayapti.');
    expect(both).toContain(vedLine);
    const full = table({ facts: { weightKg: 3500, volumeM3: 12, goods: [{ name: 'Kurtka', quantity: 3 }, { name: 'Shim', quantity: 5 }] } });
    expect(full).toContain('✅ Ma’lumot to‘liq. Tasdiqlaysizmi?');
    expect(full).not.toContain(vedLine);
  });

  it('no goods: the «tovar nomi» row and the «➕ Yana ma’lumot» closing, never a count line', () => {
    const text = table({ facts: { weightKg: 3500, volumeM3: 12 } });
    expect(text).toContain('Tovarlar (0):\n⚠️ tovar nomi — yozilmagan');
    expect(text).toContain('⚠️ Tovar nomi yozilmagan — tovarlarni «➕ Yana ma’lumot» bilan yuboring.');
    expect(text).not.toContain('✍️');
  });

  it('the examples are built from THIS table: the first ⚠️ row’s number and unit, a name, the total it owes', () => {
    const text = table({
      laws: new Map([['6110200000', FUTBOLKA]]),
      facts: {
        weightKg: 3500,
        goods: [
          { name: 'Sumka', quantity: 50 },
          { name: 'Futbolka erkaklar', weightKg: 40, tnvedCode: '6110200000' },
          { name: 'Kafel', measureUnit: 'm2', measureQty: 0 },
        ],
      },
    });
    expect(text).toContain('✍️ Bir xabarda istalgan qatorni to‘ldiring: «2: 30 dona», «Kafel 30 dona» yoki «jami 12 kub».');
  });

  it('a name that opens with a figure lends the example its first WORD — «100 30 dona» reads as row 100 (review adv-20)', () => {
    const text = table({ facts: { weightKg: 3500, volumeM3: 12, goods: [{ name: 'Sumka', quantity: 2 }, { name: '100% paxta futbolka' }] } });
    expect(text).toContain('✍️ Bir xabarda istalgan qatorni to‘ldiring: «2: 30 dona» yoki «paxta 30 dona».');
    // …and the example, typed back, is that row's answer.
    const input = { section: 'rastamojka' as const, facts: { weightKg: 3500, volumeM3: 12, goods: [{ name: 'Sumka', quantity: 2 }, { name: '100% paxta futbolka' }] }, laws: noLaws, amend: null };
    const ref = { rows: tableRowsOf(input), open: tableOpenOf(input), preferred: tableOpenOf(input), stage: 'review' as const };
    expect(parseTableAnswer('paxta 30 dona', ref).segments[0]!.at).toEqual({ line: 2 });
  });

  it('two rows sharing a first word: the example names one of them alone, and the parser lands it there (review PF-4)', () => {
    const facts: CalcFacts = {
      weightKg: 3500,
      volumeM3: 12,
      goods: [
        { name: 'Kurtka qishki erkaklar', weightKg: 40, tnvedCode: '6110200000' },
        { name: 'Kurtka qishki ayollar', weightKg: 30, tnvedCode: '6110200000' },
      ],
    };
    const laws = new Map([['6110200000', FUTBOLKA]]);
    const text = table({ laws, facts });
    const example = /«(\p{L}[^»]*?) 30 dona»/u.exec(text)?.[1];
    expect(example, 'a name example is taught').toBeDefined();
    const input = { section: 'rastamojka' as const, facts, laws, amend: null };
    const ref = { rows: tableRowsOf(input), open: tableOpenOf(input), preferred: tableOpenOf(input), stage: 'review' as const };
    const seg = parseTableAnswer(`${example} 30 dona`, ref).segments[0]!;
    expect(seg.refused).toBeNull();
    expect(seg.at).toEqual({ line: 2 });
  });

  it('two rows of ONE name: no name example at all, the numbered one only (review PF-4)', () => {
    const facts: CalcFacts = { weightKg: 3500, volumeM3: 12, goods: [{ name: 'Kurtka' }, { name: 'Kurtka' }] };
    const text = table({ facts });
    expect(text).toContain('✍️ Bir xabarda istalgan qatorni to‘ldiring: «1: 30 dona».');
  });

  it('a row that states nothing reads «soni (dona) yoki sof og‘irligi (kg)» — lineNeedText’s own words (product-fit-19 c)', () => {
    const text = table({ facts: { goods: [{ name: 'Shapka' }, { name: 'Sumka', quantity: 2 }] } });
    expect(text).toContain('⚠️ 1. Shapka\n   ↳ soni (dona) yoki sof og‘irligi (kg)');
  });
});

describe('the weight row', () => {
  // Re-anchored from intake-weight-basis.test.ts (R2's PF-1/PF-3, `weightLabel`,
  // re-check p3-1): the table says WHICH weight the seller confirms.
  const weightOf = (section: CalcSection, text: string) => table({ section, facts: parseManualFacts(text, section) });

  it('«(brutto)» on a freight section, «(netto)» on a netto customs total, plain otherwise', () => {
    expect(weightOf('podklyuch', 'Kurtka 300 dona\nJami 3500 kg 12 kub')).toContain('✅ Og‘irlik (brutto): 3500 kg');
    expect(weightOf('rastamojka', 'Kurtka 300 dona\nNetto 1200 kg')).toContain('✅ Og‘irlik (netto): 1200 kg');
    const plain = weightOf('rastamojka', 'Kurtka 300 dona\nJami 1200 kg');
    expect(plain).toContain('✅ Og‘irlik: 1200 kg');
    expect(plain).not.toContain('Og‘irlik (');
  });

  it('a total ANSWERED one way and stated another: «ikki xil yozilgan (pastda)», then the doubt (re-check p3-7)', () => {
    const text = table({
      section: 'yolkira',
      facts: { fromCity: 'Yiwu', toCity: 'Toshkent', volumeM3: 12, weightKg: null },
      ambiguous: [{ field: 'weightKg', answered: 3500, stated: 4200 }],
    });
    expect(text).toContain('⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — ikki xil yozilgan (pastda)');
    expect(text).not.toContain('qadoq bilan) — yozilmagan');
    expect(text).toContain(
      '⚠️ Siz 3500 kg deb javob bergansiz, keyin yuborilgan ma’lumotda 4200 kg — qaysi biri? Aniq yozing: «4200 kg» yoki «3500 kg».',
    );
  });

  it('a cube summed from the lines says so — `volumeText`’s own words (re-check p3-18)', () => {
    const text = table({
      section: 'yolkira',
      facts: {
        fromCity: 'Yiwu',
        toCity: 'Toshkent',
        weightKg: 3500,
        goods: [
          { name: 'Kurtka', quantity: 300, volumeM3: 5 },
          { name: 'Shim', quantity: 200, volumeM3: 7 },
        ],
      },
    });
    expect(text).toContain('✅ Hajm: 12 m³ (qatorlardan)');
  });
});

describe('a rastamojka job with no brutto (regression-22)', () => {
  const facts: CalcFacts = { volumeM3: 12, goods: [{ name: 'Kurtka', quantity: 300, weightKg: 150 }] };
  const input = { section: 'rastamojka' as const, facts, laws: noLaws, amend: null };

  it('the brutto row is ⚠️ — `missingFields` minus the line fields, on every section', () => {
    expect(table({ facts })).toContain('⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    expect(tableOpenOf(input)).toEqual([{ totals: 'weightKg' }]);
  });

  it('…and a bare «3500» goes to it as kg', () => {
    const ref = { rows: tableRowsOf(input), open: tableOpenOf(input), preferred: tableOpenOf(input), stage: 'review' as const };
    const seg = parseTableAnswer('3500', ref).segments[0]!;
    expect(seg.at).toEqual({ totals: 'weightKg' });
    expect(seg.totals?.weightKg).toBe(3500);
  });
});

describe('an add collection’s table (§2.1, §2.4)', () => {
  const amend = (over: Partial<TableAmend> = {}): TableAmend => ({
    cardLabel: 'B-00123',
    storedCount: 3,
    totalsStale: [],
    conflicts: [],
    askedSeqs: null,
    ...over,
  });
  // Stored rows keep their seq (a VED deletion left a gap at 2); the new line is max(seq) + 1.
  const facts: CalcFacts = {
    weightKg: 3500,
    volumeM3: 12,
    goods: [
      { name: 'Kurtka', quantity: 300, seq: 1, itemId: 'i1' },
      { name: 'Krossovka', weightKg: 20, seq: 3, itemId: 'i3' },
      { name: 'Shim', quantity: 200, seq: 4, itemId: 'i4' },
      { name: 'Sumka', quantity: 50 },
    ],
  };

  it('numbers stored rows by seq, gaps kept, and the new line after them', () => {
    expect(tableRowsOf({ section: 'rastamojka', facts, laws: noLaws }).map((r) => r.no)).toEqual([1, 3, 4, 5]);
    const text = table({ facts, amend: amend() });
    expect(text).toContain('➕ Qo‘shimcha · B-00123 · 🛃 Rastamojka');
    expect(text).toContain('So‘rovdagi qatorlar (3):');
    expect(text).toContain('✅ 3. Krossovka — 20 kg');
    expect(text).toContain('✅ 🆕 5. Sumka — 50 dona');
  });

  it('a conflict row is ⚠️ with its ↳; an empty-field conflict says «yozilsinmi»', () => {
    const text = table({
      facts,
      amend: amend({
        conflicts: [
          { itemId: 'i4', seq: 4, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: null },
          { itemId: 'i1', seq: 1, field: 'weightKg', unit: 'kg', stored: null, read: 120, choice: null },
        ],
      }),
    });
    expect(text).toContain('⚠️ 4. Shim — 200 dona\n   ↳ faylda 200 dona, so‘rovda 300 — qo‘shilsinmi (500), o‘rniga (200) yoki VED hal qilsinmi?');
    expect(text).toContain('⚠️ 1. Kurtka — 300 dona\n   ↳ faylda 120 kg, so‘rovda og‘irlik yo‘q — yozilsinmi yoki VED hal qilsinmi?');
    expect(text).toContain('⚠️ 2 ta qatorda ma’lumot yetishmayapti.');
  });

  it('an answered conflict is ✅ again', () => {
    const text = table({
      facts,
      amend: amend({ conflicts: [{ itemId: 'i4', seq: 4, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: 'add' }] }),
    });
    expect(text).toContain('✅ 4. Shim — 200 dona');
    expect(text).not.toContain('↳');
  });

  it('a stale brutto row asks to update it', () => {
    const text = table({ facts, amend: amend({ totalsStale: ['weightKg'] }) });
    expect(text).toContain('⚠️ umumiy brutto og‘irligi (kg) — yangi tovar qo‘shildi, yangilansinmi? «jami … kg»');
    expect(text).toContain('⚠️ Umumiyda ma’lumot yetishmayapti.');
    expect(text).toContain('«✅ Qo‘shish» ni hozir ham bosishingiz mumkin.');
  });

  it('a started job confirms «📨 VED ga yuborish»', () => {
    expect(table({ facts, amend: amend({ started: true, totalsStale: ['weightKg'] }) })).toContain('«📨 VED ga yuborish» ni hozir ham');
  });

  it('only a conflict open, the brutto ✅: the example is that conflict’s answer, never «jami 3500 kg» (review adv-20)', () => {
    const text = table({
      facts,
      amend: amend({ conflicts: [{ itemId: 'i4', seq: 4, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: null }] }),
    });
    expect(text).toContain('✍️ Yetishmaganini yozing: «4: 200 dona». Yangi tovar yoki fayl — «➕ Yana ma’lumot».');
    expect(text).not.toContain('jami 3500 kg');
  });
});

describe('over Telegram’s 4096 (§2.1, product-fit-10)', () => {
  const MAX = 4096;
  const long = (i: number) => `${String(i).padStart(2, '0')} ${'Ayollar qishki kurtkasi, sintepon, kapyushonli, rang turli '.repeat(4)}`.slice(0, 227);
  const numbers = (text: string) => [...text.matchAll(/^(?:✅|⚠️) (\d+)\. /gmu)].map((m) => Number(m[1]));

  it('fifteen 227-character names fit, and every ⚠️ row is present — a name is clipped to 40 points', () => {
    // Fifteen, each owing a DIFFERENT figure: the table prints a name ONCE (the
    // summary printed it twice) and groups identical ↳ lines, so ten names
    // sharing one need would fit uncapped and the cap would go untested.
    const code = (i: number) => `61102000${String(i).padStart(2, '0')}`;
    const laws = new Map(
      Array.from({ length: 15 }, (_, i) => [
        code(i + 1),
        needLawOf({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: i + 1, dutyFree: false }),
      ]),
    );
    const goods = Array.from({ length: 15 }, (_, i) => ({ name: long(i + 1), weightKg: 10, tnvedCode: code(i + 1) }));
    const text = table({ laws, facts: { weightKg: 3500, volumeM3: 12, goods } });
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(numbers(text)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(text).not.toContain('va yana');
  });

  it('60 rows with 3 ⚠️: the ✅ rows collapse into one numbered line, every ⚠️ row shown', () => {
    const goods = Array.from({ length: 60 }, (_, i) =>
      [7, 23, 41].includes(i + 1)
        ? { name: `Tovar raqami ${i + 1} — uzun nom, rang turli` }
        : { name: `Tovar raqami ${i + 1} — uzun nom, rang turli`, quantity: 10, weightKg: 5, volumeM3: 0.1, tnvedCode: '6201400000' },
    );
    const text = table({ facts: { weightKg: 3500, volumeM3: 12, goods } });
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(text).toMatch(/^✅ yana \d+ ta qator to‘liq: [\d, –]+$/mu);
    for (const n of [7, 23, 41]) expect(text, String(n)).toContain(`⚠️ ${n}. `);
    expect(text).not.toContain('Qatorlar ko‘p');
  });

  it('40 short rows under 4096: all 40 shown — the reply’s 25-line cap is not the table’s', () => {
    const goods = Array.from({ length: 40 }, (_, i) => ({ name: `Tovar ${i + 1}`, quantity: 5 }));
    const text = table({ facts: { weightKg: 3500, volumeM3: 12, goods } });
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(numbers(text)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('100 long rows owing ONE count, cut to fit: the grouped ↳ still says what they lack (review PF-5)', () => {
    const goods = Array.from({ length: 100 }, (_, i) => ({ name: long(i + 1), weightKg: 10, tnvedCode: '6110200000' }));
    const text = table({ laws: new Map([['6110200000', FUTBOLKA]]), facts: { weightKg: 3500, volumeM3: 12, goods } });
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(text).toContain('va yana');
    expect(text).toContain('   ↳ 1–100: soni (dona) — boj kamida $2/dona');
  });

  it('an add table asking EVERY one of 250 rows: the closing names a few, counts the rest, and keeps its instruction (review PF-6)', () => {
    const goods = Array.from({ length: 250 }, (_, i) => ({
      name: `Futbolka ${i + 1}`,
      weightKg: 10,
      tnvedCode: '6110200000',
      seq: i + 1,
      itemId: `i${i + 1}`,
    }));
    const text = table({
      laws: new Map([['6110200000', FUTBOLKA]]),
      facts: { weightKg: 3500, volumeM3: 12, goods },
      amend: {
        cardLabel: 'B-00123',
        storedCount: 250,
        totalsStale: [],
        conflicts: [],
        askedSeqs: goods.map((g) => g.seq),
        started: false,
      },
    });
    expect(text.length).toBeLessThanOrEqual(MAX);
    // « va yana N ta», no comma before «va» — §2.2's and the echo's own (fix review W-8).
    expect(text).toMatch(/✍️ So‘ralgan: 1-qator soni \(dona\), .*8-qator soni \(dona\) va yana 242 ta\. Yozing: «1: 30 dona»\./u);
    expect(text).not.toContain('(qisqartirildi)');
  });

  it('60 kg-only rows owing the same count: one grouped ↳ line, every ⚠️ row’s number present', () => {
    const goods = Array.from({ length: 60 }, (_, i) => ({ name: `Futbolka model ${i + 1}`, weightKg: 10, tnvedCode: '6110200000' }));
    const text = table({ laws: new Map([['6110200000', FUTBOLKA]]), facts: { weightKg: 3500, volumeM3: 12, goods } });
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(numbers(text)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(text).toContain('   ↳ 1–60: soni (dona) — boj kamida $2/dona');
    expect(text.match(/↳/gu)).toHaveLength(1);
    expect(text).not.toContain('va yana');
  });
});

describe('the fix review of the review’s fixes (docs/SAKKIZ-R3.md §20.2)', () => {
  const MAX = 4096;
  /** The name example the ✍️ line teaches (the one that is no number and no total), or null. */
  const nameExample = (text: string): string | null => {
    const line = text.split('\n').find((l) => l.startsWith('✍️ Bir xabarda')) ?? '';
    return [...line.matchAll(/«([^»]+)»/gu)].map((m) => m[1]!).find((e) => !/^\d/u.test(e) && !e.startsWith('jami')) ?? null;
  };
  const refOf = (input: TableInput) => {
    const open = tableOpenOf(input);
    return { rows: tableRowsOf(input), open, preferred: open, stage: 'review' as const };
  };
  const input = (names: string[], over: Partial<TableInput> = {}): TableInput => ({
    section: 'rastamojka',
    laws: noLaws,
    clientLabel: null,
    fileCount: 0,
    ambiguous: [],
    amend: null,
    tail: '',
    nameWord: nameWordFor,
    facts: { weightKg: 500, volumeM3: 2, goods: names.map((name) => ({ name })) },
    ...over,
  });

  it('a 500-row table asks for a name at most NAME_ROWS_TRIED times (FR-3: every ⚠️ row, each over every row, was seconds)', () => {
    let calls = 0;
    const counting: TableInput['nameWord'] = (rows, row) => {
      calls += 1;
      return nameWordFor(rows, row);
    };
    // The worst shape: no row has a name of its own within three words.
    const names = Array.from({ length: 500 }, (_, i) => `Futbolka erkaklar paxta ${['qora', 'oq'][i % 2]} ${i + 1}`);
    const text = intakeTableText(input(names, { nameWord: counting }));
    expect(calls).toBeLessThanOrEqual(NAME_ROWS_TRIED);
    expect(text.length).toBeLessThanOrEqual(MAX);
  });

  it('the first row that answers ends the search — the next ⚠️ row’s name, as before', () => {
    let calls = 0;
    const counting: TableInput['nameWord'] = (rows, row) => {
      calls += 1;
      return nameWordFor(rows, row);
    };
    const text = intakeTableText(input(['Kurtka', 'Shapka', 'Sumka', 'Shim'], { nameWord: counting }));
    expect(calls).toBe(1);
    expect(nameExample(text)).toBe('Shapka 30 dona');
  });

  for (const [label, names, law] of [
    ['a totals word first («Jami …») is no example (FR-6)', ['Sumka', 'Jami to‘plam'], null],
    ['«Brutto …» neither', ['Stol', 'Brutto plyonka'], null],
    ['«TOTAL drel 150 kg» was read as the brutto (FR-6)', ['Sumka', 'TOTAL drel'], 'kg'],
    ['a carton word first («Qop …», «Quti …») is no example (FR-6)', ['Sumka', 'Qop polipropilen', 'Quti karton'], null],
    ['a model number stays in the name it teaches (W-9)', ['iPhone 15', 'iPhone 15 Pro'], null],
    ['«Xiaomi 14 Ultra», «Shina 205 55 R16»', ['Xiaomi 14 Ultra', 'Shina 205 55 R16'], null],
    ['«Monitor 24 dyuym» beside «Monitor 27 dyuym»', ['Monitor 24 dyuym', 'Monitor 27 dyuym'], null],
    // The fix review's check (CHK-1): a name holding «N <unit>» taught an example
    // the parser refused «repeated», or read with a second figure.
    ['«Futbolka 2 dona to‘plam» (CHK-1)', ['Futbolka 2 dona to‘plam', 'Futbolka oq'], null],
    ['«Paket 100 dona qora» beside «… oq» (CHK-1)', ['Paket 100 dona qora', 'Paket 100 dona oq'], null],
    ['«Paypoq 10 juft qora» beside «… oq» (CHK-1)', ['Paypoq 10 juft qora', 'Paypoq 10 juft oq'], null],
    ['«Kafel 2 kub qadoq» (CHK-1)', ['Kafel 2 kub qadoq', 'Kafel oq'], null],
  ] as const) {
    it(`the taught name example parses back to ITS row: ${label}`, () => {
      const laws = law === 'kg' ? new Map([['8467210000', needLawOf({ dutyMode: 'specific', dutyUnit: 'kg', dutySpecific: 1, dutyFree: false })]]) : noLaws;
      const goods = names.map((name, i) => ({ name, ...(law === 'kg' && i === 1 ? { tnvedCode: '8467210000' } : {}) }));
      const tableInput = input([...names], { laws, facts: { weightKg: 3500, volumeM3: 2, goods } });
      const text = intakeTableText(tableInput);
      const example = nameExample(text);
      if (example === null) return;
      const parsed = parseTableAnswer(example, refOf(tableInput));
      expect(parsed.segments, example).toHaveLength(1);
      const [segment] = parsed.segments;
      expect(segment!.refused, example).toBeNull();
      // The row whose taught words the example carries — the one it was built for.
      const rows = tableRowsOf(tableInput);
      const row = rows.find((r) => {
        const word = nameWordFor(rows, r);
        return word !== null && example.startsWith(`${word} `);
      });
      expect(segment!.at, example).toEqual({ line: row!.no });
      expect(segment!.totals, example).toBeNull();
      // Only the example's own figure — never a second one the name carried (CHK-1).
      const word = nameWordFor(rows, row!)!;
      expect(segment!.answer, example).toEqual(parseLineAnswer(example.slice(word.length + 1)));
    });
  }

  it('a name holding «N <unit>» teaches its words without the pair, and still teaches one (CHK-1)', () => {
    const rows = tableRowsOf(input(['Paket 100 dona qora', 'Paket 100 dona sariq']));
    expect(rows.map((r) => nameWordFor(rows, r))).toEqual(['Paket qora', 'Paket sariq']);
    const kafel = tableRowsOf(input(['Kafel 2 kub qadoq', 'Kafel oq']));
    expect(nameWordFor(kafel, kafel[0]!)).toBe('Kafel qadoq');
  });

  it('a decimal or grouped figure leaves the name whole — never a stray «1» (CHK-1 verify, CORR-nit-1)', () => {
    const moy = tableRowsOf(input(['Moy 1.5 litr qora', 'Moy 1.5 litr sariq']));
    expect(moy.map((r) => nameWordFor(moy, r))).toEqual(['Moy qora', 'Moy sariq']);
    const kurtka = tableRowsOf(input(['Kurtka 1 200 dona qora', 'Kurtka 1 200 dona sariq']));
    expect(kurtka.map((r) => nameWordFor(kurtka, r))).toEqual(['Kurtka qora', 'Kurtka sariq']);
    // A model number is no figure: «iPhone 15 Pro» keeps its 15 (W-9).
    const phones = tableRowsOf(input(['iPhone 15', 'iPhone 15 Pro']));
    expect(nameWordFor(phones, phones[1]!)).toBe('iPhone 15 Pro');
  });

  it('«iPhone 15 Pro», never «iPhone Pro» — the row’s own name (W-9)', () => {
    expect(nameWordFor(tableRowsOf(input(['iPhone 15', 'iPhone 15 Pro'])), tableRowsOf(input(['iPhone 15', 'iPhone 15 Pro']))[1]!)).toBe(
      'iPhone 15 Pro',
    );
    const rows = tableRowsOf(input(['Sumka', 'Jami to‘plam', 'TOTAL drel', 'Qop polipropilen']));
    expect(rows.slice(1).map((r) => nameWordFor(rows, r))).toEqual([null, null, null]);
  });

  it('a cut table counts the ⚠️ rows the cut took, and the ✅ rows stay in their one line (W-12)', () => {
    const long = (n: number) => `Kiyim ${n} ${'x'.repeat(220)}`;
    const goods = [
      ...Array.from({ length: 30 }, (_, i) => ({ name: long(i + 1), weightKg: 10, tnvedCode: '6110200000' })),
      ...Array.from({ length: 30 }, (_, i) => ({ name: long(i + 31), weightKg: 10, tnvedCode: '6403990000' })),
      ...Array.from({ length: 10 }, (_, i) => ({ name: long(i + 61), quantity: 5, weightKg: 10 })),
    ];
    const text = table({
      laws: new Map([
        ['6110200000', FUTBOLKA],
        ['6403990000', KROSSOVKA],
      ]),
      facts: { weightKg: 3500, volumeM3: 12, goods },
    });
    expect(text.length).toBeLessThanOrEqual(MAX);
    const shownWarn = [...text.matchAll(/^⚠️ (\d+)\. /gmu)].length;
    const cut = /… va yana (\d+) ta qator/u.exec(text);
    expect(cut, 'the table was cut').not.toBeNull();
    expect(Number(cut![1])).toBe(60 - shownWarn);
    expect(text).toContain('✅ yana 10 ta qator to‘liq: 61–70');
  });

  it('a SEEDED table asks its stale brutto (FR-4): «yangilansinmi?», never «✅ … Ma’lumot to‘liq»', () => {
    const tableInput = input(['Sumka', 'Krossovka', 'Shim'], {
      section: 'podklyuch',
      facts: {
        weightKg: 500,
        volumeM3: 2,
        fromCity: 'Yiwu',
        toCity: 'Toshkent',
        goods: [
          { name: 'Sumka', quantity: 10, weightKg: 5 },
          { name: 'Krossovka', quantity: 20, weightKg: 5 },
          { name: 'Shim', quantity: 5, weightKg: 5 },
        ],
      },
      totalsStale: ['weightKg'],
    });
    const text = intakeTableText(tableInput);
    expect(text).toContain('⚠️ umumiy brutto og‘irligi (kg) — yangi tovar qo‘shildi, yangilansinmi? «jami … kg»');
    expect(text).not.toContain('Ma’lumot to‘liq');
    expect(tableOpenOf(tableInput)).toContainEqual({ totals: 'weightKg' });
  });

  it('an add table whose brutto is stale with NO line added does not say a new item came (W-2)', () => {
    const amend: TableAmend = { cardLabel: 'B-00123', storedCount: 1, totalsStale: ['weightKg'], conflicts: [], askedSeqs: null };
    const stored = { name: 'Palto', quantity: 30, weightKg: 800, seq: 1, itemId: 'i1' };
    const corrected = table({ section: 'podklyuch', facts: { weightKg: 500, volumeM3: 2, fromCity: 'Yiwu', toCity: 'Toshkent', goods: [stored] }, amend });
    expect(corrected).toContain('⚠️ umumiy brutto og‘irligi (kg) — yangilansinmi? «jami … kg»');
    expect(corrected).not.toContain('yangi tovar qo‘shildi');
    const added = table({
      section: 'podklyuch',
      facts: { weightKg: 500, volumeM3: 2, fromCity: 'Yiwu', toCity: 'Toshkent', goods: [stored, { name: 'Shim', quantity: 5, weightKg: 5 }] },
      amend,
    });
    expect(added).toContain('⚠️ umumiy brutto og‘irligi (kg) — yangi tovar qo‘shildi, yangilansinmi? «jami … kg»');
  });
});
