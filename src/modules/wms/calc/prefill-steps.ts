import { eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcGroups, calcRequestItems } from '../../platform/db/schema';
import { isQueryCanceled } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import type { AuditContext } from '../../platform/audit/service';
import { recordAiPass } from './ai-cost';
import { batchesForCodes } from '../customs/import-service';
import {
  foreignCodes,
  isFullCode,
  judgeCandidates,
  suggestImportBaza,
  unitsForAsk,
  type ImportBazaRow,
} from '../customs/import-baza';
import { onDate, ratesForCodes } from './dictionaries';
import { CalcError } from './service';
import { AI_RECODE_PREFIX } from './warnings';
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

/**
 * The statement ceiling of a HEADING's candidate read in the background pick
 * (round 2, performance-1). Longer than the 📥 list's 1.5 s — nobody is
 * waiting on a screen here — and still a ceiling: a heading admits every
 * subheading of the file, and the scan scores every one of them.
 */
export const PICK_HEADING_MS = 5000;

/** `saveTable`'s options for a revision the caller carries — none for null. */
const casOf = (expectRev: number | null) => (expectRev === null ? undefined : { expectRev });

/**
 * A machine save refused because a PERSON saved in between (K14). Nothing was
 * written — not a cell, not an audit row — and the machine does not retry: a
 * person is working on this request, and putting the machine's answer back
 * would write over them, or take their ✅ off (`jobs.ts`'s own law: the
 * machine stands down rather than un-ticking a person's ✅). Only the PICK
 * swallows it, because nothing writes after the pick; `applyMemory` lets it
 * through, so the pass can stand down (review P2-CAS-1).
 */
const overtakenByPerson = (err: unknown) => err instanceof CalcError && err.code === 'conflict';

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
): Promise<{ coded: number; filled: number; dictionaryFilled: number; rev: number | null }> {
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
  if (uncoded.length === 0) return { coded: 0, filled: 0, dictionaryFilled: 0, rev: expectRev };

  const hits = await sealedMemoryFor(
    uncoded.map((r) => r.name),
    { excludeRequestId: requestId },
  );
  if (hits.size === 0) return { coded: 0, filled: 0, dictionaryFilled: 0, rev: expectRev };

  // Named apart from the pick's `edits` on purpose: these carry a CODE and
  // nothing else, and `ai-advisory.test.ts` anchors its «the prefill writes
  // no provenance of its own» fence on the pick's own push.
  const codeEdits: TableItemEdit[] = [];
  for (const r of uncoded) {
    const hit = hits.get(itemNameNorm(r.name));
    if (!hit?.tnvedCode) continue;
    codeEdits.push({ id: r.id, seq: r.seq, tnvedCode: hit.tnvedCode });
  }
  if (codeEdits.length === 0) return { coded: 0, filled: 0, dictionaryFilled: 0, rev: expectRev };

  // A `conflict` here is NOT swallowed (review P2-CAS-1). The pass's glue
  // reads it as «a person saved meanwhile» and writes nothing more; answered
  // as an ordinary «nothing to stamp», the glue re-reads the CURRENT revision
  // for its next step — the person's own — and the sweep and the pick would
  // pass the compare-and-set and refill a baza the person had just cleared,
  // taking their ✅ off with it. The book fills in this save too (round 2),
  // so its count rides beside the memory's.
  const out = await saveTable(requestId, { items: codeEdits, adds: [] }, ctx, casOf(expectRev));
  return {
    coded: codeEdits.length,
    filled: out.memoryFilled.length,
    dictionaryFilled: out.dictionaryFilled.length,
    rev: out.rev,
  };
}

