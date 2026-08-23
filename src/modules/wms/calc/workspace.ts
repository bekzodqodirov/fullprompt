import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  costTypes,
  telegramLinks,
  deals,
  leads,
  users,
} from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { getSetting } from '@/modules/platform/settings/service';
import { isUniqueViolation } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { notifyStaffTelegram, userName } from '@/modules/platform/notifications/staff';
import { usersWithPermission } from '@/modules/platform/notifications/service';
import { cardLink } from '@/modules/platform/notifications/links';
import { bazasFor, onDate, ratesForCodes, tariffFor, tariffZones } from './dictionaries';
import {
  groupMeasure,
  groupQuantity,
  mergeProposals,
  planBatches,
  type DraftGroup,
  type ProposedGroup,
} from './grouping';
import {
  customsFor,
  freightFor,
  isNumber,
  sectionParts,
  totalsFor,
  type BazaBasis,
  type CalcSectionName,
  type CustomsResult,
  type FreightBand,
  type FreightResult,
  type PricedItem,
} from './pricing';
import { CalcError } from './service';

/**
 * The calculation workspace (docs/VED.md phase B) — the screen that replaces
 * the Excel, and the SEAL that turns its numbers into a document.
 *
 * The whole file is built on one distinction. A price on this screen is a
 * DRAFT: it is recomputed from the dictionaries on every render, and a
 * dictionary corrected this morning changes it. A price in `calc_versions` is
 * a FACT: it is written once, carries the tariff row and every rate that made
 * it, and nothing ever edits it — which is what makes «the client was quoted
 * this» answerable a year later. The seal is the one door between them.
 *
 * The second rule, inherited from the review, is that **the model never
 * reaches a sealed number**. A proposal fills labels, codes and groupings; the
 * rates and bazas it estimates are stored in `ai_*` columns that the
 * arithmetic in `pricing.ts` cannot even name, and a group must be confirmed
 * by a person before the seal will take it.
 */

/** How long a sealed quote stands. The owner's answer: «1 oy bo'lgani yaxshi». */
export const QUOTE_VALID_DAYS_DEFAULT = 30;

const toNum = (v: string | null) => (v === null ? null : Number(v));

/** A typo is refused before it is stored — see `dictionaries.ts` for why. */
function mustBeNumber(...values: (number | null | undefined)[]): void {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (!isNumber(v)) throw new CalcError('bad_number');
  }
}

// ---------------------------------------------------------------------------
// Reading the workspace
// ---------------------------------------------------------------------------

export interface WorkspaceItem extends PricedItem {
  unit: string | null;
  volumeM3: number | null;
  tnvedCode: string | null;
  groupId: string | null;
  bazaSource: 'dictionary' | 'typed' | null;
  /** The dictionary's current answer, offered even when a value is typed. */
  dictionaryBaza: { bazaUsd: number; basis: BazaBasis; effectiveDate: string } | null;
}

export interface WorkspaceGroup {
  id: string;
  seq: number;
  label: string;
  tnvedCode: string | null;
  dutyPct: number | null;
  vatPct: number | null;
  feeUsd: number | null;
  rateSource: 'dictionary' | 'typed' | null;
  dutyFree: boolean;
  vatFree: boolean;
  aiProposed: boolean;
  aiConfidence: 'high' | 'medium' | 'low' | null;
  aiDutyPct: number | null;
  confirmedAt: Date | null;
  confirmedByName: string | null;
  note: string | null;
  items: WorkspaceItem[];
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  customs: CustomsResult;
  /** What the rates dictionary says today, for the «pull» button. */
  dictionaryRates: { dutyPct: number; vatPct: number; feeUsd: number; effectiveDate: string } | null;
}

export interface WorkspaceExtra {
  id: string;
  seq: number;
  costTypeId: string | null;
  label: string;
  amountUsd: number;
  note: string | null;
}

export interface Workspace {
  requestId: string;
  section: CalcSectionName | null;
  parts: { customs: boolean; freight: boolean; extras: boolean };
  weightKg: number | null;
  volumeM3: number | null;
  density: number | null;
  freightZone: string | null;
  zones: string[];
  guessedZone: string | null;
  fromCity: string | null;
  groups: WorkspaceGroup[];
  ungrouped: WorkspaceItem[];
  extras: WorkspaceExtra[];
  costTypeOptions: { id: string; name: string }[];
  freight: FreightResult | null;
  customsUsd: number | null;
  extrasUsd: number;
  totals: ReturnType<typeof totalsFor> | null;
  /** Everything standing between this screen and «Muhrlash». */
  blockers: SealBlocker[];
  /** Σ over the groups against what the seller declared (they can disagree). */
  reconcile: { groupKg: number | null; groupM3: number | null; mismatch: boolean };
  sealedVersion: SealedVersion | null;
  completedAt: Date | null;
}

export type SealBlocker =
  | { kind: 'section_missing' }
  | { kind: 'no_groups' }
  | { kind: 'ungrouped_items'; count: number }
  | { kind: 'groups_unconfirmed'; count: number }
  | { kind: 'customs'; groupSeq: number; groupLabel: string; reason: string; itemLabel?: string }
  | { kind: 'freight'; reason: string }
  | { kind: 'totals'; reason: string }
  | { kind: 'customs_on_yolkira' };

/**
 * A pure pre-selection, never a decision.
 *
 * The zone is a 36-58 % difference in the freight price, and `from_city` is
 * free text a seller typed on a phone. So this offers an answer and the
 * picker demands one: the seal refuses `freight_zone_required` no matter what
 * the city says.
 */
export function guessZone(fromCity: string | null): string | null {
  const c = (fromCity ?? '').toLowerCase();
  if (!c) return null;
  if (/qashqar|кашгар|kashgar|喀什/.test(c)) return 'kashgar';
  if (/yiwu|иу|义乌|guangzhou|гуанчжоу|广州|yw|gz/.test(c)) return 'cn';
  return null;
}

/**
 * The draft, as the screen sees it.
 *
 * `opts` is what the VED has typed but not yet sealed — the band override and
 * the discount. They belong HERE and not only in `sealCalc`, because the
 * blockers are computed from this draft: without them, a load at a density
 * the tariff cannot price refuses, and the override whose entire purpose is
 * to rescue exactly that load could never be reached. The screen previews
 * with the same call the seal validates with, so the two cannot disagree.
 */
