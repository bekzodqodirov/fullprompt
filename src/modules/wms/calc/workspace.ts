import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  costTypes,
  deals,
  fxRates,
  leads,
  receipts,
  tasks,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { getSetting } from '@/modules/platform/settings/service';
import { isUniqueViolation } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { recordAiPass } from './ai-cost';
import { stampCalcLinksTx } from './link';
import { itemNameNorm, memoryProvenanceFor, sealedMemoryFor } from './memory';
import { aiConfigured } from '@/modules/platform/ai/model';
import { notifyStaffTelegram, userName } from '@/modules/platform/notifications/staff';
import { usersWithRoles } from '@/modules/platform/notifications/service';
import { cardLink } from '@/modules/platform/notifications/links';
import {
  BAZA_STALE_DAYS,
  bazasFor,
  onDate,
  ratesForCodes,
  tariffFor,
  tariffZones,
  type RatesRow,
} from './dictionaries';
import { answerFloorStandsSql, currentVersionSql, notSupersededSql } from './version-set';
import { basisConflicts, defaultBasisFor, pairUnitFor } from './basis';
import {
  BASIS_FOR_UNIT,
  importRowForCode,
  suggestImportBaza,
  unitsForRow,
  type ImportBazaRow,
} from '../customs/import-baza';
import { newestReadyBatchId } from '../customs/import-service';
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
  isBazaBasis,
  isNumber,
  pricedGroupOf,
  requestCustomsFor,
  sectionParts,
  totalsFor,
  type BazaBasis,
  type BazaSource,
  type CalcSectionName,
  type CustomsResult,
  type DutyMode,
  type DutyUnit,
  type FeeResult,
  type FreightBand,
  type FreightResult,
  type MeasureUnit,
  type PricedItem,
} from './pricing';
import {
  CalcError,
  MAX_CALC_ITEMS,
  calcDueMinutes,
  linkLine,
  nextVedAssignee,
  requestLabel,
  vedRotaPool,
} from './service';
import { childStateSql } from './chain';
import { isAnswer, isAnswerSql } from './credit';
import { createTask } from '@/modules/platform/tasks/service';
import { retireTaskCopiesSoon } from '@/modules/platform/notifications/retire-tasks';
import { kickPriceChannel } from './channel-queue';
import { forgetUpsaleLiability } from './liability-memo';
import {
  sealCounters,
  unchangedFromProposal,
  warningsForGroup,
  type CalcWarningKind,
  type ProposalSnapshot,
} from './warnings';

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
  /** The immutable address (phase 3): seqs are re-minted after a delete, so
   * drafts and edits key on the id or a stranded draft lands on new cargo. */
  id: string;
  /** The SELLER's own unit word («шт», «кг», «компл») — display only (his
   * 20a). The engine never reads it: what a baza is per is `bazaBasis`. */
  unit: string | null;
  tnvedCode: string | null;
  note: string | null;
  groupId: string | null;
  bazaSource: BazaSource;
  /** The customs-import row this baza was taken from — the provenance behind
   * the «📥 taxmin» chip, and what the picker re-opens on. */
  importRowId: string | null;
  /** The sealed answer this baza was copied from (0096) — the 🧠 chip's
   * title. Null on every other source. */
  memoryFrom: { sealedAt: string; sealedByName: string | null } | null;
  /** WHY the model chose this declaration and not the one beside it (0096,
   * owed since #909). Words, never a number. */
  bazaReason: string | null;
  /** The dictionary's current answer, offered even when a value is typed. */
  dictionaryBaza: { bazaUsd: number; basis: BazaBasis; effectiveDate: string; stale: boolean } | null;
}

export interface WorkspaceGroup {
  id: string;
  seq: number;
  label: string;
  tnvedCode: string | null;
  dutyPct: number | null;
  vatPct: number | null;
  feeUsd: number | null;
  /** The law's shape (VED 2.0): stored NULL reads as 'advalor'. */
  dutyMode: DutyMode;
  dutySpecific: number | null;
  dutyUnit: DutyUnit | null;
  excisePct: number | null;
  /** The group's own answer — null inherits the request's. */
  hasCertificate: boolean | null;
  /** Resolved: the group's answer, else the request's. What the engine used. */
  effectiveCertificate: boolean;
  rateSource: 'dictionary' | 'typed' | null;
  dutyFree: boolean;
  vatFree: boolean;
  aiProposed: boolean;
  aiConfidence: 'high' | 'medium' | 'low' | null;
  aiDutyPct: number | null;
  confirmedAt: Date | null;
  confirmedByName: string | null;
  /** How it was confirmed, and what stood on the screen when it was (phase E). */
  confirmVia: 'single' | 'bulk' | null;
  confirmedWarnings: CalcWarningKind[] | null;
  /** What needs a second look RIGHT NOW — recomputed every render. */
  warnings: CalcWarningKind[];
  note: string | null;
  items: WorkspaceItem[];
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  customs: CustomsResult;
  /** What the rates dictionary says today, for the «pull» button. */
  dictionaryRates: {
    dutyPct: number;
    vatPct: number;
    feeUsd: number;
    dutyMode: DutyMode;
    dutySpecific: number | null;
    dutyUnit: DutyUnit | null;
    /** The stored code that answered — a prefix when the group's own code
     * has no row of its own (6403 answering for 6403520000). */
    matchedCode: string;
    effectiveDate: string;
    /** The law's own condition on this row, when it has one — rendered as a
     * visible warn chip, and recorded by the confirm (`rate_noted`). */
    note: string | null;
  } | null;
  /**
   * Law 7's second half: how this code's lgota was decided the LAST time a
   * person sealed it — the offered default, never an applied one. Non-null
   * only when the last decision carried an exemption; declining one is
   * ordinary typing, forgetting one is the error this exists to catch.
   */
  lgotaLast: { dutyFree: boolean; vatFree: boolean } | null;
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
  /**
   * The revision clock, read by loadWorkspace's FIRST query — the seal and
   * the confirm doors compare exactly this value under FOR UPDATE, so a
   * capture taken any later would pass on a torn snapshot.
   */
  rev: number;
  /** Is there an ANTHROPIC key on this server at all? The ✨ button is not
   * drawn without one: «ИИ не ответил» on a keyless server is an invitation
   * to press again, and the honest word belongs before the press (audit A25). */
  aiConfigured: boolean;
  /**
   * When a LIVE AI pass holds the request (`ai_proposal_started_at` inside
   * the ten-minute window) — every table write is refused `ai_running` until
   * it lets go, and the screen must say so BEFORE a press rather than answer
   * one with a refusal nobody can explain (the minutes after a Telegram
   * «landed» notice are exactly when a phone opens the job). Null otherwise.
   */
  aiRunningSince: Date | null;
  /** The fee's raw inputs, shipped so the browser can run the SAME pure
   * assembly the server does (live sums). null = unset / no rate in the book. */
  bhmUzs: number | null;
  fxUzsPerUsd: number | null;
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
  /** The request's certificate answer — the groups inherit it. */
  hasCertificate: boolean;
  /**
   * The per-DECLARATION customs fee (VMQ-55's BHM scale), computed once for
   * the request and folded into `customsUsd` — never per group, or a
   * three-group job would pay it three times. null on a yolkira quote.
   */
  fee: FeeResult | null;
  feeOverrideUsd: number | null;
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
  | { kind: 'fee'; reason: string }
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
  // AFTER «cn» on purpose: «Yiwu (Horgos orqali)» is Yiwu cargo, and his
  // 21a keeps it on the China price whichever border the truck takes.
  if (/yiwu|иу|义乌|guangzhou|гуанчжоу|广州|yw|gz/.test(c)) return 'cn';
  if (/horgos|khorgos|xorgos|хоргос|коргас|қорғас|霍尔果斯/.test(c)) return 'horgos';
  return null;
}

/**
 * The hint the workspace shows — a guessed zone only when the tariff PRICES
 * it. «horgos» is guessable from a city the day he opens the warehouse and
 * priceable only once he types its rows (answer 22); a hint naming an
 * unpriced zone points at a picker option that does not exist.
 */
export function guessedZoneFor(fromCity: string | null, priced: readonly string[]): string | null {
  const g = guessZone(fromCity);
  return g !== null && priced.includes(g) ? g : null;
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
/**
 * The last sealed lgota decision per TNVED code (law 7: «the dictionary
 * remembers the last state as the offered default»).
 *
 * No lgota column lives in any dictionary ON PURPOSE — the exemption is
 * per-CALC, so the memory is the sealed record itself: the newest sealed
 * request carrying the code, excluding the one being worked on. One grouped
 * query for all codes (#432), and only decisions that carried an exemption
 * come back — offering «no lgota» as a default would nag every ordinary
 * group.
 */
async function lgotaLastByCode(
  codes: string[],
  excludeRequestId: string,
): Promise<Map<string, { dutyFree: boolean; vatFree: boolean }>> {
  const out = new Map<string, { dutyFree: boolean; vatFree: boolean }>();
  const list = [...new Set(codes)].filter(Boolean);
  if (list.length === 0) return out;
  const rows = await db.execute<{ tnved_code: string; duty_free: boolean; vat_free: boolean }>(sql`
    SELECT DISTINCT ON (g.tnved_code) g.tnved_code, g.duty_free, g.vat_free
      FROM calc_groups g
      JOIN calc_versions v ON v.request_id = g.request_id
     WHERE g.tnved_code IN (${sql.join(list.map((c) => sql`${c}`), sql`, `)})
       AND g.request_id <> ${excludeRequestId}::uuid
       AND (g.duty_free OR g.vat_free)
     ORDER BY g.tnved_code, v.sealed_at DESC
  `);
  for (const r of rows) out.set(r.tnved_code, { dutyFree: r.duty_free, vatFree: r.vat_free });
  return out;
}

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
  const [bazas, rates, tariff, zones, confirmers, lgotaLast, bhmSetting, fxUzsPerUsd] =
    await Promise.all([
      bazasFor(itemRows.map((i) => i.name), date),
      ratesForCodes(groupRows.map((g) => g.tnvedCode ?? '').filter(Boolean), date),
      tariffFor(date),
      tariffZones(date),
      namesOf(groupRows.map((g) => g.confirmedBy).filter((v): v is string => v !== null)),
      lgotaLastByCode(
        groupRows.map((g) => g.tnvedCode ?? '').filter(Boolean),
        requestId,
      ),
      getSetting('bhm_uzs'),
      uzsPerUsd(date),
    ]);
  // The 🧠 chip's title, for the memory-filled rows only — one query, and
  // none at all on a request the memory never answered.
  const memoryProv = await memoryProvenanceFor(
    itemRows.map((i) => i.memoryItemId).filter((v): v is string => v !== null),
  );
  const bhmUzs = bhmSetting == null ? null : Number(bhmSetting);

  const bazaStaleCutoff = onDate(new Date(Date.now() - BAZA_STALE_DAYS * 86_400_000));
  const items: WorkspaceItem[] = itemRows.map((i) => {
    const dict = bazas.get(normalise(i.name));
    return {
      id: i.id,
      seq: i.seq,
      label: i.name,
      quantity: toNum(i.quantity),
      weightKg: toNum(i.weightKg),
      volumeM3: toNum(i.volumeM3),
      unit: i.unit,
      tnvedCode: i.tnvedCode,
      note: i.note,
      groupId: i.groupId,
      bazaUsd: toNum(i.bazaUsd),
      bazaBasis: (i.bazaBasis as BazaBasis | null) ?? null,
      bazaSource: (i.bazaSource as BazaSource) ?? null,
      importRowId: i.importRowId === null ? null : String(i.importRowId),
      bazaReason: i.bazaReason,
      memoryFrom: (() => {
        const p = i.memoryItemId === null ? undefined : memoryProv.get(i.memoryItemId);
        return p ? { sealedAt: p.sealedAt.toISOString(), sealedByName: p.sealedByName } : null;
      })(),
      measureUnit: (i.measureUnit as MeasureUnit | null) ?? null,
      measureQty: toNum(i.measureQty),
      dictionaryBaza: dict
        ? {
            bazaUsd: dict.bazaUsd,
            basis: dict.basis,
            effectiveDate: dict.effectiveDate,
            // Law 5 puts the stale ⚠ where a stale baza actually PRICES a job
            // — the workspace — not only on the dictionary screen. Same
            // 90-day rule as /hisoblash/lugatlar.
            stale: dict.effectiveDate <= bazaStaleCutoff,
          }
        : null,
    };
  });

  const section = (request.section as CalcSectionName | null) ?? null;
  const parts = section ? sectionParts(section) : { customs: true, freight: true, extras: true };

  const groups: WorkspaceGroup[] = groupRows.map((g) => {
    const mine = items.filter((i) => i.groupId === g.id);
    const qty = groupQuantity(mine.map((i) => ({ quantity: i.quantity, unit: i.unit })));
    // The group's own certificate answer wins; a group that says nothing
    // inherits the request's — a sborniy truck mixes senders, and one
    // certificate-less sender must not flip the whole declaration.
    const effectiveCertificate = g.hasCertificate ?? request.hasCertificate;
    // Through the SHARED mapper (pricing.ts): the live browser recompute
    // builds its PricedGroup the same way, and the parameter name forces the
    // EFFECTIVE certificate on both — the raw override would silently drop
    // the add-duty from whichever side picked it.
    const priced = pricedGroupOf({
      seq: g.seq,
      label: g.label,
      tnvedCode: g.tnvedCode,
      dutyPct: toNum(g.dutyPct),
      vatPct: toNum(g.vatPct),
      feeUsd: toNum(g.feeUsd),
      // Stored NULL reads as 'advalor' — every group sealed before 0091
      // keeps meaning exactly what it meant.
      dutyMode: (g.dutyMode as DutyMode | null) ?? 'advalor',
      dutySpecific: toNum(g.dutySpecific),
      dutyUnit: (g.dutyUnit as DutyUnit | null) ?? null,
      excisePct: toNum(g.excisePct),
      effectiveCertificate,
      dutyFree: g.dutyFree,
      vatFree: g.vatFree,
    });
    const dictRates = g.tnvedCode ? rates.get(g.tnvedCode.trim()) : undefined;
    return {
      id: g.id,
      ...priced,
      hasCertificate: g.hasCertificate,
      effectiveCertificate,
      rateSource: (g.rateSource as 'dictionary' | 'typed' | null) ?? null,
      aiProposed: g.aiProposed,
      aiConfidence: (g.aiConfidence as 'high' | 'medium' | 'low' | null) ?? null,
      aiDutyPct: toNum(g.aiDutyPct),
      confirmedAt: g.confirmedAt,
      confirmedByName: g.confirmedBy ? (confirmers.get(g.confirmedBy) ?? null) : null,
      confirmVia: (g.confirmVia as 'single' | 'bulk' | null) ?? null,
      confirmedWarnings: (g.confirmedWarnings as CalcWarningKind[] | null) ?? null,
      warnings: warningsForGroup({
        dictionaryRates: dictRates
          ? { dutyPct: dictRates.dutyPct, vatPct: dictRates.vatPct, feeUsd: dictRates.feeUsd }
          : null,
        dictionaryNote: dictRates?.note ?? null,
        rateSource: (g.rateSource as 'dictionary' | 'typed' | null) ?? null,
        dutyPct: toNum(g.dutyPct),
        vatPct: toNum(g.vatPct),
        aiProposed: g.aiProposed,
        aiConfidence: (g.aiConfidence as 'high' | 'medium' | 'low' | null) ?? null,
        aiDutyPct: toNum(g.aiDutyPct),
        dutyUnit: priced.dutyUnit,
        items: mine.map((i) => ({
          hasDictionaryBaza: i.dictionaryBaza !== null,
          bazaSource: i.bazaSource,
          bazaUsd: i.bazaUsd,
          bazaBasis: i.bazaBasis,
          dictionaryBaza: i.dictionaryBaza
            ? { bazaUsd: i.dictionaryBaza.bazaUsd, basis: i.dictionaryBaza.basis }
            : null,
        })),
      }),
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
            dutyMode: dictRates.dutyMode,
            dutySpecific: dictRates.dutySpecific,
            dutyUnit: dictRates.dutyUnit,
            matchedCode: dictRates.tnvedCode,
            effectiveDate: dictRates.effectiveDate,
            note: dictRates.note,
          }
        : null,
      lgotaLast: (g.tnvedCode && lgotaLast.get(g.tnvedCode)) || null,
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

  // The per-declaration fee (VMQ-55) and the request-grain sum, through the
  // ONE pure assembly the live browser recompute also runs (`requestCustomsFor`
  // — no partial sums, fee only when every group prices).
  const feeOverrideUsd = toNum(request.feeOverrideUsd);
  const assembled = parts.customs
    ? requestCustomsFor({
        customs: groups.map((g) => g.customs),
        bhmUzs,
        fxUzsPerUsd,
        feeOverrideUsd,
      })
    : null;
  const fee = assembled?.fee ?? null;
  const customsUsd = parts.customs ? assembled!.customsUsd : 0;
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
  /**
   * Is the Σ above the WHOLE of what it is being compared against?
   *
   * `groupMeasure` returns the sum of whatever items carry the measure and
   * null only when none do, so a partially-measured request produces a
   * partial Σ that LOOKS like a total — and `disagrees` then fires on the
   * shortfall. Two ways to be partial: an item with no figure, and an item
   * in no group at all, which is the normal state of every request the VED
   * is half-way through coding. Both make the two sides incomparable, and
   * «not yet» is the honest answer, not «they disagree».
   *
   * The module already decided this one file over: `groupPerUnit`
   * (calc/history.ts) refuses unless EVERY item carries the measure, because
   * dividing by a partial Σ «prints roughly three times the true rate». This
   * is the same arithmetic and now the same rule.
   */
  const covered = (pick: (i: WorkspaceItem) => number | null) =>
    items.length > 0 && items.every((i) => i.groupId !== null && pick(i) !== null);

  return {
    requestId,
    rev: request.rev,
    bhmUzs,
    fxUzsPerUsd,
    section,
    parts,
    weightKg,
    volumeM3,
    density: weightKg !== null && volumeM3 !== null && volumeM3 > 0 ? weightKg / volumeM3 : null,
    freightZone: request.freightZone,
    zones,
    guessedZone: guessedZoneFor(request.fromCity, zones),
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
    hasCertificate: request.hasCertificate,
    fee,
    feeOverrideUsd,
    totals,
    blockers: blockersFor({ section, parts, groups, items, freight, fee, totals }),
    reconcile: {
      groupKg,
      groupM3,
      // Freight reads the REQUEST's totals and customs reads the GROUPS', so
      // nothing else would tell the VED the two disagree — but only once
      // both sides are measuring the same cargo.
      mismatch:
        (covered((i) => i.weightKg) && disagrees(groupKg, weightKg)) ||
        (covered((i) => i.volumeM3) && disagrees(groupM3, volumeM3)),
    },
    sealedVersion: sealed,
    aiConfigured: aiConfigured(),
    aiRunningSince: aiClaimLive(request.aiProposalStartedAt) ? request.aiProposalStartedAt : null,
    completedAt: request.completedAt,
  };
}

const disagrees = (a: number | null, b: number | null) =>
  a !== null && b !== null && b > 0 && Math.abs(a - b) / b > 0.01;

/**
 * UZS per one USD on the day — the fee scale is written in so'm and this
 * screen prices in USD. Deliberately NOT `costing.rateFor`: that one falls
 * back to the earliest row ever recorded (a cost predating the rate book
 * still has to convert into something), and this module's rule is that a
 * missing rate is a refusal, never an invented number.
 */
async function uzsPerUsd(date: string): Promise<number | null> {
  const [hit] = await db
    .select({ rateToUsd: fxRates.rateToUsd })
    .from(fxRates)
    .where(and(eq(fxRates.currency, 'UZS'), lte(fxRates.effectiveDate, date)))
    .orderBy(desc(fxRates.effectiveDate))
    .limit(1);
  if (!hit) return null;
  const usdPerUzs = Number(hit.rateToUsd);
  return usdPerUzs > 0 ? 1 / usdPerUzs : null;
}

function blockersFor(w: {
  section: CalcSectionName | null;
  parts: { customs: boolean; freight: boolean; extras: boolean };
  groups: WorkspaceGroup[];
  items: WorkspaceItem[];
  freight: FreightResult | null;
  fee: FeeResult | null;
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
  if (w.fee && !w.fee.ok) out.push({ kind: 'fee', reason: w.fee.reason });
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
  const zones = await tariffZones(onDate());
  if (zone !== null && !zones.includes(zone)) throw new CalcError('zone_unknown');
  await mutateRequest(requestId, async (tx) => {
    await tx.update(calcRequests).set({ freightZone: zone }).where(eq(calcRequests.id, requestId));
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { freightZone: zone },
    });
  });
}

/**
 * The cargo facts a QUOTE cannot be made without — typed by the VED.
 *
 * The owner's report, and it is the one that made the whole module dead-end
 * for him: «agar AI kub kilolarni bermagan bo'lsa lekin materiallarda bo'lsa,
 * ularni VED hodimi o'zi kirgiza olmayabti». The screen has printed
 * «⚠ Yetishmayapti: og'irlik, hajm» since phase A and offered NOTHING to fill
 * it: the request's own weight, volume and route arrive from the bot's
 * reading and nowhere else, so a photograph the model could not read left a
 * job that could never be priced — freight has no density and the band lookup
 * has no answer — and the only way out was «Готово» with a typed figure.
 * `setFreightZone` next door was the shape of the missing door all along.
 *
 * NOT a confirmation clear: a ✅ blesses a group's RATES and BAZAS, and the
 * shipment's weight is neither. It DOES move the rev clock, because it moves
 * what a seal would seal — the freight band is looked up at the arrived
 * density (#764).
 */
export async function setCargoFacts(
  requestId: string,
  input: {
    fromCity: string | null;
    toCity: string | null;
    weightKg: number | null;
    volumeM3: number | null;
  },
  ctx: AuditContext,
): Promise<void> {
  mustBeNumber(input.weightKg, input.volumeM3);
  for (const v of [input.weightKg, input.volumeM3]) {
    if (v === null) continue;
    if (!(v > 0)) throw new CalcError('measure_positive');
    // numeric(12,3) holds nine whole digits; past it the UPDATE dies 22003
    // as a white page rather than as a sentence (#867's rule).
    if (v >= 1e9) throw new CalcError('bad_number');
  }
  const city = (raw: string | null) => (raw ?? '').trim().slice(0, 120) || null;
  const patch = {
    fromCity: city(input.fromCity),
    toCity: city(input.toCity),
    weightKg: input.weightKg === null ? null : input.weightKg.toFixed(3),
    volumeM3: input.volumeM3 === null ? null : input.volumeM3.toFixed(3),
  };
  await mutateRequest(requestId, async (tx) => {
    await tx.update(calcRequests).set(patch).where(eq(calcRequests.id, requestId));
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { cargoFacts: patch },
    });
  });
}

