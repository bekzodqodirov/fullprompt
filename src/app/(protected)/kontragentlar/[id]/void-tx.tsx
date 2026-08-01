'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { voidPartnerTxAction } from '../actions';

/**
 * Cancel a row. Never a delete: the account is a record of what was agreed,
 * and a reason nobody can read afterwards is the same as no reason.
 *
 * Voiding a settlement takes the client's half with it — the service does
 * that, and the confirm text says so, because a person pressing this from the
 * partner side has no way of guessing it otherwise.
 */
export function VoidTx({ id, partnerId }: { id: string; partnerId: string }) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="mt-1 text-xs font-semibold text-bad underline"
        onClick={() => setOpen(true)}
      >
        ✕ {tc('cancel')}
      </button>
    );
  }

  return (
    <form action={voidPartnerTxAction} className="mt-1 space-y-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="partnerId" value={partnerId} />
      <input
        name="reason"
        className="input !py-1 text-xs"
        placeholder={t('voidReason')}
        aria-label={t('voidReason')}
        required
        minLength={3}
      />
      <div className="flex gap-1">
        <button type="submit" className="btn-danger !py-1 flex-1 text-xs">
          ✕ {tc('confirm')}
        </button>
        <button
          type="button"
          className="btn-secondary !py-1 flex-1 text-xs"
          onClick={() => setOpen(false)}
        >
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
