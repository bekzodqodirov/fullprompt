'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { nameKey } from '@/modules/wms/receipts/composition-math';
import {
  saveLineCodesAction,
  saveTnvedAction,
  suggestTnvedForLineAction,
  suggestTnvedForLotAction,
} from './actions';
// The row, its key (`rowKey(` — never the lot's id: two lines of one lot
// share it) and the decisions that are not React live in the pure module.
import { reseedRows, rowKey, sameNameCode, walkStep, type TnvedRow } from './editor-state';

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
 *
 * The editor is NOT remounted when the server's rows come back (a save, the
 * 🔄, a colleague's change): it re-seeds itself row by row (`reseedRows`), so
 * a code typed or suggested and not saved yet stays on its row. It used to
 * be keyed on the line revisions — one lot's tarkib moving, or one line code
 * saved, threw away every unsaved code on the screen (the review of the
 * built round; every answer of the 🤖 is paid for).
 */
export function TnvedEditor({ batchId, rows: initial }: { batchId: string; rows: TnvedRow[] }) {
  const t = useTranslations('tnved');
  const tk = useTranslations('tarkib');
  const tc = useTranslations('common');
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  /**
   * What a save has just written, until the refresh brings the rows back.
   * «Changed» is «differs from what the server holds», and for the moment
   * between the ✅ and the refreshed page that is NOT the rows the editor was
   * handed: the invoice button beside it said «1 ta kod saqlanmagan» about a
   * code saved a third of a second earlier (found by the browser test — the
   * press came before the refresh landed).
   */
  const [written, setWritten] = useState<Record<string, string>>({});
  // The rows this state was last seeded from. A refresh hands the editor new
  // ones; the state is re-seeded HERE, during the render that sees them
  // (React's «adjust state when a prop changes»): every row takes the
  // server's code and revision, except a code that is not saved yet.
  const [seed, setSeed] = useState(initial);
  if (seed !== initial) {
    const baseOf = (key: string) => written[key] ?? seed.find((r) => rowKey(r) === key)?.code ?? '';
    setRows(reseedRows(rows, baseOf, initial));
    setSeed(initial);
    setWritten({});
  }
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
  // The walk ends with the editor. Left alone it went on asking the model
  // for every remaining row after the person had opened another screen —
  // unseen, unstoppable, every answer dropped, and every other action of the
  // tab queued behind each call (the review of the built round). At most the
  // call already in flight is paid for.
  useEffect(
    () => () => {
      stopWalk.current = true;
    },
    [],
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

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
      case 'not_found':
        return t('notOnTruck');
      default:
        return t('aiFailed');
    }
  }

  function refuse(code: string | undefined) {
    setError(askError(code));
    // The tarkib was re-saved on the prixod card (or the lot left the truck):
    // these rows name lines that are gone, and a reload brings the new ones —
    // keeping every other row's unsaved code (`reseedRows`).
    setStale(code === 'composition_changed' || code === 'not_found');
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
   *     «Мышь»'s answer — the one this walk was given, or a code a line of
   *     that name already holds on the screen (`sameNameCode`: typed, from
   *     the row's own 🤖, from a walk that stopped). Two asks could come back
   *     with two codes for one good, and the invoice merges same-named goods
   *     only when their codes are equal;
   *  4. `walkStep` decides what a refusal means: a door shut for every row
   *     (no key, no permission, a ticked truck) STOPS the walk, as do two
   *     model failures in a row — a dead button is not pressed N times; a
   *     fact about ONE lot (its tarkib re-saved under the screen) leaves
   *     that lot's rows alone, goes on, and names the lot at the end.
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
    /** The lots this walk leaves alone, and why (the last reason is the one said). */
    const skipped = new Set<string>();
    let skippedFor: string | undefined;
    let stopped = false;
    let failed = 0;
    let done = 0;
    setWalk({ done, n: queue.length });
    try {
      for (const target of queue) {
        if (stopWalk.current) break;
        const key = rowKey(target);
        const live = rowsRef.current.find((r) => rowKey(r) === key);
        if (live && empty(live) && !skipped.has(target.lotId)) {
          const name = nameKey(target.nameZh);
          const onScreen = sameNameCode(rowsRef.current, target);
          const same = target.line
            ? (byName.get(name) ?? (onScreen ? { code: onScreen, note: t('aiSameName') } : undefined))
            : undefined;
          if (same) {
            fillEmpty(key, same.code, 'ai');
            setReasonings((prev) => ({ ...prev, [key]: same.note }));
          } else {
            setBusy(key);
            const res = await ask(target);
            setBusy(null);
            if (res.ok && res.suggestion) {
              failed = 0;
              const note = noteOf(target, res);
              fillEmpty(key, res.suggestion.tnved_code, 'ai');
              setReasonings((prev) => ({ ...prev, [key]: note }));
              if (target.line) {
                byName.set(name, { code: res.suggestion.tnved_code, note: `${note} · ${t('aiSameName')}` });
              }
            } else if (walkStep(res.error) === 'skip-lot') {
              skipped.add(target.lotId);
              skippedFor = res.error;
            } else {
              refuse(res.error);
              failed += 1;
              if (walkStep(res.error) === 'stop' || failed >= 2) {
                stopped = true;
                break;
              }
            }
          }
        }
        done += 1;
        setWalk({ done, n: queue.length });
      }
      // The lots left alone are named last — unless a shut door already spoke.
      if (!stopped && skipped.size > 0) refuse(skippedFor);
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

  /**
   * «Saqlash». What the server wrote is settled at once (`markWritten`), and
   * ONE refusal never stops the rest: a product whose lot a colleague
   * composed meanwhile is named while the other names are saved, a lot whose
   * tarkib moved under the screen is named while the other lots are saved
   * — and the line codes are posted whatever the products answered. The
   * review of the built round: one such row blocked every code after it,
   * and the only way on the screen offered was a reload that dropped them.
   * Then the server's rows come back (`router.refresh` → `reseedRows`): what
   * was saved is the baseline, what was not stays on its row.
   */
  async function saveAll() {
    setSaving(true);
    setError(null);
    setMessage(null);
    setStale(false);
    const said: string[] = [];
    const refusals: string[] = [];
    let reload = false;
    try {
      if (changedProducts.length > 0) {
        // The CHANGED rows only. Every coded row used to be posted — one
        // stale row refused them all, and an untouched row wrote its code
        // back over a colleague's correction of the shared memory.
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
        const gone = new Set(res.gone ?? []);
        if (res.saved) {
          markWritten(changedProducts.filter((r) => !gone.has(r.nameZh)));
          said.push(t('saved', { n: res.saved }));
        }
        if (!res.ok) {
          refusals.push(
            res.error === 'invalid_code'
              ? t('invalidCode')
              : res.error === 'not_on_truck'
                ? t('notOnTruck')
                : res.error === 'forbidden'
                  ? tc('forbidden')
                  : (res.error ?? 'error'),
          );
          // «Sahifani yangilang» with the button that does it — a colleague
          // composed the lot and its product row is gone.
          reload = res.error === 'not_on_truck';
          // A wrong code or a shut door wrote nothing and is the person's to
          // cure before anything else is posted.
          if (res.error !== 'not_on_truck') {
            setError(refusals.join(' '));
            return;
          }
        }
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
        if (res.saved) said.push(t('lineSaved', { n: res.saved }));
        if (!res.ok) {
          refusals.push(lineError(res.error));
          reload ||= res.error === 'composition_changed';
        }
      }
      if (said.length > 0 || refusals.length === 0) {
        setMessage(`✅ ${said.length > 0 ? said.join(' · ') : t('saved', { n: 0 })}`);
      }
      if (refusals.length > 0) {
        setError(refusals.join(' '));
        setStale(reload);
      }
      if (said.length > 0 || refusals.length === 0) router.refresh();
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
