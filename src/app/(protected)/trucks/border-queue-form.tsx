'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { BorderQueueErrorCode } from '@/modules/wms/tracking/border-queue';
import {
  resetBorderWaitAction,
  saveBorderWaitAction,
  type BorderQueueFormState,
} from './border-queue-actions';

/**
 * One post's queue, typed. The two numbers are CONTROLLED so a refusal keeps
 * what the logist typed (#463 — React resets an uncontrolled form after a
 * form action, and «5–2» wiped to empty reads as «it saved nothing»).
 * `type="text" inputMode="decimal"`, not `type="number"`: a phone's number
 * field swallows «3,5», the comma a Tashkent keyboard types for a half.
 *
 * `seenAt` is the row as this screen drew it; a colleague's number typed in
 * between is refused (`changed`) instead of being overwritten in silence.
 * `updated_by` is never posted — the service writes the actor.
 */
export function BorderQueueForm({
  post,
  seenAt,
  minDays,
  maxDays,
  note,
}: {
  post: string;
  seenAt: string | null;
  minDays: string;
  maxDays: string;
  note: string;
}) {
  const t = useTranslations('trucks.queue');
  const [min, setMin] = useState(minDays);
  const [max, setMax] = useState(maxDays);
  const [text, setText] = useState(note);
  const [last, setLast] = useState<'save' | 'reset'>('save');
  const [saved, save, saving] = useActionState<BorderQueueFormState, FormData>(saveBorderWaitAction, null);
  const [reset, clear, clearing] = useActionState<BorderQueueFormState, FormData>(resetBorderWaitAction, null);

  // Back to the usual days: the boxes empty with the row, or they would offer
  // the number that was just taken away.
  useEffect(() => {
    if (reset && 'ok' in reset) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMin('');
      setMax('');
      setText('');
    }
  }, [reset]);

  const ERRORS: Record<BorderQueueErrorCode | 'server_behind', string> = {
    forbidden: t('errors.forbidden'),
    scoped_actor: t('errors.scoped_actor'),
    unknown_post: t('errors.unknown_post'),
    bad_number: t('errors.bad_number'),
    bad_range: t('errors.bad_range'),
    note_too_long: t('errors.note_too_long'),
    changed: t('errors.changed'),
    server_behind: t('errors.server_behind'),
  };
  const state = last === 'reset' ? reset : saved;
  const busy = saving || clearing;

  return (
    <form action={save} className="space-y-2" data-testid={`queue-form-${post}`}>
      <input type="hidden" name="post" value={post} />
      <input type="hidden" name="seenAt" value={seenAt ?? ''} />
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-ink-500">
          {t('minDays')}
          <input
            name="minDays"
            type="text"
            inputMode="decimal"
            className="input"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            data-testid={`queue-min-${post}`}
          />
        </label>
        <label className="block text-xs text-ink-500">
          {t('maxDays')}
          <input
            name="maxDays"
            type="text"
            inputMode="decimal"
            className="input"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            data-testid={`queue-max-${post}`}
          />
        </label>
      </div>
      <label className="block text-xs text-ink-500">
        {t('note')}
        <input
          name="note"
          type="text"
          className="input"
          maxLength={300}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid={`queue-note-${post}`}
        />
      </label>
      {state && 'error' in state && (
        <p role="alert" className="text-sm font-semibold text-bad" data-testid={`queue-error-${post}`}>
          {ERRORS[state.error]}
        </p>
      )}
      {state && 'ok' in state && (
        <p className="text-sm font-semibold text-good" data-testid={`queue-saved-${post}`}>
          ✅ {t('saved')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          onClick={() => setLast('save')}
          className="btn-primary flex-1 disabled:opacity-60"
          data-testid={`queue-save-${post}`}
        >
          {saving ? '…' : t('save')}
        </button>
        <button
          type="submit"
          formAction={clear}
          disabled={busy}
          onClick={() => setLast('reset')}
          className="btn-secondary flex-1 disabled:opacity-60"
          data-testid={`queue-reset-${post}`}
        >
          {clearing ? '…' : t('reset')}
        </button>
      </div>
    </form>
  );
}
