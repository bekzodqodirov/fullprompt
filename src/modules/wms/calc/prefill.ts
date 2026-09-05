import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  deals,
  leads,
} from '../../platform/db/schema';
import { cardLink } from '../../platform/notifications/links';
import { aiConfigured } from '../../platform/ai/model';
import { logger } from '../../platform/logger';
import type { AuditContext } from '../../platform/audit/service';
import {
  newestReadyBatchId,
} from '../customs/import-service';
import { suggestImportBaza, unitsForRow, BASIS_FOR_UNIT } from '../customs/import-baza';
import { sectionParts, type CalcSectionName } from './pricing';
import {
  loadWorkspace,
  proposeGroups,
  saveTable,
  type SealBlocker,
  type TableItemEdit,
  type Workspace,
} from './workspace';
import { itemNameNorm, sealedMemoryFor } from './memory';
import { aiVedReplyText, type AiVedLine } from './ai-reply';
import { dutyText } from './duty-text';
import { blockerText, prefillReplyText } from './prefill-reply';
import { pickImportRows, type PickAnswer, type PickRequest } from './prefill-ai';

/**
 * The AI VED hodimi (docs/VED-IMPORT-AI.md §3).
 *
 * The owner's ask: «AI Ved hodimi … malumotlar berilganda hamma malumotlarni
 * toliq qilib olib hsoblab beradgan bolsin». A job the bot has just landed
 * is picked up by the machine and carried as far as it honestly can — codes
 * from the model, rates from PP-3818, bazas from the customs file — and then
 * it STOPS. The request stays in the VED's queue, every group is
 * unconfirmed (which is a seal blocker), and the official price is still
 * the seal or the typed «Готово». Nothing here can price a customer.
 *
 * Every write goes through a door that already exists — `proposeGroups` and
 * `saveTable` — so the rev clock, the sweep, the measure pass, the audit row
 * and 0094's import fill all happen exactly as they do when a person works
 * the screen. There is no second writer.
 *
 * The model is INJECTABLE at both points, which is how any of this is
 * provable in a container with no key.
 */

/**
 * May the machine still touch this request?
 *
 * The pass moved to pg-boss so a deploy could not lose it, and that opened a
 * wider hole than it closed: the job no longer runs seconds after the seller
 * presses ✅, it runs whenever the queue drains, and `enqueue` re-delivers it
 * up to five times. Meanwhile `applyProposal` DELETES every group and
 * re-inserts them, and `saveTable`'s import fill ends by clearing the
 * confirmations of every group it touched. So a late or re-delivered job
 * could destroy an evening of a VED's typing — rates, bazas, a certificate
 * flag — and silently un-tick the ✅ that phase E1 exists to record.
 *
 * The rev clock answers it exactly. The job carries the revision the request
 * stood at when it was queued; if anything has moved it since, a person has
 * been here and the machine stands down. A confirmed group or a closed
 * request is the same answer said louder.
 *
 * COST, stated: a pass killed half-way is not retried, because its own first
 * half has already moved the clock. That is the safer half of the trade —
 * the request is in the VED's queue either way, and re-running
 * `applyProposal` over work somebody has since done is the loss this guard
 * exists to prevent. The refusal is logged, never silent.
 */
export type PrefillStand = 'ok' | 'touched' | 'confirmed' | 'closed' | 'not_found';

export async function prefillStanding(
  requestId: string,
  expectRev: number | null,
): Promise<PrefillStand> {
  const [request] = await db
    .select({ rev: calcRequests.rev, completedAt: calcRequests.completedAt })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!request) return 'not_found';
  if (request.completedAt) return 'closed';
  if (expectRev !== null && request.rev !== expectRev) return 'touched';
  const [confirmed] = await db
    .select({ id: calcGroups.id })
    .from(calcGroups)
    .where(and(eq(calcGroups.requestId, requestId), isNotNull(calcGroups.confirmedAt)))
    .limit(1);
  return confirmed ? 'confirmed' : 'ok';
}

/** The revision to quote back when the pass finally runs. */
export async function prefillTicket(requestId: string): Promise<number | null> {
  const [row] = await db
    .select({ rev: calcRequests.rev })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  return row?.rev ?? null;
}

