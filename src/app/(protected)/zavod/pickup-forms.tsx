'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import {
  addStopAction,
  cancelPickupAction,
  collectStopAction,
  createPickupAction,
  linkReceiptAction,
  markArrivedAction,
  removeStopAction,
  saveStopLinesAction,
  type PickupActionResult,
} from './actions';

/**
 * Every refusal the pickup doors can name. A literal list because a missing
 * i18n key throws at RENDER time (#163): a code nobody translated reads as
 * the generic sentence, never as a crashed screen.
 */
const KNOWN_ERRORS = [
  'forbidden',
  'validation',
  'bad_number',
  'cancelled',
  'already_collected',
  'stop_collected',
  'stop_linked',
  'last_stop',
  'too_many_stops',
  'dest_locked',
  'pickup_has_costs',
  'pickup_has_receipts',
  'reason_required',
  'wrong_warehouse',
  'receipt_not_live',
  'factory_not_found',
  'client_not_found',
  'warehouse_not_found',
  'bad_point',
  'no_point',
] as const;

export function useErrorText() {
  const t = useTranslations('pickups.errors');
  return (code: string | undefined) =>
    (KNOWN_ERRORS as readonly string[]).includes(code ?? '') ? t(code as (typeof KNOWN_ERRORS)[number]) : t('generic');
}

export interface LineDraft {
  owner: string;
  goods: string;
  factoryBoxes: string;
  volumeM3: string;
  weightKg: string;
}

export const emptyLine = (): LineDraft => ({ owner: '', goods: '', factoryBoxes: '', volumeM3: '', weightKg: '' });

/** A draft the service can read, or the first problem with it (the row, in words). */
function toLines(drafts: LineDraft[]) {
  const lines = [];
  for (const [i, d] of drafts.entries()) {
    if (!d.owner.trim() && !d.goods.trim() && !d.factoryBoxes.trim()) continue;
    const boxes = parseTypedMoney(d.factoryBoxes);
    const m3 = d.volumeM3.trim() ? parseTypedMoney(d.volumeM3) : null;
    const kg = d.weightKg.trim() ? parseTypedMoney(d.weightKg) : null;
    if (
      !d.owner.trim() ||
      !d.goods.trim() ||
      boxes === null ||
      !Number.isInteger(boxes) ||
      boxes <= 0 ||
      (d.volumeM3.trim() && (m3 === null || m3 <= 0)) ||
      (d.weightKg.trim() && (kg === null || kg <= 0))
    ) {
      return { error: i + 1 };
    }
    lines.push({ owner: d.owner.trim(), goods: d.goods.trim(), factoryBoxes: boxes, volumeM3: m3, weightKg: kg });
  }
  return { lines };
}

