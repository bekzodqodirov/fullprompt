import { inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { users } from '../../platform/db/schema';
import { followUps, type FollowUp } from './service';

/**
 * «Mening kunim» — whose calls, and how far back.
 *
 * The owner, 2026-09-14: «moy den degan joyda telefonlar royhati turibti …
 * adminda hozir moy denni ichida hamma odamniki yegilib turib qolgan».
 * Anyone holding `crm.leads.view_all` — him, the logist — got EVERY seller's
 * calls in one flat list, which is not a to-do list at all: nothing on it is
 * his to do, and the one row that is his is buried in a hundred that are not.
 *
 * His answers: **4.1a** mine by default with a «Hammasi · N» door, and — his
 * own addition — the everybody view broken into per-seller folds
 * («hammanikini korganimda yegma bolim bolib»); **4.2a** everything older
 * than a week folded into one line rather than hidden, because his standing
 * rule is that late work must not disappear.
 *
 * ONE function, and both day screens read it: `/bugun` and `/crm/today` are
 * two screens carrying the same title, and the seller's home links to the
 * second — so fixing one of them would have left his complaint alive one tab
 * over (#513, the reason this is a module and not a page).
 */

/** Older than this and a call is a backlog rather than today's work. */
export const STALE_DAYS = 7;

export interface DaySection {
  ownerId: string;
  name: string;
  rows: FollowUp[];
}

export interface DayCalls {
  /** Mine, plus the unclaimed ones (round 74's rule — those are anybody's). */
  mine: FollowUp[];
  /** Mine, but overdue by more than a week — folded behind one line. */
  stale: FollowUp[];
  /** Everybody else's, by seller. Empty unless asked for AND allowed. */
  others: DaySection[];
  /** How many rows belong to other people — printed on the door, always. */
  othersCount: number;
  /** Whether this person may open that door at all. */
  seesAll: boolean;
}

function isStale(row: FollowUp, asOf: string): boolean {
  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - STALE_DAYS);
  return row.dueOn < cutoff.toISOString().slice(0, 10);
}

/**
 * The day's calls for this person.
 *
 * ONE query in both branches (#432): a viewer who sees everything reads the
 * whole list once and it is partitioned here, and a seller's list is narrowed
 * in SQL as it always was. The counts come off the same arrays the rows do,
 * so «Hammasi · 187» can never disagree with what opening it shows (#513).
 */
export async function dayCalls(input: {
  actorId: string;
  seesAll: boolean;
  asOf: string;
  /** The «Hammasi» door. Ignored — not refused — for a seller: there is
   *  nothing behind it for them, and a URL param is not a permission. */
  includeOthers?: boolean;
}): Promise<DayCalls> {
  const rows = await followUps(input.asOf, input.seesAll ? undefined : input.actorId);

  const mineAll = rows.filter((row) => row.ownerId === input.actorId || row.ownerId === null);
  const mine = mineAll.filter((row) => !isStale(row, input.asOf));
  const stale = mineAll.filter((row) => isStale(row, input.asOf));

  if (!input.seesAll) {
    return { mine, stale, others: [], othersCount: 0, seesAll: false };
  }

  // Everybody else's. Unclaimed rows are NOT here — they are in `mine`, for
  // everyone, because an unowned lead is the one anybody may pick up.
  const foreign = rows.filter(
    (row) => row.ownerId !== null && row.ownerId !== input.actorId,
  );
  const byOwner = new Map<string, FollowUp[]>();
  for (const row of foreign) {
    const list = byOwner.get(row.ownerId!);
    if (list) list.push(row);
    else byOwner.set(row.ownerId!, [row]);
  }

  let others: DaySection[] = [];
  if (input.includeOthers && byOwner.size > 0) {
    const names = await db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(inArray(users.id, [...byOwner.keys()]));
    const nameOf = new Map(names.map((row) => [row.id, row.name]));
    others = [...byOwner.entries()]
      .map(([ownerId, list]) => ({
        ownerId,
        name: nameOf.get(ownerId) ?? '—',
        rows: list,
      }))
      // Biggest pile first: that is the seller who needs looking at.
      .sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  }

  return { mine, stale, others, othersCount: foreign.length, seesAll: true };
}

/**
 * The per-seller tail of the morning Telegram message (his 4.3c: «meniki
 * kelsin va sotuvchilar bolimida alisher 4ta Bekzod 5 ta bolib korinsin»).
 *
 * Counts only — names and numbers. A supervisor's phone is not the place to
 * read a hundred other people's call lists, and the screen is one tap away.
 */
export function othersLine(sections: { name: string; rows: unknown[] }[]): string {
  if (sections.length === 0) return '';
  return sections.map((section) => `${section.name} ${section.rows.length} ta`).join(' · ');
}
