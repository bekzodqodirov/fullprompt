'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { Scanner } from '@/components/scan/scanner';
import { armScanAudio, scanFeedback } from '@/components/scan/feedback';
import { issueBoxesAction } from './actions';

interface WarehouseOption {
  id: string;
  code: string;
}
interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
}
interface IssuableBox {
  boxId: string;
  shortCode: string;
  seqInLot: number;
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
}

/**
 * W7 issue mode (spec 6.7): pick warehouse + client → issuable boxes grouped
 * by lot → tap or scan out → receiver name/phone (+ debt-OK slot, no logic) →
 * issued. Partial pickup just leaves the rest.
 */
export function IssueScreen({ warehouses }: { warehouses: WarehouseOption[] }) {
  const t = useTranslations('issue');
  const tc = useTranslations('common');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [client, setClient] = useState<ClientHit | null>(null);
  const [list, setList] = useState<IssuableBox[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [personName, setPersonName] = useState('');
  const [personPhone, setPersonPhone] = useState('');
  const [debtOk, setDebtOk] = useState(false);
  const [debtUsd, setDebtUsd] = useState(0);
  /** The slice of that debt the client was deliberately given more time for. */
  const [deferredUsd, setDeferredUsd] = useState(0);
  /**
   * What the gate actually decides on. The client's real debt still shows in
   * full — a screen that quietly hid the deferred part would be lying about
   * what is owed — but only the undeferred remainder blocks the handover.
   */
  const blockingDebt = debtUsd - deferredUsd;
  const [canOverrideDebt, setCanOverrideDebt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneHandover, setDoneHandover] = useState<string | null>(null);

  useEffect(() => {
    if (!clientQuery.trim() || client) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClientHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/clients/search?q=${encodeURIComponent(clientQuery)}`);
      if (res.ok) setClientHits(((await res.json()) as { results: ClientHit[] }).results);
    }, 250);
    return () => clearTimeout(timer);
  }, [clientQuery, client]);

  useEffect(() => {
    if (!client || !warehouseId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setList([]);
      setSelected(new Set());
      return;
    }
    // Abort on client/warehouse switch — a stale slow response must not
    // overwrite the fresh list and wipe the selection (UX audit).
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/issue/list?warehouseId=${warehouseId}&clientId=${client.id}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as {
            boxes: IssuableBox[];
            debtUsd: number;
            deferredUsd: number;
            canOverrideDebt: boolean;
          };
          setList(data.boxes);
          setDebtUsd(data.debtUsd);
          setDeferredUsd(data.deferredUsd ?? 0);
          setCanOverrideDebt(data.canOverrideDebt);
          setSelected(new Set());
          setDebtOk(false);
        }
      } catch {
        /* aborted */
      }
    })();
    return () => controller.abort();
  }, [client, warehouseId, doneHandover]);

  function toggle(boxId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(boxId)) next.delete(boxId);
      else next.add(boxId);
      return next;
    });
  }

  // iOS unlocks the beep only inside a user gesture — arm on mount.
  useEffect(() => armScanAudio(), []);

  function onScan(code: string) {
    const hit = list.find((b) => b.shortCode === code);
    if (hit && !selected.has(hit.boxId)) {
      toggle(hit.boxId);
      scanFeedback('ok');
    } else {
      // Unknown code or already selected — buzz so a silent no-op never
      // reads as "scanned fine" (UX audit leftover).
      scanFeedback(hit ? 'dup' : 'bad');
    }
  }

  async function submit() {
    if (!client) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await issueBoxesAction({
        handoverId: uuidv4(),
        clientId: client.id,
        warehouseId,
        boxIds: [...selected],
        personName,
        personPhone,
        debtOk,
      });
      if (res.ok) {
        setDoneHandover(res.handoverId!);
        setPersonName('');
        setPersonPhone('');
        setDebtOk(false);
      } else if (res.error === 'debt_block') {
        setError(t('debtBlocked'));
      } else if (res.error === 'debt_override_forbidden') {
        setError(t('debtNeedsManager'));
      } else {
        setError(res.error ?? 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const lots = new Map<string, IssuableBox[]>();
  for (const box of list) lots.set(box.lotId, [...(lots.get(box.lotId) ?? []), box]);

  return (
    <div className="space-y-3 pb-28">
      <div className="card space-y-2 !p-3">
        <div className="flex gap-2">
          <select
            data-testid="issue-wh"
            aria-label={t('warehouse')}
            className="input !w-24 shrink-0 font-mono font-bold"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            {warehouses.map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.code}
              </option>
            ))}
          </select>
          <div className="min-w-0 flex-1">
            {client ? (
              <div className="flex min-h-12 items-center gap-2 rounded-lg border border-good/30 bg-good/10 px-3">
                <span className="truncate font-mono font-extrabold text-good">
                  {client.clientCode} — {client.name}
                </span>
                <button type="button" aria-label={tc('cancel')} className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center text-lg" onClick={() => setClient(null)}>
                  ✕
                </button>
              </div>
            ) : (
              <input
                id="issueClientQuery"
                className="input font-mono uppercase"
                value={clientQuery}
                onChange={(e) => setClientQuery(e.target.value)}
                placeholder={t('clientCode')}
                autoComplete="off"
              />
            )}
            {clientHits.length > 0 && !client && (
              <ul className="absolute z-20 mt-1 w-72 divide-y divide-line rounded-lg border border-line bg-surface-raised shadow-lg">
                {clientHits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-surface-sunken"
                      onClick={() => {
                        setClient(hit);
                        setClientQuery('');
                        setDoneHandover(null);
                      }}
                    >
                      <span className="font-mono font-extrabold text-brand-700">{hit.clientCode}</span>
                      <span className="truncate">{hit.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {doneHandover && (
        <div className="space-y-2 rounded-lg border border-good/30 bg-good/10 p-3">
          <p className="font-semibold">✅ {t('issued')}</p>
          <a
            href={`/api/handovers/${doneHandover}/act`}
            target="_blank"
            className="btn-secondary w-full"
            data-testid="act-link"
          >
            📄 {t('act')}
          </a>
        </div>
      )}

      {client && debtUsd > 0.009 && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            blockingDebt > 0.009
              ? 'border-bad/30 bg-bad/10'
              : 'border-warn/30 bg-warn/10'
          }`}
        >
          <p className={`font-bold ${blockingDebt > 0.009 ? 'text-bad' : 'text-warn'}`}>
            ⚠️ {t('debtBanner', { amount: debtUsd.toFixed(2) })}
          </p>
          {/* An open gate beside a real debt reads as a bug unless the screen
              says why (docs/DEALS.md). */}
          {deferredUsd > 0.009 && (
            <p className="mt-1 font-semibold text-warn">
              ⏳ {t('debtDeferred', { amount: deferredUsd.toFixed(2) })}
            </p>
          )}
          {blockingDebt > 0.009 && !canOverrideDebt && (
            <p className="mt-1 text-bad">{t('debtNeedsManager')}</p>
          )}
        </div>
      )}

      {client && (
        <>
          <Scanner active onCode={onScan} />
          <div className="card space-y-2 !p-3" id="issuable-boxes">
            {lots.size === 0 && <p className="text-sm text-ink-500">{t('noBoxes')}</p>}
            {[...lots.entries()].map(([lotId, lotBoxes]) => {
              const first = lotBoxes[0]!;
              const allIn = lotBoxes.every((b) => selected.has(b.boxId));
              return (
                <div key={lotId} className="rounded-lg border border-line p-2">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    onClick={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const b of lotBoxes) {
                          if (allIn) next.delete(b.boxId);
                          else next.add(b.boxId);
                        }
                        return next;
                      })
                    }
                  >
                    <span className={`flex h-6 w-6 items-center justify-center rounded border text-sm font-bold ${allIn ? 'border-blue-700 bg-brand-600 text-white' : 'border-line-strong'}`}>
                      {allIn ? '✓' : ''}
                    </span>
                    <span className="font-mono text-lg font-extrabold text-brand-700">{first.letter ?? '·'}</span>
                    <span className="truncate">
                      {first.productNameZh}
                      {first.productNameRu && <span className="text-ink-500"> ({first.productNameRu})</span>}
                    </span>
                    <span className="ml-auto whitespace-nowrap text-sm font-semibold">
                      {lotBoxes.filter((b) => selected.has(b.boxId)).length}/{lotBoxes.length} 📦
                    </span>
                  </button>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {lotBoxes.map((box) => (
                      <button
                        key={box.boxId}
                        type="button"
                        className={`min-h-10 rounded-md border px-3 py-1.5 font-mono text-sm font-semibold ${
                          selected.has(box.boxId)
                            ? 'border-blue-700 bg-brand-50 text-brand-700'
                            : 'border-line text-ink-700'
                        }`}
                        onClick={() => toggle(box.boxId)}
                      >
                        {box.seqInLot}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {error}
        </p>
      )}

      {client && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          <div className="mx-auto max-w-4xl space-y-2 px-4 py-2.5">
            <div className="flex gap-2">
              <input
                data-testid="receiver-name"
                className="input flex-1"
                placeholder={t('personName')}
                value={personName}
                onChange={(e) => setPersonName(e.target.value)}
              />
              <input
                data-testid="receiver-phone"
                className="input flex-1"
                inputMode="tel"
                placeholder={t('personPhone')}
                value={personPhone}
                onChange={(e) => setPersonPhone(e.target.value)}
              />
            </div>
            {blockingDebt > 0.009 && canOverrideDebt && (
              <label className="flex items-center gap-2 text-sm font-semibold text-bad">
                <input type="checkbox" className="h-5 w-5" checked={debtOk} onChange={(e) => setDebtOk(e.target.checked)} />
                {t('debtOk')}
              </label>
            )}
            <button
              type="button"
              data-testid="confirm-issue"
              className="btn-primary w-full disabled:opacity-50"
              disabled={
                submitting ||
                selected.size === 0 ||
                personName.trim().length < 2 ||
                personPhone.trim().length < 5 ||
                (blockingDebt > 0.009 && !debtOk)
              }
              onClick={submit}
            >
              {submitting ? tc('loading') : `🤝 ${t('confirm')} (${selected.size} 📦)`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
