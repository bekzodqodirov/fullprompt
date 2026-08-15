'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setFollowUpAction } from '../crm/actions';

/**
 * One «bugun qo'ng'iroq» row, with the two taps that take it off the list.
 *
 * The owner watched this list fill up and never empty («call today bo'lib
 * yig'ilib turibti»), because the only way to clear a row was to open the
 * card, unfold the ✏️ form and re-date it by hand — so nobody did, and every
 * advert lead (booked for TODAY on arrival) stayed for ever.
 *
 * The row is still a LINK to the card, because the usual next move is to open
 * it; the buttons sit beside the link and stop the navigation themselves.
 * «Bajarildi» clears the date (nothing scheduled — the lead lives on the
 * board now), «Ertaga» moves it one day.
 */
export function FollowUpRow({
  kind,
  id,
  href,
  title,
  dueOn,
  note,
}: {
  kind: 'lead' | 'client';
  id: string;
  href: string;
  title: string;
  dueOn: string;
  note: string | null;
}) {
  const t = useTranslations('crm');
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);
  const [failed, setFailed] = useState(false);

  const set = (until: string | null) => {
    if (pending) return;
    setFailed(false);
    startTransition(async () => {
      const res = await setFollowUpAction(kind, id, until).catch(() => ({ error: 'failed' }));
      // Optimistic removal only on a real success: a refused row that vanished
      // would be a call quietly dropped, which is the opposite of the fix.
      if ('ok' in res && res.ok) setGone(true);
      else setFailed(true);
    });
  };

  const tomorrow = () => {
    const date = new Date(`${dueOn}T00:00:00Z`);
    const today = new Date();
    // From TOMORROW, not from the row's own (possibly weeks-old) date — «put
    // it off a day» means a day from now, whatever the backlog says.
    const base = date.getTime() > today.getTime() ? date : today;
    base.setUTCDate(base.getUTCDate() + 1);
    return base.toISOString().slice(0, 10);
  };

  if (gone) return null;

  return (
    <div className="card !p-3" data-testid="follow-up-row">
      <Link href={href} className="block hover:opacity-80">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="min-w-0 flex-1 font-semibold">{title}</span>
          <span className="num text-xs text-ink-500">{dueOn}</span>
        </div>
        {note && <p className="text-sm text-ink-700">{note}</p>}
      </Link>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending}
          onClick={() => set(null)}
          data-testid="follow-up-done"
        >
          ✓ {t('followUpDone')}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending}
          onClick={() => set(tomorrow())}
          data-testid="follow-up-tomorrow"
        >
          {t('followUpTomorrow')}
        </button>
        {failed && <span className="self-center text-xs text-bad">{t('followUpFailed')}</span>}
      </div>
    </div>
  );
}
