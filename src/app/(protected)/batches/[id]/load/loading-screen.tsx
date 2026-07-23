'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { Scanner } from '@/components/scan/scanner';
import {
  enqueueScan,
  flushScans,
  pendingScans,
  type SyncAck,
} from '@/offline/scan-outbox';

interface PlannedBox {
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
  boxes: PlannedBox[];
  crates: { code: string; boxShortCodes: string[] }[];
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
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState<'ok' | 'dup' | 'bad' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState<string | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      try {
        const res = await fetch(`/api/batches/${batchId}/planned`);
        if (res.ok) {
          const data = (await res.json()) as Snapshot;
          localStorage.setItem(cacheKey, JSON.stringify(data));
          applySnapshot(data);
          return;
        }
      } catch {
        /* offline */
      }
      const cached = localStorage.getItem(cacheKey);
      if (cached) applySnapshot(JSON.parse(cached) as Snapshot);
    })();
  }, [batchId, cacheKey, applySnapshot]);

  const refreshPending = useCallback(async () => {
    setPending((await pendingScans()).length);
  }, []);

  const handleAcks = useCallback((acks: SyncAck[]) => {
    for (const ack of acks) {
      if (ack.result === 'unknown_code' || ack.result === 'rejected') {
        setToast(`❌ ${ack.detail ?? ack.result}`);
      }
    }
  }, []);

  const flush = useCallback(async () => {
    try {
      const acks = await flushScans();
      handleAcks(acks);
      setOnline(true);
    } catch {
      setOnline(false);
    }
    await refreshPending();
  }, [handleAcks, refreshPending]);

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

  function feedback(kind: 'ok' | 'dup' | 'bad') {
    setFlash(kind);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 450);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(kind === 'ok' ? 60 : [70, 60, 70]);
    }
  }

  async function accept(codes: string[], scan: { code: string; method: 'qr' | 'manual'; manualReason?: string; addedOnSpot?: boolean; addedReason?: string }) {
    setLoaded((prev) => {
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
      addedOnSpot: scan.addedOnSpot ?? false,
      addedReason: scan.addedReason,
      scannedAt: new Date().toISOString(),
    });
    await refreshPending();
    void flush();
  }

  function onCode(code: string, method: 'qr' | 'manual' = 'qr', manualReason?: string) {
    if (!snapshot) return;
    const crate = snapshot.crates.find((c) => c.code === code);
    const memberCodes = crate ? crate.boxShortCodes : [code];
    const planned = new Set(snapshot.boxes.map((b) => b.shortCode));

    if (memberCodes.every((c) => loaded.has(c))) {
      feedback('dup');
      setToast(`🔁 ${t('alreadyScanned')} ${code}`);
      return;
    }
    if (crate || memberCodes.every((c) => planned.has(c))) {
      void accept(memberCodes, { code, method, manualReason });
      return;
    }
    // Not on this batch's plan — red confirm flow.
    feedback('bad');
    setConfirmCode(code);
    setConfirmReason('');
  }

  if (!snapshot) return <p className="p-4 text-gray-500">{tc('loading')}</p>;

  const total = snapshot.boxes.length;
  const byLot = new Map<string, { label: string; product: string; total: number; done: number }>();
  for (const box of snapshot.boxes) {
    const key = box.lotId;
    const entry =
      byLot.get(key) ?? {
        label: `${box.clientCode ?? box.marking ?? '?'}-${box.letter}`,
        product: box.productNameZh,
        total: 0,
        done: 0,
      };
    entry.total += 1;
    if (loaded.has(box.shortCode)) entry.done += 1;
    byLot.set(key, entry);
  }
  const doneCount = snapshot.boxes.filter((b) => loaded.has(b.shortCode)).length;
  const unscanned = snapshot.boxes.filter((b) => !loaded.has(b.shortCode));

  return (
    <div
      className={`space-y-3 pb-6 transition-colors ${
        flash === 'ok' ? 'bg-green-100' : flash ? 'bg-red-100' : ''
      }`}
    >
      <div
        className={`rounded-lg p-2 text-center text-sm font-semibold ${
          online ? (pending > 0 ? 'bg-orange-100 text-orange-800' : 'bg-green-50 text-green-800') : 'bg-red-100 text-red-800'
        }`}
        data-testid="sync-banner"
      >
        {online ? (pending > 0 ? `🔄 ${t('syncing', { n: pending })}` : `✅ ${t('online')}`) : `📴 ${t('offline', { n: pending })}`}
      </div>

      <Scanner active={confirmCode === null} onCode={(code) => onCode(code)} />

      <p className="text-center font-mono text-4xl font-extrabold" data-testid="load-counter">
        {doneCount}
        <span className="text-gray-400">/{total}</span> 📦
      </p>

      <div className="card space-y-1 !p-3">
        {[...byLot.values()].map((lot) => (
          <div key={lot.label} className="flex items-center gap-2 text-sm">
            <span className="font-mono font-extrabold text-blue-800">{lot.label}</span>
            <span className="min-w-0 flex-1 truncate text-gray-600">{lot.product}</span>
            <span className={`font-semibold ${lot.done === lot.total ? 'text-green-700' : ''}`}>
              {lot.done}/{lot.total}
            </span>
          </div>
        ))}
      </div>

      <button type="button" className="btn-secondary w-full" onClick={() => setManualOpen(true)}>
        🏷 {t('stickerLost')}
      </button>

      {toast && (
        <button type="button" className="w-full rounded-lg bg-gray-800 p-2 text-sm font-semibold text-white" onClick={() => setToast(null)}>
          {toast}
        </button>
      )}

      {/* Not-on-plan red confirm */}
      {confirmCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-red-700/95 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-4">
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
                void accept([confirmCode], {
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
          <div className="max-h-[80vh] w-full max-w-md space-y-2 overflow-y-auto rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <p className="font-bold">🏷 {t('stickerLostHint')}</p>
            <div className="flex gap-2">
              <input
                data-testid="manual-code"
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
            <p className="text-xs font-semibold text-gray-500">{t('unscannedList')}</p>
            {unscanned.slice(0, 80).map((box) => (
              <button
                key={box.shortCode}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg border border-gray-200 p-2 text-left text-sm hover:bg-gray-50"
                onClick={() => {
                  onCode(box.shortCode, 'manual', 'sticker_lost');
                  setManualOpen(false);
                }}
              >
                <span className="font-mono font-bold">{box.shortCode}</span>
                <span className="font-mono font-extrabold text-blue-800">
                  {box.clientCode ?? box.marking ?? '?'}-{box.letter}
                </span>
                <span className="min-w-0 flex-1 truncate text-gray-500">{box.productNameZh}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