export async function loadWorkspace(
  requestId: string,
  opts: { overrideDensity?: number | null; discountUsd?: number } = {},
): Promise<Workspace | null> {
  const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, requestId) });
  if (!request) return null;

  const [groupRows, itemRows, extraRows, costTypeRows, sealed] = await Promise.all([
    db.select().from(calcGroups).where(eq(calcGroups.requestId, requestId)).orderBy(asc(calcGroups.seq)),
    db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, requestId))
      .orderBy(asc(calcRequestItems.seq)),
    db.select().from(calcExtras).where(eq(calcExtras.requestId, requestId)).orderBy(asc(calcExtras.seq)),
    db
      .select({ id: costTypes.id, name: costTypes.name })
      .from(costTypes)
      .where(eq(costTypes.active, true))
      .orderBy(asc(costTypes.name)),
    currentVersion(requestId),
  ]);

  const date = onDate();
  const [bazas, rates, tariff, zones, confirmers] = await Promise.all([
    bazasFor(itemRows.map((i) => i.name), date),
    ratesForCodes(groupRows.map((g) => g.tnvedCode ?? '').filter(Boolean), date),
    tariffFor(date),
    tariffZones(date),
    namesOf(groupRows.map((g) => g.confirmedBy).filter((v): v is string => v !== null)),
  ]);

  const items: WorkspaceItem[] = itemRows.map((i) => {
    const dict = bazas.get(normalise(i.name));
    return {
      seq: i.seq,
      label: i.name,
      quantity: toNum(i.quantity),
      weightKg: toNum(i.weightKg),
      volumeM3: toNum(i.volumeM3),
      unit: i.unit,
      tnvedCode: i.tnvedCode,
      groupId: i.groupId,
      bazaUsd: toNum(i.bazaUsd),
      bazaBasis: (i.bazaBasis as BazaBasis | null) ?? null,
      bazaSource: (i.bazaSource as 'dictionary' | 'typed' | null) ?? null,
      dictionaryBaza: dict
        ? { bazaUsd: dict.bazaUsd, basis: dict.basis, effectiveDate: dict.effectiveDate }
        : null,
    };
  });

  const section = (request.section as CalcSectionName | null) ?? null;
  const parts = section ? sectionParts(section) : { customs: true, freight: true, extras: true };

  const groups: WorkspaceGroup[] = groupRows.map((g) => {
    const mine = items.filter((i) => i.groupId === g.id);
    const qty = groupQuantity(mine.map((i) => ({ quantity: i.quantity, unit: i.unit })));
    const priced = {
      seq: g.seq,
      label: g.label,
      tnvedCode: g.tnvedCode,
      dutyPct: toNum(g.dutyPct),
      vatPct: toNum(g.vatPct),
      feeUsd: toNum(g.feeUsd),
      dutyFree: g.dutyFree,
      vatFree: g.vatFree,
    };
    const dictRates = g.tnvedCode ? rates.get(g.tnvedCode) : undefined;
    return {
      id: g.id,
      ...priced,
      rateSource: (g.rateSource as 'dictionary' | 'typed' | null) ?? null,
      aiProposed: g.aiProposed,
      aiConfidence: (g.aiConfidence as 'high' | 'medium' | 'low' | null) ?? null,
      aiDutyPct: toNum(g.aiDutyPct),
      confirmedAt: g.confirmedAt,
      confirmedByName: g.confirmedBy ? (confirmers.get(g.confirmedBy) ?? null) : null,
      note: g.note,
      items: mine,
      quantity: qty.quantity,
      unit: qty.unit,
      weightKg: groupMeasure(mine.map((i) => i.weightKg)),
      volumeM3: groupMeasure(mine.map((i) => i.volumeM3)),
      customs: customsFor(priced, mine),
      dictionaryRates: dictRates
        ? {
            dutyPct: dictRates.dutyPct,
            vatPct: dictRates.vatPct,
            feeUsd: dictRates.feeUsd,
            effectiveDate: dictRates.effectiveDate,
          }
        : null,
    };
  });

  const weightKg = toNum(request.weightKg);
  const volumeM3 = toNum(request.volumeM3);

  // Freight is not computed at all for a rastamojka quote. A zero freight
  // line and no freight line total the same and read very differently on a
  // sheet the client holds.
  const freight = parts.freight
    ? freightFor(tariff, {
        zone: request.freightZone,
        weightKg,
        volumeM3,
        overrideDensity: opts.overrideDensity ?? null,
      })
    : null;

  const customsOk = groups.every((g) => g.customs.ok);
  const customsUsd = parts.customs
    ? customsOk
      ? groups.reduce((sum, g) => sum + (g.customs.ok ? g.customs.customsUsd : 0), 0)
      : null
    : 0;
  const extrasUsd = extraRows.reduce((sum, e) => sum + Number(e.amountUsd), 0);

  const totals =
    section && customsUsd !== null && (!parts.freight || freight?.ok)
      ? totalsFor({
          section,
          customsUsd,
          freightUsd: freight?.ok ? freight.listUsd : 0,
          extrasUsd,
          discountUsd: opts.discountUsd ?? 0,
          weightKg,
          volumeM3,
        })
      : null;

  const groupKg = groupMeasure(groups.map((g) => g.weightKg));
  const groupM3 = groupMeasure(groups.map((g) => g.volumeM3));

  return {
    requestId,
    section,
    parts,
    weightKg,
    volumeM3,
    density: weightKg !== null && volumeM3 !== null && volumeM3 > 0 ? weightKg / volumeM3 : null,
    freightZone: request.freightZone,
    zones,
    guessedZone: guessZone(request.fromCity),
    fromCity: request.fromCity,
    groups,
    ungrouped: items.filter((i) => i.groupId === null),
    extras: extraRows.map((e) => ({
      id: e.id,
      seq: e.seq,
      costTypeId: e.costTypeId,
      label: e.label,
      amountUsd: Number(e.amountUsd),
      note: e.note,
    })),
    costTypeOptions: costTypeRows,
    freight,
    customsUsd,
    extrasUsd,
    totals,
    blockers: blockersFor({ section, parts, groups, items, freight, totals }),
    reconcile: {
      groupKg,
      groupM3,
      // Freight reads the REQUEST's totals and customs reads the GROUPS', so
      // nothing else would tell the VED the two disagree.
      mismatch: disagrees(groupKg, weightKg) || disagrees(groupM3, volumeM3),
    },
    sealedVersion: sealed,
    completedAt: request.completedAt,
  };
}

const disagrees = (a: number | null, b: number | null) =>
  a !== null && b !== null && b > 0 && Math.abs(a - b) / b > 0.01;

function blockersFor(w: {
  section: CalcSectionName | null;
  parts: { customs: boolean; freight: boolean; extras: boolean };
  groups: WorkspaceGroup[];
  items: WorkspaceItem[];
  freight: FreightResult | null;
  totals: ReturnType<typeof totalsFor> | null;
}): SealBlocker[] {
  const out: SealBlocker[] = [];
  if (!w.section) out.push({ kind: 'section_missing' });

  if (w.parts.customs) {
    if (w.groups.length === 0) out.push({ kind: 'no_groups' });
    const ungrouped = w.items.filter((i) => i.groupId === null).length;
    if (ungrouped > 0) out.push({ kind: 'ungrouped_items', count: ungrouped });
    // Law 1: an unconfirmed group is still the model's opinion.
    const unconfirmed = w.groups.filter((g) => g.confirmedAt === null).length;
    if (unconfirmed > 0) out.push({ kind: 'groups_unconfirmed', count: unconfirmed });
    for (const g of w.groups) {
      if (!g.customs.ok) {
        out.push({
          kind: 'customs',
          groupSeq: g.seq,
          groupLabel: g.label,
          reason: g.customs.reason,
          itemLabel: g.customs.itemLabel,
        });
      }
    }
  } else if (w.groups.length > 0) {
    // A yolkira quote that carries customs groups is a section chosen wrongly.
    out.push({ kind: 'customs_on_yolkira' });
  }

  if (w.parts.freight && w.freight && !w.freight.ok) {
    out.push({ kind: 'freight', reason: w.freight.reason });
  }
  if (w.totals && !w.totals.ok) out.push({ kind: 'totals', reason: w.totals.reason });
  return out;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Every write refuses once the request is closed — a sealed price is a fact. */
async function assertOpen(requestId: string): Promise<typeof calcRequests.$inferSelect> {
  const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, requestId) });
  if (!row) throw new CalcError('not_found');
  if (row.completedAt) throw new CalcError('already_closed');
  return row;
}

