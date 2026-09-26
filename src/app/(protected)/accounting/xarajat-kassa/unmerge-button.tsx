'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { unmergeDuplicateAction } from './actions';

/**
 * «↩ Birlashtirishni bekor qilish» (owner's Q8, the lead's A) — shared by the
 * queue's «Birlashtirilganlar» list and the cost card's merged row, because
 * the need arises where the cost is, not only where the merge was made. The
 * answer says what happens next in words: the double is back until the COST
 * is voided or merged again (voiding the expense would re-open its rasxod
 * xabari), and the day to re-enter it on.
 */
export function UnmergeButton({ expenseId, count }: { expenseId: string; count?: number }) {
  const t = useTranslations('accounting');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <button
        type="button"
        className="btn-secondary !min-h-9"
        data-testid="unmerge"
        disabled={pending}
        onClick={() => {
          // The cost card does not know how many costs the merge holds.
          const question = count === undefined ? t('unmergeConfirmCard') : t('unmergeConfirm', { count });
          if (!window.confirm(question)) return;
          start(async () => {
            const res = await unmergeDuplicateAction({ expenseId });
            if (res.ok) {
              const back = res.queued ?? 0;
              const old = (res.total ?? 0) - back;
              setMessage({
                ok: true,
                text: [
                  t('unmergeDone', { count: back, dates: (res.dates ?? []).join(', ') }),
                  old > 0 ? t('unmergeOld', { count: old }) : '',
                ]
                  .filter(Boolean)
                  .join(' '),
              });
              router.refresh();
            } else {
              setMessage({ ok: false, text: unmergeError(res.error, t) });
            }
          });
        }}
      >
        ↩ {t('unmerge')}
      </button>
      {message && (
        <span
          role={message.ok ? 'status' : 'alert'}
          data-testid="unmerge-result"
          className={`basis-full text-xs font-semibold ${message.ok ? 'text-good' : 'text-bad'}`}
        >
          {message.text}
        </span>
      )}
    </span>
  );
}

/** Literal keys (#163): an assembled key is invisible to the i18n fence and throws at render. */
const UNMERGE_ERRORS = {
  not_merged: 'unmergeErrGone',
  not_found: 'unmergeErrGone',
  merge_changed: 'unmergeErrChanged',
  merge_staff_paid: 'unmergeErrStaffPaid',
  forbidden: 'queueErrForbidden',
} as const;

function unmergeError(code: string | undefined, t: (key: string) => string): string {
  const key = code ? UNMERGE_ERRORS[code as keyof typeof UNMERGE_ERRORS] : undefined;
  return key ? t(key) : (code ?? 'error');
}
