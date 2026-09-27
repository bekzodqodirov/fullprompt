'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Scanner } from '@/components/scan/scanner';
import { armScanAudio, scanFeedback } from '@/components/scan/feedback';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { reconcileInventoryAction, type ReconcileResult } from './actions';

interface ExpectedBox {
  boxId: string;
  shortCode: string;
  status: string;
  /** Absent from a snapshot cached before 0112; the lot row only groups. */
  lotId?: string;
  letter: string | null;
  productNameZh: string;
  clientCode: string | null;
  marking: string | null;
  crateCode: string | null;
  /** No sticker of ours (0112): no scan can find it, so none is expected. */
  qrless?: boolean;
  /** Last loaded or landed by an office COUNT: no per-carton witness. */
  countMoved?: boolean;
}

/** A carton a missed scan says nothing about — never offered as lost (0112). */
function guarded(box: ExpectedBox): boolean {
  return Boolean(box.qrless || box.countMoved);
}
interface Snapshot {
  boxes: ExpectedBox[];
  crates: { code: string; boxShortCodes: string[] }[];
}

/**
 * Inventory (stocktake) mode — owner's request (M6 #12): scan EVERYTHING in
 * the warehouse; boxes recorded elsewhere but scanned here get moved here on
 * submit; unscanned boxes are listed and the warehouse MANAGER ticks which
 * become `lost` (the owner gets a Telegram summary). Runs in parallel with
 * normal operations — small drift just shows up in the lists.
 */
