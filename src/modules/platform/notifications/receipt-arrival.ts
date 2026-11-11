import { roundKg, roundM3, sumRounded } from '../telegram/format';
import { fillCount, type NotificationLabels } from './labels';

/**
 * «Prixod keldi» — the ONE message a prixod's seller gets (the owner,
 * 2026-11-11: «prixod kelganda … 2 marta sms boryabti … prixod keldi desin
 * sotuvchiga klient karobka soni tovar nomlari kg kub shunda ikta button
 * bolsin file qoshish va bitim biriktirish»; docs/PRIXOD-XABARI.md §C).
 *
 * Before this the seller of a deal-less prixod was told twice: once by
 * `ReceiptConfirmed` («📥 Prixod …») and once by price control's alert
 * (`UnlinkedCargo` / `UnquotedCargo`). The alert EVENTS are still emitted —
 * the owner's automation rules listen to them — but they write no rows any
 * more: the `ReceiptConfirmed` row carries what both said.
 *
 * Everything that decides «is this row the new message» lives here, in a leaf
 * the recipients, the renderer, the open button's label and the bot's button
 * row all ask (#513): `payload.dealState` is one of the four strings. A row
 * written before this release has none, and renders, counts and behaves
 * exactly as it always did (#688's rule about old payloads).
 */
export const RECEIPT_DEAL_STATES = ['none', 'attachable', 'unpriced', 'priced'] as const;

/**
 * What the prixod's deal looked like the moment the fact was written:
 *   none       — no deal of its client's on the prixod, and the client has no
 *                open deal worth attaching to (one with a price or a goods list);
 *   attachable — no deal on the prixod, the client has such open deals;
 *   unpriced   — on a deal of its client's that carries no price;
 *   priced     — on a priced deal of its client's.
 * «A deal of its client's» is `ownDealOf`'s rule (finance/truck-deal.ts): a
 * deal left behind by a client correction belongs to somebody else's job and
 * is no deal here.
 */
export type ReceiptDealState = (typeof RECEIPT_DEAL_STATES)[number];

export function isReceiptDealState(value: unknown): value is ReceiptDealState {
  return typeof value === 'string' && (RECEIPT_DEAL_STATES as readonly string[]).includes(value);
}

/** The types a «Prixod keldi» row may be written under (see `arrivalAlertOf`). */
const ARRIVAL_ROW_TYPES: readonly string[] = ['ReceiptConfirmed', 'UnlinkedCargo', 'UnquotedCargo'];

/** THE predicate: is this notification row the new one-message prixod? */
export function isReceiptArrival(type: string, payload: Record<string, unknown>): boolean {
  return ARRIVAL_ROW_TYPES.includes(type) && isReceiptDealState(payload.dealState);
}

/**
 * The alarm a state stands for — the event price control emits for it, and
 * the type the folded row is ALSO heard under. A Record over the states, so a
 * fifth state is a compile error until somebody says what it alarms.
 */
const ARRIVAL_ALERT: Record<ReceiptDealState, 'UnlinkedCargo' | 'UnquotedCargo' | null> = {
  none: 'UnquotedCargo',
  attachable: 'UnlinkedCargo',
  unpriced: 'UnquotedCargo',
  priced: null,
};

export function alertOfDealState(state: ReceiptDealState): 'UnlinkedCargo' | 'UnquotedCargo' | null {
  return ARRIVAL_ALERT[state];
}

/**
 * The alarm folded into a `ReceiptConfirmed` EVENT — null for an old event, a
 * priced prixod, and the claim door (`via: 'assign'`): giving unclaimed cargo
 * its owner has never run price control, emits no alert event, and must not
 * start alarming the admins about cargo that came weeks ago.
 */
export function arrivalAlertOf(payload: Record<string, unknown>): 'UnlinkedCargo' | 'UnquotedCargo' | null {
  if (!isReceiptDealState(payload.dealState) || payload.via === 'assign') return null;
  return ARRIVAL_ALERT[payload.dealState];
}

/** Does the card link open the prixod AT its deal picker («🔗 Bitim biriktirish»)? */
export function arrivalOpensDealPicker(type: string, payload: Record<string, unknown>): boolean {
  return isReceiptArrival(type, payload) && (payload.dealState === 'none' || payload.dealState === 'attachable');
}

/** The anchor of the prixod card's deal block. */
export const RECEIPT_DEAL_ANCHOR = 'bitim';

