'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { createCrateAction } from '../actions';

interface WarehouseOption {
  id: string;
  code: string;
  country: string;
}
interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
}
interface CratableBox {
  boxId: string;
  shortCode: string;
  seqInLot: number;
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  receiptNumber: string | null;
}

/**
 * W2 crate builder (spec 6.2): pick warehouse + client, tick in-stock boxes
 * (whole lots or individual boxes), confirm "logist approved", optional
 * measured dims/weight + note, create → label.
 */
export function CrateBuilder({
  warehouses,
  currencies,
}: {
  warehouses: WarehouseOption[];
  currencies: string[];
}) {
  const t = useTranslations('crates');
  const tc = useTranslations('common');
  const router = useRouter();
  const [crateId] = useState(() => uuidv4());
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [client, setClient] = useState<ClientHit | null>(null);
  const [boxes, setBoxes] = useState<CratableBox[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<'yashik' | 'karkas'>('yashik');
  const [approved, setApproved] = useState(false);
  const [note, setNote] = useState('');
  const [dims, setDims] = useState({ lengthCm: '', widthCm: '', heightCm: '', weightKg: '' });
  const [costAmount, setCostAmount] = useState('');
  const [costCurrency, setCostCurrency] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultCurrency =
    warehouses.find((wh) => wh.id === warehouseId)?.country === 'CN' ? 'CNY' : 'USD';

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
      setBoxes([]);
      setSelected(new Set());
      return;
    }
    // Abort on client/warehouse switch — a stale slow response must not
    // overwrite the fresh list and wipe the selection (UX audit).
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/crates/boxes?warehouseId=${warehouseId}&clientId=${client.id}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { boxes: CratableBox[] };
          setBoxes(data.boxes);
          setSelected(new Set());
        }
      } catch {
        /* aborted */
      }
    })();
    return () => controller.abort();
  }, [client, warehouseId]);

  const lots = new Map<string, CratableBox[]>();
  for (const box of boxes) {
    const list = lots.get(box.lotId) ?? [];
    list.push(box);
    lots.set(box.lotId, list);
  }

  function toggle(boxId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(boxId)) next.delete(boxId);
      else next.add(boxId);
      return next;
    });
  }

  function toggleLot(lotBoxes: CratableBox[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = lotBoxes.every((b) => next.has(b.boxId));
      for (const b of lotBoxes) {
        if (allIn) next.delete(b.boxId);
        else next.add(b.boxId);
      }
      return next;
    });
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await createCrateAction({
        crateId,
        warehouseId,
        boxIds: [...selected],
        kind,
        logistApproved: approved as true,
        note,
        lengthCm: dims.lengthCm ? Number(dims.lengthCm) : undefined,
        widthCm: dims.widthCm ? Number(dims.widthCm) : undefined,
        heightCm: dims.heightCm ? Number(dims.heightCm) : undefined,
        weightKg: dims.weightKg ? Number(dims.weightKg) : undefined,
        cratingCost:
          Number(costAmount) > 0
            ? { amount: Number(costAmount), currency: costCurrency || defaultCurrency }
            : undefined,
      });
      if (res.ok) router.push(`/crates/${res.crateId}`);
      else setError(res.error ?? 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3 pb-24">
      <div className="card space-y-2 !p-3">
        <div className="flex gap-2">
          <select
            data-testid="crate-wh"
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
                <button
                  type="button"
                  aria-label={tc('cancel')}
                  className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center text-lg"
                  onClick={() => setClient(null)}
                >
                  ✕
                </button>
              </div>
            ) : (
              <input
                id="crateClientQuery"
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
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-line-strong text-sm font-semibold">
            {(['yashik', 'karkas'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`px-3 py-2 ${kind === k ? 'bg-brand-600 text-white' : 'bg-surface-raised'}`}
                onClick={() => setKind(k)}
              >
                {k === 'yashik' ? t('yashik') : t('karkas')}
              </button>
            ))}
          </div>
          <input
            aria-label={t('note')}
            className="input min-w-0 flex-1"
            placeholder={`📝 ${t('note')}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {(
            [
              ['lengthCm', 'L'],
              ['widthCm', 'W'],
              ['heightCm', 'H'],
              ['weightKg', 'kg'],
            ] as const
          ).map(([field, label]) => (
            <input
              key={field}
              aria-label={label}
              className="input-cell !h-10 text-center"
              inputMode="decimal"
              placeholder={label}
              value={dims[field]}
              onChange={(e) => setDims((d) => ({ ...d, [field]: e.target.value }))}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <input
            aria-label={t('cratingCost')}
            className="input flex-1"
            inputMode="decimal"
            placeholder={`💰 ${t('cratingCost')}`}
            value={costAmount}
            onChange={(e) => setCostAmount(e.target.value)}
          />
          <select
            aria-label="currency"
            className="input !w-24 shrink-0"
            value={costCurrency || defaultCurrency}
            onChange={(e) => setCostCurrency(e.target.value)}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <p className="text-xs text-ink-500">{t('dimsHint')}</p>
      </div>

      {client && (
        <div className="card space-y-2 !p-3" id="cratable-boxes">
          {lots.size === 0 && <p className="text-sm text-ink-500">{t('noBoxes')}</p>}
          {[...lots.entries()].map(([lotId, lotBoxes]) => {
            const allIn = lotBoxes.every((b) => selected.has(b.boxId));
            const first = lotBoxes[0]!;
            return (
              <div key={lotId} className="rounded-lg border border-line p-2">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => toggleLot(lotBoxes)}
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded border text-sm font-bold ${
                      allIn ? 'border-blue-700 bg-brand-600 text-white' : 'border-line-strong'
                    }`}
                  >
                    {allIn ? '✓' : ''}
                  </span>
                  <span className="font-mono text-lg font-extrabold text-brand-700">
                    {first.letter ?? '·'}
                  </span>
                  <span className="truncate">
                    {first.productNameZh}
                    {first.productNameRu && (
                      <span className="text-ink-500"> ({first.productNameRu})</span>
                    )}
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
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {t(`errors.${error}` as never) || tc('error')}
        </p>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
        <div className="mx-auto max-w-4xl space-y-2 px-4 py-2.5">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            {t('logistApproved')}
          </label>
          <button
            type="button"
            data-testid="create-crate"
            className="btn-primary w-full disabled:opacity-50"
            disabled={submitting || !approved || selected.size === 0}
            onClick={submit}
          >
            {submitting ? tc('loading') : `🧰 ${t('create')} (${selected.size} 📦)`}
          </button>
        </div>
      </div>
    </div>
  );
}
