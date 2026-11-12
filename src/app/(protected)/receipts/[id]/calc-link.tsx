'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setCalcLinkAction } from '../../hisoblash/nazorat/actions';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';

/**
 * Which CALCULATION priced this cargo (phase E1).
 *
 * The auto guess is deliberately silent whenever a client has two jobs open,
 * which is a busy client's ordinary state — so this picker is not a fallback,
 * it is how the join fills up for exactly the customers who matter most.
 *
 * Rendered only when the deal HAS a sealed calculation: a picker with nothing
 * in it is furniture that teaches a person the feature does not work.
 */
export function CalcLink({
  receiptId,
  currentId,
  currentHref,
  confirmed,
  options,
}: {
  receiptId: string;
  currentId: string | null;
  /**
   * The linked job's own screen, for `ved.docs` only (`calcWorkspaceHref`).
   * The PICKER is the accountant's too (the E1 confirm door, his 'all'
   * scope); the workspace link bounced him home, so it is drawn apart.
   */
  currentHref: string | null;
  confirmed: boolean;
  options: {
    requestId: string;
    section: string;
    sealedAt: string;
    volumeM3: number | null;
    weightKg: number | null;
  }[];
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [requestId, setRequestId] = useState(currentId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The ties' one cell anatomy (docs/PRIXOD-KARTA.md §7.1): label, what it
  // is tied to now, one row to change it — «Saqlash» only once it differs.
  return (
    <div className="space-y-1.5" data-testid="receipt-calc-link">
      <p className="section-title">{t('linkPick')}</p>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {currentId ? (
          <>
            {currentHref ? (
              <Link href={currentHref} className="font-mono text-brand-700 underline" data-testid="receipt-calc-open">
                {t('openCalc')}
              </Link>
            ) : null}
            {confirmed ? <span className="chip chip-good">✓</span> : null}
          </>
        ) : (
          <span className="text-ink-500">{t('linkNoneOnCard')}</span>
        )}
      </p>
      <div className="flex gap-2">
        <select
          value={requestId}
          onChange={(event) => setRequestId(event.target.value)}
          aria-label={t('linkPick')}
          data-testid="receipt-calc-pick"
          className="input-sm min-w-0 flex-1"
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.requestId} value={o.requestId}>
              {t(SECTION_LABELS[o.section as 'podklyuch'] as 'sections.podklyuch')} · {o.sealedAt}
              {o.volumeM3 !== null ? ` · ${o.volumeM3} m³` : ''}
              {o.weightKg !== null ? ` · ${o.weightKg} kg` : ''}
            </option>
          ))}
        </select>
        {requestId !== (currentId ?? '') && (
          <button
            type="button"
            disabled={pending}
            data-testid="receipt-calc-save"
            className="btn-primary btn-sm shrink-0 disabled:opacity-50"
            onClick={() =>
              startTransition(async () => {
                const result = await setCalcLinkAction(receiptId, requestId || null);
                setError(result.ok ? null : (result.error ?? 'error'));
                if (result.ok) router.refresh();
              })
            }
          >
            {pending ? tc('loading') : tc('save')}
          </button>
        )}
      </div>
      {error && (
        <p className="text-sm font-semibold text-bad" role="alert">
          {t.has(`linkErrors.${error}`) ? t(`linkErrors.${error}` as 'linkErrors.not_mine') : tc('error')}
        </p>
      )}
    </div>
  );
}
