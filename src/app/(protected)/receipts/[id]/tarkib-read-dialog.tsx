'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Overlay } from '@/components/ui/overlay';
import {
  fromUnits,
  KG_SCALE,
  M3_SCALE,
  MAX_LINES,
  type DraftLine,
  type LotTotals,
} from '@/modules/wms/receipts/composition-math';
import {
  appliedName,
  applyProposal,
  cartonsMixed,
  hasTypedLines,
  lotUnits,
  tickedSums,
  tickedToBegin,
  type ApplyRefusal,
  type ProposalLot,
  type ProposalNote,
  type ProposalWarning,
  type TarkibProposal,
} from '@/modules/wms/receipts/tarkib-proposal';

/**
 * «🤖 Fayldan to'ldirish» in the tarkib editor (docs/TARKIB-TAKLIFLAR.md §3;
 * the owner, 2026-11-11: «Tarkibni mijozning packing-list fayli yoki rasmidan
 * AI o'qib to'ldirsin — 10–20 qatorni qo'lda yozmaslik uchun»).
 *
 * The model read the chosen document; this dialog shows what it found and the
 * person TICKS the rows that are this lot's. «Qo'llash» puts the ticked rows
 * into the editor's DRAFT and nothing else happens: the editor's own
 * «Saqlash», with its own parse and its own sums, is still the only writer.
 *
 * Nothing here corrects the paper. The Σ of the ticked rows stands BESIDE the
 * lot's own figures, coloured when they differ — the warehouse weighed the
 * lot, the client typed the paper, and which of the two is right is the
 * person's call (the editor's «Sklad o'lchoviga moslashtirish» is one press
 * away, and a person presses it).
 *
 * A reading takes up to a minute and one of the day's fifty, so it is never
 * lost to a stray tap: a backdrop tap and Escape do NOT close the dialog
 * (only «Yopish» does), and the proposal is kept in the browser by its
 * document, so the button shows it again instead of paying for it again.
 */

/** Today's count as the route answers it (`calc/ai-press.ts PressToday`). */
export interface ReadToday {
  used: number;
  limit: number;
  usd: number | null;
  usd30: number | null;
  unpriced: number | null;
}

/** One reading, as the browser keeps it. */
export interface StoredRead {
  attachmentId: string;
  fileName: string;
  /** When it was read — the cache's clock, and the dialog body's key. */
  at: number;
  proposal: TarkibProposal;
  today: ReadToday | null;
}

export type ReadAnswer =
  | { ok: true; proposal: TarkibProposal; today?: ReadToday }
  | { ok: false; error: string; detail?: string; today?: ReadToday };

/**
 * The proposal is LOT-INDEPENDENT, so it is kept by the DOCUMENT: a packing
 * list covers the shipment, and the second lot of a prixod ticks its own
 * rows from the reading the first one paid for. sessionStorage — this tab,
 * this sitting — and thirty minutes: long enough to work through a prixod,
 * short enough that a stale reading is not mistaken for a fresh one. The
 * version tag is for the release that changes the shape.
 */
const CACHE_VERSION = 1;
const CACHE_MS = 30 * 60_000;
const cacheKey = (attachmentId: string) => `tarkib-read:${attachmentId}`;

export function cachedRead(attachmentId: string, now: number = Date.now()): StoredRead | null {
  try {
    const raw = window.sessionStorage.getItem(cacheKey(attachmentId));
    if (!raw) return null;
    const kept = JSON.parse(raw) as { v?: number; at?: number; fileName?: string; proposal?: TarkibProposal; today?: ReadToday | null };
    if (kept.v !== CACHE_VERSION || typeof kept.at !== 'number' || now - kept.at > CACHE_MS || !Array.isArray(kept.proposal?.rows)) {
      window.sessionStorage.removeItem(cacheKey(attachmentId));
      return null;
    }
    return { attachmentId, fileName: String(kept.fileName ?? ''), at: kept.at, proposal: kept.proposal!, today: kept.today ?? null };
  } catch {
    // A private window throws, an old entry does not parse: no cache, a fresh reading.
    return null;
  }
}

