import { eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcGroups, calcRequestItems } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import type { AuditContext } from '../../platform/audit/service';
import { recordAiPass } from './ai-cost';
import { newestReadyBatchId } from '../customs/import-service';
import { suggestImportBaza, unitsForItem } from '../customs/import-baza';
import type { ImportUnit } from '../customs/import-parse';
import { saveTable, type TableItemEdit } from './workspace';
import { itemNameNorm, sealedMemoryFor } from './memory';
import type { PickRequest } from './prefill-ai';
import type { PrefillDeps } from './prefill';

/**
 * The prefill's two SAVING steps, out of `prefill.ts` (docs/SAKKIZ-R2.md K5):
 * the sealed memory's codes (step 0) and the model's declaration pick
 * (step 3). Moved verbatim, so the pass (`aiPrefill`) is the reading and
 * replying half and this file is the writing half — round 2's baza package
 * reworks these two and nothing of the reply.
 *
 * Both take the REVISION their caller last saw and give back the one their
 * own save left (K14). `null` means «no compare-and-set» — today's behaviour,
 * and what the kernel passes. A number makes `saveTable` refuse `conflict`
 * when a person has saved in between, so a machine answering a question it
 * asked a minute ago cannot write over them.
 */

/** How many rows are ever sent to the pick — a wall, not a silent truncation. */
export const MAX_PICK_ROWS = 40;

/** `saveTable`'s options for a revision the caller carries — none for null. */
const casOf = (expectRev: number | null) => (expectRev === null ? undefined : { expectRev });

/**
 * Step 0: stamp the codes the company's own seals already know.
 *
 * Only UNCODED rows are asked about — a code the intake or a person has
 * already put on the row is never second-guessed — and only the CODE is
 * posted here. The baza arrives by itself: `saveTable`'s own memory fill
 * (0096) answers every row this save leaves coded and baza-less, from the
 * same sealed record, under the same three re-checks.
 */
export async function applyMemory(
  requestId: string,
  ctx: AuditContext,
  expectRev: number | null,
): Promise<{ coded: number; filled: number; rev: number | null }> {
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
  if (uncoded.length === 0) return { coded: 0, filled: 0, rev: expectRev };

  const hits = await sealedMemoryFor(
    uncoded.map((r) => r.name),
    { excludeRequestId: requestId },
  );
  if (hits.size === 0) return { coded: 0, filled: 0, rev: expectRev };

  // Named apart from the pick's `edits` on purpose: these carry a CODE and
  // nothing else, and `ai-advisory.test.ts` anchors its «the prefill writes
  // no provenance of its own» fence on the pick's own push.
  const codeEdits: TableItemEdit[] = [];
  for (const r of uncoded) {
    const hit = hits.get(itemNameNorm(r.name));
    if (!hit?.tnvedCode) continue;
    codeEdits.push({ id: r.id, seq: r.seq, tnvedCode: hit.tnvedCode });
  }
  if (codeEdits.length === 0) return { coded: 0, filled: 0, rev: expectRev };

  const out = await saveTable(requestId, { items: codeEdits, adds: [] }, ctx, casOf(expectRev));
  return { coded: codeEdits.length, filled: out.memoryFilled.length, rev: out.rev };
}

/**
 * Offer the model every still-empty baza's candidates, and write back the
 * rows it chose — through `saveTable`'s `importRowId` path, so the PRICE
 * comes out of the file and the provenance lands on 'import' (#894).
 */
export async function pickBazas(
  requestId: string,
  ctx: AuditContext,
  pick: NonNullable<PrefillDeps['pick']>,
  expectRev: number | null,
): Promise<{
  picked: number;
  capped: number;
  refused: number;
  overtaken: number;
  timedOut: number;
  rev: number | null;
}> {
  const none = { picked: 0, capped: 0, refused: 0, overtaken: 0, timedOut: 0, rev: expectRev };
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
      volumeM3: calcRequestItems.volumeM3,
      bazaUsd: calcRequestItems.bazaUsd,
      bazaBasis: calcRequestItems.bazaBasis,
      groupId: calcRequestItems.groupId,
      measureUnit: calcRequestItems.measureUnit,
      measureQty: calcRequestItems.measureQty,
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
  const unitsOfSeq = new Map<number, ImportUnit[]>();
  for (const r of empty.slice(0, MAX_PICK_ROWS)) {
    const qty = r.quantity === null ? null : Number(r.quantity);
    const kg = r.weightKg === null ? null : Number(r.weightKg);
    const m3 = r.volumeM3 === null ? null : Number(r.volumeM3);
    // The row's whole accepted set — and a unit the VED already CHOSE on this
    // still-unpriced row narrows it to that one (0125): the model chooses a
    // declaration, never a unit. ONE row → units mapping (`unitsForItem`),
    // shared with round 2's median read.
    const units = unitsForItem(
      {
        quantity: qty,
        weightKg: kg,
        volumeM3: m3,
        bazaBasis: r.bazaBasis,
        measureUnit: r.measureUnit,
        measureQty: r.measureQty === null ? null : Number(r.measureQty),
      },
      r.groupId ? (dutyUnitOf.get(r.groupId) ?? null) : null,
    );
    if (units.length === 0) continue;
    const perPiece =
      units.includes('dona') && qty !== null && qty > 0 && kg !== null && kg > 0 ? kg / qty : null;
    const sug = await suggestImportBaza(
      { tnvedCode: r.tnvedCode!.trim(), name: r.name, units, weightPerUnitKg: perPiece },
      { batchId },
    );
    if (sug.candidates.length === 0) continue;
    unitsOfSeq.set(r.seq, units);
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
  const outcome = await pick(asking);
  // The pick hands its usage BACK rather than through a callback (K5): a
  // callback's `void` could never be made to finish before the pass returns.
  // Still fire-and-forget here, as it was inside the callback — round 2's P2
  // turns it into an `await`.
  if (outcome.usage) {
    const usage = outcome.usage;
    void recordAiPass({
      requestId,
      staffId: ctx.actorId ?? null,
      kind: 'pick',
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  }
  const answers = outcome.answers;
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
    const units = unitsOfSeq.get(a.seq);
    // The units the row was ASKED about are the only ones it may be answered
    // in: a per-kg declaration on a per-dona row is off by the weight of the
    // goods, and the model is choosing a row, not a basis. A chosen unit
    // narrowed this to one (0125).
    if (!units || !units.includes(chosen.unit)) {
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

  if (edits.length === 0) return { ...none, capped, refused };

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
  if (live.length === 0) return { ...none, capped, refused, overtaken };

  const saved = await saveTable(requestId, { items: live, adds: [] }, ctx, casOf(expectRev));
  return { picked: live.length, capped, refused, overtaken, timedOut: 0, rev: saved.rev };
}
