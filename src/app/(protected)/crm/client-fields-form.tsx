'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveClientFieldsAction, type CrmFormState } from './actions';

/** Saves the owner's own fields on a client card. */
export function ClientFieldsForm({
  clientId,
  children,
}: {
  clientId: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const action = saveClientFieldsAction.bind(null, clientId);
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-2">
      {children}
      <button
        type="submit"
        data-testid="save-client-fields"
        className="btn-primary w-full"
        disabled={pending}
      >
        {pending ? tc('loading') : tc('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-green-700">✅ {tc('saved')}</p>}
      {state.error && (
        <p className="text-sm font-semibold text-red-700">
          {state.error === 'bad_number'
            ? t('badNumber')
            : state.error === 'bad_date'
              ? t('badDate')
              : state.error === 'bad_option'
                ? t('badOption')
                : tc('error')}
        </p>
      )}
    </form>
  );
}
