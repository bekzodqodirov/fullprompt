import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { labelRenderer, type LabelData } from '@/modules/wms/labels/renderer';

const querySchema = z.object({
  lotId: z.string().uuid().optional(),
  boxId: z.string().uuid().optional(),
});

/** Generate the 100×100 mm label PDF for a receipt / lot / single box. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, id) });
  if (!receipt) return new Response('Not found', { status: 404 });

  let actor;
  try {
    actor = await authorize('receipts.create', { warehouseId: receipt.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }

  const url = new URL(request.url);
  const query = querySchema.safeParse({
    lotId: url.searchParams.get('lotId') ?? undefined,
    boxId: url.searchParams.get('boxId') ?? undefined,
  });
  if (!query.success) return new Response('Bad request', { status: 400 });

  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;
  const client = receipt.clientId
    ? await db.query.clients.findFirst({ where: eq(clients.id, receipt.clientId) })
    : null;

  const lots = await db
    .select()
    .from(receiptLots)
    .where(
      query.data.lotId
        ? and(eq(receiptLots.receiptId, id), eq(receiptLots.id, query.data.lotId))
        : eq(receiptLots.receiptId, id),
    )
    .orderBy(asc(receiptLots.seq));
  if (lots.length === 0) return new Response('Not found', { status: 404 });

  const lotIds = lots.map((l) => l.id);
  const boxRows = await db
    .select()
    .from(boxes)
    .where(
      query.data.boxId
        ? and(inArray(boxes.lotId, lotIds), eq(boxes.id, query.data.boxId))
        : inArray(boxes.lotId, lotIds),
    )
    .orderBy(asc(boxes.seqInLot));
  if (boxRows.length === 0) return new Response('Not found', { status: 404 });

  const dateLocal = new Intl.DateTimeFormat('ru-RU', {
    timeZone: warehouse.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(receipt.receivedAt);

  const lotById = new Map(lots.map((l) => [l.id, l]));
  const labels: LabelData[] = boxRows.map((box) => {
    const lot = lotById.get(box.lotId)!;
    const perBoxWeight =
      lot.dimsMode === 'uniform' && lot.boxWeightKg
        ? lot.boxWeightKg
        : (Number(lot.totalWeightKg) / lot.boxCount).toFixed(1);
    return {
      warehouseCode: warehouse.code,
      dateLocal,
      receiptNumber: receipt.number ?? '',
      clientCodeWithLetter: client ? `${client.clientCode}-${lot.letter}` : `#UNKNOWN`,
      unclaimed: !client,
      productZh: lot.productNameZh,
      productRu: lot.productNameRu,
      boxSeq: box.seqInLot,
      boxTotal: lot.boxCount,
      weightKg: perBoxWeight,
      dimsCm:
        lot.dimsMode === 'uniform'
          ? `${lot.boxLengthCm}×${lot.boxWidthCm}×${lot.boxHeightCm}`
          : null,
      shortCode: box.shortCode,
    };
  });

  const pdf = await labelRenderer.render(labels);

  const meta = await requestMeta();
  const now = new Date();
  await db
    .update(boxes)
    .set({ labelPrintedAt: now })
    .where(inArray(boxes.id, boxRows.map((b) => b.id)));
  await writeAudit(
    db,
    { actorId: actor.id, ...meta, warehouseId: warehouse.id },
    {
      entityType: 'receipt',
      entityId: id,
      action: 'label_print',
      after: { count: labels.length, boxes: boxRows.map((b) => b.shortCode) },
    },
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="labels-${receipt.number}.pdf"`,
    },
  });
}
