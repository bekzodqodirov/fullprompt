'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { addCostEntryAction, rebaseCostAction, voidCostEntryAction } from '@/app/(protected)/costs/actions';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { latestTxDate } from '@/modules/wms/finance/dates';
import type { AllocationBasis } from '@/modules/wms/costing/engine';
import { FREIGHT_LIGHT_BELOW, bandText, freightUsable, offeredBases } from '@/modules/wms/costing/freight-split';
import type { FreightHeld, FreightOffer, FreightRowView, RebasePreview } from '@/modules/wms/costing/freight-types';
import { FreightGroupRows, FreightHeldLines, FreightHeldNote } from '@/components/freight-views';
import { UnmergeButton } from '@/app/(protected)/accounting/xarajat-kassa/unmerge-button';
import { TwinGapNote, TwinWarning } from '@/components/twin-warning';
import type { TwinGap, TwinView } from '@/modules/wms/accounting/twins';

export interface CostEntryView {
  id: string;
  typeName: string;
  amount: string;
  currency: string;
  amountUsd: string | null;
  costDate: string;
  allocationBasis: string;
  note: string | null;
  clientCode?: string | null;
  /** Who settled it, when it was not us (round 39). */
  partnerName?: string | null;
  /** A member of staff paid it and this reader may not see who (`payerView`, M3a). */
  payerHidden?: boolean;
  /** The kassa it left from — the NAME only for money readers (0101). */
  accountName?: string | null;
  /** A kassa answered for it, whether or not this reader may see which. */
  paidFromTill?: boolean;
  /**
   * False when this reader may not void the row and must be told who may
   * (`tillView`: a kassa-paid cost, for a reader the kassa is hidden from —
   * Q19). Undefined keeps the 🗑 exactly as every other caller has it.
   */
  voidable?: boolean;
  /**
   * The accountant's expense this cost was merged with (Q8). While set, the
   * cost is the only record of that money: nobody voids it until the merge
   * is undone, and the row says so in words that fit the reader.
   */
  mergedExpenseId?: string | null;
  /**
   * A freight bill's explanation — its frozen column, whether it sits on any
   * box, and its split (docs/YOLKIRA-TAQSIMOT.md §7.4). REQUIRED: a card
   * that never draws freight says `null`, so a new card cannot forget it.
   */
  freight: FreightRowView | null;
  /**
   * May this row's basis be changed in place — a TRUCK's own bill (§8). The
   * per-prixod grid's cells and the receipt/crate/pickup cards say false.
   */
  rebasable: boolean;
  /** The bill's type — which bases the re-basis select offers for it (§4). */
  costTypeId: string;
  /**
   * Converted and on no box, whatever its basis — the same fact the truck's
   * todo, its Σ and the pricing page count (`noShareSql`), so a counted bill
   * is always a marked row (review of the round: a weight bill typed before
   * any carton boarded was counted and marked nowhere).
   */
  unsplit: boolean;
}

/** What one bill leaves for the next on the general entry page (his 5a). */
export interface CostKept {
  typeId: string;
  currency: string;
  costDate: string;
  payer: string;
  /**
   * Only a basis the person CHOSE (review of the round): the effective one
   * carried a weight that was merely this truck's default onto the next
   * truck as a «touched» choice, and a priced column there never got its
   * freight preselect (his 4a).
   */
  basis?: AllocationBasis;
}

export interface CostTypeOption {
  id: string;
  code: string;
  name: string;
}
export interface ClientOption {
  id: string;
  clientCode: string;
}

/**
 * The payer/kassa refusals in words (0101). A literal list, not a key built
 * from the code: a key assembled at runtime is invisible to the i18n fence
 * and throws at render (#163). Fenced (SARFLAR §8.5): every code the add and
 * void doors can return is a key here or on the test's counted allowlist,
 * and every word exists in all four bundles — `tests/unit/cost-refusals.test.ts`.
 */
