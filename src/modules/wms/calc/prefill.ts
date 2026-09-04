import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcGroups, calcRequestItems, calcRequests } from '../../platform/db/schema';
import { aiConfigured } from '../../platform/ai/model';
import { logger } from '../../platform/logger';
import type { AuditContext } from '../../platform/audit/service';
import {
  newestReadyBatchId,
} from '../customs/import-service';
import { suggestImportBaza, unitsForRow, BASIS_FOR_UNIT } from '../customs/import-baza';
import { sectionParts, type CalcSectionName } from './pricing';
import { loadWorkspace, proposeGroups, saveTable, type TableItemEdit } from './workspace';
import { prefillReplyText } from './prefill-reply';
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
   * «NOTHING TO PRICE» IS NOT «PRICED AT ZERO», and the engine spells both 0.
   *
   * Two independent sources, and the section gate above only closes the
   * first. (1) A section with no customs half is hard-coded 0 by
   * `loadWorkspace`. (2) A section that HAS one but carries no groups yet:
   * `requestCustomsFor([])` runs `[].every(ok)` — vacuously TRUE — and
   * returns `customsUsd: 0`. That second one is the ordinary way this ships:
   * no ANTHROPIC key, or a model that refused, and nothing the TNVED memory
   * already knew. MEASURED: the seller read «Tahminiy: rastamojka ~$0.00».
   *
   * `null` here, so the reply refuses in words. Deliberately NOT fixed in
   * `requestCustomsFor`: that function is consumed verbatim by the live
   * browser recompute and by the seal, and making its empty case null would
   * move the footer bar and the seal gate in a round that ships no migration.
   */
  const customsUsd =
    ws && ws.parts.customs && ws.groups.length > 0 ? ws.customsUsd : null;
  const freight = ws?.freight ?? null;
  // `listUsd` is the road's LIST price — what the tariff says before any
  // concession. A prefill states the tariff, never a discount somebody has
  // not given yet (phase D's line).
  const freightUsd = freight && freight.ok ? freight.listUsd : null;

  return {
    text: prefillReplyText({
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
    }),
    customsUsd,
    freightUsd,
    codesStamped,
    ratesPulled,
    importFilled,
    picked,
    aiUsed,
  };
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
    });
  }
  // The model's REASONS, which nothing on a screen can show yet: there is no
  // column for them and this round mints no migration. Logged structurally so
  // the first real week is reviewable at all — and STATED to the owner as
  // owed, because a pick a person cannot see the reason for is exactly as
  // reviewable as no reason at all.
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
