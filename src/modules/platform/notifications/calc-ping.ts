import type { NotificationLabels } from './labels';

/**
 * The five calc pings — «🧮 Hisob tayyor», «✅ Hisoblash tayyor», «olindi»,
 * «qaytarildi», «qayta hisoblanmoqda» — and the word on their «↗️» button.
 *
 * Written out HERE because platform must not import wms (TASK_COPY_TYPES'
 * shape). The button is named by TYPE first: a path rule would rename every
 * staff message linking a lead or a deal (task pings, advert leads, thread
 * pings — «↗️ Ochish» is pinned on them, R11/D10), and it could not name the
 * VED's `/hisoblash/<id>` at all.
 */
export const CALC_PING_TYPES = ['CalcSealed', 'CalcDone', 'CalcTaken', 'CalcReturned', 'CalcRecalc'] as const;
export type CalcPingType = (typeof CALC_PING_TYPES)[number];

/**
 * WHICH door the ping's link is — the arm `calcJobDoorFor` answered, stored
 * beside the text by the writer that drew the link (payload `openAs`), so the
 * word and the link are one decision and an edit rebuilds the same button.
 */
export const CALC_OPEN_AS = ['lead', 'deal', 'calc'] as const;
export type CalcOpenAs = (typeof CALC_OPEN_AS)[number];

/**
 * The button's words for a calc ping, or null = the drain's ordinary
 * «↗️ Ochish». Null for every other type whatever its payload says, and for a
 * calc ping written before this (no `openAs`) — it keeps the word it was sent
 * with. Pure: `composeStaffMessage` asks it beside `arrivalOpensDealPicker`.
 */
export function calcPingOpenLabel(
  type: string,
  payload: Record<string, unknown>,
  L: Pick<NotificationLabels, 'openLead' | 'openDeal' | 'openCalc'>,
): string | null {
  if (!(CALC_PING_TYPES as readonly string[]).includes(type)) return null;
  switch (payload.openAs) {
    case 'lead':
      return L.openLead;
    case 'deal':
      return L.openDeal;
    case 'calc':
      return L.openCalc;
    default:
      return null;
  }
}
