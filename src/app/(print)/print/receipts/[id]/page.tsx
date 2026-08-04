import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receipts } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { labelsForReceipt, qrSvg } from '@/modules/wms/labels/sheet';
import { BoxLabelSvg } from '@/components/label-svg';
import { PrintSheet } from '@/components/print-sheet';

const querySchema = z.object({
  lotId: z.string().uuid().optional(),
  boxId: z.string().uuid().optional(),
});

/**
 * The stickers, as a page the phone can print.
 *
 * The same labels the PDF route renders — same builder, so they cannot
 * disagree — laid out as SVG at the same millimetre geometry. The reason it
 * is a page at all is `window.print()`: that is the printer-and-pages dialog
 * the owner asked for, and only a document can open it. A PDF is a file.
 */
export default async function PrintReceiptLabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const query = querySchema.safeParse({
    lotId: typeof raw.lotId === 'string' ? raw.lotId : undefined,
    boxId: typeof raw.boxId === 'string' ? raw.boxId : undefined,
  });
  if (!query.success) notFound();

  const actor = await getActor();
  if (!actor) redirect('/login');

  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, id) });
  if (!receipt) notFound();
  // The same gate as the PDF: whoever may not generate the file may not read
  // the stickers off a screen either. And a receipt from another warehouse is
  // not "forbidden", it is not there (#200).
  if (!actor.permissions.has('receipts.create')) redirect('/');
  if (!inScope(actor, receipt.warehouseId)) notFound();

  const sheet = await labelsForReceipt(id, query.data);
  if (!sheet) notFound();

  const qrs = await Promise.all(sheet.labels.map((label) => qrSvg(label.shortCode)));
  const search = new URLSearchParams();
  if (query.data.lotId) search.set('lotId', query.data.lotId);
  if (query.data.boxId) search.set('boxId', query.data.boxId);
  const suffix = search.size ? `?${search}` : '';

  return (
    <>
      <PrintSheet
        pdfHref={`/api/receipts/${id}/labels${suffix}`}
        recordHref={`/api/receipts/${id}/labels/printed${suffix}`}
        backHref={`/receipts/${id}`}
        fileName={sheet.receiptNumber}
        count={sheet.labels.length}
      />
      {sheet.labels.map((label, i) => (
        <div key={label.shortCode} className="label-frame">
          <BoxLabelSvg label={label} qr={qrs[i]!} />
        </div>
      ))}
    </>
  );
}