interface ArrivalLot {
  letter?: unknown;
  productNameZh?: unknown;
  productNameRu?: unknown;
  boxCount?: unknown;
  totalWeightKg?: unknown;
  totalVolumeM3?: unknown;
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A prixod's totals AS ITS LINES PRINT: every lot rounded the way the line
 * shows it (kilos to two places, cubic metres to three — the customer's push
 * prints the same), then summed and rounded again, so «Jami» is what a person
 * adding the lines up gets. The alert's own totals were raw float sums
 * («12.450000000000001 kg»).
 */
export function arrivalTotals(lots: readonly ArrivalLot[]): { boxCount: number; weightKg: number; volumeM3: number } {
  return {
    boxCount: lots.reduce((sum, lot) => sum + num(lot.boxCount), 0),
    weightKg: sumRounded(lots.map((lot) => num(lot.totalWeightKg)), roundKg),
    volumeM3: sumRounded(lots.map((lot) => num(lot.totalVolumeM3)), roundM3),
  };
}

/** Lot lines drawn before «… yana N ta» — a prixod of forty goods must not be refused whole by Telegram. */
export const ARRIVAL_LOTS_SHOWN = 12;

function dealLine(payload: Record<string, unknown>, L: NotificationLabels): string | null {
  const code = typeof payload.dealCode === 'string' ? payload.dealCode : '';
  switch (payload.dealState as ReceiptDealState) {
    case 'none':
      return `⚠️ ${L.arrivalNoDeal}`;
    case 'attachable': {
      const open = Array.isArray(payload.openDealCodes) ? (payload.openDealCodes as unknown[]).map(String).join(', ') : '';
      return `📎 ${L.unlinkedMark}` + (open ? `\n${L.openDealsWord}: ${open}` : '');
    }
    case 'unpriced':
      return `💰 ${L.arrivalUnpriced.replace('{code}', code)}`;
    case 'priced':
      return code ? `🔗 ${L.arrivalDeal.replace('{code}', code)}` : null;
  }
}

/**
 * The message, in the reader's language. Pure: the same payload renders the
 * same words for the seller, for an admin who hears it as the alarm, and for
 * an edit of a sent copy.
 *
 * The LAST line is the card link, alone — the drain lifts it into the URL
 * button (`takeOwnLink`), and where it cannot (a non-https APP_URL, a refused
 * button) the link stays readable in the text.
 */
export function receiptArrivalText(
  payload: Record<string, unknown>,
  L: NotificationLabels,
  appUrl: string,
): string {
  const lots = Array.isArray(payload.lots) ? (payload.lots as ArrivalLot[]) : [];
  const head = payload.via === 'assign' ? L.receiptAssigned : L.receiptArrived;
  const lines: string[] = [
    `📥 ${head} — ${String(payload.number ?? '')}`,
    `${L.client}: ${String(payload.clientCode ?? '—')} (${String(payload.clientName ?? '—')})`,
  ];
  const deal = dealLine(payload, L);
  if (deal) lines.push(deal);
  lines.push(`${L.warehouse}: ${String(payload.warehouseCode ?? '')}`, '');
  for (const lot of lots.slice(0, ARRIVAL_LOTS_SHOWN)) {
    const ru = typeof lot.productNameRu === 'string' && lot.productNameRu ? ` (${lot.productNameRu})` : '';
    lines.push(
      `${String(lot.letter ?? '')} — ${String(lot.productNameZh ?? '')}${ru}: ` +
        `${num(lot.boxCount)} ${L.boxesShort}, ${roundKg(num(lot.totalWeightKg))} ${L.kg}, ${roundM3(num(lot.totalVolumeM3))} ${L.m3}`,
    );
  }
  if (lots.length > ARRIVAL_LOTS_SHOWN) lines.push(fillCount(L.andMore, lots.length - ARRIVAL_LOTS_SHOWN));
  if (lots.length > 1) {
    const total = arrivalTotals(lots);
    lines.push(`${L.totalWord}: ${total.boxCount} ${L.boxesShort} · ${total.weightKg} ${L.kg} · ${total.volumeM3} ${L.m3}`);
  }
  const anchor = arrivalOpensDealPicker('ReceiptConfirmed', payload) ? `#${RECEIPT_DEAL_ANCHOR}` : '';
  lines.push('', `${appUrl}/receipts/${String(payload.receiptId ?? '')}${anchor}`);
  return lines.join('\n');
}