export async function setFreightZone(requestId: string, zone: string | null, ctx: AuditContext) {
  await assertOpen(requestId);
  const zones = await tariffZones(onDate());
  if (zone !== null && !zones.includes(zone)) throw new CalcError('zone_unknown');
  await db
    .update(calcRequests)
    .set({ freightZone: zone, updatedAt: new Date() })
    .where(eq(calcRequests.id, requestId));
  await writeAudit(db, ctx, {
    entityType: 'calc_request',
    entityId: requestId,
    action: 'update',
    after: { freightZone: zone },
  });
}

export async function createGroup(
  requestId: string,
  input: { label: string; tnvedCode?: string | null },
  ctx: AuditContext,
): Promise<string> {
  await assertOpen(requestId);
  const seq = await nextSeq(calcGroups, requestId);
  const [row] = await db
    .insert(calcGroups)
    .values({
      requestId,
      seq,
      label: input.label.trim() || '—',
      tnvedCode: input.tnvedCode?.trim() || null,
    })
    .returning({ id: calcGroups.id });
  await writeAudit(db, ctx, {
    entityType: 'calc_group',
    entityId: row!.id,
    action: 'create',
    after: { requestId, ...input },
  });
  return row!.id;
}

/**
 * Deleting a group RE-PARENTS its items rather than orphaning them.
 *
 * The FK is `ON DELETE SET NULL`, so the cargo survives either way — but it
 * survives as «ungrouped», which is a seal blocker with a count on it, and
 * that is the only version a person can act on.
 */
export async function deleteGroup(groupId: string, ctx: AuditContext) {
  const group = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
  if (!group) throw new CalcError('not_found');
  await assertOpen(group.requestId);
  await db.delete(calcGroups).where(eq(calcGroups.id, groupId));
  await writeAudit(db, ctx, {
    entityType: 'calc_group',
    entityId: groupId,
    action: 'delete',
    before: { requestId: group.requestId, label: group.label },
  });
}

export async function moveItemToGroup(
  requestId: string,
  itemSeq: number,
  groupId: string | null,
  ctx: AuditContext,
) {
  await assertOpen(requestId);
  if (groupId) {
    const group = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
    // Re-proved server-side: a hand-posted id must not move cargo between
    // two customers' calculations.
    if (!group || group.requestId !== requestId) throw new CalcError('group_foreign');
  }
  const was = await db.query.calcRequestItems.findFirst({
    where: and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, itemSeq)),
    columns: { groupId: true },
  });
  const [moved] = await db
    .update(calcRequestItems)
    .set({ groupId })
    .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, itemSeq)))
    .returning({ id: calcRequestItems.id });
  // Both ends of the move: a group that gained or lost cargo is a group whose
  // customs figure changed, so neither may keep a ✅ from before it did.
  if (moved) {
    if (groupId) await unconfirm(groupId);
    if (was?.groupId && was.groupId !== groupId) await unconfirm(was.groupId);
  }
  await writeAudit(db, ctx, {
    entityType: 'calc_request',
    entityId: requestId,
    action: 'update',
    after: { itemSeq, groupId },
  });
}

/**
 * The group's rates.
 *
 * `source` is the fence law 1 rests on: the column's CHECK allows
 * 'dictionary' and 'typed' and NOTHING else, so a model's estimate has
 * nowhere to land however the call arrives. Changing a rate also clears the
 * confirmation — the person who confirmed did not confirm these numbers.
 */
export async function setGroupRates(
  groupId: string,
  input: {
    tnvedCode: string | null;
    dutyPct: number | null;
    vatPct: number | null;
    feeUsd: number | null;
    dutyFree: boolean;
    vatFree: boolean;
    source: 'dictionary' | 'typed';
    label?: string;
    note?: string | null;
  },
  ctx: AuditContext,
) {
  const group = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
  if (!group) throw new CalcError('not_found');
  await assertOpen(group.requestId);
  mustBeNumber(input.dutyPct, input.vatPct, input.feeUsd);
  for (const pct of [input.dutyPct, input.vatPct]) {
    if (pct !== null && (pct < 0 || pct > 100)) throw new CalcError('rate_range');
  }
  if (input.feeUsd !== null && input.feeUsd < 0) throw new CalcError('rate_range');

  await db
    .update(calcGroups)
    .set({
      label: input.label?.trim() || group.label,
      tnvedCode: input.tnvedCode?.trim() || null,
      dutyPct: input.dutyPct === null ? null : input.dutyPct.toFixed(3),
      vatPct: input.vatPct === null ? null : input.vatPct.toFixed(3),
      feeUsd: input.feeUsd === null ? null : input.feeUsd.toFixed(2),
      rateSource: input.source,
      dutyFree: input.dutyFree,
      vatFree: input.vatFree,
      note: input.note ?? group.note,
      confirmedBy: null,
      confirmedAt: null,
    })
    .where(eq(calcGroups.id, groupId));

  await writeAudit(db, ctx, {
    entityType: 'calc_group',
    entityId: groupId,
    action: 'update',
    before: {
      dutyPct: group.dutyPct,
      vatPct: group.vatPct,
      feeUsd: group.feeUsd,
      dutyFree: group.dutyFree,
      vatFree: group.vatFree,
    },
    after: input,
  });
}

export async function setItemBaza(
  requestId: string,
  itemSeq: number,
  input: { bazaUsd: number | null; basis: BazaBasis | null; source: 'dictionary' | 'typed' },
  ctx: AuditContext,
) {
  await assertOpen(requestId);
  mustBeNumber(input.bazaUsd);
  if (input.bazaUsd !== null && !(input.bazaUsd > 0)) throw new CalcError('baza_positive');
  const [changed] = await db
    .update(calcRequestItems)
    .set({
      bazaUsd: input.bazaUsd === null ? null : input.bazaUsd.toFixed(4),
      bazaBasis: input.bazaUsd === null ? null : input.basis,
      bazaSource: input.bazaUsd === null ? null : input.source,
    })
    .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, itemSeq)))
    .returning({ groupId: calcRequestItems.groupId });
  // The confirmation was about NUMBERS, and this is one of them. Changing a
  // baza under a confirmed group left the ✅ standing over a figure nobody
  // had looked at — the same rule `setGroupRates` already applies to a rate.
  if (changed?.groupId) await unconfirm(changed.groupId);
  await writeAudit(db, ctx, {
    entityType: 'calc_request',
    entityId: requestId,
    action: 'update',
    after: { itemSeq, baza: input },
  });
}

/**
 * Take a group's rates from the rates dictionary.
 *
 * The numbers are read HERE and never accepted from the caller: `rate_source`
 * records where a rate came from, and an action that stamps 'dictionary' onto
 * whatever it was handed makes that column a lie.
 */
export async function pullRatesFromDictionary(groupId: string, ctx: AuditContext): Promise<void> {
  const group = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
  if (!group) throw new CalcError('not_found');
  await assertOpen(group.requestId);
  const code = (group.tnvedCode ?? '').trim();
  if (!code) throw new CalcError('code_required');

  const hit = (await ratesForCodes([code], onDate())).get(code);
  if (!hit) throw new CalcError('rates_not_in_dictionary');

  await setGroupRates(
    groupId,
    {
      tnvedCode: code,
      dutyPct: hit.dutyPct,
      vatPct: hit.vatPct,
      feeUsd: hit.feeUsd,
      dutyFree: group.dutyFree,
      vatFree: group.vatFree,
      source: 'dictionary',
    },
    ctx,
  );
}

