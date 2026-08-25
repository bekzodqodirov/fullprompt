'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import {
  confirmLinkAction,
  dropLinkAction,
  type LinkFormState,
} from '@/app/(protected)/hisoblash/nazorat/actions';

/**
 * One guess, and the two answers a person can give it.
 *
 * The numbers are on the row on purpose: «is this the cargo that quote was
 * about?» is answerable in a second from quoted-versus-measured and in no
 * time at all from a prixod number, and this queue is the only thing standing
 * between the feature and an empty screen.
 */
export function CalcLinkRow({
  receiptId,
  children,
}: {
  receiptId: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('calc');
  const [yes, confirmIt, yesBusy] = useActionState<LinkFormState, FormData>(confirmLinkAction, {});
  const [no, dropIt, noBusy] = useActionState<LinkFormState, FormData>(dropLinkAction, {});
  const error = yes.error ?? no.error;

  return (
    <li className="card !p-3" data-testid="link-row">
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <form action={confirmIt}>
          <input type="hidden" name="receiptId" value={receiptId} />
          <button type="submit" className="btn-primary" disabled={yesBusy} data-testid="link-confirm">
            {t('linkConfirm')}
          </button>
        </form>
        <form action={dropIt}>
          <input type="hidden" name="receiptId" value={receiptId} />
          <button type="submit" className="btn" disabled={noBusy} data-testid="link-drop">
            {t('linkDrop')}
          </button>
        </form>
        {error ? <span className="text-2xs text-bad">{error}</span> : null}
      </div>
    </li>
  );
}
