'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { addCostEntryAction, voidCostEntryAction } from '@/app/(protected)/costs/actions';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { latestTxDate } from '@/modules/wms/finance/dates';
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
}

/** What one bill leaves for the next on the general entry page (his 5a). */
export interface CostKept {
  typeId: string;
  currency: string;
  costDate: string;
  payer: string;
  basis: (typeof BASES)[number];
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

const BASES = ['weight', 'volume', 'chargeable', 'boxes', 'direct_to_client'] as const;

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
} as const;

function payerErrorText(code: string | undefined, t: (key: string) => string): string {
  const key = code ? PAYER_ERRORS[code as keyof typeof PAYER_ERRORS] : undefined;
  return key ? t(key) : (code ?? 'error');
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
}) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
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
  const scopeBasis: (typeof BASES)[number] = scope === 'pickup' ? 'volume' : 'weight';
  // A direct bill is a one-off: it never carries over (§8.5).
  const [basis, setBasis] = useState<(typeof BASES)[number]>(
    initial?.basis && initial.basis !== 'direct_to_client' ? initial.basis : scopeBasis,
  );
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
        const nextBasis = basis === 'direct_to_client' ? scopeBasis : basis;
        if (basis === 'direct_to_client') {
          setBasis(scopeBasis);
          setClientId('');
        }
        setSaved(again);
        onKept?.({ typeId, currency, costDate, payer, basis: nextBasis });
        router.refresh();
      } else {
        setTwins(null);
        setError(
          res.error === 'client_required'
            ? t('clientRequired')
            : // Naming a payer turns the cost into a debt, and a debt needs a
              // rate. Refused rather than saved half — the row used to keep
              // the firm's name with nothing on that firm's account.
              res.error === 'fx_missing'
              ? t('fxMissing')
              : payerErrorText(res.error, t),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function voidEntry(id: string) {
    const reason = window.prompt(t('voidReason'));
    if (!reason?.trim()) return;
    const res = await voidCostEntryAction({ id, reason });
    if (res.ok) router.refresh();
    else setError(payerErrorText(res.error, t)); // a silent failed void looked like success
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
            {entry.costDate} · {t(`bases.${entry.allocationBasis}`)}
            {entry.clientCode && ` → ${entry.clientCode}`}
          </span>
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
            className="input"
            value={basis}
            onChange={(e) => setBasis(e.target.value as (typeof BASES)[number])}
          >
            {BASES.map((b) => (
              <option key={b} value={b}>
                {t(`bases.${b}`)}
              </option>
            ))}
          </select>
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