const PAYER_ERRORS = {
  till_forbidden: 'errTillForbidden',
  staff_payer_forbidden: 'errStaffPayer',
  kassa_cost_needs_finance: 'errKassaVoid',
  account_amount_required: 'errTillAmountRequired',
  account_amount_mismatch: 'errTillAmountMismatch',
  account_not_found: 'errTillNotFound',
  account_currency_mismatch: 'errTillCurrency',
  payer_conflict: 'errPayerConflict',
  staff_cost_needs_finance: 'errStaffVoid',
  partner_cost_not_yours: 'errPartnerVoidNotYours',
  partner_cost_settled: 'errPartnerVoidSettled',
  cost_not_yours: 'errCostNotYours',
  future_date: 'errFutureDate',
  amount_too_large: 'errAmountTooLarge',
  merged_cost: 'errMergedCost',
  merged_cost_ask: 'errMergedCostAsk',
  cost_payer_changed: 'errPayerChanged',
  // The add door (SARFLAR §8.5): a cancelled truck, a voided prixod.
  cancelled: 'errCancelled',
  receipt_voided: 'errReceiptVoided',
  not_found: 'errNotFound',
  forbidden: 'errForbidden',
  validation: 'errValidation',
  already_voided: 'errAlreadyVoided',
  // The freight basis's tariff configuration (0132, docs/YOLKIRA-TAQSIMOT.md
  // §5): each NAMES what to fix — the warehouse, the column, the date.
  freight_batch_only: 'errFreightBatchOnly',
  freight_on_customs: 'errFreightOnCustoms',
  freight_no_column: 'errFreightNoColumn',
  freight_zone_unpriced: 'errFreightUnpriced',
  freight_tariff_gap: 'errFreightGap',
  freight_tariff_top: 'errFreightTop',
  freight_tariff_overlap: 'errFreightOverlap',
  freight_tariff_invalid: 'errFreightInvalid',
  freight_changed: 'errFreightChanged',
  server_behind: 'errServerBehind',
  // The re-basis door (§8).
  rebase_changed: 'errRebaseChanged',
  rebase_same: 'errRebaseSame',
  rebase_direct: 'errRebaseDirect',
  rebase_batch_only: 'errRebaseBatchOnly',
} as const;

/**
 * A refusal in words, from the WHOLE action result (T9): the type carries the
 * params, so a call site cannot forget them. A column's code is resolved into
 * /admin/tarif's own zone words before it reaches the sentence.
 */
function payerErrorText(
  res: { error?: string; params?: Record<string, string | number> },
  t: (key: string, values?: Record<string, string | number>) => string,
  zoneWords: (zone: string) => string,
): string {
  const code = res.error;
  const key = code ? PAYER_ERRORS[code as keyof typeof PAYER_ERRORS] : undefined;
  if (!key) return code ?? 'error';
  const params = res.params
    ? { ...res.params, ...(typeof res.params.column === 'string' ? { column: zoneWords(res.params.column) } : {}) }
    : undefined;
  return t(key, params);
}

/** His rule 6's «10», as the sentences say it (the copy freezes the real one per bill). */
const FREIGHT_LIMIT = FREIGHT_LIGHT_BELOW;

/** The disabled freight option's own short fact (SP-5) — a literal map, never a built key (#163). */
const FREIGHT_OPT = {
  server_behind: 'freightOptServerBehind',
  no_column: 'freightOptNoColumn',
  unpriced: 'freightOptUnpriced',
  problem: 'freightOptProblem',
} as const;

function freightOffText(
  offer: FreightOffer,
  why: keyof typeof FREIGHT_OPT,
  costDate: string,
  t: (key: string, values?: Record<string, string | number>) => string,
  zoneWords: (zone: string) => string,
): string {
  if (offer.status === 'server_behind' || why === 'server_behind') return t('freightOffServerBehind');
  const warehouse = `${offer.warehouse.code} — ${offer.warehouse.name}`;
  if (offer.status === 'no_column') return t('freightOffNoColumn', { warehouse });
  if (why === 'unpriced') return t('freightOffUnpriced', { warehouse, column: zoneWords(offer.zone), date: costDate });
  return t('freightOffProblem', { column: zoneWords(offer.zone) });
}

/**
 * «Bo'lish usuli ✎» on a truck's own bill (docs/YOLKIRA-TAQSIMOT.md §8, his
 * 5a): pick a basis → «Ko'rish» answers who moves how much, before anything
 * is written → «Shu usulda saqlash» posts the preview's token. A refusal
 * that came with a FRESH preview (`rebase_changed`) shows both. Below the
 * row's chips, full width, so nothing is squeezed beside the 🗑 (SP-9).
 */
