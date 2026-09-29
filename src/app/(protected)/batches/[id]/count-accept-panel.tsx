'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import {
  countAcceptCrateAction,
  countAcceptLotAction,
  type CountAcceptActionResult,
} from '../batch-actions-server';
import type { CountAcceptRefusal, CountPanelLot } from '@/modules/wms/scanning/count-accept';

/**
 * «Sanab qabul» (0112) — the office's count at unloading, on the batch card.
 *
 * One block per lot, stacked rather than a table, so it fits a phone (the
 * logist is as often at the gate as at the desk). The number typed is the
 * lot's TOTAL that came off this truck, phone scans INCLUDED (his Q1 b); the
 * press opens ONE confirm that says, in numbers, what it will do — short,
 * exact, or beyond the truck — and, when the truck is still «on the road»,
 * whether clients will be told «yukingiz keldi». Inputs are controlled: a
 * refusal keeps what was typed (#377/#463).
 */
export function CountAcceptPanel({
  batchId,
  status,
  notifiesClients,
  mayOver,
  lots,
  crates,
}: {
  batchId: string;
  status: string;
  /** The destination tells clients on landing (customs/distribution), a hub does not. */
  notifiesClients: boolean;
  /** The ORIGIN's count door — cartons beyond the truck come off its books. */
  mayOver: boolean;
  lots: CountPanelLot[];
  crates: { crateId: string; code: string; n: number }[];
}) {
  const t = useTranslations('countAccept');
  // The anchor another screen links to (`/batches/<id>/yuklash#count-accept`): the
  // Panel is a native <details>, so the hash alone scrolls to it shut.
  useEffect(() => {
    if (window.location.hash !== '#count-accept') return;
    const el = document.getElementById('count-accept');
    if (el instanceof HTMLDetailsElement) {
      el.open = true;
      el.scrollIntoView({ block: 'start' });
    }
  }, []);

  const active = lots.filter((l) => l.awaiting > 0);
  const done = lots.filter((l) => l.awaiting === 0);
  const inTransit = status === 'in_transit';

  return (
    <div className="space-y-2" data-testid="count-accept-panel">
      <p className="text-xs text-ink-500">{t('hint')}</p>
      {active.map((lot) => (
        <LotRow
          key={lot.lotId}
          batchId={batchId}
          lot={lot}
          inTransit={inTransit}
          notifiesClients={notifiesClients}
          mayOver={mayOver}
        />
      ))}
      {done.length > 0 && (
        <details className="rounded-lg border border-line" data-testid="count-done-lots">
          <summary className="cursor-pointer p-2 text-xs font-semibold text-ink-700">
            ✅ {t('doneLots', { n: done.length })}
          </summary>
          <div className="space-y-2 border-t border-line p-2">
            {done.map((lot) => (
              <LotRow
                key={lot.lotId}
                batchId={batchId}
                lot={lot}
                inTransit={inTransit}
                notifiesClients={notifiesClients}
                mayOver={mayOver}
              />
            ))}
          </div>
        </details>
      )}
      {crates.length > 0 && (
        <div className="space-y-1.5 border-t border-line pt-2">
          <p className="section-title">{t('cratesTitle')}</p>
          {crates.map((crate) => (
            <CrateRow
              key={crate.crateId}
              batchId={batchId}
              crate={crate}
              inTransit={inTransit}
              notifiesClients={notifiesClients}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A refusal is a sentence (a literal map, #163) — and the map is fenced
 * against the service's union, so a refusal added there without a sentence
 * here turns a test red (#906).
 */
function useRefusalText() {
  const t = useTranslations('countAccept');
  return (code: CountAcceptRefusal | 'validation', detail: Record<string, number | string> = {}): string => {
    switch (code) {
      case 'forbidden':
        return t('errors.forbidden');
      case 'batch_not_found':
        return t('errors.batch_not_found');
      case 'batch_not_unloading':
        return t('errors.batch_not_unloading');
      case 'confirm_arrival_required':
        return t('errors.confirm_arrival_required');
      case 'lot_not_on_truck':
        return t('errors.lot_not_on_truck');
      case 'count_stale':
        return t('errors.count_stale', { arrived: Number(detail.arrived ?? 0) });
      case 'count_below_arrived':
        return t('errors.count_below_arrived', {
          arrived: Number(detail.arrived ?? 0),
          min: Number(detail.min ?? detail.arrived ?? 0),
        });
      case 'over_needs_reason':
        return t('errors.over_needs_reason', { max: Number(detail.max ?? 0) });
      case 'undo_needs_reason':
        return t('errors.undo_needs_reason', { arrived: Number(detail.arrived ?? 0) });
      case 'over_needs_origin_scope':
        return t('errors.over_needs_origin_scope');
      case 'grow_limit':
        return t('errors.grow_limit', { max: Number(detail.max ?? 0) });
      case 'grow_refused':
        return t('errors.grow_refused');
      case 'count_conflict':
        return t('errors.count_conflict');
      case 'busy_retry':
        return t('errors.busy_retry');
      case 'crate_not_on_batch':
        return t('errors.crate_not_on_batch');
      case 'validation':
        return t('errors.validation');
    }
  };
}

function LotRow({
  batchId,
  lot,
  inTransit,
  notifiesClients,
  mayOver,
}: {
  batchId: string;
  lot: CountPanelLot;
  inTransit: boolean;
  notifiesClients: boolean;
  mayOver: boolean;
}) {
  const t = useTranslations('countAccept');
  const format = useFormatter();
  const router = useRouter();
  const refusal = useRefusalText();
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  // One id per PRESS (decision 11), re-minted after a landing so the next
  // correction is a new press — never a replay of this one.
  const [pressId, setPressId] = useState(() => uuidv4());
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const typed = Number(target);
  const valid = target.trim() !== '' && Number.isInteger(typed) && typed >= 1;
  const onTruck = lot.arrived + lot.awaiting;
  const over = valid ? Math.max(0, typed - onTruck) : 0;
  const grow = valid ? Math.max(0, typed - onTruck - lot.spare) : 0;
  const extraArrived = Math.max(0, lot.arrived + lot.awaiting - lot.departed);
  // Below what arrived: this truck's own over-landings taken back (review
  // money-1) — the service decides how far that can go and says so.
  const undo = valid ? Math.max(0, lot.arrived - typed) : 0;
  // …which is only ever this truck's office over-landings: a lower number
  // than those can reach is refused at once, in the service's own words,
  // before a dialog promises what the press will not do (ui2-3).
  const unreachable = undo > lot.takeBack;

  async function accept() {
    setError(null);
    setResult(null);
    if (!valid) {
      setError(refusal('validation'));
      return;
    }
    if (unreachable) {
      setError(refusal('count_below_arrived', { arrived: lot.arrived, min: lot.arrived - lot.takeBack }));
      return;
    }
    if (undo > 0 && reason.trim().length < 3) {
      setError(refusal('undo_needs_reason', { arrived: lot.arrived }));
      return;
    }
    const lines: string[] = [];
    if (inTransit) lines.push(notifiesClients ? t('confirmArrivalClients') : t('confirmArrivalHub'));
    if (undo > 0) {
      lines.push(t('confirmUndo', { lot: lot.label, arrived: lot.arrived, target: typed, n: undo }));
    } else if (over > 0) {
      lines.push(t('confirmOver', { lot: lot.label, departed: lot.departed, target: typed, over }));
      if (grow > 0) lines.push(t('confirmGrow', { n: grow }));
    } else if (typed < lot.departed) {
      lines.push(t('confirmShort', { lot: lot.label, departed: lot.departed, target: typed, short: lot.departed - typed }));
    } else {
      lines.push(t('confirmExact', { lot: lot.label, target: typed }));
    }
    if (!window.confirm(lines.join('\n\n'))) return;
    setPending(true);
    try {
      const res: CountAcceptActionResult = await countAcceptLotAction({
        batchId,
        lotId: lot.lotId,
        target: typed,
        seenArrived: lot.arrived,
        pressId,
        overReason: reason,
        confirmArrival: inTransit,
      });
      if (!res.ok) {
        setError(refusal(res.error, res.detail));
        return;
      }
      setResult(
        res.result.replay
          ? t('noop', { lot: lot.label, n: res.result.arrived })
          : (res.result.undone ?? 0) > 0
            ? t('doneUndo', { lot: lot.label, n: res.result.arrived, undone: res.result.undone ?? 0 })
            : res.result.grown > 0
            ? t('doneGrown', { lot: lot.label, n: res.result.arrived, grown: res.result.grown })
            : t('done', { lot: lot.label, n: res.result.arrived }),
      );
      setTarget('');
      setReason('');
      setPressId(uuidv4());
      router.refresh();
    } catch {
      // The action never reached the server (review ui-5): a silent button is
      // read as «done». The typed number stays for the retry.
      setError(t('offline'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-line p-2" data-testid={`count-lot-${lot.lotId}`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-mono font-extrabold text-brand-700">{lot.label}</span>
        {lot.sub && <span className="text-2xs text-ink-500">{lot.sub}</span>}
        <span className="min-w-0 flex-1 truncate text-sm text-ink-700">
          {lot.product}
          {lot.productRu && <span className="text-ink-500"> ({lot.productRu})</span>}
        </span>
        {lot.mode === 'counted' && <span className="chip-brand">{t('modeCounted')}</span>}
        {lot.mode === 'qrless' && <span className="chip-warn">{t('modeQrless')}</span>}
      </div>
      <p className="flex flex-wrap gap-x-2 text-xs text-ink-700" data-testid={`count-numbers-${lot.lotId}`}>
        <span>{t('departed', { n: lot.departed })}</span>
        <span>
          · {t('arrived', { n: lot.arrived })}
          {lot.phoneScanned > 0 && <span className="text-ink-500"> ({t('phone', { n: lot.phoneScanned })})</span>}
        </span>
        <span className={lot.awaiting > 0 ? 'font-semibold' : ''}>· {t('waiting', { n: lot.awaiting })}</span>
        {extraArrived > 0 && (
          <span className="font-semibold text-orange-700">· {t('over', { n: extraArrived })}</span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {/* The width sits on the wrapper, never on `.input` (#419). Neither
            gives way: inside the «done» fold at 360 px the press was squeezed
            to 60 px and its word cut, and a squeezed box cannot hold «1200» —
            so the press WRAPS onto its own full-width line when the row is
            short (a done lot is where a press below «arrived» is made). */}
        <div className="w-24 shrink-0">
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            aria-label={t('target')}
            placeholder={String(lot.departed)}
            data-testid={`count-target-${lot.lotId}`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn-secondary shrink-0 px-2"
          data-testid={`count-fill-${lot.lotId}`}
          onClick={() => setTarget(String(Math.max(lot.departed, lot.arrived)))}
        >
          {t('fillAll', { n: Math.max(lot.departed, lot.arrived) })}
        </button>
        <button
          type="button"
          className="btn-primary shrink-0 grow px-3 disabled:opacity-50"
          data-testid={`count-accept-${lot.lotId}`}
          disabled={pending}
          onClick={accept}
        >
          {t('accept')}
        </button>
      </div>
      {(over > 0 || (undo > 0 && !unreachable)) && (
        <div className="space-y-1">
          <input
            className="input"
            placeholder={undo > 0 ? t('undoReason') : t('overReason')}
            data-testid={`count-reason-${lot.lotId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {grow > 0 && <p className="text-xs font-semibold text-warn">{t('growHint', { n: grow })}</p>}
          {undo > 0 && !unreachable && (
            <p className="text-xs font-semibold text-warn">{t('undoHint', { n: undo })}</p>
          )}
          {!mayOver && <p className="text-xs text-bad">{t('overNoScope')}</p>}
        </div>
      )}
      {unreachable && (
        <p className="text-xs font-semibold text-bad" data-testid={`count-unreachable-${lot.lotId}`}>
          {refusal('count_below_arrived', { arrived: lot.arrived, min: lot.arrived - lot.takeBack })}
        </p>
      )}
      {lot.last && (
        <p className="text-2xs text-ink-500" data-testid={`count-last-${lot.lotId}`}>
          {t('lastBy', {
            name: lot.last.name,
            // A raw `db.execute` timestamp arrives as TEXT (#923).
            when: format.dateTime(new Date(lot.last.at), { dateStyle: 'short', timeStyle: 'short' }),
          })}
        </p>
      )}
      {result && (
        <p className="rounded bg-good/10 p-1.5 text-sm font-semibold text-good" data-testid={`count-result-${lot.lotId}`}>
          {result}
        </p>
      )}
      {error && (
        <p className="rounded bg-bad/10 p-1.5 text-sm font-semibold text-bad" data-testid={`count-error-${lot.lotId}`}>
          {error}
        </p>
      )}
    </div>
  );
}

function CrateRow({
  batchId,
  crate,
  inTransit,
  notifiesClients,
}: {
  batchId: string;
  crate: { crateId: string; code: string; n: number };
  inTransit: boolean;
  notifiesClients: boolean;
}) {
  const t = useTranslations('countAccept');
  const router = useRouter();
  const refusal = useRefusalText();
  const [pressId] = useState(() => uuidv4());
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function accept() {
    const lines = [t('crateConfirm', { code: crate.code, n: crate.n })];
    if (inTransit) lines.unshift(notifiesClients ? t('confirmArrivalClients') : t('confirmArrivalHub'));
    if (!window.confirm(lines.join('\n\n'))) return;
    setPending(true);
    try {
      const res = await countAcceptCrateAction({ batchId, crateId: crate.crateId, pressId, confirmArrival: inTransit });
      if (!res.ok) {
        setNote({ ok: false, text: refusal(res.error) });
        return;
      }
      setNote({
        ok: true,
        text:
          t('crateDone', { code: crate.code, n: res.landed }) +
          (res.notArrived.length ? ` · ${t('crateNotArrived', { codes: res.notArrived.join(', ') })}` : ''),
      });
      router.refresh();
    } catch {
      setNote({ ok: false, text: t('offline') });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1" data-testid={`count-crate-${crate.code}`}>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono font-bold">{crate.code}</span>
        <span className="min-w-0 flex-1 truncate text-ink-500">{t('crateBoxes', { n: crate.n })}</span>
        <button
          type="button"
          className="btn-secondary shrink-0 px-2 disabled:opacity-50"
          data-testid={`count-crate-accept-${crate.code}`}
          disabled={pending}
          onClick={accept}
        >
          {t('crateAccept')}
        </button>
      </div>
      {note && (
        <p className={`text-xs font-semibold ${note.ok ? 'text-good' : 'text-bad'}`}>{note.text}</p>
      )}
    </div>
  );
}
