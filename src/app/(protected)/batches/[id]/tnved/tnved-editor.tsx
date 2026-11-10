'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { nameKey } from '@/modules/wms/receipts/composition-math';
import type { TnvedProductRow } from '@/modules/wms/tnved/batch-lots';
import {
  saveLineCodesAction,
  saveTnvedAction,
  suggestTnvedForLineAction,
  suggestTnvedForLotAction,
} from './actions';

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
 * code is stored on the LINE (`saveLineCodesAction`), never in the memory, so
 * it has no «xotiradan»; the 💡 offers a code a person stated before. On a
 * truck whose papers went, the lines are the frozen copy and read-only.
 *
 * A line HAS its 🤖 (the owner's item 5, 2026-11-10 — a truck of composed
 * lots had no AI at all, and nothing on the screen said why). The server
 * decides what the model reads (`lineQuestion`): the line's own name, the
 * lot's photograph only when every carton of the lot is that one good. The
 * answer is this screen's state until «Saqlash», like a product row's.
 *
 * The root carries `data-tnved-unsaved` = how many codes are typed and not
 * saved: the invoice button beside it reads the count and says so before it
 * hands over a paper made from the SAVED codes (`invoice-download.tsx`).
 */
export function TnvedEditor({ batchId, rows: initial }: { batchId: string; rows: TnvedRow[] }) {
  const t = useTranslations('tnved');
  const tk = useTranslations('tarkib');
  const tc = useTranslations('common');
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  // The rows as they are NOW, for the walk below: it runs across many awaits
  // and must judge each row by what the person has typed meanwhile, not by
  // the render it started in.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const [reasonings, setReasonings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** «🤖 AI taklif (N)» in flight: how far it is, and the person's «stop». */
  const [walk, setWalk] = useState<{ done: number; n: number } | null>(null);
  const stopWalk = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(() => {
    const said = lastSaved.get(batchId) ?? null;
    lastSaved.delete(batchId);
    return said;
  });
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  /**
   * What a save has just written, until the refresh brings the rows back.
   * «Changed» is «differs from what the server holds», and for the moment
   * between the ✅ and the refreshed page that is NOT the rows the editor was
   * handed: the invoice button beside it said «1 ta kod saqlanmagan» about a
   * code saved a third of a second earlier (found by the browser test — the
   * press came before the refresh landed).
   */
  const [written, setWritten] = useState<Record<string, string>>({});
  const initialCode = (key: string) => written[key] ?? initial.find((r) => rowKey(r) === key)?.code ?? '';
  const markWritten = (saved: readonly TnvedRow[]) =>
    setWritten((prev) => ({ ...prev, ...Object.fromEntries(saved.map((r) => [rowKey(r), r.code])) }));

  function setCode(key: string, code: string, source: 'manual' | 'ai') {
    setRows((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, code, source } : r)));
  }

  /**
   * Fill a row only while it is still EMPTY — the walk's write. The check is
   * inside the updater, so it is made against the rows as React holds them at
   * that moment: a code the person typed while the model was thinking is
   * theirs, and no answer arriving late can take its place.
   */
  function fillEmpty(key: string, code: string, source: 'manual' | 'ai') {
    setRows((prev) => prev.map((r) => (rowKey(r) === key && !r.code.trim() ? { ...r, code, source } : r)));
  }

  /** A row the 🤖 may be asked about: a product, or a LIVE line of a tarkib. */
  const askable = (row: TnvedRow) => !row.line || (!row.line.frozen && row.line.lineId !== null);

  function ask(row: TnvedRow) {
    return row.line
      ? suggestTnvedForLineAction(batchId, row.line.lotId, row.line.lineId!)
      : suggestTnvedForLotAction(batchId, row.lotId);
  }

  type Asked = Awaited<ReturnType<typeof ask>>;

  /** The 🤖 line under a code: how sure, why — and, for a line, that no photo was read. */
  function noteOf(row: TnvedRow, res: Asked): string {
    const said = `${t(`confidence.${res.suggestion!.confidence}`)} · ${res.suggestion!.reasoning}`;
    return row.line && 'photo' in res && res.photo === false ? `${said} · ${t('aiNameOnly')}` : said;
  }

  /**
   * A refusal is not the model failing: «AI did not answer — try later» would
   * send the person to press again at a door that stays shut.
   */
  function askError(code: string | undefined): string {
    switch (code) {
      case 'ai_not_configured':
        return t('aiNotConfigured');
      case 'forbidden':
        return tc('forbidden');
      case 'composition_changed':
      case 'frozen':
      case 'busy':
      case 'server_behind':
        return lineError(code);
      case 'receipt_not_confirmed':
        return tk('errors.receipt_not_confirmed');
      default:
        return t('aiFailed');
    }
  }

  function refuse(code: string | undefined) {
    setError(askError(code));
    // The tarkib was re-saved on the prixod card: these rows name lines that
    // are gone, and only a reload brings the new ones.
    setStale(code === 'composition_changed');
  }

  async function suggest(row: TnvedRow) {
    const key = rowKey(row);
    setBusy(key);
    setError(null);
    setStale(false);
    try {
      const res = await ask(row);
      if (res.ok && res.suggestion) {
        setCode(key, res.suggestion.tnved_code, 'ai');
        setReasonings((prev) => ({ ...prev, [key]: noteOf(row, res) }));
      } else {
        refuse(res.error);
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * «🤖 AI taklif (N)» — every empty code on the screen, one at a time
   * (visible progress, no rate-limit burst), product rows and tarkib lines
   * alike:
   *
   *  1. a line whose name a person coded before has its 💡 — that code is
   *     free and a person's, so it is filled and the model is never asked;
   *  2. the rest are asked in the order they are drawn. Each row is judged
   *     LIVE before its ask — a code typed meanwhile is the person's — and
   *     written through `fillEmpty`, which cannot overwrite one;
   *  3. one answer per line NAME: «Мышь» on a second lot takes the first
   *     «Мышь»'s answer. Two asks could come back with two codes for one
   *     good, and the invoice merges same-named goods only when their codes
   *     are equal;
   *  4. it STOPS at a door that stays shut — no key, no permission, a ticked
   *     truck, a tarkib re-saved under the screen — and after two model
   *     failures in a row, instead of pressing a dead button N times.
   */
  async function suggestAllMissing() {
    stopWalk.current = false;
    setError(null);
    setStale(false);
    const empty = (row: TnvedRow) => askable(row) && !row.code.trim();
    const hinted = new Set<string>();
    for (const row of rowsRef.current) {
      if (empty(row) && row.line?.hint) {
        fillEmpty(rowKey(row), row.line.hint.code, 'manual');
        hinted.add(rowKey(row));
      }
    }
    const queue = rowsRef.current.filter((row) => empty(row) && !hinted.has(rowKey(row)));
    const byName = new Map<string, { code: string; note: string }>();
    let failed = 0;
    let done = 0;
    setWalk({ done, n: queue.length });
    try {
      for (const target of queue) {
        if (stopWalk.current) break;
        const key = rowKey(target);
        const live = rowsRef.current.find((r) => rowKey(r) === key);
        if (live && empty(live)) {
          const same = target.line ? byName.get(nameKey(target.nameZh)) : undefined;
          if (same) {
            fillEmpty(key, same.code, 'ai');
            setReasonings((prev) => ({ ...prev, [key]: `${same.note} · ${t('aiSameName')}` }));
          } else {
            setBusy(key);
            const res = await ask(target);
            setBusy(null);
            if (res.ok && res.suggestion) {
              failed = 0;
              const note = noteOf(target, res);
              fillEmpty(key, res.suggestion.tnved_code, 'ai');
              setReasonings((prev) => ({ ...prev, [key]: note }));
              if (target.line) byName.set(nameKey(target.nameZh), { code: res.suggestion.tnved_code, note });
            } else {
              refuse(res.error);
              failed += 1;
              if (res.error !== 'ai_failed' || failed >= 2) break;
            }
          }
        }
        done += 1;
        setWalk({ done, n: queue.length });
      }
    } finally {
      setBusy(null);
      setWalk(null);
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
        // The CHANGED rows only. Every coded row used to be posted, so one
        // product a colleague composed meanwhile (its row is a tarkib's
        // lines now) refused the whole save `not_on_truck` — and the reload
        // that cures it drops every answer typed or suggested and not saved.
        const res = await saveTnvedAction(
          batchId,
          changedProducts.map((r) => ({
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
        markWritten(changedProducts);
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
          // …and those lots' codes are on their lines now, refusal or not.
          markWritten(changedLines.filter((r) => res.revs[r.line!.lotId] !== undefined));
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

  // What the 🤖 can still fill — tarkib lines included, so the button's
  // number is the header's «TNVED kodsiz · N» less the rows a ticked truck
  // keeps read-only.
  const missing = rows.filter((r) => askable(r) && !r.code.trim()).length;
  const working = busy !== null || walk !== null;

  return (
    <div className="space-y-3" data-tnved-unsaved={changedProducts.length + changedLines.length}>
      <div className="flex flex-wrap gap-2">
        {walk ? (
          <button
            type="button"
            className="btn-secondary min-w-0 flex-1 px-3"
            data-testid="tnved-ai-stop"
            onClick={() => {
              stopWalk.current = true;
            }}
          >
            ⏳ {t('suggestProgress', { done: walk.done, n: walk.n })} · {t('suggestStop')}
          </button>
        ) : (
          missing > 0 && (
            <button
              type="button"
              className="btn-secondary min-w-0 flex-1 px-3 disabled:opacity-50"
              disabled={working || saving}
              data-testid="tnved-ai-all"
              onClick={() => void suggestAllMissing()}
            >
              🤖 {t('suggestAll', { n: missing })}
            </button>
          )
        )}
        <button
          type="button"
          className="btn-primary min-w-0 flex-1 px-3 disabled:opacity-50"
          disabled={saving || working}
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
        <div className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad" data-testid="tnved-error">
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
                {askable(row) && (
                  <button
                    type="button"
                    className="btn-secondary whitespace-nowrap px-3 disabled:opacity-50"
                    disabled={working || saving}
                    data-testid={line ? 'tnved-tarkib-ai' : 'tnved-ai'}
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
              {row.source === 'ai' && reasonings[key] && (
                <p className="rounded-lg bg-brand-50 p-2 text-xs text-brand-800" data-testid="tnved-ai-note">
                  🤖 {reasonings[key]}
                </p>
              )}
              {!line && row.source === 'manual' && initialCode(key) === row.code && row.code && (
                <p className="text-xs text-ink-500">💾 {t('fromMemory')}</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-400">{t('hint')}</p>
      {/* A line's code is the lot's own and never reaches the memory the
          sentence above describes — say so wherever a line is drawn. */}
      {rows.some((r) => r.line) && <p className="text-xs text-ink-400">{t('hintLines')}</p>}
    </div>
  );
}
