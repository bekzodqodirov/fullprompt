import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { labelsForReceipt, recordLabelPrint } from '@/modules/wms/labels/sheet';

const querySchema = z.object({
  lotId: z.string().uuid().optional(),
  boxId: z.string().uuid().optional(),
});

/**
 * "The operator asked to print these stickers."
 *
 * The PDF route records a print as a side effect of generating the file, so
 * merely opening a sheet to look at it stamps every box and adds a row to
 * `/reports/label-prints`. The HTML sheet is a screen — it would be read far
 * more often than it is printed — so the record is a separate, deliberate
 * call made when the print dialog is opened, and the report keeps meaning
 * what a manager reads it to mean.
 *
 * A POST because it writes, and gated exactly as the PDF is: nobody records a
 * print they could not have produced.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const meta = await requestMeta();
  await recordLabelPrint(
    { actorId: actor.id, ...meta },
    sheet,
    sheet.labels.map((l) => l.shortCode),
  );

  return new Response(null, { status: 204 });
}
