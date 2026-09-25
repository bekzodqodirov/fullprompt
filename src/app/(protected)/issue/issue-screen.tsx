'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { Scanner } from '@/components/scan/scanner';
import { armScanAudio, scanFeedback } from '@/components/scan/feedback';
import { approvalCovers } from '@/modules/wms/issue/approval-covers';
import { issueBoxesAction, requestIssueApprovalAction } from './actions';

interface WarehouseOption {
  id: string;
  code: string;
}
interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
}
/**
 * Who is waiting at this warehouse — his own shape: «yolchi GS555 700boxes
 * gs777 400 boxes». A party is one human being when the codes have been
 * grouped under a person, and one code when they have not.
 */
interface IssueParty {
  personId: string | null;
  name: string;
  phones: string[];
  codes: { clientId: string; code: string; name: string; boxes: number }[];
  boxes: number;
}
interface UnclaimedParty {
  receiptId: string;
  marking: string;
  boxes: number;
}
interface IssuableBox {
  boxId: string;
  shortCode: string;
  seqInLot: number;
  lotId: string;
  receiptId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  /** No price covers it (`finance/unpriced.ts`). */
  uncovered?: boolean;
  /** …and the ban stops it: it landed by road after the ban's instant. */
  gated?: boolean;
}
/** A prixod at this counter with cartons that have no price (0104). */
interface UnpricedHere {
  receiptId: string;
  number: string | null;
  arrivalTrucks: { batchId: string; code: string }[];
  elsewhere: { batchId: string; code: string; usd: number }[];
  walkIn: boolean;
  boxesHere: number;
  gatedHere: number;
}
interface ApprovalState {
  id: string;
  status: string;
  expiresAt: string | null;
  blockingDebtUsd: number;
  unpricedBoxIds: string[];
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
  const [parties, setParties] = useState<IssueParty[] | null>(null);
  const [unclaimed, setUnclaimed] = useState<UnclaimedParty[]>([]);
  const [partiesMore, setPartiesMore] = useState(0);
  /**
   * Why the waiting list is not on screen: an HTTP status the server answered
   * with, or 'offline' when the request never got there. `null` = no failure.
   */
  const [partiesFailed, setPartiesFailed] = useState<string | null>(null);
  const [list, setList] = useState<IssuableBox[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [personName, setPersonName] = useState('');
  const [personPhone, setPersonPhone] = useState('');
  const [debtOk, setDebtOk] = useState(false);
  /** The price half of the holder's tick (0104) — its own box, its own words. */
  const [priceOk, setPriceOk] = useState(false);
  const [unpriced, setUnpriced] = useState<UnpricedHere[]>([]);
  const [compensated, setCompensated] = useState<{ receiptNumber: string }[]>([]);
  const [gate, setGate] = useState<{ state: 'on' | 'off' | 'invalid'; since: string | null }>({
    state: 'off',
    since: null,
  });
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
  /** Phase 6: the live request/approval for this client at this warehouse. */
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [asking, setAsking] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
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

  /**
   * The waiting list. Re-read when the warehouse changes and after a
   * handover, because the counts are what the operator checks against the
   * pile in front of them — a stale «700 karobka» beside 300 boxes is worse
   * than no number. Aborted on switch for the same reason the box list is.
   */
  useEffect(() => {
    /**
     * CLEARED FIRST, and that is the fix for what shipped: the comment above
     * claimed the list was «aborted on switch for the same reason the box list
     * is», and `abort()` cancels the REQUEST while leaving the previous
     * warehouse's people rendered. So a failed refresh — `!res.ok` returned
     * silently, and a thrown fetch was swallowed as «aborted» — kept the OLD
     * warehouse's customers, their phone numbers and their box counts under
     * the NEW warehouse's heading. On this screen that is the worst shape a
     * bug can take: the operator reads a name off it and hands cargo over.
     *
     * `null` is «not loaded yet» and renders neither the list nor
     * «no cargo here» — the distinction the empty state needs.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParties(null);
    setPartiesMore(0);
    setUnclaimed([]);
    setPartiesFailed(null);
    if (!warehouseId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/issue/parties?warehouseId=${warehouseId}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          // The Kashgar round's rule (#846): «the server answered and refused»
          // is a different problem from «there is no network», and a warehouse
          // phone needs to be told which one it has.
          setPartiesFailed(`${res.status}`);
          return;
        }
        const data = (await res.json()) as {
          parties: IssueParty[];
          more: number;
          unclaimed: UnclaimedParty[];
        };
        setParties(data.parties);
        setPartiesMore(data.more);
        setUnclaimed(data.unclaimed);
      } catch (err) {
        // An abort is this effect's own cleanup and says nothing to anybody.
        if ((err as Error)?.name === 'AbortError') return;
        setPartiesFailed('offline');
      }
    })();
    return () => controller.abort();
  }, [warehouseId, doneHandover]);

  /**
   * A new client or a new counter starts clean — the selection, both ticks
   * and the last refusal belong to the previous pair. Nothing else clears
   * them: a refusal, an approval request or a refresh must never cost the
   * operator the scan (#463's rule — a form that can be refused holds its
   * inputs).
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(new Set());
    setDebtOk(false);
    setPriceOk(false);
    setError(null);
  }, [client?.id, warehouseId]);

  useEffect(() => {
    if (!client || !warehouseId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setList([]);
      setUnpriced([]);
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
            approval: ApprovalState | null;
            unpriced?: UnpricedHere[];
            compensated?: { receiptNumber: string }[];
            gate?: { state: 'on' | 'off' | 'invalid'; since: string | null };
          };
          setList(data.boxes);
          setDebtUsd(data.debtUsd);
          setDeferredUsd(data.deferredUsd ?? 0);
          setCanOverrideDebt(data.canOverrideDebt);
          setApproval(data.approval ?? null);
          setUnpriced(data.unpriced ?? []);
          setCompensated(data.compensated ?? []);
          setGate(data.gate ?? { state: 'off', since: null });
          // What is still here stays selected: a box handed over leaves the
          // list and the selection by the same rule, a refresh keeps the rest.
          const still = new Set(data.boxes.map((box) => box.boxId));
          setSelected((prev) => new Set([...prev].filter((id) => still.has(id))));
        }
      } catch {
        /* aborted */
      }
    })();
    return () => controller.abort();
  }, [client, warehouseId, doneHandover, refreshTick]);

  async function askApproval() {
    if (!client || asking) return;
    setAsking(true);
    const result = await requestIssueApprovalAction({ clientId: client.id, warehouseId });
    setAsking(false);
    if (!result.ok && result.error !== 'already_requested') {
      setError(
        result.error === 'nothing_to_approve'
          ? t('nothingToApprove')
          : result.error === 'already_approved'
            ? t('alreadyApproved')
            : tc('error'),
      );
    }
    setRefreshTick((n) => n + 1);
  }

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
        priceOk,
      });
      if (res.ok) {
        setDoneHandover(res.handoverId!);
        setPersonName('');
        setPersonPhone('');
        setDebtOk(false);
        setPriceOk(false);
      } else {
        // Every refusal is a sentence (#472): a raw code at a counter is a
        // call to the office.
        const words: Record<string, string> = {
          debt_block: t('debtBlocked'),
          debt_override_forbidden: t('debtNeedsManager'),
          price_block: t('priceBlocked'),
          price_elsewhere: t('priceElsewhereBlocked'),
          debt_price_block: t('debtPriceBlocked'),
          price_override_forbidden: t('priceNeedsManager'),
        };
        setError(words[res.error ?? ''] ?? tc('error'));
        // The permission on screen may be stale — re-read it, keeping the scan.
        setRefreshTick((n) => n + 1);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const lots = new Map<string, IssuableBox[]>();
  for (const box of list) lots.set(box.lotId, [...(lots.get(box.lotId) ?? []), box]);

  // 0104: the price question, asked the way the server asks it.
  const gatedIds = new Set(list.filter((box) => box.gated).map((box) => box.boxId));
  const selectedGated = [...selected].filter((id) => gatedIds.has(id));
  const gatedReceipts = unpriced.filter((row) => row.gatedHere > 0);
  const gatedCount = gatedReceipts.reduce((sum, row) => sum + row.gatedHere, 0);
  const oldReceipts = unpriced.filter((row) => row.gatedHere === 0 && !row.walkIn);
  const walkIns = unpriced.filter((row) => row.gatedHere === 0 && row.walkIn);
  const needDebt = blockingDebt > 0.009 && !debtOk;
  const needPrice = selectedGated.length > 0 && !priceOk;
  const covers = (question: { debtUsd: number | null; boxIds: string[] }) =>
    approval !== null && approvalCovers(approval, question);
  // What the confirm press needs a permission for, and whether the recorded
  // one answers it — the server re-checks every word of this.
  const pressCovered = covers({
    debtUsd: needDebt ? blockingDebt : null,
    boxIds: needPrice ? selectedGated : [],
  });
  // The strip asks about the whole counter: the selection when there is one,
  // every gated carton here when nothing is picked yet.
  const stripQuestion = {
    debtUsd: blockingDebt > 0.009 ? blockingDebt : null,
    boxIds: selectedGated.length ? selectedGated : [...gatedIds],
  };
  const showStrip = client !== null && !canOverrideDebt && (blockingDebt > 0.009 || gatedIds.size > 0);
  const money = (usd: number) => `$${usd.toFixed(2)}`;
  const untilText = (at: string | null) =>
    at
      ? new Date(at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—';
  const barTall = error !== null || (canOverrideDebt && blockingDebt > 0.009);

  return (
    <div className={`space-y-3 ${barTall ? 'pb-40' : 'pb-28'}`}>
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

      {/**
        * The waiting list — the owner's item 3. Only while no client is
        * chosen: once one is, the boxes below are what the operator is
        * working through and a list of other customers is noise on a
        * scanning screen.
        *
        * A CODE is the tap target, never the person, because everything after
        * this point is per code — the boxes, the debt, the manager's
        * permission and the act that gets signed. The person is the heading
        * that puts «yolchi's» two codes next to each other.
        */}
      {!client && (
        <section className="space-y-2" data-testid="issue-parties">
          <h2 className="text-xs font-bold uppercase text-ink-500">👥 {t('waitingHere')}</h2>
          {partiesFailed !== null && (
            <p className="card text-sm text-warn" data-testid="issue-parties-failed">
              ⚠️{' '}
              {partiesFailed === 'offline'
                ? t('partiesOffline')
                : t('partiesFailed', { code: partiesFailed })}
            </p>
          )}
          {partiesFailed === null && parties?.length === 0 && unclaimed.length === 0 && (
            <p className="card text-sm text-ink-500">{t('partiesEmpty')}</p>
          )}
          {(parties ?? []).map((party) => (
            <div
              key={party.personId ?? party.codes[0]!.clientId}
              className="card space-y-1.5 !p-3"
              data-testid="issue-party"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-semibold">{party.name}</span>
                {/* His 3.3a. The number is read by the person about to hand
                    the cargo over, and the list is built from what stands on
                    THIS shelf, so no other customer's phone is on screen. */}
                {party.phones.map((phone) => (
                  <a
                    key={phone}
                    href={`tel:${phone}`}
                    className="font-mono text-xs text-ink-700 underline decoration-dotted"
                  >
                    {phone}
                  </a>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {party.codes.map((code) => (
                  <button
                    key={code.clientId}
                    type="button"
                    data-testid="issue-party-code"
                    className="flex items-baseline gap-1.5 rounded-lg border border-line bg-surface-sunken px-2 py-1.5 text-left"
                    onClick={() => {
                      setClient({ id: code.clientId, clientCode: code.code, name: code.name });
                      setClientQuery('');
                      setDoneHandover(null);
                    }}
                  >
                    <span className="font-mono font-extrabold text-brand-700">{code.code}</span>
                    <span className="text-xs text-ink-600">{t('boxesN', { n: code.boxes })}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {partiesMore > 0 && (
            <p className="text-xs text-ink-500">{t('partiesMore', { n: partiesMore })}</p>
          )}

          {/**
            * Cargo whose owner is not known yet (his 3.2a). It is a LINK and
            * not a choice: there is no client to sign for it or to bill, so
            * the prixod is where somebody names one first.
            */}
          {unclaimed.length > 0 && (
            <>
              <h2 className="pt-1 text-xs font-bold uppercase text-ink-500">
                ❓ {t('unclaimedHere')}
              </h2>
              {unclaimed.map((row) => (
                <a
                  key={row.receiptId}
                  href={`/receipts/${row.receiptId}`}
                  className="card block space-y-1 !p-3"
                  data-testid="issue-unclaimed"
                >
                  {/* The marking WRAPS and is never truncated. It is the only
                      thing identifying this cargo, it is hand-written on the
                      carton, and his markings differ in the TAIL
                      («GS500MANIKEN-AL») — «GS500MA…» names nothing. Seen in
                      the round's own 360 px screenshot, not by a test. */}
                  <span className="block break-all font-mono font-bold">{row.marking}</span>
                  <span className="flex items-baseline gap-2 text-xs">
                    <span className="text-ink-600">{t('boxesN', { n: row.boxes })}</span>
                    <span className="text-brand-700 underline">{t('openReceipt')}</span>
                  </span>
                </a>
              ))}
            </>
          )}
        </section>
      )}

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
        </div>
      )}

      {/**
        * 0104, the owner's Q3b: «ruxsat berilmasa olib ketolmasin, taqiq
        * tursin». Cargo with no price, landed by one of our trucks after the
        * ban's instant, goes out only with a permission. In the page flow and
        * not in the fixed bar, so the words that explain the tick sit beside
        * it and a 360 px screen never hides them under the bar.
        */}
      {client && gatedReceipts.length > 0 && (
        <div className="rounded-lg border border-bad/30 bg-bad/10 p-3 text-sm" data-testid="issue-unpriced">
          <p className="font-bold text-bad">
            {t('unpricedBanner', { boxes: gatedCount, receipts: gatedReceipts.length })}
          </p>
          <ul className="mt-1 space-y-1">
            {gatedReceipts.slice(0, 5).map((row) => (
              <li key={row.receiptId}>
                <span className="font-mono text-xs">
                  {t('unpricedRow', {
                    number: row.number ?? '—',
                    truck: row.arrivalTrucks.map((truck) => truck.code).join(', ') || '—',
                    boxes: row.gatedHere,
                  })}
                </span>
                {row.elsewhere.length > 0 && (
                  <span className="block text-xs text-warn">
                    {t('unpricedElsewhere', {
                      codes: row.elsewhere.map((e) => e.code).join(', '),
                      usd: money(row.elsewhere.reduce((sum, e) => sum + e.usd, 0)),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-700">{t('unpricedRule')}</p>
          {canOverrideDebt && selectedGated.length > 0 && (
            <label className="mt-2 flex items-center gap-2 font-semibold text-bad">
              <input
                type="checkbox"
                className="h-5 w-5"
                data-testid="issue-price-ok"
                checked={priceOk}
                onChange={(e) => setPriceOk(e.target.checked)}
              />
              {t('priceOk')}
            </label>
          )}
        </div>
      )}
      {/* 0105: a carton found after its loss was compensated. A warning and
          not a gate — the cargo is the client's; the money is the
          accountant's, who has been told. No amount on a warehouse screen. */}
      {client && compensated.length > 0 && (
        <p
          className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm font-semibold text-warn"
          data-testid="issue-compensated"
        >
          {t('compensatedFound', { receipts: compensated.map((row) => row.receiptNumber).join(', ') })}
        </p>
      )}
      {client && gate.state === 'invalid' && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm font-semibold text-warn">
          ⚠️ {t('gateInvalid')}
        </p>
      )}
      {client && gate.state === 'on' && oldReceipts.length > 0 && (
        <p className="text-xs text-ink-500" data-testid="issue-unpriced-old">
          {t('unpricedOld', { date: gate.since ? new Date(gate.since).toLocaleDateString('en-GB') : '—' })}
        </p>
      )}
      {client &&
        walkIns.map((row) => (
          <p key={row.receiptId} className="text-xs text-ink-500">
            {t('unpricedWalkIn', { number: row.number ?? '—' })}
          </p>
        ))}

      {/* Phase 6: the escalation lives ON the screen, not in a phone call.
          Ask → the deciders' Telegram buzzes → the answer shows here, with its
          expiry. ONE strip for both questions, because one approval answers
          both; «granted» only when it covers what is asked NOW. */}
      {showStrip && (
        <div className="rounded-lg border border-line p-3 text-sm" data-testid="issue-permission">
          {approval?.status === 'approved' && covers(stripQuestion) ? (
            <p className="font-semibold text-good" data-testid="approval-granted">
              ✅ {t('debtApprovalGranted', { until: untilText(approval.expiresAt) })}
            </p>
          ) : approval?.status === 'pending' ? (
            <p className="font-semibold text-warn" data-testid="approval-pending">
              ⏳ {t('debtApprovalPending')}
            </p>
          ) : (
            <>
              <p className="text-bad">
                {approval?.status === 'approved'
                  ? t('approvalStale')
                  : blockingDebt > 0.009
                    ? t('debtNeedsManager')
                    : t('priceNeedsManager')}
              </p>
              <button
                type="button"
                data-testid="ask-approval"
                onClick={() => void askApproval()}
                disabled={asking}
                className="btn-secondary mt-2 w-full disabled:opacity-50"
              >
                {asking ? tc('loading') : `🔐 ${t('debtAskApproval')}`}
              </button>
            </>
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
              const lotGated = lotBoxes.some((b) => b.gated);
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
                    {lotGated && (
                      <span className="chip shrink-0 bg-bad/10 text-xs text-bad" data-testid="lot-unpriced">
                        {t('lotUnpriced')}
                      </span>
                    )}
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

      {error && !client && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {error}
        </p>
      )}

      {client && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          <div className="mx-auto max-w-4xl space-y-2 px-4 py-2.5">
            {/* The refusal sits IN the bar, above the button it answers — as a
                last in-flow paragraph it fell under this fixed bar at 360 px. */}
            {error && (
              <p role="alert" className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad" data-testid="issue-error">
                {error}
              </p>
            )}
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
                // A recorded approval that COVERS the press opens both gates
                // without the ticks; the server re-checks and CONSUMES it.
                ((needDebt || needPrice) && !pressCovered)
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