export async function createGroup(
  requestId: string,
  input: { label: string; tnvedCode?: string | null },
  ctx: AuditContext,
): Promise<string> {
  return mutateRequest(requestId, async (tx) => {
    const seq = await nextSeq(tx, calcGroups, requestId);
    const [row] = await tx
      .insert(calcGroups)
      .values({
        requestId,
        seq,
        label: input.label.trim() || '—',
        tnvedCode: input.tnvedCode?.trim() || null,
      })
      .returning({ id: calcGroups.id });
    await writeAudit(tx, ctx, {
      entityType: 'calc_group',
      entityId: row!.id,
      action: 'create',
      after: { requestId, ...input },
    });
    return row!.id;
  });
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
  await mutateRequest(group.requestId, async (tx) => {
    await tx.delete(calcGroups).where(eq(calcGroups.id, groupId));
    await writeAudit(tx, ctx, {
      entityType: 'calc_group',
      entityId: groupId,
      action: 'delete',
      before: { requestId: group.requestId, label: group.label },
    });
  });
}

export async function moveItemToGroup(
  requestId: string,
  itemSeq: number,
  groupId: string | null,
  ctx: AuditContext,
) {
  await mutateRequest(requestId, async (tx) => {
    if (groupId) {
      const [group] = await tx
        .select({ requestId: calcGroups.requestId })
        .from(calcGroups)
        .where(eq(calcGroups.id, groupId));
      // Re-proved server-side: a hand-posted id must not move cargo between
      // two customers' calculations.
      if (!group || group.requestId !== requestId) throw new CalcError('group_foreign');
    }
    const [was] = await tx
      .select({ groupId: calcRequestItems.groupId })
      .from(calcRequestItems)
      .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, itemSeq)));
    const [moved] = await tx
      .update(calcRequestItems)
      .set({ groupId })
      .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, itemSeq)))
      .returning({ id: calcRequestItems.id });
    // Both ends of the move: a group that gained or lost cargo is a group whose
    // customs figure changed, so neither may keep a ✅ from before it did.
    if (moved) {
      const ends = [groupId, was?.groupId && was.groupId !== groupId ? was.groupId : null].filter(
        (v): v is string => !!v,
      );
      await unconfirmInTx(tx, ends);
    }
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { itemSeq, groupId },
    });
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
    dutyFree: boolean;
    vatFree: boolean;
    source: 'dictionary' | 'typed';
    /** Absent = keep the group's stored shape (a rate edit is not a shape
     * edit). 'advalor' explicitly is how the specific half is removed. */
    dutyMode?: DutyMode;
    dutySpecific?: number | null;
    dutyUnit?: DutyUnit | null;
    excisePct?: number | null;
    /** Absent = keep; null = «inherit the request»; a boolean = this group's
     * own answer (a sborniy truck mixes senders). */
    hasCertificate?: boolean | null;
    label?: string;
    note?: string | null;
  },
  ctx: AuditContext,
) {
  const found = await db.query.calcGroups.findFirst({
    where: eq(calcGroups.id, groupId),
    columns: { requestId: true },
  });
  if (!found) throw new CalcError('not_found');
  mustBeNumber(input.dutyPct, input.vatPct, input.dutySpecific, input.excisePct);
  for (const pct of [input.dutyPct, input.vatPct, input.excisePct]) {
    if (pct !== null && pct !== undefined && (pct < 0 || pct > 100)) {
      throw new CalcError('rate_range');
    }
  }

  await mutateRequest(found.requestId, async (tx) => {
  // Re-read under the lock — the pool row above only located the request.
  const [group] = await tx.select().from(calcGroups).where(eq(calcGroups.id, groupId));
  if (!group) throw new CalcError('not_found');

  const dutyMode = input.dutyMode ?? ((group.dutyMode as DutyMode | null) ?? 'advalor');
  let dutySpecific =
    input.dutySpecific !== undefined ? input.dutySpecific : toNum(group.dutySpecific);
  let dutyUnit =
    input.dutyUnit !== undefined ? input.dutyUnit : ((group.dutyUnit as DutyUnit | null) ?? null);
  if (dutyMode === 'advalor') {
    // The pair CHECK: an advalor group carries no specific half.
    dutySpecific = null;
    dutyUnit = null;
  } else if (dutySpecific === null || !(dutySpecific >= 0) || dutyUnit === null) {
    throw new CalcError('rate_range');
  }

  await tx
    .update(calcGroups)
    .set({
      label: input.label?.trim() || group.label,
      tnvedCode: input.tnvedCode?.trim() || null,
      dutyPct: input.dutyPct === null ? null : input.dutyPct.toFixed(3),
      vatPct: input.vatPct === null ? null : input.vatPct.toFixed(3),
      // THE GROUP CARRIES NO FEE (audit A2). The declaration's BHM scale
      // pays it once per REQUEST (#858) and `customsFor` was adding this
      // column INSIDE every group on top of it — the same fee twice, or N
      // times on an N-group truck. No screen posts one any more, and saving a
      // group's rates is what clears a legacy number.
      feeUsd: null,
      dutyMode: dutyMode === 'advalor' ? null : dutyMode,
      dutySpecific: dutySpecific === null ? null : dutySpecific.toFixed(4),
      dutyUnit,
      excisePct:
        input.excisePct !== undefined
          ? input.excisePct === null
            ? null
            : input.excisePct.toFixed(3)
          : group.excisePct,
      hasCertificate: input.hasCertificate !== undefined ? input.hasCertificate : group.hasCertificate,
      rateSource: input.source,
      dutyFree: input.dutyFree,
      vatFree: input.vatFree,
      note: input.note ?? group.note,
      // The SECOND writer of the confirmation clear, and the one a fix aimed
      // at `unconfirm()` alone would miss — all four columns, per the pair
      // CHECK 0089 added.
      confirmedBy: null,
      confirmedAt: null,
      confirmVia: null,
      confirmedWarnings: null,
    })
    .where(eq(calcGroups.id, groupId));

  await writeAudit(tx, ctx, {
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
  });
}

export async function setItemBaza(
  requestId: string,
  itemSeq: number,
  input: { bazaUsd: number | null; basis: BazaBasis | null; source: 'dictionary' | 'typed' },
  ctx: AuditContext,
) {
  mustBeNumber(input.bazaUsd);
  if (input.bazaUsd !== null && !(input.bazaUsd > 0)) throw new CalcError('baza_positive');
  if (input.basis !== null && !isBazaBasis(input.basis)) throw new CalcError('bad_basis');
  await mutateRequest(requestId, async (tx) => {
    // saveTable's own basis rule (0125), restated for the one door that is
    // not the table: a basis without a price is a CHOICE and stands; a price
    // without a basis is «auto» and takes the law's default from the row's
    // group as it is NOW; null with null clears the whole pair. This door
    // runs no measure pass — like `setGroupRates`, the stored pair
    // reconciles on the next Saqlash.
    let basis = input.basis;
    if (input.bazaUsd !== null && basis === null) {
      const [law] = await tx
        .select({ dutyUnit: calcGroups.dutyUnit })
        .from(calcRequestItems)
        .leftJoin(calcGroups, eq(calcGroups.id, calcRequestItems.groupId))
        .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, itemSeq)));
      basis = defaultBasisFor({ dutyUnit: law?.dutyUnit ?? null });
    }
    const [changed] = await tx
      .update(calcRequestItems)
      .set({
        bazaUsd: input.bazaUsd === null ? null : input.bazaUsd.toFixed(4),
        bazaBasis: basis,
        bazaSource: input.bazaUsd === null ? null : input.source,
        // The whole provenance moves together (0094, widened by 0096):
        // whatever this writes, the number is no longer the import's and no
        // longer a sealed calculation's — leaving either behind is #896's
        // defect, a chip naming a source that did not supply the figure.
        importRowId: null,
        memoryItemId: null,
        bazaReason: null,
      })
      .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, itemSeq)))
      .returning({ groupId: calcRequestItems.groupId });
    // The confirmation was about NUMBERS, and this is one of them. Changing a
    // baza under a confirmed group left the ✅ standing over a figure nobody
    // had looked at — the same rule `setGroupRates` already applies to a rate.
    if (changed?.groupId) await unconfirmInTx(tx, [changed.groupId]);
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { itemSeq, baza: input },
    });
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
  // The lock and the clock ride the delegate: setGroupRates opens the
  // request tx itself.
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
      dutyMode: hit.dutyMode,
      dutySpecific: hit.dutySpecific,
      dutyUnit: hit.dutyUnit,
      dutyFree: group.dutyFree,
      vatFree: group.vatFree,
      source: 'dictionary',
    },
    ctx,
  );
}

/**
 * The request's certificate answer — the door the «sertifikat» chip presses.
 *
 * Flipping it re-prices every group that INHERITS it (the additional duty
 * appears or vanishes), so those groups lose their ✅ — the person who
 * confirmed did not confirm these numbers. A group carrying its own answer
 * keeps both its answer and its confirmation.
 */
export async function setRequestCertificate(
  requestId: string,
  hasCertificate: boolean,
  ctx: AuditContext,
) {
  const request = await assertOpen(requestId);
  if (request.hasCertificate === hasCertificate) return;
  await mutateRequest(requestId, async (tx) => {
    await tx
      .update(calcRequests)
      .set({ hasCertificate })
      .where(eq(calcRequests.id, requestId));
    const inheriting = await tx
      .select({ id: calcGroups.id })
      .from(calcGroups)
      .where(and(eq(calcGroups.requestId, requestId), isNull(calcGroups.hasCertificate)));
    await unconfirmInTx(tx, inheriting.map((g) => g.id));
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      before: { hasCertificate: request.hasCertificate },
      after: { hasCertificate },
    });
  });
}

/** The typed per-declaration fee override — null returns to the computed tier. */
export async function setFeeOverride(
  requestId: string,
  feeOverrideUsd: number | null,
  ctx: AuditContext,
) {
  mustBeNumber(feeOverrideUsd);
  if (feeOverrideUsd !== null && feeOverrideUsd < 0) throw new CalcError('rate_range');
  await mutateRequest(requestId, async (tx) => {
    await tx
      .update(calcRequests)
      .set({ feeOverrideUsd: feeOverrideUsd === null ? null : feeOverrideUsd.toFixed(2) })
      .where(eq(calcRequests.id, requestId));
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { feeOverrideUsd },
    });
  });
}

/**
 * Fill every item that has no baza from the dictionary, in one pass.
 *
 * A hit is applied only when its basis is RESOLVABLE on that row — see the
 * rule in the loop (0125). Since the m² box follows the BASIS (`pairUnitFor`)
 * a «plitka» row stored per m² is no longer stranded on an advalor item: the
 * row grows its O'lchov line and refuses «o'lchov yo'q» until the VED types
 * the count. Like `setGroupRates`, this door runs no measure pass — the
 * stored pair reconciles on the next Saqlash.
 */
export async function pullBazasFromDictionary(
  requestId: string,
  ctx: AuditContext,
): Promise<{ filled: number; skipped: number }> {
  await assertOpen(requestId);
  const items = await db
    .select()
    .from(calcRequestItems)
    .where(and(eq(calcRequestItems.requestId, requestId), isNull(calcRequestItems.bazaUsd)));
  if (items.length === 0) return { filled: 0, skipped: 0 };
  const [bazas, groupRows] = await Promise.all([
    bazasFor(items.map((i) => i.name), onDate()),
    db
      .select({ id: calcGroups.id, dutyUnit: calcGroups.dutyUnit })
      .from(calcGroups)
      .where(eq(calcGroups.requestId, requestId)),
  ]);
  const unitByGroup = new Map(groupRows.map((g) => [g.id, g.dutyUnit]));

  const fills: { id: string; groupId: string | null; bazaUsd: number; basis: BazaBasis }[] = [];
  let skipped = 0;
  for (const item of items) {
    const hit = bazas.get(normalise(item.name));
    if (!hit) continue;
    // 0125: a row's own basis is free (his 18a), so the book's unit lands on
    // any row — EXCEPT a row whose unit the VED already chose (an unpriced
    // row's stored basis is always a choice, never a stamp) when the book
    // prices it per something else, and a unit the row's law cannot hold
    // (a pair unit on a juft/litr/m² code). Both are counted and reported.
    const chosen = (item.bazaBasis as BazaBasis | null) ?? null;
    const law = item.groupId !== null ? (unitByGroup.get(item.groupId) ?? null) : null;
    const resolvable = (chosen === null || hit.basis === chosen) && !basisConflicts(law, hit.basis);
    if (!resolvable) {
      skipped += 1;
      continue;
    }
    fills.push({ id: item.id, groupId: item.groupId, bazaUsd: hit.bazaUsd, basis: hit.basis });
  }
  if (fills.length === 0) return { filled: 0, skipped };

  await mutateRequest(requestId, async (tx) => {
    for (const f of fills) {
      await tx
        .update(calcRequestItems)
        // The provenance goes with the price it explained (0094): a row the
        // dictionary just re-priced is no longer wearing the import's
        // number, and a stale `import_row_id` would keep the «📥 taxmin»
        // chip on a baza the book supplied.
        .set({
          bazaUsd: f.bazaUsd.toFixed(4),
          bazaBasis: f.basis,
          bazaSource: 'dictionary',
          importRowId: null,
          memoryItemId: null,
          bazaReason: null,
        })
        .where(and(eq(calcRequestItems.id, f.id), isNull(calcRequestItems.bazaUsd)));
    }
    // The same rule `setItemBaza` applies one item at a time. A baza is one
    // of the numbers the ✅ was about, and filling a blank one changes the
    // group's customs figure exactly as retyping one does.
    await unconfirmInTx(tx, fills.map((f) => f.groupId).filter((v): v is string => !!v));
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: { bazasPulled: fills.length, bazasSkipped: skipped },
    });
  });
  return { filled: fills.length, skipped };
}

export async function confirmGroup(
  groupId: string,
  ctx: AuditContext,
  /**
   * WHICH DOOR pressed it (audit A18).
   *
   * The phone card and the desktop row call the same function, and the record
   * used to say 'single' for both — so a ✅ that was pressed beside the duty,
   * the VAT and the ✨ chips and a ✅ pressed on a card that shows none of
   * them read identically to phase E1. They are different facts about how
   * carefully a rate was blessed, and E1 exists to measure exactly that.
   */
  via: 'single' | 'phone' = 'single',
) {
  const group = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
  if (!group) throw new CalcError('not_found');
  // What stood on the screen at this moment, recorded now because it cannot
  // be recovered later: the dictionaries move, so re-deriving the warnings a
  // month from now asks a different question about a different world.
  const warnings = await warningsNow(group.requestId);
  await mutateRequest(group.requestId, async (tx, locked) => {
    // The clock: a save committing after the warnings were computed makes
    // that list a description of numbers that no longer stand — refuse, the
    // screen re-renders, the person presses again over the truth.
    if (locked.rev !== warnings.rev) throw new CalcError('conflict');
    const [row] = await tx
      .update(calcGroups)
      .set({
        confirmedBy: ctx.actorId ?? null,
        confirmedAt: new Date(),
        confirmVia: via,
        confirmedWarnings: warnings.byGroup.get(groupId) ?? [],
      })
      // A re-press is a no-op, never a re-stamp: the first press's who/when/
      // warnings are the record E1 reads.
      .where(and(eq(calcGroups.id, groupId), isNull(calcGroups.confirmedAt)))
      .returning({ id: calcGroups.id });
    if (row) {
      await writeAudit(tx, ctx, {
        entityType: 'calc_group',
        entityId: groupId,
        action: 'update',
        after: { confirmed: true },
      });
    }
  });
}

export async function confirmAllGroups(requestId: string, ctx: AuditContext): Promise<number> {
  const warnings = await warningsNow(requestId);
  // ONE transaction under the request lock, with the SAME clock check as the
  // single door — bulk is the COMMON press, and a save landing between the
  // warnings compute and the stamps would otherwise record lists describing
  // numbers that no longer stand (the drift E1's record exists to prevent).
  const rows = await mutateRequest(requestId, async (tx, locked) => {
    if (locked.rev !== warnings.rev) throw new CalcError('conflict');
    const pending = await tx
      .select({ id: calcGroups.id })
      .from(calcGroups)
      .where(and(eq(calcGroups.requestId, requestId), isNull(calcGroups.confirmedAt)));
    const now = new Date();
    const out: { id: string }[] = [];
    for (const group of pending) {
      // Per group, because the list each one was confirmed over is its own —
      // and 'bulk' is a different act from 'single', which is exactly what
      // the owner's «ko'rmasdan tasdiqlagan» question is about.
      const [row] = await tx
        .update(calcGroups)
        .set({
          confirmedBy: ctx.actorId ?? null,
          confirmedAt: now,
          confirmVia: 'bulk',
          confirmedWarnings: warnings.byGroup.get(group.id) ?? [],
        })
        .where(and(eq(calcGroups.id, group.id), isNull(calcGroups.confirmedAt)))
        .returning({ id: calcGroups.id });
      if (row) out.push(row);
    }
    if (out.length > 0) {
      await writeAudit(tx, ctx, {
        entityType: 'calc_request',
        entityId: requestId,
        action: 'update',
        after: { confirmedGroups: out.length },
      });
    }
    return out;
  });
  return rows.length;
}

