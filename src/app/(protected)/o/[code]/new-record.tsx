'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createRecordAction, type RecordFormState } from '../actions';

/** Name first, everything else on the card — a record exists in one tap. */
export function NewRecordForm({ entityCode }: { entityCode: string }) {
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  const action = createRecordAction.bind(null, entityCode);
  const [state, formAction, pending] = useActionState<RecordFormState, FormData>(action, {});

  return (
    <form action={formAction} className="flex gap-2" data-testid="new-record-form">
      <input
        name="name"
        placeholder={t('newRecordName')}
        aria-label={t('newRecordName')}
        data-testid="record-name"
        className="input flex-1"
      />
      <button type="submit" disabled={pending} data-testid="save-record" className="btn-primary">
        {pending ? tc('loading') : `+ ${t('add')}`}
      </button>
      {state.error && (
        <p role="alert" className="self-center text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}
    </form>
  );
}
