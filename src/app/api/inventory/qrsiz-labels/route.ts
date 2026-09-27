import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { labelRenderer } from '@/modules/wms/labels/renderer';
import { qrlessLabelsAt } from '@/modules/wms/labels/qrless';

const querySchema = z.object({
  warehouseId: z.string().uuid(),
  lotId: z.string().uuid().optional(),
  boxId: z.string().uuid().optional(),
});

/**
 * The QR-siz cartons' stickers as a PDF (0112) — the share sheet and RawBT
 * way out of the print-later sheet, beside its print dialog.
 *
 * Gated at the warehouse the cartons STAND in, the one named in the query:
 * never the receipt's, which is where the goods were received (critique b8 —
 * the Tashkent operator labels the Yiwu prixod's sacks in front of them).
 *
 * It stamps NOTHING, unlike the receipt's PDF: a generated file is not a
 * sticker on a carton, and here the difference decides whether the phones
 * start expecting a scan. The «stikerlar yopishtirildi» press does that.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({
    warehouseId: url.searchParams.get('warehouseId') ?? undefined,
    lotId: url.searchParams.get('lotId') ?? undefined,
    boxId: url.searchParams.get('boxId') ?? undefined,
  });
  if (!query.success) return new Response('Bad request', { status: 400 });

  let actor;
  try {
    actor = await authorize('receipts.create', { warehouseId: query.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }

  const sheet = await qrlessLabelsAt(
    query.data.warehouseId,
    { lotId: query.data.lotId, boxId: query.data.boxId },
    actor,
  );
  if (!sheet || sheet.labels.length === 0) return new Response('Not found', { status: 404 });

  const pdf = await labelRenderer.render(sheet.labels);
  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${sheet.hereCode}-QR.pdf"`,
    },
  });
}
