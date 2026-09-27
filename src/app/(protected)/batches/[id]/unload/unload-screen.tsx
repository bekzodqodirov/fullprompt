'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { Scanner } from '@/components/scan/scanner';
import { armScanAudio, scanFeedback } from '@/components/scan/feedback';
import {
  enqueueScan,
  flushScans,
  isSendableCode,
  pendingScans,
  type SyncAck,
} from '@/offline/scan-outbox';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { codesToUnmark } from '@/offline/ack-verdict';
import { countOnlyLotOf, type CountOnlyLot } from '@/offline/count-only';
import { isScanRefusal, type ScanRefusal } from '@/offline/scan-refusal';
import { BarcodeIdentify, type IdentifiedLot } from '@/components/barcode-identify';
import { lotsForBarcode } from '@/modules/wms/receipts/factory-barcode';
import { isOwnCodeShape, looksLikeRetailBarcode } from '@/offline/code-shape';

interface MemberBox {
  shortCode: string;
  status: string;
  letter: string | null;
  lotId: string;
  productNameZh: string;
  clientCode: string | null;
  marking: string | null;
  crateCode?: string | null;
}
interface Snapshot {
  batch: { id: string; code: string; status: string };
  boxes: MemberBox[];
  crates: { code: string; boxShortCodes: string[] }[];
  /** Lots the office counts on this truck (0112). Absent from a cached old snapshot. */
  countOnly?: CountOnlyLot[];
  /** The count-only list reached its cap (review phone-3) — absent from an old snapshot. */
  countOnlyCapped?: boolean;
  /** Lots with a factory barcode (0112) — absent from an old cached snapshot. */
  lotBarcodes?: { lotId: string; key: string }[];
}

/**
 * W5 unload mode (spec 6.5): scan everything off the truck. On-manifest →
 * stock here; a known box that is NOT on the manifest is auto-transferred
 * (orange toast, logist alerted — edge case 4, reality wins); unknown QR →
 * red toast with a link to the unclaimed intake. Fully offline-capable.
 */
