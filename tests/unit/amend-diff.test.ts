import { describe, expect, it } from 'vitest';
import {
  amendChangeText,
  amendDiff,
  amendThreadBody,
  amendTotalsStale,
  conflictOf,
  tableEditsOf,
  type AmendChange,
} from '@/modules/wms/calc/amend';
import type { AmendBase, AmendBaseItem, AmendSubmission } from '@/modules/wms/calc/amend-types';
import { THREAD_TEXT_MAX } from '@/modules/platform/notifications/thread-ref';
import { amendSubmissionOf, AMEND_REFUSAL } from '@/modules/platform/telegram/calc-amend';
import { endIntake, startIntake } from '@/modules/platform/telegram/calc-store';
import { sameGoodsLine } from '@/modules/platform/telegram/calc-intake';
import { knownGoodsText } from '@/modules/wms/calc/intake-ai';

/**
 * The add door's pure halves (docs/SAKKIZ-R3.md §9.5, his 1.9 a): what a
 * seller's addition becomes over the request AS IT STANDS at the save, which
 * totals it leaves stale, and the words the seller and the VED read — each
 * asserted on literals written here, never on a second computation.
 */

const NOTE = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
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

const base = (items: AmendBaseItem[], over: Partial<AmendBase> = {}): AmendBase => ({
  requestId: id(99),
  cardLabel: 'B-000067',
  entityType: 'deal',
  entityId: id(98),
  leadOpen: null,
  section: 'rastamojka',
  clientLabel: 'GS777 Ali aka',
  openedRev: 0,
  items,
  weightKg: null,
  volumeM3: null,
  fromCity: null,
  toCity: null,
  ...over,
});

const sub = (over: Partial<AmendSubmission> = {}): AmendSubmission => ({
  rowAnswers: [],
  newLines: [],
  totals: null,
  route: null,
  conflicts: [],
  doubtedTotals: [],
  material: [],
  fileCount: 0,
  ...over,
});

