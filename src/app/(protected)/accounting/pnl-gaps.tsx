import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { PnlGaps } from '@/modules/wms/accounting/reports';

/**
 * What the report above could not count, in words (audit A11, A31, U20).
 * Renders nothing when there is nothing to say — a warning that is always
 * there is one nobody reads.
 */
export async function PnlGapsNote({
  gaps,
  legacyFx = null,
  mayOpenFx = false,
}: {
  gaps: PnlGaps;
  /**
   * The legacy kurs farqi residues (0103) — `legacyFxCount`, which the P&L
   * PAGE computes and `pnlGaps` never does (fence F8): the dashboard and the
   * XLSX read `pnlGaps` too and must not pay for a walk of all history.
   */
  legacyFx?: { accounts: number; usd: number } | null;
  /** `mayClassifyFx` — the links to «Kurs qoldiqlari» are its audience's. */
  mayOpenFx?: boolean;
}) {
  if (
    gaps.manualCharges.count === 0 &&
    gaps.unconverted.count === 0 &&
    gaps.onNoBox.count === 0 &&
    gaps.unclassifiedAdjusts.count === 0 &&
    gaps.kassaUsdMissing.count === 0 &&
    gaps.transferUsdMissing.count === 0 &&
    !(legacyFx && legacyFx.accounts > 0)
  ) {
    return null;
  }
  const t = await getTranslations('accounting');
  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="card space-y-2 border-warn/40 bg-warn/5 text-sm" data-testid="pnl-gaps">
      {gaps.manualCharges.count > 0 && (
        <div data-testid="pnl-gap-manual">
          <p className="font-semibold text-warn">
            ⚠{' '}
            {t('gapManualCharges', {
              count: gaps.manualCharges.count,
              usd: `$${usd(gaps.manualCharges.usd)}`,
            })}
          </p>
          <p className="text-xs text-ink-700">
            {t('gapManualChargesHint')}{' '}
            <Link href="/kontragentlar" className="text-brand-700 underline">
              {t('gapOpenPartners')}
            </Link>
          </p>
        </div>
      )}
      {gaps.unconverted.count > 0 && (
        <div data-testid="pnl-gap-unconverted">
          <p className="font-semibold text-warn">
            ⚠{' '}
            {t('gapUnconverted', {
              count: gaps.unconverted.count,
              sums: gaps.unconverted.byCurrency
                .map((row) => `${usd(row.amount)} ${row.currency}`)
                .join(', '),
            })}
          </p>
          <p className="text-xs text-ink-700">{t('gapUnconvertedHint')}</p>
        </div>
      )}
      {gaps.onNoBox.count > 0 && (
        <div data-testid="pnl-gap-no-box">
          <p className="font-semibold text-warn">
            ⚠ {t('gapNoBox', { count: gaps.onNoBox.count, usd: `$${usd(gaps.onNoBox.usd)}` })}
          </p>
          <p className="text-xs text-ink-700">{t('gapNoBoxHint')}</p>
        </div>
      )}
      {/* The kurs farqi the report could not count (0103) — named, never
          guessed into the line. */}
      {gaps.unclassifiedAdjusts.count > 0 && (
        <p className="font-semibold text-warn" data-testid="pnl-gap-adjusts">
          ⚠{' '}
          {t('gapAdjustUnclassified', {
            count: gaps.unclassifiedAdjusts.count,
            usd: `$${usd(gaps.unclassifiedAdjusts.usd)}`,
          })}
          {mayOpenFx && (
            <>
              {' '}
              <Link href="/accounting/kurs-farqi#adjusts" className="font-normal text-brand-700 underline">
                {t('gapOpenFx')}
              </Link>
            </>
          )}
        </p>
      )}
      {legacyFx && legacyFx.accounts > 0 && (
        <p className="font-semibold text-warn" data-testid="pnl-gap-legacy-fx">
          ⚠ {t('gapLegacyFx', { count: legacyFx.accounts, usd: `$${usd(legacyFx.usd)}` })}
          {mayOpenFx && (
            <>
              {' '}
              <Link href="/accounting/kurs-farqi" className="font-normal text-brand-700 underline">
                {t('gapOpenFx')}
              </Link>
            </>
          )}
        </p>
      )}
      {gaps.kassaUsdMissing.count > 0 && (
        <p className="font-semibold text-warn" data-testid="pnl-gap-kassa-usd">
          ⚠ {t('gapKassaUsdMissing', { count: gaps.kassaUsdMissing.count })}
        </p>
      )}
      {gaps.transferUsdMissing.count > 0 && (
        <p className="font-semibold text-warn" data-testid="pnl-gap-transfer-usd">
          ⚠ {t('gapTransferUsdMissing', { count: gaps.transferUsdMissing.count })}
        </p>
      )}
    </div>
  );
}
