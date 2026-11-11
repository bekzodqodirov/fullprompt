import { count, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { attachments, receiptLots } from '../../platform/db/schema';
import { aiConfigured } from '../../platform/ai/model';
import { isUuidShaped } from '../../platform/audit/fields';
import { readWithin } from '../../platform/files/read-within';
import { getStorage } from '../../platform/files/storage';
import { logger } from '../../platform/logger';
import { pressLimit, pressToday, reservePress, settlePress, type PressOutcome, type PressToday } from '../calc/ai-press';
import { companyMoneySight } from '../finance/scope';
import { CompositionError, compositionDoor, isPaperDocument, type CompositionActor } from './lot-composition';
import { kindOfAttachment, prepareFile } from './tarkib-file';
import { buildProposal, type TarkibProposal } from './tarkib-proposal';
import { readTarkibDocument, type ReadResult } from './tarkib-read-ai';

/**
 * «🤖 Fayldan to'ldirish» — one pressed reading, door to answer
 * (docs/TARKIB-TAKLIFLAR.md §3; the owner, 2026-11-11: «Tarkibni mijozning
 * packing-list fayli yoki rasmidan AI o'qib to'ldirsin»).
 *
 * The person has chosen a document on the prixod in the tarkib editor and
 * pressed the button; this reads THAT file with the model and answers with a
 * proposal — rows for a dialog, nothing else. It is NEVER A WRITER: no
 * composition, no TNVED memory, no audit row. What it writes is its own bill
 * line, through `calc/ai-press.ts`, and what becomes of the rows is the
 * person's «Saqlash», which runs the editor's own validation unchanged.
 *
 * EVERY DOOR BEFORE ANY SPEND, in this order — each a refusal in a code the
 * editor has words for, and each BEFORE the one that costs more:
 *
 *   1. the save's own door (`compositionDoor`: the tarkib's writer, the
 *      prixod readable and confirmed) — a reading nobody could save is not
 *      paid for;
 *   2. the file is a paper of THIS lot's prixod (never a posted receipt id),
 *      and not a receive-time carton photo — the save's two document rules;
 *   3. its kind and size, from the ROW — a video is never loaded;
 *   4. a key on the server (`ai_not_configured` — and no ledger row), and
 *      the feature not switched off (`ai_off`: reading one setting costs less
 *      than fifteen megabytes from storage);
 *   5. the document is not cooling off after a reading that ran out of time
 *      or of room;
 *   6. the bytes, and the file made ready for the model — a workbook that is
 *      empty, encrypted or broken spends nothing;
 *   7. one of the day's readings (`reservePress`) — then the model — then the
 *      row is settled, whatever happened: with what the model said, or
 *      «no answer» when something of ours threw before it could (the reader
 *      itself never throws, and `settlePress` never does either — a ledger
 *      that cannot be written must not cost the reading it was measuring).
 */

/**
 * Every code a reading can answer. The union is DERIVED from this list, and
 * each sub-module's own codes are assigned into it below — so a code added
 * anywhere is a compile error here until it is listed, and
 * `tests/unit/tarkib-read-wire.test.ts` holds the list against the editor's
 * words: a code with no sentence would read «Ma'lumot to'liq emas».
 */
export const TARKIB_READ_ERRORS = [
  // The save's own doors, in the save's own codes.
  'forbidden',
  'receipt_not_confirmed',
  'document_not_on_receipt',
  'document_is_photo',
  // The file.
  'read_unsupported',
  'read_too_large',
  'read_broken',
  'read_old_format',
  'read_encrypted',
  'read_empty',
  'file_unavailable',
  // Before the ledger.
  'ai_not_configured',
  'cooling',
  // The ledger (`reservePress`).
  'ai_off',
  'ai_limit',
  'server_behind',
  'failed',
  // The model.
  'ai_refused',
  'ai_truncated',
  'ai_failed',
  'ai_timeout',
  'ai_rejected',
  'read_no_goods',
] as const;
export type TarkibReadError = (typeof TARKIB_READ_ERRORS)[number];

export type TarkibReadAnswer =
  | { ok: true; proposal: TarkibProposal; today?: PressToday }
  | {
      ok: false;
      error: TarkibReadError;
      /** `read_no_goods`: the model's own sentence about what the document is. */
      detail?: string;
      today?: PressToday;
    };

/**
 * How long storage may take to hand over the file before the reading is given
 * up. Part of the SERVER's whole budget for one press — this, the file's
 * preparation, then the model's leash (`READ_LEASH_MS`) — which the browser
 * must outwait (`READ_DEADLINE_MS`; `tarkib-read-wire.test.ts` holds the
 * three numbers against each other): an answer that arrives after the
 * browser gave up is a paid reading delivered to nobody, with «press again»
 * on the screen.
 */
export const FILE_READ_MS = 10_000;

/**
 * Ten minutes during which a document whose reading ran out of time
 * (`ai_timeout`) or of room (`ai_truncated`) is not read again.
 *
 * Both mean «this document is too much for one reading», and neither changes
 * by pressing again: the same pages would run the same minute and a half and
 * spend another of the day's readings. The refusal says what does help —
 * fewer pages, or the spreadsheet. In memory, per process: a deploy forgets
 * it, which costs one more reading and nothing else.
 */
export const COOLING_MS = 10 * 60_000;

export class ReadCooling {
  private readonly until = new Map<string, number>();

  constructor(private readonly ms: number = COOLING_MS) {}

  start(id: string, now: number = Date.now()): void {
    // Swept on the way in, so the map holds only documents still cooling.
    for (const [key, until] of this.until) if (until <= now) this.until.delete(key);
    this.until.set(id, now + this.ms);
  }

  /** Milliseconds until the document may be read again; 0 = now. */
  left(id: string, now: number = Date.now()): number {
    const until = this.until.get(id);
    if (until === undefined) return 0;
    if (until > now) return until - now;
    this.until.delete(id);
    return 0;
  }
}

const cooling = new ReadCooling();

/** Who presses: the composition's writer, with what the money line needs. */
export type TarkibReader = CompositionActor & { permissions: Set<string> };

/**
 * Today's count beside the answer — and, only for a reader of the company's
 * money, what the answered readings cost. Undefined when the ledger cannot
 * be read: no line is drawn.
 */
async function readingsToday(actor: TarkibReader): Promise<PressToday | undefined> {
  return pressToday('tarkib', companyMoneySight(actor)).catch(() => undefined);
}

export async function readTarkibFile(
  actor: TarkibReader,
  input: { lotId: unknown; attachmentId: unknown },
): Promise<TarkibReadAnswer> {
  const { lotId, attachmentId } = input;
  // A malformed id is a forged post: «forbidden», never a 22P02 error page.
  if (!isUuidShaped(lotId) || !isUuidShaped(attachmentId)) return { ok: false, error: 'forbidden' };

  let door: Awaited<ReturnType<typeof compositionDoor>>;
  try {
    door = await compositionDoor(actor, lotId, { requireConfirmed: true });
  } catch (err) {
    if (!(err instanceof CompositionError)) throw err;
    return { ok: false, error: err.code === 'receipt_not_confirmed' ? 'receipt_not_confirmed' : 'forbidden' };
  }

  // The save's two document rules, asked of the LOT's own prixod: a file of
  // another prixod — or of a truck — answers exactly like one that is not
  // there, so the refusal says nothing about which ids exist.
  const [file] = await db
    .select({
      id: attachments.id,
      entityType: attachments.entityType,
      entityId: attachments.entityId,
      kind: attachments.kind,
      storageKey: attachments.storageKey,
      fileName: attachments.fileName,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  if (!file || file.entityType !== 'receipt' || file.entityId !== door.lot.receiptId) {
    return { ok: false, error: 'document_not_on_receipt' };
  }
  if (!isPaperDocument(file, door.receipt)) return { ok: false, error: 'document_is_photo' };

  // From the row alone: a sixty-megabyte video is refused here, unread.
  const kind = kindOfAttachment(file);
  if (!kind.ok) return { ok: false, error: kind.error };

  // A keyless server says so before the ledger: nothing counted, nothing read.
  if (!aiConfigured()) return { ok: false, error: 'ai_not_configured' };
  // Switched off in settings (limit 0): said HERE, before the bytes — the
  // reservation below would say it too, but only after the file had been
  // loaded and a workbook parsed for a press that could never run.
  if ((await pressLimit('tarkib')) <= 0) return { ok: false, error: 'ai_off', today: await readingsToday(actor) };
  if (cooling.left(file.id) > 0) return { ok: false, error: 'cooling' };

  let body: Buffer;
  try {
    body = await readWithin(getStorage().get(file.storageKey), FILE_READ_MS);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), attachmentId: file.id }, '[tarkib-read] file not readable');
    return { ok: false, error: 'file_unavailable' };
  }
  const prepared = await prepareFile(kind.kind, body, file);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  // A fact of the PRIXOD, not of the reading — read before the press is
  // reserved, so nothing of ours stands between the model's answer and the
  // person: a packing list covers the shipment and a tarkib is one lot's, and
  // with more than one lot the dialog ticks nothing to begin with.
  const [lots] = await db.select({ n: count() }).from(receiptLots).where(eq(receiptLots.receiptId, door.lot.receiptId));

  // Counted BEFORE it spends: at the day's limit the model is never asked.
  const pass = await reservePress({ kind: 'tarkib', staffId: actor.id, lotId, batchId: null });
  if (!pass.ok) return { ok: false, error: pass.error, today: await readingsToday(actor) };

  // Settled whatever happens: a throw between the reservation and the answer
  // must not leave the row `reserved` with nobody to close it. The reader
  // itself never throws — if something of ours does, nothing came back and
  // nothing is counted.
  let read: ReadResult;
  try {
    read = await readTarkibDocument(prepared.file, { fileName: file.fileName });
  } catch (err) {
    await settlePress(pass.id, { outcome: 'no_answer' });
    throw err;
  }
  const outcome: PressOutcome = read.ok ? 'ok' : read.outcome;
  await settlePress(pass.id, { outcome, usage: read.usage });

  if (!read.ok) {
    if (read.code === 'ai_timeout' || read.code === 'ai_truncated') cooling.start(file.id);
    return { ok: false, error: read.code, today: await readingsToday(actor) };
  }

  const cut = prepared.file.kind === 'sheet' ? prepared.file : { rowsCut: false, cellsCut: false };
  const built = buildProposal(read.answer, { rowsCut: cut.rowsCut, cellsCut: cut.cellsCut });
  // The model answered, and the answer is «there is no goods table here» —
  // paid for and said, with its own sentence about what the paper is.
  if (built.rows.length === 0) {
    return { ok: false, error: 'read_no_goods', detail: built.notes ?? undefined, today: await readingsToday(actor) };
  }
  return {
    ok: true,
    proposal: { ...built, lotsOnReceipt: Number(lots?.n ?? 1) },
    today: await readingsToday(actor),
  };
}
