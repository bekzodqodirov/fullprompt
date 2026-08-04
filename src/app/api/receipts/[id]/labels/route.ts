import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { labelRenderer } from '@/modules/wms/labels/renderer';
import { labelsForReceipt, recordLabelPrint } from '@/modules/wms/labels/sheet';

const querySchema = z.object({
  lotId: z.string().uuid().optional(),
  boxId: z.string().uuid().optional(),
});

/**
 * The 100×100 mm label PDF for a receipt / lot / single box.
 *
 * Still here, and still the right answer for two cases: Android's RawBT picks
 * a PDF up and drives the paired thermal printer with it, and the iOS share
 * sheet hands a FILE to AirPrint or to the printer's own app. The HTML sheet
 * at `/print/receipts/[id]` is the other route — it opens the phone's own
 * printer-and-page dialog — and both build their label list from the same
 * function, so the two can never disagree about what belongs on a box.
 */
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

  const sheet = await labelsForReceipt(id, query.data);
  if (!sheet) return new Response('Not found', { status: 404 });

  const pdf = await labelRenderer.render(sheet.labels);

  const meta = await requestMeta();
  await recordLabelPrint(
    { actorId: actor.id, ...meta },
    sheet,
    sheet.labels.map((l) => l.shortCode),
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="labels-${sheet.receiptNumber}.pdf"`,
    },
  });
}
