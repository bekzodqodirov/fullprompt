import { describe, expect, it } from 'vitest';
import { amendAdds } from '@/modules/platform/telegram/calc-dialog';
import { amendSubmissionOf } from '@/modules/platform/telegram/calc-amend';
import type { IntakeState } from '@/modules/platform/telegram/calc-intake';
import { AMEND_NOTHING_YET, intakeTableText, type TableAmend } from '@/modules/wms/calc/intake';

/**
 * An add collection with nothing in it does not promise «✅ Qo‘shish» or a
 * re-run (review ask-break-6): the press answers «Hech narsa o‘zgarmadi» and
 * queues no pass. `amendAdds` reads the same state fields `amendSubmissionOf`
 * builds the save's submission from; the agreement is pinned here by building
 * the submission itself and asking it what `changeSays` asks.
 */
const AT = { material: 0, files: 0 };
const stored = { itemId: 'i1', seq: 1, name: 'Kurtka', quantity: 300, weightKg: 150, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '6201400000', law: null, confirmed: false };
const base = (): IntakeState =>
  ({
    amend: { requestId: 'r', cardLabel: 'B-00123', items: [stored] },
    conflicts: [],
    lineAnswers: [],
    facts: { goods: [{ name: 'Kurtka', quantity: 300, weightKg: 150, seq: 1, itemId: 'i1', tnvedCode: '6201400000' }] },
    totalsAnswer: { weightKg: null, volumeM3: null, at: AT },
    routeAnswer: null,
    ambiguousTotals: [],
    material: [],
    answers: [],
    fileCount: 0,
    fileNotes: [],
    refusedFiles: [],
  }) as unknown as IntakeState;

/** What `changeSays` asks of the submission, minus the diff against the stored base. */
const says = (s: IntakeState) => {
  const sub = amendSubmissionOf(s);
  return (
    sub.rowAnswers.length > 0 ||
    sub.newLines.length > 0 ||
    sub.totals !== null ||
    sub.route !== null ||
    sub.conflicts.length > 0 ||
    sub.doubtedTotals.length > 0 ||
    sub.material.some((m) => m.trim() !== '') ||
    sub.fileCount > 0
  );
};

describe('amendAdds: anything the add door’s save would write or name', () => {
  const cases: [string, (s: IntakeState) => void, boolean][] = [
    ['nothing yet: the stored rows only', () => {}, false],
    ['whitespace typed is nothing', (s) => void (s.material = ['  ', '\n']), false],
    ['a line answered on a stored row', (s) => void (s.lineAnswers = [{ index: 0, name: 'Kurtka', patch: { weightKg: 180 }, itemId: 'i1' }]), true],
    ['an answer carrying no figure is none', (s) => void (s.lineAnswers = [{ index: 0, name: 'Kurtka', patch: { weightKg: null }, itemId: 'i1' }]), false],
    ['a new line', (s) => void s.facts.goods!.push({ name: 'Shim', quantity: 100 }), true],
    ['a totals answer', (s) => void (s.totalsAnswer = { weightKg: 3500, volumeM3: null, at: AT }), true],
    ['a route answer', (s) => void (s.routeAnswer = { fromCity: 'Yiwu', at: AT }), true],
    ['typed words', (s) => void (s.material = ['rangi qora']), true],
    ['an answer to a question', (s) => void (s.answers = ['300 dona']), true],
    ['a file', (s) => void (s.fileCount = 1), true],
    [
      'a conflict left to the VED',
      (s) => void (s.conflicts = [{ itemId: 'i1', seq: 1, field: 'weightKg', unit: 'kg', stored: 150, read: 160, choice: null }] as never),
      true,
    ],
  ];
  for (const [what, set, expected] of cases) {
    it(what, () => {
      const s = base();
      set(s);
      expect(amendAdds(s)).toBe(expected);
      // The submission the press would send says the same thing.
      expect(says(s)).toBe(expected);
    });
  }
});

describe('the add table’s closing when nothing was added (review ask-break-6)', () => {
  const amend = (adds?: boolean): TableAmend => ({ cardLabel: 'B-00123', storedCount: 1, totalsStale: [], conflicts: [], askedSeqs: null, ...(adds === undefined ? {} : { adds }) });
  const facts = { weightKg: 3500, volumeM3: 12, goods: [{ name: 'Kurtka', quantity: 300, seq: 1, tnvedCode: '6201400000' }] };
  const ai = { available: true, last: [], reading: null } as never;
  const last = (a: TableAmend) => intakeTableText({ section: 'rastamojka', facts, laws: new Map(), clientLabel: null, fileCount: 0, ambiguous: [], amend: a, ai } as never).split('\n').at(-1);

  it('nothing yet: no press and no re-run promised — what the door takes', () => {
    expect(last(amend(false))).toBe('ℹ️ Hali hech narsa qo‘shilmadi — yangi tovar, javob yoki faylni shu yerga yuboring.');
    expect(AMEND_NOTHING_YET).toBe(last(amend(false)));
    expect(last({ ...amend(false), started: true })).toBe(AMEND_NOTHING_YET);
  });

  it('something added, or not known: today’s words', () => {
    expect(last(amend(true))).toBe('✅ Ma’lumot to‘liq — «✅ Qo‘shish» ni bosing, AI qayta hisoblaydi.');
    expect(last(amend())).toBe('✅ Ma’lumot to‘liq — «✅ Qo‘shish» ni bosing, AI qayta hisoblaydi.');
  });
});
