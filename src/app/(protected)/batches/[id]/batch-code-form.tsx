'use client';

import { useActionState, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { renameBatchAction, type BatchCodeFormState } from '../../plans/actions';
import {
  codeShapeProblem,
  hasCyrillic,
  loadingCodeProblem,
  normalizeBatchCode,
  roadCodeProblem,
} from '@/modules/wms/batches/batch-code';

type Mode = 'off' | 'loading' | 'road';
type Refusal = { error: string; detail?: string };

/**
 * The truck's code, with a ✏️ for whoever may rename it — before departure
 * as ever, and on the road until unloading finishes (the owner's 1a / 2a /
 * 3a; `wms/batches/rename.ts`, which reverses #122).
 *
 * `mode` comes from the card, off the same predicate the service obeys
 * (`mayRenameBatch`), so a drawn pencil never bounces. Every post carries
 * what this screen SHOWED (`seenCode`, `seenStage`) from PROPS, so after a
 * refresh it carries the new truth; the service refuses a truck that changed
 * under the open form, and the form then refreshes instead of guessing —
 * departed while typing (the reason box appears), a colleague's rename (the
 * next confirm reads «their name → yours»), unloading finished (the pencil
 * goes). Both inputs are CONTROLLED: React resets an uncontrolled form after
 * an action, and a refusal must never eat what was typed (#377/#463/#1207).
 * Not keyed on `mode`, so the typed name survives a refresh that moves it
 * from loading to road.
 */
export function BatchCodeForm({
  batchId,
  code,
  mode,
  ownFormer,
  sentToAgentAt,
}: {
  batchId: string;
  code: string;
  mode: Mode;
  ownFormer: string[];
  sentToAgentAt: string | null;
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(code);
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<Refusal | null>(null);
  const [state, formAction, pending] = useActionState<BatchCodeFormState, FormData>(
    renameBatchAction,
    {},
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.ok) setOpen(false);
    // A truck that changed under the form: the action refused, so nothing
    // revalidated — ask for the truth, keep what was typed.
    else if (state.error === 'batch_changed' || state.error === 'rename_closed') router.refresh();
  }, [state, router]);

  function refusalText(r: Refusal): string {
    switch (r.error) {
      case 'bad_code':
        return t('rename.errors.bad_code');
      case 'code_cyrillic':
        return t('rename.errors.code_cyrillic');
      case 'code_chars':
        return t('rename.errors.code_chars');
      case 'code_length':
        return t('rename.errors.code_length');
      case 'code_needs_letter':
        return t('rename.errors.code_needs_letter');
      case 'code_needs_digit':
        return t('rename.errors.code_needs_digit');
      case 'reason_required':
        return t('rename.errors.reason_required');
      case 'code_taken':
        return t('rename.errors.code_taken');
      case 'batch_changed':
        return t('rename.errors.batch_changed');
      case 'rename_closed':
        return t('rename.errors.rename_closed');
      case 'forbidden':
        return t('rename.errors.forbidden');
      case 'not_found':
        return t('rename.errors.not_found');
      case 'busy':
        return t('rename.errors.busy');
      case 'code_shape':
        return (
          {
            lot: t('rename.errors.shape_lot'),
            client: t('rename.errors.shape_client'),
            box: t('rename.errors.shape_box'),
            crate: t('rename.errors.shape_crate'),
          } as Record<string, string>
        )[r.detail ?? ''] ?? tc('error');
      case 'code_shadows':
        return (
          {
            client: t('rename.errors.shadows_client'),
            box: t('rename.errors.shadows_box'),
            crate: t('rename.errors.shadows_crate'),
          } as Record<string, string>
        )[r.detail ?? ''] ?? tc('error');
      default:
        return tc('error');
    }
  }

  /** The service's own rules, before anything is posted or confirmed. */
  function precheck(n: string): Refusal | null {
    if (mode === 'loading') {
      const bad = loadingCodeProblem(n);
      if (bad) return { error: bad };
    } else if (!ownFormer.includes(n)) {
      const bad = roadCodeProblem(n);
      if (bad) return { error: bad };
    }
    const shape = codeShapeProblem(n, null);
    return shape ? { error: 'code_shape', detail: shape } : null;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    setLocal(null);
    const n = normalizeBatchCode(value);
    const problem = n === code ? null : precheck(n);
    if (problem) {
      event.preventDefault();
      setLocal(problem);
      return;
    }
    // The dialog says EXACTLY what will be stored («ka-77» → «KA-77»).
    if (mode === 'road' && !window.confirm(t('rename.confirm', { from: code, to: n }))) {
      event.preventDefault();
    }
  }

  // A Cyrillic look-alike is said WHILE typing: on screen «КА-77» is KA-77.
  const live: Refusal | null = mode === 'road' && open && hasCyrillic(value) ? { error: 'code_cyrillic' } : null;
  const shown = local ?? live ?? (state.error ? { error: state.error, detail: state.detail } : null);
  const error = shown && (
    <p data-testid="batch-rename-error" className="w-full text-xs font-semibold text-bad">
      {refusalText(shown)}
    </p>
  );
  const hidden = (
    <>
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="seenCode" value={code} />
      <input type="hidden" name="seenStage" value={mode} />
    </>
  );
  const openForm = () => {
    setValue(code);
    setReason('');
    setLocal(null);
    setOpen(true);
  };

  const heading = <h1 className="font-mono text-xl font-extrabold text-brand-700">{code}</h1>;

  if (mode === 'off' || !open) {
    return (
      <>
        {heading}
        {mode !== 'off' && (
          <button
            type="button"
            aria-label={tc('edit')}
            data-testid="edit-batch-code"
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm"
            onClick={openForm}
          >
            ✏️
          </button>
        )}
        {state.ok && state.changed && (
          <span className="text-xs font-semibold text-good">✅ {tc('saved')}</span>
        )}
        {mode === 'off' && error}
      </>
    );
  }

  if (mode === 'loading') {
    return (
      <form action={formAction} onSubmit={onSubmit} className="flex w-full flex-wrap items-center gap-2">
        {hidden}
        <input
          name="code"
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
        {error}
      </form>
    );
  }

  const normalized = normalizeBatchCode(value);
  const ready = normalized !== code && reason.trim().length >= 3;
  return (
    <>
      {heading}
      <form
        action={formAction}
        onSubmit={onSubmit}
        className="w-full space-y-2 rounded-lg border border-line p-2"
        data-testid="batch-rename-panel"
      >
        {hidden}
        <label className="block space-y-1">
          <span className="label">{t('rename.codeLabel')}</span>
          <input
            name="code"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setLocal(null);
            }}
            autoFocus
            maxLength={40}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            data-testid="batch-code-input"
            className="input font-mono uppercase"
          />
          <span className="block text-xs text-ink-500">{t('rename.codeHintRoad')}</span>
        </label>
        <label className="block space-y-1">
          <span className="label">{t('rename.reasonLabel')}</span>
          <input
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            placeholder={t('rename.reasonHint')}
            data-testid="batch-rename-reason"
            className="input"
          />
        </label>
        {error}
        <p className="text-xs text-ink-500">{t('rename.docsHint')}</p>
        {sentToAgentAt && (
          <p className="text-xs font-semibold text-warn">
            {t('rename.agentSent', {
              date: format.dateTime(new Date(sentToAgentAt), { dateStyle: 'short' }),
            })}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            data-testid="batch-rename-save"
            className="btn-primary flex-1"
            disabled={pending || !ready}
          >
            {pending ? tc('loading') : t('rename.save')}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
            {tc('cancel')}
          </button>
        </div>
      </form>
    </>
  );
}
