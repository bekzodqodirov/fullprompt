'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { MentionTextarea } from '@/components/mention-textarea';
import type { MentionPerson } from '@/modules/wms/crm/mentions';
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
  people = [],
}: {
  entityType: 'lead' | 'client';
  entityId: string;
  today: string;
  /** Inside a collapsible Panel the panel owns the card and the title. */
  bare?: boolean;
  /** Colleagues an @ can name (phase 4). */
  people?: MentionPerson[];
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(
    addActivityAction,
    {},
  );

  // Round 73's composer pass: the KIND is four segmented chips (peer-checked,
  // zero JavaScript — the dropdown hid the answer behind a tap), the note is
  // a composer shell whose send button lives inside it, and the two dates
  // stay one quiet row each. Same names, same action, same testids.
  const kinds = [
    { value: 'call', icon: '📞' },
    { value: 'message', icon: '💬' },
    { value: 'meeting', icon: '🤝' },
    { value: 'note', icon: '📝' },
  ] as const;

  return (
    <form action={formAction} className={bare ? 'space-y-2' : 'card space-y-2'}>
      {!bare && <h2 className="text-sm font-bold uppercase text-ink-500">📝 {t('addActivity')}</h2>}
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />

      <div className="flex flex-wrap gap-1.5">
        {kinds.map((kind, index) => (
          <label key={kind.value} className="cursor-pointer">
            <input
              type="radio"
              name="kind"
              value={kind.value}
              defaultChecked={index === 0}
              className="peer sr-only"
            />
            <span className="block rounded-xl border border-line bg-surface-raised px-2.5 py-1.5 text-xs font-bold peer-checked:border-brand-600 peer-checked:bg-brand-50 peer-checked:text-brand-800">
              {kind.icon} {t(kind.value === 'note' ? 'noteKind' : kind.value)}
            </span>
          </label>
        ))}
      </div>

      <div className="rounded-2xl border border-line bg-surface-raised p-1.5 transition-colors focus-within:border-brand-500">
        <MentionTextarea
          bare
          name="note"
          testid="activity-note"
          placeholder={t('what')}
          people={people}
          required
        />
        <div className="flex items-center gap-2">
          <input
            type="date"
            name="happenedAt"
            aria-label={t('addActivity')}
            defaultValue={today}
            className="input !min-h-9 !w-36 text-xs"
          />
          <button
            type="submit"
            data-testid="save-activity"
            className="btn-primary !min-h-9 ml-auto shrink-0 rounded-xl px-4"
            disabled={pending}
          >
            {pending ? tc('loading') : tc('save')}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block text-xs text-ink-500">{t('nextAction')}</span>
          <input type="date" name="nextActionAt" className="input !min-h-9 !w-36 text-xs" />
        </label>
        <input
          name="nextActionNote"
          placeholder={t('nextActionNote')}
          aria-label={t('nextActionNote')}
          className="input !min-h-9 min-w-32 flex-1 text-sm"
        />
      </div>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && <p className="text-sm font-semibold text-bad">{tc('error')}</p>}
    </form>
  );
}
