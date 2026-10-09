import { needLawOf, type NeedLaw } from './needs';

/**
 * The BOOK's law for each code a door's goods carry — what the checklist and
 * the bot's line questions ask before any person has grouped anything
 * (2026-10-09, judge TT-5). A 6110 sweater stating only kg owes its count
 * («boj kamida $X/dona»), and the only place that is written down before the
 * workspace exists is the rates book.
 *
 * ON THE POOL, and called BEFORE any transaction (#714): the callers are the
 * bot, the thread door, the card door's answer and the queue's projections,
 * none of which holds one. ONE `ratesForCodes` per call (#432), keyed by the
 * code as the line carries it. A dynamic import, because `dictionaries.ts`
 * imports the service this is read beside.
 *
 * The book knows nothing of a job's lgota or a specific excise — those are a
 * group's own answers, made in the workspace — so a book law is never
 * duty-free and carries no excise; the VED page reads the GROUP's law
 * instead for a grouped line (`CalcGoodsFact.law`, judge S9).
 */
export async function bookLawsFor(
  codes: readonly (string | null | undefined)[],
): Promise<Map<string, NeedLaw>> {
  const list = [...new Set(codes.map((c) => c?.trim() ?? '').filter(Boolean))];
  if (list.length === 0) return new Map();
  const { ratesForCodes, onDate } = await import('./dictionaries');
  const rates = await ratesForCodes(list, onDate());
  const out = new Map<string, NeedLaw>();
  for (const [code, r] of rates) {
    out.set(
      code,
      needLawOf({ dutyMode: r.dutyMode, dutyUnit: r.dutyUnit, dutySpecific: r.dutySpecific, dutyFree: false }),
    );
  }
  return out;
}