export function storeRead(read: StoredRead): void {
  try {
    const { attachmentId, ...kept } = read;
    window.sessionStorage.setItem(cacheKey(attachmentId), JSON.stringify({ v: CACHE_VERSION, ...kept }));
  } catch {
    /* storage refused — the reading simply is not kept */
  }
}

export function forgetRead(attachmentId: string): void {
  try {
    window.sessionStorage.removeItem(cacheKey(attachmentId));
  } catch {
    /* nothing to forget */
  }
}

/** A little longer than the server's own leash (150 s) — never shorter, or a paid answer arrives to nobody. */
export const READ_DEADLINE_MS = 165_000;

const isAnswer = (value: unknown): value is ReadAnswer => {
  if (typeof value !== 'object' || value === null) return false;
  const answer = value as { ok?: unknown; error?: unknown; proposal?: { rows?: unknown } };
  if (answer.ok === true) return Array.isArray(answer.proposal?.rows);
  return answer.ok === false && typeof answer.error === 'string';
};

/**
 * One reading asked of the server. Never throws: a dead connection, a
 * deadline and a proxy's error page each come back as a code the editor has
 * words for, so the button always re-enables with a sentence.
 */
export async function requestTarkibRead(
  lotId: string,
  attachmentId: string,
  deadlineMs: number = READ_DEADLINE_MS,
): Promise<ReadAnswer> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), deadlineMs);
  try {
    const res = await fetch('/api/tarkib/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lotId, attachmentId }),
      cache: 'no-store',
      signal: controller.signal,
    });
    const answer: unknown = await res.json().catch(() => null);
    if (controller.signal.aborted) return { ok: false, error: 'read_deadline' };
    if (isAnswer(answer)) return answer;
    return { ok: false, error: res.status === 401 ? 'unauthorized' : 'failed' };
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'read_deadline' : 'read_offline' };
  } finally {
    window.clearTimeout(timer);
  }
}

/** A row note or a proposal warning in words — ONE literal map each (a runtime-built key throws at render, #163). */
export function useProposalWords(): { note: (n: ProposalNote) => string; warning: (w: ProposalWarning) => string } {
  const t = useTranslations('tarkib');
  const field = (code: 'pieces' | 'cartons' | 'kg' | 'm3'): string => {
    switch (code) {
      case 'pieces':
        return t('read.fields.pieces');
      case 'cartons':
        return t('read.fields.cartons');
      case 'kg':
        return t('read.fields.kg');
      case 'm3':
        return t('read.fields.m3');
    }
  };
  return {
    note: (n) => {
      switch (n.code) {
        case 'name_cut':
          return t('read.notes.name_cut');
        case 'name_short':
          return t('read.notes.name_short');
        case 'dropped':
          return t('read.notes.dropped', { field: field(n.params.field), value: n.params.value });
        case 'rounded':
          return t('read.notes.rounded', { field: field(n.params.field), value: n.params.value });
        case 'gross_unused':
          return t('read.notes.gross_unused', { value: n.params.value });
        case 'seller_code':
          return t('read.notes.seller_code', { value: n.params.value });
      }
    },
    warning: (w) => {
      switch (w.code) {
        case 'rows_cut':
          return t('read.warnings.rows_cut', { shown: w.params.shown, total: w.params.total });
        case 'text_cut':
          return t('read.warnings.text_cut');
        case 'cells_cut':
          return t('read.warnings.cells_cut');
        case 'doc_invoice':
          return t('read.warnings.doc_invoice');
        case 'doc_other':
          return t('read.warnings.doc_other');
        case 'totals_differ':
          return t('read.warnings.totals_differ', { field: field(w.params.field), sum: w.params.sum, total: w.params.total });
      }
    },
  };
}

