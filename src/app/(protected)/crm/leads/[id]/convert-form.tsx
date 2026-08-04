'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { CrmFormState } from '../../actions';

/**
 * Lead → client card.
 *
 * The code field is optional on purpose: leaving it empty hands the job to
 * the same generator the admin screen uses (DECISIONS #115), which is what
 * anyone doing this in a hurry should get.
 */
export function ConvertForm({
  action,
  defaultName,
  codePrefix,
}: {
  action: (state: CrmFormState, formData: FormData) => Promise<CrmFormState>;
  defaultName: string;
  codePrefix: string;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          name="clientCode"
          placeholder={codePrefix}
          aria-label={t('clientCode')}
          data-testid="convert-code"
          className="input !w-32 font-mono uppercase"
        />
        <input
          name="clientName"
          defaultValue={defaultName}
          aria-label={t('name')}
          className="input min-w-40 flex-1"
        />
      </div>
      <p className="text-xs text-ink-500">{t('codeAuto')}</p>
      <button
        type="submit"
        data-testid="convert-lead"
        className="btn-primary w-full"
        disabled={pending}
      >
        {pending ? tc('loading') : `🤝 ${t('convert')}`}
      </button>
      {state.error && (
        <p className="text-sm font-semibold text-bad">
          {state.error === 'code_exists'
            ? tc('error') + ': ' + t('clientCode')
            : state.error === 'already_converted'
              ? t('alreadyClient')
              : tc('error')}
        </p>
      )}
    </form>
  );
}
