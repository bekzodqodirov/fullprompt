'use server';

import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { attachments, batches, boxes, receiptLots } from '@/modules/platform/db/schema';
import { requestMeta } from '@/modules/platform/auth/session';
import { getStorage } from '@/modules/platform/files/storage';
import { requireActor } from '@/modules/platform/rbac/authorize';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { batchMemberFilter } from '@/modules/wms/scanning/unload';
import {
  isValidTnved,
  lineQuestion,
  productKey,
  saveTnved,
  suggestTnved,
  TnvedError,
  type AiUsage,
  type TnvedSuggestion,
} from '@/modules/wms/tnved/service';
import { batchTnvedProducts } from '@/modules/wms/tnved/batch-lots';
import { aiConfigured } from '@/modules/platform/ai/model';
import { pressToday, reservePress, settlePress, type PressOutcome, type PressToday } from '@/modules/wms/calc/ai-press';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import { isBusyError, isServerBehind } from '@/modules/platform/db/errors';
import { isUuidShaped } from '@/modules/platform/audit/fields';
import {
  CompositionError,
  compositionDoor,
  mayWriteComposition,
  paperCompositionsFor,
  setLineCodes,
} from '@/modules/wms/receipts/lot-composition';

async function vedActor() {
  const actor = await requireActor();
  if (!actor.permissions.has('ved.docs') && !actor.permissions.has('plans.manage')) return null;
  return actor;
}

type ModelPhoto = { data: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' };

type VedActor = NonNullable<Awaited<ReturnType<typeof vedActor>>>;

/**
 * Today's 🤖 count for the line beside the buttons — and, only for a reader
 * of the company's money, what the answered calls cost. Undefined when the
 * ledger cannot be read (a server one migration behind): no line is drawn.
 */
async function aiToday(actor: VedActor): Promise<PressToday | undefined> {
  return pressToday('tnved', companyMoneySight(actor)).catch(() => undefined);
}

/** What a 🤖 press answers: the suggestion or a refusal's code, and today's count after it. */
type Suggested = { ok: boolean; suggestion?: TnvedSuggestion; error?: string; today?: PressToday };

/**
 * The first photograph of a lot, smaller variant preferred — enough for the
 * model. Read only AFTER every door has answered: the bytes are the lot's,
 * and a refused press must not have touched them.
 */
async function firstLotPhoto(lotId: string): Promise<ModelPhoto | null> {
  const [att] = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'receipt_lot'),
        eq(attachments.entityId, lotId),
        eq(attachments.kind, 'photo'),
      ),
    )
    .orderBy(asc(attachments.createdAt))
    .limit(1);
  if (!att) return null;
  try {
    const key = att.thumb800Key ?? att.storageKey;
    const data = await getStorage().get(key);
    const mediaType = key.endsWith('.webp')
      ? ('image/webp' as const)
      : att.contentType === 'image/png'
        ? ('image/png' as const)
        : ('image/jpeg' as const);
    return { data, mediaType };
  } catch {
    /* photo unavailable — classify from the name alone */
    return null;
  }
}

/**
 * The model's guess for one lot of THIS truck.
 *
 * It took a lot id alone, so anybody holding the permission could name any
 * lot in the company: its photo was read and sent to the model, and the AI
 * budget paid for it. Now the truck's card door is asked (its two ends,
 * `mayOpenBatchCard`), and the lot must have a carton that is a member of the
 * truck by the invoice's own rule (`batchMemberFilter`) — both before the
 * photo is touched. A truck that is not there answers like one the person may
 * not open, so the refusal says nothing about which ids exist.
 */
