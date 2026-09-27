'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import {
  countLoadCrateAction,
  countLoadLotAction,
  type CountActionError,
} from '../count-load-actions';
import type {
  CountableLot,
  CountErrorDetail,
  CountPanelCrate,
  CountPanelMode,
  CountPanelRow,
} from '@/modules/wms/scanning/count-load';

/**
 * «🔢 Sanab yuklash» on the batch card (0112, the owner's Q1-Q7) — the one
 * place the office tells the system how many cartons of a stickerless lot
 * went onto the truck. Online only: an office count never queues.
 *
 * The box asks for the lot's TOTAL on the truck, phone-scanned cartons
 * included (his Q1 = b), starts EMPTY with the current number as its
 * placeholder, and posts what the screen showed as `seenAboard` — a number
 * typed over a stale screen is refused with the truth instead of undoing a
 * colleague's correction. A refusal keeps everything typed (#377/#419).
 */

/** Stage colour for the lot's mode — literal classes, Tailwind cannot see built ones. */
const MODE_CLASS: Record<CountPanelMode, string> = {
  counted: 'bg-brand-50 text-brand-700',
  qrless: 'bg-warn/10 text-warn',
  scanning: 'bg-surface-sunken text-ink-700',
  none: 'bg-surface-sunken text-ink-500',
};

type Detail = CountErrorDetail;

/** The planner's own arithmetic, for the warning the box shows BEFORE a press. */
function deviation(row: CountPanelRow, quick: boolean, target: number) {
  const need = target - row.aboard;
  if (need <= 0) return { over: 0, grow: 0 };
  if (quick) {
    const fromShelf = Math.min(need, row.spare);
    return { over: 0, grow: need - fromShelf };
  }
  const load = Math.min(need, row.reserved);
  const room = Math.max(0, (row.plan ?? 0) - (row.aboard - row.over) - load);
  const again = Math.min(need - load, room, row.spare);
  const rest = need - load - again;
  const fromShelf = Math.min(rest, row.spare - again);
  const grow = rest - fromShelf;
  return { over: fromShelf + grow, grow };
}

export function CountLoadPanel({
  batchId,
  quick,
  rows,
  crates,
  defaultOpen,
}: {
  batchId: string;
  quick: boolean;
  rows: CountPanelRow[];
  crates: CountPanelCrate[];
  defaultOpen: boolean;
}) {
  const t = useTranslations('countLoad');
  const ref = useRef<HTMLDetailsElement>(null);
  const [extra, setExtra] = useState<CountPanelRow[]>([]);

  // «Sanab yuklash» linked from the loading screen lands OPEN on the panel
  // (the kernel's `#count-load` anchor). The DOM is set directly: React owns
  // only the initial attribute, so a refresh never snaps a panel shut.
  useEffect(() => {
    const land = () => {
      if (location.hash === '#count-load' && ref.current) {
        ref.current.open = true;
        ref.current.scrollIntoView({ block: 'start' });
      }
    };
    land();
    window.addEventListener('hashchange', land);
    return () => window.removeEventListener('hashchange', land);
  }, []);

  const known = new Set(rows.map((r) => r.lotId));
  const all = [...rows, ...extra.filter((r) => !known.has(r.lotId))];
  const aboard = rows.reduce((sum, r) => sum + r.aboard, 0);

  return (
    <details id="count-load" ref={ref} className="card !p-0 scroll-mt-20" open={defaultOpen}>
      <summary
        data-testid="count-load-open"
        className="cursor-pointer p-3 text-sm font-bold text-ink-700 marker:text-ink-400"
      >
        {t('title')}
        <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-700">
          {t('badge', { lots: rows.length, boxes: aboard })}
        </span>
      </summary>
      <div className="space-y-3 border-t border-line p-3">
        <p className="text-xs text-ink-500">{t('hint')}</p>
        {all.map((row) => (
          <CountRow key={row.lotId} batchId={batchId} quick={quick} row={row} />
        ))}
        {crates.map((crate) => (
          <CrateRow key={crate.crateId} batchId={batchId} crate={crate} />
        ))}
        <LotPicker
          batchId={batchId}
          taken={new Set(all.map((r) => r.lotId))}
          onPick={(lot) =>
            setExtra((prev) => [
              ...prev,
              {
                lotId: lot.lotId,
                label: lot.label,
                sub: lot.sub,
                product: lot.product,
                plan: quick ? null : 0,
                aboard: 0,
                phoneScanned: 0,
                over: 0,
                reserved: 0,
                spare: lot.spare,
                mode: lot.qrless ? 'qrless' : 'none',
                lastCount: null,
              },
            ])
          }
        />
      </div>
    </details>
  );
}

