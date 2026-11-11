import { parseMergeParam } from '@/modules/wms/documents/invoice-rows';
import { guardBatchDocument } from '@/modules/wms/documents/route-guard';
import { buildInvoiceXlsx } from '@/modules/wms/documents/ved-xlsx';

export const dynamic = 'force-dynamic';

/**
 * Invoice draft XLSX (W6). `?merge=` carries the answers of the «qo'shaymi?»
 * dialog (`invoice-download.tsx`): the groups to print as ONE position, each
 * with the signature it was listed under. Read as a forged post — garbage is
 * dropped, a stale signature merges nothing — so a bare address is always the
 * draft with every asked group printed apart.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Permission AND warehouse, in one place for all four batch documents.
  const refused = await guardBatchDocument(id, ['ved.docs', 'plans.manage']);
  if (refused) return refused;

  const answer = parseMergeParam(new URL(request.url).searchParams.get('merge'));
  const buffer = await buildInvoiceXlsx(id, answer);
  if (!buffer) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="invoice-draft.xlsx"',
      // The rows follow the codes saved a minute ago: never yesterday's file.
      'cache-control': 'private, no-store',
    },
  });
}