export async function saveExtra(
  requestId: string,
  input: { id?: string; costTypeId: string | null; label: string; amountUsd: number; note: string | null },
  ctx: AuditContext,
): Promise<string> {
  mustBeNumber(input.amountUsd);
  if (!(input.amountUsd >= 0)) throw new CalcError('amount_range');
  const label = input.label.trim();
  if (!label) throw new CalcError('label_required');

  return mutateRequest(requestId, async (tx) => {
    if (input.id) {
      const [existing] = await tx.select().from(calcExtras).where(eq(calcExtras.id, input.id));
      if (!existing || existing.requestId !== requestId) throw new CalcError('not_found');
      await tx
        .update(calcExtras)
        .set({
          costTypeId: input.costTypeId,
          label,
          amountUsd: input.amountUsd.toFixed(2),
          note: input.note,
        })
        .where(eq(calcExtras.id, input.id));
      await writeAudit(tx, ctx, { entityType: 'calc_extra', entityId: input.id, action: 'update', after: input });
      return input.id;
    }

    const seq = await nextSeq(tx, calcExtras, requestId);
    const [row] = await tx
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
    await writeAudit(tx, ctx, { entityType: 'calc_extra', entityId: row!.id, action: 'create', after: input });
    return row!.id;
  });
}

export async function deleteExtra(extraId: string, ctx: AuditContext) {
  const extra = await db.query.calcExtras.findFirst({ where: eq(calcExtras.id, extraId) });
  if (!extra) throw new CalcError('not_found');
  await mutateRequest(extra.requestId, async (tx) => {
    await tx.delete(calcExtras).where(eq(calcExtras.id, extraId));
    await writeAudit(tx, ctx, {
      entityType: 'calc_extra',
      entityId: extraId,
      action: 'delete',
      before: { label: extra.label, amountUsd: extra.amountUsd },
    });
  });
}

/** Land a model proposal as draft groups. Refuses once anything is confirmed. */
export async function applyProposal(requestId: string, drafts: DraftGroup[], ctx: AuditContext) {
  await db.transaction(async (tx) => {
    // Its OWN flow holds the AI claim it would otherwise refuse on; the lock
    // still serializes it against saves (it deletes and recreates every
    // group — unlocked, a concurrent save's items UPDATE hits a deleted
    // group's FK and the whole save dies with a raw 23503).
    await lockRequestInTx(tx, requestId, { ignoreAiClaim: true });
    const confirmed = await tx
      .select({ id: calcGroups.id })
      .from(calcGroups)
      .where(and(eq(calcGroups.requestId, requestId), sql`${calcGroups.confirmedAt} IS NOT NULL`))
      .limit(1);
    if (confirmed.length > 0) throw new CalcError('groups_confirmed');

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
          // The model's own words, kept whole (phase E1). A code alone cannot
          // answer «did the VED change anything» — moving one carton between
          // two groups is the commonest correction there is and touches no
          // rate at all, so the MEMBERSHIP has to be in the snapshot. The key
          // is spelled `aiDutyPct` deliberately: `tests/unit/ai-advisory.test`
          // asserts this function never mentions a bare `dutyPct:`, which is
          // law 1's third fence — the model must not be able to reach a
          // number the arithmetic reads.
          aiProposal: {
            tnvedCode: draft.tnvedCode,
            aiDutyPct: draft.aiDutyPct,
            itemSeqs: draft.itemSeqs,
          },
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
    await bumpRevInTx(tx, requestId);
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
  if (!canSeal(workspace)) throw new CalcError('not_ready');

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

  const request = await db.query.calcRequests.findFirst({
    where: eq(calcRequests.id, requestId),
    columns: { supersedesRequestId: true },
  });
  const superseded = request?.supersedesRequestId ?? null;

  const breakdown = {
    groups: workspace.groups.map((g) => ({
      seq: g.seq,
      label: g.label,
      tnvedCode: g.tnvedCode,
      dutyPct: g.dutyPct,
      vatPct: g.vatPct,
      feeUsd: g.feeUsd,
      // VED 2.0: the law's shape rides into the snapshot, so a sealed MAX
      // price goes on explaining its own floor after the dictionary moves.
      // Readers of OLD breakdowns must tolerate their absence (advalor).
      dutyMode: g.dutyMode,
      dutySpecific: g.dutySpecific,
      dutyUnit: g.dutyUnit,
      excisePct: g.excisePct,
      hasCertificate: g.effectiveCertificate,
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
        // Added in phase C, when `PricedItem` had no volume — so the snapshot
        // the migration calls «the whole snapshot … so phase E can compare»
        // could not answer «how many m³ of this item». Since 0125 an m³ baza
        // PRICES from it. Every reader must still tolerate an OLD breakdown
        // that lacks it.
        volumeM3: i.volumeM3,
        bazaUsd: i.bazaUsd,
        bazaBasis: i.bazaBasis,
        bazaSource: i.bazaSource,
        // Phase 3's measure pair — absent on every older breakdown, and
        // every reader tolerates that.
        measureUnit: i.measureUnit,
        measureQty: i.measureQty,
      })),
    })),
    extras: workspace.extras,
    tariffRow: freight?.ok ? freight.band : null,
    density: workspace.density,
    // VED 2.0: what the declaration paid VMQ-55, and under which certificate
    // answer. `fee` is inside `customsUsd` already — this is its receipt.
    hasCertificate: workspace.hasCertificate,
    fee: workspace.fee?.ok ? workspace.fee : null,
  };

  const aiGroupsSealed = workspace.groups.filter((g) => g.aiProposed).length;
  // `aiProposed` and not `aiConfidence` alone: `mergeProposals` mints the
  // orphan group — the cargo the model did not place — with confidence 'low'
  // and `aiProposed: false`, so counting confidence by itself inflates «how
  // much of this was still the model's» by a group nobody's model touched.
  const lowConfidenceSealed = workspace.groups.filter(
    (g) => g.aiProposed && g.aiConfidence === 'low',
  ).length;

  // Phase E1's three counters. A sealed version is immutable and its
  // `breakdown` is a snapshot of numbers — these three are questions about
  // the DICTIONARIES, which will have moved by the time anybody reads them.
  const proposals = await db
    .select({ id: calcGroups.id, aiProposal: calcGroups.aiProposal })
    .from(calcGroups)
    .where(eq(calcGroups.requestId, requestId));
  const proposalById = new Map(proposals.map((p) => [p.id, (p.aiProposal as ProposalSnapshot | null) ?? null]));
  const counters = sealCounters(
    workspace.groups.map((g) => ({
      warnings: g.warnings,
      // Blind = the model proposed it, said so with low confidence, nothing
      // was edited, and the dictionary could not have corrected it.
      blind:
        g.warnings.includes('ai_low_confidence') &&
        unchangedFromProposal(proposalById.get(g.id) ?? null, {
          tnvedCode: g.tnvedCode,
          dutyPct: g.dutyPct,
          itemSeqs: g.items.map((i) => i.seq),
        }),
    })),
  );

  const result = await db.transaction(async (tx) => {
    // The clock CAS (phase 3): the compute above ran on the pool —
    // loadWorkspace cannot move inside a tx (#714) — so this is where the
    // seal learns whether the workspace it computed still stands. Every
    // mutator bumps `rev` under the same lock; a moved clock means somebody
    // saved between the compute and this line, and sealing the pre-save
    // snapshot would lock a price nobody is looking at onto a client card.
    const locked = await lockRequestInTx(tx, requestId);
    if (locked.rev !== workspace.rev) throw new CalcError('conflict');
    const closed = await tx
      .update(calcRequests)
      .set({
        completedAt: new Date(),
        completedBy: ctx.actorId ?? null,
        completedVia: 'sealed',
        currentVersionNo: sql`${calcRequests.currentVersionNo} + 1`,
        rev: sql`${calcRequests.rev} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(calcRequests.id, requestId), isNull(calcRequests.completedAt)))
      .returning({
        versionNo: calcRequests.currentVersionNo,
        entityType: calcRequests.entityType,
        entityId: calcRequests.entityId,
        requestedBy: calcRequests.requestedBy,
        taskId: calcRequests.taskId,
      });
    const row = closed[0];
    if (!row) throw new CalcError('already_closed');

    /**
     * THE SEAL CLOSES THE VED'S TASK (audit A20).
     *
     * `endRequest` closes it on the other three endings — Готово, qaytarish,
     * pozitsiyalar — and the seal never did, because it closes the request
     * with its own UPDATE. So every sealed job left a red priority-1 task on
     * the VED's /bugun and in the owner's task counts until somebody pressed
     * «✅ Bajarildi» by hand, which then found no open request to end.
     * MEASURED: five such tasks on a database with five sealed requests.
     */
    if (row.taskId) {
      await tx
        .update(tasks)
        .set({
          status: 'done',
          doneAt: new Date(),
          doneBy: ctx.actorId ?? null,
          result: 'Muhrlandi',
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, row.taskId), eq(tasks.status, 'open')));
    }

    const [inserted] = await tx.insert(calcVersions).values({
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
      warnedGroups: counters.warnedGroups,
      aiBlindGroups: counters.aiBlindGroups,
      aiRateTakenGroups: counters.aiRateTakenGroups,
      breakdown,
    }).returning({ id: calcVersions.id });

    // A correction ADOPTS the cargo the request it supersedes was measuring
    // (phase E1). Re-pointing at `recalcFromSealed` time was refused: that
    // function inserts a request with no version at all, so the cargo would
    // hang off a PRICELESS request — permanently, if the correction is then
    // abandoned through `endRequest('returned')`. Here there is a price by
    // construction, because this statement runs after the version's INSERT.
    if (superseded) {
      await tx
        .update(receipts)
        // An unconfirmed guess changes hands with the cargo, and the sealer of
        // THIS version may be a different person from the one who was asked
        // about it (0119): asking again is the only way the right VED sees it.
        // A confirmed link keeps its record — nobody is asked twice about an
        // answer.
        .set({
          calcRequestId: requestId,
          calcLinkNotifiedAt: sql`CASE WHEN ${receipts.calcLinkConfirmedAt} IS NULL THEN NULL ELSE ${receipts.calcLinkNotifiedAt} END`,
        })
        .where(eq(receipts.calcRequestId, superseded));
    }

    // The cargo that arrived WHILE this calculation was being worked on
    // (0119). Before this, a prixod confirmed between the request and the seal
    // was never suggested at all — the only stamp doors were the receipt's own
    // confirm and a re-file, and at both moments there was no sealed price to
    // stamp. Inside the seal's transaction on `tx` only (#714), and BEFORE the
    // deals UPDATE below: receipts → deals is `linkReceipt`'s lock order too,
    // so the two can never wait on each other in opposite directions. The
    // receipt-count doors meet a «band» for these milliseconds, stated.
    if (row.entityType === 'deal') {
      await stampCalcLinksTx(tx, row.entityId);
    }

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

    return {
      versionNo: row.versionNo,
      versionId: inserted!.id,
      requestedBy: row.requestedBy,
      entityType: row.entityType,
      entityId: row.entityId,
      taskId: row.taskId,
    };
  });

  // The price channel's claim (his F, 2026-10-07) — FIRST after the commit:
  // `writeAudit` below is not in a catch and `announceSeal` awaits Telegram,
  // so a throw or a restart in that window must not cost the row. Its own
  // catch: a channel that cannot be told must never undo a seal (#472), and
  // the drain's net picks up a row this misses.
  await import('./channel-queue')
    .then((m) => m.queuePriceChannelPost({ kind: 'seal', requestId, versionId: result.versionId }))
    .catch((err) => logger.error({ err, requestId }, '[price-channel] not queued'));

  // The task the seal just closed stops offering its «✅ Bajarildi» in
  // Telegram (review integration-5) — `endRequest`, the release and the take
  // all retire their task's copies, and the seal closed its task with its own
  // UPDATE and retired nothing, so the VED's chat kept a live button for a job
  // that was already sealed. After the commit, never inside it (#714), and
  // off the request (the void form, #706).
  if (result.taskId) retireTaskCopiesSoon({ taskIds: [result.taskId], outcome: 'done' });

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

  // 0096: the seal is the company's answer, so it teaches the code memory
  // too. `tnved_assignments` is the EXACT-key half (`productKey` = the same
  // normalisation `itemNameNorm` uses) — the intake reads it before anything
  // else and lands a repeat product already coded; `sealedMemoryFor` is the
  // fuzzy half beside it and carries the baza. Source 'manual': a person
  // sealed this, whatever proposed it, and 'ai' here would tell the next
  // reader a machine chose the code.
  //
  // AFTER the transaction and in its own catch: `saveTnved` runs on the POOL
  // and writes its own audit row, so calling it inside the seal's tx is
  // #714's freeze, and a memory that failed to learn must never undo a seal.
  await rememberSealedCodes(workspace, ctx).catch((err) =>
    logger.error({ err, requestId }, '[calc] code memory not updated'),
  );

  await announceSeal(result, totals, input, ctx, requestId).catch((err) =>
    logger.error({ err, requestId }, '[calc] seal notify failed'),
  );

  return { versionNo: result.versionNo, totalUsd: totals.totalUsd };
}

/**
 * What the seal teaches the exact-key code memory.
 *
 * One row per DISTINCT product name that carries a code — a request with the
 * same name twice teaches once, and the last write wins, which is the same
 * row either way. A name without a code teaches nothing (a yolkira seal has
 * no codes at all), and an unreadable code is skipped rather than throwing:
 * `saveTnved` refuses anything that is not 4-10 digits, and one bad row must
 * not stop the rest of the request from being remembered.
 */
async function rememberSealedCodes(workspace: Workspace, ctx: AuditContext): Promise<void> {
  const { saveTnved } = await import('../tnved/service');
  const seen = new Set<string>();
  // Every item of the request: a grouped one AND an ungrouped one — the code
  // is on the ITEM (phase 2), and a group is only how it is priced.
  const all = [...workspace.groups.flatMap((g) => g.items), ...workspace.ungrouped];
  for (const item of all) {
    const code = (item.tnvedCode ?? '').trim();
    const name = item.label.trim();
    if (!code || !name) continue;
    const key = itemNameNorm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await saveTnved({ nameZh: name, nameRu: null, code, source: 'manual' }, ctx);
    } catch (err) {
      logger.warn({ err, code }, '[calc] one sealed code not remembered');
    }
  }
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
  requestId: string,
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
    // WHO hears about a concession (round 112, his «4c»): the owner, the
    // seller whose job it is, and the accountant — and nobody else. This used
    // to go to `finance.debt_override` holders, a set borrowed from the
    // handover-debt approval that happens to include EVERY seller and every
    // warehouse manager, so one seller's discount was company news. The owner
    // is the admin ROLES (his own accounts carry «bir admin va sotuvchi»,
    // not necessarily super_admin). On a correction `requestedBy` is whoever
    // pressed «Qayta hisoblash», so the ORIGINAL request's seller is added
    // through `supersedesRequestId`, or the person whose price this locks
    // hears nothing (the review's cross-lens find).
    const deciders = await discountAudience(result.requestedBy, requestId);
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


/** The people a sealed concession is reported to — see the call site. */
async function discountAudience(requestedBy: string, requestId: string): Promise<string[]> {
  const [owners, accountants, req] = await Promise.all([
    usersWithRoles(['super_admin', 'admin']),
    usersWithRoles(['accountant']),
    db.query.calcRequests.findFirst({
      where: eq(calcRequests.id, requestId),
      columns: { supersedesRequestId: true },
    }),
  ]);
  const original = req?.supersedesRequestId
    ? await db.query.calcRequests.findFirst({
        where: eq(calcRequests.id, req.supersedesRequestId),
        columns: { requestedBy: true },
      })
    : null;
  return [
    ...new Set(
      [...owners, ...accountants, requestedBy, original?.requestedBy ?? null].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
}


/**
 * «This workspace can be sealed» — ONE predicate for three doors (#513): the
 * seal itself (`not_ready`), the seal button, and — since round 112 — the
 * phase-A «Готово» fallback, which refuses a hand-typed price on a job the
 * VED could have sealed. The typed answer exists for the workspace that
 * cannot price (#775: empty dictionaries); on one that can, it was a way to
 * close the job with a number nobody sealed — no version, no card lock, no
 * floor for the upsale, no discount notice, nothing for E1 to measure.
 */
export function canSeal(workspace: {
  blockers: unknown[];
  totals: { ok: boolean } | null;
}): boolean {
  return workspace.blockers.length === 0 && Boolean(workspace.totals?.ok);
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
 * «Qayta hisoblash»: a correction is a NEW request seeded from a PRICED one —
 * a sealed version, or since 2026-10-06 a Готово answer (his 10a, «muhrlanganlar
 * bilan bir xil qoida»).
 *
 * Re-opening the old one by clearing `completed_at` would re-arm the overdue
 * sweep, the clock and the manual «Bajarildi» against a request that already
 * has a price behind it. This is also exactly what an EXPIRED quote needs, so
 * there is one path and not two.
 *
 * The parent must have a price, and the words say which it lacks (review
 * tests-completeness-5): an open parent `not_closed`, a handed-back one
 * `parent_returned`, a price-less one `not_priced`. A parent with a child is
 * refused by how the child ended: open → `recalc_open` («finish that one»),
 * returned or closed price-less → `recalc_returned` (the chain has no way on
 * from here; the door is a NEW request from the card — review
 * ved-correctness-5, which decides tests-completeness-22's exit this way and
 * states it), priced → `recalc_superseded` («recalc from the newest»).
 *
 * The correction lands in the queue like any request (review
 * ved-correctness-1, -19, data-migration-15):
 *   - `requested_by` is the ROOT request's seller, never the admin who
 *     pressed — the correction's CalcSealed / CalcDone must reach the person
 *     who will quote it (one walk up `supersedes_request_id`, which also
 *     repairs chains corrected before this fix);
 *   - it is assigned to whoever PRICED the parent when the rota would hand
 *     them work at all (`vedRotaPool` — never the owner or an admin), else
 *     to the rota, else unassigned (the admin keeps «Olaman»);
 *   - its task opens through `createTask` bound to the request, so the clock
 *     and the holder are the queue's;
 *   - the seller is told the old price no longer stands, which is true by
 *     the money rules as they are: the edge supersedes at the press
 *     (`answerFloorStandsSql`, `payableOffersSql`, unchanged).
 * Corrections made before this round keep their requester and have no task
 * (stated; no backfill here).
 */
export async function recalcFromSealed(
  requestId: string,
  ctx: AuditContext,
): Promise<string> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  const old = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, requestId) });
  if (!old) throw new CalcError('not_found');
  if (!old.completedAt) throw new CalcError('not_closed');
  if (old.completedVia === 'returned') throw new CalcError('parent_returned');
  // Its name promises a PRICED parent, and `completed_at` alone does not say
  // so: a «lines» ending or a price-less task close stamps it too.
  const [sealed] = await db
    .select({ id: calcVersions.id, sealedBy: calcVersions.sealedBy })
    .from(calcVersions)
    .where(eq(calcVersions.requestId, requestId))
    .orderBy(desc(calcVersions.versionNo))
    .limit(1);
  const answered = isAnswer(old);
  if (!sealed && !answered) throw new CalcError('not_priced');
  // Whoever PRICED it: the sealer of a seal, the answerer of an answer.
  const pricer = sealed ? sealed.sealedBy : old.completedBy;

  // The ROOT's seller — the person every correction in the chain is for.
  const root = await db.execute<{ requested_by: string }>(sql`
    WITH RECURSIVE up AS (
      SELECT id, supersedes_request_id, requested_by, 0 AS depth
        FROM calc_requests WHERE id = ${requestId}::uuid
      UNION ALL
      SELECT r.id, r.supersedes_request_id, r.requested_by, u.depth + 1
        FROM calc_requests r JOIN up u ON r.id = u.supersedes_request_id
       WHERE u.depth < 64
    )
    SELECT requested_by::text AS requested_by FROM up
     WHERE supersedes_request_id IS NULL
     LIMIT 1
  `);
  const seller = root[0]?.requested_by ?? old.requestedBy;

  // Pooled, so BEFORE the transaction (#714).
  const pool = await vedRotaPool();
  const assigneeId = pricer && pool.includes(pricer) ? pricer : await nextVedAssignee();
  const dueAt = new Date(Date.now() + calcDueMinutes(old.itemCount, Boolean(old.noteId)) * 60_000);

  // A correction starts from the chain's NEWEST link, never from one that
  // already has a child. This is a MONEY fence before it is a numbering one:
  // two children off one parent both stand (`notSupersededSql` sees no child
  // on either), so `payableOffersSql` pays the seller's commission on BOTH,
  // and the cargo link (`stampCalcLink`, «exactly one sealed request») can
  // no longer choose.
  let newId: string;
  try {
    newId = await db.transaction(async (tx) => {
      /**
       * ONE CORRECTION PER PARENT, decided under the PARENT'S LOCK (audit A11).
       *
       * The check used to run on the pool before the insert, so two people
       * pressing «Qayta hisoblash» in the same second both passed it and both
       * inserted — and both children then STOOD: `notSupersededSql` sees no
       * child on either, so `payableOffersSql` pays the seller's commission
       * twice for one sale and `stampCalcLink`'s «exactly one sealed request»
       * can no longer choose which price the cargo was quoted at.
       *
       * `FOR UPDATE` on the parent serialises the two callers; the loser's
       * re-read (a new statement, so a new snapshot in READ COMMITTED) then
       * sees the committed child and gets the sentence. 0096's partial UNIQUE
       * index is the database saying the same thing — and `isUniqueViolation`
       * below maps it to the same word, because a fence nobody translates is a
       * white page.
       */
      await tx.execute(sql`SELECT id FROM calc_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
      const [child] = await tx.execute<{ state: string | null }>(sql`
        SELECT ${childStateSql(sql`${requestId}::uuid`)} AS state
      `);
      if (child?.state === 'open') throw new CalcError('recalc_open');
      if (child?.state === 'returned' || child?.state === 'unpriced') {
        throw new CalcError('recalc_returned');
      }
      if (child?.state) throw new CalcError('recalc_superseded');

      const [fresh] = await tx
        .insert(calcRequests)
        .values({
          entityType: old.entityType,
          entityId: old.entityId,
          requestedBy: seller,
          assigneeId,
          itemCount: old.itemCount,
          section: old.section,
          fromCity: old.fromCity,
          toCity: old.toCity,
          weightKg: old.weightKg,
          volumeM3: old.volumeM3,
          source: old.source,
          noteId: old.noteId,
          freightZone: old.freightZone,
          // VED 2.0 (J19's rule): a correction inherits the certificate answer
          // and the fee override — the sender did not change, only the numbers.
          hasCertificate: old.hasCertificate,
          feeOverrideUsd: old.feeOverrideUsd,
          supersedesRequestId: old.id,
          takenAt: assigneeId ? new Date() : null,
          dueAt,
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
            // VED 2.0: the law's shape travels with the rates it shapes — a
            // correction that dropped the MAX floor would re-price the job.
            dutyMode: g.dutyMode,
            dutySpecific: g.dutySpecific,
            dutyUnit: g.dutyUnit,
            excisePct: g.excisePct,
            hasCertificate: g.hasCertificate,
            rateSource: g.rateSource,
            dutyFree: g.dutyFree,
            vatFree: g.vatFree,
            aiProposed: g.aiProposed,
            // The model's own words go across too. Without them
            // `unchangedFromProposal` answers false for every group of a
            // correction, so `ai_blind_groups` was permanently 0 on exactly
            // the calculations somebody had already had to redo.
            aiProposal: g.aiProposal,
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
          // A correction inherits WHERE the price came from, or the chip and
          // the ✅'s `baza_from_import` would vanish the moment somebody
          // re-priced the job (0094). 0096's two memory columns travel with
          // it for the same reason — and `name_norm` besides, or the row this
          // correction seals would be invisible to the next job's memory.
          importRowId: item.importRowId,
          memoryItemId: item.memoryItemId,
          bazaReason: item.bazaReason,
          nameNorm: item.nameNorm ?? itemNameNorm(item.name),
          // Phase 3: a column absent from this explicit list is NULL on every
          // correction — exactly the freshest measures missing (0087's rule).
          measureUnit: item.measureUnit,
          measureQty: item.measureQty,
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
  } catch (err) {
    // 0096's partial UNIQUE index, said in the office's words. The lock above
    // decides it first; this is the answer when two callers reach the INSERT
    // from different processes in the same instant.
    if (isUniqueViolation(err)) throw new CalcError('recalc_open');
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'calc_request',
    entityId: newId,
    action: 'create',
    after: { supersedes: requestId },
  });
  // The CARD's own row too, in the same vocabulary as every other calc
  // ending, so the seller's History tab says the price was reopened.
  await writeAudit(db, ctx, {
    entityType: old.entityType,
    entityId: old.entityId,
    action: 'update',
    after: { calcRecalc: newId, calcRequest: requestId },
  });

  const label = await requestLabel(old.entityType, old.entityId);
  // The task: what puts the correction on the holder's /bugun and phone,
  // bound to the request so no task door can move its clock or close it
  // (docs/VED-TARIX.md §8). After the commit, never inside it (#714); a
  // failure leaves a request «Olaman» can still give a task — a task with no
  // request would be the ghost.
  if (assigneeId) {
    try {
      const task = await createTask(
        {
          title: `Hisoblash: ${label} (${old.itemCount})`,
          note: '',
          typeId: null,
          assigneeId,
          dueAt: dueAt.toISOString(),
          priority: 1,
          entityType: old.entityType,
          entityId: old.entityId,
          repeatUnit: null,
          repeatEvery: 1,
        },
        ctx,
        { origin: 'calc', boundId: newId },
      );
      await db
        .update(calcRequests)
        .set({ taskId: task.id, updatedAt: new Date() })
        .where(eq(calcRequests.id, newId));
    } catch (err) {
      logger.error({ err, newId }, '[calc] correction task creation failed');
    }
  }
  await notifyStaffTelegram({
    userIds: [seller],
    type: 'CalcRecalc',
    text:
      `🔄 ${label}: narx qayta hisoblanmoqda — eski narx endi amal qilmaydi` +
      linkLine(old.entityType, old.entityId),
    exceptUserId: ctx.actorId,
  }).catch((err) => logger.error({ err, newId }, '[calc] recalc notify failed'));
  // The old price's channel post gets its «qayta hisoblanmoqda» mark — derived
  // by the drain's reconcile from the graph this insert just changed; the
  // kick only makes it soon (his F).
  kickPriceChannel();
  return newId;
}

// ---------------------------------------------------------------------------

async function nextSeq(
  handle: TxHandle | typeof db,
  table: typeof calcGroups | typeof calcExtras,
  requestId: string,
): Promise<number> {
  const [row] = await handle
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

/**
 * Today's warnings for every group of a request, keyed by group id.
 *
 * Reads the workspace rather than restating the query, so the list recorded
 * at confirm time is the same list the screen was showing (#513).
 */
async function warningsNow(
  requestId: string,
): Promise<{ byGroup: Map<string, CalcWarningKind[]>; rev: number }> {
  const w = await loadWorkspace(requestId);
  // The rev rides the SAME loadWorkspace call — a capture read any later
  // would let a save land between the compute and the capture and pass.
  return { byGroup: new Map((w?.groups ?? []).map((g) => [g.id, g.warnings])), rev: w?.rev ?? -1 };
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
 * How long a held AI claim is believed.
 *
 * ONE constant for the two places that ask (#513): the claim that TAKES the
 * request and the workspace lock that REFUSES while somebody holds it. If the
 * lock healed sooner than the claim, an edit would land under a pass still
 * running; if the claim healed sooner than the lock, the pass would be
 * refused by a lock it had itself been granted.
 */
export const AI_CLAIM_STALE_MS = 10 * 60_000;

/**
 * Is an AI claim still holding the request? ONE home for the window, asked by
 * the workspace lock, the screen's chip and the clock probe.
 *
 * Takes TEXT as well as a Date on purpose: a raw `tx.execute` hands a
 * timestamptz back as a string whatever its generic type says (#923), and a
 * `.getTime()` on that string is a TypeError inside the lock. A value that
 * does not read as a time is NOT a claim — a garbage stamp must never brick
 * the table.
 */
export function aiClaimLive(startedAt: Date | string | null, now = Date.now()): boolean {
  if (startedAt === null) return false;
  const at = new Date(startedAt).getTime();
  return Number.isFinite(at) && now - at < AI_CLAIM_STALE_MS;
}

/**
 * The request's clock as the phone's probe reads it (his B6 a — «boshqa kishi
 * hozirgina o'zgartirdi»): one indexed pool read, never inside a transaction
 * (#714), typed by drizzle so the claim arrives as a Date. Null when the
 * request does not exist.
 */
export async function requestClock(
  requestId: string,
): Promise<{ rev: number; aiRunning: boolean; closed: boolean } | null> {
  const [row] = await db
    .select({
      rev: calcRequests.rev,
      completedAt: calcRequests.completedAt,
      aiProposalStartedAt: calcRequests.aiProposalStartedAt,
    })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId))
    .limit(1);
  if (!row) return null;
  return { rev: row.rev, aiRunning: aiClaimLive(row.aiProposalStartedAt), closed: row.completedAt !== null };
}

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
): Promise<{
  groups: number;
  batches: number;
  failed: number;
  ratesPulled: number;
  codesStamped: number;
  importFilled: number;
}> {
  await assertOpen(requestId);

  const claimed = await db
    .update(calcRequests)
    .set({ aiProposalStartedAt: new Date() })
    .where(
      and(
        eq(calcRequests.id, requestId),
        or(
          isNull(calcRequests.aiProposalStartedAt),
          // …or the holder is GONE. The release lives in a `finally`, which
          // runs for a refusal and a thrown call and not for a killed
          // process — and this app is restarted on every deploy, with a bot
          // dispatching this pass in the background. Without the window a
          // single unlucky restart answered `ai_running` to that request for
          // ever, with no sweep and no reaper anywhere to clear it. Same
          // window `lockRequestInTx` already heals on, from the same
          // constant, so the two cannot drift apart (#513).
          lt(calcRequests.aiProposalStartedAt, new Date(Date.now() - AI_CLAIM_STALE_MS)),
        ),
      ),
    )
    .returning({ id: calcRequests.id });
  if (claimed.length === 0) throw new CalcError('ai_running');

  try {
    const items = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, requestId))
      .orderBy(asc(calcRequestItems.seq));
    if (items.length === 0) throw new CalcError('no_items');

    const { proposeGoodsGrouping, TnvedError } = await import('../tnved/service');
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
        // One ledger row per model call (0096), so a real week of this can
        // be read as a bill. Never throws — see `recordAiPass`.
        if (answer.usage) {
          await recordAiPass({
            requestId,
            staffId: ctx.actorId ?? null,
            kind: 'grouping',
            model: answer.usage.model,
            inputTokens: answer.usage.inputTokens,
            outputTokens: answer.usage.outputTokens,
          });
        }
      } catch (err) {
        // NO KEY IS NOT «THE MODEL DID NOT ANSWER» (audit A25). Every other
        // failure here is per-batch and survivable; a missing key is a fact
        // about the SERVER that no later batch can improve, and swallowing it
        // sent the VED «ИИ не ответил» — a sentence that invites pressing
        // again — while the honest word existed two lines away in every
        // bundle. Rethrown unchanged, and the button is not even drawn when
        // `workspace.aiConfigured` is false.
        if (err instanceof TnvedError && err.code === 'ai_not_configured') {
          throw new CalcError('ai_not_configured');
        }
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
    // …and then the proposal is turned into a CALCULATION.
    //
    // MEASURED before it was written (a probe on a real request): the
    // proposal alone leaves a group carrying the code and NOTHING else —
    // `duty_pct` and `vat_pct` null, so `customsFor` refuses `rates_missing`
    // — and it never stamps the item's own `tnved_code`, so phase 2's «the
    // code on the row is what groups and prices it» machinery and 0094's
    // customs-import baza fill both stay asleep. Pressing ✨ therefore
    // produced a request nobody could price, over a book of 1,489 seeded
    // PP-3818 rates that answers for nearly every code: the VED had to pull
    // each group's rates by hand and retype every code the model had found.
    //
    // Both halves go through doors that already exist, and NEITHER lets the
    // model reach a number: `pullRatesFromDictionary` writes the BOOK's rate
    // for the code (source 'dictionary'), and `saveTable` writes the model's
    // CODE onto the row exactly as a person typing it would — which is also
    // what makes the import fill fire. Law 1's fence is untouched:
    // `applyProposal` still writes no rate column at all.
    // THE CLAIM COMES OFF FIRST, and it has to.
    //
    // The tail writes through `pullRatesFromDictionary` and `saveTable`, and
    // BOTH take `lockRequestInTx`, which refuses on exactly the claim this
    // function is holding — so the tail ran, was refused `ai_running` on
    // every group, and logged it as «this code has no dictionary rate».
    // Measured, not read: the whole pricing half was dead in production and
    // green in the tests, because the test called the tail directly with no
    // claim held (#531, a third time in this module).
    //
    // Releasing here rather than threading `ignoreAiClaim` through two more
    // public doors is not a shortcut, it is what the claim MEANS: its stated
    // job is that «two people pressing the button do not both spend a model
    // call on the same thousand goods», and by this line that call is spent.
    // What guards the writes from here on is the rev clock and `FOR UPDATE`,
    // which is what guards every other writer. The `finally` still runs — the
    // release is an idempotent UPDATE — so a throw in the tail cannot strand
    // the claim.
    await releaseAiClaim(requestId);
    const priced = await priceProposedGroups(requestId, ctx);
    return { groups: drafts.length, batches: batches.length, failed, ...priced };
  } finally {
    await releaseAiClaim(requestId);
  }
}

/** Idempotent, because both the happy path and the `finally` call it. */
async function releaseAiClaim(requestId: string): Promise<void> {
  await db
    .update(calcRequests)
    .set({ aiProposalStartedAt: null })
    .where(eq(calcRequests.id, requestId));
}

/**
 * Turn a landed proposal into something the engine can price.
 *
 * Two steps, in this order and for a reason: the rates come FIRST because
 * the group's `duty_unit` is what says which of the customs file's units may
 * price a row (0094's `unitsForRow`), and the item codes come second because
 * `saveTable` is the ONE writer that runs the sweep, the measure pass and
 * the import fill together.
 *
 * A code the dictionary has never heard of is SKIPPED, not fatal: the model
 * proposes codes for a living, and one it invented must cost its own group's
 * rates and never the other nine groups' — `proposeGroups`'s own batch rule,
 * one level down.
 *
 * Exported for the integration test alone: `proposeGroups` needs a model and
 * this container has no key, so the behaviour is proven by driving the tail
 * directly and the CALL is pinned by `tests/unit/proposal-wire.test.ts`.
 */
export async function priceProposedGroups(
  requestId: string,
  ctx: AuditContext,
): Promise<{ ratesPulled: number; codesStamped: number; importFilled: number }> {
  const groups = await db
    .select({
      id: calcGroups.id,
      tnvedCode: calcGroups.tnvedCode,
      dutyPct: calcGroups.dutyPct,
      vatPct: calcGroups.vatPct,
    })
    .from(calcGroups)
    .where(eq(calcGroups.requestId, requestId));

  let ratesPulled = 0;
  for (const g of groups) {
    if (!(g.tnvedCode ?? '').trim()) continue;
    if (g.dutyPct !== null && g.vatPct !== null) continue;
    try {
      await pullRatesFromDictionary(g.id, ctx);
      ratesPulled += 1;
    } catch (err) {
      // Only the rate LOOKUP's own refusals belong here. Anything else — a
      // lock, a closed request, a bad number — is a fact about the request
      // and not about this code, and swallowing it under «no dictionary
      // rate» is how a dead pricing half read as a book with holes in it.
      if (!(err instanceof CalcError)) throw err;
      if (err.code !== 'rates_not_in_dictionary' && err.code !== 'code_required') throw err;
      logger.info(
        { requestId, groupId: g.id, code: g.tnvedCode, reason: err.code },
        '[calc] proposed code has no dictionary rate',
      );
    }
  }

  // The item's own code — phase 2's grain, and what 0094's import fill keys
  // on. Through `saveTable`, never a bare UPDATE: the sweep, the measure
  // pass, the rev clock and the baza suggestion all ride that one door.
  const items = await db
    .select({
      id: calcRequestItems.id,
      seq: calcRequestItems.seq,
      tnvedCode: calcRequestItems.tnvedCode,
      groupId: calcRequestItems.groupId,
    })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId));
  const codeOfGroup = new Map(groups.map((g) => [g.id, (g.tnvedCode ?? '').trim()]));
  const edits = items
    .filter((i) => {
      const code = i.groupId ? (codeOfGroup.get(i.groupId) ?? '') : '';
      return code !== '' && (i.tnvedCode ?? '') !== code;
    })
    .map((i) => ({ id: i.id, seq: i.seq, tnvedCode: codeOfGroup.get(i.groupId!)! }));
  if (edits.length === 0) return { ratesPulled, codesStamped: 0, importFilled: 0 };

  const saved = await saveTable(requestId, { items: edits, adds: [] }, ctx);
  return {
    ratesPulled,
    codesStamped: edits.length,
    importFilled: saved.importFilled.length,
  };
}

