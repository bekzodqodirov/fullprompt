'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { createCrateAction } from '../actions';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';

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

/** What a «🧱 Palet qilish» door opens the builder with (0112, Q10 d). */
export interface CrateBuilderInitial {
  warehouseId?: string;
  client?: ClientHit;
  lotId?: string;
  kind?: 'karkas' | 'palet';
}

/** The kinds, in chip order — the labels live in two namespaces (crates / ofis). */
const KIND_CHIPS = ['yashik', 'karkas', 'palet'] as const;
type Kind = (typeof KIND_CHIPS)[number];

/**
 * W2 crate builder (spec 6.2): pick warehouse + client, tick in-stock boxes
 * (whole lots or individual boxes) — or, for a pallet of stickerless cartons,
 * say HOW MANY of a lot (0112, Q10 d: «N ta», the service picks which) —
 * confirm "logist approved", optional measured dims/weight + note, create →
 * label.
 */
export function CrateBuilder({
  warehouses,
  currencies,
  initial = {},
}: {
  warehouses: WarehouseOption[];
  currencies: string[];
  initial?: CrateBuilderInitial;
}) {
  const t = useTranslations('crates');
  const to = useTranslations('ofis');
  const tc = useTranslations('common');
  const router = useRouter();
  const [crateId] = useState(() => uuidv4());
  const [warehouseId, setWarehouseId] = useState(initial.warehouseId ?? warehouses[0]?.id ?? '');
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [client, setClient] = useState<ClientHit | null>(initial.client ?? null);
  const [boxes, setBoxes] = useState<CratableBox[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<Kind>(initial.kind ?? 'yashik');
  /** «N ta» per lot: a lot with a count sends no ticks, the service picks. */
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const initialLotRef = useRef<HTMLInputElement | null>(null);
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
          setCounts({});
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

  // Opened from a lot's door: bring that lot into view with its count box
  // focused — the whole point of the door is «N of THIS lot on a pallet».
  const hasInitialLot = Boolean(initial.lotId && lots.has(initial.lotId));
  useEffect(() => {
    if (!hasInitialLot) return;
    initialLotRef.current?.scrollIntoView({ block: 'center' });
    initialLotRef.current?.focus();
  }, [hasInitialLot]);

  /** A lot's typed count, when it is a positive whole number. */
  const countOf = (lotId: string) => {
    const n = Number(counts[lotId]);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const countedLots = new Set([...lots.keys()].filter((lotId) => countOf(lotId) > 0));
  const tickedIds = boxes
    .filter((box) => selected.has(box.boxId) && !countedLots.has(box.lotId))
    .map((box) => box.boxId);
  const totalBoxes = tickedIds.length + [...countedLots].reduce((sum, lotId) => sum + countOf(lotId), 0);

  /** Every refusal in words — a code without a key fails at RENDER (footgun 1). */
  function crateErrorText(code: string, detail?: string): string {
    switch (code) {
      case 'multiple_clients':
        return t('errors.multiple_clients');
      case 'unclaimed_not_allowed':
        return t('errors.unclaimed_not_allowed');
      case 'box_not_in_stock':
        return t('errors.box_not_in_stock');
      case 'box_already_crated':
        return t('errors.box_already_crated');
      case 'box_wrong_warehouse':
        return t('errors.box_wrong_warehouse');
      case 'validation':
        return t('errors.validation');
      case 'not_enough_boxes': {
        const [lot, n] = (detail ?? '').split(':');
        return to('crateErrors.not_enough_boxes', { lot: lot || '?', n: n || '0' });
      }
      case 'lot_twice':
        return to('crateErrors.lot_twice');
      case 'too_many_boxes':
        return to('crateErrors.too_many_boxes');
      case 'box_not_found':
        return to('crateErrors.box_not_found');
      case 'warehouse_not_found':
        return to('crateErrors.warehouse_not_found');
      case 'crating_cost_type_missing':
        return to('crateErrors.crating_cost_type_missing');
      case 'forbidden':
      case 'unauthenticated':
        return to('crateErrors.forbidden');
      default:
        return tc('error');
    }
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
        boxIds: tickedIds,
        lotCounts: [...countedLots].map((lotId) => ({ lotId, count: countOf(lotId) })),
        kind,
        logistApproved: approved as true,
        note,
        lengthCm: dims.lengthCm ? Number(dims.lengthCm) : undefined,
        widthCm: dims.widthCm ? Number(dims.widthCm) : undefined,
        heightCm: dims.heightCm ? Number(dims.heightCm) : undefined,
        weightKg: dims.weightKg ? Number(dims.weightKg) : undefined,
        // The office's reader (U28): `Number('1,200')` was NaN and the fee
        // was silently left off the crate.
        cratingCost:
          (parseTypedMoney(costAmount) ?? 0) > 0
            ? { amount: parseTypedMoney(costAmount)!, currency: costCurrency || defaultCurrency }
            : undefined,
      });
      if (res.ok) router.push(`/crates/${res.crateId}`);
      else {
        setError(res.error ?? 'error');
        setErrorDetail(res.detail);
      }
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
            {KIND_CHIPS.map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`crate-kind-${k}`}
                aria-pressed={kind === k}
                className={`px-3 py-2 ${kind === k ? 'bg-brand-600 text-white' : 'bg-surface-raised'}`}
                onClick={() => setKind(k)}
              >
                {k === 'yashik' ? t('yashik') : k === 'karkas' ? t('karkas') : to('palet')}
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
            const counted = countedLots.has(lotId);
            const allIn = !counted && lotBoxes.every((b) => selected.has(b.boxId));
            const first = lotBoxes[0]!;
            return (
              <div key={lotId} className="rounded-lg border border-line p-2">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left disabled:opacity-60"
                  disabled={counted}
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
                    {counted ? countOf(lotId) : lotBoxes.filter((b) => selected.has(b.boxId)).length}/
                    {lotBoxes.length} 📦
                  </span>
                </button>
                {/* «N ta» (0112, Q10 d): AFTER the toggle, so the lot's first
                    button stays the toggle, and a spinbutton rather than
                    another checkbox. A count takes the lot out of the ticks —
                    the service picks WHICH cartons, lowest seq first. */}
                <label className="mt-1.5 flex items-center gap-2 text-xs text-ink-500">
                  {to('lotCount')}
                  <input
                    ref={lotId === initial.lotId ? initialLotRef : undefined}
                    type="number"
                    inputMode="numeric"
                    data-testid="crate-lot-count"
                    min={0}
                    max={lotBoxes.length}
                    className="input !min-h-9 !w-20 shrink-0 text-center"
                    placeholder="0"
                    value={counts[lotId] ?? ''}
                    onChange={(e) => setCounts((prev) => ({ ...prev, [lotId]: e.target.value }))}
                  />
                  <span className="min-w-0">{to('lotCountHint')}</span>
                </label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {lotBoxes.map((box) => (
                    <button
                      key={box.boxId}
                      type="button"
                      disabled={counted}
                      className={`min-h-10 rounded-md border px-3 py-1.5 font-mono text-sm font-semibold disabled:opacity-40 ${
                        selected.has(box.boxId) && !counted
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
          {crateErrorText(error, errorDetail)}
        </p>
      )}

      <div className="pb-safe fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
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
            disabled={submitting || !approved || totalBoxes === 0}
            onClick={submit}
          >
            {submitting
              ? tc('loading')
              : kind === 'palet'
                ? `🧱 ${to('createPallet')} (${totalBoxes} 📦)`
                : `🧰 ${t('create')} (${totalBoxes} 📦)`}
          </button>
        </div>
      </div>
    </div>
  );
}
