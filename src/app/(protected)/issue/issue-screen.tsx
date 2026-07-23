'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { Scanner } from '@/components/scan/scanner';
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
    void (async () => {
      const res = await fetch(`/api/issue/list?warehouseId=${warehouseId}&clientId=${client.id}`);
      if (res.ok) {
        setList(((await res.json()) as { boxes: IssuableBox[] }).boxes);
        setSelected(new Set());
      }
    })();
  }, [client, warehouseId, doneHandover]);

  function toggle(boxId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(boxId)) next.delete(boxId);
      else next.add(boxId);
      return next;
    });
  }

  function onScan(code: string) {
    const hit = list.find((b) => b.shortCode === code);
    if (hit && !selected.has(hit.boxId)) {
      toggle(hit.boxId);
      if ('vibrate' in navigator) navigator.vibrate(60);
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
              <div className="flex min-h-12 items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3">
                <span className="truncate font-mono font-extrabold text-green-800">
                  {client.clientCode} — {client.name}
                </span>
                <button type="button" aria-label={tc('cancel')} className="ml-auto shrink-0 text-lg" onClick={() => setClient(null)}>
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
              <ul className="absolute z-20 mt-1 w-72 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white shadow-lg">
                {clientHits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-gray-50"
                      onClick={() => {
                        setClient(hit);
                        setClientQuery('');
                        setDoneHandover(null);
                      }}
                    >
                      <span className="font-mono font-extrabold text-blue-800">{hit.clientCode}</span>
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
        <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 p-3">
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

      {client && (
        <>
          <Scanner active onCode={onScan} />
          <div className="card space-y-2 !p-3" id="issuable-boxes">
            {lots.size === 0 && <p className="text-sm text-gray-500">{t('noBoxes')}</p>}
            {[...lots.entries()].map(([lotId, lotBoxes]) => {
              const first = lotBoxes[0]!;
              const allIn = lotBoxes.every((b) => selected.has(b.boxId));
              return (
                <div key={lotId} className="rounded-lg border border-gray-200 p-2">
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
                    <span className={`flex h-6 w-6 items-center justify-center rounded border text-sm font-bold ${allIn ? 'border-blue-700 bg-blue-700 text-white' : 'border-gray-300'}`}>
                      {allIn ? '✓' : ''}
                    </span>
                    <span className="font-mono text-lg font-extrabold text-blue-800">{first.letter ?? '·'}</span>
                    <span className="truncate">
                      {first.productNameZh}
                      {first.productNameRu && <span className="text-gray-500"> ({first.productNameRu})</span>}
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
                        className={`rounded-md border px-2 py-1 font-mono text-xs font-semibold ${
                          selected.has(box.boxId)
                            ? 'border-blue-700 bg-blue-50 text-blue-800'
                            : 'border-gray-200 text-gray-600'
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
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      )}

      {client && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-gray-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
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
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" className="h-5 w-5" checked={debtOk} onChange={(e) => setDebtOk(e.target.checked)} />
              {t('debtOk')}
            </label>
            <button
              type="button"
              data-testid="confirm-issue"
              className="btn-primary w-full disabled:opacity-50"
              disabled={submitting || selected.size === 0 || personName.trim().length < 2 || personPhone.trim().length < 5}
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
