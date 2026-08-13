'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { Scanner } from '@/components/scan/scanner';
import { armScanAudio, scanFeedback } from '@/components/scan/feedback';
import {
  boxesForScan,
  enqueueScan,
  flushScans,
  isSendableCode,
  pendingScans,
  scanNeedsConfirm,
  scanWasRecorded,
  type SyncAck,
} from '@/offline/scan-outbox';
import { codeIdentity } from '@/modules/wms/labels/code-identity';

interface PlannedBox {
  shortCode: string;
  status: string;
  letter: string | null;
  lotId: string;
  productNameZh: string;
  clientCode: string | null;
  marking: string | null;
  crateCode?: string | null;
  /** Numeric strings from the API — a lot's boxes are identical. */
  perBoxKg?: string | null;
  perBoxM3?: string | null;
}
interface Snapshot {
  batch: { id: string; code: string; status: string };
  /** True when the batch has NO plan (quick batch). */
  quick?: boolean;
  boxes: PlannedBox[];
  /** Quick batch only: the origin warehouse's loadable stock (tap-to-pick). */
  available?: PlannedBox[];
  crates: { code: string; boxShortCodes: string[] }[];
}

/**
 * Plan-less (quick) batch? The server flag is the truth; the box-count
 * fallback covers stale cached snapshots — but ONLY before anything was
 * loaded, since loaded boxes become members and would flip the mode.
 */
function isQuick(snapshot: Snapshot): boolean {
  return snapshot.quick ?? snapshot.boxes.length === 0;
}

/**
 * W4 loading mode: camera/HID scanning with instant local verdicts
 * (<300 ms), offline outbox with visible sync state, running counter,
 * not-on-plan red flow (edge case 6) and sticker-lost manual entry
 * (edge case 3).
 */
