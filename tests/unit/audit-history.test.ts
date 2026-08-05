import { describe, expect, it } from 'vitest';
import {
  groupHistory,
  visibleChanges,
  HISTORY_WINDOW_MS,
  type HistoryRow,
} from '@/modules/platform/audit/history';

/**
 * What the History tab is allowed to say.
 *
 * The rules worth pinning are the ones that decide whether a reader is told
 * the truth: a row must read the same alone as it does merged, a merged entry
 * must never carry a count over an empty box, and nothing may be merged across
 * two people or two sittings.
 */

const ALI = '11111111-1111-1111-1111-111111111111';
const VALI = '22222222-2222-2222-2222-222222222222';
const T0 = new Date('2026-08-05T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let seq = 0;
function row(over: Partial<HistoryRow> = {}): HistoryRow {
  seq += 1;
  return {
    id: `r${seq}`,
    actorId: ALI,
    actorName: 'Ali',
    action: 'update',
    before: null,
    after: null,
    createdAt: T0,
    ...over,
  };
}

describe('what one row changed', () => {
  it('drops a pair that was recorded but not changed', () => {
    // Several writers record a fixed set of columns whether or not the person
    // touched them; `name: Ali → Ali` is noise, not history.
    expect(
      visibleChanges({ name: 'Ali', phone: '+998900000000' }, { name: 'Ali', phone: '+998911112233' }),
    ).toEqual([{ key: 'phone', before: '+998900000000', after: '+998911112233' }]);
  });

  it('keeps a field that only the after side names', () => {
    // `saveLines` writes an after with no before at all.
    expect(visibleChanges(null, { lines: 5 })).toEqual([{ key: 'lines', before: null, after: 5 }]);
  });

  it('treats null, undefined and a missing key as the same nothing', () => {
    expect(visibleChanges({ note: null }, { note: null })).toEqual([]);
    expect(visibleChanges({}, { note: null })).toEqual([]);
  });
});

describe('what merges into one entry', () => {
  it('folds one person correcting three fields in one sitting', () => {
    const rows = [
      row({ createdAt: at(4), before: { note: null }, after: { note: 'chaqirdim' } }),
      row({ createdAt: at(2), before: { company: null }, after: { company: 'Alfa' } }),
      row({ createdAt: at(0), before: { phone: 'x' }, after: { phone: 'y' } }),
    ];
    const [group, ...rest] = groupHistory(rows);
    expect(rest).toHaveLength(0);
    expect(group!.rows).toHaveLength(3);
    expect(group!.changes.map((c) => c.key).sort()).toEqual(['company', 'note', 'phone']);
    // The entry is stamped with the NEWEST row, which is what the list is
    // ordered by — a group dated by its oldest row would sort into the past.
    expect(group!.at).toEqual(at(4));
  });

  it('shows where a field ended up, not every step it took', () => {
    const rows = [
      row({ createdAt: at(3), before: { phone: 'b' }, after: { phone: 'c' } }),
      row({ createdAt: at(1), before: { phone: 'a' }, after: { phone: 'b' } }),
    ];
    const [group] = groupHistory(rows);
    expect(group!.changes).toEqual([{ key: 'phone', before: 'a', after: 'c' }]);
    // …and the steps are still there, one press away.
    expect(group!.rows.map((r) => r.id)).toHaveLength(2);
  });

  it('never merges two people, even back to back', () => {
    const rows = [
      row({ actorId: VALI, actorName: 'Vali', createdAt: at(1), after: { note: 'b' } }),
      row({ actorId: ALI, createdAt: at(0), after: { note: 'a' } }),
    ];
    expect(groupHistory(rows)).toHaveLength(2);
  });

  it('never merges two system writes — nobody owns them', () => {
    const rows = [
      row({ actorId: null, actorName: null, createdAt: at(1), after: { note: 'b' } }),
      row({ actorId: null, actorName: null, createdAt: at(0), after: { note: 'a' } }),
    ];
    expect(groupHistory(rows)).toHaveLength(2);
  });

  it('never merges across a gap longer than one sitting', () => {
    const rows = [
      row({ createdAt: new Date(T0.getTime() + HISTORY_WINDOW_MS + 1), after: { note: 'b' } }),
      row({ createdAt: T0, after: { note: 'a' } }),
    ];
    expect(groupHistory(rows)).toHaveLength(2);
  });

  it('leaves a create, a void or a scan standing alone', () => {
    const rows = [
      row({ createdAt: at(2), action: 'void', after: { voided: true } }),
      row({ createdAt: at(1), action: 'create', after: { name: 'Ali' } }),
      row({ createdAt: at(0), after: { note: 'a' } }),
    ];
    expect(groupHistory(rows)).toHaveLength(3);
  });
});

describe('what it refuses to say', () => {
  it('does not put a count over an empty box', () => {
    // Both rows recorded columns the person did not touch — the shape every
    // lead and deal save wrote before this round. Merged, they would net to
    // nothing, and «2 ta o'zgarish» over a blank list reads as a broken screen.
    const rows = [
      row({ createdAt: at(1), before: { name: 'Ali' }, after: { name: 'Ali' } }),
      row({ createdAt: at(0), before: { name: 'Ali' }, after: { name: 'Ali' } }),
    ];
    const groups = groupHistory(rows);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.rows.length === 1 && g.changes.length === 0)).toBe(true);
  });

  it('counts what is on screen, not what is in the fold', () => {
    // Three rows, but two of them moved the same field: the badge counts the
    // net lines a reader can see, the fold counts the rows behind them.
    const rows = [
      row({ createdAt: at(2), before: { phone: 'b' }, after: { phone: 'c' } }),
      row({ createdAt: at(1), before: { phone: 'a' }, after: { phone: 'b' } }),
      row({ createdAt: at(0), before: { note: null }, after: { note: 'x' } }),
    ];
    const [group] = groupHistory(rows);
    expect(group!.changes).toHaveLength(2);
    expect(group!.rows).toHaveLength(3);
  });

  it('gives a row the same reading alone as it has merged', () => {
    // The one rule that makes the fold trustworthy: `visibleChanges` decides,
    // whether the row stands by itself or inside a group.
    const alone = row({ before: { name: 'Ali', phone: 'a' }, after: { name: 'Ali', phone: 'b' } });
    const [solo] = groupHistory([alone]);
    expect(solo!.changes).toEqual(visibleChanges(alone.before, alone.after));
    expect(solo!.changes.map((c) => c.key)).toEqual(['phone']);
  });
});
