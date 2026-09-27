import { getTranslations } from 'next-intl/server';
import { PrintLabels } from '@/components/print-labels';
import type { CountDoorActor } from '@/modules/wms/scanning/count-door';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { qrlessLotsAt } from '@/modules/wms/labels/qrless';

/**
 * «Stiker keyin» for one warehouse (0112, the owner's Q8): the QR-siz lots
 * whose cartons stand HERE, each with a sheet of its own, and one sheet for
 * all of them.
 *
 * A fourth mode of the stocktake's warehouse chooser rather than a screen of
 * its own: this is already the place a warehouse person picks «THIS
 * warehouse» to do something to its cartons, so no menu grows a line.
 */
export async function QrlessPrintList({
  warehouseId,
  actor,
}: {
  warehouseId: string;
  actor: Omit<CountDoorActor, 'id'>;
}) {
  const t = await getTranslations('qrsiz');
  const rows = await qrlessLotsAt(warehouseId, actor);
  const printable = rows.reduce((n, row) => n + row.n, 0);
  const sheet = (lotId?: string) =>
    `/print/qrsiz?warehouseId=${warehouseId}${lotId ? `&lotId=${lotId}` : ''}`;

  if (rows.length === 0) {
    return (
      <p className="card text-sm text-ink-500" data-testid="qr-print-empty">
        {t('sheetEmpty')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-700">{t('listHint')}</p>
      {printable > 0 && (
        <div data-testid="qr-print-all">
          <PrintLabels href={sheet()} label={t('printAll', { n: printable })} />
        </div>
      )}
      <ul className="space-y-2">
        {rows.map((row) => {
          const id = codeIdentity(row.marking, row.clientCode);
          return (
            <li key={row.lotId} className="card space-y-1 !p-3" data-testid="qr-print-lot">
              <div className="flex items-baseline gap-2">
                <span className="whitespace-nowrap font-mono font-extrabold text-brand-700">
                  {id.main}-{row.letter}
                </span>
                {id.sub && <span className="text-2xs text-ink-500">{id.sub}</span>}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {row.productNameZh}
                  {row.productNameRu && <span className="text-ink-500"> ({row.productNameRu})</span>}
                </span>
              </div>
              <p className="font-mono text-xs text-ink-500">{row.receiptNumber}</p>
              {row.plannedLocked > 0 && (
                <p className="text-xs text-ink-700">{t('plannedLocked', { n: row.plannedLocked })}</p>
              )}
              {row.crated > 0 && <p className="text-xs text-ink-700">{t('crated', { n: row.crated })}</p>}
              {row.n > 0 && (
                <PrintLabels variant="secondary" href={sheet(row.lotId)} label={t('printLot', { n: row.n })} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
