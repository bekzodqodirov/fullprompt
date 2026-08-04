'use client';

import { useActionState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  createEntityAction,
  toggleEntityAction,
  updateEntityAction,
  type EntityFormState,
} from './actions';

const CHOICES = ['everyone', 'sales', 'finance', 'admins'] as const;

/** Create when no code is given, rename/regate an existing one otherwise. */
export function EntityForm({
  code,
  label,
  writeChoice,
}: {
  code?: string;
  label?: string;
  writeChoice?: (typeof CHOICES)[number];
}) {
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  const action = code ? updateEntityAction.bind(null, code) : createEntityAction;
  const [state, formAction, pending] = useActionState<EntityFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-2" data-testid={code ? undefined : 'entity-form'}>
      <input
        name="label"
        defaultValue={label ?? ''}
        placeholder={t('typeName')}
        aria-label={t('typeName')}
        data-testid={code ? undefined : 'entity-label'}
        className="input"
      />
      <select
        name="writeChoice"
        defaultValue={writeChoice ?? 'everyone'}
        aria-label={t('whoEdits')}
        data-testid={code ? undefined : 'entity-write-choice'}
        className="input"
      >
        {CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {t(`choice.${choice}` as 'choice.everyone')}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        data-testid={code ? undefined : 'save-entity'}
        className="btn-primary w-full"
      >
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

export function EntityToggle({ code, active }: { code: string; active: boolean }) {
  const t = useTranslations('objects');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      data-testid="entity-toggle"
      onClick={() =>
        startTransition(async () => {
          await toggleEntityAction(code, !active);
          router.refresh();
        })
      }
      className="btn-secondary !px-2 !py-1 text-xs"
    >
      {active ? t('deactivate') : t('activate')}
    </button>
  );
}
