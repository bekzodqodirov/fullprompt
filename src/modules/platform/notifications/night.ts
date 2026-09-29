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
 */
export const NIGHT_SILENT_TYPES: ReadonlySet<string> = new Set(['InboundLeadArrived']);

export function sendsSilently(
  type: string,
  payload: Record<string, unknown>,
  now: Date,
): boolean {
  return payload.silent === true || (NIGHT_SILENT_TYPES.has(type) && quietHour(now));
}