export async function suggestTnvedForLotAction(
  batchId: string,
  lotId: string,
): Promise<Suggested> {
  const actor = await vedActor();
  if (!actor) return { ok: false, error: 'forbidden' };
  // A malformed id is a forged post: «forbidden», never a 22P02 error page.
  if (!isUuidShaped(batchId) || !isUuidShaped(lotId)) return { ok: false, error: 'forbidden' };
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true },
  });
  if (!batch || !mayOpenBatchCard(actor, batch)) return { ok: false, error: 'forbidden' };
  const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lotId) });
  if (!lot) return { ok: false, error: 'not_found' };
  const [aboard] = await db
    .select({ id: boxes.id })
    .from(boxes)
    .where(and(eq(boxes.lotId, lotId), batchMemberFilter(batchId)))
    .limit(1);
  if (!aboard) return { ok: false, error: 'forbidden' };

  // Counted BEFORE anything is spent (docs/TARKIB-TAKLIFLAR.md §2): a keyless
  // server writes no ledger row, and a press over the day's limit reads no
  // photograph and asks no model.
  if (!aiConfigured()) return { ok: false, error: 'ai_not_configured' };
  const pass = await reservePress({ kind: 'tnved', staffId: actor.id, lotId, batchId });
  if (!pass.ok) return { ok: false, error: pass.error, today: await aiToday(actor) };

  let answer: Suggested;
  let usage: AiUsage | undefined;
  let outcome: PressOutcome = 'no_answer';
  try {
    const photo = await firstLotPhoto(lotId);
    const { usage: spent, ...suggestion } = await suggestTnved({
      nameZh: lot.productNameZh,
      nameRu: lot.productNameRu,
      photo,
    });
    usage = spent;
    outcome = 'ok';
    answer = { ok: true, suggestion };
  } catch (err) {
    if (!(err instanceof TnvedError)) {
      await settlePress(pass.id, { outcome: 'no_answer' });
      throw err;
    }
    // An answer that was no good was still paid for; no answer at all was not.
    usage = err.usage;
    outcome = err.usage ? 'failed' : 'no_answer';
    answer = { ok: false, error: err.code };
  }
  await settlePress(pass.id, { outcome, usage });
  return { ...answer, today: await aiToday(actor) };
}

/**
 * The model's guess for one LINE of a lot tarkibi on THIS truck (the owner's
 * item 5, 2026-11-10 — «tarkibga bo'lingan bo'lsa tenved qo'ya olmayapti»;
 * docs/TARKIB-TUZATISH.md §5). It reverses the lot tarkibi round's «a line
 * has no 🤖»: that rule was about the PHOTOGRAPH (a keyboard carton steering
 * the mouse's code), and `lineQuestion` answers it by sending the photo only
 * when every carton of the lot is that one good.
 *
 * By line ID, never by seq: a save on the prixod card replaces every line,
 * so a seq may name another good by the time the press arrives.
 *
 * Every door BEFORE any spend — the model is never paid for a code that
 * could not be saved: the tab's audience and the composition's writer, the
 * truck's card door, a carton of the lot riding this truck, a live (not
 * frozen) composition that still holds the line, then the save's own door
 * (`compositionDoor` — the prixod readable and confirmed) — and only then is
 * the press counted against the day (`reservePress`). It writes nothing
 * about the CODE: that is the editor's state until «Saqlash», which posts it
 * through `saveLineCodesAction` — onto the line, never into the memory. The
 * one thing it writes is its own bill line, through `calc/ai-press.ts`.
 *
 * `photo` tells the editor whether the answer came from the name alone.
 */
