'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  closeBatchAction,
  finishUnloadAction,
  resolveMissingAction,
  resolveMissingLotAction,
  unloadRemainingAction,
} from '../batch-actions-server';

interface MissingBox {
  boxId: string;
  shortCode: string;
  label: string;
  /** The lot and its goods (0112): a stickerless carton is found by its lot. */
  lotId: string;
  product: string;
  crated: boolean;
}

/** Destination-side controls: finish unload, resolve missing boxes, close. */
export function UnloadActions({
  batchId,
  status,
  missing,
  remaining,
  acceptable,
  canShortcut,
  canResolve,
  canCountResolve,
  canClose,
}: {
  batchId: string;
  status: string;
  missing: MissingBox[];
  /** Manifest boxes still waiting to be accepted at the destination. */
  remaining: number;
  /**
   * What «Hammasini qabul qilish» will really land: `remaining` minus the
   * loose cartons of lots the office counted HERE (0112, decision 21) —
   * those are the count's declared shortfall, not «everything else».
   */
  acceptable: number;
  /**
   * May this person take the two SHORTCUTS — accept everything without
   * scanning, and close over cartons nobody scanned? Both are manager acts
   * (owner: «hammasini qabul qilib olish degan knobkani skladchilardan olib
   * tashla»), and they travel together: taking away only the safe one leaves
   * the operator holding the lossy one.
   */
  canShortcut: boolean;
  canResolve: boolean;
  /** The destination's COUNT door — the per-lot answer (decision 22). */
  canCountResolve: boolean;
  canClose: boolean;
}) {
  const t = useTranslations('unloading');
  const tc = useTranslations('common');
  const tca = useTranslations('countAccept');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The road-loss form is open for ONE box at a time, and holds what was
  // typed until the server has answered (a refusal must not eat it).
  const [lostFor, setLostFor] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [failures, setFailures] = useState<string | null>(null);

  // A refusal is a sentence (a literal map, #163), never the service's code.
  function errorText(code: string): string {
    switch (code) {
      case 'not_missing':
        return t('errors.not_missing');
      case 'reason_required':
        return t('errors.reason_required');
      case 'finish_needs_manager':
        return t('errors.finish_needs_manager');
      case 'finish_unload_first':
        return t('errors.finish_unload_first');
      case 'batch_not_unloading':
        return t('errors.batch_not_unloading');
      case 'batch_not_found':
      case 'box_not_found':
        return t('errors.not_found');
      case 'forbidden':
        return tc('forbidden');
      default:
        return t('errors.failed');
    }
  }

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'error');
      router.refresh();
      return res;
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {['in_transit', 'arrived'].includes(status) && (
        <p className="rounded-lg bg-surface-sunken p-2 text-sm font-semibold" data-testid="unload-remaining">
          {remaining > 0 ? `📦 ${t('remaining', { n: remaining })}` : `✅ ${t('allAccepted')}`}
        </p>
      )}

      {/* The truck is standing in the yard: accepting everything must be at
          least as easy as finishing, or the operator reaches for the button
          that declares the cargo lost (owner's report). */}
      {['in_transit', 'arrived'].includes(status) && acceptable > 0 && canShortcut && (
        <button
          type="button"
          data-testid="accept-all"
          className="btn-primary w-full disabled:opacity-50"
          disabled={pending}
          onClick={async () => {
            if (!window.confirm(t('acceptAllConfirm', { n: acceptable }))) return;
            const res = (await run(() => unloadRemainingAction(batchId))) as {
              ok: boolean;
              accepted?: number;
              skippedCounted?: number;
            };
            if (res.ok) {
              setSummary(
                `✅ ${t('acceptAllDone', { n: res.accepted ?? 0 })}` +
                  (res.skippedCounted ? ` · ${tca('acceptAllSkipped', { n: res.skippedCounted })}` : ''),
              );
            }
          }}
        >
          📥 {t('acceptAll', { n: acceptable })}
        </button>
      )}
      {['in_transit', 'arrived'].includes(status) && remaining > acceptable && canShortcut && (
        <p className="text-xs text-ink-500" data-testid="accept-all-skips">
          🔢 {tca('acceptAllSkips', { n: remaining - acceptable })}
        </p>
      )}

      {/* Closing with cartons outstanding declares them lost, so the button
          renders for the operator only when there is nothing left to lose —
          and a manager keeps it in both states. The service refuses too. */}
      {['in_transit', 'arrived'].includes(status) && remaining > 0 && !canShortcut && (
        <p className="rounded-lg bg-surface-sunken p-2 text-xs text-ink-500" data-testid="unload-scan-hint">
          {t('scanTheRest')}
        </p>
      )}

      {['in_transit', 'arrived'].includes(status) && (remaining === 0 || canShortcut) && (
        <button
          type="button"
          data-testid="finish-unload"
          className={`w-full disabled:opacity-50 ${remaining > 0 ? 'btn-secondary' : 'btn-primary'}`}
          disabled={pending}
          onClick={async () => {
            // Finishing with boxes left over marks them lost — never let that
            // happen on a tap the operator read as "accept everything".
            if (remaining > 0 && !window.confirm(t('finishConfirm', { n: remaining }))) return;
            const res = (await run(() => finishUnloadAction(batchId))) as {
              ok: boolean;
              missing?: string[];
            };
            if (res.ok) {
              setSummary(
                res.missing && res.missing.length > 0
                  ? `🔍 ${t('missingSummary', { n: res.missing.length })}: ${res.missing.join(', ')}`
                  : `✅ ${t('allUnloaded')}`,
              );
            }
          }}
        >
          🏁 {t('finishUnload')}
        </button>
      )}
      {summary && <p className="rounded-lg bg-brand-50 p-2 text-sm font-semibold">{summary}</p>}

      {missing.length > 0 && (
        <div className="space-y-2 rounded-lg border border-bad/30 bg-bad/10 p-3">
          <p className="text-sm font-bold">🔍 {t('missingTitle')}</p>
          {canResolve && missing.length > 1 && (
            <button
              type="button"
              data-testid="found-here-all"
              className="btn-primary w-full disabled:opacity-50"
              disabled={pending}
              onClick={async () => {
                // The whole truck arrived but was accepted without scanning —
                // one tap lands everything here instead of 13 taps.
                if (!window.confirm(t('foundHereAllConfirm', { n: missing.length }))) return;
                setPending(true);
                setError(null);
                setFailures(null);
                try {
                  // Every refusal is kept, not the last one written over the
                  // rest: «3 of 13 failed» is a different fact from «1 failed».
                  const failed: string[] = [];
                  for (const box of missing) {
                    const res = await resolveMissingAction({ boxId: box.boxId, resolution: 'found_here' });
                    if (!res.ok) failed.push(res.error ?? 'error');
                  }
                  if (failed.length) {
                    setFailures(tca('foundHereAllFailed', { n: failed.length, first: errorText(failed[0]!) }));
                  }
                  router.refresh();
                } finally {
                  setPending(false);
                }
              }}
            >
              ✅ {t('foundHereAll', { n: missing.length })}
            </button>
          )}
          {failures && (
            <p data-testid="found-here-all-failed" className="text-sm font-semibold text-bad">
              {failures}
            </p>
          )}
          {missingGroups(missing).map((group) =>
            group.lotId ? (
              <MissingLotCard
                key={group.lotId}
                batchId={batchId}
                group={group}
                canCountResolve={canCountResolve}
                boxesOpen={!canCountResolve}
                pending={pending}
                onDone={() => router.refresh()}
              >
                {group.boxes.map((box) => renderBox(box))}
              </MissingLotCard>
            ) : (
              group.boxes.map((box) => renderBox(box))
            ),
          )}
        </div>
      )}

      {status === 'unloaded' && canClose && (
        <button
          type="button"
          data-testid="close-batch"
          className="btn-secondary w-full disabled:opacity-50"
          disabled={pending}
          onClick={() => run(() => closeBatchAction(batchId))}
        >
          🔒 {t('closeBatch')}
        </button>
      )}
      {pending && <p className="text-sm">{tc('loading')}</p>}
      {error && (
        <p data-testid="unload-error" className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad">
          {errorText(error)}
        </p>
      )}
    </div>
  );

  function renderBox(box: MissingBox) {
    return (
      <div key={box.boxId} className="space-y-1.5 rounded-lg bg-surface-raised p-2 text-sm">
        <p>
          <span className="font-mono font-bold">{box.shortCode}</span>{' '}
          <span className="font-mono font-extrabold text-brand-700">{box.label}</span>
        </p>
        {canResolve && (
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary flex-1 !min-h-9 px-2 text-xs"
              disabled={pending}
              onClick={() =>
                run(() => resolveMissingAction({ boxId: box.boxId, resolution: 'found_at_origin' }))
              }
            >
              ↩️ {t('foundAtOrigin')}
            </button>
            <button
              type="button"
              data-testid={`found-here-${box.shortCode}`}
              className="btn-secondary flex-1 !min-h-9 px-2 text-xs"
              disabled={pending}
              onClick={() =>
                run(() => resolveMissingAction({ boxId: box.boxId, resolution: 'found_here' }))
              }
            >
              ✅ {t('foundHere')}
            </button>
          </div>
        )}
        {/* The third answer, and the only one that is not «found»: the
            carton is gone. Never part of the bulk «all here» — a loss
            is one person's written sentence about one box. */}
        {canResolve && lostFor !== box.boxId && (
          <button
            type="button"
            data-testid={`lost-road-${box.shortCode}`}
            className="btn-danger w-full !min-h-9 px-2 text-xs"
            disabled={pending}
            onClick={() => {
              setLostFor(box.boxId);
              setLostReason('');
            }}
          >
            ❌ {t('lostInTransit')}
          </button>
        )}
        {canResolve && lostFor === box.boxId && (
          <div className="space-y-1.5">
            <input
              data-testid={`lost-road-reason-${box.shortCode}`}
              className="input"
              placeholder={t('lostReason')}
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                type="button"
                data-testid={`lost-road-confirm-${box.shortCode}`}
                className="btn-danger flex-1 !min-h-9 px-2 text-xs disabled:opacity-50"
                disabled={pending || lostReason.trim().length < 3}
                onClick={async () => {
                  if (!window.confirm(t('lostConfirm', { code: box.shortCode }))) return;
                  const res = await run(() =>
                    resolveMissingAction({
                      boxId: box.boxId,
                      resolution: 'lost_in_transit',
                      reason: lostReason,
                    }),
                  );
                  if (res.ok) {
                    setLostFor(null);
                    setLostReason('');
                  }
                }}
              >
                ❌ {t('lostInTransit')}
              </button>
              <button
                type="button"
                className="btn-secondary flex-1 !min-h-9 px-2 text-xs"
                onClick={() => setLostFor(null)}
              >
                {tc('cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
}

interface MissingGroup {
  /** Null for crated cartons: a crate's member is answered box by box, as always. */
  lotId: string | null;
  label: string;
  product: string;
  boxes: MissingBox[];
}

/** Loose missing cartons grouped by lot, in the order they came; crated ones stay single. */
function missingGroups(missing: MissingBox[]): MissingGroup[] {
  const out: MissingGroup[] = [];
  const byLot = new Map<string, MissingGroup>();
  for (const box of missing) {
    if (box.crated) {
      out.push({ lotId: null, label: box.label, product: box.product, boxes: [box] });
      continue;
    }
    let group = byLot.get(box.lotId);
    if (!group) {
      group = { lotId: box.lotId, label: box.label, product: box.product, boxes: [] };
      byLot.set(box.lotId, group);
      out.push(group);
    }
    group.boxes.push(box);
  }
  return out;
}

/**
 * One lot's missing cartons, answered by the lot and a NUMBER (0112,
 * decision 22): a stickerless carton has no code anybody can read, so «3 of
 * GS777-A are here» is the only question the office can answer. Behind the
 * count door; the per-box buttons keep living in the fold beneath, for the
 * warehouse manager who holds `receipts.void` and not the count door.
 */
function MissingLotCard({
  batchId,
  group,
  canCountResolve,
  boxesOpen,
  pending,
  onDone,
  children,
}: {
  batchId: string;
  group: MissingGroup;
  canCountResolve: boolean;
  boxesOpen: boolean;
  pending: boolean;
  onDone: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('countAccept');
  const tu = useTranslations('unloading');
  const tc = useTranslations('common');
  const total = group.boxes.length;
  const [n, setN] = useState(String(total));
  const [reason, setReason] = useState('');
  const [lostOpen, setLostOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refusal(code: string): string {
    switch (code) {
      case 'count_stale':
        return t('missing.errors.count_stale');
      case 'resolve_exceeds_missing':
        return t('missing.errors.resolve_exceeds_missing', { max: total });
      case 'reason_required':
        return tu('errors.reason_required');
      case 'busy_retry':
        return t('errors.busy_retry');
      case 'forbidden':
        return tc('forbidden');
      default:
        return tu('errors.failed');
    }
  }

  async function resolve(resolution: 'found_here' | 'found_at_origin' | 'lost_in_transit') {
    const count = Number(n);
    if (!Number.isInteger(count) || count < 1 || count > total) {
      setError(refusal('resolve_exceeds_missing'));
      return;
    }
    const confirmText =
      resolution === 'found_here'
        ? t('missing.hereConfirm', { lot: group.label, n: count })
        : resolution === 'found_at_origin'
          ? t('missing.originConfirm', { lot: group.label, n: count })
          : t('missing.lostConfirm', { lot: group.label, n: count });
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await resolveMissingLotAction({
        batchId,
        lotId: group.lotId,
        n: count,
        seenMissing: total,
        resolution,
        ...(resolution === 'lost_in_transit' ? { reason } : {}),
      });
      if (!res.ok) {
        setError(refusal(res.error ?? 'error'));
        return;
      }
      setLostOpen(false);
      setReason('');
      onDone();
    } catch {
      setError(t('offline'));
    } finally {
      setBusy(false);
    }
  }

  const disabled = pending || busy;
  return (
    <div className="space-y-1.5 rounded-lg bg-surface-raised p-2 text-sm" data-testid={`missing-lot-${group.lotId}`}>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono font-extrabold text-brand-700">{group.label}</span>
        <span className="min-w-0 flex-1 truncate text-ink-700">{group.product}</span>
        <span className="font-semibold" data-testid={`missing-lot-count-${group.lotId}`}>
          {t('missing.count', { n: total })}
        </span>
      </p>
      {canCountResolve && (
        <>
          <div className="flex gap-2">
            <div className="w-20 shrink-0">
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={total}
                aria-label={t('missing.n')}
                data-testid={`missing-lot-n-${group.lotId}`}
                value={n}
                onChange={(e) => setN(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-secondary min-w-0 flex-1 !min-h-9 px-2 text-xs disabled:opacity-50"
              data-testid={`missing-lot-here-${group.lotId}`}
              disabled={disabled}
              onClick={() => resolve('found_here')}
            >
              {t('missing.here')}
            </button>
            <button
              type="button"
              className="btn-secondary min-w-0 flex-1 !min-h-9 px-2 text-xs disabled:opacity-50"
              data-testid={`missing-lot-origin-${group.lotId}`}
              disabled={disabled}
              onClick={() => resolve('found_at_origin')}
            >
              {t('missing.origin')}
            </button>
          </div>
          {!lostOpen ? (
            <button
              type="button"
              className="btn-danger w-full !min-h-9 px-2 text-xs disabled:opacity-50"
              data-testid={`missing-lot-lost-${group.lotId}`}
              disabled={disabled}
              onClick={() => setLostOpen(true)}
            >
              {t('missing.lost')}
            </button>
          ) : (
            <div className="space-y-1.5">
              <input
                className="input"
                placeholder={tu('lostReason')}
                data-testid={`missing-lot-reason-${group.lotId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-danger flex-1 !min-h-9 px-2 text-xs disabled:opacity-50"
                  data-testid={`missing-lot-lost-confirm-${group.lotId}`}
                  disabled={disabled || reason.trim().length < 3}
                  onClick={() => resolve('lost_in_transit')}
                >
                  {t('missing.lost')}
                </button>
                <button
                  type="button"
                  className="btn-secondary flex-1 !min-h-9 px-2 text-xs"
                  onClick={() => setLostOpen(false)}
                >
                  {tc('cancel')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="text-xs font-semibold text-bad" data-testid={`missing-lot-error-${group.lotId}`}>
          {error}
        </p>
      )}
      <details open={boxesOpen} data-testid={`missing-lot-boxes-${group.lotId}`}>
        <summary className="cursor-pointer text-xs text-ink-500">{t('missing.boxes', { n: total })}</summary>
        <div className="mt-1.5 space-y-1.5">{children}</div>
      </details>
    </div>
  );
}