describe('amendDiff — over a FRESH base', () => {
  it('an answer over a row the machine changed since the open: expect holds the FRESH values', () => {
    // At the open row 3 read 250 dona; the machine's pass wrote 300 since.
    const fresh = base([item(3, { name: 'Sumka', quantity: 300, weightKg: 20 })]);
    const change = amendDiff(fresh, sub({ rowAnswers: [{ itemId: id(3), patch: { quantity: 50 } }] }), NOTE);
    expect(change.edits).toEqual([
      { itemId: id(3), seq: 3, name: 'Sumka', set: { quantity: 50 }, expect: { quantity: 300 } },
    ]);
  });

  it('an answer that equals the stored figure writes nothing', () => {
    const fresh = base([item(3, { quantity: 50 })]);
    expect(amendDiff(fresh, sub({ rowAnswers: [{ itemId: id(3), patch: { quantity: 50 } }] }), NOTE).edits).toEqual([]);
  });

  it('a new line repeating a stored name: the same figures are nothing, another figure is that row’s conflict — never an add', () => {
    const fresh = base([item(2, { name: 'Krossovka', quantity: 300 })]);
    const same = amendDiff(fresh, sub({ newLines: [{ name: 'krossovka', quantity: 300 }] }), NOTE);
    expect(same.adds).toEqual([]);
    expect(same.conflicts).toEqual([]);
    const other = amendDiff(fresh, sub({ newLines: [{ name: 'Krossovka', quantity: 200 }] }), NOTE);
    expect(other.adds).toEqual([]);
    expect(other.conflicts).toEqual([
      { itemId: id(2), seq: 2, name: 'Krossovka', field: 'quantity', unit: 'dona', stored: 300, read: 200 },
    ]);
  });

  it('a new line’s client id is minted from the note and its index: a retried save is the same row', () => {
    const fresh = base([item(1)]);
    const lines = sub({ newLines: [{ name: 'Shim', weightKg: 20 }, { name: 'Kepka', quantity: 5 }] });
    const a = amendDiff(fresh, lines, NOTE);
    const b = amendDiff(fresh, lines, NOTE);
    expect(a.adds.map((x) => x.clientId)).toEqual(b.adds.map((x) => x.clientId));
    expect(new Set(a.adds.map((x) => x.clientId)).size).toBe(2);
    expect(amendDiff(fresh, lines, id(77)).adds[0]!.clientId).not.toBe(a.adds[0]!.clientId);
  });

  it('«Kafel 120 m2» as a new line is the pair (doorRow) — never 120 pieces', () => {
    const change = amendDiff(base([item(1)]), sub({ newLines: [{ name: 'Kafel', quantity: 120, unit: 'm2' }] }), NOTE);
    expect(change.adds[0]).toMatchObject({ name: 'Kafel', quantity: null, measureUnit: 'm2', measureQty: 120 });
  });

  it('a code on a CODED row is kept for the VED; an EMPTY code is filled; a non-code is named «yozilmadi»', () => {
    const fresh = base([
      item(1, { name: 'Krossovka', tnvedCode: '6403990000' }),
      item(2, { name: 'Sumka' }),
      item(3, { name: 'Shim' }),
    ]);
    const change = amendDiff(
      fresh,
      sub({
        rowAnswers: [
          { itemId: id(1), patch: { tnvedCode: '6402990000' } },
          { itemId: id(2), patch: { tnvedCode: '4202920000' } },
          { itemId: id(3), patch: { tnvedCode: 'qora' } },
        ],
      }),
      NOTE,
    );
    expect(change.codesKept).toEqual([{ seq: 1, name: 'Krossovka', typed: '6402990000', stored: '6403990000' }]);
    expect(change.edits).toEqual([
      { itemId: id(2), seq: 2, name: 'Sumka', set: { tnvedCode: '4202920000' }, expect: { tnvedCode: null } },
    ]);
    expect(change.notWritten).toEqual([{ seq: 3, name: 'Shim', text: 'qora' }]);
  });

  it('an edit carries the answered fields and its compare-and-set — and no note (re-check p4-17)', () => {
    // The stored row's note is «og‘irlik umumiy (brutto)dan olindi»: an edit's
    // note REPLACES it, so the add door posts none.
    const change = amendDiff(
      base([item(1, { quantity: 10, weightKg: 150 })]),
      sub({ rowAnswers: [{ itemId: id(1), patch: { quantity: 40 } }] }),
      NOTE,
    );
    const [edit] = tableEditsOf(change);
    expect(edit).toEqual({ id: id(1), seq: 1, quantity: 40, expect: { quantity: 10 } });
    expect('note' in edit!).toBe(false);
    for (const banned of ['bazaUsd', 'bazaBasis', 'importRowId', 'bazaReason', 'shownBasis']) {
      expect(banned in edit!, banned).toBe(false);
    }
  });

  it('cargo carries only the keys a table answer set — no null, no stored city echoed back', () => {
    const fresh = base([item(1)], { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 3000, volumeM3: 12 });
    const change = amendDiff(fresh, sub({ totals: { weightKg: 3500 }, route: { fromCity: 'yiwu' } }), NOTE);
    expect(change.cargo).toEqual({ weightKg: 3500 });
  });
});

