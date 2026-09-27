import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { pickupLines, pickups, pickupStops, receipts, warehouses } from '../../platform/db/schema';
import { b, h } from '../../platform/telegram/format';
import { clientLabels, fillLabel } from '../../platform/telegram/client-labels';
import type { NoticeRow, ClientRow, PreparedPush, Skip } from '../notices/client-push';
import { boxesText, headerLine, joinBlocks, PUSH_LOT_LINES, totalLine } from '../notices/client-text';

/**
 * «Yukingiz zavoddan olindi» (owner's B4a: a message when it is picked up,
 * and again at the warehouse). Claimed by `collectStop` inside the press's
 * own transaction, sent by the SAME sweep and the same rules as every other
 * customer notice (notices/arrival-jobs.ts since round C, where this file's
 * own claim-and-send loop was folded in): a CLAIM so two overlapping sweeps
 * split the work, a deadline on every call, transient-vs-permanent refusals,
 * and a five-attempt budget.
 *
 * What it deliberately does not carry: a date (a single figure from an
 * uncalibrated estimate is a promise nobody made), the truck, the photograph
 * (there are no lots yet) and the cabinet button — the cabinet is built from
 * boxes, and there are none yet.
 */

export interface PickedUpLine {
  goods: string;
  boxes: number;
}

/**
 * Pure — the wording is testable in every language without Telegram or a
 * database. HTML since round C: the goods are the factory's free text and go
 * through `h()`, like every typed value in a customer's message.
 *
 * `place` is the warehouse the truck is heading to, as the customer reads it
 * — its NAME since round C (the argument once carried the staff code).
 */
export function pickedUpText(
  lines: PickedUpLine[],
  clientCode: string,
  place: string,
  locale?: string | null,
): string {
  const t = clientLabels(locale);
  const total = lines.reduce((sum, line) => sum + line.boxes, 0);
  const shown = lines.slice(0, PUSH_LOT_LINES).map((line) => {
    const goods = line.goods.replace(/\s+/g, ' ').trim();
    const clipped = goods.length > 80 ? `${goods.slice(0, 79)}…` : goods;
    return `📦 ${h(clipped)} — ${boxesText(line.boxes, locale)}`;
  });
  if (lines.length > PUSH_LOT_LINES) {
    shown.push(h(fillLabel(t.pushMoreLots, { n: lines.length - PUSH_LOT_LINES })));
  }
  return joinBlocks(
    [b(h(t.pickedUpTitle)), headerLine(clientCode, '', null)],
    [...shown, totalLine(total, null, locale)],
    [`${h(t.pickedUpOnWay)}: ${h(place)}`, h(t.pickedUpNote)],
  );
}

/** What to say, read at SEND time: the trip may have been cancelled, the cargo already received. */
export async function pickedUpMessageFor(noticeClientId: string, stopId: string) {
  const [row] = await db
    .select({ status: pickups.status, destCode: warehouses.code, destName: warehouses.name })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .innerJoin(warehouses, eq(pickups.destWarehouseId, warehouses.id))
    .where(eq(pickupStops.id, stopId));
  if (!row) return { skip: 'stop_gone' as const };
  if (row.status === 'cancelled') return { skip: 'cancelled' as const };
  const [received] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.pickupStopId, stopId), eq(receipts.clientId, noticeClientId), isNull(receipts.voidedAt)))
    .limit(1);
  // The warehouse got there first: «keldi» has been (or is being) said, and
  // «olindi» after it would tell the customer something older than they know.
  if (received) return { skip: 'already_received' as const };
  const lines = await db
    .select({ goods: pickupLines.goods, factoryBoxes: pickupLines.factoryBoxes, driverBoxes: pickupLines.driverBoxes })
    .from(pickupLines)
    .where(and(eq(pickupLines.stopId, stopId), eq(pickupLines.clientId, noticeClientId)));
  if (!lines.length) return { skip: 'no_lines' as const };
  return {
    // The driver's recount when he gave one: it is what is on the truck.
    lines: lines.map((l) => ({ goods: l.goods, boxes: l.driverBoxes ?? l.factoryBoxes })),
    warehouseCode: row.destCode,
    warehouseName: row.destName,
  };
}

/** The sweep's renderer for this kind (notices/arrival-jobs.ts). */
export async function preparePickupNotice(notice: NoticeRow, client: ClientRow): Promise<PreparedPush | Skip> {
  const message = await pickedUpMessageFor(notice.clientId, notice.refId);
  if (message.skip !== undefined) return { skip: message.skip };
  const place = message.warehouseName || message.warehouseCode;
  return {
    render: (locale) => ({ text: pickedUpText(message.lines, client.clientCode, place, locale), caption: null }),
    keyboard: null,
    photo: null,
  };
}
