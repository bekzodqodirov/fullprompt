/**
 * Turning audit rows into something a person can read.
 *
 * Two rules, both of them about honesty rather than tidiness.
 *
 * The first is that a row shows what CHANGED. `writeAudit` inserts whatever it
 * is handed, and several writers hand it a fixed set of columns whether or not
 * the person touched them — so `name: Ali → Ali` has been on these cards since
 * they shipped. Dropping equal pairs is applied to EVERY row, alone or merged,
 * or the same row would read differently depending on its neighbours.
 *
 * The second is that a run of edits by one person in one sitting is one story.
 * Correcting a lead's phone, company and note now writes three rows (one field
 * per row, since the card learned inline edit), and three cards saying
 * "changed" is not three facts.
 */

/** One audit row, as the History tab already fetches it. */
export interface HistoryRow {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Date;
}

export interface HistoryChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface HistoryGroup {
  /** The newest row's id — stable across renders, unlike a position. */
  id: string;
  actorName: string | null;
  action: string;
  /** When the newest row in the group was written. */
  at: Date;
  /** Every underlying row, newest first. One row means nothing was merged. */
  rows: HistoryRow[];
  /** What the group amounts to: the net change per field, equal pairs dropped. */
  changes: HistoryChange[];
}

/**
 * How far apart two edits can be and still be the same sitting.
 *
 * A person fixing a card types for a minute or two, is interrupted, comes
 * back. Ten minutes covers that and is short enough that yesterday's edits
 * never join today's.
 */
export const HISTORY_WINDOW_MS = 10 * 60 * 1000;

/** The comparison `diffFields` uses, so both ends of the trail agree. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * What one row actually changed.
 *
 * `after` names the fields the writer recorded; a key whose before equals its
 * after was recorded but not changed, and printing it as `X → X` reads like a
 * bug to everyone who is not holding the source.
 */
export function visibleChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): HistoryChange[] {
  return Object.entries(after ?? {})
    .map(([key, value]) => ({ key, before: (before ?? {})[key] ?? null, after: value ?? null }))
    .filter((change) => !same(change.before, change.after));
}

/** Rows are newest first; `newer` sits directly above `older` in the list. */
function joins(newer: HistoryRow, older: HistoryRow, windowMs: number): boolean {
  // Only edits merge. A create, a void or a scan is an event in its own right,
  // and merging across actors would put one person's name on another's work —
  // a null actor is the system, and two system writes are not one sitting.
  if (newer.action !== 'update' || older.action !== 'update') return false;
  if (newer.actorId === null || newer.actorId !== older.actorId) return false;
  return newer.createdAt.getTime() - older.createdAt.getTime() <= windowMs;
}

/** The net of a run: the oldest `before` and the newest `after` per field. */
function netChanges(run: HistoryRow[]): HistoryChange[] {
  const first = new Map<string, unknown>();
  const last = new Map<string, unknown>();
  for (const row of [...run].reverse()) {
    for (const [key, value] of Object.entries(row.after ?? {})) {
      if (!first.has(key)) first.set(key, (row.before ?? {})[key] ?? null);
      last.set(key, value ?? null);
    }
  }
  return [...last.entries()]
    .map(([key, after]) => ({ key, before: first.get(key) ?? null, after }))
    .filter((change) => !same(change.before, change.after));
}

function single(row: HistoryRow): HistoryGroup {
  return {
    id: row.id,
    actorName: row.actorName,
    action: row.action,
    at: row.createdAt,
    rows: [row],
    changes: visibleChanges(row.before, row.after),
  };
}

/**
 * Collapse a newest-first list of audit rows into what happened.
 *
 * @param rows      as fetched: newest first
 * @param windowMs  the longest gap that still counts as one sitting
 */
export function groupHistory(rows: HistoryRow[], windowMs = HISTORY_WINDOW_MS): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  let i = 0;
  while (i < rows.length) {
    let end = i + 1;
    while (end < rows.length && joins(rows[end - 1]!, rows[end]!, windowMs)) end++;
    const run = rows.slice(i, end);
    i = end;

    if (run.length === 1) {
      groups.push(single(run[0]!));
      continue;
    }
    const changes = netChanges(run);
    // A run that nets to nothing is not one story — it is several rows that
    // each recorded no visible change. Merging them would put a count over an
    // empty box, which reads as a screen that failed to load.
    if (changes.length === 0) {
      for (const row of run) groups.push(single(row));
      continue;
    }
    groups.push({
      id: run[0]!.id,
      actorName: run[0]!.actorName,
      action: run[0]!.action,
      at: run[0]!.createdAt,
      rows: run,
      changes,
    });
  }
  return groups;
}