export async function suggestTnvedForLineAction(
  batchId: string,
  lotId: string,
  lineId: string,
): Promise<Suggested & { photo?: boolean }> {
  const actor = await vedActor();
  if (!actor || !mayWriteComposition(actor.permissions)) return { ok: false, error: 'forbidden' };
  if (!isUuidShaped(batchId) || !isUuidShaped(lotId) || !isUuidShaped(lineId)) {
    return { ok: false, error: 'forbidden' };
  }
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true },
  });
  if (!batch || !mayOpenBatchCard(actor, batch)) return { ok: false, error: 'forbidden' };
  const [aboard] = await db
    .select({ id: boxes.id })
    .from(boxes)
    .where(and(eq(boxes.lotId, lotId), batchMemberFilter(batchId)))
    .limit(1);
  if (!aboard) return { ok: false, error: 'forbidden' };

  const comp = (await paperCompositionsFor(batchId, [lotId])).get(lotId);
  if (!comp) return { ok: false, error: 'composition_changed' };
  // A ticked truck prints its frozen copy: a code suggested for it could
  // never be saved (`saveLineCodesAction` answers the same word).
  if (comp.frozen) return { ok: false, error: 'frozen' };
  const line = comp.lines.find((l) => l.id === lineId);
  if (!line) return { ok: false, error: 'composition_changed' };
  let door: Awaited<ReturnType<typeof compositionDoor>>;
  try {
    door = await compositionDoor(actor, lotId, { requireConfirmed: true });
  } catch (err) {
    if (err instanceof CompositionError) return { ok: false, error: err.code };
    throw err;
  }

  const question = lineQuestion({
    lot: { zh: door.lot.productNameZh, ru: door.lot.productNameRu },
    line,
    siblings: comp.lines
      .filter((l) => l.id !== lineId)
      .sort((a, b) => a.seq - b.seq)
      .map((l) => l.name),
  });
  // Counted before the photograph is read, as on the lot row (§2).
  if (!aiConfigured()) return { ok: false, error: 'ai_not_configured' };
  const pass = await reservePress({ kind: 'tnved', staffId: actor.id, lotId, batchId });
  if (!pass.ok) return { ok: false, error: pass.error, today: await aiToday(actor) };

  let answer: Suggested & { photo?: boolean };
  let usage: AiUsage | undefined;
  let outcome: PressOutcome = 'no_answer';
  try {
    const photo = question.wantsPhoto ? await firstLotPhoto(lotId) : null;
    const { usage: spent, ...suggestion } = await suggestTnved({
      nameZh: question.nameZh,
      nameRu: question.nameRu,
      photo,
      context: question.context,
    });
    usage = spent;
    outcome = 'ok';
    answer = { ok: true, suggestion, photo: photo !== null };
  } catch (err) {
    if (!(err instanceof TnvedError)) {
      await settlePress(pass.id, { outcome: 'no_answer' });
      throw err;
    }
    usage = err.usage;
    outcome = err.usage ? 'failed' : 'no_answer';
    answer = { ok: false, error: err.code };
  }
  await settlePress(pass.id, { outcome, usage });
  return { ...answer, today: await aiToday(actor) };
}

/**
 * Save codes into the shared memory — PRODUCT rows of THIS truck only.
 *
 * It took a list of names alone and asked no truck door at all, so any
 * holder of the permission could write any name into the company-wide
 * memory (the lot tarkibi judge's Access-5). Now the truck's card door is
 * asked, `departed` is derived from the truck row, and a name that is not a
 * product row of `batchTnvedProducts` on this truck is refused
 * `not_on_truck` — which is also what makes «a composition line's code never
 * writes the memory» a server rule and not a promise of the editor (#531).
 *
 * Refused means NEVER WRITTEN, and since the review of the built round
 * (2026-11-10) it no longer means «and neither is anything else»: the names
 * that ARE product rows are saved and the others come back in `gone`. One
 * product a colleague had composed meanwhile (its row is a tarkib's lines
 * now) used to refuse every other code on the screen, and the reload the
 * screen then offered dropped them. Every code is validated BEFORE the first
 * write, so a wrong code is still all-or-nothing: the loop writes row by
 * row, and an invalid code at row k left the rows above it in the memory
 * while the screen was told nothing had been saved.
 */
export async function saveTnvedAction(
  batchId: string,
  entries: {
    nameZh: string;
    nameRu: string | null;
    code: string;
    source: 'manual' | 'ai';
    aiReasoning?: string | null;
  }[],
): Promise<{ ok: boolean; saved?: number; error?: string; gone?: string[] }> {
  const actor = await vedActor();
  if (!actor) return { ok: false, error: 'forbidden' };
  if (!isUuidShaped(batchId)) return { ok: false, error: 'forbidden' };
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true, departedAt: true },
  });
  if (!batch || !mayOpenBatchCard(actor, batch)) return { ok: false, error: 'forbidden' };
  const posted = entries.filter((entry) => entry.code.trim());
  if (posted.some((entry) => !isValidTnved(entry.code.trim()))) return { ok: false, error: 'invalid_code' };
  const products = await batchTnvedProducts(batchId, batch.departedAt !== null);
  const productKeys = new Set(products.filter((row) => !row.line).map((row) => productKey(row.nameZh)));
  const onTruck = (entry: { nameZh: string }) => productKeys.has(productKey(entry.nameZh));
  const gone = posted.filter((entry) => !onTruck(entry)).map((entry) => entry.nameZh);
  const meta = await requestMeta();
  let saved = 0;
  try {
    for (const entry of posted.filter(onTruck)) {
      await saveTnved(entry, { actorId: actor.id, ...meta });
      saved += 1;
    }
  } catch (err) {
    if (err instanceof TnvedError) return { ok: false, saved, error: err.code };
    throw err;
  }
  return gone.length > 0 ? { ok: false, saved, error: 'not_on_truck', gone } : { ok: true, saved };
}