function CountRow({ batchId, quick, row }: { batchId: string; quick: boolean; row: CountPanelRow }) {
  const t = useTranslations('countLoad');
  const format = useFormatter();
  const router = useRouter();
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A refusal is a sentence (a literal map, #163), never the service's code.
  function errorText(code: CountActionError, d: Detail): string {
    switch (code) {
      case 'forbidden':
        return t('errors.forbidden');
      case 'batch_not_found':
      case 'lot_not_found':
      case 'crate_not_found':
        return t('errors.not_found');
      case 'batch_not_loading':
        return t('errors.batch_not_loading');
      case 'lot_not_here':
        return t('errors.lot_not_here');
      case 'count_stale':
        return t('errors.count_stale', { current: d.current ?? 0 });
      case 'over_reason_required':
        return d.plan === null || d.plan === undefined
          ? t('errors.grow_reason', { stock: d.stock ?? 0 })
          : t('errors.over_reason_required', { plan: d.plan });
      case 'grow_too_many':
        return t('errors.grow_too_many', { max: d.max ?? 0 });
      case 'grow_refused':
        return t('errors.grow_refused');
      case 'count_conflict':
      case 'busy_retry':
        return t('errors.busy');
      case 'bad_target':
        return t('errors.bad_target');
      case 'crate_not_on_plan':
        return t('errors.crate_not_on_plan');
      case 'crate_not_here':
        return t('errors.crate_not_here');
      default:
        return t('errors.failed');
    }
  }

  const typed = value.trim() === '' ? null : Number(value);
  const valid = typed !== null && Number.isInteger(typed) && typed >= 0 && typed <= 10000;
  const dev = valid ? deviation(row, quick, typed) : { over: 0, grow: 0 };
  const stock = row.aboard + row.reserved + row.spare;
  const allN = !quick && (row.plan ?? 0) > 0 ? row.plan! : stock;
  const of = quick ? stock : (row.plan ?? 0);

  async function save() {
    if (!valid) {
      setError(t('errors.bad_target'));
      return;
    }
    const target = typed;
    if (
      target < row.aboard &&
      !window.confirm(
        t('reduceConfirm', { lot: row.label, from: row.aboard, to: target, n: row.aboard - target }),
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await countLoadLotAction({
        batchId,
        lotId: row.lotId,
        target,
        seenAboard: row.aboard,
        pressId: uuidv4(),
        overReason: reason,
      });
      if (res.ok) {
        setDone(
          res.unchanged
            ? t('unchanged', { n: res.aboard })
            : res.grown > 0
              ? t('doneGrown', { n: res.aboard, g: res.grown })
              : (res.shrunk ?? 0) > 0
                ? t('doneShrunk', { n: res.aboard, s: res.shrunk ?? 0 })
                : t('done', { n: res.aboard }),
        );
        setValue('');
        setReason('');
        router.refresh();
      } else {
        setError(errorText(res.error, res));
      }
    } catch {
      // The action never reached the server — no queue behind this box.
      setError(t('offline'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="count-load-row"
      data-lot-id={row.lotId}
      data-mode={row.mode}
      className="space-y-1.5 border-b border-line pb-3 last:border-0 last:pb-0"
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono font-extrabold text-brand-700">
          {row.label}
          {row.sub && <span className="block font-sans text-2xs font-normal text-ink-500">{row.sub}</span>}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-700">{row.product}</span>
        <span className="font-semibold tabular-nums" data-testid="count-load-aboard">
          {row.aboard}/{of}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {row.mode !== 'none' && (
          <span className={`rounded px-1.5 py-0.5 font-semibold ${MODE_CLASS[row.mode]}`}>
            {row.mode === 'counted'
              ? t('modeCounted')
              : row.mode === 'qrless'
                ? t('modeQrless')
                : t('modeScanning')}
          </span>
        )}
        {row.phoneScanned > 0 && (
          <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-ink-700" data-testid="count-load-phone">
            📷 {t('phoneScanned', { n: row.phoneScanned })}
          </span>
        )}
        {row.over > 0 && (
          <span className="rounded bg-warn/10 px-1.5 py-0.5 font-semibold text-warn">
            {t('overBadge', { n: row.over })}
          </span>
        )}
      </div>
      {row.lastCount && (
        <p className="text-xs text-ink-500">
          {t('lastCount', {
            name: row.lastCount.name ?? '—',
            when: format.dateTime(new Date(row.lastCount.at), { dateStyle: 'short', timeStyle: 'short' }),
          })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid="count-load-input"
          className="input !w-20 font-mono"
          type="number"
          inputMode="numeric"
          min={0}
          max={10000}
          placeholder={String(row.aboard)}
          aria-label={t('targetLabel')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          data-testid="count-load-all"
          className="btn-secondary whitespace-nowrap px-3"
          disabled={busy}
          onClick={() => setValue(String(allN))}
        >
          {t('all', { n: allN })}
        </button>
        <button
          type="button"
          data-testid="count-load-save"
          className="btn-primary whitespace-nowrap px-3 disabled:opacity-50"
          disabled={busy || value.trim() === ''}
          onClick={() => void save()}
        >
          {t('save')}
        </button>
      </div>
      {(dev.over > 0 || dev.grow > 0) && (
        <div className="space-y-1.5">
          {/* The truck's number over the plan AFTER the press — what is already
              marked plus what this press marks (grown cartons carry the mark
              too). Only the new cartons' share was printed before, so «9 of a
              plan of 4» read «1 over». */}
          {dev.over > 0 && (
            <p className="text-xs font-semibold text-warn" data-testid="count-load-over">
              {(row.plan ?? 0) > 0 ? t('overWarn', { n: row.over + dev.over }) : t('offPlanWarn')}
            </p>
          )}
          {dev.grow > 0 && (
            <p className="text-xs font-semibold text-warn" data-testid="count-load-grow">
              {t('growWarn', { stock, n: dev.grow })}
            </p>
          )}
          <input
            data-testid="count-load-reason"
            className="input"
            placeholder={t('overReason')}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}
      {done && (
        <p data-testid="count-load-result" className="text-sm font-semibold text-good">
          {done}
        </p>
      )}
      {error && (
        <p data-testid="count-load-error" className="text-sm font-semibold text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

/** «Yuklash (1 joy)» — a crate goes on as one place, never counted loose. */
function CrateRow({ batchId, crate }: { batchId: string; crate: CountPanelCrate }) {
  const t = useTranslations('countLoad');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    setBusy(true);
    setNote(null);
    try {
      const res = await countLoadCrateAction({ batchId, crateId: crate.crateId, pressId: uuidv4() });
      if (res.ok) {
        setNote({ ok: true, text: t('crateDone', { code: res.code }) });
        router.refresh();
      } else {
        setNote({
          ok: false,
          text:
            res.error === 'crate_not_on_plan'
              ? t('errors.crate_not_on_plan')
              : res.error === 'crate_not_here'
                ? t('errors.crate_not_here')
                : res.error === 'forbidden'
                  ? t('errors.forbidden')
                  : res.error === 'count_conflict' || res.error === 'busy_retry'
                    ? t('errors.busy')
                    : t('errors.failed'),
        });
      }
    } catch {
      setNote({ ok: false, text: t('offline') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="count-load-crate" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 font-mono font-bold">
        {t('crateRow', { code: crate.code, aboard: crate.aboard, n: crate.boxes })}
      </span>
      {crate.aboard < crate.boxes && (
        <button
          type="button"
          data-testid="count-load-crate-load"
          className="btn-secondary whitespace-nowrap px-3 disabled:opacity-50"
          disabled={busy}
          onClick={() => void load()}
        >
          {t('crateLoad')}
        </button>
      )}
      {note && (
        <p className={`w-full text-xs font-semibold ${note.ok ? 'text-good' : 'text-bad'}`}>{note.text}</p>
      )}
    </div>
  );
}

/** Lots on the origin's shelf that can still go on — fetched when opened (#758: a cut list says so). */
function LotPicker({
  batchId,
  taken,
  onPick,
}: {
  batchId: string;
  taken: Set<string>;
  onPick: (lot: CountableLot) => void;
}) {
  const t = useTranslations('countLoad');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<{ lots: CountableLot[]; total: number; shown: number } | null>(null);
  const [failed, setFailed] = useState(false);
  /** The newest request wins: a slow answer to an old search must not replace a newer one. */
  const asked = useRef(0);

  useEffect(() => {
    if (!open) return;
    const ticket = ++asked.current;
    const timer = setTimeout(() => {
      fetch(`/api/batches/${batchId}/count-lots${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((data: { lots: CountableLot[]; total: number; shown: number }) => {
          if (ticket === asked.current) {
            setAnswer(data);
            setFailed(false);
          }
        })
        .catch(() => {
          if (ticket === asked.current) setFailed(true);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [open, q, batchId]);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="count-load-pick-open"
        className="btn-secondary w-full"
        onClick={() => setOpen(true)}
      >
        {t('pickOpen')}
      </button>
    );
  }
  const lots = (answer?.lots ?? []).filter((lot) => !taken.has(lot.lotId));
  return (
    <div className="space-y-2 rounded-lg border border-line p-2">
      <input
        data-testid="count-load-pick-search"
        className="input"
        placeholder={t('pickSearch')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      {failed && <p className="text-xs font-semibold text-bad">{t('offline')}</p>}
      {answer && lots.length === 0 && <p className="text-sm text-ink-500">{t('pickEmpty')}</p>}
      {answer && answer.total > answer.shown && (
        <p className="text-xs text-ink-500">{t('pickCapped', { shown: answer.shown, total: answer.total })}</p>
      )}
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {lots.map((lot) => (
          <button
            key={lot.lotId}
            type="button"
            data-testid="count-load-pick-row"
            data-lot-id={lot.lotId}
            className="flex w-full items-center gap-2 rounded-lg border border-line p-2 text-left text-sm hover:bg-surface-sunken"
            onClick={() => onPick(lot)}
          >
            <span className="font-mono font-extrabold text-brand-700">{lot.label}</span>
            <span className="min-w-0 flex-1 truncate text-ink-700">{lot.product}</span>
            {lot.qrless && <span className="whitespace-nowrap text-xs text-warn">{t('pickQrless')}</span>}
            <span className="whitespace-nowrap text-xs text-ink-500">{t('pickSpare', { n: lot.spare })}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
