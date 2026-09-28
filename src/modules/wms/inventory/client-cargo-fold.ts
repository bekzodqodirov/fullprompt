import { roundKg, roundM3, shareOf, sumRounded } from '../../platform/telegram/format';
import { cargoStage, milestoneOf, MILESTONES, type StageBatch } from '../client-cabinet/stages';
import { pushLotName } from '../notices/client-text';
import { daysSince } from '../reports/dashboard-math';

/**
 * The client card's «Yuklar» tab, decided with no database and no clock of
 * its own (#166): rows in, sections and sums out. `client-cargo-now.ts` reads,
 * this folds, the page draws.
 *
 * Nothing here is a new rule about cargo:
 * - WHICH SECTION is the customer's own five steps (`milestoneOf(cargoStage)`)
 *   minus «issued», which the tab lists as history — so the office and the
 *   Mini App the client is holding cannot bucket one carton two ways (judge
 *   STRIP-1). That includes the Kashgar hub under «Tranzitda» (the design's
 *   open point 1, default a);
 * - kg and m³ are a lot's SHARE through `shareOf` and `roundKg`/`roundM3`, and
 *   every sum is `sumRounded` — the lines as printed — which is what the Mini
 *   App prints to the digit (#1114-1116);
 * - «days here» is `daysSince` on Tashkent days (R5), from the day the cargo
 *   reached the warehouse it stands in NOW (`arrivalsForPairs` with
 *   `standing`), never from the prixod's day — a lot forty days out of Yiwu
 *   and three days in Tashkent has waited three days here.
 */

/** The tab's four sections, in the customer's order. */
export const NOW_SECTIONS = ['china', 'transit', 'uz', 'ready'] as const;
export type NowSection = (typeof NOW_SECTIONS)[number];

/** What the fold needs of a truck; `client-cargo-now.ts`'s `CargoTruck` is one. */
export interface FoldTruck {
  id: string;
  code: string;
  stage: StageBatch;
}

/** What the fold needs of a row; `client-cargo-now.ts`'s `ClientCargoRow` is one. */
export interface FoldRow {
  clientId: string;
  lotId: string;
  letter: string | null;
  productZh: string;
  productRu: string | null;
  lotBoxes: number;
  lotKg: string | null;
  lotM3: string | null;
  receiptId: string;
  receiptNumber: string | null;
  receivedAt: Date;
  receiptWarehouseId: string;
  marking: string | null;
  status: string;
  warehouseId: string | null;
  whCode: string | null;
  whName: string | null;
  whCountry: string | null;
  whType: string | null;
  batchId: string | null;
  n: number;
  missing: number;
}

/** When the cartons standing in one warehouse got there (`PairArrival`'s two facts). */
export interface FoldArrival {
  codes: string[];
  batchIds: string[];
  since: Date;
}

/** One part of a mixed row: «omborda 3 · rejada 2 → B-00125». */
export interface NowPart {
  status: string;
  /** The truck a planned/loading part is going onto (the live pointer); null otherwise. */
  truckId: string | null;
  n: number;
}

export interface NowRow {
  key: string;
  section: NowSection;
  clientId: string;
  lotId: string;
  letter: string | null;
  /** The lot's name as the customer reads it (`pushLotName`'s rule). */
  name: string;
  receiptId: string;
  receiptNumber: string | null;
  receiptWarehouseId: string;
  marking: string | null;
  n: number;
  /** Null when the lot carries no weight/volume at all — never a 0 that was not measured. */
  kg: number | null;
  m3: number | null;
  parts: NowPart[];
  /** Where it stands; null when it rides a truck. */
  warehouseId: string | null;
  whCode: string | null;
  whName: string | null;
  /** The truck it rides (in_transit only). */
  truckId: string | null;
  /** Tashkent days since it reached `warehouseId`; null on a truck or unknown. */
  days: number | null;
  /** The trucks that brought what stands here (standing rows only). */
  arrivedOn: { id: string; code: string }[];
}

