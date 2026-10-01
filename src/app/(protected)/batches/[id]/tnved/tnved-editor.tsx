'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { TnvedProductRow } from '@/modules/wms/tnved/batch-lots';
import { saveLineCodesAction, saveTnvedAction, suggestTnvedForLotAction } from './actions';

export interface TnvedRow {
  lotId: string;
  nameZh: string;
  nameRu: string | null;
  photoId: string | null;
  boxCount: number;
  /** From memory — pre-filled. */
  code: string;
  source: 'manual' | 'ai' | null;
  /** The lots behind the row; `readable` = the person may open that prixod. */
  lots: { lotId: string; receiptId: string; label: string; readable: boolean }[];
  /** A lot tarkibi LINE (docs/LOT-TARKIBI.md §5); absent on a product row. */
  line?: NonNullable<TnvedProductRow['line']> & { readable: boolean; firstOfLot: boolean };
}

/**
 * Every piece of per-row state is keyed by THIS — never by `lotId`: both
 * lines of a composed lot share their lot's id, so a `lotId` key wrote the
 * mouse's code into the keyboard's line too (the lot tarkibi judge's R1, a
 * misdeclaration no other test saw).
 */
export function rowKey(row: Pick<TnvedRow, 'lotId' | 'line'>): string {
  return row.line ? row.line.rowKey : row.lotId;
}

/**
 * The ✅ of the last save, per truck, for the editor that REPLACES this one:
 * the page keys the editor on the line revisions, so a saved line code
 * remounts it on the refresh — and the sentence would vanish with the
 * instance that said it.
 */
const lastSaved = new Map<string, string>();

/**
 * ТНВЭД editor (Phase 1.5): per-product code entry with an AI suggestion
 * button. Confirmed codes land in the shared memory, so a product is only
 * ever classified once — next batches pre-fill automatically.
 *
 * `batchId` rides along with every 🤖: the action asks the truck's door and
 * refuses a lot that is not on it.
 *
 * Lot tarkibi: a composed lot shows one row per line on this truck. A line's
 * code is stored on the LINE (`saveLineCodesAction`), never in the memory —
 * it has no 🤖 and no «xotiradan»; the 💡 offers a code a person stated
 * before and never fills itself. On a truck whose papers went, the lines are
 * the frozen copy and read-only.
 */