// ---------------------------------------------------------------------------
// The table (VED 2.0 phase 2) — one save, auto-grouping by TNVED code
// ---------------------------------------------------------------------------

/**
 * The Excel-table workspace's one write door.
 *
 * The owner's pain this phase exists for: «gruh yasab ulanga tovarlarni
 * ulash juda ish kop». A group stops being a thing a person CREATES — the
 * VED types a TNVED code on the item row and the item lands in that code's
 * group by itself, find-or-create, with the PP-3818 rates pulled from the
 * dictionary at mint. One save carries a hundred cells (per-cell round
 * trips at 100 items is the freeze round 108 measured), so everything runs
 * in ONE transaction opened with `FOR UPDATE` on the request row — the
 * judge's finding: `assertOpen` is a check, not a lock, and two saves
 * minting seqs off the same max(seq) collide on the unique index.
 *
 * TX LAW (#714/#725): nothing inside the transaction calls a pooled
 * helper — the dictionary rates are read BEFORE the tx, the audit rides
 * the tx handle, and the confirmation clears are inline (all FOUR columns,
 * or `calc_groups_confirm_pair_check` 23514s the next press).
 */
export interface TableItemEdit {
  /** The immutable address: seqs are re-minted after a delete (max+1), so an
   * edit keyed by seq could land a stranded draft on DIFFERENT cargo. */
  id: string;
  /** Display order — a refusal names the row by it. */
  seq: number;
  name?: string;
  quantity?: number | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  tnvedCode?: string | null;
  note?: string | null;
  /** The amount in the row's pair unit (juft/litr/m²/sm³). The UNIT is never
   * posted — the server stamps it by `pairUnitFor`: the law's pair unit when
   * the code has one, else the row's own pair BASIS (an m² baza on an advalor
   * code); a posted unit could disagree with the code it rides. */
  measureQty?: number | null;
  /**
   * The row's baza (0125's four states — `bazaUsd` undefined leaves it alone):
   * - an amount + a basis — priced per that unit, the VED's word;
   * - an amount + NULL basis — «avto»: the stored basis stands, and a row
   *   with none takes the law's default from its FINAL group (18a), stamped
   *   inside the measure pass — never from the pre-tx dictionary read, since
   *   a typed code can join a group whose law a person typed;
   * - NULL amount + a basis — no price yet, but the unit is CHOSEN and stands
   *   (the snap-back the owner reported had a second costume here: a unit
   *   picked on an unpriced row posted nothing and vanished on Saqlash);
   * - NULL + NULL — clears amount, basis and source together.
   */
  bazaUsd?: number | null;
  bazaBasis?: BazaBasis | null;
  /** A row PICKED out of the customs import. The id is a claim: the server
   * re-reads that row, refuses one that does not price this very code, and
   * takes the PRICE and the BASIS from the file — never from the browser
   * (the `pullRates` rule, #778). A posted `bazaUsd` is ignored when this is
   * set; clearing the baza clears this with it. */
  importRowId?: string | null;
  /**
   * The model's one-line REASON for choosing this declaration (0096).
   *
   * SERVER-SIDE ONLY — the browser never posts it, and there is no input for
   * it: it is what the machine said about its own pick, not a field a person
   * edits. A typed baza clears it, like every other half of the provenance.
   */
  bazaReason?: string | null;
  /**
   * What the screen SHOWED under this edit's cells at the press — the stored
   * values of exactly the fields the draft stands on (review PHONE-2). The
   * phone sheet's B6 look is a probe before the post, and a colleague's save
   * landing between that look and this commit would otherwise be overwritten
   * unseen; compared under the request lock, a row that moved since is
   * refused `changed_under` naming it, and the screen brings the change in.
   * Not a lock: the next press, with the change on the screen, carries what
   * it then showed. The grid posts none (its silence is by design), and
   * neither does the machine.
   */
  expect?: TableExpect;
}

