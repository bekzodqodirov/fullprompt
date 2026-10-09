import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { chainVersionsFor, childStateSql, type ChainVersion, type ChildState } from './chain';
import type { CalcRegistrySight } from './control-scope';
import { isAnswerSql } from './credit';
import { dutyText } from './duty-text';
import type { CalcSectionName, DutyMode } from './pricing';

/**
 * «🧮 Bitim hisobi» — a deal's calculation, laid out for reading (owner,
 * 2026-09-29, answers 19, 26a and 27a).
 *
 * WHAT IT IS: the SEALED record, read back. Every figure comes from the
 * version the VED sealed (`calc_versions` and its `breakdown` snapshot) and
 * nothing is recomputed — a sheet that re-priced from today's dictionaries
 * would print a number nobody ever quoted.
 *
 * WHO READS IT: the accountant, the admins and the VED (`mayReadCalcRegistry`
 * — the registry's own audience), and only with a `CalcRegistrySight` in hand.
 * The VED sees the calculation's total, which is their own work (26a); the
 * type below has NO field for a client price, an offer, a quote or an upsale —
 * those stay in the pricing page's `dealPriceSight` block and nowhere else
 * (law 4). `deals.quoted_amount` is deliberately never read here: after a
 * released offer it IS the client price (#793).
 */

export type CalcSheetStatus = 'stands' | 'recalc_open' | 'superseded';

export interface CalcSheetItem {
  name: string;
  /** 7a's «qty»: the item's count and the unit it was counted in, as sealed. */
  quantity: number | null;
  unit: string | null;
  bazaUsd: number | null;
  basis: string | null;
  kg: number | null;
  m3: number | null;
  measureUnit: string | null;
  measureQty: number | null;
}

export interface CalcSheetGroup {
  code: string | null;
  label: string;
  /** The whole law in one cell (`duty-text.ts`), «—» when an old snapshot has none. */
  dutyText: string;
  /** The law's columns, as sealed — what the sheet words the shape from
   * («20 %, kamida $3/juft»); null percentages on an old snapshot. */
  dutyPct: number | null;
  dutyMode: DutyMode;
  dutySpecific: number | null;
  dutyUnit: string | null;
  vatPct: number | null;
  excisePct: number | null;
  /** 0131's specific excise — absent (null) on every older snapshot. */
  exciseSpecific: number | null;
  exciseUnit: string | null;
  /** The lgota the seal applied (P2.7): «boj yo‘q (lgota)», «QQS yo‘q (lgota)». */
  dutyFree: boolean;
  vatFree: boolean;
  /** The certificate answer the seal priced with — null on an old snapshot. */
  hasCertificate: boolean | null;
  /** The customs VALUE the duty was taken on, as sealed — «—» on an old snapshot. */
  valueUsd: number | null;
  customsUsd: number | null;
  /**
   * What the group's customs is MADE of, as sealed (P2.7) — duty, the
   * certificate's additional duty, excise and VAT. They ADD UP to
   * `customsUsd` by the engine's own construction (`sheetPartsAddUp` says so
   * in a test). Null on a snapshot with no customs receipt.
   */
  parts: {
    dutyUsd: number;
    addDutyPct: number;
    addDutyUsd: number;
    exciseUsd: number;
    vatUsd: number;
  } | null;
  items: CalcSheetItem[];
}

/**
 * The declaration fee, as sealed, with the inputs that made it (P2.6) — so
 * a sealed fee explains itself after the BHM setting and the rate book have
 * both moved. Every input is null on a snapshot sealed before 0131's round.
 */
export interface CalcSheetFee {
  usd: number;
  bhm: number | null;
  overridden: boolean;
  bhmUzs: number | null;
  fxUzsPerUsd: number | null;
  fxDate: string | null;
}

