'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { changeDestBeforeDepartureAction } from '../../batch-actions-server';
import type { DestChangeErrorCode } from '@/modules/wms/batches/reroute-rules';

type Refusal = DestChangeErrorCode | 'busy_retry' | 'validation' | 'offline' | 'unauthenticated';

/**
 * «Qabul skladini o'zgartirish» on a truck that has not left (the owner's 6a,
 * docs/NARX-VA-RAQAM.md §2.4) — a select and ONE press, no reason: a
 * destination fixed before departure is a typo fixed, like a name changed
 * before departure. The road's own form (`RerouteForm`) asks for a reason and
 * tells Telegram; this one does neither.
 *
 * Controlled, never a `<form action>`: a refusal keeps the chosen warehouse
 * (#377/#463), and the press awaits inside try/finally so `pending` cannot
 * stick (#882). No `router.refresh()` after a success — the action
 * revalidates (#1242). The one refresh is after `dest_changed`: nothing was
 * written and the page must show what a colleague just chose. Imports only
 * the refusal TYPE from the rules (#276).
 */
export function DestChangeForm({
  batchId,
  fromId,
  fromCode,
  targets,
}: {
  batchId: string;
  /** The destination this page was drawn for — the compare-and-set's «seen». */
  fromId: string;
  fromCode: string;
  targets: { id: string; label: string; code: string }[];
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const router = useRouter();
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const chosen = targets.find((option) => option.id === target) ?? null;

  // A literal map (#163): typecheck forces a sentence for every refusal.
  const refusalText: Record<Refusal, string> = {
    forbidden: t('destChange.errors.forbidden'),
    batch_not_found: t('destChange.errors.batch_not_found'),
    not_before_departure: t('destChange.errors.not_before_departure'),
    dest_changed: t('destChange.errors.dest_changed'),
    bad_target: t('destChange.errors.bad_target'),
    dest_agent_sent: t('destChange.errors.dest_agent_sent'),
    same_destination: t('destChange.errors.same_destination'),
    destination_is_origin: t('destChange.errors.destination_is_origin'),
    target_inactive: t('destChange.errors.target_inactive'),
    dest_money_country: t('destChange.errors.dest_money_country'),
    busy_retry: t('destChange.errors.busy_retry'),
    validation: t('destChange.errors.validation'),
    offline: t('destChange.errors.offline'),
    unauthenticated: t('destChange.errors.unauthenticated'),
  };

  if (targets.length === 0) {
    return (
      <p className="text-sm text-ink-500" data-testid="dest-change-no-targets">
        {t('destChange.noTargets')}
      </p>
    );
  }

  async function submit() {
    if (!chosen) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const res = await changeDestBeforeDepartureAction({
        batchId,
        destWarehouseId: chosen.id,
        seenDestWarehouseId: fromId,
      });
      if (!res.ok) {
        setError(res.error);
        if (res.error === 'dest_changed') router.refresh();
        return;
      }
      setDone(res.toCode);
      setTarget('');
    } catch {
      setError('offline');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="dest-change-form">
      <p className="text-xs text-ink-500">{t('destChange.hint')}</p>
      <div>
        <label className="label" htmlFor="dest-change-target">
          {t('destChange.target')} <span className="font-mono text-ink-500">({fromCode} →)</span>
        </label>
        <select
          id="dest-change-target"
          className="input"
          data-testid="dest-change-target"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setDone(null);
            setError(null);
          }}
        >
          <option value="">{t('destChange.targetPick')}</option>
          {targets.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn-primary w-full disabled:opacity-50"
        data-testid="dest-change-submit"
        disabled={pending || !chosen}
        onClick={submit}
      >
        {pending ? tc('loading') : t('destChange.submit')}
      </button>
      {error && (
        <p role="alert" data-testid="dest-change-refusal" className="text-sm font-semibold text-bad">
          {refusalText[error]}
        </p>
      )}
      {done && (
        <p data-testid="dest-change-done" className="text-sm font-semibold text-good">
          {t('destChange.done', { to: done })}
        </p>
      )}
    </div>
  );
}
