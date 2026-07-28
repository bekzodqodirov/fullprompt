'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { addActivityAction, type CrmFormState } from './actions';

/**
 * Log a contact and set the next one in the same breath.
 *
 * The two belong on one form because they are one thought: you finish the
 * call, you write what was said, you decide when to ring again. Splitting
 * them is how "call back on Friday" ends up living only in someone's head.
 */
export function ActivityForm({
  entityType,
  entityId,
  today,
  bare = false,
}: {
  entityType: 'lead' | 'client';
  entityId: string;
  today: string;
  /** Inside a collapsible Panel the panel owns the card and the title. */
  bare?: boolean;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(
    addActivityAction,
    {},
  );

  const kinds = ['call', 'message', 'meeting', 'note'] as const;

  return (
    <form action={formAction} className={bare ? 'space-y-2' : 'card space-y-2'}>
      {!bare && <h2 className="text-sm font-bold uppercase text-ink-500">📝 {t('addActivity')}</h2>}
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <div className="flex flex-wrap gap-2">
        <select name="kind" aria-label={t('addActivity')} className="input !w-36">
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {t(kind === 'note' ? 'noteKind' : kind)}
            </option>
          ))}
        </select>
        <input
          type="date"
          name="happenedAt"
          aria-label={t('addActivity')}
          defaultValue={today}
          className="input !w-40"
        />
      </div>
      <textarea
        name="note"
        data-testid="activity-note"
        placeholder={t('what')}
        aria-label={t('what')}
        rows={2}
        className="input"
        required
      />
      <div className="flex flex-wrap gap-2">
        <label className="text-sm">
          <span className="block text-xs text-ink-500">{t('nextAction')}</span>
          <input type="date" name="nextActionAt" className="input !w-40" />
        </label>
        <input
          name="nextActionNote"
          placeholder={t('nextActionNote')}
          aria-label={t('nextActionNote')}
          className="input min-w-40 flex-1 self-end"
        />
      </div>
      <button
        type="submit"
        data-testid="save-activity"
        className="btn-primary w-full"
        disabled={pending}
      >
        {pending ? tc('loading') : tc('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && <p className="text-sm font-semibold text-bad">{tc('error')}</p>}
    </form>
  );
}