export interface CalcSheet {
  requestId: string;
  section: CalcSectionName;
  /** The rank in the correction chain — what «V2» prints everywhere (chain.ts). */
  quoteNo: number;
  sealedAt: Date;
  sealedByName: string | null;
  validUntil: Date;
  expired: boolean;
  status: CalcSheetStatus;
  /** How the correction ended, for the chip's words (chain.ts `ChildState`). */
  childState: ChildState | null;
  groups: CalcSheetGroup[];
  feeUsd: number | null;
  /** The fee's receipt (P2.6), null where the seal carried none. */
  fee: CalcSheetFee | null;
  freight: {
    zone: string | null;
    bandMin: number | null;
    rate: number | null;
    perKg: boolean | null;
    listUsd: number | null;
  } | null;
  discountUsd: number;
  extrasUsd: number;
  totalUsd: number;
  perM3Usd: number | null;
  perKgUsd: number | null;
  /** From `calc_request_items` — the one source a yo'lkira seal has (#874). */
  goods: { name: string; kg: number | null; m3: number | null }[];
  /** The chain's older prices, newest first («V1» under «V2»). */
  previous: { quoteNo: number; sealedAt: Date; totalUsd: number }[];
}

/** A Готово answer — a price a VED typed without sealing (27a): «muhrlanmagan». */
export interface CalcAnswer {
  requestId: string;
  section: CalcSectionName | null;
  amount: number;
  currency: string | null;
  note: string | null;
  completedAt: Date;
  byName: string | null;
  /** A correction off this answer, and how it ended — the same words the
   * seller's push and the chain chip use (review ved-correctness-2). */
  childState: ChildState | null;
}

/** One item of a request's goods, read from its own row — its baza lives on the ITEM. */
export interface CalcGoodsItem {
  name: string;
  tnvedCode: string | null;
  quantity: number | null;
  unit: string | null;
  kg: number | null;
  m3: number | null;
  bazaUsd: number | null;
  basis: string | null;
  measureUnit: string | null;
  measureQty: number | null;
}

/** A group of a request's goods — the code and the law, NEVER a customs sum. */
export interface CalcGoodsGroup {
  code: string | null;
  label: string;
  dutyText: string;
  vatPct: number | null;
  items: CalcGoodsItem[];
}

/**
 * The goods of a request that has no SEALED snapshot — a Готово answer (7a,
 * 8a) or a hand-back (10a's closed page) — read back from the request's own
 * rows, which every writer froze at the ending (`already_closed`).
 *
 * Deliberately NO per-group rastamojka (review ved-correctness-14): an answer
 * is one typed figure, and a group's sum recomputed today would be a draft
 * nobody sealed or gave, printed as if it were part of the answer. (Only the
 * per-declaration fee would need today's FX and `bhm_uzs`; the groups' own
 * arithmetic would not — which is exactly why it would look authoritative.)
 * Ungrouped or uncoded items — every Готово job has a blocker by #880's
 * construction — list with «—».
 */
export interface CalcGoodsSheet {
  requestId: string;
  groups: CalcGoodsGroup[];
  ungrouped: CalcGoodsItem[];
}

