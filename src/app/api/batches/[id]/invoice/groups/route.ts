import { invoiceModel, type InvoiceGroupsView } from '@/modules/wms/documents/invoice-rows';
import { guardBatchDocument } from '@/modules/wms/documents/route-guard';
import { invoiceSourceRows } from '@/modules/wms/documents/ved-xlsx';

export const dynamic = 'force-dynamic';

/**
 * What the invoice would ASK before it is downloaded (the owner's item 6,
 * 2026-11-10 — «TNVED kod bir xil bo'lib nomi farq qilsa … shularni ko'rsatib
 * qo'shaymi yo'qmi deb so'rasin va invoice bersin»): the codes that hold two
 * or more positions, from the same source rows the file is written from.
 *
 * A GET route and not a server action: Next runs a page's actions one at a
 * time, and this one would queue behind the editor's AI walk. Never cached —
 * a list of merge candidates must not be yesterday's (`sw.ts` lists it
 * NetworkOnly too).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const refused = await guardBatchDocument(id, ['ved.docs', 'plans.manage']);
  if (refused) return refused;

  const source = await invoiceSourceRows(id);
  if (!source) return new Response('Not found', { status: 404 });
  const model = invoiceModel(source.rows);
  const view: InvoiceGroupsView = {
    fp: model.fp,
    groups: model.groups.map((group) => ({ ...group, customs: source.scopes.get(group.scope) ?? null })),
    positions: model.positions.length,
    red: [...model.redLabels],
    sent: source.batch.sentToAgentAt !== null,
  };
  return Response.json(view, { headers: { 'cache-control': 'private, no-store' } });
}