/** The stored values an edit was made over — `RowBase` on the screen. */
export type TableExpect = Partial<{
  label: string;
  tnvedCode: string | null;
  quantity: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  note: string | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
  bazaUsd: number | null;
  bazaBasis: BazaBasis | null;
}>;

/**
 * Did the stored row move under what the screen showed? Only the fields the
 * expectation names; numbers at the column's own scale, text trimmed (an
 * empty note is no note). A field that is not a known one, or a value of the
 * wrong shape, counts as moved — a crafted expectation refuses, it never
 * waves a write through.
 */
export function movedUnder(
  expect: TableExpect,
  stored: {
    name: string;
    tnvedCode: string | null;
    quantity: string | null;
    weightKg: string | null;
    volumeM3: string | null;
    note: string | null;
    measureUnit: string | null;
    measureQty: string | null;
    bazaUsd: string | null;
    bazaBasis: string | null;
  },
): boolean {
  const scaled = (v: number | string | null, places: number) =>
    v === null ? null : Number(Number(v).toFixed(places));
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null ? '' : undefined);
  for (const [key, value] of Object.entries(expect)) {
    if (value === undefined) continue;
    switch (key) {
      case 'label':
        if (text(value) !== stored.name.trim()) return true;
        break;
      case 'tnvedCode':
      case 'note':
        if (text(value) !== (stored[key] ?? '').trim()) return true;
        break;
      case 'quantity':
      case 'weightKg':
      case 'volumeM3':
      case 'measureQty':
      case 'bazaUsd': {
        // A number off the wire, never a numeric string read as one (a NaN or
        // an Infinity can equal no stored figure, so it reads as moved anyway).
        if (value !== null && typeof value !== 'number') return true;
        const places = key === 'measureQty' || key === 'bazaUsd' ? 4 : 3;
        if (scaled(value, places) !== scaled(stored[key], places)) return true;
        break;
      }
      case 'measureUnit':
      case 'bazaBasis':
        if ((value ?? null) !== (stored[key] ?? null)) return true;
        break;
      default:
        return true;
    }
  }
  return false;
}

export interface TableSaveResult {
  /** Freshly minted codes, so the bar can say «+N yangi kod: …» — a typo'd
   * code shows up as a surprise one-item block instead of pricing silently
   * off a prefix match. */
  minted: string[];
  /** Coded-but-ungrouped items the SWEEP placed (intake prefills codes from
   * the TNVED memory, so the commonest request arrives pre-coded with
   * nothing dirty — any save heals the backlog). */
  swept: number;
  added: number;
  /** Legacy same-code duplicate groups this save merged — only ever when
   * their whole rate column set is identical, and always announced. */
  merged: string[];
  /** Rows whose measure pair was CLEARED because the required unit changed —
   * a quantity is a statement IN a unit, and the unit changed. Named, never
   * silent. */
  measuresCleared: number[];
  /** Rows whose posted measure was DROPPED — the code needs no extended
   * unit. Never a whole-save refusal: the box was on the screen in good
   * faith (a new row's law shape is unknowable before the save). */
  measuresDropped: number[];
  /** PRICED rows recoded or added in THIS save whose basis is not the one
   * the new law counts in (0125's A2: a priced row keeps the unit its price
   * was typed in — a number typed «per dona» does not silently become «per
   * juft»). Advisory and NAMED, never a silent rewrite (#171 inverted); an
   * unpriced row simply follows the new code. */
  basisSuspect: number[];
  /** Rows whose basis the law cannot hold (a pair unit on a juft/litr/m²
   * code, after a recode or a file pick): the law's own pair stands, the
   * engine refuses `measure_missing` naming the row, and the select shows
   * ⚠ until a person picks a unit that fits. Never rewritten silently. */
  basisConflict: number[];
  /** New rows whose client id this request ALREADY holds — a retried save
   * whose first answer was lost. Skipped, so a goods line is never written
   * twice (phase 0 of the phone round). */
  alreadySaved: number;
  /** Rows whose EMPTY baza this save filled from the customs import (0094).
   * Named, never silent — his own rule is that a suggestion the VED cannot
   * see is a price nobody stated: «agar to'g'ri bo'lmasa baza yo'q deb VED
   * hodimi o'zi qo'yadi». */
  importFilled: number[];
  /** …and rows filled from a SEALED calculation (0096): the company's own
   * confirmed price for this product, which outranks the file. Named the
   * same way, for the same reason. */
  memoryFilled: number[];
  /** The request's rev AFTER this save, as the save itself wrote it — the
   * screen settles exactly what it posted once a refresh reaches this rev
   * (the phone round, D3). Required: every constructor must answer. */
  rev: number;
}

const CODE_SHAPE = /^\d{4,10}$/;
/** A client-minted row id (phase 0): the same shape the database mints. */
const CLIENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a table code cell: '' → null, digits 4-10 → trimmed, else refused. */
function tableCode(raw: string | null | undefined, seq: number): string | null {
  const code = (raw ?? '').trim();
  if (!code) return null;
  if (!CODE_SHAPE.test(code)) throw new CalcError('bad_code', seq);
  return code;
}

function tableMeasure(v: number | null | undefined, seq: number): number | null {
  if (v === null || v === undefined) return null;
  if (!isNumber(v)) throw new CalcError('bad_number', seq);
  if (!(v > 0)) throw new CalcError('measure_positive', seq);
  // numeric(12,3) holds nine digits; past it the INSERT dies 22003 as a
  // white page. The cap sits at the true column boundary.
  if (v >= 1e9) throw new CalcError('bad_number', seq);
  return v;
}

type TxHandle = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The four-column confirmation clear, on the TX handle (never the pool). */
async function unconfirmInTx(tx: TxHandle, groupIds: Iterable<string>) {
  const ids = [...new Set(groupIds)].filter(Boolean);
  if (ids.length === 0) return;
  await tx
    .update(calcGroups)
    .set({ confirmedBy: null, confirmedAt: null, confirmVia: null, confirmedWarnings: null })
    .where(inArray(calcGroups.id, ids));
}

/**
 * Lock the request row and refuse what must be refused, INSIDE the tx.
 *
 * `FOR UPDATE` serializes concurrent saves (seq minting, itemCount, the
 * emptied-group delete all stop racing); the completedAt check re-runs
 * under the lock because assertOpen's answer can go stale between the read
 * and the write; and a LIVE AI proposal claim refuses — applyProposal
 * deletes and recreates every group, so a table edit landing mid-pass would
 * be silently destroyed. The claim counts as live for ten minutes: the
 * pass takes single minutes, and a claim a crashed process left behind must
 * not brick the table for ever.
 */
async function lockRequestInTx(
  tx: TxHandle,
  requestId: string,
  opts: { ignoreAiClaim?: boolean } = {},
): Promise<{ rev: number }> {
  const rows = await tx.execute<{
    id: string;
    completed_at: Date | null;
    ai_proposal_started_at: Date | string | null;
    rev: number;
  }>(
    sql`SELECT id, completed_at, ai_proposal_started_at, rev FROM calc_requests WHERE id = ${requestId}::uuid FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) throw new CalcError('not_found');
  if (row.completed_at) throw new CalcError('already_closed');
  // `ignoreAiClaim` exists for exactly one caller: applyProposal, whose OWN
  // flow holds the claim it would otherwise refuse on. The raw value is TEXT
  // here (a raw execute), which aiClaimLive reads as such.
  if (!opts.ignoreAiClaim && aiClaimLive(row.ai_proposal_started_at)) {
    throw new CalcError('ai_running');
  }
  return { rev: row.rev };
}

/** The revision clock's one writer — every mutator moves it, the seal and
 * the confirm doors compare it. An integer under FOR UPDATE cannot collide
 * the way a millisecond timestamp does. */
async function bumpRevInTx(tx: TxHandle, requestId: string) {
  await tx
    .update(calcRequests)
    .set({ rev: sql`${calcRequests.rev} + 1`, updatedAt: new Date() })
    .where(eq(calcRequests.id, requestId));
}

/**
 * EVERY workspace mutator runs through here (or opens its own tx that calls
 * `lockRequestInTx` + bumps — the table doors' shape): lock the request row
 * FIRST — one lock order everywhere, so no two doors can deadlock — re-check
 * closed/claimed under the lock (assertOpen is a check, not a lock: a door
 * statement queued behind a seal must land as a refusal, never as a ghost
 * edit onto a completed request), run the writes, move the clock.
 * `tests/unit/calc-clock.test.ts` derives the mutator list and holds it here.
 */
async function mutateRequest<T>(
  requestId: string,
  fn: (tx: TxHandle, locked: { rev: number }) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const locked = await lockRequestInTx(tx, requestId);
    const out = await fn(tx, locked);
    await bumpRevInTx(tx, requestId);
    return out;
  });
}

/**
 * Find-or-create groups by code and move the given items, on loaded state.
 *
 * Pure orchestration over tx statements. `rates` was read BEFORE the tx;
 * a code the book does not answer mints with NULL rates and NULL source —
 * 'dictionary' over nulls would be a provenance lie the warnings and E1's
 * counters read as the book's word. Returns what to unconfirm and what got
 * minted; the caller deletes emptied groups AFTER all moves (a group that
 * loses its last item to a sibling in the same save is empty only at the
 * end).
 */
async function autoGroupInTx(
  tx: TxHandle,
  requestId: string,
  state: {
    groups: { id: string; seq: number; tnvedCode: string | null }[];
    /** seq → target code (null = ungroup). */
    moves: Map<number, string | null>;
    itemGroupBySeq: Map<number, string | null>;
    rates: Map<string, RatesRow>;
  },
): Promise<{ minted: { id: string; code: string }[]; touched: Set<string> }> {
  const { groups, moves, itemGroupBySeq, rates } = state;
  const byCode = new Map<string, { id: string }>();
  for (const g of groups) {
    const code = (g.tnvedCode ?? '').trim();
    // First by seq wins — one code, one group; a second same-code group is a
    // legacy arrangement the auto-path never adds to.
    if (code && !byCode.has(code)) byCode.set(code, { id: g.id });
  }
  let nextGroupSeq = groups.reduce((m, g) => Math.max(m, g.seq), 0) + 1;
  const minted: { id: string; code: string }[] = [];
  const touched = new Set<string>();

  for (const [seq, code] of moves) {
    const was = itemGroupBySeq.get(seq) ?? null;
    let target: string | null = null;
    if (code !== null) {
      const existing = byCode.get(code);
      if (existing) {
        target = existing.id;
      } else {
        const hit = rates.get(code) ?? null;
        const [made] = await tx
          .insert(calcGroups)
          .values({
            requestId,
            seq: nextGroupSeq++,
            label: code,
            tnvedCode: code,
            dutyPct: hit ? hit.dutyPct.toFixed(3) : null,
            vatPct: hit ? hit.vatPct.toFixed(3) : null,
            // The fee is the DECLARATION's (customsFeeFor), never a per-code
            // number — same rule as pullRatesFromDictionary.
            feeUsd: null,
            dutyMode: hit && hit.dutyMode !== 'advalor' ? hit.dutyMode : null,
            dutySpecific: hit?.dutySpecific != null ? hit.dutySpecific.toFixed(4) : null,
            dutyUnit: hit?.dutyUnit ?? null,
            rateSource: hit ? 'dictionary' : null,
          })
          .returning({ id: calcGroups.id });
        target = made!.id;
        byCode.set(code, { id: target });
        minted.push({ id: target, code });
      }
    }
    if (was === target) continue;
    await tx
      .update(calcRequestItems)
      .set({ groupId: target })
      .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.seq, seq)));
    itemGroupBySeq.set(seq, target);
    // Both ends of the move lose their ✅ — the numbers each was about moved.
    if (was) touched.add(was);
    if (target) touched.add(target);
  }
  return { minted, touched };
}

/** Delete this request's groups that ended the save memberless. Only ever
 * called after every move has landed — and only inside the caller's tx. */
async function pruneEmptyGroupsInTx(
  tx: TxHandle,
  requestId: string,
  candidateIds: Iterable<string>,
): Promise<void> {
  const ids = [...new Set(candidateIds)].filter(Boolean);
  if (ids.length === 0) return;
  await tx.execute(sql`
    DELETE FROM calc_groups g
     WHERE g.request_id = ${requestId}::uuid
       AND g.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       AND NOT EXISTS (SELECT 1 FROM calc_request_items i WHERE i.group_id = g.id)
  `);
}

/** count(*) is the arbiter — a cached itemCount under concurrency is how
 * two saves each pass the cap and the label lies (judge #5/#38).
 *
 * It also moves the clock — exactly once per table save and per delete, an
 * empty save included — and answers the rev it wrote, so the screen can
 * settle the drafts it posted at the server's OWN revision (the phone
 * round's D3: a refresh can land a colleague's rev first). */
async function recountItemsInTx(tx: TxHandle, requestId: string): Promise<{ n: number; rev: number }> {
  const rows = await tx.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM calc_request_items WHERE request_id = ${requestId}::uuid`,
  );
  const n = Number(rows[0]?.n ?? 0);
  const [bumped] = await tx
    .update(calcRequests)
    .set({ itemCount: n, rev: sql`${calcRequests.rev} + 1`, updatedAt: new Date() })
    .where(eq(calcRequests.id, requestId))
    .returning({ rev: calcRequests.rev });
  return { n, rev: bumped!.rev };
}

/**
 * One row's answer from a SEALED calculation, ready to be written (0096).
 *
 * The memory outranks the customs file: the file is what SOMEBODY ELSE
 * declared for this code, the memory is what THIS company confirmed and
 * sealed for this product. Both are still a suggestion the VED can retype.
 */
interface MemoryFill {
  bazaUsd: number;
  basis: BazaBasis;
  memoryItemId: string;
}

/** One row's answer from the customs import, ready to be written. */
interface ImportFill {
  /** The code the suggestion was made FOR — re-checked inside the tx. */
  code: string;
  bazaUsd: number;
  basis: BazaBasis;
  importRowId: string;
}

interface ImportFillPlan {
  byItemId: Map<string, ImportFill>;
  /** Keyed by the add's index, because a ghost row has no id until it is
   * inserted; the insert maps them onto the minted ids. */
  byAddIndex: Map<number, ImportFill>;
}

const EMPTY_FILL_PLAN: ImportFillPlan = { byItemId: new Map(), byAddIndex: new Map() };

/**
 * The sealed memory's auto-fill, computed on the POOL before the transaction.
 *
 * Same shape and same discipline as the import's below it: only rows that
 * will end this save BAZA-LESS are asked about, the answer is applied inside
 * the tx only where the state still agrees, and the basis must be one the
 * row's own law allows. A code is NOT required here — the memory is keyed on
 * the product NAME, which is what the owner's sentence is about.
 */
async function suggestMemoryFills(input: {
  requestId: string;
  standing: {
    id: string;
    name: string;
    quantity: string | null;
    weightKg: string | null;
    bazaUsd: string | null;
  }[];
  itemEdits: {
    id: string;
    name?: string;
    quantity?: number | null;
    weightKg?: number | null;
    bazaUsd?: number | null;
  }[];
  withCodes: { name: string; quantity: number | null; weightKg: number | null; bazaUsd: number | null }[];
}): Promise<{ byItemId: Map<string, MemoryFill>; byAddIndex: Map<number, MemoryFill> }> {
  const empty = { byItemId: new Map<string, MemoryFill>(), byAddIndex: new Map<number, MemoryFill>() };
  const num = (v: string | null) => (v === null ? null : Number(v));
  const wants: { key: { kind: 'item'; id: string } | { kind: 'add'; index: number }; name: string }[] = [];

  const editById = new Map(input.itemEdits.map((e) => [e.id, e]));
  for (const row of input.standing) {
    const e = editById.get(row.id);
    const baza = e && e.bazaUsd !== undefined ? e.bazaUsd : num(row.bazaUsd);
    if (baza !== null) continue;
    wants.push({
      key: { kind: 'item', id: row.id },
      name: e && e.name !== undefined ? e.name : row.name,
    });
  }
  input.withCodes.forEach((r, index) => {
    if (r.bazaUsd !== null) return;
    wants.push({ key: { kind: 'add', index }, name: r.name });
  });
  if (wants.length === 0) return empty;

  const hits = await sealedMemoryFor(
    wants.map((w) => w.name),
    { excludeRequestId: input.requestId },
  );
  if (hits.size === 0) return empty;

  const plan = { byItemId: new Map<string, MemoryFill>(), byAddIndex: new Map<number, MemoryFill>() };
  for (const w of wants) {
    const hit = hits.get(itemNameNorm(w.name));
    // A sealed row with no baza remembers a CODE and nothing to price with.
    if (!hit || hit.bazaUsd === null || hit.bazaBasis === null) continue;
    const fill: MemoryFill = {
      bazaUsd: hit.bazaUsd,
      basis: hit.bazaBasis,
      memoryItemId: hit.itemId,
    };
    if (w.key.kind === 'item') plan.byItemId.set(w.key.id, fill);
    else plan.byAddIndex.set(w.key.index, fill);
  }
  return plan;
}

/**
 * The import's auto-fill, computed on the POOL before the transaction.
 *
 * Only rows that will end this save CODED and BAZA-LESS are asked about: a
 * price the VED typed is never second-guessed, and a code-less row has
 * nothing to look up. `unitsForRow` says which of the file's units may price
 * the row — the law when it pins one, the row's own figures when it does not
 * — so a per-m² declaration can never land on a per-kg row, and the
 * similarity threshold does the rest. His own rule: «agar to'g'ri bo'lmasa
 * baza yo'q deb VED hodimi o'zi qo'yadi.»
 */
