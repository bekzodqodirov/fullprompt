'use client';

import { useActionState } from 'react';
import { setWorkAccountAction, type ConnectState } from './actions';

/**
 * «Shaxsiy raqam» / «Ish raqami» — the switch the whole widening rests on.
 *
 * The owner asked for it by name («kalit qilib ber har kim ozi tanlasin»)
 * after confirming both kinds of number exist in the company. It decides one
 * thing: what happens when a stranger writes. On a work number that is a
 * customer and becomes a lead by itself; on a personal number it is a
 * question on the «qaysi chatlar» tray, and nothing about the conversation is
 * stored until somebody answers it.
 *
 * Two radios and a save rather than a live toggle, because the consequence is
 * worth a deliberate press: turning this on starts keeping conversations that
 * were not kept a minute ago.
 */
export function WorkSwitch({
  workAccount,
  labels,
}: {
  workAccount: boolean;
  labels: {
    title: string;
    personal: string;
    personalHint: string;
    work: string;
    workHint: string;
    save: string;
    saved: string;
  };
}) {
  const [state, submit, pending] = useActionState<ConnectState, FormData>(
    setWorkAccountAction,
    { stage: 'phone' },
  );

  return (
    <form action={submit} className="card space-y-2" data-testid="work-switch">
      <p className="section-title">{labels.title}</p>
      {(
        [
          ['personal', labels.personal, labels.personalHint, !workAccount],
          ['work', labels.work, labels.workHint, workAccount],
        ] as const
      ).map(([value, label, hint, checked]) => (
        <label key={value} className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="kind"
            value={value}
            defaultChecked={checked}
            data-testid={`work-${value}`}
            className="mt-1"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{label}</span>
            <span className="block text-xs text-ink-500">{hint}</span>
          </span>
        </label>
      ))}
      <div className="flex items-center gap-2">
        <button type="submit" className="btn-secondary" disabled={pending} data-testid="work-save">
          {labels.save}
        </button>
        {state.ok && <span className="text-sm font-semibold text-good">✅ {labels.saved}</span>}
        {state.error && <span className="text-sm font-semibold text-bad">{state.error}</span>}
      </div>
    </form>
  );
}
