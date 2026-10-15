import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { costEntries } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { freightCopiesFor } from './freight-copy';
import { costPool } from './pool';
import { liveFreightBills } from './freight-rollback';
import { freightSplitZone } from './freight-zone';
import { loadPoolInputs, recomputeEntry, scopeBoxIds } from './service';

/**
 * The ONE-SHOT re-split of his 2b (docs/YOLKIRA-TAQSIMOT.md §15.5), the part
 * `scripts/freight-resplit.ts` runs. A freight bill saved under 0132's client
 * grain keeps those shares until something recomputes it, while every fold
 * re-derives the LOT grain from its frozen copy — so the % and the $ on one
 * row would disagree, and «Bo'lish usuli ✎» refuses forcing it (same basis,
 * same copy). The grain is code, not part of the copy (3a freezes the TARIFF,
 * never the arithmetic), so this re-splits each live freight bill once
 * through the ordinary writer (`recomputeEntry`) over its own frozen copy.
 * Nothing else moves: not the amount, the dollars, the payer, the kassa, the
 * firm's charge, the frozen column.
 *
 * Expected on his server: NO bills (0132 shipped every warehouse without a
 * column, and he never wanted one). The dry run says so first.
 */
export interface ResplitRow {
  id: string;
  truckCode: string | null;
  amount: string;
  currency: string;
  /** The bill's own frozen column (3a); a column other than the one table is named, never moved. */
  zone: string | null;
  /** Per client (or unclaimed prixod), stored now → after the re-split, to the cent — for PRINTING. */
  before: ShareRow[];
  after: ShareRow[];
  verdict: 'split' | 'held' | 'nothing' | 'unconverted';
  /** The light / unmeasured lots a HELD after-state names (lightest first). */
  heldLots: string[];
  /**
   * Would the re-split change a single carton's share? Decided per BOX in
   * the stored $0.0001 units, never from the printed client totals (the
   * review as built): money moving only between ONE client's own lots — his
   * D's yostiq and kafel — leaves the client total equal, and a half-cent
   * rounded two ways read an untouched bill as work.
   */
  moves: boolean;
}

/** One printed line: a client (`c:<id>`) or an unclaimed prixod (`r:<id>`), its label and its dollars. */
export interface ShareRow {
  key: string;
  label: string;
  usd: number;
}

/** $0.0001 units → dollars to the cent, half up IN INTEGERS (postgres's `round(x, 2)`; `Math.round(1.005 * 100)` is 100). */
const centsOf = (units: number) => Math.floor((units + 50) / 100) / 100;
const unitsOf = (usd: string | number) => Math.round(Number(usd) * 10_000);