describe('the Σ rule and stale totals (law-money-1)', () => {
  it('a stored m³ that is the lines’ Σ (5 + 7 = 12) and a new 3 m³ line → re-summed to 15', () => {
    const fresh = base([item(1, { volumeM3: 5 }), item(2, { volumeM3: 7 })], { volumeM3: 12 });
    const change = amendDiff(fresh, sub({ newLines: [{ name: 'Shim', volumeM3: 3 }] }), NOTE);
    expect(change.cargo).toEqual({ volumeM3: 15 });
    expect(change.resummedM3).toBe(15);
    expect(change.totalsStale).toEqual([]);
  });

  it('a TYPED m³ (20, the lines say 12) and a new line → not re-summed, stale', () => {
    const fresh = base([item(1, { volumeM3: 5 }), item(2, { volumeM3: 7 })], { volumeM3: 20 });
    const change = amendDiff(fresh, sub({ newLines: [{ name: 'Shim', volumeM3: 3 }] }), NOTE);
    expect(change.cargo).toBeNull();
    expect(change.totalsStale).toEqual(['volumeM3']);
  });

  it('a Σ the new line leaves un-whole (no m³ on it) → stale, never a smaller Σ', () => {
    const fresh = base([item(1, { volumeM3: 5 }), item(2, { volumeM3: 7 })], { volumeM3: 12 });
    const change = amendDiff(fresh, sub({ newLines: [{ name: 'Shim', weightKg: 20 }] }), NOTE);
    expect(change.cargo).toBeNull();
    expect(change.totalsStale).toEqual(['volumeM3']);
  });

  it('brutto has no Σ: an added line leaves a stored brutto stale, an answered one is the seller’s', () => {
    const stale = amendTotalsStale({
      section: 'rastamojka',
      stored: { weightKg: 3000, volumeM3: null, items: [{ volumeM3: null }] },
      linesAfter: [{ volumeM3: null }, { volumeM3: null }],
      added: 1,
      answered: { weightKg: false, volumeM3: false },
    });
    expect(stale.stale).toEqual(['weightKg']);
    const answered = amendTotalsStale({
      section: 'rastamojka',
      stored: { weightKg: 3000, volumeM3: null, items: [{ volumeM3: null }] },
      linesAfter: [{ volumeM3: null }, { volumeM3: null }],
      added: 1,
      answered: { weightKg: true, volumeM3: false },
    });
    expect(answered.stale).toEqual([]);
  });

  it('nothing added and no line’s m³ moved: nothing stale, nothing re-summed', () => {
    expect(
      amendTotalsStale({
        section: 'podklyuch',
        stored: { weightKg: 3000, volumeM3: 12, items: [{ volumeM3: 12 }] },
        linesAfter: [{ volumeM3: 12 }],
        added: 0,
        answered: { weightKg: false, volumeM3: false },
      }),
    ).toEqual({ stale: [], resummedM3: null });
  });
});

describe('conflictOf — a stored row the new material restates (law-money-5)', () => {
  it('a different figure, and a figure in a field the row has EMPTY, are conflicts; the same figure is not', () => {
    expect(conflictOf({ quantity: 300, weightKg: null }, { quantity: 200, weightKg: 120 })).toEqual([
      { field: 'quantity', unit: 'dona', stored: 300, read: 200 },
      { field: 'weightKg', unit: 'kg', stored: null, read: 120 },
    ]);
    expect(conflictOf({ quantity: 300, weightKg: 150 }, { quantity: 300, weightKg: 150.4 })).toEqual([]);
  });
  it('a pair counts only in the row’s own pair unit', () => {
    expect(conflictOf({ measureUnit: 'm2', measureQty: 120 }, { measureUnit: 'juft', measureQty: 40 })).toEqual([]);
    expect(conflictOf({ measureUnit: 'm2', measureQty: 120 }, { measureUnit: 'm2', measureQty: 140 })).toEqual([
      { field: 'measureQty', unit: 'm2', stored: 120, read: 140 },
    ]);
  });
});

describe('sameGoodsLine — the stored row read again (re-check p4-10)', () => {
  it('a bilingual top-up is the stored row; a bracketed colour with other figures is a NEW line', () => {
    expect(sameGoodsLine({ name: 'Ladies jacket', quantity: 300 }, { name: 'Куртка женская (Ladies jacket)', quantity: 300 })).toBe(true);
    expect(sameGoodsLine({ name: 'Kurtka', quantity: 300 }, { name: 'Kurtka (qora)', quantity: 200 })).toBe(false);
    // The same whole name is the row whatever its figures — a conflict, not a line.
    expect(sameGoodsLine({ name: 'Sumka', quantity: 300 }, { name: 'sumka', quantity: 200 })).toBe(true);
  });
});