/** Fill every item that has no baza from the dictionary, in one pass. */
export async function pullBazasFromDictionary(requestId: string, ctx: AuditContext): Promise<number> {
  await assertOpen(requestId);
  const items = await db
    .select()
    .from(calcRequestItems)
    .where(and(eq(calcRequestItems.requestId, requestId), isNull(calcRequestItems.bazaUsd)));
  if (items.length === 0) return 0;
  const bazas = await bazasFor(items.map((i) => i.name), onDate());
  let filled = 0;
  for (const item of items) {
    const hit = bazas.get(normalise(item.name));
    if (!hit) continue;
    await db
      .update(calcRequestItems)
      .set({ bazaUsd: hit.bazaUsd.toFixed(4), bazaBasis: hit.basis, bazaSource: 'dictionary' })
      .where(eq(calcRequestItems.id, item.id));
    filled += 1;
  }
  if (filled > 0) {
    await writeAudit(db, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { bazasPulled: filled },
    });
  }
  return filled;
}

export async function confirmGroup(groupId: string, ctx: AuditContext) {
  const group = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
  if (!group) throw new CalcError('not_found');
  await assertOpen(group.requestId);
  await db
    .update(calcGroups)
    .set({ confirmedBy: ctx.actorId ?? null, confirmedAt: new Date() })
    .where(eq(calcGroups.id, groupId));
  await writeAudit(db, ctx, { entityType: 'calc_group', entityId: groupId, action: 'update', after: { confirmed: true } });
}

export async function confirmAllGroups(requestId: string, ctx: AuditContext): Promise<number> {
  await assertOpen(requestId);
  const rows = await db
    .update(calcGroups)
    .set({ confirmedBy: ctx.actorId ?? null, confirmedAt: new Date() })
    .where(and(eq(calcGroups.requestId, requestId), isNull(calcGroups.confirmedAt)))
    .returning({ id: calcGroups.id });
  if (rows.length > 0) {
    await writeAudit(db, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { confirmedGroups: rows.length },
    });
  }
  return rows.length;
}

export async function saveExtra(
  requestId: string,
  input: { id?: string; costTypeId: string | null; label: string; amountUsd: number; note: string | null },
  ctx: AuditContext,
): Promise<string> {
  await assertOpen(requestId);
  mustBeNumber(input.amountUsd);
  if (!(input.amountUsd >= 0)) throw new CalcError('amount_range');
  const label = input.label.trim();
  if (!label) throw new CalcError('label_required');

  if (input.id) {
    const existing = await db.query.calcExtras.findFirst({ where: eq(calcExtras.id, input.id) });
    if (!existing || existing.requestId !== requestId) throw new CalcError('not_found');
    await db
      .update(calcExtras)
      .set({
        costTypeId: input.costTypeId,
        label,
        amountUsd: input.amountUsd.toFixed(2),
        note: input.note,
      })
      .where(eq(calcExtras.id, input.id));
    await writeAudit(db, ctx, { entityType: 'calc_extra', entityId: input.id, action: 'update', after: input });
    return input.id;
  }

  const seq = await nextSeq(calcExtras, requestId);
  const [row] = await db
    .insert(calcExtras)
    .values({
      requestId,
      seq,
      costTypeId: input.costTypeId,
      label,
      amountUsd: input.amountUsd.toFixed(2),
      note: input.note,
    })
    .returning({ id: calcExtras.id });
  await writeAudit(db, ctx, { entityType: 'calc_extra', entityId: row!.id, action: 'create', after: input });
  return row!.id;
}

export async function deleteExtra(extraId: string, ctx: AuditContext) {
  const extra = await db.query.calcExtras.findFirst({ where: eq(calcExtras.id, extraId) });
  if (!extra) throw new CalcError('not_found');
  await assertOpen(extra.requestId);
  await db.delete(calcExtras).where(eq(calcExtras.id, extraId));
  await writeAudit(db, ctx, {
    entityType: 'calc_extra',
    entityId: extraId,
    action: 'delete',
    before: { label: extra.label, amountUsd: extra.amountUsd },
  });
}

/** Land a model proposal as draft groups. Refuses once anything is confirmed. */
export async function applyProposal(requestId: string, drafts: DraftGroup[], ctx: AuditContext) {
  await assertOpen(requestId);
  const confirmed = await db
    .select({ id: calcGroups.id })
    .from(calcGroups)
    .where(and(eq(calcGroups.requestId, requestId), sql`${calcGroups.confirmedAt} IS NOT NULL`))
    .limit(1);
  if (confirmed.length > 0) throw new CalcError('groups_confirmed');

  await db.transaction(async (tx) => {
    await tx.delete(calcGroups).where(eq(calcGroups.requestId, requestId));
    let seq = 1;
    for (const draft of drafts) {
      const [row] = await tx
        .insert(calcGroups)
        .values({
          requestId,
          seq: seq++,
          label: draft.label,
          tnvedCode: draft.tnvedCode,
          aiProposed: draft.aiProposed,
          aiConfidence: draft.confidence,
          // Recorded for phase E's «confirmed over a warning» list. The
          // arithmetic in pricing.ts cannot name this column.
          aiDutyPct: draft.aiDutyPct === null ? null : draft.aiDutyPct.toFixed(3),
          note: draft.note,
        })
        .returning({ id: calcGroups.id });
      if (draft.itemSeqs.length > 0) {
        await tx
          .update(calcRequestItems)
          .set({ groupId: row!.id })
          .where(
            and(
              eq(calcRequestItems.requestId, requestId),
              inArray(calcRequestItems.seq, draft.itemSeqs),
            ),
          );
      }
    }
  });

  await writeAudit(db, ctx, {
    entityType: 'calc_request',
    entityId: requestId,
    action: 'update',
    after: { aiGroups: drafts.length },
  });
}

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

export interface SealedVersion {
  id: string;
  requestId: string;
  versionNo: number;
  sealedAt: Date;
  sealedByName: string | null;
  validUntil: Date;
  expired: boolean;
  section: CalcSectionName;
  customsUsd: number;
  freightUsd: number;
  extrasUsd: number;
  discountUsd: number;
  discountReason: string | null;
  bandOverrideMin: number | null;
  bandOverrideReason: string | null;
  totalUsd: number;
  perM3Usd: number | null;
  perKgUsd: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  freightZone: string | null;
  freightBandMin: number | null;
  freightRate: number | null;
  freightPerKg: boolean | null;
  freightListUsd: number | null;
  breakdown: unknown;
}

export interface SealInput {
  discountUsd: number;
  discountReason: string | null;
  bandOverrideMin: number | null;
  bandOverrideReason: string | null;
}

/**
 * Seal the calculation: the one door between a draft and a fact.
 *
 * The version number comes OUT of the closing update rather than being read
 * first, so two people pressing «Muhrlash» at the same second cannot both
 * write version 3 — the second finds no row to close and is told the request
 * is already answered. `getSetting` is read BEFORE the transaction opens,
 * because a pooled call inside `db.transaction` deadlocks the pool.
 */