export interface PrefillDeps {
  /** The grouping pass. Default: `proposeGroups` (the ✨ button's own door). */
  propose?: typeof proposeGroups;
  /** The baza pick. Default: `pickImportRows`. Null answer = not available. */
  pick?: (rows: PickRequest[]) => Promise<PickAnswer[] | null>;
  /** Overridable so a test can run without a customs import in the database. */
  configured?: boolean;
}

export interface PrefillOutcome {
  /** The message for the chat that asked. */
  text: string;
  customsUsd: number | null;
  freightUsd: number | null;
  codesStamped: number;
  ratesPulled: number;
  importFilled: number;
  /** How many bazas the model chose a declaration for. */
  picked: number;
  /** Codes the SEALED memory supplied before the model was asked anything. */
  memoryCoded: number;
  /** Bazas a sealed calculation of ours answered (0096). */
  memoryFilled: number;
  aiUsed: boolean;
}

/** How many rows are ever sent to the pick — a wall, not a silent truncation. */
const MAX_PICK_ROWS = 40;

export async function aiPrefill(
  requestId: string,
  ctx: AuditContext,
  deps: PrefillDeps = {},
): Promise<PrefillOutcome> {
  const propose = deps.propose ?? proposeGroups;
  const pick = deps.pick ?? pickImportRows;
  const configured = deps.configured ?? aiConfigured();

  let codesStamped = 0;
  let ratesPulled = 0;
  let importFilled = 0;
  let memoryCoded = 0;
  let memoryFilled = 0;
  let aiUsed = false;

  /**
   * DOES THIS JOB HAVE A CUSTOMS SIDE AT ALL?
   *
   * The pass never asked, and on a **yolkira** request — the freight-only
   * section, the first one the bot offers — it ran the whole customs half
   * anyway: the model grouped the goods, `applyProposal` COMMITTED customs
   * groups onto a quote that has no customs, and `blockersFor` then raised
   * `customs_on_yolkira` («bu bo'limda rastamojka hisoblanmaydi») — a blocker
   * no screen can clear, because nothing offers to delete those groups. So
   * the machine could make a freight quote permanently unsealable, and then
   * bill an Opus grouping call for doing it.
   *
   * A freight quote is priced on the TOTALS. There is nothing here for the
   * model to do, and the honest pass is the one that does nothing.
   */
  const [row] = await db
    .select({ section: calcRequests.section })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  const parts = row?.section
    ? sectionParts(row.section as CalcSectionName)
    : { customs: true, freight: true, extras: true };

  /**
   * 0. THE SEALED MEMORY GOES FIRST (0096), before a token is spent.
   *
   * The owner's own order: «shu muhrlangan datani AI xotirasiga qo'yish
   * kerak». What a VED person confirmed and sealed for this product is this
   * company's answer about it — so the machine reads it before the model,
   * before the quarterly file, and before anything is billed. A product we
   * have priced before comes back coded and with its baza in one save, and
   * the model is then asked only about the names nobody here has ever seen.
   *
   * It writes through `saveTable` like every other door: the same rev clock,
   * the same regroup, the same rate pull at group mint, and the same memory
   * fill that gives those rows their bazas (there is no second writer).
   */
  if (parts.customs) {
    try {
      const out = await applyMemory(requestId, ctx);
      memoryCoded = out.coded;
      memoryFilled = out.filled;
    } catch (err) {
      logger.warn({ err, requestId }, '[calc-prefill] memory pass failed');
    }
  }

  // 1. The model groups the goods and names their codes; `proposeGroups`
  //    then prices what it proposed (the book's rates, the code onto the
  //    row) and 0094's import fill runs inside its save.
  if (configured && parts.customs) {
    try {
      const out = await propose(requestId, ctx);
      codesStamped += out.codesStamped;
      ratesPulled += out.ratesPulled;
      importFilled += out.importFilled;
      aiUsed = true;
    } catch (err) {
      // A model that refused, a key that expired, a request somebody closed
      // between landing and here — none of it is fatal. What follows still
      // runs, and the reply says what was and was not done.
      logger.warn({ err, requestId }, '[calc-prefill] propose failed');
    }
  }

  // 2. …and with or without a model: the SWEEP. Intake prefills codes from
  //    the TNVED memory, so the commonest request arrives already coded, and
  //    an empty save is what places those items in groups (with rates at
  //    mint) and fires the import fill. This is the whole model-free half of
  //    the feature, and it is why a server with no key still gets a figure.
  if (parts.customs) {
    try {
      const swept = await saveTable(requestId, { items: [], adds: [] }, ctx);
      importFilled += swept.importFilled.length;
    } catch (err) {
      logger.warn({ err, requestId }, '[calc-prefill] sweep failed');
    }
  }

  // 3. The bazas the file could not fill by itself: the model is shown the
  //    candidates and picks a DECLARATION, never a number.
  let picked = 0;
  let pickCapped = 0;
  let pickRefused = 0;
  let pickOvertaken = 0;
  if (configured && parts.customs) {
    try {
      const out = await pickBazas(requestId, ctx, pick);
      picked = out.picked;
      pickCapped = out.capped;
      pickRefused = out.refused;
      pickOvertaken = out.overtaken;
      if (picked > 0) aiUsed = true;
    } catch (err) {
      logger.warn({ err, requestId }, '[calc-prefill] pick failed');
    }
  }

  // 4. Read what the engine now says, and say it in words.
  const ws = await loadWorkspace(requestId);
  /**
   * «NOTHING TO PRICE» IS NOT «PRICED AT ZERO».
   *
   * Two sources spelled both as 0 and the section gate above closes only the
   * first: (1) a section with no customs half is hard-coded 0 by
   * `loadWorkspace`; (2) a section that HAS one but carries no groups yet used
   * to come back 0 from `requestCustomsFor([])` — `[].every(ok)` is vacuously
   * TRUE. MEASURED then: the seller read «Tahminiy: rastamojka ~$0.00».
   *
   * The second half is now the ENGINE's answer (audit A17, 0096's round): an
   * empty customs list is `null`, so the screen, the seal gate and this reply
   * all refuse in the same place. The `groups.length` clause stays as the
   * belt — a workspace read by an older server would still spell it 0.
   */
  const customsUsd =
    ws && ws.parts.customs && ws.groups.length > 0 ? ws.customsUsd : null;
  const freight = ws?.freight ?? null;
  // `listUsd` is the road's LIST price — what the tariff says before any
  // concession. A prefill states the tariff, never a discount somebody has
  // not given yet (phase D's line).
  const freightUsd = freight && freight.ok ? freight.listUsd : null;

  /**
   * TWO shapes, one pass, and which one the seller reads is decided by the
   * SECTION and nothing else.
   *
   * A customs job gets the per-line breakdown the owner asked for — that is
   * the whole round. A yolkira job has no customs half at all, so the
   * breakdown would be a heading over an empty list; it keeps the summary
   * this pass has always sent, which says honestly that the road is the
   * VED's to price.
   */
  // Who the answer is ABOUT — the card's own code, and the customer's, so a
  // seller with three open jobs can tell which one this is. One query, and
  // only on the shape that prints them.
  const about = ws && ws.parts.customs ? await requestAbout(requestId) : null;
  const text =
    ws && ws.parts.customs
      ? aiVedReplyText({
          clientLabel: about?.clientCode ?? null,
          cardLabel: about?.cardLabel ?? null,
          lines: replyLines(ws),
          ungrouped: ws.ungrouped.map((i) => i.label),
          fee: ws.fee && ws.fee.ok ? { bhm: ws.fee.bhmCoefficient, usd: ws.fee.feeUsd } : null,
          totalUsd: customsUsd,
          hasCertificate: ws.hasCertificate,
          hasFreight: ws.parts.freight,
          link: about?.link ?? null,
          aiConfigured: configured,
        })
      : prefillReplyText({
          customsUsd,
          freightUsd,
          hasFreight: ws?.parts.freight ?? false,
          hasCustoms: ws?.parts.customs ?? parts.customs,
          blockers: ws?.blockers ?? [],
          codesStamped,
          ratesPulled,
          importFilled: importFilled + picked,
          link: null,
          aiConfigured: configured,
          pickCapped,
          pickRefused,
          pickOvertaken,
        });

  return {
    text,
    customsUsd,
    freightUsd,
    codesStamped,
    ratesPulled,
    importFilled,
    picked,
    memoryCoded,
    memoryFilled,
    aiUsed,
  };
}

