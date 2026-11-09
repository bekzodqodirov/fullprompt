'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { createQuickBatchAction } from './batch-actions-server';

export interface QuickWarehouse {
  id: string;
  code: string;
  name: string;
}

/**
 * ⚡ Tezkor partiya — with ONE line of confirm before it mints (the owner's
 * 6a, docs/NARX-VA-RAQAM.md §3.2.9): «YW → Toshkent: yangi partiya
 * ochilsinmi?». The press used to post the two selects straight away, so a
 * mis-picked destination was a minted number at once, and the only way back
 * was a cancel.
 *
 * IN-PAGE, never `window.confirm`: Playwright dismisses a dialog it was not
 * told about, and the specs that press this button also arm `page.once` for
 * the CANCEL's confirm later — a second native dialog would be the wrong one
 * to eat it. The first press only asks; «Ha, ochish» is the form's real submit
 * button, so the action is the same `<form action>` it always was (it
 * redirects to the new card), and «Bekor» posts nothing. Changing either
 * select takes the question back, so the confirm always names what will be
 * sent. The option text stays the warehouse CODE (the specs select by label);
 * the question names the warehouses.
 */
export function QuickBatchForm({
  origins,
  dests,
  defaultDestId,
}: {
  /** Where this person may start an unplanned truck — one warehouse is shown, not chosen. */
  origins: QuickWarehouse[];
  dests: QuickWarehouse[];
  defaultDestId: string | undefined;
}) {
  const t = useTranslations('batches');
  const [originId, setOriginId] = useState(origins[0]?.id ?? '');
  const [destId, setDestId] = useState(defaultDestId ?? '');
  const [asking, setAsking] = useState(false);
  const origin = origins.find((wh) => wh.id === originId) ?? null;
  const dest = dests.find((wh) => wh.id === destId) ?? null;
  // The action refuses a truck to its own warehouse by returning quietly; a
  // press that does nothing reads as a press that worked, so it is not offered.
  const sendable = origin !== null && dest !== null && origin.id !== dest.id;

  return (
    <form action={createQuickBatchAction} className="card space-y-2 !p-3" data-testid="quick-batch-form">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">⚡ {t('quickBatch')}</span>
        {origins.length === 1 ? (
          // One warehouse, no choice to make: show it and send it.
          <>
            <input type="hidden" name="originId" value={origins[0]!.id} />
            <span data-testid="quick-origin-fixed" className="input !w-24 flex items-center font-mono font-bold">
              {origins[0]!.code}
            </span>
          </>
        ) : (
          <select
            name="originId"
            aria-label={t('quickOrigin')}
            className="input !w-24 font-mono font-bold"
            value={originId}
            onChange={(e) => {
              setOriginId(e.target.value);
              setAsking(false);
            }}
          >
            {origins.map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.code}
              </option>
            ))}
          </select>
        )}
        <span className="font-bold">→</span>
        <select
          name="destId"
          aria-label={t('quickDest')}
          className="input !w-24 font-mono font-bold"
          value={destId}
          onChange={(e) => {
            setDestId(e.target.value);
            setAsking(false);
          }}
        >
          {dests.map((wh) => (
            <option key={wh.id} value={wh.id}>
              {wh.code}
            </option>
          ))}
        </select>
        {!asking && (
          <button
            type="button"
            className="btn-primary flex-1 whitespace-nowrap px-3 disabled:opacity-50"
            data-testid="create-quick-batch"
            disabled={!sendable}
            onClick={() => setAsking(true)}
          >
            ＋ {t('create')}
          </button>
        )}
      </div>
      {asking && sendable && (
        <div className="space-y-2 rounded-lg border border-line p-2" data-testid="quick-batch-confirm" role="alertdialog">
          <p className="text-sm font-semibold [overflow-wrap:anywhere]">
            {t('quickConfirm', { from: origin!.name || origin!.code, to: dest!.name || dest!.code })}
          </p>
          <div className="flex gap-2">
            <ConfirmButton label={t('quickConfirmYes')} />
            <button
              type="button"
              className="btn-secondary"
              data-testid="quick-batch-no"
              onClick={() => setAsking(false)}
            >
              {t('quickConfirmNo')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

/** The form's real submit — dead while the post is in flight, so a double press mints one truck. */
function ConfirmButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-primary flex-1 whitespace-nowrap px-3 disabled:opacity-50"
      data-testid="quick-batch-yes"
      disabled={pending}
    >
      {label}
    </button>
  );
}
