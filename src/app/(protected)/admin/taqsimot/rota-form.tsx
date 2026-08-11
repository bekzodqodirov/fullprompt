'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveRotaAction, type RoutingFormState } from './actions';

export interface RotaMember {
  id: string;
  name: string;
  inRota: boolean;
}

/**
 * Who takes part in the general rotation — every active member of staff, one
 * enabled checkbox each. Replace-all on save is sound precisely because no box
 * here is ever disabled (#171).
 */
export function RotaForm({ members }: { members: RotaMember[] }) {
  const t = useTranslations('routing');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<RoutingFormState, FormData>(
    saveRotaAction,
    {},
  );

  return (
    <form action={formAction} className="card space-y-2" data-testid="rota-form">
      <h2 className="font-semibold">{t('membersTitle')}</h2>
      <p className="text-xs text-ink-500">{t('membersHint')}</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {members.map((member) => (
          <label key={member.id} className="flex items-center gap-2 py-0.5 text-sm">
            <input
              type="checkbox"
              name="member"
              value={member.id}
              defaultChecked={member.inRota}
              className="h-5 w-5 shrink-0"
            />
            <span className="min-w-0 truncate">{member.name}</span>
          </label>
        ))}
      </div>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.forbidden')}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        data-testid="rota-save"
        className="btn-primary w-full disabled:opacity-50"
      >
        {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
      </button>
    </form>
  );
}
