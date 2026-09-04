import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listImportBatches } from '@/modules/wms/customs/import-service';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { AutoRefresh } from '@/components/auto-refresh';
import { ImportUploadForm } from './upload-form';
import { DeleteBatchButton } from './delete-button';

/**
 * The quarterly customs dump — uploaded here, parsed in the background.
 *
 * His answer 4: the ADMIN uploads the file and the VED only reads from it.
 * The screen is deliberately a list of FACTS, not a chart: which quarter,
 * how many rows, how many the parser refused, and what a failure said —
 * because the person standing here after a failed import needs a sentence,
 * not a colour.
 *
 * Imports ACCUMULATE (his answer 2b): suggestions read the newest READY
 * batch and the older quarters stay for «bu kod avvalgi chorakda qancha
 * edi». A batch can be removed while no calculation has taken a price from
 * it — after that it is that price's provenance and stays.
 */
export default async function CustomsImportPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('admin.dictionaries.manage')) redirect('/');
  const t = await getTranslations('customsImport');
  const format = await getFormatter();

  let batches: Awaited<ReturnType<typeof listImportBatches>> = [];
  try {
    batches = await listImportBatches();
  } catch (err) {
    // Deploy morning: 0094's tables may not exist yet (#472).
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[customs-import] screen: server behind');
  }

  const processing = batches.some((b) => b.status === 'processing');

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      {/* While a file is being parsed the row counter is the progress bar. */}
      {processing ? <AutoRefresh ms={5_000} /> : null}
      <h1 className="text-xl font-bold">📥 {t('title')}</h1>
      <p className="text-2xs text-ink-500">{t('hint')}</p>

      <div className="card !p-3" data-testid="customs-import">
        <ImportUploadForm />

        <div className="table-wrap mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                <th className="p-2">{t('file')}</th>
                <th className="p-2">{t('period')}</th>
                <th className="p-2 text-right">{t('rows')}</th>
                <th className="p-2 text-right">{t('skipped')}</th>
                <th className="p-2">{t('status')}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-line/60" data-testid="import-batch">
                  <td className="p-2">
                    <span className="block truncate" title={b.fileName}>
                      {b.fileName}
                    </span>
                    <span className="text-2xs text-ink-500">
                      {format.dateTime(b.uploadedAt, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </td>
                  <td className="p-2 text-2xs">
                    {b.periodFrom && b.periodTo ? `${b.periodFrom} … ${b.periodTo}` : '—'}
                  </td>
                  <td className="p-2 text-right font-mono tabular-nums">{b.rowCount}</td>
                  <td className="p-2 text-right font-mono tabular-nums text-ink-500">
                    {b.skippedRows}
                  </td>
                  <td className="p-2">
                    {b.status === 'ready' ? (
                      <span className="chip chip-good" data-testid="import-ready">
                        {t('ready')}
                      </span>
                    ) : b.status === 'processing' ? (
                      <>
                        <span className="chip chip-brand">{t('processing')}</span>
                        {/* The row counter moves every ten seconds now, and
                            this is the clock beside it: a beat that stops is
                            how a stuck import used to be invisible. The
                            sweep fails it in words a quarter of an hour
                            later — this is what the person watching sees
                            first. */}
                        {b.heartbeatAt ? (
                          <span className="mt-0.5 block text-2xs text-ink-500">
                            {t('lastBeat', {
                              time: format.dateTime(b.heartbeatAt, { timeStyle: 'medium' }),
                            })}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="chip chip-warn" data-testid="import-failed">
                        {t('failed')}
                      </span>
                    )}
                    {b.error ? (
                      <span className="mt-0.5 block text-2xs text-warn">{b.error}</span>
                    ) : null}
                  </td>
                  <td className="p-2 text-right">
                    {/* A ready batch goes only while nothing is priced off
                        it — the service refuses the rest, in words. */}
                    {b.status === 'processing' ? null : <DeleteBatchButton batchId={b.id} />}
                  </td>
                </tr>
              ))}
              {batches.length === 0 ? (
                <tr>
                  <td className="p-3 text-center text-sm text-ink-500" colSpan={6}>
                    {t('empty')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