function RebaseBlock({
  entry,
  freight,
  t,
  zoneWords,
  onSaved,
}: {
  entry: CostEntryView;
  freight: FreightOffer | null;
  t: (key: string, values?: Record<string, string | number>) => string;
  zoneWords: (zone: string) => string;
  onSaved: (held: FreightHeld | null, pending: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<RebasePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flags = freight?.typeFlags ?? { freightTypeIds: [], customsTypeIds: [] };
  const usable = freightUsable(freight, entry.costDate);
  const choices = offeredBases('batch', flags, entry.costTypeId).filter((b) => b !== 'direct_to_client');

  async function press(seen?: string) {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rebaseCostAction({ entryId: entry.id, basis: target, ...(seen ? { seen } : {}) });
      if (res.ok) {
        setOpen(false);
        setPreview(null);
        onSaved(res.unsplit?.held ?? null, res.pending === true);
        return;
      }
      setPreview(res.rebase ?? null);
      if (res.error) setError(payerErrorText(res, t, zoneWords));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="text-xs font-semibold text-brand-700" data-testid="cost-rebase" onClick={() => setOpen(true)}>
        {t('rebaseButton')}
      </button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-lg bg-surface-sunken p-2 text-xs" data-testid="cost-rebase-block">
      <select
        aria-label={t('basis')}
        data-testid="cost-rebase-basis"
        className="input"
        value={target}
        onChange={(e) => {
          setTarget(e.target.value);
          setPreview(null);
          setError(null);
        }}
      >
        <option value="">{t('basis')}…</option>
        {choices.map((b) => (
          <option key={b} value={b} disabled={b === 'freight' && !usable.ok}>
            {t(`bases.${b}`)}
            {b === 'freight' && !usable.ok ? ` ${t(FREIGHT_OPT[usable.why])}` : ''}
          </option>
        ))}
      </select>
      {preview && (
        <div className="space-y-1 rounded-md bg-surface p-2" data-testid="cost-rebase-preview">
          <p className="font-semibold text-ink-700">{t('rebasePreviewTitle')}</p>
          {preview.column && (
            <p className="min-w-0 break-words text-ink-700">
              {t('rebaseColumn', {
                column: zoneWords(preview.column.zone),
                warehouse: preview.column.warehouseCode,
                from: preview.column.tariffFrom,
              })}
              {preview.column.previousZone && preview.column.previousZone !== preview.column.zone
                ? ` · ${t('rebaseColumnMoved', {
                    old: zoneWords(preview.column.previousZone),
                    new: zoneWords(preview.column.zone),
                  })}`
                : ''}
            </p>
          )}
          {preview.unconverted && <p className="text-warn">{t('rebaseUnconverted')}</p>}
          <ul className="space-y-0.5">
            {preview.rows.map((row) => (
              <li key={row.key} className="min-w-0 break-words" data-testid={`cost-rebase-row-${row.key}`}>
                {t('rebaseRow', { label: row.label, before: row.beforePct, after: row.afterPct })}
                {row.band
                  ? (() => {
                      const b = bandText(row.band, { money: preview.money });
                      return ` · ${t(b.key, { range: b.range, price: b.price })}`;
                    })()
                  : ''}
                {row.beforeUsd !== undefined || row.afterUsd !== undefined
                  ? ` · ${t('rebaseRowMoney', {
                      before: (row.beforeUsd ?? 0).toFixed(2),
                      after: (row.afterUsd ?? 0).toFixed(2),
                    })}`
                  : ''}
              </li>
            ))}
          </ul>
          {preview.nowhere && (
            <p className="font-semibold text-warn" data-testid="cost-rebase-nowhere">
              ⚠ {t('rebaseNowhere')}
            </p>
          )}
          {preview.held && (
            <div className="text-warn">
              <p className="font-semibold">{t('freightPreviewHeld')}</p>
              <FreightHeldLines held={preview.held} limit={FREIGHT_LIMIT} />
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="font-semibold text-bad">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {preview ? (
          <button
            type="button"
            className="btn-primary flex-1 disabled:opacity-50"
            data-testid="cost-rebase-save"
            disabled={busy}
            onClick={() => press(preview.seen)}
          >
            {t('rebaseSave')}
          </button>
        ) : (
          <button
            type="button"
            className="btn-secondary flex-1 disabled:opacity-50"
            data-testid="cost-rebase-show"
            disabled={busy || !target}
            onClick={() => press()}
          >
            {t('rebaseShow')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setOpen(false);
            setPreview(null);
            setError(null);
          }}
        >
          {t('rebaseCancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * W9 cost capture (spec 6.9) — shared by the batch card (freight, agent fee,
 * customs…), the receipt page (local handling) and the crate card (the yashik
 * fee, correctable since round 31). Lists entries with their USD conversion,
 * adds new ones, voids with a reason.
 */
export function CostPanel({
  scope,
  targetId,
  entries,
  costTypes,
  currencies,
  clientOptions,
  defaultCurrency,
  canVoid,
  canAdd,
  partnerOptions = [],
  tillOptions = [],
  today,
  canUnmerge = false,
  afterSave = 'close',
  initial,
  defaultTypeCode,
  onKept,
  onBusy,
  freight,
}: {
  scope: 'batch' | 'receipt' | 'crate' | 'pickup';
  targetId: string;
  entries: CostEntryView[];
  costTypes: CostTypeOption[];
  currencies: string[];
  /** Clients aboard — needed only for direct_to_client. */
  clientOptions: ClientOption[];
  defaultCurrency: string;
  /**
   * May this reader void a row (the 🗑) — the void door's own grant — and,
   * separately, ADD one (SARFLAR §8.5). Both REQUIRED: the truck tab passes
   * `mayEnterBatchCost` as `canAdd`, so a cancelled truck keeps its 🗑 (the
   * annul leaves kassa-paid bills on it for a person to void) and loses its
   * «＋»; the receipt, crate and pickup cards pass one value to both.
   */
  canVoid: boolean;
  canAdd: boolean;
  /**
   * Counterparties who might have settled this cost out of their own account
   * (round 39). Empty for a caller that does not offer the choice, and then
   * the field is not drawn at all.
   */
  partnerOptions?: { id: string; name: string }[];
  /**
   * The kassas the money may have left from (0101). Offered to the kassa
   * holders only — the server passes an empty list to everybody else, and the
   * action refuses a posted kassa from them (`till_forbidden`).
   */
  tillOptions?: { id: string; name: string; currency: string }[];
  /**
   * The default cost date: Tashkent's day, computed on the SERVER (R5). The
   * browser's own clock is neither the office's nor reliably set.
   */
  today: string;
  /**
   * May this reader undo a merge (`mayPickTill` — the kassa holders, Q8)? The
   * server passes it; the door refuses anybody else anyway.
   */
  canUnmerge?: boolean;
  /**
   * `'again'` — the general entry page (SARFLAR §2, his 5a «one bill at a
   * time; the form stays open»): the form opens on mount and stays open
   * after a save, clearing only the amount, the kassa amount and the note.
   * The truck tab keeps `'close'`.
   */
  afterSave?: 'close' | 'again';
  /** What the previous bill kept (type, currency, date, payer, basis) — carried across a truck switch. */
  initial?: Partial<CostKept>;
  /** The type a fresh panel proposes, by its fixed code (the entry page: `freight`). */
  defaultTypeCode?: string;
  /** Told after every save what is kept for the next bill. */
  onKept?: (kept: CostKept) => void;
  /** Told while a save is in flight, so the page can hold the truck picker still. */
  onBusy?: (busy: boolean) => void;
  /**
   * The freight basis's offer for THIS truck (docs/YOLKIRA-TAQSIMOT.md §7.2)
   * — REQUIRED, so a caller that forgets it does not compile: receipt, crate
   * and pickup cards pass null, and then 'freight' is never listed.
   */
  freight: FreightOffer | null;
}) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const tzone = useTranslations('calc');
  const zoneWords = (zone: string) =>
    tzone.has(`zones.${zone}`) ? tzone(`zones.${zone}` as 'zones.cn') : zone;
  const router = useRouter();
  const again = afterSave === 'again';
  const [adding, setAdding] = useState(again);
  const [busy, setBusyState] = useState(false);
  const setBusy = (value: boolean) => {
    setBusyState(value);
    onBusy?.(value);
  };
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A kept type must still be offered on this truck's list; a code default
  // only when it is active.
  const keptType = initial?.typeId && costTypes.some((type) => type.id === initial.typeId) ? initial.typeId : undefined;
  const codeType = defaultTypeCode ? costTypes.find((type) => type.code === defaultTypeCode)?.id : undefined;
  const [typeId, setTypeId] = useState(keptType ?? codeType ?? costTypes[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(
    initial?.currency && currencies.includes(initial.currency) ? initial.currency : defaultCurrency,
  );
  const [costDate, setCostDate] = useState(initial?.costDate ?? today);
  // The factory truck is split by m³ (owner's B5a) — the default, not a lock.
  const scopeBasis: AllocationBasis = scope === 'pickup' ? 'volume' : 'weight';
  // The basis a person CHOSE, and whether they did (docs/YOLKIRA-TAQSIMOT.md
  // §4). Untouched, it follows the type and the date: a yo'lkira type on a
  // truck whose column is priced on that date reads «yo'lkira tarifi
  // bo'yicha» by itself (his 4a). A direct bill is a one-off and a kept
  // freight starts untouched, so it is re-derived for the next truck — it
  // never follows onto one whose warehouse has no column (§8.5).
  const keptTouched = Boolean(initial?.basis && initial.basis !== 'direct_to_client' && initial.basis !== 'freight');
  const [touched, setTouched] = useState(keptTouched);
  const [chosen, setChosen] = useState<AllocationBasis>(keptTouched ? (initial?.basis ?? scopeBasis) : scopeBasis);
  const flags = freight?.typeFlags ?? { freightTypeIds: [], customsTypeIds: [] };
  const offered = offeredBases(scope, flags, typeId || null);
  const usable = freightUsable(freight, costDate);
  const isFreightType = flags.freightTypeIds.includes(typeId);
  const defaultBasis: AllocationBasis =
    isFreightType && offered.includes('freight') && usable.ok && usable.version ? 'freight' : scopeBasis;
  const chosenValid = offered.includes(chosen) && (chosen !== 'freight' || usable.ok);
  const basis: AllocationBasis = touched && chosenValid ? chosen : defaultBasis;
  const dropped = touched && !chosenValid;
  const setBasis = (next: AllocationBasis) => {
    setChosen(next);
    setTouched(true);
  };
  const [unsplit, setUnsplit] = useState<FreightHeld | null>(null);
  // A re-basis whose split was queued (§8.4): said until the next press.
  const [rebasePending, setRebasePending] = useState(false);
  const [clientId, setClientId] = useState('');
  // ONE «who paid» choice (0101): our money with no kassa said yet (the
  // accountant's queue), a kassa, or a counterparty — never two, which is
  // also the database's cost_entries_payer_check. A kept payer must still
  // be offered here.
  const keptPayer =
    initial?.payer &&
    (tillOptions.some((option) => `till:${option.id}` === initial.payer) ||
      partnerOptions.some((option) => `partner:${option.id}` === initial.payer))
      ? initial.payer
      : '';
  const [payer, setPayer] = useState(keptPayer);
  const [tillAmount, setTillAmount] = useState('');
  const [note, setNote] = useState('');
  // «Bu pul allaqachon yozilgan» (SARFLAR §3): the server's answer instead
  // of a save. Every input above stays as typed, so «Baribir saqlash» posts
  // the same values with the token the server computed.
  const [twins, setTwins] = useState<TwinView | null>(null);
  // A clean save's «kurs yo'q — solishtirib bo'lmadi» (§8.1): kept outside
  // the form, which a one-shot panel closes on success.
  const [gap, setGap] = useState<TwinGap | null>(null);
  const partnerId = payer.startsWith('partner:') ? payer.slice(8) : '';
  const accountId = payer.startsWith('till:') ? payer.slice(5) : '';
  const till = tillOptions.find((option) => option.id === accountId);
  const tillInOtherCurrency = till !== undefined && till.currency !== currency;

  async function submit(twinAck?: string) {
    setBusy(true);
    setRebasePending(false);
    setError(null);
    setSaved(false);
    setGap(null);
    try {
      const res = await addCostEntryAction({
        twinAck,
        scope,
        batchId: scope === 'batch' ? targetId : undefined,
        receiptId: scope === 'receipt' ? targetId : undefined,
        crateId: scope === 'crate' ? targetId : undefined,
        pickupId: scope === 'pickup' ? targetId : undefined,
        costTypeId: typeId,
        amount: parseTypedMoney(amount) ?? Number.NaN,
        currency,
        costDate,
        allocationBasis: basis,
        // What the preview drew (M6): the server refuses a column that moved
        // between this render and the press instead of freezing it silently.
        ...(basis === 'freight' && usable.ok && usable.version ? { freightSeen: usable.version.digest } : {}),
        clientId: basis === 'direct_to_client' ? clientId || undefined : undefined,
        partnerId: partnerId || undefined,
        accountId: accountId || undefined,
        accountAmount: tillInOtherCurrency ? (parseTypedMoney(tillAmount) ?? Number.NaN) : undefined,
        note,
      });
      if (res.twins) {
        setTwins(res.twins);
      } else if (res.ok) {
        setTwins(null);
        setGap(res.unchecked ?? null);
        setAdding(again);
        setAmount('');
        setTillAmount('');
        setNote('');
        const nextBasis = touched && chosenValid && chosen !== 'direct_to_client' ? chosen : undefined;
        if (basis === 'direct_to_client') {
          setChosen(scopeBasis);
          setTouched(false);
          setClientId('');
        }
        setUnsplit(res.unsplit?.held ?? null);
        setSaved(again);
        onKept?.({ typeId, currency, costDate, payer, basis: nextBasis });
        router.refresh();
      } else {
        setTwins(null);
        // The column moved under the preview (M6): the page's offer is the
        // old one, so without a refresh every press would post the same stale
        // digest and be refused for ever. The inputs are controlled and
        // survive it.
        if (res.error === 'freight_changed') router.refresh();
        setError(
          res.error === 'client_required'
            ? t('clientRequired')
            : // Naming a payer turns the cost into a debt, and a debt needs a
              // rate. Refused rather than saved half — the row used to keep
              // the firm's name with nothing on that firm's account.
              res.error === 'fx_missing'
              ? t('fxMissing')
              : payerErrorText(res, t, zoneWords),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function voidEntry(id: string) {
    const reason = window.prompt(t('voidReason'));
    if (!reason?.trim()) return;
    setRebasePending(false);
    const res = await voidCostEntryAction({ id, reason });
    if (res.ok) router.refresh();
    else setError(payerErrorText(res, t, zoneWords)); // a silent failed void looked like success
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        // `[overflow-wrap:anywhere]`: a note or a firm's name with no break
        // in it (a pasted waybill number) otherwise widens the page past 360
        // and the phone zooms everything out (#400, SARFLAR §8.5).
        <div
          key={entry.id}
          className="flex flex-wrap items-baseline gap-2 border-b border-line py-1.5 text-sm [overflow-wrap:anywhere] last:border-0"
        >
          <span>{entry.typeName}</span>
          <span className="font-semibold">
            {entry.amount} {entry.currency}
          </span>
          {entry.amountUsd !== null ? (
            <span className="text-ink-500">≈ ${entry.amountUsd}</span>
          ) : (
            <span className="rounded bg-orange-100 px-1.5 text-xs font-semibold text-orange-800">
              {t('noRate')}
            </span>
          )}
          <span className="text-xs text-ink-500">
            {entry.costDate} ·{' '}
            {entry.freight && entry.freight.zone
              ? t('freightLabel', {
                  warehouse: entry.freight.warehouseCode,
                  column: zoneWords(entry.freight.zone),
                  from: entry.freight.tariffFrom,
                })
              : t(`bases.${entry.allocationBasis}`)}
            {entry.clientCode && ` → ${entry.clientCode}`}
          </span>
          {(entry.unsplit || entry.freight?.unsplit) && (
            <span className="rounded bg-warn/15 px-1.5 text-xs font-semibold text-warn" data-testid="cost-unsplit">
              ⚠ {t('costUnsplitChip')}
            </span>
          )}
          {/* Who settled it. Its absence was the complaint: the warehouse
              could not tell our own money from a debt to the transport firm
              once the row was saved. */}
          {entry.partnerName && (
            <span className="rounded bg-warn/15 px-1.5 text-xs font-semibold text-warn">
              {entry.partnerName}
            </span>
          )}
          {entry.payerHidden && (
            <span className="rounded bg-warn/15 px-1.5 text-xs font-semibold text-warn" data-testid="cost-payer-hidden">
              🔒 {t('payerHidden')}
            </span>
          )}
          {/* Which kassa it left from (0101) — the name for money readers,
              the fact alone for everybody else. */}
          {entry.paidFromTill && (
            <span className="rounded bg-surface-sunken px-1.5 text-xs font-semibold text-ink-700" data-testid="cost-till">
              🏦 {entry.accountName ?? t('paidFromTill')}
            </span>
          )}
          {entry.mergedExpenseId && (
            <span className="rounded bg-surface-sunken px-1.5 text-xs font-semibold text-ink-700" data-testid="cost-merged">
              🔗 {t('mergedChip')}
            </span>
          )}
          {entry.mergedExpenseId && canUnmerge && <UnmergeButton expenseId={entry.mergedExpenseId} />}
          {entry.note && <span className="w-full text-xs text-ink-500">{entry.note}</span>}
          {/* «Qanday bo'lindi?» — the bill's own split over its own frozen
              column, below the row's chips so nothing is squeezed (SP-9). */}
          {entry.freight?.view && (
            <details className="w-full text-xs" data-testid="cost-freight-how">
              <summary className="cursor-pointer text-ink-700">{t('freightHow')}</summary>
              <div className="mt-1">
                <FreightGroupRows
                  view={entry.freight.view}
                  money={entry.freight.allocatedUsd !== undefined}
                  amount={null}
                  currency="USD"
                  limit={FREIGHT_LIMIT}
                  cents={entry.freight.allocatedUsd}
                  testid="cost-freight-row"
                  saved
                />
              </div>
            </details>
          )}
          {entry.rebasable && canAdd && (
            <RebaseBlock
              entry={entry}
              freight={freight}
              t={t}
              zoneWords={zoneWords}
              onSaved={(held, pending) => {
                setUnsplit(held);
                setRebasePending(pending);
                router.refresh();
              }}
            />
          )}
          {canVoid && entry.voidable !== false && (
            <button
              type="button"
              aria-label={t('void')}
              className="ml-auto text-xs font-semibold text-bad"
              onClick={() => voidEntry(entry.id)}
            >
              🗑 {t('void')}
            </button>
          )}
          {/* No silent dead end (#420): the row says who takes it back — the
              person, never the drawer the reader may not see. */}
          {canVoid && entry.voidable === false && (
            <span className="ml-auto text-xs text-ink-500" data-testid="cost-void-locked">
              🔒 {t('voidByAccountant')}
            </span>
          )}
        </div>
      ))}
      {entries.length === 0 && <p className="text-sm text-ink-500">—</p>}

      {error && !adding && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {error}
        </p>
      )}
      <TwinGapNote gap={gap} />
      <FreightHeldNote held={unsplit} limit={FREIGHT_LIMIT} />
      {rebasePending && (
        <p role="status" className="text-sm text-ink-700" data-testid="cost-rebase-pending">
          {t('rebasePending')}
        </p>
      )}
      {canAdd && !adding && (
        <button
          type="button"
          data-testid="add-cost"
          className="btn-secondary w-full"
          onClick={() => setAdding(true)}
        >
          ＋ {t('addCost')}
        </button>
      )}
      {canAdd && adding && (
        <div className="space-y-2 rounded-lg bg-surface-sunken p-3">
          <select aria-label={t('type')} className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {costTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              aria-label={t('amount')}
              data-testid="cost-amount"
              className="input flex-1"
              inputMode="decimal"
              placeholder={t('amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <select aria-label="currency" className="input !w-24 shrink-0" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <input
            aria-label={t('date')}
            type="date"
            className="input"
            value={costDate}
            // #995's rule, the door's own limit (U21): not after tomorrow.
            max={latestTxDate()}
            onChange={(e) => setCostDate(e.target.value)}
          />
          {/* Its own line. Sharing one with the date box left it reading «по»
              on a phone, and «по весу», «по объёму» and «клиенту напрямую»
              all start that way — the answer was unreadable exactly where it
              decides how the money is spread. */}
          <select
            aria-label={t('basis')}
            data-testid="cost-basis"
            className="input"
            value={basis}
            onChange={(e) => setBasis(e.target.value as AllocationBasis)}
          >
            {offered.map((b) => (
              <option key={b} value={b} disabled={b === 'freight' && !usable.ok}>
                {t(`bases.${b}`)}
                {b === 'freight' && !usable.ok ? ` ${t(FREIGHT_OPT[usable.why])}` : ''}
              </option>
            ))}
          </select>
          {dropped && (
            <p className="text-xs text-warn" data-testid="freight-dropped">
              {t('freightDropped', { basis: t(`bases.${defaultBasis}`) })}
            </p>
          )}
          {/* Why a yo'lkira bill is not split by the tariff here — a FACT,
              drawn only where the untouched default would have been freight
              (SP-5): a warehouse deliberately left without a column costs a
              bill of another type nothing. */}
          {isFreightType && offered.includes('freight') && !usable.ok && freight && (
            <p className="text-xs text-ink-500" data-testid="freight-off">
              {freightOffText(freight, usable.why, costDate, t, zoneWords)}
              {freight.status === 'no_column' && freight.mayFixColumn && (
                <>
                  {' '}
                  <a className="underline" href={`/admin/warehouses/${freight.warehouse.id}`} target="_blank" rel="noopener">
                    {t('freightFixColumn')}
                  </a>
                </>
              )}
              {freight.status === 'ready' && freight.mayFixTariff && (
                <>
                  {' '}
                  <a className="underline" href="/admin/tarif" target="_blank" rel="noopener">
                    {t('freightFixTariff')}
                  </a>
                </>
              )}
            </p>
          )}
          {basis === 'freight' && usable.ok && freight?.status === 'ready' && (
            <div className="space-y-1 rounded-md bg-surface p-2" data-testid="freight-preview">
              <p className="text-xs font-semibold text-ink-700">
                {t('freightColumnLine', {
                  warehouse: freight.warehouse.code,
                  column: zoneWords(freight.zone),
                  from: usable.version?.from ?? '—',
                })}
              </p>
              {usable.version?.split ? (
                <FreightGroupRows
                  view={usable.version.split}
                  money={freight.money}
                  amount={parseTypedMoney(amount)}
                  currency={currency}
                  limit={FREIGHT_LIMIT}
                />
              ) : (
                <p className="text-xs text-ink-500">{t('freightVersionUnknown')}</p>
              )}
            </div>
          )}
          {basis === 'direct_to_client' && (
            <select aria-label={t('client')} className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">{t('client')}…</option>
              {clientOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.clientCode}
                </option>
              ))}
            </select>
          )}
          {/* Who settled it. Left empty this is our own money, exactly as
              before; named, the cost still lands on the cargo but the amount
              becomes a debt to that firm instead of cash we spent. */}
          {/* Who paid. Drawn whenever there is a choice to make — v1 hid the
              whole select behind `partnerOptions.length > 0`, and an install
              with no counterparty would have had no way to name a kassa. */}
          {(partnerOptions.length > 0 || tillOptions.length > 0) && (
            <select
              aria-label={t('paidBy')}
              data-testid="cost-partner"
              className="input"
              value={payer}
              onChange={(e) => {
                const next = e.target.value;
                setPayer(next);
                // A kassa speaks one currency: picking it proposes that one.
                // The person may still type the cost in another and say
                // what left the kassa below.
                const picked = tillOptions.find((option) => `till:${option.id}` === next);
                if (picked && currencies.includes(picked.currency)) setCurrency(picked.currency);
              }}
            >
              <option value="">{tillOptions.length > 0 ? t('paidByUsNoTill') : t('paidByUs')}</option>
              {tillOptions.length > 0 && (
                <optgroup label={t('tillGroup')}>
                  {tillOptions.map((option) => (
                    <option key={option.id} value={`till:${option.id}`}>
                      {option.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {partnerOptions.length > 0 && (
                <optgroup label={t('partnerGroup')}>
                  {partnerOptions.map((partner) => (
                    <option key={partner.id} value={`partner:${partner.id}`}>
                      {partner.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          {tillInOtherCurrency && (
            <input
              aria-label={t('tillAmount', { currency: till.currency })}
              data-testid="cost-till-amount"
              className="input"
              inputMode="decimal"
              placeholder={t('tillAmount', { currency: till.currency })}
              value={tillAmount}
              onChange={(e) => setTillAmount(e.target.value)}
            />
          )}
          <input
            aria-label={t('note')}
            className="input"
            placeholder={t('note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm font-semibold text-bad">
              {error}
            </p>
          )}
          {saved && !error && !twins && (
            <p className="text-sm font-semibold text-good" data-testid="cost-saved">
              ✅ {tc('saved')}
            </p>
          )}
          {twins && (
            <TwinWarning
              twins={twins}
              busy={busy}
              onSaveAnyway={() => submit(twins.ackToken)}
              onBack={() => setTwins(null)}
            />
          )}
          <div className={twins ? 'hidden' : 'flex gap-2'}>
            <button
              type="button"
              data-testid="save-cost"
              className="btn-primary flex-1 disabled:opacity-50"
              disabled={busy || !typeId || !((parseTypedMoney(amount) ?? 0) > 0)}
              onClick={() => submit()}
            >
              {busy ? tc('loading') : tc('save')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
