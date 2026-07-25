'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { personFromClientAction } from './actions';

/** Turn this code into a person, so its siblings can be attached to it. */
export function MakePersonButton({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const t = useTranslations('crm');
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      data-testid="make-person"
      disabled={pending}
      title={clientName}
      onClick={() => start(async () => void (await personFromClientAction(clientId)))}
      className="btn-secondary w-full"
    >
      {pending ? '…' : `🔗 ${t('makePerson')}`}
    </button>
  );
}
