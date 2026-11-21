import type { AviaDays } from '../../platform/settings/service';
import type { NumberSource } from './numbers';

/**
 * The flight's days among a draft's number sources (stage 1a P7, J2) — one home for the rows that carry his setting
 * `agent_avia_days`, so the run that writes them and the press that reads them again name the same rows.
 */

/** The company's own rules among a draft's number sources (run `memoryFor`), as the card's «🔢 Raqamlar» names them. */
export const COMPANY_RULE = 'kompaniya qoidasi';

/** The avia tool's own day sources (tools `avia_estimate`). */
export const AVIA_DAYS_LABEL = 'avia muddati';

/**
 * The flight's days as the company's rule: the pair rule 9 TOLD this run (`LoopResult.aviaDays`, his setting), each a
 * day count said of the flight — and nothing else. The old «2–5 kun» and the flight clause he did not repeat («reys
 * bo‘lsa 2 kun») are then a day nobody vouches for; a run that told no days (a tayyor matn) vouches for none.
 */
export function aviaDaySources(days: AviaDays | null): NumberSource[] {
  if (days === null) return [];
  return [days.min, days.max].map((value): NumberSource => ({ value, kind: 'duration', label: COMPANY_RULE, origin: 'kb', mode: 'air', unit: 'day' }));
}

/** A day row his setting owns: the company rule's or the avia tool's day count of the flight. */
function settingDayRow(s: NumberSource): boolean {
  return s.kind === 'duration' && s.mode === 'air' && (s.label === COMPANY_RULE || s.label === AVIA_DAYS_LABEL);
}

/**
 * A stored draft's sources with the flight's days as his setting says them NOW (the P7 review's N2) — what the policy
 * judges a reply by when it runs again at ✅ and at the machine's press (`policyFor`). Without it a draft written
 * before he changed «3-5» to «4-7» — or before the deploy, on the old «2-5, reys bo‘lsa 2» — still vouched for its
 * own run's days and left with them, by his press or the machine's. The avia rate retires such drafts up front
 * (config `setAviaRate`), because its label alone shows which draft was priced; whether a reply SAYS a day needs the
 * body read, so the press reads again instead — the way the warehouse address is read now and not remembered.
 *
 * Each row the company rule or the avia tool stored takes today's pair in its own shape (label, origin, tool and unit
 * kept from the stored row); a draft whose run vouched for no day (a tayyor matn) gains none. A knowledge fact's own
 * day count is untouched: it is his words, and a fact that disagrees with the setting is a chore on «Bilimlar» (J2),
 * never a figure the code quietly takes away.
 */
export function withAviaDaysNow(sources: readonly NumberSource[], days: AviaDays): NumberSource[] {
  // In place, at the first row of each label: on a draft whose run was told today's pair every figure comes back where
  // it stood, so the write's own check and every card's ledger read exactly as they did.
  const seen = new Set<string>();
  return sources.flatMap((s): NumberSource[] => {
    if (!settingDayRow(s)) return [s];
    if (seen.has(s.label)) return [];
    seen.add(s.label);
    return [{ ...s, value: days.min }, { ...s, value: days.max }];
  });
}
