import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { clientBalanceUsd, deferredBalanceUsd } from '@/modules/wms/finance/service';
import { approvalStateFor } from '@/modules/wms/issue/approvals';
import { ISSUABLE_STATUSES } from '@/modules/wms/issue/parties';
import { gatedAt, uncoveredBoxesOn, unpricedGate, unpricedReceiptsOn } from '@/modules/wms/finance/unpriced';
import { compensatedReceiptsAmong } from '@/modules/wms/finance/compensation';

const querySchema = z.object({
  warehouseId: z.string().uuid(),
  clientId: z.string().uuid(),
});

/** Issue mode (W7): the client's issuable boxes at this warehouse. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({
    warehouseId: url.searchParams.get('warehouseId'),
    clientId: url.searchParams.get('clientId'),
  });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });
  let canOverrideDebt = false;
  try {
    const actor = await authorize('scan.issue', { warehouseId: query.data.warehouseId });
    canOverrideDebt = actor.permissions.has('finance.debt_override');
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const rows = await db
    .select({
      boxId: boxes.id,
      shortCode: boxes.shortCode,
      seqInLot: boxes.seqInLot,
      status: boxes.status,
      lotId: receiptLots.id,
      receiptId: receiptLots.receiptId,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.clientId, query.data.clientId),
        eq(boxes.currentWarehouseId, query.data.warehouseId),
        // The same definition of «issuable» the party list is built from, or
        // a row on that list can open onto an empty box screen.
        inArray(boxes.status, [...ISSUABLE_STATUSES]),
      ),
    )
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));

  // Debt gate (Phase 2.1): the screen shows the debt up front so the operator
  // isn't surprised by a blocked confirm. `deferredUsd` is the part the client
  // was given more time for — the screen must say so, otherwise an operator
  // looking at an open gate beside a real debt reads it as a bug and calls the
  // office (docs/DEALS.md).
  const debtUsd = await clientBalanceUsd(query.data.clientId);
  const deferredUsd = await deferredBalanceUsd(query.data.clientId);
  // Phase 6: the live request/approval for this pair, so the screen can say
  // "asked, waiting" or "approved until HH:MM" instead of a dead end.
  const approval = await approvalStateFor(query.data.clientId, query.data.warehouseId);

  // 0104: which of these boxes have no price, and which of those the ban
  // stops — the same fragment and the same `gatedAt` the service will ask on
  // confirm, so a box the screen shows as free is a box the server lets go.
  // Everything on the pool, outside any transaction.
  const gate = await unpricedGate();
  const here = new Set(rows.map((row) => row.boxId));
  const uncovered = (
    await uncoveredBoxesOn(db, { kind: 'client', clientId: query.data.clientId }, { landedOnly: true })
  ).filter((box) => here.has(box.boxId));
  const gatedIds = new Set(uncovered.filter((box) => gatedAt(box.roadLandedAt, gate)).map((box) => box.boxId));
  const uncoveredIds = new Set(uncovered.map((box) => box.boxId));
  const receiptIds = [...new Set(uncovered.map((box) => box.receiptId))];
  const labels = receiptIds.length
    ? await unpricedReceiptsOn(db, { kind: 'receipts', receiptIds }, gate)
    : [];
  const unpriced = labels.map((receipt) => {
    const mine = uncovered.filter((box) => box.receiptId === receipt.receiptId);
    return {
      receiptId: receipt.receiptId,
      number: receipt.number,
      arrivalTrucks: receipt.arrivalTrucks,
      elsewhere: receipt.elsewhere,
      walkIn: receipt.walkIn,
      boxesHere: mine.length,
      gatedHere: mine.filter((box) => gatedIds.has(box.boxId)).length,
    };
  });

  // 0105: a carton found after its prixod's loss was compensated — the
  // screen says so (no amount); the accountant was told by Telegram.
  const compensated = await compensatedReceiptsAmong(rows.map((row) => row.boxId));

  return Response.json({
    boxes: rows.map((row) => ({
      ...row,
      uncovered: uncoveredIds.has(row.boxId),
      gated: gatedIds.has(row.boxId),
    })),
    debtUsd,
    deferredUsd,
    canOverrideDebt,
    approval,
    unpriced,
    compensated,
    gate: gate.state === 'on' ? { state: 'on', since: gate.since.toISOString() } : { state: gate.state, since: null },
  });
}