describe('amendSubmissionOf — what an add collection hands the writer', () => {
  const state = (patch: Parameters<typeof Object.assign>[1]) => {
    const s = startIntake(-424242n, 'rastamojka', {
      ai: true,
      staffId: id(50),
      amend: base([item(1, { name: 'Kurtka', quantity: 300 }), item(2, { name: 'Krossovka', weightKg: 12.5 })]),
    });
    endIntake(-424242n);
    return Object.assign(s, patch);
  };

  it('stored rows’ answers by item id, new lines without one, and the seller’s words verbatim', () => {
    const out = amendSubmissionOf(
      state({
        lineAnswers: [
          { index: 1, name: 'Krossovka', patch: { measureUnit: 'juft', measureQty: 40 }, itemId: id(2) },
          { index: 2, name: 'Shim', patch: { weightKg: 20 } },
        ],
        facts: {
          goods: [
            { name: 'Kurtka', quantity: 300, itemId: id(1), seq: 1 },
            { name: 'Krossovka', weightKg: 12.5, measureUnit: 'juft', measureQty: 40, itemId: id(2), seq: 2 },
            { name: 'Shim', weightKg: 20 },
          ],
        },
        material: ['Shim 20 kg'],
        answers: ['2-qator: 40 juft'],
        fileCount: 1,
      }),
    );
    expect(out.rowAnswers).toEqual([{ itemId: id(2), patch: { measureUnit: 'juft', measureQty: 40 } }]);
    expect(out.newLines).toEqual([{ name: 'Shim', weightKg: 20 }]);
    expect(out.material).toEqual(['Shim 20 kg', '2-qator: 40 juft']);
    expect(out.fileCount).toBe(1);
  });

  it('a totals answer later material doubts is NOT written: it reaches the VED as words (re-check p4-6)', () => {
    const out = amendSubmissionOf(
      state({
        totalsAnswer: { weightKg: 3500, volumeM3: 12, at: { material: 0, files: 0 } },
        ambiguousTotals: [{ field: 'weightKg', answered: 3500, stated: 4200 }],
      }),
    );
    expect(out.totals).toEqual({ volumeM3: 12 });
    expect(out.doubtedTotals).toEqual([{ field: 'weightKg', asked: 3500, read: 4200 }]);
    const change = amendDiff(
      base([item(1)], { weightKg: 3000, volumeM3: 12 }),
      out,
      NOTE,
    );
    expect(amendChangeText(change, 0)).toContain('· umumiy brutto: 3500 kg so‘ralgan, faylda 4200 kg — VED hal qiladi');
  });

  it('a conflict answered «qo‘shilsin» is its row’s answer (stored + read); unanswered or «📨» is the VED’s', () => {
    const out = amendSubmissionOf(
      state({
        conflicts: [
          { itemId: id(1), seq: 1, field: 'quantity', unit: 'dona', stored: 300, read: 200, choice: 'add' },
          { itemId: id(2), seq: 2, field: 'weightKg', unit: 'kg', stored: 12.5, read: 14, choice: null },
        ],
      }),
    );
    expect(out.rowAnswers).toEqual([
      { itemId: id(1), patch: { quantity: 500 }, sum: { field: 'quantity', unit: 'dona', stored: 300, read: 200 } },
    ]);
    expect(out.conflicts).toEqual([
      { itemId: id(2), seq: 2, name: 'Krossovka', field: 'weightKg', unit: 'kg', stored: 12.5, read: 14 },
    ]);
  });

  it('the route only from a table answer, present keys only', () => {
    const out = amendSubmissionOf(state({ routeAnswer: { toCity: 'Toshkent', at: { material: 0, files: 0 } } }));
    expect(out.route).toEqual({ toCity: 'Toshkent' });
  });
});

