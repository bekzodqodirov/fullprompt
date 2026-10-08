'use client';

import { startTransition, useActionState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { MentionTextarea } from '@/components/mention-textarea';
import type { MentionPerson } from '@/modules/wms/crm/mentions';
import { THREAD_TEXT_MAX, type CargoKind } from '@/modules/platform/notifications/thread-ref';
import type { CargoThreadState } from '@/modules/wms/crm/cargo-thread';
import { postCargoThreadAction } from '@/modules/wms/crm/cargo-thread-actions';
import { useClearOnSent } from './thread-box-clear';

/**
 * The prixod's and the truck's «❓ Savol-javob» composer (round 2, 0129) —
 * the calc box's shape: submitted by hand (`preventDefault` + the action in a
 * transition), so a REFUSED message keeps its text (#463) and the box clears
 * only on a success the server answered, once per send.
 *
 * Text only (E10 a): no 📎. What it prints after a send is the action's own
 * answer, each line ONE fact: who of the arm will not hear it and why (capped,
 * «… yana N kishi»), the standing warehouses where NOBODY is assigned («u
 * yerga xabar bormadi» — not «nobody got it»: another warehouse may have), a
 * warehouse writer's message that reached no logist, and «nobody was sent it»
 * only when nobody at all was. Its words are the cargo box's own
 * (`threads.cargo.errors.*`) — round 1's say «calculation not found».
 */
export function CargoThreadBox({
  threadRef,
  people,
}: {
  threadRef: { kind: CargoKind; id: string };
  people: MentionPerson[];
}) {
  const t = useTranslations('threads');
  const [state, submit, pending] = useActionState<CargoThreadState, FormData>(postCargoThreadAction, {});
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
      data-testid="cargo-thread-box"
    >
      <input type="hidden" name="kind" value={threadRef.kind} />
      <input type="hidden" name="id" value={threadRef.id} />
      <div className="flex items-end gap-1 rounded-2xl border border-line bg-surface-raised p-1.5 focus-within:border-line-strong">
        <MentionTextarea
          bare
          name="body"
          required
          maxLength={THREAD_TEXT_MAX}
          placeholder={t('placeholder')}
          people={people}
          testid="cargo-thread-input"
        />
        <button
          type="submit"
          disabled={pending}
          className="btn-primary !min-h-9 shrink-0 rounded-xl px-4"
          data-testid="cargo-thread-send"
        >
          {pending ? t('sending') : t('send')}
        </button>
      </div>
      {state.error ? (
        <p className="text-sm font-semibold text-bad" data-testid="cargo-thread-error">
          {t(`cargo.errors.${state.error}`)}
        </p>
      ) : null}
      {state.ok
        ? (state.unreachable ?? []).map((row) => (
            <p key={`${row.name}:${row.reason}`} className="text-xs text-warn" data-testid="cargo-thread-unreachable">
              {t(`unreachable.${row.reason}`, { name: row.name })}
            </p>
          ))
        : null}
      {state.ok && (state.unreachableMore ?? 0) > 0 ? (
        <p className="text-xs text-warn" data-testid="cargo-thread-unreachable-more">
          {t('cargo.more', { n: state.unreachableMore ?? 0 })}
        </p>
      ) : null}
      {state.ok && (state.noStaffAt ?? []).length > 0 ? (
        <p className="text-xs text-warn" data-testid="cargo-thread-no-staff">
          {t('cargo.noStaffAt', { codes: (state.noStaffAt ?? []).join(', ') })}
        </p>
      ) : null}
      {state.ok && state.noOffice ? (
        <p className="text-xs text-warn" data-testid="cargo-thread-no-office">
          {t('cargo.noOffice')}
        </p>
      ) : null}
      {state.ok && state.nobody ? (
        <p className="text-xs text-warn" data-testid="cargo-thread-nobody">
          {t('cargo.nobody')}
        </p>
      ) : null}
    </form>
  );
}