export function InventoryScreen({
  warehouseId,
  warehouseCode,
  canMarkLost,
}: {
  warehouseId: string;
  warehouseCode: string;
  canMarkLost: boolean;
}) {
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const tq = useTranslations('qrsiz');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scanned, setScanned] = useState<Set<string>>(new Set());
  const [foundHere, setFoundHere] = useState<Set<string>>(new Set());
  const [unknown, setUnknown] = useState<Set<string>>(new Set());
  const [manualCode, setManualCode] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [lostTicks, setLostTicks] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [flash, setFlash] = useState<'ok' | 'dup' | 'bad' | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Same haptic + color feedback as the loading screen — without it the
  // operator can't tell a scan registered (UX audit).
  // iOS unlocks the beep only inside a user gesture — arm on mount.
  useEffect(() => armScanAudio(), []);

  function feedback(kind: 'ok' | 'dup' | 'bad') {
    setFlash(kind);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 450);
    scanFeedback(kind);
  }

  const [snapError, setSnapError] = useState<
    { kind: 'offline' | 'server'; status?: number } | null
  >(null);
  useEffect(() => {
    void (async () => {
      // Round 89 taught the two scan screens to say WHY there is no list;
      // this one kept sitting on «Yuklanmoqda…» for ever, which is
      // indistinguishable from a broken screen.
      try {
        const res = await fetch(`/api/inventory/expected?warehouseId=${warehouseId}`);
        if (res.ok) {
          setSnapshot((await res.json()) as Snapshot);
          setSnapError(null);
          return;
        }
        setSnapError({ kind: 'server', status: res.status });
      } catch {
        setSnapError({ kind: 'offline' });
      }
    })();
  }, [warehouseId]);

  const expectedByCode = useMemo(
    () => new Map((snapshot?.boxes ?? []).map((b) => [b.shortCode, b])),
    [snapshot],
  );

  function onCode(raw: string) {
    if (!snapshot) return;
    const code = raw.trim().toUpperCase();
    if (!code) return;
    const crate = snapshot.crates.find((c) => c.code === code);
    const codes = crate ? crate.boxShortCodes : [code];
    if (codes.every((c) => scanned.has(c))) {
      feedback('dup');
    } else if (codes.some((c) => !expectedByCode.has(c)) && !crate) {
      feedback('bad'); // recorded elsewhere / unknown — draws a second look
    } else {
      feedback('ok');
    }
    setScanned((prev) => {
      const next = new Set(prev);
      for (const c of codes) next.add(c);
      return next;
    });
    for (const c of codes) {
      if (!expectedByCode.has(c)) {
        // Recorded elsewhere (or unknown entirely) — verified on submit;
        // locally we only split "looks like ours" vs junk.
        if (/^[A-Z]{2,10}\d{2}-\d{4,8}$/.test(c) || crate) {
          setFoundHere((prev) => new Set(prev).add(c));
        } else {
          setUnknown((prev) => new Set(prev).add(c));
        }
      }
    }
  }

  if (!snapshot) {
    if (!snapError) return <p className="p-4 text-ink-500">{tc('loading')}</p>;
    return (
      <div className="card space-y-3 !p-4 text-center" data-testid="snapshot-error">
        <p className="font-semibold text-bad">
          {snapError.kind === 'server'
            ? tc('scanSnapshotServer', { n: snapError.status ?? 0 })
            : tc('scanSnapshotOffline')}
        </p>
        <button type="button" className="btn-primary w-full" onClick={() => location.reload()}>
          {tc('retry')}
        </button>
      </div>
    );
  }

  // The counter counts what a scan CAN find: a QR-siz carton is not «0/48
  // missing», it is 48 cartons the office counts (0112, Q8).
  const scannable = snapshot.boxes.filter((b) => !b.qrless);
  const qrlessCount = snapshot.boxes.length - scannable.length;
  const expectedScanned = scannable.filter((b) => scanned.has(b.shortCode));
  const missing = snapshot.boxes.filter((b) => !scanned.has(b.shortCode) && !guarded(b));
  const keptByLot = new Map<string, { box: ExpectedBox; qrless: number; counted: number }>();
  for (const box of snapshot.boxes) {
    if (scanned.has(box.shortCode) || !guarded(box)) continue;
    const key = box.lotId ?? `${box.marking ?? box.clientCode}-${box.letter}`;
    const row = keptByLot.get(key) ?? { box, qrless: 0, counted: 0 };
    if (box.qrless) row.qrless += 1;
    else row.counted += 1;
    keptByLot.set(key, row);
  }
  const keptTotal = [...keptByLot.values()].reduce((n, row) => n + row.qrless + row.counted, 0);

  async function submit() {
    setSubmitting(true);
    try {
      const res = await reconcileInventoryAction({
        warehouseId,
        foundHereCodes: [...foundHere],
        lostBoxIds: [...lostTicks],
        scannedCount: scanned.size,
      });
      setResult(res);
    } finally {
      setSubmitting(false);
    }
  }

  if (result?.ok) {
    return (
      <div className="card space-y-3 text-center">
        <p className="text-3xl">✅</p>
        <h2 className="text-lg font-bold">{t('doneTitle', { wh: warehouseCode })}</h2>
        <p className="text-sm">
          {t('doneScanned', { n: scanned.size })}
          {(result.moved?.length ?? 0) > 0 && ` · ↩️ ${result.moved!.length}`}
          {(result.lost?.length ?? 0) > 0 && ` · ❌ ${result.lost!.length}`}
        </p>
        {(result.skipped?.length ?? 0) > 0 && (
          <p className="text-xs text-warn">
            ⚠️ {t('skipped')}: {result.skipped!.join(', ')}
          </p>
        )}
        {(result.qrlessKept?.length ?? 0) + (result.countKept?.length ?? 0) > 0 && (
          <p className="text-xs text-ink-700" data-testid="inventory-qrless-kept">
            {tq('keptDone', {
              n: (result.qrlessKept?.length ?? 0) + (result.countKept?.length ?? 0),
            })}
          </p>
        )}
        <p className="text-xs text-ink-500">{t('telegramSent')}</p>
      </div>
    );
  }

  return (
    <div
      className={`space-y-3 pb-8 transition-colors ${
        flash === 'ok' ? 'bg-good/15' : flash ? 'bg-bad/15' : ''
      }`}
    >
      {!finishing && (
        <>
          <Scanner active onCode={onCode} />
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono uppercase"
              placeholder="YW26-000123"
              autoCapitalize="characters"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manualCode.trim().length >= 4) {
                  onCode(manualCode);
                  setManualCode('');
                }
              }}
            />
            <button
              type="button"
              className="btn-secondary px-4"
              onClick={() => {
                if (manualCode.trim().length >= 4) {
                  onCode(manualCode);
                  setManualCode('');
                }
              }}
            >
              ✓
            </button>
          </div>
        </>
      )}

      <p className="text-center font-mono text-3xl font-extrabold">
        {expectedScanned.length}
        <span className="text-ink-400">/{scannable.length}</span> 📦
      </p>
      {qrlessCount > 0 && (
        <p className="text-center text-sm font-semibold text-warn" data-testid="inventory-qrless-count">
          {tq('stocktakeCount', { n: qrlessCount })}
        </p>
      )}
      <div className="flex justify-center gap-4 text-sm font-semibold">
        {foundHere.size > 0 && <span className="text-warn">↩️ {t('foundHere')}: {foundHere.size}</span>}
        {unknown.size > 0 && <span className="text-bad">❓ {t('unknown')}: {unknown.size}</span>}
      </div>

      {!finishing ? (
        <button
          type="button"
          className="btn-primary w-full"
          data-testid="inventory-finish"
          onClick={() => setFinishing(true)}
        >
          {t('finish')} →
        </button>
      ) : (
        <div className="space-y-3">
          {foundHere.size > 0 && (
            <div className="card space-y-1 !p-3">
              <p className="text-sm font-bold">↩️ {t('foundHereTitle')}</p>
              <p className="text-xs text-ink-500">{t('foundHereHint')}</p>
              <p className="font-mono text-xs">{[...foundHere].join(', ')}</p>
            </div>
          )}

          <div className="card space-y-2 !p-3" data-testid="inventory-missing">
            <p className="text-sm font-bold">
              🔍 {t('missingTitle')} ({missing.length})
            </p>
            {missing.length === 0 && <p className="text-sm text-good">✅ {t('allScanned')}</p>}
            {missing.length > 0 && (
              <>
                <p className="text-xs text-ink-500">
                  {canMarkLost ? t('missingHintManager') : t('missingHintOperator')}
                </p>
                {canMarkLost && missing.length > 0 && (
                  <button
                    type="button"
                    className="btn-secondary !min-h-9 px-2 text-xs"
                    onClick={() =>
                      setLostTicks((prev) =>
                        prev.size === missing.length
                          ? new Set()
                          : new Set(missing.map((b) => b.boxId)),
                      )
                    }
                  >
                    {lostTicks.size === missing.length ? t('untickAll') : t('tickAll')}
                  </button>
                )}
                <div className="max-h-72 space-y-1 overflow-y-auto">
                  {missing.map((box) => (
                    <label key={box.boxId} className="flex items-center gap-2 text-sm">
                      {canMarkLost && (
                        <input
                          type="checkbox"
                          checked={lostTicks.has(box.boxId)}
                          onChange={(e) =>
                            setLostTicks((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(box.boxId);
                              else next.delete(box.boxId);
                              return next;
                            })
                          }
                        />
                      )}
                      <span className="font-mono font-bold">{box.shortCode}</span>
                      <span className="font-mono font-extrabold text-brand-700">
                        {box.clientCode ?? box.marking ?? '?'}-{box.letter}
                      </span>
                      {box.crateCode && (
                        <span className="rounded bg-warn/15 px-1 text-xs">🧰 {box.crateCode}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-ink-500">{box.productNameZh}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Shown apart and with no tick (0112, decision 33): the service
              refuses to write these off even when their ids are posted, so a
              checkbox here would be a promise it does not keep. */}
          {keptTotal > 0 && (
            <div className="card space-y-2 !p-3" data-testid="inventory-qrless">
              <p className="text-sm font-bold">{tq('keptTitle', { n: keptTotal })}</p>
              <p className="text-xs text-ink-500">{tq('keptHint')}</p>
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {[...keptByLot.entries()].map(([key, row]) => {
                  const id = codeIdentity(row.box.marking, row.box.clientCode);
                  return (
                    <li key={key} className="flex items-center gap-2 text-sm">
                      <span className="whitespace-nowrap font-mono font-extrabold text-brand-700">
                        {id.main}-{row.box.letter}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink-500">
                        {row.box.productNameZh}
                      </span>
                      {row.qrless > 0 && (
                        <span className="chip-warn whitespace-nowrap">
                          {tq('kindQrless', { n: row.qrless })}
                        </span>
                      )}
                      {row.counted > 0 && (
                        <span className="chip-neutral whitespace-nowrap">
                          {tq('kindCounted', { n: row.counted })}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {result?.error && (
            <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
              {tc('error')}: {result.error}
            </p>
          )}
          <button
            type="button"
            className="btn-primary w-full disabled:opacity-50"
            disabled={submitting}
            onClick={submit}
          >
            {submitting
              ? tc('loading')
              : `✅ ${t('submit')}${lostTicks.size > 0 ? ` (❌ ${lostTicks.size})` : ''}`}
          </button>
          <button type="button" className="btn-secondary w-full" onClick={() => setFinishing(false)}>
            ← {t('backToScan')}
          </button>
        </div>
      )}
    </div>
  );
}