export async function sealCalc(
  requestId: string,
  input: SealInput,
  ctx: AuditContext,
): Promise<{ versionNo: number; totalUsd: number }> {
  // The two «say why» rules are checked before anything is loaded: they are
  // facts about the request being made, not about the cargo.
  mustBeNumber(input.discountUsd, input.bandOverrideMin);
  if (input.discountUsd < 0) throw new CalcError('amount_range');
  if (input.discountUsd > 0 && !input.discountReason?.trim()) throw new CalcError('discount_reason_required');
  if (input.bandOverrideMin !== null && !input.bandOverrideReason?.trim()) {
    throw new CalcError('band_reason_required');
  }

  // Priced with exactly what is being sealed. The override belongs in the
  // draft, not only here: a load at a density his tariff does not cover
  // refuses, and the override exists to rescue precisely that load — computed
  // afterwards, the blockers would refuse the seal before the override was
  // ever considered, and the button could never be used.
  const workspace = await loadWorkspace(requestId, {
    overrideDensity: input.bandOverrideMin,
    discountUsd: input.discountUsd,
  });
  if (!workspace) throw new CalcError('not_found');
  if (workspace.completedAt) throw new CalcError('already_closed');
  if (workspace.blockers.length > 0) throw new CalcError('not_ready');

  const section = workspace.section;
  if (!section) throw new CalcError('section_required');
  const parts = sectionParts(section);
  if (parts.freight && !workspace.freightZone) throw new CalcError('freight_zone_required');

  const freight = workspace.freight;
  if (parts.freight && !freight?.ok) throw new CalcError('freight_missing');
  const totals = workspace.totals;
  if (!totals?.ok) throw new CalcError('not_ready');

  const validDays = Number(
    (await getSetting('quote_valid_days')) ?? QUOTE_VALID_DAYS_DEFAULT,
  );
  const validUntil = new Date(Date.now() + validDays * 86_400_000);

  const breakdown = {
    groups: workspace.groups.map((g) => ({
      seq: g.seq,
      label: g.label,
      tnvedCode: g.tnvedCode,
      dutyPct: g.dutyPct,
      vatPct: g.vatPct,
      feeUsd: g.feeUsd,
      dutyFree: g.dutyFree,
      vatFree: g.vatFree,
      rateSource: g.rateSource,
      aiProposed: g.aiProposed,
      aiConfidence: g.aiConfidence,
      quantity: g.quantity,
      unit: g.unit,
      weightKg: g.weightKg,
      volumeM3: g.volumeM3,
      customs: g.customs.ok ? g.customs : null,
      items: g.items.map((i) => ({
        seq: i.seq,
        label: i.label,
        quantity: i.quantity,
        weightKg: i.weightKg,
        // Added in phase C. The map was written from `PricedItem`, which has
        // no volume because the customs arithmetic does not need one — so the
        // snapshot the migration calls «the whole snapshot … so phase E can
        // compare» could not answer «how many m³ of this item». Every reader
        // must tolerate an OLD breakdown that lacks it.
        volumeM3: i.volumeM3,
        bazaUsd: i.bazaUsd,
        bazaBasis: i.bazaBasis,
        bazaSource: i.bazaSource,
      })),
    })),
    extras: workspace.extras,
    tariffRow: freight?.ok ? freight.band : null,
    density: workspace.density,
  };

  const aiGroupsSealed = workspace.groups.filter((g) => g.aiProposed).length;
  const lowConfidenceSealed = workspace.groups.filter((g) => g.aiConfidence === 'low').length;

  const result = await db.transaction(async (tx) => {
    const closed = await tx
      .update(calcRequests)
      .set({
        completedAt: new Date(),
        completedBy: ctx.actorId ?? null,
        completedVia: 'sealed',
        currentVersionNo: sql`${calcRequests.currentVersionNo} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(calcRequests.id, requestId), isNull(calcRequests.completedAt)))
      .returning({
        versionNo: calcRequests.currentVersionNo,
        entityType: calcRequests.entityType,
        entityId: calcRequests.entityId,
        requestedBy: calcRequests.requestedBy,
      });
    const row = closed[0];
    if (!row) throw new CalcError('already_closed');

    await tx.insert(calcVersions).values({
      requestId,
      versionNo: row.versionNo,
      sealedBy: ctx.actorId!,
      validUntil,
      section,
      weightKg: workspace.weightKg === null ? null : workspace.weightKg.toFixed(3),
      volumeM3: workspace.volumeM3 === null ? null : workspace.volumeM3.toFixed(4),
      density: workspace.density === null ? null : workspace.density.toFixed(4),
      customsUsd: totals.customsUsd.toFixed(2),
      freightUsd: totals.freightUsd.toFixed(2),
      extrasUsd: totals.extrasUsd.toFixed(2),
      totalUsd: totals.totalUsd.toFixed(2),
      perM3Usd: totals.perM3Usd === null ? null : totals.perM3Usd.toFixed(2),
      perKgUsd: totals.perKgUsd === null ? null : totals.perKgUsd.toFixed(4),
      freightZone: freight?.ok ? freight.band.zone : null,
      freightBandMin: freight?.ok ? freight.band.minDensity.toFixed(2) : null,
      freightRate: freight?.ok ? freight.band.priceUsd.toFixed(4) : null,
      freightPerKg: freight?.ok ? freight.band.perKg : null,
      freightListUsd: freight?.ok ? freight.listUsd.toFixed(2) : null,
      bandOverrideMin: input.bandOverrideMin === null ? null : input.bandOverrideMin.toFixed(2),
      bandOverrideReason: input.bandOverrideReason,
      discountUsd: totals.discountUsd.toFixed(2),
      discountReason: input.discountReason,
      aiGroupsSealed,
      lowConfidenceSealed,
      breakdown,
    });

    // Law 2: the price lands on the card LOCKED. Writing it here is what
    // makes «the seller cannot change it» a fact about the data rather than
    // a fact about which buttons happen to be on screen today.
    if (row.entityType === 'lead') {
      // `leads` carries no quoted_at/quoted_by — the version holds who and
      // when, and it is the only record that cannot be edited afterwards.
      await tx
        .update(leads)
        .set({
          quotedAmount: totals.totalUsd.toFixed(2),
          quotedCurrency: 'USD',
          quotedVolumeM3: workspace.volumeM3 === null ? null : workspace.volumeM3.toFixed(3),
          quotedWeightKg: workspace.weightKg === null ? null : workspace.weightKg.toFixed(3),
          updatedAt: new Date(),
        })
        .where(eq(leads.id, row.entityId));
    } else {
      await tx
        .update(deals)
        .set({
          quotedAmount: totals.totalUsd.toFixed(2),
          quotedCurrency: 'USD',
          quotedVolumeM3: workspace.volumeM3 === null ? null : workspace.volumeM3.toFixed(3),
          quotedWeightKg: workspace.weightKg === null ? null : workspace.weightKg.toFixed(3),
          quotedAt: new Date(),
          quotedBy: ctx.actorId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(deals.id, row.entityId));
    }

    return { versionNo: row.versionNo, requestedBy: row.requestedBy, entityType: row.entityType, entityId: row.entityId };
  });

  await writeAudit(db, ctx, {
    entityType: 'calc_request',
    entityId: requestId,
    action: 'update',
    after: {
      sealed: result.versionNo,
      totalUsd: totals.totalUsd,
      discountUsd: totals.discountUsd,
      bandOverrideMin: input.bandOverrideMin,
    },
  });

  await announceSeal(result, totals, input, ctx).catch((err) =>
    logger.error({ err, requestId }, '[calc] seal notify failed'),
  );

  return { versionNo: result.versionNo, totalUsd: totals.totalUsd };
}

/**
 * Who hears about a seal.
 *
 * The requester always — it is their answer. The owner and anyone who may
 * override money hear about a CONCESSION, which is the owner's own rule:
 * «skidka berilganda biz bilishimiz kerak». A band override is announced the
 * same way, because it moves the same money by another name.
 */
async function announceSeal(
  result: { versionNo: number; requestedBy: string; entityType: string; entityId: string },
  totals: { totalUsd: number; discountUsd: number },
  input: SealInput,
  ctx: AuditContext,
) {
  const link = cardLink(result.entityType === 'lead' ? 'lead' : 'deal', result.entityId);
  const who = ctx.actorId ? await userName(ctx.actorId) : '—';
  await notifyStaffTelegram({
    userIds: [result.requestedBy],
    type: 'CalcSealed',
    text: `🧮 Hisob tayyor: $${totals.totalUsd.toFixed(2)}\n${link}`,
    exceptUserId: ctx.actorId ?? null,
  });

  if (totals.discountUsd > 0 || input.bandOverrideMin !== null) {
    const deciders = await usersWithPermission('finance.debt_override');
    const lines = [
      `⚠️ Hisobda chegirma: ${who}`,
      totals.discountUsd > 0
        ? `Chegirma: $${totals.discountUsd.toFixed(2)} — ${input.discountReason ?? '—'}`
        : null,
      input.bandOverrideMin !== null
        ? `Tarif bandi o'zgartirildi: ${input.bandOverrideMin} kg/m³ — ${input.bandOverrideReason ?? '—'}`
        : null,
      `Yakuniy: $${totals.totalUsd.toFixed(2)}`,
      link,
    ].filter(Boolean);
    await notifyStaffTelegram({
      userIds: deciders,
      type: 'CalcDiscounted',
      text: lines.join('\n'),
      exceptUserId: ctx.actorId ?? null,
    });
  }
}

export async function currentVersion(requestId: string): Promise<SealedVersion | null> {
  const [row] = await db
    .select()
    .from(calcVersions)
    .where(eq(calcVersions.requestId, requestId))
    .orderBy(desc(calcVersions.versionNo))
    .limit(1);
  if (!row) return null;
  const name = await namesOf([row.sealedBy]);
  return toVersion(row, name.get(row.sealedBy) ?? null);
}

/**
 * The card's price is the VERSION, not `answer_*`.
 *
 * Phase A's `endRequest` writes the answer columns on every ending, so a
 * request that was sealed and then ended some other way would read back the
 * later, emptier answer. The seal writes no `answer_*` at all and this is
 * what the card and the panel ask.
 */
export async function currentSealFor(
  entityType: 'deal' | 'lead',
  entityId: string,
): Promise<SealedVersion | null> {
  const [row] = await db
    .select({ v: calcVersions })
    .from(calcVersions)
    .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
    .where(and(eq(calcRequests.entityType, entityType), eq(calcRequests.entityId, entityId)))
    .orderBy(desc(calcVersions.sealedAt))
    .limit(1);
  if (!row) return null;
  const name = await namesOf([row.v.sealedBy]);
  return toVersion(row.v, name.get(row.v.sealedBy) ?? null);
}

/**
 * «Qayta hisoblash»: a correction is a NEW request seeded from the sealed one.
 *
 * Re-opening the old one by clearing `completed_at` would re-arm the overdue
 * sweep, the clock and the manual «Bajarildi» against a request that already
 * has a locked price behind it. This is also exactly what an EXPIRED quote
 * needs, so there is one path and not two.
 */
export async function recalcFromSealed(
  requestId: string,
  ctx: AuditContext,
): Promise<string> {
  const old = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, requestId) });
  if (!old) throw new CalcError('not_found');
  if (!old.completedAt) throw new CalcError('not_closed');

  const newId = await db.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(calcRequests)
      .values({
        entityType: old.entityType,
        entityId: old.entityId,
        requestedBy: ctx.actorId ?? old.requestedBy,
        assigneeId: old.assigneeId,
        itemCount: old.itemCount,
        section: old.section,
        fromCity: old.fromCity,
        toCity: old.toCity,
        weightKg: old.weightKg,
        volumeM3: old.volumeM3,
        source: old.source,
        noteId: old.noteId,
        freightZone: old.freightZone,
        supersedesRequestId: old.id,
        dueAt: new Date(Date.now() + 2 * 3_600_000),
      })
      .returning({ id: calcRequests.id });

    const items = await tx
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, requestId))
      .orderBy(asc(calcRequestItems.seq));
    const groups = await tx
      .select()
      .from(calcGroups)
      .where(eq(calcGroups.requestId, requestId))
      .orderBy(asc(calcGroups.seq));

    const groupMap = new Map<string, string>();
    for (const g of groups) {
      const [copy] = await tx
        .insert(calcGroups)
        .values({
          requestId: fresh!.id,
          seq: g.seq,
          label: g.label,
          tnvedCode: g.tnvedCode,
          dutyPct: g.dutyPct,
          vatPct: g.vatPct,
          feeUsd: g.feeUsd,
          rateSource: g.rateSource,
          dutyFree: g.dutyFree,
          vatFree: g.vatFree,
          aiProposed: g.aiProposed,
          aiConfidence: g.aiConfidence,
          aiDutyPct: g.aiDutyPct,
          note: g.note,
          // Deliberately NOT copied: a confirmation is a person saying «I
          // have looked at these numbers», and they have not looked at these.
        })
        .returning({ id: calcGroups.id });
      groupMap.set(g.id, copy!.id);
    }

    for (const item of items) {
      await tx.insert(calcRequestItems).values({
        requestId: fresh!.id,
        seq: item.seq,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        weightKg: item.weightKg,
        volumeM3: item.volumeM3,
        amount: item.amount,
        currency: item.currency,
        tnvedCode: item.tnvedCode,
        note: item.note,
        groupId: item.groupId ? (groupMap.get(item.groupId) ?? null) : null,
        bazaUsd: item.bazaUsd,
        bazaBasis: item.bazaBasis,
        bazaSource: item.bazaSource,
      });
    }

    const extras = await tx.select().from(calcExtras).where(eq(calcExtras.requestId, requestId));
    for (const extra of extras) {
      await tx.insert(calcExtras).values({
        requestId: fresh!.id,
        seq: extra.seq,
        costTypeId: extra.costTypeId,
        label: extra.label,
        amountUsd: extra.amountUsd,
        note: extra.note,
      });
    }

    return fresh!.id;
  });

  await writeAudit(db, ctx, {
    entityType: 'calc_request',
    entityId: newId,
    action: 'create',
    after: { supersedes: requestId },
  });
  return newId;
}

