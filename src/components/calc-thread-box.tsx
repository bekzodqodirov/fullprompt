'use client';

import { startTransition, useActionState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { MentionTextarea } from '@/components/mention-textarea';
import type { MentionPerson } from '@/modules/wms/crm/mentions';
import { THREAD_TEXT_MAX } from '@/modules/platform/notifications/thread-ref';
import type { CalcThreadState } from '@/modules/wms/crm/thread';
import { postCalcThreadAction } from '@/app/(protected)/hisoblash/[id]/thread-actions';
import { useClearOnSent } from './thread-box-clear';

/**
 * The calc Q&A composer (§3.5 a/b) — one component for both mounts, the calc
 * page (the VED asks) and the card's fold (the seller answers).
 *
 * A refused message KEEPS its text (#463, #377, #419 — «a form that can be
 * refused must hold its inputs»): the form is submitted by hand
 * (`preventDefault` + the action called in a transition), so React's reset
 * after a form Action never runs, and the box is cleared only on a success
 * the server answered — once per send, keyed on `sent`.
 *
 * Text only (E10 a): no 📎. What it prints after a send is the action's own
 * answer: one line per expected person who will NOT hear it and why, and
 * «nobody receives this» only when there is nobody to expect.
 */
export function CalcThreadBox({
  requestId,
  people,
  hint,
}: {
  requestId: string;
  people: MentionPerson[];
  /** The calc page's warning to the VED — tannarx and the sealed floor are read by sellers too. */
  hint?: string | null;
}) {
  const t = useTranslations('threads');
  const [state, submit, pending] = useActionState<CalcThreadState, FormData>(postCalcThreadAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  useClearOnSent(state, formRef);

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => submit(data));
      }}
      className="space-y-1"
      data-testid="calc-thread-box"
    >
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex items-end gap-1 rounded-2xl border border-line bg-surface-raised p-1.5 focus-within:border-line-strong">
        <MentionTextarea
          bare
          name="body"
          required
          maxLength={THREAD_TEXT_MAX}
          placeholder={t('placeholder')}
          people={people}
          testid="calc-thread-input"
        />
        <button
          type="submit"
          disabled={pending}
          className="btn-primary !min-h-9 shrink-0 rounded-xl px-4"
          data-testid="calc-thread-send"
        >
          {pending ? t('sending') : t('send')}
        </button>
      </div>
      {hint ? <p className="text-2xs text-ink-500">{hint}</p> : null}
      {state.error ? (
        <p className="text-sm font-semibold text-bad" data-testid="calc-thread-error">
          {t(`errors.${state.error}`)}
        </p>
      ) : null}
      {state.ok && state.noAudience ? (
        <p className="text-xs text-warn" data-testid="calc-thread-no-audience">
          {t('noAudience')}
        </p>
      ) : null}
      {state.ok
        ? (state.unreachable ?? []).map((row) => (
            <p key={`${row.name}:${row.reason}`} className="text-xs text-warn" data-testid="calc-thread-unreachable">
              {t(`unreachable.${row.reason}`, { name: row.name })}
            </p>
          ))
        : null}
    </form>
  );
}
