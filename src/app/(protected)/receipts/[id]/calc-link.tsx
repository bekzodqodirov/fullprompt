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
  confirmed,
  options,
}: {
  receiptId: string;
  currentId: string | null;
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

  return (
    <div className="card space-y-2 !p-3" data-testid="receipt-calc-link">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{t('linkPick')}:</span>
        {currentId ? (
          <>
            <Link
              href={`/hisoblash/${currentId}`}
              className="font-mono text-brand-700 underline"
            >
              {t('openCard')}
            </Link>
            {confirmed ? <span className="chip chip-good">✓</span> : null}
          </>
        ) : (
          <span className="text-ink-500">{t('linkNoneOnCard')}</span>
        )}
      </div>
      <div className="flex gap-2">
        <select
          value={requestId}
          onChange={(event) => setRequestId(event.target.value)}
          aria-label={t('linkPick')}
          data-testid="receipt-calc-pick"
          className="input min-w-0 flex-1"
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
        <button
          type="button"
          disabled={pending || requestId === (currentId ?? '')}
          data-testid="receipt-calc-save"
          className="btn-primary shrink-0 disabled:opacity-50"
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
      </div>
      {error && <p className="text-sm font-semibold text-bad">{tc('error')}</p>}
    </div>
  );
}
