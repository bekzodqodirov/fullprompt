import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { legacyFxCount, legacyFxResidues, unclassifiedAdjusts, type LegacyFxRow } from '@/modules/wms/finance/fx-legacy';
import type { LegacyState } from '@/modules/wms/finance/fx-residue';
import { fxPnlEffect } from '@/modules/wms/finance/fx-sign';
import { ClassifyAdjust } from '../../kontragentlar/[id]/classify-adjust';
import { CloseAllLegacyButton, CloseLegacyButton } from './legacy-buttons';

export const dynamic = 'force-dynamic';

/**
 * «Kurs qoldiqlari» (0103, design §6.3) — the accountant's one screen for the
 * dollar residues nobody's rule closes by itself, and for the corrections
 * nobody has said the kind of. `finance.manage` AND `finance.reports`
 * (`mayClassifyFx`): a close writes the P&L.
 */
export default async function KursFarqiPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayClassifyFx(actor.permissions)) redirect('/accounting');
  const includeStaff = maySeeStaffMoney(actor.permissions);
  const t = await getTranslations('accounting');
  const tp = await getTranslations('partners');
  const [rows, count, adjusts] = await Promise.all([
    legacyFxResidues({ includeStaff }),
    legacyFxCount({ includeStaff }),
    unclassifiedAdjusts({ includeStaff }),
  ]);
  const money = (value: number) => `$${Math.abs(value).toFixed(2)}`;
  // Literal map (#163): a state the list learns is a type error here.
  const CHIP: Record<LegacyState, { label: string; tone: string }> = {
    auto: { label: t('fxLegacyAuto'), tone: 'bg-surface-sunken text-ink-700' },
    check: { label: t('fxLegacyCheck'), tone: 'bg-warn/15 text-warn' },
    closable: { label: t('fxLegacyClose'), tone: 'bg-brand-50 text-brand-700' },
    hand: { label: t('fxLegacyHand'), tone: 'bg-good/15 text-good' },
  };
  const open = rows.filter((row) => row.state !== 'hand');
  const hand = rows.filter((row) => row.state === 'hand');
  const bulk = rows.filter((row) => row.state === 'auto' || row.state === 'closable');
  const bulkUsd = bulk.reduce((sum, row) => sum + Math.abs(row.residueUsd), 0);

  const item = (row: LegacyFxRow) => {
    const effect = fxPnlEffect(row.ledger, -row.residueUsd);
    const href = row.ledger === 'client' ? `/finance/${row.ownerId}` : `/kontragentlar/${row.ownerId}`;
    return (
      <li key={`${row.ledger}-${row.anchorId}-${row.currency}`} className="space-y-1 border-b border-line py-2 last:border-0" data-testid="fx-legacy-row">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link href={href} className="font-semibold text-brand-700 underline [overflow-wrap:anywhere]">
            {row.code ? <span className="font-mono">{row.code}</span> : null} {row.name}
          </Link>
          <span className={`rounded px-2 py-0.5 text-2xs font-bold ${CHIP[row.state].tone}`}>{CHIP[row.state].label}</span>
        </div>
        <p className="text-xs text-ink-700">
          {t('fxLegacyRow', {
            currency: row.currency,
            date: row.anchorDate,
            usd: money(row.residueUsd),
            month: row.anchorDate.slice(0, 7),
          })}{' '}
          <span className="font-semibold">
            ({t('fxEffect', { kind: effect >= 0 ? 'gain' : 'loss', usd: money(effect) })})
          </span>
        </p>
        {row.state === 'check' && row.ledger === 'partner' && (
          <ul className="space-y-1">
            {row.usdAdjusts
              .filter((adjust) => adjust.kind === null)
              .map((adjust) => (
                <li key={adjust.id} className="text-xs text-ink-700">
                  {t('fxLegacyCheckAdjust', { date: adjust.txDate, usd: money(adjust.usd) })}{' '}
                  <ClassifyAdjust
                    id={adjust.id}
                    compact
                    labels={{ fx: t('fxLegacyAdjustFx'), correction: t('fxLegacyAdjustCorrection') }}
                  />
                </li>
              ))}
          </ul>
        )}
        {row.state === 'check' && row.ledger === 'client' && (
          <p className="text-xs text-warn">{t('fxLegacyCheckUsdRow', { date: row.anchorDate, usd: money(row.residueUsd) })}</p>
        )}
        {row.state !== 'hand' && !(row.state === 'check' && row.ledger === 'partner') && (
          <CloseLegacyButton ledger={row.ledger} ownerId={row.ownerId} anchorId={row.anchorId} currency={row.currency} />
        )}
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="exchange" title={t('fxLegacyTitle')} />
      <p className="text-sm text-ink-700">{t('fxLegacyHint')}</p>

      <section className="card space-y-2 !p-3" data-testid="fx-legacy">
        {open.length === 0 && hand.length === 0 && <p className="text-sm text-ink-500">{t('fxLegacyEmpty')}</p>}
        {bulk.length > 0 && (
          <CloseAllLegacyButton label={t('fxLegacyCloseAll', { count: bulk.length, usd: money(bulkUsd) })} />
        )}
        {open.length > 0 && (
          <p className="text-xs text-ink-500">
            {t('gapLegacyFx', { count: count.accounts, usd: money(count.usd) })}
          </p>
        )}
        <ul>{open.map(item)}</ul>
        {hand.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-500">
              {t('fxLegacyHand')} · {hand.length}
            </summary>
            <ul>{hand.map(item)}</ul>
          </details>
        )}
      </section>

      <section id="adjusts" className="card space-y-2 !p-3" data-testid="fx-unclassified">
        <h2 className="section-title">{t('fxUnclassifiedTitle')}</h2>
        {adjusts.length === 0 && <p className="text-sm text-ink-500">—</p>}
        <ul>
          {adjusts.map((adjust) => (
            <li key={adjust.id} className="space-y-1 border-b border-line py-2 text-sm last:border-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <Link href={`/kontragentlar/${adjust.partnerId}`} className="font-semibold text-brand-700 underline [overflow-wrap:anywhere]">
                  {adjust.partnerName}
                </Link>
                <span className="font-mono text-xs text-ink-500">{adjust.txDate}</span>
                <span className="ml-auto font-mono">
                  {adjust.amount} {adjust.currency}
                </span>
              </div>
              {adjust.note && <p className="text-xs text-ink-500 [overflow-wrap:anywhere]">{adjust.note}</p>}
              <p className="text-xs text-ink-500">
                {tp('adjustKinds.unset')}
                {adjust.authorName ? ` · ${adjust.authorName}` : ''}
              </p>
              <ClassifyAdjust id={adjust.id} compact />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