/**
 * The Bojxona tab's codes for composition LINES (lot tarkibi §5): stored on
 * the line, never in the memory. The truck's card door, the composition's
 * writer, and every lot must have a carton that is a member of THIS truck. A
 * ticked truck prints its frozen copy, so its line codes are read-only here
 * (`frozen`). Entries are GROUPED per lot into ONE `setLineCodes` call each —
 * two calls for one lot would refuse the second by the first's revision bump
 * — and the revisions of the lots that DID commit travel with the answer, so
 * the editor never keeps posting dead ones. No revalidatePath: the editor
 * refreshes after both saves (#1242).
 *
 * Each lot is its own transaction, and a refused lot does not stop the lots
 * after it (the review of the built round): lot B's tarkib re-saved under
 * the screen used to leave C and D unsaved however often «Saqlash» was
 * pressed — B was posted first again, refused again, and the action returned.
 * `error` is the FIRST refusal and `refused` names every lot that did not
 * commit. Only a schema one migration behind ends the loop: every lot would
 * answer the same.
 */
export async function saveLineCodesAction(
  batchId: string,
  entries: { lotId: string; lineId: string; rev: number; code: string }[],
): Promise<{ ok: boolean; revs: Record<string, number>; saved?: number; error?: string; refused?: string[] }> {
  const revs: Record<string, number> = {};
  const actor = await vedActor();
  if (!actor || !mayWriteComposition(actor.permissions)) return { ok: false, revs, error: 'forbidden' };
  // Every id is bound into a uuid comparison below: a malformed one is a
  // forged post and answers «forbidden», never a 22P02 error page.
  if (!isUuidShaped(batchId) || entries.some((e) => !isUuidShaped(e.lotId) || !isUuidShaped(e.lineId))) {
    return { ok: false, revs, error: 'forbidden' };
  }
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId),
    columns: { originWarehouseId: true, destWarehouseId: true },
  });
  if (!batch || !mayOpenBatchCard(actor, batch)) return { ok: false, revs, error: 'forbidden' };
  const byLot = new Map<string, { rev: number; codes: { lineId: string; code: string }[] }>();
  for (const entry of entries) {
    const group = byLot.get(entry.lotId) ?? { rev: entry.rev, codes: [] };
    group.codes.push({ lineId: entry.lineId, code: entry.code });
    byLot.set(entry.lotId, group);
  }
  for (const lotId of byLot.keys()) {
    const [aboard] = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(and(eq(boxes.lotId, lotId), batchMemberFilter(batchId)))
      .limit(1);
    if (!aboard) return { ok: false, revs, error: 'forbidden' };
  }
  const papers = await paperCompositionsFor(batchId, [...byLot.keys()]);
  if ([...papers.values()].some((comp) => comp.frozen)) return { ok: false, revs, error: 'frozen' };
  const meta = await requestMeta();
  let saved = 0;
  let error: string | undefined;
  const refused: string[] = [];
  for (const [lotId, group] of byLot) {
    try {
      const res = await setLineCodes({ lotId, seenRev: group.rev, codes: group.codes }, actor, {
        actorId: actor.id,
        ...meta,
      });
      revs[lotId] = res.rev;
      saved += group.codes.length;
    } catch (err) {
      const code =
        err instanceof CompositionError
          ? err.code
          : isBusyError(err)
            ? 'busy'
            : isServerBehind(err)
              ? 'server_behind'
              : null;
      if (code === null) throw err;
      error ??= code;
      refused.push(lotId);
      if (code === 'server_behind') break;
    }
  }
  return error ? { ok: false, revs, saved, error, refused } : { ok: true, revs, saved };
}