/** The sealed version's own row, as `calcSheetOf` reads it — raw, tolerant. */
export interface SheetVersionRow {
  id: string;
  requestId: string;
  section: string;
  sealedAt: Date;
  validUntil: Date;
  totalUsd: number;
  perM3Usd: number | null;
  perKgUsd: number | null;
  discountUsd: number;
  extrasUsd: number;
  freightZone: string | null;
  freightBandMin: number | null;
  freightRate: number | null;
  freightPerKg: boolean | null;
  freightListUsd: number | null;
  breakdown: unknown;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const DUTY_MODES: readonly DutyMode[] = ['advalor', 'specific', 'max', 'plus'];

/**
 * One sealed version as a sheet. Pure, and TOLERANT: a breakdown sealed
 * before phase C has no item `volumeM3`, one before 0091 no `dutyMode`, one
 * before 0092 no measure pair — each reads as «—» (null), never NaN, never a
 * $0 somebody could take for a figure.
 */
export function calcSheetOf(
  version: SheetVersionRow,
  items: { name: string; weightKg: unknown; volumeM3: unknown }[],
  chain: ChainVersion[],
  now = new Date(),
): CalcSheet {
  const breakdown = (version.breakdown ?? {}) as Record<string, unknown>;
  const rawGroups = Array.isArray(breakdown.groups) ? (breakdown.groups as Record<string, unknown>[]) : [];
  const groups: CalcSheetGroup[] = rawGroups.map((g) => {
    const mode = DUTY_MODES.includes(g.dutyMode as DutyMode) ? (g.dutyMode as DutyMode) : 'advalor';
    const dutyPct = num(g.dutyPct);
    const hasLaw = dutyPct !== null || num(g.dutySpecific) !== null;
    const customs = (g.customs ?? null) as Record<string, unknown> | null;
    const rawItems = Array.isArray(g.items) ? (g.items as Record<string, unknown>[]) : [];
    const part = (k: string) => (customs ? num(customs[k]) : null);
    const dutyUsd = part('dutyUsd');
    const vatUsd = part('vatUsd');
    return {
      code: text(g.tnvedCode),
      label: text(g.label) ?? '—',
      dutyText: hasLaw
        ? dutyText({
            dutyPct,
            dutyMode: mode,
            dutySpecific: num(g.dutySpecific),
            dutyUnit: text(g.dutyUnit),
          })
        : '—',
      dutyPct,
      dutyMode: mode,
      dutySpecific: num(g.dutySpecific),
      dutyUnit: text(g.dutyUnit),
      vatPct: num(g.vatPct),
      excisePct: num(g.excisePct),
      exciseSpecific: num(g.exciseSpecific),
      exciseUnit: text(g.exciseUnit),
      dutyFree: g.dutyFree === true,
      vatFree: g.vatFree === true,
      hasCertificate: typeof g.hasCertificate === 'boolean' ? g.hasCertificate : null,
      valueUsd: customs ? num(customs.valueUsd) : null,
      customsUsd: customs ? num(customs.customsUsd) : null,
      // The parts only when the receipt carries the two every breakdown has
      // had since phase B — an old one prints its total and nothing to add up.
      parts:
        dutyUsd !== null && vatUsd !== null
          ? {
              dutyUsd,
              addDutyPct: part('addDutyPct') ?? 0,
              addDutyUsd: part('addDutyUsd') ?? 0,
              exciseUsd: part('exciseUsd') ?? 0,
              vatUsd,
            }
          : null,
      items: rawItems.map((i) => ({
        name: text(i.label) ?? '—',
        quantity: num(i.quantity),
        // The breakdown names the unit on the GROUP (one code, one unit) and
        // an item's own measure pair when it has one.
        unit: text(i.unit) ?? text(g.unit),
        bazaUsd: num(i.bazaUsd),
        basis: text(i.bazaBasis),
        kg: num(i.weightKg),
        m3: num(i.volumeM3),
        measureUnit: text(i.measureUnit),
        measureQty: num(i.measureQty),
      })),
    };
  });
  const fee = (breakdown.fee ?? null) as Record<string, unknown> | null;
  const hasFreight = version.freightZone !== null || version.freightListUsd !== null;
  const mine = chain.find((v) => v.versionId === version.id);
  const quoteNo = mine?.quoteNo ?? 1;
  return {
    requestId: version.requestId,
    section: version.section as CalcSectionName,
    quoteNo,
    sealedAt: version.sealedAt,
    sealedByName: mine?.sealedByName ?? null,
    validUntil: version.validUntil,
    expired: version.validUntil.getTime() < now.getTime(),
    status: mine?.recalcOpen ? 'recalc_open' : mine?.superseded ? 'superseded' : 'stands',
    childState: mine?.childState ?? null,
    groups,
    feeUsd: fee ? num(fee.feeUsd) : null,
    fee:
      fee && num(fee.feeUsd) !== null
        ? {
            usd: num(fee.feeUsd)!,
            bhm: fee.overridden === true ? null : num(fee.bhmCoefficient),
            overridden: fee.overridden === true,
            bhmUzs: num(fee.bhmUzs),
            fxUzsPerUsd: num(fee.fxUzsPerUsd),
            fxDate: text(fee.fxDate),
          }
        : null,
    freight: hasFreight
      ? {
          zone: version.freightZone,
          bandMin: version.freightBandMin,
          rate: version.freightRate,
          perKg: version.freightPerKg,
          listUsd: version.freightListUsd,
        }
      : null,
    discountUsd: version.discountUsd,
    extrasUsd: version.extrasUsd,
    totalUsd: version.totalUsd,
    perM3Usd: version.perM3Usd,
    perKgUsd: version.perKgUsd,
    goods: items.map((i) => ({ name: i.name, kg: num(i.weightKg), m3: num(i.volumeM3) })),
    previous: chain
      .filter((v) => v.quoteNo < quoteNo)
      .sort((a, b) => b.quoteNo - a.quoteNo)
      .map((v) => ({ quoteNo: v.quoteNo, sealedAt: v.sealedAt, totalUsd: v.totalUsd })),
  };
}

/**
 * Do the parts the sheet prints ADD UP to the group total it prints (P2.7)?
 * The engine builds `customsUsd` as exactly duty + additional duty + excise +
 * VAT (the group carries no fee, #858), each rounded to the cent first — so a
 * sheet that prints all four beside the total is a sum a person can check by
 * hand. Pure, for the test that holds the printed lines to it.
 */
export function sheetPartsAddUp(g: Pick<CalcSheetGroup, 'parts' | 'customsUsd'>): boolean {
  if (!g.parts || g.customsUsd === null) return false;
  const sum = g.parts.dutyUsd + g.parts.addDutyUsd + g.parts.exciseUsd + g.parts.vatUsd;
  return Math.abs(sum - g.customsUsd) < 0.005;
}

type VersionDbRow = {
  id: string;
  request_id: string;
  section: string;
  sealed_at: string;
  valid_until: string;
  total_usd: string;
  per_m3_usd: string | null;
  per_kg_usd: string | null;
  discount_usd: string;
  extras_usd: string;
  freight_zone: string | null;
  freight_band_min: string | null;
  freight_rate: string | null;
  freight_per_kg: boolean | null;
  freight_list_usd: string | null;
  breakdown: unknown;
};

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** The versions' own rows and their requests' goods — queries 3 and 4. */
async function versionsAndGoods(versionIds: string[]): Promise<{
  versions: Map<string, SheetVersionRow>;
  goods: Map<string, { name: string; weightKg: unknown; volumeM3: unknown }[]>;
}> {
  const versions = new Map<string, SheetVersionRow>();
  const goods = new Map<string, { name: string; weightKg: unknown; volumeM3: unknown }[]>();
  if (versionIds.length === 0) return { versions, goods };
  const rows = await db.execute<VersionDbRow>(sql`
    SELECT v.id::text AS id, v.request_id::text AS request_id, v.section, v.sealed_at, v.valid_until,
           v.total_usd, v.per_m3_usd, v.per_kg_usd, v.discount_usd, v.extras_usd,
           v.freight_zone, v.freight_band_min, v.freight_rate, v.freight_per_kg, v.freight_list_usd,
           v.breakdown
      FROM calc_versions v WHERE v.id IN (${idList(versionIds)})
  `);
  for (const r of rows) {
    // Raw `db.execute` timestamps are TEXT (#923).
    versions.set(r.id, {
      id: r.id,
      requestId: r.request_id,
      section: r.section,
      sealedAt: new Date(r.sealed_at),
      validUntil: new Date(r.valid_until),
      totalUsd: Number(r.total_usd),
      perM3Usd: r.per_m3_usd === null ? null : Number(r.per_m3_usd),
      perKgUsd: r.per_kg_usd === null ? null : Number(r.per_kg_usd),
      discountUsd: Number(r.discount_usd ?? 0),
      extrasUsd: Number(r.extras_usd ?? 0),
      freightZone: r.freight_zone,
      freightBandMin: r.freight_band_min === null ? null : Number(r.freight_band_min),
      freightRate: r.freight_rate === null ? null : Number(r.freight_rate),
      freightPerKg: r.freight_per_kg,
      freightListUsd: r.freight_list_usd === null ? null : Number(r.freight_list_usd),
      breakdown: r.breakdown,
    });
  }
  const requestIds = [...new Set(rows.map((r) => r.request_id))];
  if (requestIds.length > 0) {
    const items = await db.execute<{ request_id: string; name: string; weight_kg: string | null; volume_m3: string | null }>(sql`
      SELECT i.request_id::text AS request_id, i.name, i.weight_kg, i.volume_m3
        FROM calc_request_items i WHERE i.request_id IN (${idList(requestIds)})
       ORDER BY i.request_id, i.seq
    `);
    for (const i of items) {
      const list = goods.get(i.request_id) ?? [];
      list.push({ name: i.name, weightKg: i.weight_kg, volumeM3: i.volume_m3 });
      goods.set(i.request_id, list);
    }
  }
  return { versions, goods };
}

/** How many chains a deal prints in full; the rest are counted. */
export const SHEETS_PER_DEAL = 3;

/**
 * Every deal's calculations, for a page of lots — at most four queries
 * whatever the number of deals (#432): the deals' requests, their chains
 * (`chainVersionsFor`, one query), the newest versions' rows, their goods.
 *
 * THE DISPLAY RULE, and deliberately not a money rule. `notSupersededSql` and
 * `answerFloorStandsSql` decide what a COMMISSION is paid on (version-set.ts)
 * and would, for instance, hide a rastamojka answer the moment a yo'lkira job
 * on the same card is sealed — a different job, still the answer to its own
 * question. Here each chain's NEWEST seal prints in full with a status word
 * (a correction being written keeps the old price standing), older seals
 * print under it, and an answer prints while no SEALED correction replaced
 * its own request — in any currency, marked «muhrlanmagan».
 */
export async function dealCalcSheets(
  dealIds: string[],
  _sight: CalcRegistrySight,
): Promise<Map<string, { sheets: CalcSheet[]; answers: CalcAnswer[]; more: number }>> {
  const out = new Map<string, { sheets: CalcSheet[]; answers: CalcAnswer[]; more: number }>();
  const ids = [...new Set(dealIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const requests = await db.execute<{
    id: string;
    deal_id: string;
    section: string | null;
    completed_at: string | null;
    completed_via: string | null;
    answer_amount: string | null;
    answer_currency: string | null;
    answer_note: string | null;
    by_name: string | null;
    is_answer: boolean;
    child_state: ChildState | null;
    replaced: boolean;
  }>(sql`
    SELECT r.id::text AS id, r.entity_id::text AS deal_id, r.section, r.completed_at, r.completed_via,
           r.answer_amount, r.answer_currency, r.answer_note, u.full_name AS by_name,
           ${isAnswerSql('r')} AS is_answer,
           ${childStateSql(sql.raw('r.id'))} AS child_state,
           EXISTS (
             SELECT 1 FROM calc_requests c JOIN calc_versions cv ON cv.request_id = c.id
              WHERE c.supersedes_request_id = r.id
           ) AS replaced
      FROM calc_requests r
      LEFT JOIN users u ON u.id = r.completed_by
     WHERE r.entity_type = 'deal' AND r.entity_id IN (${idList(ids)})
  `);
  for (const id of ids) out.set(id, { sheets: [], answers: [], more: 0 });

  const chains = await chainVersionsFor(requests.map((r) => r.id));
  // One chain per deal, however many of its requests sit in it: the chain's
  // oldest seal names it.
  const chainsOfDeal = new Map<string, Map<string, ChainVersion[]>>();
  for (const r of requests) {
    const chain = chains.get(r.id) ?? [];
    if (chain.length === 0) continue;
    const perDeal = chainsOfDeal.get(r.deal_id) ?? new Map<string, ChainVersion[]>();
    perDeal.set(chain[0]!.versionId, chain);
    chainsOfDeal.set(r.deal_id, perDeal);
  }
  const shownVersions: string[] = [];
  const shownChains = new Map<string, ChainVersion[][]>();
  for (const [dealId, perDeal] of chainsOfDeal) {
    const ordered = [...perDeal.values()].sort(
      (a, b) => b[b.length - 1]!.sealedAt.getTime() - a[a.length - 1]!.sealedAt.getTime(),
    );
    const shown = ordered.slice(0, SHEETS_PER_DEAL);
    shownChains.set(dealId, shown);
    out.get(dealId)!.more = ordered.length - shown.length;
    for (const chain of shown) shownVersions.push(chain[chain.length - 1]!.versionId);
  }

  const { versions, goods } = await versionsAndGoods(shownVersions);
  for (const [dealId, shown] of shownChains) {
    for (const chain of shown) {
      const newest = versions.get(chain[chain.length - 1]!.versionId);
      if (!newest) continue;
      out.get(dealId)!.sheets.push(calcSheetOf(newest, goods.get(newest.requestId) ?? [], chain));
    }
  }

  for (const r of requests) {
    // THE answer predicate (credit.ts), plus the sheet's own display clause:
    // an answer prints until a SEALED correction replaces its request. An
    // open, answered or returned correction keeps it on the sheet with the
    // chip saying so — the same words the seller's push used.
    if (!r.is_answer || r.replaced || !r.completed_at) continue;
    out.get(r.deal_id)!.answers.push({
      requestId: r.id,
      section: (r.section as CalcSectionName | null) ?? null,
      amount: Number(r.answer_amount),
      currency: r.answer_currency,
      note: r.answer_note,
      completedAt: new Date(r.completed_at),
      byName: r.by_name,
      childState: r.child_state ?? null,
    });
  }
  for (const entry of out.values()) {
    entry.answers.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
  }
  return out;
}

/**
 * The same sheet for ONE request — what the VED's own workspace mounts under
 * its sealed price (audit A39): the request's newest seal, its chain's older
 * prices under it. Null when the request has never been sealed.
 */
export async function calcSheetsForRequest(
  requestId: string,
  _sight: CalcRegistrySight,
): Promise<CalcSheet | null> {
  const chain = (await chainVersionsFor([requestId])).get(requestId) ?? [];
  const own = chain.filter((v) => v.requestId === requestId);
  const newestOwn = own[own.length - 1];
  if (!newestOwn) return null;
  const { versions, goods } = await versionsAndGoods([newestOwn.versionId]);
  const version = versions.get(newestOwn.versionId);
  if (!version) return null;
  return calcSheetOf(version, goods.get(requestId) ?? [], chain);
}

type GoodsItemRow = {
  item_name: string;
  item_code: string | null;
  quantity: string | null;
  unit: string | null;
  weight_kg: string | null;
  volume_m3: string | null;
  baza_usd: string | null;
  baza_basis: string | null;
  measure_unit: string | null;
  measure_qty: string | null;
  group_id: string | null;
  group_label: string | null;
  group_code: string | null;
  duty_pct: string | null;
  duty_mode: string | null;
  duty_specific: string | null;
  duty_unit: string | null;
  vat_pct: string | null;
};

/**
 * One request's goods as a sheet (`CalcGoodsSheet`), in one query: each item
 * with its own baza, under its group's code and law, groups in their order.
 * The caller decides WHICH requests may be read this way — the goods route
 * answers only for a registry row, the closed page only for `ved.docs`.
 */
export async function requestGoodsSheet(
  requestId: string,
  _sight: CalcRegistrySight,
): Promise<CalcGoodsSheet> {
  const rows = await db.execute<GoodsItemRow>(sql`
    SELECT i.name AS item_name, i.tnved_code AS item_code, i.quantity, i.unit, i.weight_kg, i.volume_m3,
           i.baza_usd, i.baza_basis, i.measure_unit, i.measure_qty,
           g.id::text AS group_id, g.label AS group_label, g.tnved_code AS group_code,
           g.duty_pct, g.duty_mode, g.duty_specific, g.duty_unit, g.vat_pct
      FROM calc_request_items i
      LEFT JOIN calc_groups g ON g.id = i.group_id
     WHERE i.request_id = ${requestId}::uuid
     ORDER BY g.seq NULLS LAST, i.seq
  `);
  const groups = new Map<string, CalcGoodsGroup>();
  const ungrouped: CalcGoodsItem[] = [];
  for (const r of rows) {
    const item: CalcGoodsItem = {
      name: r.item_name,
      tnvedCode: text(r.item_code) ?? text(r.group_code),
      quantity: num(r.quantity),
      unit: text(r.unit),
      kg: num(r.weight_kg),
      m3: num(r.volume_m3),
      bazaUsd: num(r.baza_usd),
      basis: text(r.baza_basis),
      measureUnit: text(r.measure_unit),
      measureQty: num(r.measure_qty),
    };
    if (!r.group_id) {
      ungrouped.push(item);
      continue;
    }
    let group = groups.get(r.group_id);
    if (!group) {
      const dutyPct = num(r.duty_pct);
      const mode = DUTY_MODES.includes(r.duty_mode as DutyMode) ? (r.duty_mode as DutyMode) : 'advalor';
      const hasLaw = dutyPct !== null || num(r.duty_specific) !== null;
      group = {
        code: text(r.group_code),
        label: text(r.group_label) ?? '—',
        dutyText: hasLaw
          ? dutyText({ dutyPct, dutyMode: mode, dutySpecific: num(r.duty_specific), dutyUnit: text(r.duty_unit) })
          : '—',
        vatPct: num(r.vat_pct),
        items: [],
      };
      groups.set(r.group_id, group);
    }
    group.items.push(item);
  }
  return { requestId, groups: [...groups.values()], ungrouped };
}