/**
 * Offer the model every still-empty baza's candidates, and write back the
 * rows it chose — through `saveTable`'s `importRowId` path, so the PRICE
 * comes out of the file and the provenance lands on 'import' (#894).
 *
 * Round 2 (docs/SAKKIZ-R2.md §7.4-7.5):
 * - the quarter is chosen PER CODE (`batchesForCodes`), the list's and the
 *   fill's own chooser;
 * - a row coded only by a HEADING is offered the heading's declarations, each
 *   with its own code, under a statement ceiling (`PICK_HEADING_MS`); a pick
 *   among them RECODES the row to the declaration's code — which chooses the
 *   duty law — so the reason says so (`AI_RECODE_PREFIX`) and the ✅ records
 *   it (`ai_recode`);
 * - the unit is checked against the TARGET code's law, never the heading's;
 * - one candidate read per row SHAPE, as the auto-fill already keeps;
 * - the call's usage is recorded with `await`, before any save;
 * - the save carries the revision the machine last wrote (K14): a person's
 *   save in between makes it `conflict`, which writes nothing.
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
  /** Rows the BOOK filled in the pick's own save (every save fills since
   * round 2) — counted, or the pass under-reports the book (review P2-9). */
  dictionaryFilled: number;
  rev: number | null;
}> {
  const none = { picked: 0, capped: 0, refused: 0, overtaken: 0, timedOut: 0, dictionaryFilled: 0, rev: expectRev };

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

  const sent = empty.slice(0, MAX_PICK_ROWS);
  const chosenBatch = await batchesForCodes(sent.map((r) => r.tnvedCode!.trim()));
  // Nothing imported yet: there is nothing to choose between, and inventing
  // a price is the one thing this module may never do.
  if (chosenBatch.size === 0) return none;

  const groups = await db
    .select({ id: calcGroups.id, dutyUnit: calcGroups.dutyUnit })
    .from(calcGroups)
    .where(eq(calcGroups.requestId, requestId));
  const dutyUnitOf = new Map(groups.map((g) => [g.id, g.dutyUnit]));

  /** The row's figures, as the ONE row → units mapping reads them (K10). */
  const factsOf = (r: (typeof rows)[number]) => ({
    quantity: r.quantity === null ? null : Number(r.quantity),
    weightKg: r.weightKg === null ? null : Number(r.weightKg),
    volumeM3: r.volumeM3 === null ? null : Number(r.volumeM3),
    bazaBasis: r.bazaBasis,
    measureUnit: r.measureUnit,
    measureQty: r.measureQty === null ? null : Number(r.measureQty),
  });

  const asking: PickRequest[] = [];
  /** Each asked row's figures and own block law — what its candidates are
   * judged against before the model sees them. */
  const judgeBy = new Map<number, { facts: ReturnType<typeof factsOf>; code: string; law: string | null }>();
  let timedOut = 0;
  // One candidate read per DISTINCT row shape — the memo the auto-fill
  // already keeps (#432): ten identical heading rows cost one scan, not ten.
  // Sequential awaits, never concurrent: one pool connection at a time.
  const askedShape = new Map<string, ImportBazaRow[] | 'timeout'>();
  for (const r of sent) {
    const code = r.tnvedCode!.trim();
    const batchId = chosenBatch.get(code)?.batchId;
    if (!batchId) continue;
    const facts = factsOf(r);
    const law = r.groupId ? (dutyUnitOf.get(r.groupId) ?? null) : null;
    // The row's whole accepted set — and a unit the VED already CHOSE on this
    // still-unpriced row narrows it to that one (0125): the model chooses a
    // declaration, never a unit. A HEADING is not ranked by the heading's law
    // alone (`unitsForAsk`, review P2-1): its candidates are judged by their
    // own laws below.
    const units = unitsForAsk(facts, code, law);
    if (units.length === 0) continue;
    const qty = facts.quantity;
    const kg = facts.weightKg;
    const perPiece =
      units.includes('dona') && qty !== null && qty > 0 && kg !== null && kg > 0 ? kg / qty : null;
    const shape = `${code}|${units.join('+')}|${r.name}|${perPiece ?? ''}`;
    let candidates = askedShape.get(shape);
    if (candidates === undefined) {
      try {
        const sug = await suggestImportBaza(
          { tnvedCode: code, name: r.name, units, weightPerUnitKg: perPiece },
          { batchId, ceilingMs: PICK_HEADING_MS },
        );
        candidates = sug.candidates;
      } catch (err) {
        // A HEADING over its ceiling: the row is skipped and counted, never
        // a dead pass. A full code has no ceiling, so anything else rethrows.
        if (!isQueryCanceled(err) || isFullCode(code)) throw err;
        candidates = 'timeout';
      }
      askedShape.set(shape, candidates);
    }
    if (candidates === 'timeout') {
      timedOut += 1;
      continue;
    }
    if (candidates.length === 0) continue;
    asking.push({ seq: r.seq, name: r.name, tnvedCode: code, candidates });
    judgeBy.set(r.seq, { facts, code, law });
  }
  if (empty.length > MAX_PICK_ROWS) {
    logger.info(
      { requestId, asked: MAX_PICK_ROWS, total: empty.length },
      '[calc-prefill] pick capped — the rest stay for the VED',
    );
  }
  if (timedOut > 0) {
    logger.info({ requestId, timedOut }, '[calc-prefill] heading candidates over their ceiling — left for the VED');
  }
  const capped = Math.max(0, empty.length - MAX_PICK_ROWS);
  if (asking.length === 0) return { ...none, capped, timedOut };

  // Every candidate judged by the law IT would bring with it (regression-7's
  // rule, the 📥 list's own — `judgeCandidates`), BEFORE the model is asked:
  // the «единица не совпадает» mark the model reads and the refusal after its
  // answer are then one judgement, and a declaration whose law counts in juft
  // is never shown as fitting a row that states kilograms. The book is read
  // ONCE, on the pool, for every code a pick could move a row to (#714). A
  // row the pick leaves on its own code keeps its block's law, with any law a
  // person typed. Per row, never on the memo's shared list: two rows of one
  // shape can still differ in what another law lets them be priced in.
  const foreign = [...new Set(asking.flatMap((a) => foreignCodes(a.tnvedCode, a.candidates)))];
  const book = foreign.length > 0 ? await ratesForCodes(foreign, onDate()) : new Map();
  for (const a of asking) {
    const by = judgeBy.get(a.seq)!;
    a.candidates = judgeCandidates(by.facts, by.code, by.law, a.candidates, book);
  }

  const outcome = await pick(asking);
  // The pick hands its usage BACK (K5), and it is recorded HERE, awaited and
  // before any save: the ledger row exists when this function returns, so the
  // soft budget the next pass reads already counts it. A call the model
  // answered counts whatever was made of the answer; one with no answer
  // (usage null — a timeout, the network) is not counted (2.9 c).
  if (outcome.usage) {
    const usage = outcome.usage;
    await recordAiPass({
      requestId,
      staffId: ctx.actorId ?? null,
      kind: 'pick',
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  }
  const answers = outcome.answers;
  if (!answers) return { ...none, capped, timedOut };

  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const askedBySeq = new Map(asking.map((a) => [a.seq, a]));

  const edits: TableItemEdit[] = [];
  /** The code each edit was asked under — re-checked below. */
  const askedCode = new Map<string, string>();
  let refused = 0;
  for (const a of answers) {
    if (a.candidate === null) continue;
    const row = bySeq.get(a.seq);
    const asked = askedBySeq.get(a.seq);
    if (!row || !asked) continue;
    const chosen = asked.candidates[a.candidate];
    if (!chosen) continue;
    const recode = chosen.tnvedCode !== asked.tnvedCode;
    // The units the TARGET code's law allows this row — judged above, before
    // the model was asked (`judgeCandidates`): a pick that recodes the row
    // brings the declaration's law with it, and a per-kg price on a row that
    // law counts in juft is a price in the wrong unit, whatever the heading
    // allowed. A chosen unit (0125) still narrows it to that one.
    if (!chosen.unitMatches) {
      refused += 1;
      continue;
    }
    askedCode.set(row.id, asked.tnvedCode);
    edits.push({
      id: row.id,
      seq: row.seq,
      // A recode lands the declaration's own code beside its price, in ONE
      // press — `saveTable` re-reads the row by `importRowId` against the
      // code the row will carry after this save.
      ...(recode ? { tnvedCode: chosen.tnvedCode } : {}),
      // The amount is re-read from the FILE by `saveTable` — what is posted
      // here is only which row (#894). The basis travels with it.
      bazaUsd: chosen.pricePerUnitUsd,
      bazaBasis: chosen.basis,
      importRowId: chosen.id,
      // WHY this declaration and not the one beside it — owed since #909,
      // where a model's pick and the deterministic ≥0.45 auto-fill landed
      // identically and the VED reviewing the number could not tell which
      // had put it there. WORDS only: the price still comes from the file.
      // A recode SAYS so first (law-money-4): the model chose the tariff
      // line too, and the prefix at the start survives the 300-char cut.
      bazaReason: recode ? `${AI_RECODE_PREFIX}${asked.tnvedCode} → ${chosen.tnvedCode} · ${a.reason}` : a.reason,
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

  if (edits.length === 0) return { ...none, capped, refused, timedOut };

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
   * chip claiming the file had supplied it. Round 2 re-checks the CODE as
   * well: a row a person recoded meanwhile is not the row the model was
   * asked about.
   *
   * A row that filled in the meantime is DROPPED and counted, never written.
   * The window between this read and `saveTable`'s own `FOR UPDATE` is closed
   * by the revision compare-and-set below.
   */
  const fresh = await db
    .select({ id: calcRequestItems.id, bazaUsd: calcRequestItems.bazaUsd, tnvedCode: calcRequestItems.tnvedCode })
    .from(calcRequestItems)
    .where(
      inArray(
        calcRequestItems.id,
        edits.map((e) => e.id),
      ),
    );
  const stillEmpty = new Set(
    fresh
      .filter((r) => r.bazaUsd === null && (r.tnvedCode ?? '').trim() === askedCode.get(r.id))
      .map((r) => r.id),
  );
  const live = edits.filter((e) => stillEmpty.has(e.id));
  let overtaken = edits.length - live.length;
  if (overtaken > 0) {
    logger.info(
      { requestId, overtaken },
      '[calc-prefill] a person filled these while the model was thinking — left alone',
    );
  }
  if (live.length === 0) return { ...none, capped, refused, overtaken, timedOut };

  try {
    const saved = await saveTable(requestId, { items: live, adds: [] }, ctx, casOf(expectRev));
    return {
      picked: live.length,
      capped,
      refused,
      overtaken,
      timedOut,
      dictionaryFilled: saved.dictionaryFilled.length,
      rev: saved.rev,
    };
  } catch (err) {
    if (!overtakenByPerson(err)) throw err;
    // A person saved while the model was thinking — the pick's call takes up
    // to 2 × 60 s with no claim held. Without this refusal the save's own
    // fill (which runs on EVERY save since round 2) would refill a baza they
    // had just cleared, and its unconfirm would take their ✅ off
    // (concurrency-3).
    overtaken += live.length;
    logger.info({ requestId, overtaken }, '[calc-prefill] a person saved while the model was thinking — nothing written');
    return { picked: 0, capped, refused, overtaken, timedOut, dictionaryFilled: 0, rev: expectRev };
  }
}