export interface NowTotals {
  boxes: number;
  kg: number;
  m3: number;
}

/** Cartons an unload declared missing on the road, per truck — outside every section. */
export interface NowMissing {
  truckId: string | null;
  n: number;
}

export interface CargoNow {
  sections: Record<NowSection, { rows: NowRow[]; total: NowTotals }>;
  /** The four sections' rows, summed AS PRINTED; the missing cartons are not in it. */
  total: NowTotals;
  missing: NowMissing[];
}

/** A lot figure, or null when nothing was measured (the bot's `share` refusal, #1116). */
function measured(total: string | null): number | null {
  if (total === null) return null;
  const v = Number(total);
  return Number.isFinite(v) ? v : null;
}

/**
 * «How many days has what stands here waited» — ONE function, so the parallel
 * «olib ketilmagan» list and this tab cannot count one carton two ways (the
 * tab's judge, finding 2). The arrival is `arrivalsForPairs(…, {standing:
 * true})`'s; with none (a carton that stands where it was received and never
 * moved), the prixod's own day answers — the arrival rule dates a walk-in by
 * `received_at` too. Anything else is unknown, and unknown is null, never 0.
 */
export function waitingDays(
  arrival: FoldArrival | undefined,
  row: { receivedAt: Date; receiptWarehouseId: string; warehouseId: string | null },
  today: string,
): number | null {
  if (arrival) return daysSince(arrival.since, today);
  if (row.warehouseId && row.warehouseId === row.receiptWarehouseId) return daysSince(row.receivedAt, today);
  return null;
}

/**
 * Rows → the tab. `arrivals` may be null (the «Umumiy» summary line needs the
 * counts and the Σ and pays for no arrival read); then `days` and `arrivedOn`
 * are empty and nothing else changes.
 */
