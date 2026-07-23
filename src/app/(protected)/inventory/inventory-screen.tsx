'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Scanner } from '@/components/scan/scanner';
import { reconcileInventoryAction, type ReconcileResult } from './actions';

interface ExpectedBox {
  boxId: string;
  shortCode: string;
  status: string;
  letter: string | null;
  productNameZh: string;
  clientCode: string | null;
  marking: string | null;
  crateCode: string | null;
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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scanned, setScanned] = useState<Set<string>>(new Set());
  const [foundHere, setFoundHere] = useState<Set<string>>(new Set());
  const [unknown, setUnknown] = useState<Set<string>>(new Set());
  const [manualCode, setManualCode] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [lostTicks, setLostTicks] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/inventory/expected?warehouseId=${warehouseId}`);
      if (res.ok) setSnapshot((await res.json()) as Snapshot);
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

  if (!snapshot) return <p className="p-4 text-gray-500">{tc('loading')}</p>;

  const expectedScanned = snapshot.boxes.filter((b) => scanned.has(b.shortCode));
  const missing = snapshot.boxes.filter((b) => !scanned.has(b.shortCode));

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
          <p className="text-xs text-orange-700">
            ⚠️ {t('skipped')}: {result.skipped!.join(', ')}
          </p>
        )}
        <p className="text-xs text-gray-500">{t('telegramSent')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-8">
      {!finishing && (
        <>
          <Scanner active onCode={onCode} />
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono uppercase"
              placeholder="YW26-000123"
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
        <span className="text-gray-400">/{snapshot.boxes.length}</span> 📦
      </p>
      <div className="flex justify-center gap-4 text-sm font-semibold">
        {foundHere.size > 0 && <span className="text-orange-700">↩️ {t('foundHere')}: {foundHere.size}</span>}
        {unknown.size > 0 && <span className="text-red-700">❓ {t('unknown')}: {unknown.size}</span>}
      </div>

      {!finishing ? (
        <button type="button" className="btn-primary w-full" onClick={() => setFinishing(true)}>
          {t('finish')} →
        </button>
      ) : (
        <div className="space-y-3">
          {foundHere.size > 0 && (
            <div className="card space-y-1 !p-3">
              <p className="text-sm font-bold">↩️ {t('foundHereTitle')}</p>
              <p className="text-xs text-gray-500">{t('foundHereHint')}</p>
              <p className="font-mono text-xs">{[...foundHere].join(', ')}</p>
            </div>
          )}

          <div className="card space-y-2 !p-3">
            <p className="text-sm font-bold">
              🔍 {t('missingTitle')} ({missing.length})
            </p>
            {missing.length === 0 && <p className="text-sm text-green-700">✅ {t('allScanned')}</p>}
            {missing.length > 0 && (
              <>
                <p className="text-xs text-gray-500">
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
                      <span className="font-mono font-extrabold text-blue-800">
                        {box.clientCode ?? box.marking ?? '?'}-{box.letter}
                      </span>
                      {box.crateCode && (
                        <span className="rounded bg-amber-100 px-1 text-xs">🧰 {box.crateCode}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-gray-500">{box.productNameZh}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {result?.error && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-800">
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