export function LinesEditor({ value, onChange }: { value: LineDraft[]; onChange: (next: LineDraft[]) => void }) {
  const t = useTranslations('pickups');
  const set = (i: number, patch: Partial<LineDraft>) =>
    onChange(value.map((line, j) => (j === i ? { ...line, ...patch } : line)));
  return (
    <div className="space-y-2">
      {value.map((line, i) => (
        <div key={i} data-testid="pickup-line" className="grid grid-cols-2 gap-1.5 rounded-lg bg-surface-sunken p-2 sm:grid-cols-6">
          <input
            data-testid="line-owner"
            aria-label={t('owner')}
            className="input-cell col-span-1 font-mono"
            placeholder={t('ownerPlaceholder')}
            value={line.owner}
            onChange={(e) => set(i, { owner: e.target.value })}
          />
          <input
            data-testid="line-goods"
            aria-label={t('goods')}
            className="input-cell col-span-1 sm:col-span-2"
            placeholder={t('goods')}
            value={line.goods}
            onChange={(e) => set(i, { goods: e.target.value })}
          />
          <input
            data-testid="line-boxes"
            aria-label={t('factoryBoxes')}
            className="input-cell text-center"
            inputMode="numeric"
            placeholder="📦"
            value={line.factoryBoxes}
            onChange={(e) => set(i, { factoryBoxes: e.target.value })}
          />
          <input
            data-testid="line-m3"
            aria-label="m³"
            className="input-cell text-center"
            inputMode="decimal"
            placeholder="m³"
            value={line.volumeM3}
            onChange={(e) => set(i, { volumeM3: e.target.value })}
          />
          <div className="flex gap-1">
            <input
              data-testid="line-kg"
              aria-label="kg"
              className="input-cell min-w-0 flex-1 text-center"
              inputMode="decimal"
              placeholder="kg"
              value={line.weightKg}
              onChange={(e) => set(i, { weightKg: e.target.value })}
            />
            <button
              type="button"
              className="shrink-0 px-1 text-ink-500"
              aria-label={t('removeLine')}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="btn-ghost text-sm" onClick={() => onChange([...value, emptyLine()])}>
        + {t('addLine')}
      </button>
    </div>
  );
}

interface Option {
  id: string;
  label: string;
}

export function CreatePickupForm({ warehouses, factories }: { warehouses: Option[]; factories: Option[] }) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [dest, setDest] = useState(warehouses[0]?.id ?? '');
  const [plate, setPlate] = useState('');
  const [driver, setDriver] = useState('');
  const [phone, setPhone] = useState('');
  const [plannedOn, setPlannedOn] = useState('');
  const [note, setNote] = useState('');
  const [stops, setStops] = useState<{ factoryId: string; lines: LineDraft[] }[]>([
    { factoryId: factories[0]?.id ?? '', lines: [emptyLine()] },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const parsed = [];
    for (const [i, stop] of stops.entries()) {
      const res = toLines(stop.lines);
      if ('error' in res) {
        setError(t('lineProblem', { stop: i + 1, line: res.error! }));
        return;
      }
      if (!stop.factoryId) {
        setError(t('factoryRequired'));
        return;
      }
      parsed.push({ factoryId: stop.factoryId, lines: res.lines });
    }
    setBusy(true);
    try {
      const res: PickupActionResult = await createPickupAction({
        destWarehouseId: dest,
        vehiclePlate: plate,
        driverName: driver,
        driverPhone: phone,
        plannedOn,
        note,
        stops: parsed,
      });
      if (res.ok && res.id) router.push(`/zavod/${res.id}`);
      else setError(errorText(res.error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="label">{t('destination')}</span>
          <select data-testid="pickup-dest" className="input" value={dest} onChange={(e) => setDest(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="label">{t('plannedOn')}</span>
          <input type="date" className="input" value={plannedOn} onChange={(e) => setPlannedOn(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="label">{t('plate')}</span>
          <input data-testid="pickup-plate" className="input" value={plate} onChange={(e) => setPlate(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="label">{t('driver')}</span>
          <input className="input" value={driver} onChange={(e) => setDriver(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="label">{t('driverPhone')}</span>
          <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="label">{t('note')}</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {stops.map((stop, i) => (
        <div key={i} className="card space-y-2" data-testid="pickup-stop-form">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{i + 1}.</span>
            <select
              data-testid="stop-factory"
              aria-label={t('factory')}
              className="input min-w-0 flex-1"
              value={stop.factoryId}
              onChange={(e) => setStops(stops.map((s, j) => (j === i ? { ...s, factoryId: e.target.value } : s)))}
            >
              {factories.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            {stops.length > 1 && (
              <button
                type="button"
                className="shrink-0 px-2 text-ink-500"
                aria-label={t('removeStop')}
                onClick={() => setStops(stops.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
          <LinesEditor
            value={stop.lines}
            onChange={(lines) => setStops(stops.map((s, j) => (j === i ? { ...s, lines } : s)))}
          />
        </div>
      ))}
      {stops.length < 6 && (
        <button
          type="button"
          className="btn-secondary w-full"
          onClick={() => setStops([...stops, { factoryId: factories[0]?.id ?? '', lines: [emptyLine()] }])}
        >
          + {t('addStop')}
        </button>
      )}
      {error && <p className="text-sm text-bad" data-testid="pickup-error">⚠ {error}</p>}
      <button type="button" data-testid="pickup-create" className="btn-primary w-full" disabled={busy} onClick={submit}>
        {t('create')}
      </button>
    </div>
  );
}

export function StopLinesForm({ stopId, initial }: { stopId: string; initial: LineDraft[] }) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [lines, setLines] = useState(initial.length ? initial : [emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    const res = toLines(lines);
    if ('error' in res) {
      setMsg(t('lineProblem', { stop: '', line: res.error! }));
      return;
    }
    setBusy(true);
    try {
      const out = await saveStopLinesAction(stopId, res.lines);
      setMsg(out.ok ? `✅ ${t('saved')}` : `⚠ ${errorText(out.error)}`);
      if (out.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-brand-700">✏️ {t('editLines')}</summary>
      <div className="mt-2 space-y-2">
        <LinesEditor value={lines} onChange={setLines} />
        <button type="button" className="btn-secondary" disabled={busy} onClick={save}>
          {t('save')}
        </button>
        {msg && <p className="text-xs">{msg}</p>}
      </div>
    </details>
  );
}

/**
 * «Olindi» — the truck left this factory with the cargo. The driver's recount
 * is optional per line (B2: the factory's count is exact, the driver
 * recounts and a difference is worth writing down).
 */
export function CollectForm({
  stopId,
  lines,
}: {
  stopId: string;
  lines: { id: string; label: string; factoryBoxes: number }[];
}) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [stamp, setStamp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    const driverBoxes: Record<string, number> = {};
    for (const line of lines) {
      const raw = counts[line.id]?.trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        setError(errorText('bad_number'));
        return;
      }
      driverBoxes[line.id] = n;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await collectStopAction({ stopId, driverBoxes, stampNote: stamp });
      if (res.ok) router.refresh();
      else setError(errorText(res.error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-line p-2 text-sm" data-testid="collect-form">
      {lines.map((line) => (
        <label key={line.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {line.label} · {t('factoryShort')}: {line.factoryBoxes}
          </span>
          <input
            data-testid="collect-driver-count"
            aria-label={t('driverBoxes')}
            className="input-cell !w-20 shrink-0 text-center"
            inputMode="numeric"
            placeholder={t('driverShort')}
            value={counts[line.id] ?? ''}
            onChange={(e) => setCounts({ ...counts, [line.id]: e.target.value.replace(/\D/g, '') })}
          />
        </label>
      ))}
      <input
        className="input"
        aria-label={t('stampNote')}
        placeholder={t('stampNote')}
        value={stamp}
        onChange={(e) => setStamp(e.target.value)}
      />
      {error && <p className="text-bad">⚠ {error}</p>}
      <button type="button" data-testid="collect-submit" className="btn-primary w-full" disabled={busy} onClick={submit}>
        ✓ {t('collect')}
      </button>
    </div>
  );
}

export function PickupButtons({
  pickupId,
  canArrive,
  canCancel,
}: {
  pickupId: string;
  canArrive: boolean;
  canCancel: boolean;
}) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function act(fn: () => Promise<PickupActionResult>) {
    setError(null);
    const res = await fn();
    if (res.ok) router.refresh();
    else setError(errorText(res.error));
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canArrive && (
        <button type="button" data-testid="pickup-arrived" className="btn-secondary" onClick={() => act(() => markArrivedAction(pickupId))}>
          {t('markArrived')}
        </button>
      )}
      {canCancel && (
        <button
          type="button"
          data-testid="pickup-cancel"
          className="btn-ghost text-bad"
          onClick={() => {
            const reason = window.prompt(t('cancelReason'));
            if (reason?.trim()) void act(() => cancelPickupAction(pickupId, reason));
          }}
        >
          {t('cancel')}
        </button>
      )}
      {error && <p className="w-full text-sm text-bad" data-testid="pickup-action-error">⚠ {error}</p>}
    </div>
  );
}

export function AddStopForm({ pickupId, factories }: { pickupId: string; factories: Option[] }) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [factoryId, setFactoryId] = useState(factories[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <select aria-label={t('factory')} className="input min-w-0 flex-1" value={factoryId} onChange={(e) => setFactoryId(e.target.value)}>
        {factories.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-secondary shrink-0"
        onClick={async () => {
          const res = await addStopAction(pickupId, factoryId);
          if (res.ok) router.refresh();
          else setError(errorText(res.error));
        }}
      >
        + {t('addStop')}
      </button>
      {error && <p className="w-full text-bad">⚠ {error}</p>}
    </div>
  );
}

export function RemoveStopButton({ stopId }: { stopId: string }) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn-ghost text-xs text-ink-500"
      onClick={async () => {
        if (!window.confirm(t('removeStopConfirm'))) return;
        const res = await removeStopAction(stopId);
        if (res.ok) router.refresh();
        else window.alert(errorText(res.error));
      }}
    >
      🗑 {t('removeStop')}
    </button>
  );
}

/** Attach one candidate prixod to one of the stops that could have brought it. */
export function LinkReceiptButtons({
  receiptId,
  stops,
}: {
  receiptId: string;
  stops: { id: string; seq: number; factoryName: string }[];
}) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {stops.map((stop) => (
        <button
          key={stop.id}
          type="button"
          data-testid="candidate-link"
          className="btn-secondary !min-h-8 !px-2 !py-0.5 text-xs"
          onClick={async () => {
            const res = await linkReceiptAction(receiptId, stop.id);
            if (res.ok) router.refresh();
            else setError(errorText(res.error));
          }}
        >
          {t('linkTo', { seq: stop.seq })}
        </button>
      ))}
      {error && <span className="text-xs text-bad">⚠ {error}</span>}
    </span>
  );
}

/** The receipt card's «Zavod reysi» control: attach to a stop, or detach. */
export function ReceiptPickupControl({
  receiptId,
  currentStopId,
  options,
}: {
  receiptId: string;
  currentStopId: string | null;
  options: { stopId: string; label: string }[];
}) {
  const t = useTranslations('pickups');
  const errorText = useErrorText();
  const router = useRouter();
  const [value, setValue] = useState(currentStopId ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="receipt-pickup-control">
      <select
        data-testid="receipt-pickup-select"
        aria-label={t('title')}
        className="input min-w-0 flex-1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      >
        <option value="">{t('noPickup')}</option>
        {options.map((o) => (
          <option key={o.stopId} value={o.stopId}>
            {o.label}
          </option>
        ))}
      </select>
      {value !== (currentStopId ?? '') && (
        <button
          type="button"
          data-testid="receipt-pickup-save"
          className="btn-secondary shrink-0"
          onClick={async () => {
            const res = await linkReceiptAction(receiptId, value || null);
            setMsg(res.ok ? null : errorText(res.error));
            if (res.ok) router.refresh();
          }}
        >
          {t('save')}
        </button>
      )}
      {msg && <p className="w-full text-bad">⚠ {msg}</p>}
    </div>
  );
}