// ---------------------------------------------------------------------------

async function nextSeq(
  table: typeof calcGroups | typeof calcExtras,
  requestId: string,
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${table.seq})` })
    .from(table)
    .where(eq(table.requestId, requestId));
  return (row?.max ?? 0) + 1;
}

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

/** A group whose numbers moved is a group nobody has confirmed. */
async function unconfirm(groupId: string): Promise<void> {
  await db
    .update(calcGroups)
    .set({ confirmedBy: null, confirmedAt: null })
    .where(eq(calcGroups.id, groupId));
}

const normalise = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function toVersion(row: typeof calcVersions.$inferSelect, sealedByName: string | null): SealedVersion {
  return {
    id: row.id,
    requestId: row.requestId,
    versionNo: row.versionNo,
    sealedAt: row.sealedAt,
    sealedByName,
    validUntil: row.validUntil,
    // Expiry is decided at READ time, never by a sweep — `issue_approvals`'
    // rule, and the reason a quote does not need a nightly job to go stale.
    expired: row.validUntil.getTime() < Date.now(),
    section: row.section as CalcSectionName,
    customsUsd: Number(row.customsUsd),
    freightUsd: Number(row.freightUsd),
    extrasUsd: Number(row.extrasUsd),
    discountUsd: Number(row.discountUsd),
    discountReason: row.discountReason,
    bandOverrideMin: toNum(row.bandOverrideMin),
    bandOverrideReason: row.bandOverrideReason,
    totalUsd: Number(row.totalUsd),
    perM3Usd: toNum(row.perM3Usd),
    perKgUsd: toNum(row.perKgUsd),
    weightKg: toNum(row.weightKg),
    volumeM3: toNum(row.volumeM3),
    freightZone: row.freightZone,
    freightBandMin: toNum(row.freightBandMin),
    freightRate: toNum(row.freightRate),
    freightPerKg: row.freightPerKg,
    freightListUsd: toNum(row.freightListUsd),
    breakdown: row.breakdown,
  };
}

export { isUniqueViolation, type FreightBand };

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

/**
 * «AI taklif qilsin» — the model groups the goods, and nothing more.
 *
 * What comes back is labels, TNVED codes and a grouping. What does NOT come
 * back is a price: the rates and bazas it estimates are recorded in `ai_*`
 * columns whose values the arithmetic cannot reach, and every group lands
 * unconfirmed, which is a seal blocker. So the worst a bad proposal can do is
 * put the wrong words in front of a person who has to press «Tasdiqlash»
 * before anything is worth money.
 *
 * The request is CLAIMED for the duration (`ai_proposal_started_at`, set in a
 * `WHERE … IS NULL` update): two people pressing the button do not both spend
 * a model call on the same thousand goods. The claim is released in `finally`
 * — a call that failed must not lock the button until the next deploy.
 */
export async function proposeGroups(
  requestId: string,
  ctx: AuditContext,
): Promise<{ groups: number; batches: number; failed: number }> {
  await assertOpen(requestId);

  const claimed = await db
    .update(calcRequests)
    .set({ aiProposalStartedAt: new Date() })
    .where(and(eq(calcRequests.id, requestId), isNull(calcRequests.aiProposalStartedAt)))
    .returning({ id: calcRequests.id });
  if (claimed.length === 0) throw new CalcError('ai_running');

  try {
    const items = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, requestId))
      .orderBy(asc(calcRequestItems.seq));
    if (items.length === 0) throw new CalcError('no_items');

    const { proposeGoodsGrouping } = await import('../tnved/service');
    const batches = planBatches(items.length);
    const results: { offset: number; groups: ProposedGroup[] | null }[] = [];
    let failed = 0;
    for (const batch of batches) {
      const slice = items.slice(batch.offset, batch.offset + batch.count);
      try {
        const answer = await proposeGoodsGrouping(
          slice.map((i) => ({ name: i.name, quantity: toNum(i.quantity), unit: i.unit })),
        );
        results.push({ offset: batch.offset, groups: answer.groups });
      } catch (err) {
        // A batch that failed costs its own goods, not the whole file: eight
        // hundred classified beats a thousand left for the manager.
        failed += 1;
        logger.error({ err, requestId, offset: batch.offset }, '[calc] ai batch failed');
        results.push({ offset: batch.offset, groups: null });
      }
    }
    if (failed === batches.length) throw new CalcError('ai_failed');

    const drafts = mergeProposals(results, items.map((i) => i.seq));
    await applyProposal(requestId, drafts, ctx);
    return { groups: drafts.length, batches: batches.length, failed };
  } finally {
    await db
      .update(calcRequests)
      .set({ aiProposalStartedAt: null })
      .where(eq(calcRequests.id, requestId));
  }
}

// ---------------------------------------------------------------------------
// The offer (phase C)
// ---------------------------------------------------------------------------

export interface OfferResult {
  id: string;
  /** NULL while the promise is pending: there is nothing to forward yet. */
  text: string | null;
  belowFloor: boolean;
  /** FALSE when the seller has no linked staff chat — see the comment below. */
  delivered: boolean;
  /** TRUE when a below-floor price is waiting on somebody who may allow it. */
  pending: boolean;
}

/**
 * Record what a seller offered a client, and hand them the text to forward.
 *
 * The price is the SELLER's, not the sealed one. A sealed version is what the
 * calculation cost and, by the owner's law 4, the floor a client price sits
 * above — so an offer built from it prints the company's floor to the
 * customer. Quoting BELOW the floor is allowed here and recorded as
 * `below_floor`; phase D turns that into a lock.
 *
 * Delivery is reported HONESTLY. `notifyStaffTelegram` returns a queued count
 * whether or not the recipient has a linked chat, and the drain later settles
 * an unlinked one as `muted / 'telegram not linked'`, which
 * `notificationProblemCount` deliberately excludes — so a silent success here
 * is exactly how round 104's backup alarm went unnoticed for months. The
 * caller is told, and the screen says so.
 */
export async function recordOffer(
  versionId: string,
  input: {
    clientPriceUsd: number;
    locale: 'uz' | 'ru' | 'en';
    clientName?: string | null;
    /** Mandatory when the price is below the floor — a discount's own rule. */
    belowFloorReason?: string | null;
    /**
     * May this person ALLOW a below-floor promise (law 4)?
     *
     * Passed in rather than derived here, because the services in this module
     * take an actor id and never a permission set — the action asks
     * `mayApproveBelowFloor` and hands down the answer.
     */
    mayApprove?: boolean;
    /**
     * The card the caller believes this version belongs to.
     *
     * The action gates on the CARD (a lead needs `crm.leads`, a deal needs the
     * deal-write list), so it must be able to say which card it checked — and
     * this proves the version is that one. A hand-posted version id belonging
     * to somebody else's prospect reads as `not_found`, which is what it is
     * from where the caller stands.
     */
    expect?: { entityType: 'deal' | 'lead'; entityId: string };
  },
  ctx: AuditContext,
): Promise<OfferResult> {
  mustBeNumber(input.clientPriceUsd);
  if (!(input.clientPriceUsd > 0)) throw new CalcError('price_positive');
  if (!ctx.actorId) throw new CalcError('unauthenticated');

  const [row] = await db
    .select({ version: calcVersions, request: calcRequests })
    .from(calcVersions)
    .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
    .where(eq(calcVersions.id, versionId))
    .limit(1);
  if (!row) throw new CalcError('not_found');
  if (
    input.expect &&
    (row.request.entityType !== input.expect.entityType ||
      row.request.entityId !== input.expect.entityId)
  ) {
    throw new CalcError('not_found');
  }

  const v = row.version;
  const { offerText } = await import('./offer');
  const text = offerText(
    {
      clientPriceUsd: input.clientPriceUsd,
      volumeM3: toNum(v.volumeM3),
      weightKg: toNum(v.weightKg),
      section: v.section as CalcSectionName,
      fromCity: row.request.fromCity,
      toCity: row.request.toCity,
      validUntil: v.validUntil,
      clientName: input.clientName ?? null,
    },
    input.locale,
  );

  const belowFloor = input.clientPriceUsd < Number(v.totalUsd) - 0.009;
  const reason = (input.belowFloorReason ?? '').trim();
  // A below-floor price says WHY, exactly as a discount does. Without it the
  // owner's queue is a list of numbers with nobody's reasoning attached.
  if (belowFloor && !reason) throw new CalcError('below_floor_reason_required');
  // Law 4: below-floor is admin-only. What is locked is the PROMISE and not
  // the record — the row is written either way, because the flag is how the
  // owner sees who is discounting, and a door in front of a seller with a
  // customer on the phone is a door they walk around by not using the screen.
  const approved = belowFloor ? Boolean(input.mayApprove) : true;

  const [saved] = await db
    .insert(calcOffers)
    .values({
      versionId,
      entityType: row.request.entityType,
      entityId: row.request.entityId,
      clientPriceUsd: input.clientPriceUsd.toFixed(2),
      belowFloor,
      belowFloorReason: belowFloor ? reason : null,
      approvedAt: approved && belowFloor ? new Date() : null,
      approvedBy: approved && belowFloor ? ctx.actorId : null,
      locale: input.locale,
      text,
      offeredBy: ctx.actorId,
    })
    .returning({ id: calcOffers.id });

  await writeAudit(db, ctx, {
    entityType: 'calc_offer',
    entityId: saved!.id,
    action: 'create',
    after: { versionId, clientPriceUsd: input.clientPriceUsd, belowFloor, locale: input.locale },
  });

  // A PENDING promise sends nothing and hands back nothing to forward. The
  // row exists — that is the owner's visibility — but until somebody allows
  // it there is no message, no sheet and no price on the card.
  if (!approved) {
    await notifyApprovers(saved!.id, input.clientPriceUsd, Number(v.totalUsd), reason, ctx);
    return { id: saved!.id, text: null, belowFloor, delivered: false, pending: true };
  }

  await applyOfferToCard(saved!.id, row.request, input.clientPriceUsd);

  // The offer goes to the seller's OWN chat as its own message, deliberately
  // carrying no staff URL: the internal notification does that, and this is
  // the string they forward to a customer.
  const linked = await hasLinkedChat(ctx.actorId);
  if (linked) {
    await notifyStaffTelegram({
      userIds: [ctx.actorId],
      type: 'CalcOffer',
      text,
    }).catch((err) => logger.error({ err, versionId }, '[calc] offer push failed'));
  }

  return { id: saved!.id, text, belowFloor, delivered: linked, pending: false };
}

/**
 * The card carries what the CUSTOMER pays, not what the job cost us.
 *
 * `sealCalc` writes the floor onto `quoted_amount`, and every revenue surface
 * reads that column — the funnel report, five places in `salesAnalytics`, the
 * sales snapshot and the board's money line. Law 4 says the client pays the
 * VED price plus the upsale, so leaving the floor there reports the company's
 * own cost as its revenue and leaves the accountant invoicing from memory.
 *
 * The floor itself is untouched on `calc_versions`, which is where law 2's
 * lock actually lives; volume and weight stay as sealed, because they are
 * facts about the cargo and not about the price.
 */
async function applyOfferToCard(
  offerId: string,
  request: typeof calcRequests.$inferSelect,
  clientPriceUsd: number,
): Promise<void> {
  const set = { quotedAmount: clientPriceUsd.toFixed(2), quotedCurrency: 'USD', updatedAt: new Date() };
  if (request.entityType === 'lead') {
    await db.update(leads).set(set).where(eq(leads.id, request.entityId));
  } else {
    await db.update(deals).set(set).where(eq(deals.id, request.entityId));
  }
  logger.info({ offerId, entityId: request.entityId }, '[calc] client price written to card');
}

/**
 * Does this person actually have a Telegram chat we can reach?
 *
 * The SAME question the drain asks before it settles a row as
 * «telegram not linked» (notifications/service.ts:718) — asked here so the
 * screen can say so now, instead of the seller discovering minutes later that
 * nothing arrived and nothing reported it.
 */
async function hasLinkedChat(userId: string): Promise<boolean> {
  const link = await db.query.telegramLinks.findFirst({
    where: and(eq(telegramLinks.userId, userId), eq(telegramLinks.status, 'linked')),
    columns: { id: true },
  });
  return Boolean(link);
}

/** Every offer made against this card, newest first. */
export async function offersFor(
  entityType: 'deal' | 'lead',
  entityId: string,
): Promise<(typeof calcOffers.$inferSelect)[]> {
  return db
    .select()
    .from(calcOffers)
    .where(and(eq(calcOffers.entityType, entityType), eq(calcOffers.entityId, entityId)))
    .orderBy(desc(calcOffers.offeredAt))
    .limit(10);
}

/**
 * Tell whoever may allow a below-floor promise that one is waiting.
 *
 * The audience is `mayApproveBelowFloor`'s own — the same predicate the
 * button asks, so the people who can act on the message are exactly the
 * people who get it. `finance.debt_override` alone would have carried a
 * client price and a margin to every warehouse manager and to competing
 * sellers, which is a leak wearing an alarm's clothes.
 */
async function notifyApprovers(
  offerId: string,
  clientPriceUsd: number,
  floorUsd: number,
  reason: string,
  ctx: AuditContext,
): Promise<void> {
  const { approverIds } = await import('./upsale-scope');
  const userIds = await approverIds();
  if (userIds.length === 0) return;
  const gap = Math.round((floorUsd - clientPriceUsd) * 100) / 100;
  await notifyStaffTelegram({
    userIds,
    type: 'CalcBelowFloor',
    text:
      `⚠️ Tannarxdan past narx ruxsat kutmoqda\n` +
      `Narx: $${clientPriceUsd.toFixed(2)} · tannarx $${floorUsd.toFixed(2)} (−$${gap.toFixed(2)})\n` +
      `Sabab: ${reason}`,
    exceptUserId: ctx.actorId,
  }).catch((err) => logger.error({ err, offerId }, '[calc] below-floor notify failed'));
}

/**
 * Allow a pending below-floor promise, or refuse it.
 *
 * Single-shot, and the claim IS the UPDATE (0082's rule): two admins pressing
 * in the same second must not both release, because releasing is what sends
 * the customer the message. A refusal is recorded rather than deleted — the
 * owner asked to see who is discounting, and a rejected attempt is part of
 * that answer.
 */
export async function releaseOffer(offerId: string, ctx: AuditContext): Promise<OfferResult> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  const [claimed] = await db
    .update(calcOffers)
    .set({ approvedAt: new Date(), approvedBy: ctx.actorId })
    .where(and(eq(calcOffers.id, offerId), eq(calcOffers.belowFloor, true), isNull(calcOffers.approvedAt)))
    .returning();
  if (!claimed) throw new CalcError('not_pending');

  const [row] = await db
    .select({ request: calcRequests })
    .from(calcVersions)
    .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
    .where(eq(calcVersions.id, claimed.versionId))
    .limit(1);
  if (row) await applyOfferToCard(claimed.id, row.request, Number(claimed.clientPriceUsd));

  await writeAudit(db, ctx, {
    entityType: 'calc_offer',
    entityId: claimed.id,
    action: 'update',
    after: { approved: true, clientPriceUsd: Number(claimed.clientPriceUsd) },
  });

  // The seller gets the text now — it is the first moment there is one.
  const linked = await hasLinkedChat(claimed.offeredBy);
  if (linked) {
    await notifyStaffTelegram({
      userIds: [claimed.offeredBy],
      type: 'CalcOffer',
      text: claimed.text,
    }).catch((err) => logger.error({ err, offerId }, '[calc] released offer push failed'));
  }

  return {
    id: claimed.id,
    text: claimed.text,
    belowFloor: true,
    delivered: linked,
    pending: false,
  };
}

/**
 * The client price this card is currently quoted at, if one has been released.
 *
 * The newest RELEASED offer — a pending below-floor promise is not a price the
 * customer has been told, so it is not the card's price either.
 */
export async function releasedPriceFor(
  entityType: 'deal' | 'lead',
  entityId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ price: calcOffers.clientPriceUsd })
    .from(calcOffers)
    .where(
      and(
        eq(calcOffers.entityType, entityType),
        eq(calcOffers.entityId, entityId),
        sql`(NOT ${calcOffers.belowFloor} OR ${calcOffers.approvedAt} IS NOT NULL)`,
      ),
    )
    .orderBy(desc(calcOffers.offeredAt))
    .limit(1);
  return row ? Number(row.price) : null;
}
