'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { updateRecordAction, type RecordFormState } from '../../actions';

export function RecordForm({
  recordId,
  name,
  note,
  active,
}: {
  recordId: string;
  name: string;
  note: string | null;
  active: boolean;
}) {
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  const action = updateRecordAction.bind(null, recordId);
  const [state, formAction, pending] = useActionState<RecordFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-2" data-testid="record-form">
      <input
        name="name"
        defaultValue={name}
        placeholder={t('name')}
        aria-label={t('name')}
        className="input"
      />
      <textarea
        name="note"
        defaultValue={note ?? ''}
        placeholder={t('note')}
        aria-label={t('note')}
        rows={2}
        className="input resize-none"
      />
      <label className="flex items-center gap-2 text-sm">
        {/* A disabled checkbox posts nothing (#171): the real answer rides a
            hidden value the tick overrides. */}
        <input type="hidden" name="active" value="false" />
        <input type="checkbox" name="active" value="true" defaultChecked={active} className="h-4 w-4" />
        {t('activeFlag')}
      </label>
      <button type="submit" disabled={pending} data-testid="save-record-edit" className="btn-primary w-full">
        {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}
    </form>
  );
}