async function suggestImportFills(input: {
  standing: {
    id: string;
    name: string;
    tnvedCode: string | null;
    quantity: string | null;
    weightKg: string | null;
    volumeM3: string | null;
    bazaUsd: string | null;
    bazaBasis: string | null;
  }[];
  itemEdits: {
    id: string;
    name?: string;
    tnvedCode?: string | null;
    quantity?: number | null;
    weightKg?: number | null;
    volumeM3?: number | null;
    bazaUsd?: number | null;
    bazaBasis?: BazaBasis | null;
  }[];
  withCodes: {
    name: string;
    tnvedCode: string | null;
    quantity: number | null;
    weightKg: number | null;
    volumeM3: number | null;
    bazaUsd: number | null;
    bazaBasis: BazaBasis | null;
  }[];
  rates: Map<string, RatesRow>;
}): Promise<ImportFillPlan> {
  type Want = {
    key: { kind: 'item'; id: string } | { kind: 'add'; index: number };
    code: string;
    name: string;
    quantity: number | null;
    weightKg: number | null;
    volumeM3: number | null;
    /** The unit the VED CHOSE for this still-unpriced row (0125) — a stored
     * basis on a baza-less row is always a choice, never a stamp. */
    chosen: BazaBasis | null;
  };
  const num = (v: string | null) => (v === null ? null : Number(v));
  const wants: Want[] = [];

  const editById = new Map(input.itemEdits.map((e) => [e.id, e]));
  for (const s of input.standing) {
    const e = editById.get(s.id);
    const code = e && e.tnvedCode !== undefined ? e.tnvedCode : s.tnvedCode;
    const baza = e && e.bazaUsd !== undefined ? e.bazaUsd : num(s.bazaUsd);
    if (!code || baza !== null) continue;
    const storedBasis = isBazaBasis(s.bazaBasis) ? s.bazaBasis : null;
    wants.push({
      key: { kind: 'item', id: s.id },
      code,
      name: e && e.name !== undefined ? e.name : s.name,
      quantity: e && e.quantity !== undefined ? e.quantity : num(s.quantity),
      weightKg: e && e.weightKg !== undefined ? e.weightKg : num(s.weightKg),
      volumeM3: e && e.volumeM3 !== undefined ? e.volumeM3 : num(s.volumeM3),
      chosen: e && e.bazaUsd !== undefined ? (e.bazaBasis ?? null) : storedBasis,
    });
  }
  input.withCodes.forEach((r, index) => {
    if (!r.tnvedCode || r.bazaUsd !== null) return;
    wants.push({
      key: { kind: 'add', index },
      code: r.tnvedCode,
      name: r.name,
      quantity: r.quantity,
      weightKg: r.weightKg,
      volumeM3: r.volumeM3,
      chosen: r.bazaBasis,
    });
  });
  if (wants.length === 0) return EMPTY_FILL_PLAN;

  const batchId = await newestReadyBatchId();
  // No import yet — the module ships with an empty table, exactly as the four
  // dictionaries do, and a request saved today must behave as it did before.
  if (!batchId) return EMPTY_FILL_PLAN;

  const minSimRaw = await getSetting('import_baza_min_sim');
  const minSim = Number(minSimRaw);

  const plan: ImportFillPlan = { byItemId: new Map(), byAddIndex: new Map() };
  // One question per DISTINCT row shape: a fifty-line invoice repeats the
  // same product under one code, and asking per line is fifty identical
  // trigram scans (#432).
  const asked = new Map<string, ImportFill | null>();
  for (const w of wants) {
    const units = unitsForRow({
      dutyUnit: input.rates.get(w.code)?.dutyUnit ?? null,
      chosen: w.chosen,
      hasWeight: w.weightKg !== null && w.weightKg > 0,
      hasQuantity: w.quantity !== null && w.quantity > 0,
      hasVolume: w.volumeM3 !== null && w.volumeM3 > 0,
    });
    // His rule for piece goods: «har bir tovarni ogirligiga qaraymiz». Only
    // meaningful when the row states BOTH a count and a weight.
    const perPiece =
      w.quantity !== null && w.quantity > 0 && w.weightKg !== null && w.weightKg > 0
        ? w.weightKg / w.quantity
        : null;
    const memo = `${w.code}|${units.join('+')}|${w.name}|${perPiece ?? ''}`;
    let fill = asked.get(memo);
    if (fill === undefined) {
      fill = null;
      // First unit that answers wins; the order IS the preference.
      for (const unit of units) {
        const sug = await suggestImportBaza(
          { tnvedCode: w.code, name: w.name, units: [unit], weightPerUnitKg: perPiece },
          { batchId, minSim: Number.isFinite(minSim) ? minSim : undefined },
        );
        if (!sug.auto) continue;
        fill = {
          code: w.code,
          bazaUsd: sug.auto.pricePerUnitUsd,
          basis: BASIS_FOR_UNIT[unit],
          importRowId: sug.auto.id,
        };
        break;
      }
      asked.set(memo, fill);
    }
    if (!fill) continue;
    if (w.key.kind === 'item') plan.byItemId.set(w.key.id, fill);
    else plan.byAddIndex.set(w.key.index, fill);
  }
  return plan;
}