/**
 * The card this calculation belongs to, for the reply's own heading.
 *
 * A deal is named by its CODE and a lead by its name — the same rule
 * `requestLabel` follows one file over — and the client code beside it is
 * what the office actually addresses cargo by (#581).
 */
async function requestAbout(
  requestId: string,
): Promise<{ clientCode: string | null; cardLabel: string | null; link: string | null } | null> {
  const [row] = await db
    .select({ entityType: calcRequests.entityType, entityId: calcRequests.entityId })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!row) return null;
  const link = cardLink(row.entityType === 'lead' ? 'lead' : 'deal', row.entityId) || null;
  if (row.entityType === 'deal') {
    const [deal] = await db
      .select({ code: deals.code, clientCode: clients.clientCode })
      .from(deals)
      .leftJoin(clients, eq(clients.id, deals.clientId))
      .where(eq(deals.id, row.entityId));
    return { clientCode: deal?.clientCode ?? null, cardLabel: deal?.code ?? null, link };
  }
  const [lead] = await db
    .select({ name: leads.name })
    .from(leads)
    .where(eq(leads.id, row.entityId));
  return { clientCode: null, cardLabel: lead?.name ?? null, link };
}

/**
 * The workspace's groups as the reply's lines.
 *
 * ONE LINE PER GROUP, never per item, and that is a property of the ENGINE
 * rather than a layout choice: `customsFor` prices a GROUP, and splitting its
 * figure across the members would be inventing an allocation — the same
 * refusal `groupPerUnit` makes on the price history (#780). The group names
 * its items instead, which is what the seller wrote anyway.
 *
 * The baza mark is the group's own answer only when its members AGREE about
 * where the price came from: a group carrying one remembered baza and one the
 * VED typed wears no mark at all, because a 🧠 over a mixed row would claim
 * a provenance for a number that is half somebody's typing.
 */
