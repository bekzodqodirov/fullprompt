'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setAdjustKindAction } from '../actions';

/**
 * «Kurs farqi» / «Tuzatish» on a correction nobody has said the kind of
 * (0103, Q12's split) — the partner card and «Kurs qoldiqlari» both draw it,
 * both only on `mayClassifyFx`, and the action asks again. Once only: the
 * service's UPDATE is the claim, so a second press is refused in words.
 */
export function ClassifyAdjust({
  id,
  compact = false,
  labels,
}: {
  id: string;
  compact?: boolean;
  /** «Kurs qoldiqlari» asks it as a question about ONE residue (design §5.5.8). */
  labels?: { fx: string; correction: string };
}) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const press = (kind: 'fx' | 'correction') => {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set('id', id);
      fd.set('kind', kind);
      const res = await setAdjustKindAction(fd);
      if (res.error) setError(res.error);
    });
  };
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${compact ? '' : 'mt-1'}`} data-testid="classify-adjust">
      <button
        type="button"
        className="btn-secondary !px-2 !py-0.5 text-xs"
        disabled={pending}
        data-testid="classify-adjust-fx"
        onClick={() => press('fx')}
      >
        {labels?.fx ?? t('classifyFx')}
      </button>
      <button
        type="button"
        className="btn-secondary !px-2 !py-0.5 text-xs"
        disabled={pending}
        data-testid="classify-adjust-correction"
        onClick={() => press('correction')}
      >
        {labels?.correction ?? t('classifyCorrection')}
      </button>
      {error && (
        <span className="text-xs font-semibold text-bad">
          {error === 'already_classified' ? t('alreadyClassified') : tc('error')}
        </span>
      )}
    </span>
  );
}
