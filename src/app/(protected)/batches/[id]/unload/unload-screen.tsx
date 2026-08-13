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

interface MemberBox {
  shortCode: string;
  status: string;
  letter: string | null;
  lotId: string;
  productNameZh: string;
  clientCode: string | null;
  marking: string | null;
}
interface Snapshot {
  batch: { id: string; code: string; status: string };
  boxes: MemberBox[];
  crates: { code: string; boxShortCodes: string[] }[];
}

/**
 * W5 unload mode (spec 6.5): scan everything off the truck. On-manifest →
 * stock here; a known box that is NOT on the manifest is auto-transferred
 * (orange toast, logist alerted — edge case 4, reality wins); unknown QR →
 * red toast with a link to the unclaimed intake. Fully offline-capable.
 */
export function UnloadScreen({ batchId }: { batchId: string }) {
  const t = useTranslations('unloading');
  const tc = useTranslations('common');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** Why there is no snapshot yet — `null` while it is simply still loading. */
  const [snapError, setSnapError] = useState<'forbidden' | 'offline' | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<string[]>([]);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState<'ok' | 'dup' | 'bad' | null>(null);
  const [toast, setToast] = useState<{ text: string; intake?: boolean } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheKey = `gsr-unload-${batchId}`;

  const applySnapshot = useCallback((data: Snapshot) => {
    setSnapshot(data);
    // "Accepted here" is "no longer in transit" — NOT "in_stock". A customs or
    // distribution destination lands cargo straight in ready_for_pickup, and
    // matching on in_stock alone left the counter at 0 there for ever.
    setDone(new Set(data.boxes.filter((b) => b.status !== 'in_transit').map((b) => b.shortCode)));
  }, []);

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

  const handleAcks = useCallback(
    (acks: SyncAck[]) => {
      for (const ack of acks) {
        if (ack.result === 'auto_transfer') {
          setToast({
            text: `📦❗ ${t('autoTransferred')} ${ack.boxes?.map((b) => b.shortCode).join(', ') ?? ''}`,
          });
        } else if (ack.result === 'unknown_code') {
          setToast({ text: `❓ ${t('unknownCode')}`, intake: true });
        } else if (ack.result === 'rejected') {
          setToast({ text: `❌ ${ack.detail ?? 'rejected'}` });
        }
      }
    },
    [t],
  );

  const flush = useCallback(async () => {
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
      try {
        const res = await fetch(`/api/batches/${batchId}/planned`);
        if (res.ok) {
          const data = (await res.json()) as Snapshot;
          localStorage.setItem(cacheKey, JSON.stringify(data));
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
    } catch {
      setOnline(false);
    }
    await refreshPending();
  }, [handleAcks, refreshPending, batchId, cacheKey, t]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flush();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    void flush();
    const interval = setInterval(() => void flush(), 15_000);
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

  async function accept(codes: string[], scan: { code: string; method: 'qr' | 'manual'; manualReason?: string }) {
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
    void flush();
  }

  function onCode(code: string, method: 'qr' | 'manual' = 'qr', manualReason?: string) {
    if (!snapshot) return;
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
          {snapError === 'forbidden' ? tc('scanTruckForbidden') : tc('scanSnapshotOffline')}
        </p>
        <button type="button" className="btn-primary w-full" onClick={() => location.reload()}>
          {tc('retry')}
        </button>
      </div>
    );
  }

  const total = snapshot.boxes.length;
  const doneCount = snapshot.boxes.filter((b) => done.has(b.shortCode)).length;
  const unscanned = snapshot.boxes.filter((b) => !done.has(b.shortCode));
  const byLot = new Map<
    string,
    { label: string; sub: string | null; product: string; total: number; done: number }
  >();
  for (const box of snapshot.boxes) {
    const identity = codeIdentity(box.marking, box.clientCode);
    const entry =
      byLot.get(box.lotId) ?? {
        label: `${identity.main}-${box.letter}`,
        sub: identity.sub,
        product: box.productNameZh,
        total: 0,
        done: 0,
      };
    entry.total += 1;
    if (done.has(box.shortCode)) entry.done += 1;
    byLot.set(box.lotId, entry);
  }

  return (
    <div className={`space-y-3 pb-6 transition-colors ${flash === 'ok' ? 'bg-good/15' : flash ? 'bg-bad/15' : ''}`}>
      <div
        className={`rounded-lg p-2 text-center text-sm font-semibold ${
          online ? (pending > 0 ? 'bg-orange-100 text-orange-800' : 'bg-good/10 text-good') : 'bg-bad/15 text-bad'
        }`}
        data-testid="sync-banner"
      >
        {online ? (pending > 0 ? `🔄 ${t('syncing', { n: pending })}` : `✅ ${t('online')}`) : `📴 ${t('offline', { n: pending })}`}
      </div>

      <Scanner active onCode={(code) => onCode(code)} />

      <p className="text-center font-mono text-4xl font-extrabold" data-testid="unload-counter">
        {doneCount}
        <span className="text-ink-400">/{total}</span> 📦
        {extra.length > 0 && <span className="ml-2 text-lg text-orange-600">+{extra.length}❗</span>}
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
            <span className={`font-semibold ${lot.done === lot.total ? 'text-good' : ''}`}>
              {lot.done}/{lot.total}
            </span>
          </div>
        ))}
      </div>

      <button type="button" className="btn-secondary w-full" onClick={() => setManualOpen(true)}>
        🏷 {t('stickerLost')}
      </button>

      {toast && (
        <div className="space-y-1 rounded-lg bg-gray-800 p-2 text-sm font-semibold text-white">
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
