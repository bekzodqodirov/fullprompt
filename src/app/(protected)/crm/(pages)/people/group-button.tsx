'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { groupClientsAction } from '../../actions';

/** Confirm one suggested group — the owner is not typing 900 of these. */
export function GroupButton({
  clientIds,
  defaultName,
}: {
  clientIds: string[];
  defaultName: string;
}) {
  const t = useTranslations('crm');
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      data-testid="group-clients"
      disabled={pending}
      onClick={() => {
        const name = window.prompt(t('person'), defaultName);
        if (!name?.trim()) return;
        start(async () => {
          await groupClientsAction(clientIds, name.trim());
        });
      }}
      className="btn-primary whitespace-nowrap"
    >
      {pending ? '…' : `🔗 ${t('groupThem')}`}
    </button>
  );
}
