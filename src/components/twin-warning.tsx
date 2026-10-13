'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { TwinLine, TwinView } from '@/modules/wms/accounting/twins';

/**
 * «⚠ Bu pul allaqachon yozilgan bo'lishi mumkin» (docs/SARFLAR.md §3, his
 * answer 6: «saqlashdan oldin ogohlantirsin qayerda shu qayta yozilayotganini»).
 * A confirm, never a refusal: nothing was written, the form behind it still
 * holds what was typed, and «Baribir saqlash» re-posts it with the token the
 * server computed — any change in between is asked about again.
 *
 * ONE component for the three doors (the cost form, the per-prixod grid, the
 * expense form), so the same pair reads in the same words wherever it is met.
 * Every word is a literal key (#163): the shape and the cure are closed unions.
 */
const SHAPE = {
  same_kassa: 'shape.same_kassa',
  kassa_cash: 'shape.kassa_cash',
  same_partner: 'shape.same_partner',
  debt_paid: 'shape.debt_paid',
  mergeable: 'shape.mergeable',
} as const satisfies Record<TwinLine['shape'], string>;

const CURE = { merge: 'cure.merge', repay: 'cure.repay', void: 'cure.void' } as const satisfies Record<
  TwinLine['cure'],
  string
>;
const BOOK = { expense: 'book.expense', cost: 'book.cost' } as const satisfies Record<TwinLine['book'], string>;

export function TwinWarning({
  twins,
  busy,
  onSaveAnyway,
  onBack,
  cellLabel,
}: {
  twins: TwinView;
  busy: boolean;
  onSaveAnyway: () => void;
  onBack: () => void;
  /** The grid only: a cell key (`receiptId:costTypeId`) in words. */
  cellLabel?: (cell: string) => string | null;
}) {
  const t = useTranslations('twins');
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="twin-warning">
      <p className="font-semibold text-warn">⚠ {t('title')}</p>
      <p className="text-ink-700">{t('hint')}</p>
      <ul className="space-y-1.5">
        {twins.lines.map((line) => (
          <li key={line.key} className="rounded bg-surface p-2 [overflow-wrap:anywhere]" data-testid="twin-line">
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              <span className="font-semibold">{t(BOOK[line.book])}</span>
              <span>{line.date}</span>
              <span className="font-mono tabular-nums">
                {line.amount} {line.currency}
              </span>
              {line.sum && <span className="text-ink-500">({t('sum')})</span>}
              {line.label && <span>{line.label}</span>}
              {line.where && <span className="text-ink-700">{line.where}</span>}
              {line.kassa && <span>🏦 {line.kassa}</span>}
              {line.who && <span className="text-ink-500">✍ {line.who}</span>}
              {line.cell && cellLabel?.(line.cell) && (
                <span className="text-ink-500">→ {cellLabel(line.cell)}</span>
              )}
            </div>
            {line.redacted ? (
              <p className="text-xs text-ink-500">{t('redacted')}</p>
            ) : (
              <p className="text-xs text-ink-700">
                {t(SHAPE[line.shape])} · {t(CURE[line.cure])}
                {/* The merge's own screen. Every reader who is shown a twin
                    holds finance.expenses, that screen's door (§8.2). */}
                {line.cure === 'merge' && (
                  <>
                    {' '}
                    <Link href="/accounting/xarajat-kassa" className="font-semibold underline" target="_blank">
                      {t('mergeLink')} →
                    </Link>
                  </>
                )}
              </p>
            )}
          </li>
        ))}
      </ul>
      {twins.more > 0 && <p className="text-xs text-ink-500">{t('more', { count: twins.more })}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="twin-save-anyway"
          className="btn-secondary flex-1 disabled:opacity-50"
          disabled={busy}
          onClick={onSaveAnyway}
        >
          {t('saveAnyway')}
        </button>
        <button type="button" data-testid="twin-back" className="btn-primary flex-1" onClick={onBack}>
          {t('back')}
        </button>
      </div>
    </div>
  );
}
