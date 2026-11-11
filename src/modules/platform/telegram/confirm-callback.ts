/**
 * The customer's ✅ / ❌ button under a push (0144, docs/TARKIB-TAKLIFLAR.md
 * §4.2): `yt:<1|0>:<receipt id>:<tag>` — the verdict, the prixod the message
 * was about, and eight hex digits of the facts it printed.
 *
 * Fifty bytes. Telegram's limit is 64, and a refused button drops the WHOLE
 * keyboard (`send.ts`), the Mini App and the manager door with it — so the
 * builder refuses to build anything the parser would not read back.
 *
 * Pure, and in platform: the keyboard is built here (`menu-button.ts`) and
 * the press is heard here (`client-cabinet.ts`); what the tag MEANS is wms's
 * (`wms/receipts/client-confirm.ts`), which hands over the receipt and the
 * tag and is asked back with them. The staff parser (`parseCallback`) owns
 * no `yt` prefix and answers null for these — pinned, because a customer
 * callback the staff handler swallowed would spin unanswered for 15 seconds.
 */

/** What every such button starts with — the handler is registered on this. */
export const CONFIRM_PREFIX = 'yt:';

const SHAPE = /^yt:([01]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8})$/;

export type ConfirmVerdict = 'yes' | 'no';

export interface ConfirmAsk {
  receiptId: string;
  tag: string;
}

/** The button's data — or null for an id or a tag that is not one (no button is better than a dead keyboard). */
export function confirmCallback(verdict: ConfirmVerdict, ask: ConfirmAsk): string | null {
  const data = `${CONFIRM_PREFIX}${verdict === 'yes' ? '1' : '0'}:${ask.receiptId}:${ask.tag}`;
  return SHAPE.test(data) ? data : null;
}

/** A press read back; null = not this grammar (an old or a hand-made button). */
export function parseConfirmCallback(data: string): (ConfirmAsk & { verdict: ConfirmVerdict }) | null {
  const m = SHAPE.exec(data);
  return m ? { verdict: m[1] === '1' ? 'yes' : 'no', receiptId: m[2]!, tag: m[3]! } : null;
}

/** Is this a button of the ✅ / ❌ row? — for taking the row off a pressed message. */
export function isConfirmButton(button: unknown): boolean {
  const data = (button as { callback_data?: unknown } | null)?.callback_data;
  return typeof data === 'string' && data.startsWith(CONFIRM_PREFIX);
}