export function UnloadScreen({ batchId, countHref }: { batchId: string; countHref?: string }) {
  const t = useTranslations('unloading');
  const to = useTranslations('ofis');
  const tc = useTranslations('common');
  const tr = useTranslations('scanRefusal');
  const tca = useTranslations('countAccept');
  const tcount = useTranslations('countLoad');
  /**
   * The phone's refusal of a count-only lot, in words (0112): a literal
   * switch, so every key is one the bundles can see (#163).
   */
  const refusalText = useCallback(
    (detail: ScanRefusal, lot: string) => {
      switch (detail) {
        case 'lot_counted':
          return tr('lot_counted', { lot });
        case 'qr_less_count_only':
          return tr('qr_less_count_only', { lot });
        case 'reserved_reason':
          return tr('reserved_reason');
      }
    },
    [tr],
  );
  /** The latest snapshot for the ack handler, which outlives a render. */
  const snapRef = useRef<Snapshot | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** Why there is no snapshot yet — `null` while it is simply still loading. */
  const [snapError, setSnapError] = useState<
    { kind: 'forbidden' | 'offline' | 'server'; status?: number } | null
  >(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<string[]>([]);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState<'ok' | 'dup' | 'bad' | null>(null);
  const [toast, setToast] = useState<{ text: string; intake?: boolean } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  /** A factory barcode just read (0112, Q10 c) — the identify sheet is open. */
  const [identify, setIdentify] = useState<{ code: string; lotIds: string[] } | null>(null);
  /** «🏭 Zavod kodi»: the camera reads ONE retail barcode, then goes back to QR. */
  const [scanMode, setScanMode] = useState<'qr' | 'retail'>('qr');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheKey = `gsr-unload-${batchId}`;
  /**
   * The snapshot's version (round 110, the loading screen's twin). Kashgar
   * unloads the Chinese trucks, so this screen sits on the same slow link and
   * re-read the same whole manifest every 15 seconds.
   */
  const snapEtag = useRef<string | null>(null);

  const applySnapshot = useCallback((data: Snapshot) => {
    snapRef.current = data;
    setSnapshot(data);
    // "Accepted here" is "no longer in transit" — NOT "in_stock". A customs or
    // distribution destination lands cargo straight in ready_for_pickup, and
    // matching on in_stock alone left the counter at 0 there for ever.
    setDone(new Set(data.boxes.filter((b) => b.status !== 'in_transit').map((b) => b.shortCode)));
  }, []);

  useEffect(() => {
    void (async () => {
      let failure: { kind: 'forbidden' | 'offline' | 'server'; status?: number } = {
        kind: 'offline',
      };
      try {
        const res = await fetch(`/api/batches/${batchId}/planned`);
        if (res.ok) {
          const data = (await res.json()) as Snapshot;
          snapEtag.current = res.headers.get('etag');
          localStorage.setItem(cacheKey, JSON.stringify(data));
          applySnapshot(data);
          setSnapError(null);
          return;
        }
        // A refusal is not a bad connection, and the screen used to say
        // neither: it sat on the word «Yuklanmoqda…» for ever, with no
        // camera under it, which is indistinguishable from a broken scanner.
        /*
         * The server ANSWERED — with a refusal or an error — and that is not
         * «нет связи». The Kashgar report (owner, 2026-08-26) arrived as a
         * screenshot of this exact sentence, and the sentence could not say
         * whether the phone never reached the server or the server answered
         * 500: the words are the diagnosis, so they must name the class.
         */
        failure =
          res.status === 401 || res.status === 403
            ? { kind: 'forbidden' }
            : { kind: 'server', status: res.status };
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

  const handleAcks = useCallback(
    (acks: SyncAck[]) => {
      /**
       * A scan the server REFUSED must stop being green.
       *
       * The counter and the lot lines are driven by `done`, which the screen
       * fills the moment a code is scanned — right, because the phone is
       * meant to work with no network. What was missing is the other half:
       * every path that puts a code in has to have a path that takes it back
       * out. A queue flushed after the logist pressed «Tushirish tugadi»
       * comes back `rejected / batch_not_unloading` for EVERY row, and the
       * screen went on reading 150/150 with every line green while those 150
       * cartons stood in the warehouse recorded as missing in transit. One
       * toast (a single slot, overwritten by the next) was the whole of the
       * telling.
       */
      for (const ack of acks) {
        if (ack.result === 'auto_transfer') {
          setToast({
            text: `📦❗ ${t('autoTransferred')} ${ack.boxes?.map((b) => b.shortCode).join(', ') ?? ''}`,
          });
        } else if (ack.result === 'unknown_code') {
          setToast({ text: `❓ ${t('unknownCode')}`, intake: true });
        } else if (ack.result === 'rejected') {
          if (isScanRefusal(ack.detail)) {
            // A lot the office counts: said by NAME, the server's words and
            // the phone's own being the same sentence (0112).
            const snap = snapRef.current;
            const code = ack.scannedCode ?? '';
            const lot =
              countOnlyLotOf(code, snap?.boxes ?? [], snap?.countOnly)?.label ??
              lotLabelOf(snap?.boxes.find((b) => b.shortCode.toUpperCase() === code.toUpperCase())) ??
              code;
            setToast({ text: `❌ ${refusalText(ack.detail, lot)}` });
          } else {
            setToast({ text: `❌ ${ack.detail ?? 'rejected'}` });
          }
        }
      }
      const refused = codesToUnmark(acks);
      if (refused.length) {
        setDone((prev) => {
          const next = new Set(prev);
          for (const code of refused) next.delete(code);
          return next;
        });
        // Counted, because one toast cannot report a hundred and fifty — but
        // a count-only lot's refusal is already a sentence naming the lot,
        // and a bare «N refused» over it would hide what to do.
        const plain = acks.filter(
          (a) => (a.result === 'rejected' || a.result === 'unknown_code') && !isScanRefusal(a.detail),
        ).length;
        if (plain > 0 || refused.length > 1) {
          setToast({ text: `❌ ${t('serverRefused', { n: refused.length })}` });
        }
      }
    },
    [t, refusalText],
  );

  /**
   * `sync` = also re-read the truck's snapshot.
   *
   * It used to be unconditional, and `accept()` calls this after EVERY scan
   * — so unloading a 200-box truck pulled the whole manifest 200 times
   * (round 110). The loading screen has had the split since round 9's
   * #248-250; this screen, which is the one Kashgar uses on the same
   * China→Europe link, never got it.
   */
  const flush = useCallback(
    async ({ sync }: { sync?: boolean } = {}) => {
      try {
        const { acks, discarded, refusedForbidden } = await flushScans();
        handleAcks(acks);
        // A body the server threw out is not a network problem, and saying
        // «offline» about it is how a jammed queue looked like bad wifi.
        if (discarded.length > 0) {
          setToast({ text: `❌ ${t('serverRefused', { n: discarded.length })}` });
          setDone((prev) => {
            const next = new Set(prev);
            for (const row of discarded) next.delete(row.code);
            return next;
          });
        }
        if (refusedForbidden) setToast({ text: `🚫 ${t('notYourTruck')}` });
        setOnline(true);
        // Live counter across phones: merge the server's unloaded set in.
        if (sync) {
          try {
            const res = await fetch(`/api/batches/${batchId}/planned`, {
              headers: snapEtag.current ? { 'If-None-Match': snapEtag.current } : undefined,
            });
            // 304 = nobody has scanned anything since the last tick: no body on
            // the wire, nothing to parse, nothing to re-render.
            if (res.ok) {
              const data = (await res.json()) as Snapshot;
              snapEtag.current = res.headers.get('etag');
              localStorage.setItem(cacheKey, JSON.stringify(data));
              snapRef.current = data;
              setSnapshot(data);
              setDone((prev) => {
                const next = new Set(prev);
                for (const b of data.boxes) if (b.status !== 'in_transit') next.add(b.shortCode);
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
   * One flush in flight at a time, with a follow-up for whatever arrived
   * behind it — the loading screen's `flushSoon`, for the same reason: an
   * operator clears a pallet at three boxes a second and each scan used to
   * start its own request. Coalesced, never DELAYED: a scan sends
   * immediately when nothing is in flight, because the last carton and
   * «Tushirish tugadi» happen in the same second.
   */
  const flushing = useRef(false);
  /** Set while a flush is in flight and more scans arrived behind it. */
  const again = useRef(false);
  const flushSoon = useCallback(() => {
    // The follow-up recurses through a local `run`, not through the callback
    // itself: the compiler's lint refuses a const that reads its own name.
    const run = () => {
      flushing.current = true;
      void flush().finally(() => {
        flushing.current = false;
        if (again.current) {
          again.current = false;
          run();
        }
      });
    };
    if (flushing.current) {
      again.current = true;
      return;
    }
    run();
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
    // No `sync` here: the effect above has just read the snapshot, and both
    // effects firing on mount downloaded the whole truck TWICE (round 110).
    void flush();
    // A phone in a pocket must not poll. The screen locks between pallets and
    // the tick went on asking every 15 seconds — for nothing on the phone's
    // side, and for a real query on the server's, times every phone in the
    // warehouse (round 74's one-process ceiling). Coming back is a sync, so
    // the first thing a woken screen shows is current.
    const tick = () => {
      if (document.visibilityState === 'visible') void flush({ sync: true });
    };
    const interval = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      document.removeEventListener('visibilitychange', tick);
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

  async function accept(
    codes: string[],
    scan: { code: string; method: 'qr' | 'manual'; manualReason?: string },
  ) {
    setDone((prev) => {
      const next = new Set(prev);
      for (const c of codes) next.add(c);
      return next;
    });
    feedback('ok');
    await enqueueScan({
      clientEventUuid: uuidv4(),
      batchId,
      code: scan.code,
      method: scan.method,
      manualReason: scan.manualReason,
      addedOnSpot: false,
      scannedAt: new Date().toISOString(),
      scanType: 'unload',
    });
    await refreshPending();
    flushSoon();
  }

  function onCode(code: string, method: 'qr' | 'manual' = 'qr', manualReason?: string) {
    if (!snapshot) return;
    // FIRST: a factory's barcode (0112, Q10 c) identifies a pile and is never
    // queued. It used to be queued ON PURPOSE (reality wins at unload) and
    // come back «unknown code» with the unclaimed-intake toast — a barcode is
    // no box at all, and pure digits can never be one of ours.
    if (!isOwnCodeShape(code)) {
      const lotIds = lotsForBarcode(code, snapshot.lotBarcodes ?? []);
      if (lotIds.length > 0 || looksLikeRetailBarcode(code)) {
        feedback('dup');
        setIdentify({ code, lotIds });
        return;
      }
    }
    // A Chinese carton carries the supplier's own QR too, and that one is a
    // URL. It is not an unknown BOX — the server cannot even parse it — and
    // queueing it used to make the server refuse the whole body, so every
    // good scan behind it stopped leaving the phone (silently, under an
    // «offline» banner).
    if (!isSendableCode(code)) {
      feedback('bad');
      setToast({ text: `❓ ${t('foreignCode')}` });
      return;
    }
    // A lot the office counts on this truck (0112, Q4/Q8): refused here, at
    // once and offline, before the server would say the same. Nothing is
    // queued — the office's number is the lot's whole answer.
    const counted = countOnlyLotOf(code, snapshot.boxes, snapshot.countOnly);
    if (counted) {
      feedback('bad');
      setToast({
        text: `❌ ${refusalText(counted.mode === 'counted' ? 'lot_counted' : 'qr_less_count_only', counted.label)}`,
      });
      return;
    }
    const crate = snapshot.crates.find((c) => c.code === code);
    const memberCodes = crate ? crate.boxShortCodes : [code];
    const known = new Set(snapshot.boxes.map((b) => b.shortCode));

    if (memberCodes.every((c) => done.has(c) || extra.includes(c))) {
      feedback('dup');
      setToast({ text: `🔁 ${t('alreadyScanned')} ${code}` });
      return;
    }
    if (crate || memberCodes.every((c) => known.has(c))) {
      void accept(memberCodes, { code, method, manualReason });
      return;
    }
    // Not on the manifest: send anyway — the server decides auto-transfer vs
    // unknown; reality wins at unload (edge case 4).
    setExtra((prev) => [...new Set([...prev, ...memberCodes])]);
    void accept([], { code, method, manualReason });
  }

  if (!snapshot) {
    if (!snapError) return <p className="p-4 text-ink-500">{tc('loading')}</p>;
    return (
      <div className="card space-y-3 !p-4 text-center" data-testid="snapshot-error">
        <p className="font-semibold text-bad">
          {snapError.kind === 'forbidden'
            ? tc('scanTruckForbidden')
            : snapError.kind === 'server'
              ? tc('scanSnapshotServer', { n: snapError.status ?? 0 })
              : tc('scanSnapshotOffline')}
        </p>
        <button type="button" className="btn-primary w-full" onClick={() => location.reload()}>
          {tc('retry')}
        </button>
      </div>
    );
  }

  const total = snapshot.boxes.length;
  const doneCount = snapshot.boxes.filter((b) => done.has(b.shortCode)).length;
  const countOnlyMode = new Map((snapshot.countOnly ?? []).map((l) => [l.lotId, l.mode]));
  // The sticker sheet lists what a PHONE may take: a count-only lot's
  // loose cartons are the office's (0112), a crated one is taken as its crate.
  const unscanned = snapshot.boxes.filter(
    (b) => !done.has(b.shortCode) && !(countOnlyMode.has(b.lotId) && !b.crateCode),
  );
  const byLot = new Map<
    string,
    {
      label: string;
      sub: string | null;
      product: string;
      total: number;
      done: number;
      mode: 'counted' | 'qrless' | null;
    }
  >();
  for (const box of snapshot.boxes) {
    const identity = codeIdentity(box.marking, box.clientCode);
    const entry = byLot.get(box.lotId) ?? {
      label: `${identity.main}-${box.letter}`,
      sub: identity.sub,
      product: box.productNameZh,
      total: 0,
      done: 0,
      mode: countOnlyMode.get(box.lotId) ?? null,
    };
    entry.total += 1;
    if (done.has(box.shortCode)) entry.done += 1;
    byLot.set(box.lotId, entry);
  }

  /** The identify sheet's rows, from this truck's own manifest. */
  function identifiedLots(lotIds: string[]): IdentifiedLot[] {
    return lotIds.flatMap((lotId) => {
      const entry = byLot.get(lotId);
      return entry ? [{ lotId, label: entry.label, product: entry.product, done: entry.done, total: entry.total }] : [];
    });
  }

  return (
    <div
      className={`space-y-3 pb-6 transition-colors ${flash === 'ok' ? 'bg-good/15' : flash ? 'bg-bad/15' : ''}`}
    >
      <div
        className={`rounded-lg p-2 text-center text-sm font-semibold ${
          online
            ? pending > 0
              ? 'bg-orange-100 text-orange-800'
              : 'bg-good/10 text-good'
            : 'bg-bad/15 text-bad'
        }`}
        data-testid="sync-banner"
      >
        {online
          ? pending > 0
            ? `🔄 ${t('syncing', { n: pending })}`
            : `✅ ${t('online')}`
          : `📴 ${t('offline', { n: pending })}`}
      </div>

      <Scanner
        active={identify === null}
        mode={scanMode}
        onCode={(code) => {
          // Retail mode is for ONE read: a non-own code goes to the sheet
          // whatever its symbology, and our own code falls through as a scan.
          if (scanMode === 'retail') {
            setScanMode('qr');
            if (!isOwnCodeShape(code)) {
              feedback('dup');
              setIdentify({ code, lotIds: lotsForBarcode(code, snapshot.lotBarcodes ?? []) });
              return;
            }
          }
          onCode(code);
        }}
      />
      <div className="flex justify-center">
        <button
          type="button"
          data-testid="scan-mode-barcode"
          aria-pressed={scanMode === 'retail'}
          className={`btn-secondary !min-h-9 px-3 ${scanMode === 'retail' ? '!bg-brand-600 !text-white' : ''}`}
          onClick={() => setScanMode((mode) => (mode === 'retail' ? 'qr' : 'retail'))}
        >
          🏭 {to('barcodeMode')}
        </button>
      </div>
      <BarcodeIdentify
        open={identify !== null}
        code={identify?.code ?? ''}
        lots={identifiedLots(identify?.lotIds ?? [])}
        countHref={countHref}
        onClose={() => setIdentify(null)}
      />

      {/* The loading screen's sentence, on the sibling that reads the same
          capped snapshot (review of the fixes, ui2-6). */}
      {snapshot.countOnlyCapped && (
        <p className="text-center text-xs text-ink-500" data-testid="count-only-capped">
          {tcount('countOnlyCapped')}
        </p>
      )}

      <p className="text-center font-mono text-4xl font-extrabold" data-testid="unload-counter">
        {doneCount}
        <span className="text-ink-400">/{total}</span> 📦
        {extra.length > 0 && (
          <span className="ml-2 text-lg text-orange-600">+{extra.length}❗</span>
        )}
      </p>

      <div className="card space-y-1 !p-3">
        {[...byLot.values()].map((lot) => (
          <div key={lot.label} className="flex items-center gap-2 text-sm">
            <span className="font-mono font-extrabold text-brand-700">
              {lot.label}
              {lot.sub && (
                <span className="block font-sans text-2xs font-normal text-ink-500">{lot.sub}</span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-700">{lot.product}</span>
            {lot.mode === 'counted' && (
              <span className="chip-brand shrink-0" data-testid="unload-lot-counted">
                {tca('chipCounted')}
              </span>
            )}
            {lot.mode === 'qrless' && (
              <span className="chip-warn shrink-0" data-testid="unload-lot-qrless">
                {tca('chipQrless')}
              </span>
            )}
            <span className={`font-semibold ${lot.done === lot.total ? 'text-good' : ''}`}>
              {lot.done}/{lot.total}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        data-testid="manual-open"
        className="btn-secondary w-full"
        onClick={() => setManualOpen(true)}
      >
        🏷 {t('stickerLost')}
      </button>
      {countHref && (
        <Link href={countHref} className="btn-secondary w-full" data-testid="open-count-accept">
          {tca('openCountAccept')}
        </Link>
      )}

      {toast && (
        <div
          className="space-y-1 rounded-lg bg-gray-800 p-2 text-sm font-semibold text-white"
          data-testid="unload-toast"
        >
          <button type="button" className="w-full text-left" onClick={() => setToast(null)}>
            {toast.text}
          </button>
          {toast.intake && (
            <Link href="/receive" className="block rounded bg-surface-raised/20 p-2 text-center">
              📥 {t('openIntake')}
            </Link>
          )}
        </div>
      )}

      {manualOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
          onClick={() => setManualOpen(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-md space-y-2 overflow-y-auto rounded-t-2xl bg-surface-raised p-4"
            onClick={(e) => e.stopPropagation()}
          >
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
            <p className="text-xs font-semibold text-ink-500">{t('unscannedList')}</p>
            {unscanned.slice(0, 80).map((box) => (
              <button
                key={box.shortCode}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg border border-line p-2 text-left text-sm hover:bg-surface-sunken"
                onClick={() => {
                  onCode(box.shortCode, 'manual', 'sticker_lost');
                  setManualOpen(false);
                }}
              >
                <span className="font-mono font-bold">{box.shortCode}</span>
                <span className="font-mono font-extrabold text-brand-700">
                  {codeIdentity(box.marking, box.clientCode).main}-{box.letter}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-500">{box.productNameZh}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** «GS777-A» for a snapshot carton, the way the lot rows print it. */
function lotLabelOf(box: MemberBox | undefined): string | null {
  if (!box) return null;
  return `${codeIdentity(box.marking, box.clientCode).main}-${box.letter}`;
}