export async function saveTable(
  requestId: string,
  input: { items: TableItemEdit[]; adds: TableNewItem[] },
  ctx: AuditContext,
): Promise<TableSaveResult> {
  // Validate every cell BEFORE anything is written, naming the row. A ghost
  // (new) row is named by a NEGATIVE seq — the screen renders «yangi qator».
  const itemEdits = input.items.map((e) => ({
    id: e.id,
    seq: e.seq,
    name: e.name === undefined ? undefined : e.name.trim().slice(0, 300),
    quantity: e.quantity === undefined ? undefined : tableMeasure(e.quantity, e.seq),
    weightKg: e.weightKg === undefined ? undefined : tableMeasure(e.weightKg, e.seq),
    volumeM3: e.volumeM3 === undefined ? undefined : tableMeasure(e.volumeM3, e.seq),
    tnvedCode: e.tnvedCode === undefined ? undefined : tableCode(e.tnvedCode, e.seq),
    note: e.note === undefined ? undefined : (e.note ?? '').trim().slice(0, 500) || null,
    measureQty: e.measureQty === undefined ? undefined : tableMeasure(e.measureQty, e.seq),
    bazaUsd: e.bazaUsd,
    bazaBasis: e.bazaBasis,
    importRowId: e.importRowId ?? null,
    // Capped like every other free-text field that reaches a column, and it
    // is the MACHINE's text — a browser posts none, so this is only ever the
    // prefill's own sentence.
    bazaReason:
      e.bazaReason === undefined ? null : (e.bazaReason ?? '').trim().slice(0, 300) || null,
  }));
  for (const e of itemEdits) {
    if (e.name !== undefined && !e.name) throw new CalcError('name_required', e.seq);
    checkBazaPair(e, e.seq);
  }
  const adds = input.adds.map((r, i) => {
    const seq = -(i + 1);
    const name = r.name.trim().slice(0, 300);
    if (!name) throw new CalcError('name_required', seq);
    checkBazaPair(r, seq);
    // A client id is a CLAIM like any other id off a form: it must at least
    // look like one, or a crafted string reaches the uuid column as a 22P02.
    const clientId = r.clientId ?? null;
    if (clientId !== null && !CLIENT_ID_SHAPE.test(clientId)) throw new CalcError('not_found', seq);
    return {
      clientId: clientId === null ? null : clientId.toLowerCase(),
      name,
      quantity: tableMeasure(r.quantity ?? null, seq),
      unit: r.unit?.trim().slice(0, 20) || null,
      weightKg: tableMeasure(r.weightKg ?? null, seq),
      volumeM3: tableMeasure(r.volumeM3 ?? null, seq),
      tnvedCode: tableCode(r.tnvedCode, seq),
      note: r.note?.trim().slice(0, 500) || null,
      measureQty: tableMeasure(r.measureQty ?? null, seq),
      bazaUsd: r.bazaUsd === undefined ? null : r.bazaUsd,
      bazaBasis: r.bazaBasis === undefined ? null : r.bazaBasis,
    };
  });

  // The dictionary reads live OUTSIDE the tx (#714). ONE ratesForCodes over
  // the UNION: every code this save types, every coded-but-ungrouped item
  // already standing (the sweep's targets), the adds' typed codes AND the
  // memory-resolved ones — a partial union mints groups with NULL rates and
  // silently degrades «prices on its first save» to «type them by hand».
  const standing = await db
    .select({
      id: calcRequestItems.id,
      seq: calcRequestItems.seq,
      name: calcRequestItems.name,
      tnvedCode: calcRequestItems.tnvedCode,
      groupId: calcRequestItems.groupId,
      quantity: calcRequestItems.quantity,
      weightKg: calcRequestItems.weightKg,
      volumeM3: calcRequestItems.volumeM3,
      bazaUsd: calcRequestItems.bazaUsd,
      bazaBasis: calcRequestItems.bazaBasis,
    })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId));
  let withCodes = adds;
  if (adds.length > 0) {
    // The TNVED memory fills codes exactly as openCalcRequest does — an
    // added item must not arrive uncoded while its twin from intake is coded.
    const { tnvedFor, productKey } = await import('../tnved/service');
    const known = await tnvedFor(adds.map((r) => r.name));
    withCodes = adds.map((r) => ({
      ...r,
      tnvedCode: r.tnvedCode || known.get(productKey(r.name))?.tnvedCode || null,
    }));
  }
  const editedCodes = itemEdits.map((e) => e.tnvedCode).filter((c): c is string => !!c);
  const sweepCodes = standing
    .filter((i) => i.groupId === null && (i.tnvedCode ?? '').trim())
    .map((i) => i.tnvedCode!.trim());
  const addCodes = withCodes.map((r) => r.tnvedCode).filter((c): c is string => !!c);
  const rates = await ratesForCodes([...editedCodes, ...sweepCodes, ...addCodes], onDate());

  // The picker's claims, resolved on the POOL before the tx (#714). The file
  // answers the price and the basis; the browser only says WHICH row.
  const pickedRows = new Map<string, ImportBazaRow>();
  const pickedIds = [...new Set(itemEdits.map((e) => e.importRowId).filter((v): v is string => !!v))];
  if (pickedIds.length > 0) {
    for (const e of itemEdits) {
      if (!e.importRowId || pickedRows.has(e.importRowId)) continue;
      // The code the row will CARRY after this save — a pick and a recode can
      // ride one press, and the file row must price the code that lands.
      const code = e.tnvedCode !== undefined ? e.tnvedCode : (standing.find((s) => s.id === e.id)?.tnvedCode ?? null);
      if (!code) throw new CalcError('import_row_missing', e.seq);
      const row = await importRowForCode(e.importRowId, code);
      if (!row) throw new CalcError('import_row_missing', e.seq);
      pickedRows.set(e.importRowId, row);
    }
  }
  // The picked price REPLACES whatever the browser posted, and does it here
  // so the edit loop below stays one baza writer.
  for (const e of itemEdits) {
    const row = e.importRowId ? pickedRows.get(e.importRowId) : undefined;
    if (!row) continue;
    e.bazaUsd = row.pricePerUnitUsd;
    e.bazaBasis = row.basis;
  }

  // The auto-fill (spec §2.4). Every row that will stand CODED with an EMPTY
  // baza after this save is offered the newest ready import's best match —
  // above the threshold and on the right unit, or nothing at all. Pooled, so
  // it happens HERE and is applied inside the tx only where the state still
  // agrees (#714).
  const importAuto = await suggestImportFills({ standing, itemEdits, withCodes, rates });
  /**
   * …and the SEALED memory, computed the same way and applied FIRST (0096).
   *
   * The order is the owner's: what this company sealed for this product beats
   * what somebody else declared for the code. Both are suggestions the VED
   * can retype, both are marked on the row, and both are recorded by the ✅.
   */
  const memoryAuto = await suggestMemoryFills({ requestId, standing, itemEdits, withCodes });

  return db.transaction(async (tx): Promise<TableSaveResult> => {
    await lockRequestInTx(tx, requestId);

    const items = await tx
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, requestId))
      .orderBy(asc(calcRequestItems.seq));
    const groups = await tx
      .select({ id: calcGroups.id, seq: calcGroups.seq, tnvedCode: calcGroups.tnvedCode })
      .from(calcGroups)
      .where(eq(calcGroups.requestId, requestId))
      .orderBy(asc(calcGroups.seq));
    const byId = new Map(items.map((i) => [i.id, i]));
    const itemGroupBySeq = new Map(items.map((i) => [i.seq, i.groupId]));

    /**
     * Phase 0 of the phone round: a NEW row carries the id its screen minted,
     * so a save whose answer was lost — a phone connection, a second press
     * while the refresh is still on its way — can be pressed again without
     * writing the goods twice. Decided UNDER the request lock, so two presses
     * cannot both find the id absent. An id this request already holds is
     * that same row, saved: skipped, and the retry reads as a save. An id
     * another request holds is not this screen's row at all — refused, like
     * every other foreign id (#864's teleport family).
     */
    const claimed = withCodes.map((r) => r.clientId).filter((v): v is string => v !== null);
    let alreadySaved = 0;
    const skipAdd = new Set<number>();
    /** Rows this request already holds under the posted client id → the add. */
    const retried = new Map<string, (typeof withCodes)[number]>();
    if (claimed.length > 0) {
      const foreign = await tx
        .select({ id: calcRequestItems.id, requestId: calcRequestItems.requestId })
        .from(calcRequestItems)
        .where(inArray(calcRequestItems.id, claimed));
      const ownerOf = new Map(foreign.map((f) => [f.id, f.requestId]));
      const seen = new Set<string>();
      withCodes.forEach((r, index) => {
        if (r.clientId === null) return;
        // The same id twice in ONE post is one row — the primary key would
        // otherwise refuse the second as a 23505 «save_failed».
        if (seen.has(r.clientId)) {
          skipAdd.add(index);
          alreadySaved += 1;
          return;
        }
        seen.add(r.clientId);
        const owner = ownerOf.get(r.clientId);
        if (owner === undefined) return;
        if (owner !== requestId) throw new CalcError('not_found', -(index + 1));
        skipAdd.add(index);
        retried.set(r.clientId, r);
      });
    }
    // A retried row is not inserted again — but it is not simply SKIPPED
    // either: between the lost answer and the second press the VED may have
    // corrected a cell, and skipping the row whole dropped that correction
    // under a bar that read «avval saqlangan» (review units-1). It becomes an
    // ordinary edit of the stored row, posting only the cells that DIFFER,
    // so an unchanged retry is still a no-op that writes nothing and clears
    // no ✅, and a changed cell goes through every rule an edit obeys.
    for (const [rowId, r] of retried) {
      const stored = byId.get(rowId)!;
      const num = (v: string | null) => (v === null ? null : Number(v));
      const storedBasis = (stored.bazaBasis as BazaBasis | null) ?? null;
      const basisMoved = r.bazaBasis !== null && r.bazaBasis !== storedBasis;
      // An add's empty price means «nothing typed», not «clear»: the first
      // save may have filled the row from the memory or the file, and an
      // unchanged retry must not wipe that. Only a price a PERSON typed is
      // taken back by an emptied cell.
      const priceMoved =
        r.bazaUsd === null
          ? (stored.bazaUsd !== null && stored.bazaSource === 'typed') || basisMoved
          : r.bazaUsd !== num(stored.bazaUsd) || basisMoved;
      itemEdits.push({
        id: rowId,
        seq: stored.seq,
        name: r.name !== stored.name ? r.name : undefined,
        quantity: r.quantity !== num(stored.quantity) ? r.quantity : undefined,
        weightKg: r.weightKg !== num(stored.weightKg) ? r.weightKg : undefined,
        volumeM3: r.volumeM3 !== num(stored.volumeM3) ? r.volumeM3 : undefined,
        tnvedCode: r.tnvedCode !== (stored.tnvedCode ?? null) ? r.tnvedCode : undefined,
        note: r.note !== (stored.note ?? null) ? r.note : undefined,
        measureQty: r.measureQty !== num(stored.measureQty) ? r.measureQty : undefined,
        bazaUsd: priceMoved ? r.bazaUsd : undefined,
        bazaBasis: priceMoved ? r.bazaBasis : undefined,
        importRowId: null,
        bazaReason: null,
      });
    }

    if (items.length + withCodes.length - skipAdd.size > MAX_CALC_ITEMS) {
      throw new CalcError('too_many_items');
    }

    // 1. Field edits, addressed by the immutable id (measures and bazas
    //    unconfirm — the ✅ was about those numbers; a name or note is words).
    const changedCells: { seq: number; field: string; before: unknown; after: unknown }[] = [];
    const touched = new Set<string>();
    /** item id → posted extended-unit qty (undefined = the cell was not sent). */
    const postedMeasure = new Map<string, number | null>();
    /** Rows whose LAW this save may change — recoded, added, or swept into a
     * group — the only rows A2's «birlikni tekshiring» looks at. */
    const relawed = new Set<string>();
    // The phone's look-then-write, closed (review PHONE-2): an edit made
    // over values the row no longer holds is refused whole, BEFORE anything
    // is written — under the lock, so no save can slip in after the check.
    for (const e of input.items) {
      if (!e.expect) continue;
      const item = byId.get(e.id);
      if (!item || item.requestId !== requestId) throw new CalcError('not_found', e.seq);
      if (movedUnder(e.expect, item)) throw new CalcError('changed_under', e.seq);
    }
    for (const e of itemEdits) {
      const item = byId.get(e.id);
      if (!item || item.requestId !== requestId) throw new CalcError('not_found', e.seq);
      if (e.measureQty !== undefined) postedMeasure.set(item.id, e.measureQty);
      const patch: Record<string, unknown> = {};
      const put = (field: string, before: unknown, after: unknown) => {
        patch[field] = after;
        changedCells.push({ seq: e.seq, field, before, after });
      };
      if (e.name !== undefined && e.name !== item.name) {
        put('name', item.name, e.name);
        // The memory searches on `name_norm` (0096), so it is written by the
        // same statement that writes the name it describes — never by a
        // trigger, which the audit row and the transaction cannot see.
        patch.nameNorm = itemNameNorm(e.name);
      }
      if (e.note !== undefined && e.note !== item.note) put('note', item.note, e.note);
      let measuresMoved = false;
      const num = (v: string | null) => (v === null ? null : Number(v));
      if (e.quantity !== undefined && e.quantity !== num(item.quantity)) {
        put('quantity', num(item.quantity), e.quantity);
        patch.quantity = e.quantity === null ? null : e.quantity.toFixed(3);
        measuresMoved = true;
      }
      if (e.weightKg !== undefined && e.weightKg !== num(item.weightKg)) {
        put('weightKg', num(item.weightKg), e.weightKg);
        patch.weightKg = e.weightKg === null ? null : e.weightKg.toFixed(3);
        measuresMoved = true;
      }
      if (e.volumeM3 !== undefined && e.volumeM3 !== num(item.volumeM3)) {
        put('volumeM3', num(item.volumeM3), e.volumeM3);
        patch.volumeM3 = e.volumeM3 === null ? null : e.volumeM3.toFixed(3);
        measuresMoved = true;
      }
      // The code lands via the regroup pass, but the COLUMN updates here so
      // the item's own record and its group agree.
      if (e.tnvedCode !== undefined && e.tnvedCode !== (item.tnvedCode ?? null)) {
        put('tnvedCode', item.tnvedCode, e.tnvedCode);
        patch.tnvedCode = e.tnvedCode;
        relawed.add(item.id);
      }
      // The row's baza — the four states `TableItemEdit` documents (0125).
      // The schema has no pair CHECK, so this writer is the rule; an unchanged
      // pair diffs to nothing, so a re-save re-stamps neither 'typed' nor the
      // ✅-clear.
      if (e.bazaUsd !== undefined) {
        const before = num(item.bazaUsd);
        const beforeBasis = (item.bazaBasis as BazaBasis | null) ?? null;
        if (e.bazaUsd === null) {
          // No price. A posted basis is the VED's CHOICE and stands without
          // one; none clears the whole pair.
          const chosen = e.bazaBasis ?? null;
          if (before !== null || beforeBasis !== chosen) {
            put('baza', { bazaUsd: before, basis: beforeBasis }, chosen === null ? null : { bazaUsd: null, basis: chosen });
            patch.bazaUsd = null;
            patch.bazaBasis = chosen;
            patch.bazaSource = null;
            // The provenance goes with the price it explained — both of them,
            // or a cleared row keeps a 🧠 chip pointing at a price that is no
            // longer on it (the fence in baza-provenance.test.ts).
            patch.importRowId = null;
            patch.memoryItemId = null;
            patch.bazaReason = null;
            measuresMoved = true;
          }
        } else if (
          before !== e.bazaUsd ||
          // A null basis is «avto»: the stored one stands (a priced row keeps
          // the unit its price was typed in — his A2), and a row with none is
          // stamped from its FINAL group in the measure pass below.
          beforeBasis !== (e.bazaBasis ?? beforeBasis) ||
          // A re-pick of the SAME price off a different declaration still
          // moves the provenance — the chip names a row, not a number.
          (e.importRowId !== null && String(item.importRowId ?? '') !== e.importRowId)
        ) {
          const basis = e.bazaBasis ?? beforeBasis;
          put('baza', { bazaUsd: before, basis: beforeBasis }, { bazaUsd: e.bazaUsd, basis });
          patch.bazaUsd = e.bazaUsd.toFixed(4);
          patch.bazaBasis = basis;
          patch.bazaSource = e.importRowId ? 'import' : 'typed';
          patch.importRowId = e.importRowId ? BigInt(e.importRowId) : null;
          patch.memoryItemId = null;
          // The model's words travel with the row it chose, and with nothing
          // else: a person retyping the price clears them.
          patch.bazaReason = e.importRowId ? (e.bazaReason ?? null) : null;
          measuresMoved = true;
        }
      }
      if (Object.keys(patch).length > 0) {
        await tx.update(calcRequestItems).set(patch).where(eq(calcRequestItems.id, item.id));
      }
      if (measuresMoved && item.groupId) touched.add(item.groupId);
    }

    // A retry counts as «already saved» only when it changed nothing; one
    // that carried a correction is an edit like any other (review units-1).
    const changedSeqs = new Set(changedCells.map((c) => c.seq));
    for (const rowId of retried.keys()) {
      if (!changedSeqs.has(byId.get(rowId)!.seq)) alreadySaved += 1;
    }

    // 2. Insert the ghost rows — in the SAME tx, so a new row born with
    //    code + baza + measure prices on its first save (the two-tx seam
    //    the audit measured dies here).
    let nextSeqNo = items.reduce((m, i) => Math.max(m, i.seq), 0) + 1;
    const insertedRows: { id: string; seq: number; tnvedCode: string | null }[] = [];
    /** The fill plans re-keyed onto item ids — a ghost row gets its id here. */
    const fillByItem = new Map(importAuto.byItemId);
    const memoryByItem = new Map(memoryAuto.byItemId);
    // A row already saved under its client id is not inserted again; the fill
    // plans stay keyed by the ORIGINAL add index, so each kept row carries it.
    const toInsert = withCodes
      .map((r, index) => ({ ...r, index }))
      .filter((r) => !skipAdd.has(r.index));
    if (toInsert.length > 0) {
      const minted = toInsert.map((r) => ({ ...r, seq: nextSeqNo++ }));
      const inserted = await tx
        .insert(calcRequestItems)
        .values(
          minted.map((r) => ({
            // The screen's own id when it sent one (phase 0) — the database
            // mints one otherwise.
            ...(r.clientId !== null ? { id: r.clientId } : {}),
            requestId,
            seq: r.seq,
            name: r.name,
            quantity: r.quantity === null ? null : r.quantity.toFixed(3),
            unit: r.unit,
            weightKg: r.weightKg === null ? null : r.weightKg.toFixed(3),
            volumeM3: r.volumeM3 === null ? null : r.volumeM3.toFixed(3),
            tnvedCode: r.tnvedCode,
            note: r.note,
            bazaUsd: r.bazaUsd === null ? null : r.bazaUsd.toFixed(4),
            // A chosen basis stands without a price (0125); a priced row with
            // none is «avto» and is stamped from its final group below.
            bazaBasis: r.bazaBasis,
            bazaSource: r.bazaUsd === null ? null : ('typed' as const),
            nameNorm: itemNameNorm(r.name),
          })),
        )
        .returning({ id: calcRequestItems.id, seq: calcRequestItems.seq, tnvedCode: calcRequestItems.tnvedCode });
      // Matched back by the seq this save minted, never by position.
      const mintedBySeq = new Map(minted.map((m) => [m.seq, m]));
      for (const row of inserted) {
        const add = mintedBySeq.get(row.seq)!;
        insertedRows.push(row);
        relawed.add(row.id);
        itemGroupBySeq.set(row.seq, null);
        if (add.measureQty !== null) postedMeasure.set(row.id, add.measureQty);
        const fill = importAuto.byAddIndex.get(add.index);
        if (fill) fillByItem.set(row.id, fill);
        const remembered = memoryAuto.byAddIndex.get(add.index);
        if (remembered) memoryByItem.set(row.id, remembered);
      }
    }

    // 3. Regroup: the save's typed codes (edits AND adds), PLUS the sweep —
    //    every coded item standing ungrouped (intake prefills codes from the
    //    TNVED memory, so the commonest request arrives pre-coded with
    //    nothing dirty; the judge's blocker: without the sweep, Saqlash
    //    no-ops against the ungrouped blocker for ever).
    const moves = new Map<number, string | null>();
    for (const e of itemEdits) {
      if (e.tnvedCode !== undefined) moves.set(byId.get(e.id)!.seq, e.tnvedCode);
    }
    for (const row of insertedRows) {
      if (row.tnvedCode) moves.set(row.seq, row.tnvedCode);
    }
    let swept = 0;
    for (const i of items) {
      if (moves.has(i.seq)) continue;
      const code = (i.tnvedCode ?? '').trim();
      if (code && i.groupId === null) {
        moves.set(i.seq, code);
        swept += 1;
        relawed.add(i.id);
      }
    }
    const grouped = await autoGroupInTx(tx, requestId, { groups, moves, itemGroupBySeq, rates });
    grouped.touched.forEach((id) => touched.add(id));

    // 4. Emptied groups die AFTER all moves (judge: ordering).
    const lostFrom = [...moves.keys()]
      .map((seq) => items.find((i) => i.seq === seq)?.groupId)
      .filter((id): id is string => !!id);
    await pruneEmptyGroupsInTx(tx, requestId, lostFrom);

    // 5. Legacy duplicate same-code groups MERGE — but only when their whole
    //    rate column set is identical. First-by-seq is arbitrary, and the
    //    losing group's typed lgota or certificate override silently dying
    //    under the winner's dictionary numbers would understate customs by
    //    the whole add-duty band; differing duplicates stay as two honest
    //    blocks for a person to resolve.
    const groupsNow = await tx
      .select()
      .from(calcGroups)
      .where(eq(calcGroups.requestId, requestId))
      .orderBy(asc(calcGroups.seq));
    const dupsByCode = new Map<string, (typeof groupsNow)[number][]>();
    for (const g of groupsNow) {
      const code = (g.tnvedCode ?? '').trim();
      if (!code) continue;
      const list = dupsByCode.get(code) ?? [];
      list.push(g);
      dupsByCode.set(code, list);
    }
    const merged: string[] = [];
    for (const [code, list] of dupsByCode) {
      if (list.length < 2) continue;
      const first = list[0]!;
      for (const g of list.slice(1)) {
        if (!sameGroupRates(first, g)) continue;
        await tx
          .update(calcRequestItems)
          .set({ groupId: first.id })
          .where(eq(calcRequestItems.groupId, g.id));
        touched.add(first.id);
        touched.delete(g.id);
        await tx.delete(calcGroups).where(eq(calcGroups.id, g.id));
        if (!merged.includes(code)) merged.push(code);
      }
    }

    // 6. The measure pass — the ONE writer of the pair and of the «avto»
    //    basis, after the regroup and the merge so every item's group (and
    //    thus its law) is FINAL. Written and cleared only TOGETHER, in one
    //    UPDATE per item — the pair CHECK is immediate and a lone half
    //    23514s the whole save.
    const groupsFinal = await tx
      .select({ id: calcGroups.id, dutyUnit: calcGroups.dutyUnit })
      .from(calcGroups)
      .where(eq(calcGroups.requestId, requestId));
    const dutyUnitByGroup = new Map(groupsFinal.map((g) => [g.id, g.dutyUnit]));
    const lawOf = (groupId: string | null) =>
      groupId ? (dutyUnitByGroup.get(groupId) ?? null) : null;
    const itemsNow = await tx
      .select({
        id: calcRequestItems.id,
        seq: calcRequestItems.seq,
        groupId: calcRequestItems.groupId,
        tnvedCode: calcRequestItems.tnvedCode,
        quantity: calcRequestItems.quantity,
        weightKg: calcRequestItems.weightKg,
        volumeM3: calcRequestItems.volumeM3,
        measureUnit: calcRequestItems.measureUnit,
        measureQty: calcRequestItems.measureQty,
        bazaUsd: calcRequestItems.bazaUsd,
        bazaBasis: calcRequestItems.bazaBasis,
      })
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, requestId));
    const measuresCleared: number[] = [];
    const measuresDropped: number[] = [];
    const basisConflict: number[] = [];
    const basisStamped: { seq: number; basis: BazaBasis }[] = [];
    for (const item of itemsNow) {
      const law = lawOf(item.groupId);
      const set: Record<string, unknown> = {};
      // 18a: a price with no basis is «avto» — the law's default, read off
      // the group the row ENDED in. Never off the pre-tx dictionary map: a
      // typed code can join a group whose law a person typed over the book.
      let basis = (item.bazaBasis as BazaBasis | null) ?? null;
      if (item.bazaUsd !== null && basis === null) {
        basis = defaultBasisFor({ dutyUnit: law });
        set.bazaBasis = basis;
        // Kept in step for the fills and the A2 check below, which read
        // this same snapshot.
        item.bazaBasis = basis;
        basisStamped.push({ seq: item.seq, basis });
      }
      // A unit the law cannot hold — named, never rewritten. The law's own
      // pair stands (pairUnitFor answers the law first).
      if (basisConflicts(law, basis)) basisConflict.push(item.seq);
      // Per ITEM now, ungrouped rows included: an m² baza on an advalor code
      // needs its m² count as much as an m² law does.
      const required = pairUnitFor(law, basis);
      const storedUnit = (item.measureUnit as MeasureUnit | null) ?? null;
      const storedQty = item.measureQty === null ? null : Number(item.measureQty);
      const posted = postedMeasure.get(item.id);
      let write: { unit: MeasureUnit; qty: number } | null | undefined;
      if (required === null) {
        // Neither the law nor the basis needs an extended unit. A posted qty
        // is DROPPED with a named note (never a whole-save refusal — the box
        // was offered in good faith); a standing pair is cleared and named:
        // keeping «200» under a law (or a basis) that stopped asking for m²
        // is a number nobody stated.
        if (posted !== undefined && posted !== null) measuresDropped.push(item.seq);
        if (storedUnit !== null) {
          write = null;
          measuresCleared.push(item.seq);
        }
      } else if (posted !== undefined) {
        if (posted === null) {
          if (storedUnit !== null) write = null;
        } else if (storedUnit !== required || storedQty !== posted) {
          write = { unit: required, qty: posted };
        }
      } else if (storedUnit !== null && storedUnit !== required) {
        // A recode (or a new basis) changed the required unit under a
        // standing pair — the quantity was a statement in the OLD unit. Clear
        // and name it; re-stamping «200 m²» as «200 litr» would price a
        // number nobody measured.
        write = null;
        measuresCleared.push(item.seq);
      }
      if (write !== undefined) {
        if (write === null) {
          set.measureUnit = null;
          set.measureQty = null;
        } else {
          set.measureUnit = write.unit;
          set.measureQty = write.qty.toFixed(4);
        }
      }
      if (Object.keys(set).length > 0) {
        await tx.update(calcRequestItems).set(set).where(eq(calcRequestItems.id, item.id));
        if (item.groupId) touched.add(item.groupId);
      }
    }

    // 7. The import's auto-fill (0094), AFTER the regroup — the group is what
    //    says which unit the law prices in, and the suggestion was made for
    //    that unit. Applied only where the pre-tx state still holds: the code
    //    is still the one asked about, the baza is still empty, and the
    //    group's own law still wants this basis (a typed dutyUnit override on
    //    a legacy group can disagree with today's dictionary). Anything else
    //    is left EMPTY for the VED, which is his own rule.
    //
    //    The fills run AFTER the measure pass, which is safe only because
    //    `unitsForRow` never offers an extended unit the pass did not already
    //    ask the row for (one the law pins, or one the VED chose) — pinned by
    //    tests/unit/customs-import-parse.test.ts.
    /** What may price this still-unpriced row: its law, its CHOSEN unit (a
     * baza-less row's stored basis is always a choice), its own figures. */
    const allowedFor = (item: (typeof itemsNow)[number]) =>
      unitsForRow({
        dutyUnit: lawOf(item.groupId),
        chosen: isBazaBasis(item.bazaBasis) ? item.bazaBasis : null,
        hasWeight: item.weightKg !== null && Number(item.weightKg) > 0,
        hasQuantity: item.quantity !== null && Number(item.quantity) > 0,
        hasVolume: item.volumeM3 !== null && Number(item.volumeM3) > 0,
      });
    /**
     * THE SEALED MEMORY GOES FIRST (0096, the owner's own order).
     *
     * What this company confirmed and sealed for this product outranks what
     * somebody else declared for the code — so a row the memory can answer
     * never reaches the import fill below. Applied under the SAME three
     * re-checks: the baza is still empty, the row's law still allows the
     * basis, and the group is the one the suggestion was made against.
     */
    const memoryFilled: number[] = [];
    for (const item of itemsNow) {
      const fill = memoryByItem.get(item.id);
      if (!fill) continue;
      if (item.bazaUsd !== null) continue;
      if (!allowedFor(item).some((u) => BASIS_FOR_UNIT[u] === fill.basis)) continue;
      await tx
        .update(calcRequestItems)
        .set({
          bazaUsd: fill.bazaUsd.toFixed(4),
          bazaBasis: fill.basis,
          bazaSource: 'memory',
          memoryItemId: fill.memoryItemId,
          // The provenance is one fact in four columns: a memory price is not
          // the file's and carries no model reason.
          importRowId: null,
          bazaReason: null,
        })
        .where(eq(calcRequestItems.id, item.id));
      memoryFilled.push(item.seq);
      if (item.groupId) touched.add(item.groupId);
    }

    const importFilled: number[] = [];
    for (const item of itemsNow) {
      const fill = fillByItem.get(item.id);
      if (!fill) continue;
      if (item.bazaUsd !== null) continue;
      // …and not a row the memory has just answered.
      if (memoryFilled.includes(item.seq)) continue;
      if ((item.tnvedCode ?? null) !== fill.code) continue;
      // The suggestion was made against the dictionary's law; the GROUP is
      // what actually prices, and a legacy group can carry a typed dutyUnit
      // the dictionary no longer agrees with.
      if (!allowedFor(item).some((u) => BASIS_FOR_UNIT[u] === fill.basis)) continue;
      await tx
        .update(calcRequestItems)
        .set({
          bazaUsd: fill.bazaUsd.toFixed(4),
          bazaBasis: fill.basis,
          bazaSource: 'import',
          importRowId: BigInt(fill.importRowId),
          memoryItemId: null,
          bazaReason: null,
        })
        .where(eq(calcRequestItems.id, item.id));
      importFilled.push(item.seq);
      if (item.groupId) touched.add(item.groupId);
    }

    // A2 (0125): a PRICED row whose law this save changed keeps the unit its
    // price was typed in — never silently rewritten (#171 inverted), NAMED,
    // so the VED checks it against the unit the new law counts in. Only rows
    // this save re-lawed: a deliberate override on a row nobody touched is
    // not news on every later press. An unpriced row has nothing to check —
    // it follows the new code by itself (its auto basis is stamped at its
    // first price) — and a conflict is already named more loudly above.
    const basisSuspect: number[] = [];
    for (const item of itemsNow) {
      if (!relawed.has(item.id) || item.bazaUsd === null) continue;
      if (basisConflict.includes(item.seq)) continue;
      const law = lawOf(item.groupId);
      const lawBasis = defaultBasisFor({ dutyUnit: law });
      // «The law pins a unit»: kg or a pair unit. dona / 1000_dona / sm³ /
      // advalor default to 'unit' and pin none of the baza.
      if (lawBasis === 'unit') continue;
      if (item.bazaBasis !== lawBasis) basisSuspect.push(item.seq);
    }

    await unconfirmInTx(tx, touched);
    const clock = await recountItemsInTx(tx, requestId);

    // ONE audit row per save, changed cells only — a row per cell is noise
    // and writeAudit(db, …) inside this tx is #714's deadlock.
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      after: {
        tableEdits: changedCells,
        itemsAdded: insertedRows.map((r) => r.seq),
        minted: grouped.minted.map((m) => m.code),
        swept,
        merged,
        measuresCleared,
        measuresDropped,
        basisSuspect,
        basisConflict,
        // The «avto» units this save decided — the audit's cell list shows
        // the posted null, so the stamped answer is recorded here.
        basisStamped,
        alreadySaved,
        importFilled,
        memoryFilled,
      },
    });
    return {
      minted: grouped.minted.map((m) => m.code),
      swept,
      added: insertedRows.length,
      merged,
      measuresCleared,
      measuresDropped,
      basisSuspect,
      basisConflict,
      alreadySaved,
      importFilled,
      memoryFilled,
      rev: clock.rev,
    };
  });
}

/** The whole rate column set, compared null-safe — the merge's gate. */
function sameGroupRates(
  a: typeof calcGroups.$inferSelect,
  b: typeof calcGroups.$inferSelect,
): boolean {
  return (
    a.dutyPct === b.dutyPct &&
    a.vatPct === b.vatPct &&
    a.feeUsd === b.feeUsd &&
    a.dutyMode === b.dutyMode &&
    a.dutySpecific === b.dutySpecific &&
    a.dutyUnit === b.dutyUnit &&
    a.excisePct === b.excisePct &&
    a.dutyFree === b.dutyFree &&
    a.vatFree === b.vatFree &&
    a.hasCertificate === b.hasCertificate
  );
}

/** A baza posts as a pair of halves, each checked on its own (0125): an
 * amount is a positive finite number; a basis, whenever one is posted, is on
 * the list — off it is a forged post. A null basis beside an amount is
 * «avto», and a basis beside no amount is a choice; neither is refused. */
function checkBazaPair(
  e: { bazaUsd?: number | null; bazaBasis?: BazaBasis | null },
  seq: number,
): void {
  if (e.bazaBasis !== undefined && e.bazaBasis !== null && !isBazaBasis(e.bazaBasis)) {
    throw new CalcError('bad_basis', seq);
  }
  if (e.bazaUsd === undefined || e.bazaUsd === null) return;
  if (!isNumber(e.bazaUsd)) throw new CalcError('bad_number', seq);
  if (!(e.bazaUsd > 0)) throw new CalcError('baza_positive', seq);
  if (e.bazaUsd >= 1e9) throw new CalcError('bad_number', seq);
}

export interface TableNewItem {
  /** The id the SCREEN minted for this row (phase 0) — a retried save
   * carrying it again is the same row, already written, and is skipped.
   * Optional: a tab opened on an older build still posts without one. */
  clientId?: string | null;
  name: string;
  quantity?: number | null;
  unit?: string | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  tnvedCode?: string | null;
  note?: string | null;
  measureQty?: number | null;
  bazaUsd?: number | null;
  bazaBasis?: BazaBasis | null;
}

