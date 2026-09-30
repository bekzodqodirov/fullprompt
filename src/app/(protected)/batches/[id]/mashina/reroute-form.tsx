'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { rerouteBatchAction } from '../../batch-actions-server';
import type { RerouteErrorCode } from '@/modules/wms/batches/reroute-rules';

export interface RerouteOption {
  id: string;
  label: string;
  code: string;
  pinOffRoute: boolean;
  noSchedule: boolean;
}

type Refusal = RerouteErrorCode | 'busy_retry' | 'validation' | 'offline' | 'unauthenticated';

/**
 * «Yo'nalishni o'zgartirish» — the Mashina tab's form (the reroute round).
 *
 * Controlled inputs, and not a `<form action>`: a refusal keeps both the
 * chosen warehouse and the typed reason (#377/#463), and the press awaits the
 * action inside try/finally so `pending` can never stick (#882). No
 * `router.refresh()` after a success — the action revalidates, and a refresh
 * after it is the pending-for-ever shape (#1242). The one refresh is after
 * `dest_changed`: nothing was written, no action is pending, and the page
 * must show the destination a colleague just chose — the kept choice and
 * reason survive it, because the component keeps its state across a refresh
 * (the reroute review). What the new road means (no pin on it, no date for
 * it) is said UNDER the choice, before the press.
 *
 * Imports only the refusal TYPE from the rules: a value import that reached
 * the database client would ship postgres to the phone (#276).
 */
export function RerouteForm({
  batchId,
  batchCode,
  fromId,
  fromCode,
  targets,
  hiddenByScope = 0,
}: {
  batchId: string;
  batchCode: string;
  /** The destination this page was drawn for — the compare-and-set's «seen». */
  fromId: string;
  fromCode: string;
  targets: RerouteOption[];
  /** Admissible warehouses left out only because they are not this person's. */
  hiddenByScope?: number;
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const router = useRouter();
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  const [done, setDone] = useState<{ to: string; pinOffRoute: boolean; noSchedule: boolean } | null>(null);
  const chosen = targets.find((option) => option.id === target) ?? null;

  // A literal map (#163): typecheck forces a sentence for every refusal the
  // service can give.
  const refusalText: Record<Refusal, string> = {
    forbidden: t('reroute.errors.forbidden'),
    out_of_scope: t('reroute.errors.out_of_scope'),
    batch_not_found: t('reroute.errors.batch_not_found'),
    not_in_transit: t('reroute.errors.not_in_transit'),
    dest_changed: t('reroute.errors.dest_changed'),
    reason_required: t('reroute.errors.reason_required'),
    reason_too_long: t('reroute.errors.reason_too_long'),
    bad_target: t('reroute.errors.bad_target'),
    same_destination: t('reroute.errors.same_destination'),
    destination_is_origin: t('reroute.errors.destination_is_origin'),
    target_inactive: t('reroute.errors.target_inactive'),
    country_unknown: t('reroute.errors.country_unknown'),
    other_country: t('reroute.errors.other_country'),
    busy_retry: t('reroute.errors.busy_retry'),
    validation: t('reroute.errors.validation'),
    offline: t('reroute.errors.offline'),
    unauthenticated: t('reroute.errors.unauthenticated'),
  };

  if (targets.length === 0) {
    // «There is none» and «there are some, not yours» are different answers
    // (the reroute review): the second one is a question for an admin.
    return (
      <p className="text-sm text-ink-500" data-testid="reroute-no-targets">
        {hiddenByScope > 0 ? t('reroute.noTargetsInScope') : t('reroute.noTargets')}
      </p>
    );
  }

  async function submit() {
    if (!chosen) return;
    // The house idiom: the confirm names the truck and both warehouses, and
    // Cancel sends nothing.
    if (!window.confirm(t('reroute.confirm', { code: batchCode, from: fromCode, to: chosen.code }))) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const res = await rerouteBatchAction({
        batchId,
        destWarehouseId: chosen.id,
        seenDestWarehouseId: fromId,
        reason,
      });
      if (!res.ok) {
        setError(res.error);
        // A colleague moved the truck first: show the destination as it is
        // now (the «seen» this form posts comes from the page).
        if (res.error === 'dest_changed') router.refresh();
        return;
      }
      setDone({ to: res.toCode, pinOffRoute: res.pinOffRoute, noSchedule: res.noSchedule });
      setTarget('');
      setReason('');
    } catch {
      setError('offline');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="reroute-form">
      <div>
        <label className="label" htmlFor="reroute-target">
          {t('reroute.target')}
        </label>
        <select
          id="reroute-target"
          className="input"
          data-testid="reroute-target"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setDone(null);
          }}
        >
          <option value="">{t('reroute.targetPick')}</option>
          {targets.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {chosen && (chosen.pinOffRoute || chosen.noSchedule) && (
          <div className="mt-1 space-y-0.5 text-xs text-ink-500" data-testid="reroute-consequences">
            {chosen.pinOffRoute && <p>{t('reroute.pinOff')}</p>}
            {chosen.noSchedule && <p>{t('reroute.noSchedule')}</p>}
          </div>
        )}
      </div>
      <div>
        <label className="label" htmlFor="reroute-reason">
          {t('reroute.reason')}
        </label>
        <input
          id="reroute-reason"
          className="input"
          maxLength={500}
          data-testid="reroute-reason"
          placeholder={t('reroute.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <p className="text-xs text-ink-500">{t('reroute.hint')}</p>
      <button
        type="button"
        className="btn-primary w-full disabled:opacity-50"
        data-testid="reroute-submit"
        disabled={pending || !chosen || reason.trim().length < 3}
        onClick={submit}
      >
        {pending ? tc('loading') : t('reroute.submit')}
      </button>
      {error && (
        <p role="alert" data-testid="reroute-refusal" className="text-sm font-semibold text-bad">
          {refusalText[error]}
        </p>
      )}
      {done && (
        <div data-testid="reroute-done" className="space-y-0.5 text-sm font-semibold text-good">
          <p>{t('reroute.done', { to: done.to })}</p>
          {done.pinOffRoute && <p className="text-xs font-normal text-ink-500">{t('reroute.pinOff')}</p>}
          {done.noSchedule && <p className="text-xs font-normal text-ink-500">{t('reroute.noSchedule')}</p>}
        </div>
      )}
    </div>
  );
}