function replyLines(ws: Workspace): AiVedLine[] {
  return ws.groups.map((g) => {
    const sources = [...new Set(g.items.map((i) => i.bazaSource))];
    const bazaSource = sources.length === 1 ? sources[0]! : null;
    const bazas = [...new Set(g.items.map((i) => `${i.bazaUsd}|${i.bazaBasis}`))];
    const first = g.items[0];
    // The shorthand «100 dona × $20/dona» is printed only where it is TRUE
    // of the whole group; the figure beside it is exact either way.
    const measureText =
      bazas.length === 1 && first && first.bazaUsd !== null && first.bazaBasis !== null
        ? `${measureOf(g)} × $${first.bazaUsd}/${first.bazaBasis === 'unit' ? 'dona' : first.bazaBasis}`
        : null;
    return {
      label: g.items.map((i) => i.label).join(', ') || g.label,
      code: g.tnvedCode,
      measureText,
      bazaSource,
      dutyText: g.dutyFree ? 'yo‘q (lgota)' : dutyText(g),
      addDutyPct: g.customs.ok ? g.customs.addDutyPct : 0,
      excisePct: g.excisePct,
      vatPct: g.vatFree ? 0 : g.vatPct,
      customsUsd: g.customs.ok ? g.customs.customsUsd : null,
      // Already words — `blockerText` owns the engine's whole vocabulary and
      // a second map here would drift from it (#513).
      refusal: g.customs.ok
        ? null
        : blockerText({
            kind: 'customs',
            groupLabel: g.label,
            reason: g.customs.reason,
            itemLabel: g.customs.itemLabel,
          } as SealBlocker),
    };
  });
}

