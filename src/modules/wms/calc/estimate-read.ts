import { isQueryCanceled } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import { unitsForItem } from '../customs/import-baza';
import type { ImportUnit } from '../customs/import-parse';
import { batchesForCodes } from '../customs/import-service';
import { readCodeMedians } from '../customs/import-median';
import { underCeiling } from '../finance/price-history';
import { bazaStaleCutoff } from './dictionaries';
import { bandKeyOf, medianForRow, type MedianMiss, type RowMedian } from './estimate';
import type { Workspace } from './workspace';

/**
 * Reading the medians the 📊 estimate stands on (docs/SAKKIZ-R2.md §6.6).
 *
 * BOUNDED three ways, because it runs inside the customs pass and the pass
 * has a deadline and a pg-boss expiry above it (§6.8):
 *  - at most MAX_ESTIMATE_ROWS rows are asked about (the rest say `capped`);
 *  - at most MAX_BANDS_PER_CODE per-piece bands ride one code's statement,
 *    dona-first rows served first; a row whose band missed the cap answers
 *    from a unit it prefers to dona, or says `capped`;
 *  - once ESTIMATE_BUDGET_MS has passed since the read began, or the pass's
 *    own deadline, no further statement is issued and every row not yet
 *    answered says `budget` — Taxminiy is then refused in words, never
 *    invented from the half that was read.
 *
 * And STRICTLY ONE AFTER ANOTHER. Each statement runs in its own
 * `underCeiling` transaction (≤ 1500 ms a statement), and each of those holds
 * one of the ten pool connections every page in the app shares — the pass
 * fanning out over a 30-code invoice would take the whole pool from the
 * office for as long as it ran (#714's family). `estimate-wire.test.ts`
 * refuses `Promise.all` in this file.
 */

export const MAX_ESTIMATE_ROWS = 40;
export const MAX_BANDS_PER_CODE = 8;
export const ESTIMATE_BUDGET_MS = 10_000;

const miss = (m: MedianMiss): RowMedian => ({ ok: false, miss: m, n: null });

type Row = Workspace['groups'][number]['items'][number];

/** Does the row state any figure at all? A row that states one, and is still
 * offered no unit, has a unit choice the law cannot hold — not «no measure». */
const statesAny = (i: Row) =>
  [i.quantity, i.weightKg, i.volumeM3, i.measureQty].some((v) => v !== null && v > 0);

/**
 * Medians for the workspace's baza-less, grouped rows, keyed by item id.
 *
 * Pool: `batchesForCodes`, before any transaction. Then ONE `underCeiling`
 * transaction per distinct (code, batch), in order. A cancelled statement
 * (57014) marks every row of ITS code `timeout` and the read goes on with the
 * next code; any other failure is thrown, and the pass reads that as «no
 * estimate» (prefill.ts) — it never costs the reply.
 */
export async function rowMediansFor(ws: Workspace, opts: { deadline: number }): Promise<Map<string, RowMedian>> {
  const out = new Map<string, RowMedian>();
  const started = Date.now();
  const spent = () => Date.now() > opts.deadline || Date.now() - started > ESTIMATE_BUDGET_MS;

  const wants: { id: string; code: string; allowed: ImportUnit[]; band: ReturnType<typeof bandKeyOf> }[] = [];
  let asked = 0;
  for (const g of ws.groups) {
    for (const i of g.items) {
      if (i.bazaUsd !== null) continue;
      asked += 1;
      if (asked > MAX_ESTIMATE_ROWS) {
        out.set(i.id, miss('capped'));
        continue;
      }
      const code = (i.tnvedCode ?? g.tnvedCode ?? '').trim();
      // The median is per EXACT code (`codeScopeCtes`): a heading-wide series
      // mixes subheadings priced nothing alike.
      if (!/^\d{10}$/.test(code)) {
        out.set(i.id, miss('short_code'));
        continue;
      }
      // The ONE row → units mapping (K10), the auto-fill's and the pick's.
      const allowed = unitsForItem(i, g.dutyUnit);
      if (allowed.length === 0) {
        out.set(i.id, miss(statesAny(i) ? 'unit_mismatch' : 'no_measure'));
        continue;
      }
      const perPiece =
        allowed.includes('dona') && i.quantity !== null && i.quantity > 0 && i.weightKg !== null && i.weightKg > 0
          ? i.weightKg / i.quantity
          : null;
      wants.push({ id: i.id, code, allowed, band: allowed.includes('dona') ? bandKeyOf(perPiece) : null });
    }
  }
  if (wants.length === 0) return out;
  if (spent()) {
    for (const w of wants) out.set(w.id, miss('budget'));
    return out;
  }

  // Which file answers each code (K8 — P2's chooser behind it). An EMPTY map
  // is «nothing is loaded at all»; a code no file holds still maps to the
  // newest batch and reads `no_declarations` below.
  const chosen = await batchesForCodes(wants.map((w) => w.code));
  if (chosen.size === 0) {
    for (const w of wants) out.set(w.id, miss('no_batch'));
    return out;
  }
  const staleCutoff = bazaStaleCutoff();

  for (const code of [...new Set(wants.map((w) => w.code))]) {
    const mine = wants.filter((w) => w.code === code);
    const batch = chosen.get(code);
    if (!batch) {
      for (const w of mine) out.set(w.id, miss('no_batch'));
      continue;
    }
    if (spent()) {
      for (const w of mine) out.set(w.id, miss('budget'));
      continue;
    }
    // The band slots go where a band DECIDES first: a row whose first unit is
    // 'dona' is priced off its band or not at all, while a kg-first row
    // reads its band only if the kg series falls short. Many sizes under one
    // 10-digit code is the ordinary invoice, and first-come slots once left
    // its ninth row with no Taxminiy although its kilos had a median.
    const bands: NonNullable<ReturnType<typeof bandKeyOf>>[] = [];
    const donaFirst = (w: (typeof mine)[number]) => w.allowed[0] === 'dona';
    for (const w of [...mine.filter(donaFirst), ...mine.filter((w) => !donaFirst(w))]) {
      if (w.band && !bands.some((b) => b.key === w.band!.key) && bands.length < MAX_BANDS_PER_CODE) {
        bands.push(w.band);
      }
    }
    try {
      const rows = await underCeiling((tx) =>
        readCodeMedians(tx, { batchId: batch.batchId, tnvedCode: code, bands }),
      );
      for (const w of mine) {
        if (w.band && !bands.some((b) => b.key === w.band!.key)) {
          // Its band missed the cap: answer from the units BEFORE 'dona' in
          // its own order (the choice rule's), which need no band. A unit
          // after 'dona' would skip one the row prefers unread, so a miss
          // there is still `capped` — said, never priced around.
          const before = w.allowed.slice(0, w.allowed.indexOf('dona'));
          const ahead = medianForRow({ allowed: before, bandKey: null, rows, batch, staleCutoff });
          out.set(w.id, ahead.ok ? ahead : miss('capped'));
          continue;
        }
        out.set(
          w.id,
          medianForRow({ allowed: w.allowed, bandKey: w.band?.key ?? null, rows, batch, staleCutoff }),
        );
      }
    } catch (err) {
      if (!isQueryCanceled(err)) throw err;
      // Never the goods' names in the log — they are a customer's.
      logger.warn({ code: '57014', tnvedCode: code, batchId: batch.batchId }, '[calc-estimate] median read over its ceiling');
      for (const w of mine) out.set(w.id, miss('timeout'));
    }
  }
  return out;
}
