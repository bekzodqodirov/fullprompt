import { quietHour } from '../telegram/send';

/**
 * Staff pushes that arrive WITHOUT A SOUND at night (0113).
 *
 * The advert lead is the first staff message that can land at any hour: a
 * form filled at 02:00 is a real enquiry and the seller should find it in
 * the morning, but not be woken by it. The message still goes — only the
 * buzz is dropped (`disable_notification`, the customers' night rule).
 *
 * Decided at SEND time, never at queue time: a row queued at 21:59 and held
 * by a 429 pause until 22:05 is a night send, and one queued at 07:58 and
 * sent at 08:01 is not (the design judge's finding 1).
 *
 * `payload.silent` is the queue-time half, for the one fact only the sender
 * knows: the same seller already had a lead pushed a moment ago, and a flood
 * from a public form must not become a phone that never stops ringing.
 *
 * The AI sotuvchi's cards are the second such stream (his first-set 6 ⭐a,
 * §16.7 «night-silent»): a Chinese supplier writes at 05:00 Beijing time, and
 * the draft, the stranger card, the calculation's answer and the notice that
 * nothing was drafted all wait for the morning — every one of them is held
 * for his ✅ anyway. Deliberately LOUD: `AgentForcedOff` (the machine stopped
 * itself), `TgAccountPaused` (Telegram limited the account) and
 * `AgentCapReached` (customers are going unanswered today) — alarms whose
 * silence costs the account, which is why they ring at any hour.
 */
export const NIGHT_SILENT_TYPES: ReadonlySet<string> = new Set([
  'InboundLeadArrived',
  'AgentDraft',
  'AgentStranger',
  'AgentCalcAnswered',
  'AgentNotice',
]);

export function sendsSilently(
  type: string,
  payload: Record<string, unknown>,
  now: Date,
): boolean {
  return payload.silent === true || (NIGHT_SILENT_TYPES.has(type) && quietHour(now));
}