/** What the group is measured in, as the seller stated it. */
function measureOf(g: Workspace['groups'][number]): string {
  const qty = g.items.reduce((sum, i) => sum + (i.quantity ?? 0), 0);
  if (qty > 0) return `${round3(qty)} dona`;
  const kg = g.items.reduce((sum, i) => sum + (i.weightKg ?? 0), 0);
  if (kg > 0) return `${round3(kg)} kg`;
  const measure = g.items.reduce((sum, i) => sum + (i.measureQty ?? 0), 0);
  const unit = g.items.find((i) => i.measureUnit)?.measureUnit;
  return measure > 0 && unit ? `${round3(measure)} ${unit}` : '—';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Step 0: stamp the codes the company's own seals already know.
 *
 * Only UNCODED rows are asked about — a code the intake or a person has
 * already put on the row is never second-guessed — and only the CODE is
 * posted here. The baza arrives by itself: `saveTable`'s own memory fill
 * (0096) answers every row this save leaves coded and baza-less, from the
 * same sealed record, under the same three re-checks.
 */
async function applyMemory(
  requestId: string,
  ctx: AuditContext,
): Promise<{ coded: number; filled: number }> {
  const rows = await db
    .select({
      id: calcRequestItems.id,
      seq: calcRequestItems.seq,
      name: calcRequestItems.name,
      tnvedCode: calcRequestItems.tnvedCode,
    })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId));
  const uncoded = rows.filter((r) => !(r.tnvedCode ?? '').trim());
  // A fully coded request still gets its save — that is what fills the bazas
  // and mints the groups — but there is nothing to look up.
  if (uncoded.length === 0) return { coded: 0, filled: 0 };

  const hits = await sealedMemoryFor(
    uncoded.map((r) => r.name),
    { excludeRequestId: requestId },
  );
  if (hits.size === 0) return { coded: 0, filled: 0 };

  // Named apart from the pick's `edits` on purpose: these carry a CODE and
  // nothing else, and `ai-advisory.test.ts` anchors its «the prefill writes
  // no provenance of its own» fence on the pick's own push.
  const codeEdits: TableItemEdit[] = [];
  for (const r of uncoded) {
    const hit = hits.get(itemNameNorm(r.name));
    if (!hit?.tnvedCode) continue;
    codeEdits.push({ id: r.id, seq: r.seq, tnvedCode: hit.tnvedCode });
  }
  if (codeEdits.length === 0) return { coded: 0, filled: 0 };

  const out = await saveTable(requestId, { items: codeEdits, adds: [] }, ctx);
  return { coded: codeEdits.length, filled: out.memoryFilled.length };
}

/**
 * Offer the model every still-empty baza's candidates, and write back the
 * rows it chose — through `saveTable`'s `importRowId` path, so the PRICE
 * comes out of the file and the provenance lands on 'import' (#894).
 */