describe('the change lines (§2.4) — one home for the seller, the thread and the VED', () => {
  const change = (): AmendChange =>
    amendDiff(
      base(
        [
          item(2, { name: 'Krossovka', weightKg: 12.5, tnvedCode: '6403990000' }),
          item(3, { name: 'Sumka', quantity: 300, tnvedCode: '6403990000' }),
        ],
        { weightKg: 3000, volumeM3: 12 },
      ),
      sub({
        rowAnswers: [
          { itemId: id(2), patch: { measureUnit: 'juft', measureQty: 40 } },
          { itemId: id(3), patch: { tnvedCode: '6402990000' } },
        ],
        newLines: [{ name: 'Shim', weightKg: 20, tnvedCode: '6203420000' }],
        totals: { volumeM3: 12.5 },
        conflicts: [{ itemId: id(3), seq: 3, name: 'Sumka', field: 'quantity', unit: 'dona', stored: 300, read: 200 }],
      }),
      NOTE,
    );

  it('as posted — every line literally', () => {
    expect(amendChangeText(change(), 2)).toEqual([
      '· 2-qator «Krossovka»: 40 juft',
      '· yangi qator: «Shim» — 20 kg · 6203420000',
      '· umumiy hajm: 12.5 m³',
      '· 3-qator «Sumka»: sotuvchi kodi 6402990000 (so‘rovda 6403990000 — VED hal qiladi)',
      '· 3-qator «Sumka»: faylda 200 dona (so‘rovda 300) — sotuvchi tanlamadi, VED hal qiladi',
      '· ⚠️ umumiy brutto yangilanmagan — yangi tovar qo‘shildi',
      '· 📎 2 ta fayl kartadagi lentada',
    ]);
  });

  it('as SAVED — a measure the law dropped is «yozilmadi», never «yozildi» (regression-16)', () => {
    const lines = amendChangeText(change(), 0, { measuresDropped: [2], measuresCleared: [], basisConflict: [] });
    expect(lines[0]).toBe('· 2-qator «Krossovka»: 40 juft — yozilmadi (kod juft so‘ramaydi)');
    const cleared = amendChangeText(change(), 0, { measuresDropped: [], measuresCleared: [2], basisConflict: [] });
    expect(cleared[0]).toBe('· 2-qator «Krossovka»: 40 juft — yozilmadi (qatorning birligi boshqa)');
  });

  it('a re-summed m³ says so; a conflict answered «qo‘shilsin» shows its arithmetic', () => {
    const resummed = amendDiff(
      base([item(1, { volumeM3: 5 }), item(2, { volumeM3: 7 })], { volumeM3: 12 }),
      sub({ newLines: [{ name: 'Shim', volumeM3: 3 }] }),
      NOTE,
    );
    expect(amendChangeText(resummed, 0)).toContain('· umumiy hajm: 15 m³ (qatorlardan qayta hisoblandi)');
    const summed = amendDiff(
      base([item(3, { name: 'Sumka', quantity: 300 })]),
      sub({
        rowAnswers: [
          { itemId: id(3), patch: { quantity: 500 }, sum: { field: 'quantity', unit: 'dona', stored: 300, read: 200 } } as never,
        ],
      }),
      NOTE,
    );
    expect(amendChangeText(summed, 0)).toEqual(['· 3-qator «Sumka»: 300 + 200 = 500 dona (ikkinchi fayl qo‘shildi)']);
  });

  it('at most 20 lines, then «· … yana {n} ta o‘zgarish»', () => {
    const many = amendDiff(
      base(Array.from({ length: 25 }, (_, i) => item(i + 1, { quantity: 1 }))),
      sub({ rowAnswers: Array.from({ length: 25 }, (_, i) => ({ itemId: id(i + 1), patch: { quantity: 2 } })) }),
      NOTE,
    );
    const lines = amendChangeText(many, 0);
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('· … yana 5 ta o‘zgarish');
  });

  it('a thread body over THREAD_TEXT_MAX is cut from the END into «· … yana {n} ta o‘zgarish» (re-check p4-19)', () => {
    const long = Array.from({ length: 80 }, (_, i) => `· ${i + 1}-qator «${'X'.repeat(60)}»: 1 dona`);
    const body = amendThreadBody('➕ Sotuvchi qo‘shimcha yubordi — so‘rovga yozildi, AI qayta hisoblaydi:', long);
    expect(body.length).toBeLessThanOrEqual(THREAD_TEXT_MAX);
    expect(body.startsWith('➕ Sotuvchi qo‘shimcha yubordi')).toBe(true);
    expect(body).toContain('· 1-qator');
    expect(body).toMatch(/\n· … yana \d+ ta o‘zgarish$/);
    expect(amendThreadBody('head', ['· a', '· b'])).toBe('head\n· a\n· b');
  });
});

describe('the words', () => {
  it('every saveTable refusal has a sentence (law-money-4)', () => {
    for (const [code, words] of Object.entries(AMEND_REFUSAL)) expect(words.trim(), code).not.toBe('');
  });

  it('the request’s own names lead the model’s «already there» block, in the request’s words (re-check p4-16)', () => {
    const text = knownGoodsText(['Kurtka', 'Sumka'], 6000, 'request');
    expect(text.startsWith('Эти товары уже есть в заявке — НЕ повторяй их в goods, перечисли только новые:\n- Kurtka\n- Sumka')).toBe(true);
    expect(knownGoodsText(['A'.repeat(50), 'B'.repeat(50)], 60, 'request')).toContain('…и ещё 1 строк этой заявки');
    // The invoice's block is unchanged.
    expect(knownGoodsText(['Kurtka'], 6000)).toContain('из таблицы Excel');
  });
});
