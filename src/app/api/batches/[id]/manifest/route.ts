import { guardBatchDocument } from '@/modules/wms/documents/route-guard';
import { buildManifestXlsx } from '@/modules/wms/documents/manifest-xlsx';

/**
 * Actual manifest XLSX — what really departed (fact, not plan).
 *
 * Gated like the screen it backs and like its sibling documents: the invoice
 * and packing routes ask `ved.docs || plans.manage`, and the batch card
 * itself `notFound()`s a truck belonging to neither of the viewer's
 * warehouses. This route asked for a login alone, so a warehouse-scoped
 * operator could pull another country's whole cargo list — every short code,
 * client code, marking and weight — with a batch id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const refused = await guardBatchDocument(id, ['ved.docs', 'plans.manage']);
  if (refused) return refused;

  const buffer = await buildManifestXlsx(id);
  if (!buffer) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="manifest.xlsx"',
    },
  });
}