async function pickBazas(
  requestId: string,
  ctx: AuditContext,
  pick: NonNullable<PrefillDeps['pick']>,
): Promise<{ picked: number; capped: number; refused: number; overtaken: number }> {
  const none = { picked: 0, capped: 0, refused: 0, overtaken: 0 };
  const batchId = await newestReadyBatchId();
  // Nothing imported yet: there is nothing to choose between, and inventing
  // a price is the one thing this module may never do.
  if (!batchId) return none;

  const rows = await db
    .select({
      id: calcRequestItems.id,
      seq: calcRequestItems.seq,
      name: calcRequestItems.name,
      tnvedCode: calcRequestItems.tnvedCode,
      quantity: calcRequestItems.quantity,
      weightKg: calcRequestItems.weightKg,
      bazaUsd: calcRequestItems.bazaUsd,
      groupId: calcRequestItems.groupId,
    })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId));
  const empty = rows.filter((r) => r.bazaUsd === null && (r.tnvedCode ?? '').trim());
  if (empty.length === 0) return none;

  const groups = await db
    .select({ id: calcGroups.id, dutyUnit: calcGroups.dutyUnit })
    .from(calcGroups)
    .where(eq(calcGroups.requestId, requestId));
  const dutyUnitOf = new Map(groups.map((g) => [g.id, g.dutyUnit]));

  const asking: PickRequest[] = [];
  const unitOfSeq = new Map<number, ReturnType<typeof unitsForRow>[number]>();
  for (const r of empty.slice(0, MAX_PICK_ROWS)) {
    const qty = r.quantity === null ? null : Number(r.quantity);
    const kg = r.weightKg === null ? null : Number(r.weightKg);
    const units = unitsForRow({
      dutyUnit: r.groupId ? (dutyUnitOf.get(r.groupId) ?? null) : null,
      hasWeight: kg !== null && kg > 0,
      hasQuantity: qty !== null && qty > 0,
    });
    const unit = units[0];
    if (!unit) continue;
    const perPiece = qty !== null && qty > 0 && kg !== null && kg > 0 ? kg / qty : null;
    const sug = await suggestImportBaza(
      { tnvedCode: r.tnvedCode!.trim(), name: r.name, unit, weightPerUnitKg: perPiece },
      { batchId },
    );
    if (sug.candidates.length === 0) continue;
    unitOfSeq.set(r.seq, unit);
    asking.push({
      seq: r.seq,
      name: r.name,
      tnvedCode: r.tnvedCode!.trim(),
      candidates: sug.candidates,
    });
  }
  if (empty.length > MAX_PICK_ROWS) {
    logger.info(
      { requestId, asked: MAX_PICK_ROWS, total: empty.length },
      '[calc-prefill] pick capped — the rest stay for the VED',
    );
  }
  if (asking.length === 0) return none;

  const capped = Math.max(0, empty.length - MAX_PICK_ROWS);
  const answers = await pick(asking);
  if (!answers) return { ...none, capped };

  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const askedBySeq = new Map(asking.map((a) => [a.seq, a]));
  const edits: TableItemEdit[] = [];
  let refused = 0;
  for (const a of answers) {
    if (a.candidate === null) continue;
    const row = bySeq.get(a.seq);
    const asked = askedBySeq.get(a.seq);
    if (!row || !asked) continue;
    const chosen = asked.candidates[a.candidate];
    if (!chosen) continue;
    const unit = unitOfSeq.get(a.seq);
    // The unit the row was ASKED about is the only one it may be answered
    // in: a per-kg declaration on a per-dona row is off by the weight of the
    // goods, and the model is choosing a row, not a basis.
    if (!unit || BASIS_FOR_UNIT[chosen.unit] !== BASIS_FOR_UNIT[unit]) {
      refused += 1;
      continue;
    }
    edits.push({
      id: row.id,
      seq: row.seq,
      // The amount is re-read from the FILE by `saveTable` — what is posted
      // here is only which row (#894). The basis travels with it.
      bazaUsd: chosen.pricePerUnitUsd,
      bazaBasis: chosen.basis,
      importRowId: chosen.id,
      // WHY this declaration and not the one beside it — owed since #909,
      // where a model's pick and the deterministic ≥0.45 auto-fill landed
      // identically and the VED reviewing the number could not tell which
      // had put it there. WORDS only: the price still comes from the file.
      bazaReason: a.reason,
    });
  }
  logger.info(
    {
      requestId,
      picks: answers.map((a) => ({ seq: a.seq, candidate: a.candidate, reason: a.reason })),
      capped,
      refused,
    },
    '[calc-prefill] the model chose',
  );

  if (edits.length === 0) return { picked: 0, capped, refused, overtaken: 0 };

  /**
   * STILL EMPTY? The rows were read before a model call that can take a
   * minute, and a VED opening the request meanwhile is not a race — it is
   * the normal way this queue is worked.
   *
   * The deterministic auto-fill has carried this re-check since 0094
   * (`if (item.bazaUsd !== null) continue`, inside the save's own
   * transaction). The pick did not, because it writes through `saveTable`'s
   * ORDINARY edit branch — which is right for a person, whose typing SHOULD
   * overwrite, and wrong for a machine answering a question it asked a
   * minute ago. So a baza the VED had just typed was replaced by the model's
   * choice, and `baza_source` flipped to 'import': their number gone, and the
   * chip claiming the file had supplied it.
   *
   * A row that filled in the meantime is DROPPED and counted, never written.
   * The residual window is the milliseconds to `saveTable`'s own
   * `FOR UPDATE`, which is the window every writer in this module has.
   */
  const fresh = await db
    .select({ id: calcRequestItems.id, bazaUsd: calcRequestItems.bazaUsd })
    .from(calcRequestItems)
    .where(
      inArray(
        calcRequestItems.id,
        edits.map((e) => e.id),
      ),
    );
  const stillEmpty = new Set(fresh.filter((r) => r.bazaUsd === null).map((r) => r.id));
  const live = edits.filter((e) => stillEmpty.has(e.id));
  const overtaken = edits.length - live.length;
  if (overtaken > 0) {
    logger.info(
      { requestId, overtaken },
      '[calc-prefill] a person filled these while the model was thinking — left alone',
    );
  }
  if (live.length === 0) return { picked: 0, capped, refused, overtaken };

  await saveTable(requestId, { items: live, adds: [] }, ctx);
  return { picked: live.length, capped, refused, overtaken };
}
