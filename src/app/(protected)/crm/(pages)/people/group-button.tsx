'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { groupClientsAction } from '../../actions';

/**
 * Confirm one suggested group — the owner is not typing 900 of these.
 *
 * Two shapes, and the difference is whether a name has to be invented. A NEW
 * person needs one, so it asks; JOINING one that exists must not ask, because
 * the answer is already written down and a prompt offering to rename somebody
 * else's card is how a group gets called «GS777».
 */
export function GroupButton({
  clientIds,
  defaultName,
  personId,
  personName,
}: {
  clientIds: string[];
  defaultName: string;
  personId?: string;
  personName?: string;
}) {
  const t = useTranslations('crm');
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      data-testid={personId ? 'join-person' : 'group-clients'}
      disabled={pending}
      onClick={() => {
        if (personId) {
          start(async () => {
            await groupClientsAction(clientIds, personName ?? defaultName, personId);
          });
          return;
        }
        const name = window.prompt(t('person'), defaultName);
        if (!name?.trim()) return;
        start(async () => {
          await groupClientsAction(clientIds, name.trim());
        });
      }}
      className="btn-primary whitespace-nowrap"
    >
      {pending ? '…' : personId ? `👤 ${t('groupThem')}` : `🔗 ${t('groupThem')}`}
    </button>
  );
}