/** «Bugun AI o'qish: N / LIMIT» — for everyone behind the editor's door; the dollars only where the route sent them. */
export function ReadTodayLine({ today }: { today: ReadToday }) {
  const t = useTranslations('tarkib');
  return (
    <p className="text-xs text-ink-500" data-testid="tarkib-read-today">
      {today.limit > 0 ? t('read.today', { used: today.used, limit: today.limit }) : t('read.off')}
      {today.usd !== null && <> · {t('read.todayUsd', { usd: today.usd.toFixed(2) })}</>}
      {today.usd30 !== null && <> · {t('read.monthUsd', { usd: today.usd30.toFixed(2) })}</>}
      {today.unpriced !== null && today.unpriced > 0 && <> · {t('read.unpriced', { n: today.unpriced })}</>}
    </p>
  );
}

export function TarkibReadDialog({
  open,
  read,
  lot,
  totals,
  existing,
  busy,
  error,
  onApply,
  onAgain,
  onClose,
}: {
  open: boolean;
  read: StoredRead | null;
  /** The lot the editor stands on: its STORED names, for the name rule. */
  lot: ProposalLot;
  totals: LotTotals;
  /** The editor's lines as they are — «add» keeps the typed ones. */
  existing: readonly DraftLine[];
  /** A new reading of this document is in flight. */
  busy: boolean;
  /** That reading's refusal, already in words. */
  error: string | null;
  onApply: (lines: DraftLine[]) => void;
  onAgain: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('tarkib');
  return (
    // Kept MOUNTED and toggled: an Overlay mounted already open closes itself
    // on the frame it appears (its close-on-navigation effect runs on mount).
    <Overlay
      open={open && read !== null}
      // Only a navigation closes it from outside — the page underneath has
      // gone. A backdrop tap or Escape is a stray tap on a paid reading.
      onClose={(reason) => {
        if (reason === 'route') onClose();
        return false;
      }}
      closeLabel={t('read.close')}
      testId="tarkib-read-dialog"
      className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-2xl bg-surface-raised shadow-xl md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[85dvh] md:w-[44rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
    >
      {read && (
        // Keyed on the reading: a new one starts from its own ticks, never
        // from the ticks of the list it replaced. The key is on the BODY —
        // on the Overlay it would remount it open (#684).
        <ReadBody
          key={read.at}
          read={read}
          lot={lot}
          totals={totals}
          existing={existing}
          busy={busy}
          error={error}
          onApply={onApply}
          onAgain={onAgain}
          onClose={onClose}
        />
      )}
    </Overlay>
  );
}

function ReadBody({
  read,
  lot,
  totals,
  existing,
  busy,
  error,
  onApply,
  onAgain,
  onClose,
}: {
  read: StoredRead;
  lot: ProposalLot;
  totals: LotTotals;
  existing: readonly DraftLine[];
  busy: boolean;
  error: string | null;
  onApply: (lines: DraftLine[]) => void;
  onAgain: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('tarkib');
  const words = useProposalWords();
  const { proposal } = read;
  const { rows } = proposal;
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() =>
    tickedToBegin(proposal) ? new Set(rows.map((_, i) => i)) : new Set<number>(),
  );
  const [refusal, setRefusal] = useState<ApplyRefusal | null>(null);

  const sums = tickedSums(rows, ticked);
  const own = lotUnits(totals);
  const typed = hasTypedLines(existing);
  // How old the reading is, in whole minutes — said only once it is not fresh.
  const [age] = useState(() => Math.floor((Date.now() - read.at) / 60_000));

  function pick(next: ReadonlySet<number>) {
    setTicked(next);
    setRefusal(null);
  }
  function toggle(i: number) {
    const next = new Set(ticked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    pick(next);
  }
  function apply(how: 'replace' | 'append') {
    const out = applyProposal({ rows, ticked, lot, existing, how });
    if (out.ok) onApply(out.lines);
    else setRefusal(out.refusal);
  }

  const refusalText = (r: ApplyRefusal): string => {
    switch (r.code) {
      case 'none':
        return t('read.refuse.none');
      case 'too_many':
        return t('read.refuse.too_many', { n: r.n });
      case 'duplicates':
        return t('read.refuse.duplicates', { names: r.names.join(', ') });
      case 'append_overflow':
        return t('read.refuse.append_overflow', { have: r.have, add: r.add });
      case 'append_duplicates':
        return t('read.refuse.append_duplicates', { names: r.names.join(', ') });
    }
  };

  /** One measure of the ticked rows beside the lot's: good when equal, a warning when not. */
  const measure = (text: string, same: boolean, missing: number) => (
    <span className={same && missing === 0 ? 'text-good' : 'text-warn'}>
      {text}
      {missing > 0 && ` (${t('read.sumMissing', { n: missing })})`}
    </span>
  );
  const fileTotals = proposal.fileTotals;
  const paperParts = fileTotals
    ? [
        fileTotals.cartons !== null ? `${fileTotals.cartons} ${t('cartonsShort')}` : null,
        fileTotals.kg !== null ? `${fileTotals.kg} kg (${t('read.sumGross')})` : null,
        fileTotals.m3 !== null ? `${fileTotals.m3} m³` : null,
      ].filter((part): part is string => part !== null)
    : [];

  return (
    <>
      <div className="space-y-1 border-b border-line p-3">
        <p className="text-base font-bold">🤖 {t('read.title')}</p>
        <p className="truncate text-xs text-ink-500">
          📄 {read.fileName}
          {age >= 2 && ` · ${t('read.cachedAt', { minutes: age })}`}
        </p>
        <p className="text-xs font-semibold text-warn">{t('read.check')}</p>
        {read.today && <ReadTodayLine today={read.today} />}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {proposal.warnings.map((w, i) => (
          <p key={i} className="break-words text-xs font-semibold text-warn" data-testid="tarkib-read-warning">
            ⚠ {words.warning(w)}
          </p>
        ))}
        {proposal.notes && <p className="break-words text-xs text-ink-700">🤖 {proposal.notes}</p>}
        <p className={proposal.weightKind === 'gross' ? 'text-xs text-ink-500' : 'text-xs font-semibold text-warn'} data-testid="tarkib-read-weight">
          {proposal.weightKind === 'gross'
            ? t('read.weightGross')
            : proposal.weightKind === 'net'
              ? t('read.weightNet')
              : t('read.weightNone')}
        </p>
        {proposal.lotsOnReceipt > 1 ? (
          <p className="text-xs font-semibold text-ink-900" data-testid="tarkib-read-pick">
            {t('read.pickLots', { n: proposal.lotsOnReceipt })}
          </p>
        ) : (
          rows.length > MAX_LINES && (
            <p className="text-xs font-semibold text-ink-900" data-testid="tarkib-read-pick">
              {t('read.pickMany', { n: rows.length })}
            </p>
          )
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary !min-h-9 whitespace-normal px-2 text-xs"
            data-testid="tarkib-read-all"
            onClick={() => pick(new Set(rows.map((_, i) => i)))}
          >
            {t('read.all')}
          </button>
          <button
            type="button"
            className="btn-secondary !min-h-9 whitespace-normal px-2 text-xs"
            data-testid="tarkib-read-none"
            onClick={() => pick(new Set<number>())}
          >
            {t('read.none')}
          </button>
          <span
            className={sums.count > MAX_LINES ? 'text-sm font-bold text-bad' : 'text-sm font-bold text-ink-700'}
            data-testid="tarkib-read-count"
          >
            {t('read.count', { n: sums.count })}
          </span>
        </div>

        <div className="space-y-1.5">
          {rows.map((row, i) => {
            const on = ticked.has(i);
            const name = appliedName(row, lot);
            const figures = [
              row.pieces !== '' ? `${row.pieces} ${t('piecesShort')}` : null,
              row.cartons !== '' ? `${row.cartons} ${t('cartonsShort')}` : null,
              row.kg !== '' ? `${row.kg} kg` : null,
              row.m3 !== '' ? `${row.m3} m³` : null,
              row.tnved !== '' ? row.tnved : null,
            ].filter((part): part is string => part !== null);
            return (
              <label
                key={i}
                data-testid="tarkib-read-row"
                data-ticked={on ? 'yes' : 'no'}
                className={
                  on
                    ? 'flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-brand-600 bg-brand-50 p-2'
                    : 'flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-line p-2'
                }
              >
                <input
                  type="checkbox"
                  data-testid="tarkib-read-tick"
                  className="mt-0.5 h-5 w-5 shrink-0"
                  checked={on}
                  onChange={() => toggle(i)}
                />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block break-words font-semibold" data-testid="tarkib-read-name">
                    {name.name}
                  </span>
                  {name.name !== row.name && (
                    <span className="block break-words text-xs text-ink-500">{t('read.paperName', { name: row.name })}</span>
                  )}
                  {name.own && <span className="block text-xs text-ink-500">{t('read.ownGood')}</span>}
                  <span className="block break-words text-xs text-ink-700" data-testid="tarkib-read-figures">
                    {figures.length > 0 ? figures.join(' · ') : t('read.noFigures')}
                  </span>
                  {row.notes.map((n, j) => (
                    <span key={j} className="block break-words text-xs text-warn">
                      ⚠ {words.note(n)}
                    </span>
                  ))}
                  {row.unsure && <span className="block break-words text-xs text-warn">🤖 {row.unsure}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-2 border-t border-line p-3 pb-safe">
        <div className="space-y-0.5 text-xs" data-testid="tarkib-read-sums">
          <p className="break-words font-semibold">
            <span className="text-ink-900">{t('read.sumTicked')}: </span>
            {measure(`${sums.cartons} ${t('cartonsShort')}`, sums.cartons === own.cartons, sums.missing.cartons)}
            <span className="text-ink-400"> · </span>
            {measure(`${fromUnits(sums.kgUnits, KG_SCALE)} kg`, sums.kgUnits === own.kgUnits, sums.missing.kg)}
            <span className="text-ink-400"> · </span>
            {measure(`${fromUnits(sums.m3Units, M3_SCALE)} m³`, sums.m3Units === own.m3Units, sums.missing.m3)}
          </p>
          <p className="break-words text-ink-500">
            {t('read.sumLot')}: {totals.boxCount} {t('cartonsShort')} · {fromUnits(own.kgUnits, KG_SCALE)} kg ·{' '}
            {fromUnits(own.m3Units, M3_SCALE)} m³
          </p>
          {paperParts.length > 0 && (
            <p className="break-words text-ink-500" data-testid="tarkib-read-paper">
              {t('read.sumPaper')}: {paperParts.join(' · ')}
            </p>
          )}
        </div>
        {cartonsMixed(rows, ticked) && <p className="text-xs font-semibold text-warn">{t('read.cartonsMixed')}</p>}
        {refusal && (
          <p className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad" data-testid="tarkib-read-refusal">
            {refusalText(refusal)}
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad" data-testid="tarkib-read-error">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost !min-h-10 px-3 text-sm" data-testid="tarkib-read-close" onClick={onClose}>
            {t('read.close')}
          </button>
          <button
            type="button"
            className="btn-secondary !min-h-10 whitespace-normal px-3 text-sm disabled:opacity-50"
            data-testid="tarkib-read-again"
            disabled={busy}
            onClick={() => {
              // A new reading is a new bill line: asked, never a stray tap.
              if (window.confirm(t('read.againConfirm'))) onAgain();
            }}
          >
            {busy ? '⏳' : '🔄'} {busy ? t('read.reading') : t('read.again')}
          </button>
          {typed ? (
            <>
              <button
                type="button"
                className="btn-secondary !min-h-10 flex-1 whitespace-normal px-3 text-sm"
                data-testid="tarkib-read-append"
                onClick={() => apply('append')}
              >
                {t('read.append', { n: sums.count })}
              </button>
              <button
                type="button"
                className="btn-primary !min-h-10 flex-1 whitespace-normal px-3 text-sm"
                data-testid="tarkib-read-replace"
                onClick={() => apply('replace')}
              >
                {t('read.replace', { n: sums.count })}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-primary !min-h-10 flex-1 whitespace-normal px-3 text-sm"
              data-testid="tarkib-read-apply"
              onClick={() => apply('replace')}
            >
              {t('read.apply', { n: sums.count })}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
