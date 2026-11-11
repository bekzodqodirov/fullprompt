import { describe, expect, it } from 'vitest';
import {
  reseedRows,
  rowKey,
  sameNameCode,
  walkStep,
  type TnvedRow,
} from '@/app/(protected)/batches/[id]/tnved/editor-state';

/**
 * The Bojxona tab's editor, the part that is not React — the three decisions
 * the review of the built round found wrong or missing (2026-11-10,
 * docs/TARKIB-TUZATISH.md §5). Each used to be a consequence of how the
 * component happened to be mounted; pure, they are stated and held.
 */

const product = (lotId: string, nameZh: string, code = '', source: TnvedRow['source'] = null): TnvedRow => ({
  lotId,
  nameZh,
  nameRu: null,
  photoId: null,
  boxCount: 10,
  code,
  source,
  lots: [],
});
const line = (lotId: string, lineId: string, name: string, code = '', rev = 1): TnvedRow => ({
  ...product(lotId, name, code),
  line: {
    rowKey: `line:${lineId}`,
    lotId,
    lineId,
    seq: 1,
    rev,
    receiptId: 'r',
    label: 'GS777-A',
    ofLines: 2,
    cartons: 5,
    pieces: null,
    kg: 10,
    estimate: false,
    stale: false,
    frozen: false,
    hint: null,
    readable: true,
    firstOfLot: true,
  },
});
const codes = (rows: readonly TnvedRow[]) => rows.map((r) => [rowKey(r), r.code, r.source, r.line?.rev ?? null]);

describe('the editor re-seeds itself when the server’s rows come back', () => {
  const seeded = [product('p1', '键盘', '8471300000', 'manual'), product('p2', '灯'), line('l1', 'a', 'Мышь'), line('l1', 'b', 'Коврик')];
  const baseOf = (rows: readonly TnvedRow[], written: Record<string, string> = {}) => (key: string) =>
    written[key] ?? rows.find((r) => rowKey(r) === key)?.code ?? '';

  it('a row nobody touched takes the server’s code — a colleague’s correction is never written back', () => {
    // The memory's code for «键盘» was corrected on another truck's tab while
    // this screen stood open; this editor then saved ANOTHER product. Not
    // remounted (its key carried no product code), it kept the old code in
    // its state, called the row «changed» and posted it on the next save.
    const fresh = [product('p1', '键盘', '8471607000', 'manual'), ...seeded.slice(1)];
    const next = reseedRows(seeded, baseOf(seeded), fresh);
    expect(next[0]!.code).toBe('8471607000');
    expect(next.filter((r, i) => r.code !== fresh[i]!.code)).toEqual([]);
  });

  it('a code typed or suggested and not saved stays on its row — on the server’s row', () => {
    const typed = seeded.map((r) => (rowKey(r) === 'line:b' ? { ...r, code: '5703', source: 'ai' as const } : r));
    // The other line of the same lot was saved meanwhile: its code and the lot's revision moved.
    const fresh = [seeded[0]!, seeded[1]!, line('l1', 'a', 'Мышь', '8471607000', 2), line('l1', 'b', 'Коврик', '', 2)];
    expect(codes(reseedRows(typed, baseOf(seeded), fresh))).toEqual([
      ['p1', '8471300000', 'manual', null],
      ['p2', '', null, null],
      ['line:a', '8471607000', null, 2],
      // …the person's code, the server's revision.
      ['line:b', '5703', 'ai', 2],
    ]);
  });

  it('a code this editor has just saved is the server’s now, not an unsaved one', () => {
    const typed = seeded.map((r) => (rowKey(r) === 'p2' ? { ...r, code: '9405', source: 'manual' as const } : r));
    const fresh = [seeded[0]!, product('p2', '灯', '9405', 'manual'), seeded[2]!, seeded[3]!];
    const next = reseedRows(typed, baseOf(seeded, { p2: '9405' }), fresh);
    expect(next[1]).toBe(fresh[1]);
  });

  it('a tarkib re-saved on the prixod card: its lines are new rows, and the other lots keep their unsaved codes', () => {
    // The whole editor used to be keyed on the revisions: this remounted it
    // and every unsaved code on the screen — model answers already paid for —
    // was gone.
    const typed = seeded.map((r) => (rowKey(r) === 'p2' ? { ...r, code: '9405', source: 'ai' as const } : r.line ? { ...r, code: '1111' } : r));
    const fresh = [seeded[0]!, seeded[1]!, line('l1', 'c', 'Мышь', '', 7), line('l1', 'd', 'Чехол', '', 7)];
    expect(codes(reseedRows(typed, baseOf(seeded), fresh))).toEqual([
      ['p1', '8471300000', 'manual', null],
      ['p2', '9405', 'ai', null],
      // New line ids: nothing typed for the old lines can land on them.
      ['line:c', '', null, 7],
      ['line:d', '', null, 7],
    ]);
  });

  it('a row that left the truck is gone, a row that joined it is drawn', () => {
    const fresh = [seeded[1]!, product('p3', '耳机', '8518300000', 'ai')];
    expect(reseedRows(seeded, baseOf(seeded), fresh).map(rowKey)).toEqual(['p2', 'p3']);
  });

  it('a code CLEARED by hand and not saved stays cleared', () => {
    const cleared = seeded.map((r) => (rowKey(r) === 'p1' ? { ...r, code: '', source: 'manual' as const } : r));
    expect(reseedRows(cleared, baseOf(seeded), seeded)[0]!.code).toBe('');
  });
});

describe('what a 🤖 refusal means for the walk', () => {
  it('the model’s own failure may pass; a fact about one lot leaves that lot alone; a shut door ends it', () => {
    expect(walkStep('ai_failed')).toBe('failed');
    for (const code of ['composition_changed', 'receipt_not_confirmed', 'not_found']) expect(walkStep(code), code).toBe('skip-lot');
    for (const code of ['forbidden', 'ai_not_configured', 'frozen', 'server_behind', 'busy', undefined, 'anything-new']) {
      expect(walkStep(code), String(code)).toBe('stop');
    }
  });
});

describe('one answer per line name', () => {
  const rows = [
    line('l1', 'a', 'Мышь', '8471607000'),
    line('l2', 'b', ' мышь  '),
    line('l2', 'c', 'Коврик'),
    product('p1', 'Мышь', '9999'),
  ];

  it('a line takes the code another line of the same name already holds on the screen', () => {
    // Typed, from the row's own 🤖, or from a walk that stopped: it IS the
    // answer and costs no call. The walk's own map knew only the answers of
    // one uninterrupted walk.
    expect(sameNameCode(rows, rows[1]!)).toBe('8471607000');
  });

  it('never its own code, never a PRODUCT row’s (the memory’s), never an empty one', () => {
    expect(sameNameCode(rows, rows[0]!)).toBeNull();
    expect(sameNameCode(rows, rows[2]!)).toBeNull();
    expect(sameNameCode([rows[1]!, rows[3]!], rows[1]!)).toBeNull();
    // A product row is not asked through this rule at all.
    expect(sameNameCode(rows, rows[3]!)).toBeNull();
  });
});