export function LoadingScreen({ batchId }: { batchId: string }) {
  const t = useTranslations('loading');
  const tc = useTranslations('common');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** Why there is no snapshot yet — `null` while it is simply still loading. */
  const [snapError, setSnapError] = useState<'forbidden' | 'offline' | null>(null);
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState<'ok' | 'dup' | 'bad' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState<string | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [manualQuery, setManualQuery] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Which codes each queued scan marked on screen.
   *
   * The counter moves the instant a box is scanned — that responsiveness is
   * the point of the screen — but the SERVER decides whether anything was
   * recorded. Without this map a refusal cannot be undone, and the loader is
   * left looking at a number that says the box is on the truck when it is not.
   */
  const marked = useRef<Map<string, string[]>>(new Map());

  const cacheKey = `gsr-load-${batchId}`;

  const applySnapshot = useCallback((data: Snapshot) => {
    setSnapshot(data);
    setLoaded(
      new Set(
        data.boxes
          .filter((b) => b.status === 'loading' || b.status === 'in_transit')
          .map((b) => b.shortCode),
      ),
    );
  }, []);

  // Snapshot: network-first, localStorage fallback for offline reopen.
  useEffect(() => {
    void (async () => {
      let failure: 'forbidden' | 'offline' = 'offline';
      try {
        const res = await fetch(`/api/batches/${batchId}/planned`);
        if (res.ok) {
          const data = (await res.json()) as Snapshot;
          localStorage.setItem(cacheKey, JSON.stringify(data));
          applySnapshot(data);
          setSnapError(null);
          return;
        }
        // A refusal is not a bad connection, and the screen used to say
        // neither: it sat on the word «Yuklanmoqda…» for ever, with no
        // camera under it, which is indistinguishable from a broken scanner.
        if (res.status === 401 || res.status === 403) failure = 'forbidden';
      } catch {
        /* genuinely offline */
      }
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        applySnapshot(JSON.parse(cached) as Snapshot);
        return;
      }
      setSnapError(failure);
    })();
  }, [batchId, cacheKey, applySnapshot]);

  const refreshPending = useCallback(async () => {
    setPending((await pendingScans()).length);
  }, []);

  /**
   * What the server actually did with each scan.
   *
   * `not_on_plan` had no branch here at all, and that was the whole bug the
   * warehouse hit: the box was counted on screen, beeped green, queued,
   * refused by the server, dropped from the outbox — and re-scanning answered
   * "already scanned", so the loader could not even retry. Boxes went onto the
   * truck that the manifest, the customs invoice and the cost allocation knew
   * nothing about.
   *
   * The rule now: anything that is not `ok` / `duplicate` / `auto_transfer`
   * recorded NOTHING, so its marks come back off the counter, the screen goes
   * red, and `not_on_plan` re-opens the confirm dialog — which is the door
   * that was already built for exactly this case and could never be reached.
   */
  const handleAcks = useCallback((acks: SyncAck[]) => {
    const rollback: string[] = [];
    const leftover: { code: string; boxes: string[] }[] = [];
    let reopen: string | null = null;

    for (const ack of acks) {
      const codes = marked.current.get(ack.clientEventUuid) ?? [];
      marked.current.delete(ack.clientEventUuid);
      if (scanWasRecorded(ack.result)) {
        // The crate went on the truck, but it held boxes this plan does not
        // cover. They are NOT loaded, and the loader is the only person who
        // can decide — standing in front of the open crate.
        if (ack.unplanned?.length && ack.scannedCode) {
          leftover.push({ code: ack.scannedCode, boxes: ack.unplanned });
        }
        continue;
      }
      rollback.push(...codes);
      if (scanNeedsConfirm(ack.result)) {
        // The scanned code, not the member boxes: the confirm dialog re-sends
        // the same scan with addedOnSpot, and a crate must go back as a crate.
        reopen = ack.scannedCode ?? codes[0] ?? null;
        setToast(`⚠️ ${t('notOnPlan')}`);
      } else {
        setToast(`❌ ${ack.detail ?? ack.result}`);
      }
    }

    if (rollback.length > 0) {
      setLoaded((prev) => {
        const next = new Set(prev);
        for (const code of rollback) next.delete(code);
        return next;
      });
      feedback('bad');
    }
    if (reopen) {
      setConfirmCode(reopen);
      setConfirmReason('');
    }
    // Only when nothing worse is on screen: a refusal is the louder problem.
    if (!reopen && leftover.length > 0) {
      const first = leftover[0]!;
      setToast(`🧰 ${first.code}: ${first.boxes.length} ${t('notOnPlanInCrate')}`);
      setConfirmCode(first.code);
      setConfirmReason('');
    }
  }, [t]);

  /**
   * The snapshot is the whole truck, and it was being re-downloaded after
   * EVERY scan.
   *
   * On a planned batch that is every member box; on a quick batch it also
   * carries the origin warehouse's loadable stock — 1,500 rows, ~300 KB, over
   * warehouse wifi in Yiwu, once per box. The scan's own ack already says
   * what the server did, so the only thing the refresh adds is OTHER phones'
   * work, which nobody needs within the same second.
   *
   * So it runs on the 15-second tick and not on the scan. `sync` is the tick
   * asking for it; a scan-driven flush passes false and sends only the queue.
   */
  const flush = useCallback(
    async ({ sync = false }: { sync?: boolean } = {}) => {
      try {
        const { acks, discarded, refusedForbidden } = await flushScans();
        handleAcks(acks);
        if (discarded.length > 0) {
          setToast(`❌ ${t('serverRefused', { n: discarded.length })}`);
          setLoaded((prev) => {
            const next = new Set(prev);
            for (const row of discarded) next.delete(row.code);
            return next;
          });
        }
        if (refusedForbidden) setToast(`🚫 ${t('notYourTruck')}`);
        setOnline(true);
        if (sync) {
          try {
            const res = await fetch(`/api/batches/${batchId}/planned`);
            if (res.ok) {
              const data = (await res.json()) as Snapshot;
              localStorage.setItem(cacheKey, JSON.stringify(data));
              setSnapshot(data);
              setLoaded((prev) => {
                const next = new Set(prev);
                for (const b of data.boxes) {
                  if (b.status === 'loading' || b.status === 'in_transit') next.add(b.shortCode);
                }
                return next;
              });
            }
          } catch {
            /* snapshot refresh is best-effort */
          }
        }
      } catch {
        setOnline(false);
      }
      await refreshPending();
    },
    [handleAcks, refreshPending, batchId, cacheKey, t],
  );

  /**
   * One flush in flight at a time, with a short trailing window.
   *
   * A loader working a pallet scans three boxes a second and each one fired
   * its own POST. The outbox is a QUEUE — one request carries whatever has
   * accumulated — so coalescing costs nothing but a few hundred milliseconds
   * before the server confirms, and the screen has been optimistic-with-
   * rollback since #223 precisely so it does not have to wait for that.
   */
  /**
   * Coalesced, NOT delayed.
   *
   * A timed debounce was the obvious version and it was wrong: the loader
   * scans the last box and taps "finish loading" in the same second, and a
   * scan still sitting in the outbox is a box left off the truck. Three e2e
   * specs caught it — m3 departed a batch whose final scan had not landed,
   * and m4/m5/m9 then had nothing to unload, price or hand over.
   *
   * So a scan sends immediately when nothing is in flight, and scans that
   * arrive DURING a request ride one follow-up instead of each starting their
   * own. All of the burst saving, none of the latency.
   */
  const flushing = useRef(false);
  /** Set while a flush is in flight and more scans arrived behind it. */
  const again = useRef(false);
  const flushSoon = useCallback(() => {
    if (flushing.current) {
      again.current = true;
      return;
    }
    flushing.current = true;
    void flush().finally(() => {
      flushing.current = false;
      // Scans queued while that request was in the air ride one follow-up
      // rather than each having started a request of their own.
      if (again.current) {
        again.current = false;
        flushSoon();
      }
    });
  }, [flush]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flush({ sync: true });
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    void flush({ sync: true });
    const interval = setInterval(() => void flush({ sync: true }), 15_000);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(interval);
    };
  }, [flush]);

  // iOS unlocks the beep only inside a user gesture — arm on mount.
  useEffect(() => armScanAudio(), []);

  function feedback(kind: 'ok' | 'dup' | 'bad') {
    setFlash(kind);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 450);
    scanFeedback(kind);
  }

  async function accept(codes: string[], scan: { code: string; method: 'qr' | 'manual'; manualReason?: string; addedOnSpot?: boolean; addedReason?: string }) {
    setLoaded((prev) => {
      const next = new Set(prev);
      for (const c of codes) next.add(c);
      return next;
    });
    feedback('ok');
    const clientEventUuid = uuidv4();
    marked.current.set(clientEventUuid, codes);
    await enqueueScan({
      clientEventUuid,
      batchId,
      code: scan.code,
      method: scan.method,
      manualReason: scan.manualReason,
      addedOnSpot: scan.addedOnSpot ?? false,
      addedReason: scan.addedReason,
      scannedAt: new Date().toISOString(),
    });
    await refreshPending();
    flushSoon();
  }

  function onCode(code: string, method: 'qr' | 'manual' = 'qr', manualReason?: string) {
    if (!snapshot) return;
    // The supplier's own QR on a Chinese carton is a URL, and the server can
    // only parse a code of 3-40 characters — it refuses the whole request
    // body, which used to stop every good scan behind it from ever leaving
    // the phone. Refused here, out loud, one scan at a time.
    if (!isSendableCode(code)) {
      feedback('bad');
      setToast(`❓ ${t('foreignCode')}`);
      return;
    }
    const onTruck = new Set(snapshot.boxes.map((b) => b.shortCode));
    const quick = isQuick(snapshot); // quick batch: no plan, no ceremony

    /**
     * A crate is judged on the boxes of it that belong to THIS truck.
     *
     * The snapshot ships every box physically inside the crate, and a crate
     * collects strays — one more fitted in after the plan was approved, a lot
     * the planner did not list. Requiring all of them stopped the warehouse
     * mid-load: the operator was holding a crate the plan asked for and the
     * phone answered "not on plan", the red confirm covered the screen, and
     * the scanner under it went dead.
     *
     * A crate with SOME of its boxes on the plan is this truck's crate: those
     * load, and the server names the rest so somebody decides about them. A
     * crate with NONE is a stranger, and that is what the red screen is for.
     */
    const memberCodes = boxesForScan(code, snapshot.crates, onTruck, quick);

    if (memberCodes.length > 0 && memberCodes.every((c) => loaded.has(c))) {
      feedback('dup');
      setToast(`🔁 ${t('alreadyScanned')} ${code}`);
      return;
    }
    if (quick || (memberCodes.length > 0 && memberCodes.every((c) => onTruck.has(c)))) {
      void accept(memberCodes, { code, method, manualReason });
      return;
    }
    // Nothing on this batch's plan — red confirm flow.
    feedback('bad');
    setConfirmCode(code);
    setConfirmReason('');
  }

  /** Every box the operator would be adding by confirming `code`. */
  function confirmMembers(code: string): string[] {
    const crate = snapshot?.crates.find((c) => c.code === code);
    return crate && crate.boxShortCodes.length > 0 ? crate.boxShortCodes : [code];
  }

  if (!snapshot) {
    if (!snapError) return <p className="p-4 text-ink-500">{tc('loading')}</p>;
    return (
      <div className="card space-y-3 !p-4 text-center" data-testid="snapshot-error">
        <p className="font-semibold text-bad">
          {snapError === 'forbidden' ? tc('scanTruckForbidden') : tc('scanSnapshotOffline')}
        </p>
        <button type="button" className="btn-primary w-full" onClick={() => location.reload()}>
          {tc('retry')}
        </button>
      </div>
    );
  }

  const total = snapshot.boxes.length;
  // Crated boxes group under their CRATE (owner's request: the operator must
  // see WHAT sits inside and scan the crate, not hunt loose boxes).
  const byLot = new Map<
    string,
    {
      label: string;
      /** The claimed client's code when the box carries a marking (round 100). */
      sub: string | null;
      product: string;
      total: number;
      done: number;
      crate: boolean;
      /** The whole row's weight and volume, not the part already scanned. */
      kg: number;
      m3: number;
      /** Boxes carrying a weight — the divisor of the per-box figure. */
      weighed: number;
    }
  >();
  for (const box of snapshot.boxes) {
    const identity = codeIdentity(box.marking, box.clientCode);
    const codeLabel = `${identity.main}-${box.letter}`;
    const key = box.crateCode ? `crate:${box.crateCode}` : box.lotId;
    const entry =
      byLot.get(key) ??
      (box.crateCode
        ? {
            label: `🧰 ${box.crateCode}`,
            sub: null,
            product: '',
            total: 0,
            done: 0,
            crate: true,
            kg: 0,
            m3: 0,
            weighed: 0,
          }
        : {
            label: codeLabel,
            sub: identity.sub,
            product: box.productNameZh,
            total: 0,
            done: 0,
            crate: false,
            kg: 0,
            m3: 0,
            weighed: 0,
          });
    const boxKg = Number(box.perBoxKg ?? 0);
    entry.kg += boxKg;
    entry.m3 += Number(box.perBoxM3 ?? 0);
    if (boxKg > 0) entry.weighed += 1;
    if (entry.crate) {
      // Contents summary: "GS777-A 化妆品 · GS777-B 键盘 …"
      const piece = `${codeLabel} ${box.productNameZh}`;
      if (!entry.product.includes(piece)) {
        entry.product = entry.product ? `${entry.product} · ${piece}` : piece;
      }
    }
    entry.total += 1;
    if (loaded.has(box.shortCode)) entry.done += 1;
    byLot.set(key, entry);
  }
  const doneCount = snapshot.boxes.filter((b) => loaded.has(b.shortCode)).length;

  // What is actually on the truck so far (owner: "yuklash paytida umumiy
  // kubi, kilosi va kg/m³ ko'rinsa yaxshi bo'lardi"). A quick batch has no
  // plan, so its loaded boxes come from the origin stock list instead.
  const weighed = new Map<string, PlannedBox>();
  for (const box of [...snapshot.boxes, ...(snapshot.available ?? [])]) {
    if (!weighed.has(box.shortCode)) weighed.set(box.shortCode, box);
  }
  let loadedKg = 0;
  let loadedM3 = 0;
  // Boxes that actually carry a weight. The average is theirs and not every
  // loaded box's: an unweighed box adds 0 kg, so counting it in the divisor
  // would report a lighter average the more of them there are. It is also the
  // only count a QUICK batch has — `doneCount` reads the plan, which a quick
  // batch does not have, so the average would vanish on exactly the ad-hoc
  // load this line is most useful for.
  let loadedWeighed = 0;
  for (const code of loaded) {
    const box = weighed.get(code);
    if (!box) continue;
    const kg = Number(box.perBoxKg ?? 0);
    loadedKg += kg;
    loadedM3 += Number(box.perBoxM3 ?? 0);
    if (kg > 0) loadedWeighed += 1;
  }
  const loadedDensity = loadedM3 > 0.0005 ? Math.round(loadedKg / loadedM3) : null;
  const loadedAvgKg = loadedWeighed > 0 ? Math.round(loadedKg / loadedWeighed) : null;
  const unscanned = snapshot.boxes.filter((b) => !loaded.has(b.shortCode));
  // Quick batch: no plan, so "sticker lost" picks from the origin WH stock
  // instead of the (empty) plan list (owner: tap the box, don't type codes).
  const quickBatch = isQuick(snapshot);
  const q = manualQuery.trim().toUpperCase();
  const basePick = (quickBatch ? (snapshot.available ?? []) : unscanned).filter(
    (b) => !loaded.has(b.shortCode),
  );
  const pickList = basePick.filter(
      (b) =>
        !q ||
        b.shortCode.includes(q) ||
        (b.clientCode ?? '').toUpperCase().includes(q) ||
        (b.marking ?? '').toUpperCase().includes(q) ||
        // Both compositions: the operator may type what the BOX says
        // (marking-letter) or what the client's papers say (code-letter).
        `${b.marking ?? ''}-${b.letter ?? ''}`.toUpperCase().includes(q) ||
        `${b.clientCode ?? ''}-${b.letter ?? ''}`.toUpperCase().includes(q) ||
        b.productNameZh.toUpperCase().includes(q),
    );

  return (
    <div
      className={`space-y-3 pb-6 transition-colors ${
        flash === 'ok' ? 'bg-good/15' : flash ? 'bg-bad/15' : ''
      }`}
    >
      <div
        className={`rounded-lg p-2 text-center text-sm font-semibold ${
          online ? (pending > 0 ? 'bg-orange-100 text-orange-800' : 'bg-good/10 text-good') : 'bg-bad/15 text-bad'
        }`}
        data-testid="sync-banner"
      >
        {online ? (pending > 0 ? `🔄 ${t('syncing', { n: pending })}` : `✅ ${t('online')}`) : `📴 ${t('offline', { n: pending })}`}
      </div>

      <Scanner active={confirmCode === null} onCode={(code) => onCode(code)} />

      <p className="text-center font-mono text-4xl font-extrabold" data-testid="load-counter">
        {total === 0 ? loaded.size : doneCount}
        {total > 0 && <span className="text-ink-400">/{total}</span>} 📦
      </p>

      {/* Weight and volume on board, updated with every scan — a truck is
          filled by kg and m³, and until now the loader could only count
          boxes and hope. */}
      {/* `flex-wrap`, and each separator lives INSIDE the span that follows
          it (round 78's rule) so a wrap can never leave a lone «·» hanging at
          the end of a line. The line was one row of four un-wrappable spans:
          measured at 360 it fits a 2,800 kg truck and overflows a 12,500 kg
          one — and a row wider than the viewport makes mobile Chrome rescale
          the WHOLE page (#400), which on a scanning screen moves every tap
          target. A fourth number was the moment that stopped being theory. */}
      <div
        data-testid="load-totals"
        className="flex flex-wrap items-baseline justify-center gap-x-3 text-center font-mono text-sm font-bold"
      >
        <span>{Math.round(loadedKg)} kg</span>
        <span>
          <span className="text-ink-400">· </span>
          {Math.round(loadedM3 * 100) / 100} m³
        </span>
        {loadedDensity !== null && (
          <span className="text-ink-700">
            <span className="text-ink-400">· </span>
            {loadedDensity} kg/m³
          </span>
        )}
        {/* The average box on this truck. Density says how the truck fills;
            this says how heavy the thing in front of you is, which is the
            question the person loading it is asking. */}
        {loadedAvgKg !== null && (
          <span className="text-ink-700">
            <span className="text-ink-400">· </span>ø{loadedAvgKg} kg
          </span>
        )}
        {/* The average box on this truck. Density says how the truck fills;
            this says how heavy the thing in front of you is, which is the
            question the person loading it is asking. */}
      </div>

      {/* space-y-2, not the 1 it was: a row is TWO lines now, and at the old
          spacing the gap inside a row equalled the gap between rows, so the
          grey weights read as if they belonged to the code underneath them.
          Four pixels a row, and the eye groups them correctly. */}
      <div className="card space-y-2 !p-3">
        {[...byLot.values()].map((lot) => (
          <div key={lot.label}>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono font-extrabold text-brand-700">
                {lot.label}
                {lot.sub && (
                  <span className="block font-sans text-2xs font-normal text-ink-500">
                    {lot.sub}
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-700">{lot.product}</span>
              <span className={`font-semibold ${lot.done === lot.total ? 'text-good' : ''}`}>
                {lot.done}/{lot.total}
              </span>
            </div>
            {/* A SECOND line, not a wider first one. Measured at 360: the row is
                302 px — code 84, product 177 (already truncating), count 25 —
                so three more numbers would leave the product name 43 px and
                the crate row nothing at all. The per-box weight is the number
                a loader standing at the truck actually acts on: 24 kg is
                carried by hand, 80 kg needs the forklift. */}
            {lot.weighed > 0 && (
              <p className="font-mono text-xs text-ink-500" data-testid="lot-weights">
                {Math.round(lot.kg)} kg · {Math.round(lot.m3 * 100) / 100} m³ ·{' '}
                {Math.round(lot.kg / lot.weighed)} {t('kgPerBox')}
              </p>
            )}
            {/* A SECOND line, not a wider first one. Measured at 360: the row is
                302 px — code 84, product 177 (already truncating), count 25 —
                so three more numbers would leave the product name 43 px and
                the crate row nothing at all. The per-box weight is the number
                a loader standing at the truck actually acts on: 24 kg is
                carried by hand, 80 kg needs the forklift. */}
          </div>
        ))}
      </div>

      <button type="button" className="btn-secondary w-full" onClick={() => setManualOpen(true)}>
        {quickBatch ? `📦 ${t('pickFromStock')}` : `🏷 ${t('stickerLost')}`}
      </button>

      {toast && (
        <button type="button" className="w-full rounded-lg bg-gray-800 p-2 text-sm font-semibold text-white" onClick={() => setToast(null)}>
          {toast}
        </button>
      )}

      {/* Not-on-plan red confirm */}
      {confirmCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-red-700/95 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-surface-raised p-4">
            <p className="text-center text-3xl">🚨</p>
            <p className="text-center font-bold">{t('notOnPlan')}</p>
            <p className="text-center font-mono text-lg font-extrabold">{confirmCode}</p>
            <input
              data-testid="onspot-reason"
              className="input"
              placeholder={t('reasonRequired')}
              value={confirmReason}
              onChange={(e) => setConfirmReason(e.target.value)}
            />
            <button
              type="button"
              data-testid="onspot-confirm"
              className="btn-danger w-full disabled:opacity-50"
              disabled={confirmReason.trim().length < 3}
              onClick={() => {
                // A CRATE marks its member boxes, not its own code — nothing
                // on the counter is keyed by a crate code, so confirming one
                // used to leave the number standing still while the server
                // loaded it.
                void accept(confirmMembers(confirmCode), {
                  code: confirmCode,
                  method: 'qr',
                  addedOnSpot: true,
                  addedReason: confirmReason,
                });
                setConfirmCode(null);
              }}
            >
              ⚠️ {t('loadAnyway')}
            </button>
            <button type="button" className="btn-secondary w-full" onClick={() => setConfirmCode(null)}>
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Sticker-lost: unscanned list + manual code entry */}
      {manualOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={() => setManualOpen(false)}>
          <div className="max-h-[80vh] w-full max-w-md space-y-2 overflow-y-auto rounded-t-2xl bg-surface-raised p-4" onClick={(e) => e.stopPropagation()}>
            <p className="font-bold">🏷 {t('stickerLostHint')}</p>
            <div className="flex gap-2">
              <input
                data-testid="manual-code"
                autoFocus
                autoCapitalize="characters"
                className="input flex-1 font-mono uppercase"
                placeholder="YW26-000123"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value.toUpperCase())}
              />
              <button
                type="button"
                data-testid="manual-submit"
                className="btn-primary px-4"
                onClick={() => {
                  if (manualCode.trim().length >= 4) {
                    onCode(manualCode.trim(), 'manual', 'sticker_lost');
                    setManualCode('');
                    setManualOpen(false);
                  }
                }}
              >
                ✓
              </button>
            </div>
            <p className="text-xs font-semibold text-ink-500">
              {quickBatch ? t('stockList') : t('unscannedList')}
            </p>
            {basePick.length > 8 && (
              <input
                className="input"
                value={manualQuery}
                onChange={(e) => setManualQuery(e.target.value)}
                placeholder={t('pickSearch')}
                autoComplete="off"
              />
            )}
            {pickList.slice(0, 80).map((box) => (
              <button
                key={box.shortCode}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg border border-line p-2 text-left text-sm hover:bg-surface-sunken"
                onClick={() => {
                  onCode(box.shortCode, 'manual', 'sticker_lost');
                  // Quick batch: stay open — the operator picks several boxes
                  // in a row; loaded ones drop off the list immediately.
                  if (!quickBatch) setManualOpen(false);
                }}
              >
                <span className="font-mono font-bold">{box.shortCode}</span>
                <span className="font-mono font-extrabold text-brand-700">
                  {codeIdentity(box.marking, box.clientCode).main}-{box.letter}
                </span>
                {box.crateCode && (
                  <span className="whitespace-nowrap rounded bg-warn/15 px-1.5 text-xs font-semibold text-warn">
                    🧰 {box.crateCode}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-ink-500">{box.productNameZh}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