export async function deleteItem(requestId: string, itemId: string, ctx: AuditContext): Promise<{ rev: number }> {
  return db.transaction(async (tx) => {
    await lockRequestInTx(tx, requestId);
    const [item] = await tx
      .select()
      .from(calcRequestItems)
      .where(and(eq(calcRequestItems.requestId, requestId), eq(calcRequestItems.id, itemId)));
    if (!item) throw new CalcError('not_found');
    await tx.delete(calcRequestItems).where(eq(calcRequestItems.id, item.id));
    if (item.groupId) {
      // The group's numbers changed; and a group the delete emptied dies —
      // a header with no rows is noise the table would render for ever.
      await unconfirmInTx(tx, [item.groupId]);
      await pruneEmptyGroupsInTx(tx, requestId, [item.groupId]);
    }
    const clock = await recountItemsInTx(tx, requestId);
    await writeAudit(tx, ctx, {
      entityType: 'calc_request',
      entityId: requestId,
      action: 'update',
      before: { itemSeq: item.seq, name: item.name },
      after: { itemDeleted: item.seq },
    });
    return { rev: clock.rev };
  });
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
  /**
   * TRUE when the chat is linked but the seller's own profile silences
   * «Operatsiya xabarlari», where this text lives: the row is written `muted`
   * and nothing arrives, so the screen must not say «yuborildi» (round C
   * review, second pass — the founders rule made every past tick count).
   */
  muted?: boolean;
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
  /**
   * What the promise is measured against — a sealed version (phase C) or a
   * completed request's Готово answer (phase 4). Exactly one, mirroring the
   * table's own CHECK; every admission below is re-derived server-side,
   * because the panel's rendered floor is a browser's claim (judge blocker:
   * a hand-posted requestId of an OPEN request has a NULL answer, Number(null)
   * is 0, and any price clears a $0 floor with the below-floor law bypassed).
   */
  anchor: { versionId: string } | { requestId: string },
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

  const { offerText } = await import('./offer');
  let request: typeof calcRequests.$inferSelect;
  let floorUsd: number;
  let text: string;
  let versionId: string | null = null;
  let requestId: string | null = null;

  if ('versionId' in anchor) {
    versionId = anchor.versionId;
    const [row] = await db
      .select({ version: calcVersions, request: calcRequests })
      .from(calcVersions)
      .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
      .where(eq(calcVersions.id, anchor.versionId))
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
    request = row.request;
    floorUsd = Number(v.totalUsd);
    /**
     * THE VERSION MUST STILL STAND (audit A5).
     *
     * The branch checked only that the version exists and belongs to this
     * card — never the two clauses every other money surface carries
     * (`currentVersionSql`, `notSupersededSql`) and never the quote's own
     * clock. So a stale panel, a bookmarked card or a second tab could
     * promise a customer a price off a SUPERSEDED or EXPIRED seal, and
     * `applyOfferToCard` then wrote that stale figure onto the card as the
     * client price. Measured on gsr_ci: both were accepted.
     *
     * The screen already refuses (the panel prints `sealExpiredHint` instead
     * of the form) — this is the server half, because a screen gate alone
     * leaves the action accepting it (#531). Two reads on the pool, both
     * bounded by an index.
     */
    if (v.validUntil.getTime() < Date.now()) throw new CalcError('quote_expired');
    const [newer] = await db
      .select({ id: calcVersions.id })
      .from(calcVersions)
      .where(
        and(eq(calcVersions.requestId, v.requestId), sql`${calcVersions.versionNo} > ${v.versionNo}`),
      )
      .limit(1);
    if (newer) throw new CalcError('superseded');
    const [child] = await db
      .select({ id: calcRequests.id })
      .from(calcRequests)
      .where(eq(calcRequests.supersedesRequestId, v.requestId))
      .limit(1);
    if (child) throw new CalcError('superseded');
    // A concession is the CUSTOMER's (round 112, his «VED xodimi skidka bersa
    // sotuvchi upsale qilish huquqi bo'lmasin»): once the VED has lowered the
    // floor, the seller may not quote ABOVE it and keep the difference. Phase
    // D already pays nothing on a discounted job (`payableOffersSql`), but
    // the PROMISE to the customer was still free to rise — the wrong promise,
    // paid or not. Below the discounted floor is unchanged: that is the
    // approver's own door (law 4). An ANSWER anchor carries no discount, so
    // the rule lives in this branch alone.
    if (Number(v.discountUsd) > 0 && input.clientPriceUsd > floorUsd + 0.009) {
      throw new CalcError('discounted_no_upsale');
    }
    text = offerText(
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
  } else {
    // The ANSWER anchor. Deliberately NOT lockRequestInTx — that door throws
    // `already_closed` for any completed request, and a Готово-answered
    // request is completed by definition; the answer columns are frozen by
    // endRequest, so a plain read is the truth.
    requestId = anchor.requestId;
    const [req] = await db
      .select()
      .from(calcRequests)
      .where(eq(calcRequests.id, anchor.requestId))
      .limit(1);
    if (!req) throw new CalcError('not_found');
    if (
      input.expect &&
      (req.entityType !== input.expect.entityType || req.entityId !== input.expect.entityId)
    ) {
      throw new CalcError('not_found');
    }
    const amount = toNum(req.answerAmount);
    if (req.completedAt === null || amount === null || !(amount > 0)) {
      throw new CalcError('answer_missing');
    }
    // A non-USD floor is not comparable to a USD client price — refused with
    // its own word, never coerced (law 6).
    if (req.answerCurrency !== 'USD') throw new CalcError('answer_not_usd');
    // The answer must still be the card's newest word on price: not
    // superseded, no newer USD answer, no version sealed after it.
    const stands = await db.execute<{ ok: boolean }>(sql`
      SELECT (${answerFloorStandsSql()}) AS ok
        FROM calc_requests r
       WHERE r.id = ${anchor.requestId}::uuid
    `);
    if (!stands[0]?.ok) throw new CalcError('superseded');
    // The seal's own clock (quote_valid_days) gates this door too: a
    // year-old Готово figure must not anchor a fresh promise for ever.
    const validDays = Number((await getSetting('quote_valid_days')) ?? QUOTE_VALID_DAYS_DEFAULT);
    const validUntil = new Date(req.completedAt.getTime() + validDays * 86_400_000);
    if (validUntil.getTime() < Date.now()) throw new CalcError('answer_expired');

    request = req;
    floorUsd = amount;
    text = offerText(
      {
        clientPriceUsd: input.clientPriceUsd,
        volumeM3: toNum(req.volumeM3),
        weightKg: toNum(req.weightKg),
        // Phase A's intake always records a section; the coalesce is for
        // rows minted before it and prints the combined wording.
        section: (req.section ?? 'podklyuch') as CalcSectionName,
        fromCity: req.fromCity,
        toCity: req.toCity,
        validUntil,
        clientName: input.clientName ?? null,
      },
      input.locale,
    );
  }

  const belowFloor = input.clientPriceUsd < floorUsd - 0.009;
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
      requestId,
      entityType: request.entityType,
      entityId: request.entityId,
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
  // A new standing offer can change what the sellers are owed (it replaces
  // the job's payable row): the Balans's minute-long memo forgets it (3a).
  forgetUpsaleLiability();

  await writeAudit(db, ctx, {
    entityType: 'calc_offer',
    entityId: saved!.id,
    action: 'create',
    after: {
      versionId,
      requestId,
      clientPriceUsd: input.clientPriceUsd,
      belowFloor,
      locale: input.locale,
    },
  });

  // A PENDING promise sends nothing and hands back nothing to forward. The
  // row exists — that is the owner's visibility — but until somebody allows
  // it there is no message, no sheet and no price on the card.
  if (!approved) {
    await notifyApprovers(saved!.id, input.clientPriceUsd, floorUsd, reason, ctx);
    return { id: saved!.id, text: null, belowFloor, delivered: false, pending: true };
  }

  await applyOfferToCard(saved!.id, request, input.clientPriceUsd);

  // The offer goes to the seller's OWN chat as its own message, deliberately
  // carrying no staff URL: the internal notification does that, and this is
  // the string they forward to a customer.
  const linked = await hasLinkedChat(ctx.actorId);
  // `notifyStaffTelegram` answers how many rows it queued — zero when the
  // seller's mutes wrote the row `muted`.
  const queued = linked
    ? await notifyStaffTelegram({
        userIds: [ctx.actorId],
        type: 'CalcOffer',
        text,
      }).catch((err) => {
        logger.error({ err, versionId, requestId }, '[calc] offer push failed');
        return 1;
      })
    : 0;

  return { id: saved!.id, text, belowFloor, delivered: queued > 0, muted: linked && queued === 0, pending: false };
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
    .where(
      and(
        eq(calcOffers.id, offerId),
        eq(calcOffers.belowFloor, true),
        isNull(calcOffers.approvedAt),
        // A promise a correction replaced cannot be released: approving it
        // would write a dead quote's price onto a card whose lock already
        // follows the new seal. In the claim's own WHERE, so the check and
        // the win are one statement.
        offerStandsSql(),
      ),
    )
    .returning();
  if (!claimed) {
    const still = await db.query.calcOffers.findFirst({ where: eq(calcOffers.id, offerId) });
    // Name the real refusal: «somebody already decided» and «a correction
    // replaced this quote» need different sentences on the screen.
    if (still && still.belowFloor && !still.approvedAt) throw new CalcError('superseded');
    throw new CalcError('not_pending');
  }
  // Released: the Balans's minute-long memo of the sellers' commissions
  // forgets itself (3a) — the release is a door that moves the payable set.
  forgetUpsaleLiability();

  // The card write resolves the request from the offer's OWN anchor — a
  // request-anchored offer has no version to look through (judge blocker:
  // the version-only lookup silently skipped the card write on release).
  const request = claimed.requestId
    ? await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, claimed.requestId) })
    : (
        await db
          .select({ request: calcRequests })
          .from(calcVersions)
          .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
          .where(eq(calcVersions.id, claimed.versionId!))
          .limit(1)
      )[0]?.request;
  if (request) await applyOfferToCard(claimed.id, request, Number(claimed.clientPriceUsd));

  await writeAudit(db, ctx, {
    entityType: 'calc_offer',
    entityId: claimed.id,
    action: 'update',
    after: { approved: true, clientPriceUsd: Number(claimed.clientPriceUsd) },
  });

  // The seller gets the text now — it is the first moment there is one.
  const linked = await hasLinkedChat(claimed.offeredBy);
  const queued = linked
    ? await notifyStaffTelegram({
        userIds: [claimed.offeredBy],
        type: 'CalcOffer',
        text: claimed.text,
      }).catch((err) => {
        logger.error({ err, offerId }, '[calc] released offer push failed');
        return 1;
      })
    : 0;

  return {
    id: claimed.id,
    text: claimed.text,
    belowFloor: true,
    delivered: queued > 0,
    muted: linked && queued === 0,
    pending: false,
  };
}

/**
 * A RELEASED offer — one whose promise the customer may see.
 *
 * Law 4's below-floor lock puts the wait on the PROMISE: the row is always
 * written (the owner's visibility), while the Telegram text, the PDF, the
 * card's price and the payout all wait on `approved_at`. This fragment is
 * that clause's one home for the offer-shaped reads — the card's price below
 * and the PDF route — so a surface cannot forget the wait the way the PDF
 * route did (found by the whole-module audit: a pending below-floor price
 * rendered as a customer sheet by URL). `payableOffersSql` restates it inside
 * its own documented CTE, where the five rules live together.
 */
export function releasedOfferWhere() {
  return sql`(NOT ${calcOffers.belowFloor} OR ${calcOffers.approvedAt} IS NOT NULL)`;
}

/**
 * The offer's quote still STANDS — its version is the request's newest seal
 * and no correction has superseded the request.
 *
 * The whole-module audit's second confirmed defect: the card-price reader was
 * entity-keyed with no supersession clause, so after a correction sealed on a
 * card that carried a released offer the LOCK answered the old client price
 * while the card carried the new floor — and `updateLead`, which compares the
 * posted value against the lock, refused every later ✏️ save with
 * `quote_sealed` for ever. Money already had this rule (`payableOffersSql`);
 * the card's price now embeds the SAME two clauses, verbatim from
 * version-set.ts, correlated through the offer's own version. #513: the lock
 * and the commission must stop believing a superseded promise on the same day.
 */
export function offerStandsSql() {
  // Phase 4: the offer stands on exactly ONE of two anchors, and each anchor
  // brings its own standing clauses. The version branch is phase D's,
  // unchanged; the answer branch is `answerFloorStandsSql` — this fragment
  // sits under releaseOffer's CLAIM, the quote lock and the cash screen, so a
  // version-only EXISTS here would brick every Готово-anchored below-floor
  // approval (the claim matches nothing) and hide the released price from the
  // lock (judge, phase 4).
  return sql`(
    (${calcOffers}.version_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM calc_versions v
        JOIN calc_requests r ON r.id = v.request_id
       WHERE v.id = ${calcOffers}.version_id
         AND ${currentVersionSql()}
         AND ${notSupersededSql()}
    ))
    OR
    (${calcOffers}.request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM calc_requests r
       WHERE r.id = ${calcOffers}.request_id
         AND ${answerFloorStandsSql()}
    ))
  )`;
}

/**
 * The newest RELEASED offer on this card, in the order the card column was
 * written, and whether its quote still STANDS.
 *
 * A pending below-floor promise is not a price the customer has been told,
 * so it never reached the card and is not considered at all. A promise a
 * correction replaced DID reach the card — the number is still printed there
 * — so it is returned with `stands: false` rather than skipped: the quote
 * lock asks «who wrote the number the card shows, and does it still stand»,
 * and skipping the dead writer hands it an older one that is not on the card
 * (review ved-money-1).
 *
 * `at` is the moment the price reached the CARD — `approved_at` for a
 * below-floor promise (applyOfferToCard runs at release), `offered_at`
 * otherwise — and the order is by that moment, not by `offered_at`: a
 * promise approved after a newer one was offered wrote the card LAST.
 */
export async function lastReleasedOfferFor(
  entityType: 'deal' | 'lead',
  entityId: string,
): Promise<{ id: string; price: number; at: Date; stands: boolean } | null> {
  const [row] = await db
    .select({
      id: calcOffers.id,
      price: calcOffers.clientPriceUsd,
      offeredAt: calcOffers.offeredAt,
      approvedAt: calcOffers.approvedAt,
      stands: sql<boolean>`${offerStandsSql()}`,
    })
    .from(calcOffers)
    .where(
      and(
        eq(calcOffers.entityType, entityType),
        eq(calcOffers.entityId, entityId),
        releasedOfferWhere(),
      ),
    )
    .orderBy(desc(sql`coalesce(${calcOffers.approvedAt}, ${calcOffers.offeredAt})`))
    .limit(1);
  return row
    ? { id: row.id, price: Number(row.price), at: row.approvedAt ?? row.offeredAt, stands: Boolean(row.stands) }
    : null;
}

// ---------------------------------------------------------------------------
// What stands on a card — one list for the panel, the lock and the answer line
// ---------------------------------------------------------------------------

/** A Готово answer that stands as a floor on its card. */
export interface StandingAnswer {
  requestId: string;
  section: CalcSectionName | null;
  amountUsd: number;
  completedAt: Date;
  byName: string | null;
  /** The door's own clock (`quote_valid_days`) — the answer still stands. */
  expired: boolean;
}

export interface StandingAnchors {
  /** Every current, NOT superseded seal on the card, newest first. */
  seals: SealedVersion[];
  /** Every answer passing `answerFloorStandsSql`, newest first (USD only). */
  answers: StandingAnswer[];
  /** The card's newest seal when it does NOT stand — history, never a door. */
  deadSeal: SealedVersion | null;
}

/**
 * Every price that STANDS on a card (review ved-correctness-4/-6), by the
 * money rules' own clauses: a seal stands when it is its request's current
 * version and nobody superseded the request (`currentVersionSql`,
 * `notSupersededSql`); an answer stands by `answerFloorStandsSql`.
 *
 * A deal carries several jobs (0085), so a standing seal and a standing
 * answer can live on one card — a yo'lkira sealed, a rastamojka answered. The
 * panel draws one door per anchor, each labelled with its section; there is
 * no precedence to state because the money rules already exclude the overlap
 * that matters: an answer older than any seal on the card does not stand
 * (`answerFloorStandsSql`'s last clause), so «any seal outranks the answer»
 * (phase 4) is the same rule, said once. An EXPIRED seal still stands by the
 * edge — its door is the «qayta hisoblating» sentence, not a hidden answer.
 *
 * The panel, `quoteLockedFor` and the card's «Javob berildi» line read this
 * one list, so the card cannot show one price while the lock holds another.
 */
export async function standingAnchorsFor(
  entityType: 'deal' | 'lead',
  entityId: string,
): Promise<StandingAnchors> {
  const standingIds = await db.execute<{ id: string }>(sql`
    SELECT v.id::text AS id
      FROM calc_versions v
      JOIN calc_requests r ON r.id = v.request_id
     WHERE r.entity_type = ${entityType}
       AND r.entity_id = ${entityId}::uuid
       AND ${currentVersionSql()}
       AND ${notSupersededSql()}
  `);
  const ids = standingIds.map((row) => row.id);
  const sealRows = ids.length
    ? await db
        .select()
        .from(calcVersions)
        .where(inArray(calcVersions.id, ids))
        .orderBy(desc(calcVersions.sealedAt))
    : [];
  const answerRows = await db.execute<{
    id: string;
    section: string | null;
    answer_amount: string;
    completed_at: string;
    by_name: string | null;
  }>(sql`
    SELECT r.id::text AS id, r.section, r.answer_amount, r.completed_at, u.full_name AS by_name
      FROM calc_requests r
      LEFT JOIN users u ON u.id = r.completed_by
     WHERE r.entity_type = ${entityType}
       AND r.entity_id = ${entityId}::uuid
       AND ${isAnswerSql('r')}
       AND ${answerFloorStandsSql()}
     ORDER BY r.completed_at DESC
  `);
  const newest = await currentSealFor(entityType, entityId);
  const names = await namesOf(sealRows.map((row) => row.sealedBy));
  const validDays = answerRows.length
    ? Number((await getSetting('quote_valid_days')) ?? QUOTE_VALID_DAYS_DEFAULT)
    : QUOTE_VALID_DAYS_DEFAULT;
  return {
    seals: sealRows.map((row) => toVersion(row, names.get(row.sealedBy) ?? null)),
    answers: answerRows.map((row) => {
      // Raw-execute timestamps are TEXT (#923).
      const completedAt = new Date(row.completed_at);
      return {
        requestId: row.id,
        section: (row.section as CalcSectionName | null) ?? null,
        amountUsd: Number(row.answer_amount),
        completedAt,
        byName: row.by_name,
        expired: completedAt.getTime() + validDays * 86_400_000 < Date.now(),
      };
    }),
    deadSeal: newest && !ids.includes(newest.id) ? newest : null,
  };
}

/**
 * The seller's price as the VED may read it (the owner's 16a — «sotuvchi
 * bergan narxni ham koraversin») — a PROJECTION, never the offer row
 * (review access-money-8).
 *
 * `calc_offers` carries `payout_usd` (the commission actually paid), the
 * below-floor reason and the forwarded text; the house rule for law-4 data is
 * «not fetched at all, not merely not drawn», so this reader selects exactly
 * the six facts 16a names and nothing a client component could serialise to
 * the VED's browser beyond them. The keys are pinned by
 * `calc-offer-wire.test.ts`. No upsale figure is PRINTED from it — but client
 * price minus his own floor is one subtraction away, stated to the owner.
 */
export interface OfferPrice {
  id: string;
  clientPriceUsd: number;
  currency: 'USD';
  offeredAt: Date;
  offeredByName: string | null;
  /** A below-floor promise nobody has allowed yet — «tasdiq kutilmoqda». */
  pendingApproval: boolean;
}

export async function offerPricesFor(
  entityType: 'deal' | 'lead',
  entityId: string,
): Promise<OfferPrice[]> {
  const rows = await db
    .select({
      id: calcOffers.id,
      clientPriceUsd: calcOffers.clientPriceUsd,
      offeredAt: calcOffers.offeredAt,
      offeredByName: users.fullName,
      belowFloor: calcOffers.belowFloor,
      approvedAt: calcOffers.approvedAt,
    })
    .from(calcOffers)
    .leftJoin(users, eq(users.id, calcOffers.offeredBy))
    .where(and(eq(calcOffers.entityType, entityType), eq(calcOffers.entityId, entityId)))
    .orderBy(desc(calcOffers.offeredAt))
    .limit(10);
  return rows.map((row) => ({
    id: row.id,
    clientPriceUsd: Number(row.clientPriceUsd),
    currency: 'USD',
    offeredAt: row.offeredAt,
    offeredByName: row.offeredByName ?? null,
    pendingApproval: row.belowFloor && row.approvedAt === null,
  }));
}
