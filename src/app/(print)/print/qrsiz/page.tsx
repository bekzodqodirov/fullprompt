import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { qrSvg } from '@/modules/wms/labels/sheet';
import { qrlessLabelsAt } from '@/modules/wms/labels/qrless';
import { QRLESS_SHEET_CAP } from '@/modules/wms/labels/qrless-sql';
import { BoxLabelSvg } from '@/components/label-svg';
import { PrintSheet } from '@/components/print-sheet';
import { QrStuckConfirm } from '@/components/qr-stuck-confirm';

const querySchema = z.object({
  warehouseId: z.string().uuid(),
  lotId: z.string().uuid().optional(),
  boxId: z.string().uuid().optional(),
});

/**
 * «Stiker keyin» — the stickers a QR-siz lot never got, for the cartons
 * standing at THIS warehouse (0112, the owner's Q8: «printer bo'lmagan joyda
 * qabul qilamiz, keyin chop etamiz»).
 *
 * The same sticker the receipt's sheet draws (`labelFor`), and the same print
 * dialog — but the sheet records NOTHING when it prints. The cartons become
 * «expect a scan» only when the operator says the stickers are ON, with the
 * button under the toolbar, which posts exactly the ids drawn here.
 */
export default async function PrintQrlessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = querySchema.safeParse({
    warehouseId: typeof raw.warehouseId === 'string' ? raw.warehouseId : undefined,
    lotId: typeof raw.lotId === 'string' ? raw.lotId : undefined,
    boxId: typeof raw.boxId === 'string' ? raw.boxId : undefined,
  });
  if (!query.success) notFound();

  const actor = await getActor();
  if (!actor) redirect('/login');
  // The PDF's own gate, at the warehouse the cartons stand in (#200: another
  // warehouse's cargo is not «forbidden», it is not there).
  if (!actor.permissions.has('receipts.create')) redirect('/');
  if (!inScope(actor, query.data.warehouseId)) notFound();

  const t = await getTranslations('qrsiz');
  const tc = await getTranslations('common');
  const sheet = await qrlessLabelsAt(
    query.data.warehouseId,
    { lotId: query.data.lotId, boxId: query.data.boxId },
    actor,
  );
  if (!sheet) notFound();
  const backHref = `/inventory?warehouseId=${query.data.warehouseId}&mode=stiker`;

  if (sheet.labels.length === 0) {
    return (
      <div className="no-print m-4 space-y-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm" data-testid="qr-print-empty">
        <p>{t('sheetEmpty')}</p>
        <a href={backHref} className="font-semibold text-brand-700 underline">
          ← {tc('back')}
        </a>
      </div>
    );
  }

  const qrs = await Promise.all(sheet.labels.map((label) => qrSvg(label.shortCode)));
  const search = new URLSearchParams({ warehouseId: query.data.warehouseId });
  if (query.data.lotId) search.set('lotId', query.data.lotId);
  if (query.data.boxId) search.set('boxId', query.data.boxId);

  return (
    <>
      <PrintSheet
        pdfHref={`/api/inventory/qrsiz-labels?${search}`}
        backHref={backHref}
        fileName={`${sheet.hereCode}-QR`}
        count={sheet.labels.length}
      />
      {sheet.total > sheet.labels.length && (
        <p className="no-print mb-3 px-3 text-sm font-semibold text-warn" data-testid="qr-sheet-capped">
          {t('sheetCapped', { cap: QRLESS_SHEET_CAP, rest: sheet.total - sheet.labels.length })}
        </p>
      )}
      <div className="no-print px-3">
        <QrStuckConfirm warehouseId={query.data.warehouseId} boxIds={sheet.boxIds} backHref={backHref} />
      </div>
      {sheet.labels.map((label, i) => (
        <div key={label.shortCode} className="label-frame">
          <BoxLabelSvg label={label} qr={qrs[i]!} />
        </div>
      ))}
    </>
  );
}
