import { guardBatchDocument } from '@/modules/wms/documents/route-guard';
import { buildInvoiceXlsx } from '@/modules/wms/documents/ved-xlsx';

/** Invoice draft XLSX (W6). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Permission AND warehouse, in one place for all four batch documents.
  const refused = await guardBatchDocument(id, ['ved.docs', 'plans.manage']);
  if (refused) return refused;

  const buffer = await buildInvoiceXlsx(id);
  if (!buffer) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="invoice-draft.xlsx"',
    },
  });
}
