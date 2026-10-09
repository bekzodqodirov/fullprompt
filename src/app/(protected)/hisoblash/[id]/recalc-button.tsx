'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { relawedQuery } from '@/modules/wms/calc/law-words';
import { recalcAction } from '../actions';

/**
 * «Qayta hisoblash» on a closed job that has no sealed panel to carry it — a
 * Готово ANSWER (the owner's 10a, «muhrlanganlar bilan bir xil qoida»). The
 * sealed panel keeps its own button; the rule and the gate are one
 * (`recalcFromSealed`, `admin.settings.manage`).
 *
 * A refusal is a SENTENCE, never a button that did nothing — «the correction
 * is already open», «it was handed back — send a new one from the card». On
 * success the page is LEFT by a full navigation rather than `router.push`
 * (#1242: a push right after an action can discard the action still being
 * applied, and the new request would read as never opened).
 */
export function RecalcButton({ id }: { id: string }) {
  const t = useTranslations('calc');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2">
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        data-testid="calc-recalc"
        onClick={() =>
          startTransition(async () => {
            const result = await recalcAction(id);
            setError(result.error ?? null);
            if (result.newId) window.location.assign(`/hisoblash/${result.newId}${relawedQuery(result)}`);
          })
        }
      >
        {t('recalc')}
      </button>
      {error ? (
        <p className="chip chip-warn mt-2" data-testid="calc-recalc-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_ready') : error}
        </p>
      ) : null}
    </div>
  );
}