/** Per-key rows from per-box units, ONE way for the before, the after and the stored truth. */
function rowsOf(boxes: { key: string; label: string; units: number }[]): ShareRow[] {
  const by = new Map<string, { label: string; units: number }>();
  for (const b of boxes) {
    const row = by.get(b.key) ?? { label: b.label, units: 0 };
    row.units += b.units;
    by.set(b.key, row);
  }
  return [...by]
    .map(([key, r]) => ({ key, label: r.label, usd: centsOf(r.units) }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The bills' allocations as stored, per box, with the key and label every row prints. */
async function storedBoxes(ids: string[]): Promise<Map<string, { boxId: string; key: string; label: string; units: number }[]>> {
  const out = new Map<string, { boxId: string; key: string; label: string; units: number }[]>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT ca.cost_entry_id::text AS id, ca.box_id::text AS box_id, ca.amount_usd::text AS usd,
           CASE WHEN ca.client_id IS NOT NULL THEN 'c:' || ca.client_id::text ELSE 'r:' || rl.receipt_id::text END AS k,
           coalesce(cl.client_code, r.unclaimed_marking, r.number, '?') AS label
      FROM cost_allocations ca
      JOIN boxes bx ON bx.id = ca.box_id
      JOIN receipt_lots rl ON rl.id = bx.lot_id
      JOIN receipts r ON r.id = rl.receipt_id
      LEFT JOIN clients cl ON cl.id = ca.client_id
     WHERE ca.cost_entry_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as {
    id: string;
    box_id: string;
    usd: string;
    k: string;
    label: string;
  }[];
  for (const r of rows) {
    const list = out.get(r.id) ?? [];
    list.push({ boxId: r.box_id, key: r.k, label: r.label, units: unitsOf(r.usd) });
    out.set(r.id, list);
  }
  return out;
}

export async function resplitPlan(): Promise<ResplitRow[]> {
  const bills = await liveFreightBills();
  if (bills.length === 0) return [];
  const factor = Number(await getSetting('chargeable_weight_factor'));
  // The copy's ONE home reads it (fenced: no other file names its table).
  const copies = await freightCopiesFor(bills.map((b) => b.id));
  const zones = new Map([...copies].map(([id, c]) => [id, typeof c === 'object' ? c.zone : null] as const));
  const stored = await storedBoxes(bills.map((b) => b.id));
  const out: ResplitRow[] = [];
  for (const bill of bills) {
    const entry = await db.query.costEntries.findFirst({ where: eq(costEntries.id, bill.id) });
    if (!entry) continue;
    const { measures, freight } = await loadPoolInputs(entry, await scopeBoxIds(entry));
    const now = stored.get(bill.id) ?? [];
    let next: { boxId: string; key: string; label: string; units: number }[] = [];
    let verdict: ResplitRow['verdict'];
    let heldLots: string[] = [];
    if (entry.amountUsd === null) {
      verdict = 'unconverted';
    } else {
      const pool = costPool(
        { allocationBasis: 'freight', clientId: entry.clientId, amountUsd: Number(entry.amountUsd) },
        measures,
        factor,
        freight,
      );
      verdict = pool.kind;
      if (pool.kind === 'split') {
        const m = new Map(measures.map((x) => [x.boxId, x] as const));
        next = pool.shares.map((s) => {
          const box = m.get(s.boxId)!;
          return {
            boxId: s.boxId,
            key: s.clientId ? `c:${s.clientId}` : `r:${box.receiptId}`,
            label: s.clientId ? (box.clientCode ?? '?') : (box.unclaimedMarking ?? box.receiptNumber ?? '?'),
            units: unitsOf(s.amountUsd),
          };
        });
      } else if (pool.kind === 'held' && pool.held.reason === 'cargo') {
        heldLots = [...pool.held.measureMissing, ...pool.held.tooLight].map((l) => l.label);
      }
    }
    // An unconverted bill has no shares to move (the FX save splits it); the
    // rest move when ANY carton's stored units differ from the re-split's.
    const was = new Map(now.map((b) => [b.boxId, b.units] as const));
    const moves =
      verdict !== 'unconverted' &&
      (next.length !== now.length || next.some((b) => was.get(b.boxId) !== b.units));
    out.push({
      id: bill.id,
      truckCode: bill.truckCode,
      amount: bill.amount,
      currency: bill.currency,
      zone: zones.get(bill.id) ?? null,
      before: rowsOf(now),
      after: rowsOf(next),
      verdict,
      heldLots,
      moves,
    });
  }
  return out;
}

/** Does this bill sit on a column other than the one table? (named in the dry run, moved only by ✎) */
export const offTheOneColumn = (row: Pick<ResplitRow, 'zone'>) => row.zone !== null && row.zone !== freightSplitZone();

/**
 * `--apply`: each listed bill re-split once by the ordinary writer; one
 * failure is named and the rest still run. A re-run is safe — the recompute
 * is idempotent, so a second `--apply` finds every bill unchanged. Returns
 * what each recompute DECIDED (judge J8), so the script can say what was
 * written and not what the dry run predicted.
 */
export async function resplitApply(
  ids: string[],
): Promise<{ done: number; verdicts: Map<string, ResplitRow['verdict'] | null>; failed: { id: string; message: string }[] }> {
  let done = 0;
  const verdicts = new Map<string, ResplitRow['verdict'] | null>();
  const failed: { id: string; message: string }[] = [];
  for (const id of ids) {
    try {
      verdicts.set(id, (await recomputeEntry(id))?.kind ?? null);
      done += 1;
    } catch (err) {
      failed.push({ id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { done, verdicts, failed };
}

/**
 * The shares as STORED now, per client, for the listed bills — what the
 * script prints after `--apply` (judge J8: a carton that boarded between the
 * read and the locked recompute makes the prediction wrong, and the person
 * running it must see the stored truth). The same rows, the same rounding,
 * as the plan's `after`, so an untouched bill never reads as «changed».
 */
export async function resplitStored(ids: string[]): Promise<Map<string, ShareRow[]>> {
  const stored = await storedBoxes(ids);
  return new Map(ids.map((id) => [id, rowsOf(stored.get(id) ?? [])] as const));
}

/** Two printed row sets are the same: the same keys, the same cents. */
export const sameShares = (a: ShareRow[], b: ShareRow[]) =>
  a.length === b.length && a.every((row, i) => row.key === b[i]!.key && row.usd === b[i]!.usd);
