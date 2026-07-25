'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { renameBatchAction, type BatchCodeFormState } from '../../plans/actions';

/**
 * The batch code, with a ✏️ next to it before the truck leaves.
 *
 * Owner: the per-warehouse sequence (YW-001, YW-002) is the default, but he
 * sometimes needs to type the number the partner or the papers already use.
 * After departure the code is on documents that are out of our hands, so the
 * pencil disappears and the code is plain text again.
 */
export function BatchCodeForm({
  batchId,
  code,
  editable,
}: {
  batchId: string;
  code: string;
  editable: boolean;
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<BatchCodeFormState, FormData>(
    renameBatchAction,
    {},
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.ok) setOpen(false);
  }, [state]);

  if (!editable || !open) {
    return (
      <>
        <h1 className="font-mono text-xl font-extrabold text-blue-800">{state.code ?? code}</h1>
        {editable && (
          <button
            type="button"
            aria-label={tc('edit')}
            data-testid="edit-batch-code"
            className="text-sm"
            onClick={() => setOpen(true)}
          >
            ✏️
          </button>
        )}
        {state.ok && <span className="text-xs font-semibold text-green-700">✅ {tc('saved')}</span>}
      </>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-wrap items-center gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <input
        name="code"
        defaultValue={state.code ?? code}
        autoFocus
        maxLength={40}
        data-testid="batch-code-input"
        className="input min-w-32 flex-1 font-mono font-extrabold uppercase"
      />
      <button type="submit" className="btn-primary !min-h-9 px-3 text-sm" disabled={pending}>
        {pending ? tc('loading') : tc('save')}
      </button>
      <button
        type="button"
        className="btn-secondary !min-h-9 px-3 text-sm"
        onClick={() => setOpen(false)}
      >
        {tc('cancel')}
      </button>
      {state.error && (
        <p className="w-full text-xs font-semibold text-red-700">
          {state.error === 'code_taken' ? t('codeTaken') : tc('error')}
        </p>
      )}
    </form>
  );
}
