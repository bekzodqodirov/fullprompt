'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { requestCalcAction, type CalcFormState } from '@/modules/wms/calc/actions';

/**
 * The «hand it to VED» form (round 28): the salesperson picks WHO (the
 * owner's answer 2) and says how many goods lines the job has — which is
 * what sets the deadline (30 minutes a line, two hours at most), so the
 * form shows the price of the number before it is submitted.
 */
export function CalcForm({
  entityType,
  entityId,
  revalidate,
  people,
  defaultItems,
}: {
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
  people: { id: string; name: string; open: number }[];
  defaultItems: number;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const action = requestCalcAction.bind(null, entityType, entityId, revalidate);
  const [state, formAction, pending] = useActionState<CalcFormState, FormData>(action, {});

  if (people.length === 0) {
    return <p className="text-sm text-ink-500">{t('noVed')}</p>;
  }

  return (
    <form action={formAction} className="space-y-2" data-testid="calc-form">
      <div className="flex flex-wrap gap-2">
        <select
          name="assigneeId"
          aria-label={t('assignee')}
          data-testid="calc-assignee"
          className="input min-w-40 flex-1"
        >
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
              {person.open > 0 ? ` (${t('inQueue', { n: person.open })})` : ''}
            </option>
          ))}
        </select>
        <input
          name="itemCount"
          type="number"
          min={1}
          max={500}
          defaultValue={defaultItems}
          aria-label={t('items')}
          data-testid="calc-items"
          className="input !w-24"
        />
        <button type="submit" data-testid="calc-submit" disabled={pending} className="btn-primary">
          {pending ? tc('loading') : t('send')}
        </button>
      </div>
      <p className="text-xs text-ink-500">{t('deadlineHint')}</p>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {t('sent')}</p>}
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {state.error === 'already_open'
            ? t('alreadyOpen')
            : state.error === 'not_ved'
              ? t('notVed')
              : tc('error')}
        </p>
      )}
    </form>
  );
}