export function TnvedEditor({ batchId, rows: initial }: { batchId: string; rows: TnvedRow[] }) {
  const t = useTranslations('tnved');
  const tk = useTranslations('tarkib');
  const tc = useTranslations('common');
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [reasonings, setReasonings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(() => {
    const said = lastSaved.get(batchId) ?? null;
    lastSaved.delete(batchId);
    return said;
  });
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const initialCode = (key: string) => initial.find((r) => rowKey(r) === key)?.code ?? '';

  function setCode(key: string, code: string, source: 'manual' | 'ai') {
    setRows((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, code, source } : r)));
  }

  async function suggest(row: TnvedRow) {
    const key = rowKey(row);
    setBusy(key);
    setError(null);
    try {
      const res = await suggestTnvedForLotAction(batchId, row.lotId);
      if (res.ok && res.suggestion) {
        setCode(key, res.suggestion.tnved_code, 'ai');
        setReasonings((prev) => ({
          ...prev,
          [key]: `${t(`confidence.${res.suggestion!.confidence}`)} · ${res.suggestion!.reasoning}`,
        }));
      } else {
        // A refusal is not the model failing: «AI did not answer — try later»
        // would send the person to press again at a door that stays shut.
        setError(
          res.error === 'ai_not_configured'
            ? t('aiNotConfigured')
            : res.error === 'forbidden'
              ? tc('forbidden')
              : t('aiFailed'),
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function suggestAllMissing() {
    for (const row of rows) {
      // Product rows only: a line has no 🤖 (its photo is the lot's carton).
      if (!row.line && !row.code.trim()) {
        // Sequential on purpose — visible progress + no rate-limit bursts.
        await suggest(row);
      }
    }
  }

  const changedProducts = rows.filter((r) => !r.line && r.code.trim() && r.code !== initialCode(rowKey(r)));
  const changedLines = rows.filter((r) => r.line && !r.line.frozen && r.line.lineId && r.code !== initialCode(rowKey(r)));

  function lineError(code: string | undefined): string {
    switch (code) {
      case 'composition_changed':
        return tk('errors.composition_changed');
      case 'frozen':
        return t('lineFrozen');
      case 'bad_tnved':
        return t('invalidCode');
      case 'busy':
        return tk('errors.busy');
      case 'server_behind':
        return tk('errors.server_behind');
      case 'forbidden':
        return tc('forbidden');
      default:
        return tk('errors.validation');
    }
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    setMessage(null);
    setStale(false);
    const said: string[] = [];
    try {
      if (changedProducts.length > 0) {
        const res = await saveTnvedAction(
          batchId,
          rows
            .filter((r) => !r.line && r.code.trim())
            .map((r) => ({
              nameZh: r.nameZh,
              nameRu: r.nameRu,
              code: r.code,
              source: r.source ?? 'manual',
              aiReasoning: reasonings[rowKey(r)] ?? null,
            })),
        );
        if (!res.ok) {
          setError(
            res.error === 'invalid_code'
              ? t('invalidCode')
              : res.error === 'not_on_truck'
                ? t('notOnTruck')
                : res.error === 'forbidden'
                  ? tc('forbidden')
                  : (res.error ?? 'error'),
          );
          // «Sahifani yangilang» with the button that does it — a colleague
          // composed the lot and its product row is gone (the review's nit).
          setStale(res.error === 'not_on_truck');
          return;
        }
        said.push(t('saved', { n: res.saved ?? 0 }));
      }
      if (changedLines.length > 0) {
        const res = await saveLineCodesAction(
          batchId,
          changedLines.map((r) => ({ lotId: r.line!.lotId, lineId: r.line!.lineId!, rev: r.line!.rev, code: r.code })),
        );
        // The revisions that DID commit are applied before the refusal is
        // shown, so a second press does not post dead ones.
        if (Object.keys(res.revs).length > 0) {
          setRows((prev) =>
            prev.map((r) =>
              r.line && res.revs[r.line.lotId] !== undefined
                ? { ...r, line: { ...r.line, rev: res.revs[r.line.lotId]! } }
                : r,
            ),
          );
        }
        if (!res.ok) {
          setError(lineError(res.error));
          setStale(res.error === 'composition_changed');
          if (said.length > 0) setMessage(`✅ ${said.join(' · ')}`);
          return;
        }
        said.push(t('lineSaved', { n: res.saved ?? 0 }));
      }
      const done = `✅ ${said.length > 0 ? said.join(' · ') : t('saved', { n: 0 })}`;
      setMessage(done);
      lastSaved.set(batchId, done);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const missing = rows.filter((r) => !r.line && !r.code.trim()).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {missing > 0 && (
          <button
            type="button"
            className="btn-secondary min-w-0 flex-1 px-3 disabled:opacity-50"
            disabled={busy !== null || saving}
            onClick={() => void suggestAllMissing()}
          >
            🤖 {t('suggestAll', { n: missing })}
          </button>
        )}
        <button
          type="button"
          className="btn-primary min-w-0 flex-1 px-3 disabled:opacity-50"
          disabled={saving || busy !== null}
          onClick={() => void saveAll()}
          data-testid="tnved-save"
        >
          💾 {saving ? tc('loading') : changedProducts.length > 0 ? t('saveAll') : t('saveLines')}
        </button>
      </div>
      {message && (
        <p className="rounded-lg bg-good/10 p-2 text-sm font-semibold text-good" data-testid="tnved-saved">
          {message}
        </p>
      )}
      {error && (
        <div className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad">
          <p>{error}</p>
          {stale && (
            <button type="button" className="btn-secondary mt-1 !min-h-9 px-3" onClick={() => router.refresh()}>
              🔄 {t('reload')}
            </button>
          )}
        </div>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const key = rowKey(row);
          const line = row.line;
          // `tarkib`, not `line`, in the testids: tokens.test.ts reads any
          // `<x>-line-<y>` in src/ as a colour class of the `line` family.
          return (
            <div key={key} className="card space-y-2 !p-3" data-testid={line ? 'tnved-tarkib-row' : 'tnved-row'}>
              <div className="flex items-center gap-3">
                {row.photoId && (!line || line.firstOfLot) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/attachments/${row.photoId}?variant=thumb200`}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-2xl">
                    {line ? '🧩' : '📦'}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  {line && (
                    <p className="text-xs text-ink-500">
                      {line.readable ? (
                        <Link
                          data-testid="tnved-lot-link"
                          className="text-brand-700 underline"
                          href={`/receipts/${line.receiptId}?tarkib=${line.lotId}&from=${batchId}#lot-${line.lotId}`}
                        >
                          🧩 {tk('lineOf', { lot: line.label, seq: line.seq, n: line.ofLines })}
                        </Link>
                      ) : (
                        <>🧩 {tk('lineOf', { lot: line.label, seq: line.seq, n: line.ofLines })}</>
                      )}
                    </p>
                  )}
                  <p className="truncate font-semibold">
                    {row.nameZh}
                    {row.nameRu && <span className="text-ink-500"> ({row.nameRu})</span>}
                  </p>
                  {line ? (
                    <p className="text-xs text-ink-500">
                      {line.cartons !== null
                        ? t('lineOnTruck', {
                            cartons: line.cartons,
                            kg: line.kg.toFixed(1),
                            approx: line.estimate ? '≈' : '',
                            pieces: line.pieces === null ? 'none' : String(line.pieces),
                          })
                        : t('lineMixed', {
                            kg: line.kg.toFixed(1),
                            approx: line.estimate ? '≈' : '',
                            pieces: line.pieces === null ? 'none' : String(line.pieces),
                          })}
                    </p>
                  ) : (
                    <p className="text-xs text-ink-500">
                      {row.boxCount} 📦
                      {row.lots
                        .filter((chip) => chip.readable)
                        .map((chip) => (
                          <Link
                            key={chip.lotId}
                            data-testid="tnved-lot-link"
                            className="ml-2 text-brand-700 underline"
                            href={`/receipts/${chip.receiptId}?tarkib=${chip.lotId}&from=${batchId}#lot-${chip.lotId}`}
                          >
                            {chip.label} 🧩
                          </Link>
                        ))}
                    </p>
                  )}
                  {line?.stale && <p className="text-xs font-semibold text-warn">⚠ {tk('staleShort')}</p>}
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  className="input flex-1 font-mono"
                  placeholder="8471300000"
                  inputMode="numeric"
                  data-testid={line ? 'tnved-tarkib-code' : 'tnved-code'}
                  value={row.code}
                  readOnly={line?.frozen === true}
                  onChange={(e) => setCode(key, e.target.value.replace(/\D/g, ''), 'manual')}
                />
                {!line && (
                  <button
                    type="button"
                    className="btn-secondary whitespace-nowrap px-3 disabled:opacity-50"
                    disabled={busy !== null || saving}
                    onClick={() => void suggest(row)}
                  >
                    {busy === key ? '⏳' : '🤖'}
                  </button>
                )}
              </div>
              {line?.frozen && <p className="text-xs text-ink-500">🔒 {t('lineFrozen')}</p>}
              {line && !line.frozen && line.hint && !row.code && (
                <button
                  type="button"
                  className="chip !min-h-9"
                  data-testid="tnved-tarkib-hint"
                  onClick={() => setCode(key, line.hint!.code, 'manual')}
                >
                  💡{' '}
                  {line.hint.from === 'memory'
                    ? t('lineHintMemory', { code: line.hint.code })
                    : t('lineHintComposition', { code: line.hint.code })}
                </button>
              )}
              {!line && row.source === 'ai' && reasonings[key] && (
                <p className="rounded-lg bg-brand-50 p-2 text-xs text-brand-800">🤖 {reasonings[key]}</p>
              )}
              {!line && row.source === 'manual' && initialCode(key) === row.code && row.code && (
                <p className="text-xs text-ink-500">💾 {t('fromMemory')}</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-400">{t('hint')}</p>
    </div>
  );
}