export function foldCargoNow(
  rows: readonly FoldRow[],
  trucks: ReadonlyMap<string, FoldTruck>,
  arrivals: ReadonlyMap<string, FoldArrival> | null,
  today: string,
): CargoNow {
  const byKey = new Map<string, NowRow & { lotKg: number | null; lotM3: number | null; lotBoxes: number }>();
  const missingByTruck = new Map<string, number>();

  for (const r of rows) {
    const missing = r.status === 'in_transit' ? Math.min(r.missing, r.n) : 0;
    if (missing > 0) missingByTruck.set(r.batchId ?? '', (missingByTruck.get(r.batchId ?? '') ?? 0) + missing);
    const n = r.n - missing;
    if (n <= 0) continue;

    const truck = r.batchId ? trucks.get(r.batchId) : undefined;
    const stage = cargoStage(r.status, { country: r.whCountry, type: r.whType }, truck?.stage ?? null);
    const step = MILESTONES[milestoneOf(stage)] ?? 'issued';
    // Active statuses never reach «issued»; if one ever did, it is not «now».
    if (step === 'issued') continue;
    const section: NowSection = step;
    const onTruck = r.status === 'in_transit';
    const place = onTruck ? `t:${r.batchId ?? '-'}` : `w:${r.warehouseId ?? '-'}`;
    const key = `${section}|${r.lotId}|${place}`;

    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        section,
        clientId: r.clientId,
        lotId: r.lotId,
        letter: r.letter,
        name: pushLotName(r.productRu, r.productZh),
        receiptId: r.receiptId,
        receiptNumber: r.receiptNumber,
        receiptWarehouseId: r.receiptWarehouseId,
        marking: r.marking,
        n: 0,
        kg: null,
        m3: null,
        parts: [],
        warehouseId: onTruck ? null : r.warehouseId,
        whCode: onTruck ? null : r.whCode,
        whName: onTruck ? null : r.whName,
        truckId: onTruck ? r.batchId : null,
        days: null,
        arrivedOn: [],
        lotKg: measured(r.lotKg),
        lotM3: measured(r.lotM3),
        lotBoxes: r.lotBoxes,
      };
      if (!onTruck && r.warehouseId && arrivals) {
        const arrival = arrivals.get(`${r.lotId}|${r.warehouseId}`);
        row.days = waitingDays(arrival, r, today);
        row.arrivedOn = arrival ? arrival.codes.map((code, i) => ({ id: arrival.batchIds[i] ?? '', code })) : [];
      }
      byKey.set(key, row);
    }
    row.n += n;
    // A planned or loading part names the truck it is going onto; a part on
    // the shelf or at the door names none.
    const truckId = r.status === 'planned' || r.status === 'loading' ? r.batchId : null;
    const part = row.parts.find((p) => p.status === r.status && p.truckId === truckId);
    if (part) part.n += n;
    else row.parts.push({ status: r.status, truckId, n });
  }

  const sections = Object.fromEntries(
    NOW_SECTIONS.map((s) => [s, { rows: [] as NowRow[], total: { boxes: 0, kg: 0, m3: 0 } }]),
  ) as CargoNow['sections'];
  const placeLabel = (r: NowRow) =>
    r.whCode ?? (r.truckId ? (trucks.get(r.truckId)?.code ?? '') : '');

  for (const { lotKg, lotM3, lotBoxes, ...row } of byKey.values()) {
    // The share of the row's whole count, once — never a sum of per-status
    // shares, which can round the other way from the push (#1115).
    row.kg = lotKg === null ? null : roundKg(shareOf(lotKg, row.n, lotBoxes));
    row.m3 = lotM3 === null ? null : roundM3(shareOf(lotM3, row.n, lotBoxes));
    sections[row.section].rows.push(row);
  }
  for (const s of NOW_SECTIONS) {
    const list = sections[s].rows;
    // Place, then the longest wait first, then the lot's letter — the order
    // somebody working down the list rings about.
    list.sort(
      (a, b) =>
        placeLabel(a).localeCompare(placeLabel(b)) ||
        (b.days ?? -1) - (a.days ?? -1) ||
        (a.letter ?? '').localeCompare(b.letter ?? '') ||
        a.name.localeCompare(b.name),
    );
    sections[s].total = totalsOf(list);
  }

  return {
    sections,
    total: totalsOf(NOW_SECTIONS.flatMap((s) => sections[s].rows)),
    missing: [...missingByTruck]
      .map(([truckId, n]) => ({ truckId: truckId || null, n }))
      .sort((a, b) => b.n - a.n),
  };
}

/** Σ of rows as printed (`sumRounded`) — the figure a person can add up from the lines above it. */
export function totalsOf(rows: readonly { n: number; kg: number | null; m3: number | null }[]): NowTotals {
  return {
    boxes: rows.reduce((acc, r) => acc + r.n, 0),
    kg: sumRounded(rows.map((r) => r.kg ?? 0), roundKg),
    m3: sumRounded(rows.map((r) => r.m3 ?? 0), roundM3),
  };
}

/**
 * A section draws this many rows before «+N». The bot caps its answer at 20
 * lines and /stock pages its render at 120 (#527); a client with hundreds of
 * lots would otherwise put thousands of nodes on a phone (the tab's judge,
 * finding 13). `?toliq=1` draws them all; the Σ is always the whole section.
 */
export const SECTION_ROW_CAP = 40;

export function capRows<T>(rows: readonly T[], full: boolean): { drawn: readonly T[]; more: number } {
  const drawn = full ? rows : rows.slice(0, SECTION_ROW_CAP);
  return { drawn, more: rows.length - drawn.length };
}

/** How many cartons stand in each section — the «Umumiy» summary line and the tab's chips. */
export function sectionCounts(now: CargoNow): Record<NowSection, number> {
  return Object.fromEntries(NOW_SECTIONS.map((s) => [s, now.sections[s].total.boxes])) as Record<
    NowSection,
    number
  >;
}
