'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createRoleAction, type RoleFormState } from './actions';

/** A role the owner invents. It starts with no permissions at all. */
export function NewRoleForm() {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<RoleFormState, FormData>(
    createRoleAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          name="code"
          data-testid="role-code"
          className="input min-w-32 flex-1 font-mono"
          placeholder="dispatcher"
          required
        />
        <input
          name="name"
          data-testid="role-name"
          className="input min-w-40 flex-1"
          placeholder={t('namePlaceholder')}
          required
        />
      </div>
      <input name="description" className="input" placeholder={t('descriptionPlaceholder')} />
      <p className="text-xs text-ink-500">{t('codeHint')}</p>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.bad_code')}
        </p>
      )}
      <button
        type="submit"
        data-testid="save-role"
        disabled={pending}
        className="btn-primary w-full disabled:opacity-60"
      >
        {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
      </button>
    </form>
  );
}
