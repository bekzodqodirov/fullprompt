import { createHash } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { lotCompositionLines, receiptLots, receipts } from '../../platform/db/schema';
import { isServerBehind } from '../../platform/db/errors';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import type { ScopedActor } from '../../platform/rbac/scope';
import { mayOpenBatchVed } from '../batches/card-door';
import { crossesBorderSql } from '../batches/internal';
import { batchMemberFilter } from '../scanning/unload';
import {
  checkSums,
  fromUnits,
  KG_SCALE,
  M3_SCALE,
  MAX_LINES,
  MIN_LINES,
  parseDraft,
  storedUnits,
  truckSegments,
  type DraftLine,
  type MeasureField,
  type Segment,
  type StoredLine,
} from './composition-math';
import { lockReceiptShareNoWait } from './grow-lot';
import { mayReadReceipt } from './read-door';

/**
 * Lot tarkibi — the ONE writer and the ONE reader of the composition tables
 * (docs/LOT-TARKIBI.md §3). The owner's case and answers: a lot of 100
 * cartons received as «klaviatura» is, on the client's papers, 50 keyboards +
 * 50 mice. The warehouse cannot re-sticker (his 6) and cannot tell the
 * cartons apart (2c), so the lot keeps its body; the VED or the logist states
 * a composition AGAINST A DOCUMENT on the prixod, and only the customs papers
 * and the agent file read it.
 *
 * Apart from this module the lines table is read by the price history's own
 * CTE and by `tnvedHintsFor` (raw SQL, read-only), and the frozen copy is
 * written by the «hujjat yuborildi» tick through `freezeCompositionsInTx` /
 * `thawCompositionsInTx` below.
 */

export type CompositionRefusalCode =
  | 'forbidden'
  | 'receipt_not_confirmed'
  | 'lines_count'
  | 'bad_line'
  | 'bad_number'
  | 'bad_tnved'
  | 'duplicate_name'
  | 'cartons_partial'
  | 'cartons_sum'
  | 'kg_sum'
  | 'm3_sum'
  | 'document_required'
  | 'document_not_on_receipt'
  | 'document_is_photo'
  | 'lot_changed'
  | 'composition_changed';

export class CompositionError extends Error {
  constructor(
    public readonly code: CompositionRefusalCode,
    public readonly seq?: number,
    public readonly field?: MeasureField,
    public readonly sums?: { sum: string; lot: string },
    /** `composition_changed` because the SAME person saved a moment ago (a double tap). */
    public readonly bySelf?: boolean,
  ) {
    super(code);
  }
}

type Grants = { has(code: string): boolean };

/** Who writes: the person and the scope this module asks about. */
export type CompositionActor = ScopedActor & { id: string; permissions: Grants };

/**
 * The Bojxona tab's audience is the composition's writer — one rule
 * (`ved.docs ∨ plans.manage`). `receipts.edit` is NOT widened: the warehouse
 * that cannot re-sticker does not state a customs composition either.
 */
export function mayWriteComposition(permissions: Grants): boolean {
  return mayOpenBatchVed(permissions);
}

/**
 * A paper document, not a carton photo (the judge's decision 3): a non-photo
 * file, or anything uploaded after the prixod was confirmed. Every prixod
 * received with a general photo already carries the warehouse's CARTON
 * photos as `'receipt'` attachments, so «any file on the prixod» let a
 * keyboard-carton photo stand in for the client's packing list. The editor's
 * chips and the save ask this one predicate.
 */
export function isPaperDocument(
  att: { kind: string; createdAt: Date },
  receipt: { confirmedAt: Date | null; createdAt: Date },
): boolean {
  return att.kind === 'file' || att.createdAt.getTime() > (receipt.confirmedAt ?? receipt.createdAt).getTime();
}

/**
 * The door, asked on the POOL before any transaction (`mayReadReceipt`
 * reads the pool — tests/unit/tx-pool.test.ts). A missing lot or receipt
 * answers `forbidden` exactly like an unreadable one, so a refusal says
 * nothing about which ids exist. `requireConfirmed` false is the clear's door
 * only: a composition on a prixod voided after the save must stay clearable,
 * or its document is undeletable for ever.
 */
export async function compositionDoor(
  actor: CompositionActor,
  lotId: string,
  opts: { requireConfirmed: boolean },
): Promise<{ lot: typeof receiptLots.$inferSelect; receipt: typeof receipts.$inferSelect }> {
  if (!mayWriteComposition(actor.permissions)) throw new CompositionError('forbidden');
  if (!UUID.test(lotId)) throw new CompositionError('forbidden');
  const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lotId) });
  if (!lot) throw new CompositionError('forbidden');
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, lot.receiptId) });
  if (!receipt) throw new CompositionError('forbidden');
  if (!(await mayReadReceipt(actor, { id: receipt.id, warehouseId: receipt.warehouseId }))) {
    throw new CompositionError('forbidden');
  }
  if (opts.requireConfirmed && receipt.status !== 'confirmed') throw new CompositionError('receipt_not_confirmed');
  return { lot, receipt };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const draftLineSchema = z.object({
  name: z.string().max(400),
  pieces: z.string().max(40),
  cartons: z.string().max(40),
  kg: z.string().max(40),
  m3: z.string().max(40),
  tnved: z.string().max(40),
});

export const compositionInputSchema = z.object({
  lotId: z.string().uuid(),
  /** 0 = «there was none on my screen». */
  seenRev: z.number().int().min(0),
  seenBoxCount: z.number().int().positive(),
  /** The lot's totals as the editor rendered them. */
  seenKg: z.string().max(40),
  seenM3: z.string().max(40),
  attachmentId: z.string().uuid().nullable(),
  /** Raw strings, blank rows included; `parseDraft` decides. */
  lines: z.array(draftLineSchema).max(MAX_LINES),
});
export type CompositionInput = z.infer<typeof compositionInputSchema>;

/** A refusal of the pure parse, as the service's error. */
function refusalError(r: NonNullable<ReturnType<typeof checkSums>>): CompositionError {
  switch (r.code) {
    case 'lines_count':
    case 'cartons_partial':
      return new CompositionError(r.code);
    case 'bad_line':
    case 'bad_tnved':
    case 'duplicate_name':
      return new CompositionError(r.code, r.seq);
    case 'bad_number':
      return new CompositionError(r.code, r.seq, r.field);
    case 'cartons_sum':
      return new CompositionError(r.code, undefined, undefined, { sum: String(r.sum), lot: String(r.lot) });
    case 'kg_sum':
    case 'm3_sum':
      return new CompositionError(r.code, undefined, undefined, { sum: r.sum, lot: r.lot });
  }
}

/** One line of the audit's summary — «, » inside, the History's « · » outside. */
function summaryLine(l: StoredLine): string {
  const parts = [
    l.cartons !== null ? `${l.cartons} kar` : null,
    l.pieces !== null ? `${l.pieces} шт` : null,
    `${l.kg} kg`,
    `${l.m3} m³`,
    l.tnvedCode,
  ].filter((p): p is string => p !== null);
  return `${l.name} — ${parts.join(', ')}`;
}

function compositionSummary(lot: { id: string; letter: string | null }, view: CompositionView) {
  return {
    lotId: lot.id,
    letter: lot.letter,
    lines: view.lines.map(summaryLine),
    document: view.attachment.fileName,
    attachmentId: view.attachment.id,
  };
}

/** `SET LOCAL lock_timeout` — the count doors' idiom, a shorter wait. */
async function compositionLockTimeout(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
}

interface LockedLot {
  id: string;
  receipt_id: string;
  letter: string | null;
  box_count: number;
  kg: string;
  m3: string;
}

/**
 * The lot, FOR NO KEY UPDATE: a plan line's FK insert referencing the lot is
 * not blocked, while editLot, the count doors and a second save (all FOR
 * UPDATE) serialise against it.
 */
async function lockCompositionLot(tx: Tx, lotId: string): Promise<LockedLot> {
  const rows = (await tx.execute(sql`
    SELECT id, receipt_id, letter, box_count, total_weight_kg::text AS kg, total_volume_m3::text AS m3
      FROM receipt_lots WHERE id = ${lotId}::uuid FOR NO KEY UPDATE
  `)) as unknown as LockedLot[];
  const lot = rows[0];
  if (!lot) throw new CompositionError('forbidden');
  return { ...lot, box_count: Number(lot.box_count) };
}

/** The header row, FOR UPDATE — the compare-and-set of the revision token. */
async function lockCompositionHeader(
  tx: Tx,
  lotId: string,
  seenRev: number,
  actorId: string,
): Promise<{ rev: number } | null> {
  const rows = (await tx.execute(sql`
    SELECT rev, saved_by FROM lot_compositions WHERE lot_id = ${lotId}::uuid FOR UPDATE
  `)) as unknown as { rev: string | number; saved_by: string }[];
  const row = rows[0];
  if (!row) {
    if (seenRev !== 0) throw new CompositionError('composition_changed');
    return null;
  }
  const rev = Number(row.rev);
  if (rev !== seenRev) {
    throw new CompositionError('composition_changed', undefined, undefined, undefined, row.saved_by === actorId);
  }
  return { rev };
}

/**
 * Save (or replace) a lot's composition. On the pool: the shape, the door,
 * the parse, the document's presence. In ONE transaction, in this lock order
 * — lot (NO KEY UPDATE) → prixod (SHARE NOWAIT) → document (KEY SHARE) →
 * header (UPDATE) — the compare-and-sets and the sums against the LOCKED
 * totals, then the write and the audit. No composition write locks a truck
 * row, so the count door's «lot, then truck» meets nothing here.
 */
export async function saveComposition(
  input: unknown,
  actor: CompositionActor,
  ctx: AuditContext,
): Promise<{ rev: number }> {
  const parsedInput = compositionInputSchema.parse(input);
  const { receipt } = await compositionDoor(actor, parsedInput.lotId, { requireConfirmed: true });
  const parsed = parseDraft(parsedInput.lines as DraftLine[]);
  if (!parsed.ok) throw refusalError(parsed.refusal);
  if (!parsedInput.attachmentId) throw new CompositionError('document_required');
  const attachmentId = parsedInput.attachmentId;

  return db.transaction(async (tx) => {
    await compositionLockTimeout(tx);
    // 5. The lot, compared with what the editor rendered.
    const lot = await lockCompositionLot(tx, parsedInput.lotId);
    if (
      lot.box_count !== parsedInput.seenBoxCount ||
      storedUnits(lot.kg, KG_SCALE) !== storedUnits(parsedInput.seenKg, KG_SCALE) ||
      storedUnits(lot.m3, M3_SCALE) !== storedUnits(parsedInput.seenM3, M3_SCALE)
    ) {
      throw new CompositionError('lot_changed');
    }
    // 6. The prixod: a void or an annul in flight answers «busy» at once
    //    (NOWAIT, 55P03), and one that landed a moment ago is seen.
    await lockReceiptShareNoWait(tx, lot.receipt_id);
    const [current] = (await tx.execute(sql`
      SELECT status, confirmed_at::text AS confirmed_at, created_at::text AS created_at
        FROM receipts WHERE id = ${lot.receipt_id}::uuid
    `)) as unknown as { status: string; confirmed_at: string | null; created_at: string }[];
    if (!current || current.status !== 'confirmed') throw new CompositionError('receipt_not_confirmed');
    // 7. The document, FOR KEY SHARE: a concurrent deleteAttachment waits for
    //    this commit and then answers `in_use` — a plain SELECT let it slip
    //    between this check and the FK insert (an unmapped 23503).
    const [doc] = (await tx.execute(sql`
      SELECT entity_type, entity_id, kind, created_at::text AS created_at, file_name
        FROM attachments WHERE id = ${attachmentId}::uuid FOR KEY SHARE
    `)) as unknown as { entity_type: string; entity_id: string; kind: string; created_at: string; file_name: string }[];
    if (!doc || doc.entity_type !== 'receipt' || doc.entity_id !== lot.receipt_id) {
      throw new CompositionError('document_not_on_receipt');
    }
    if (
      !isPaperDocument(
        { kind: doc.kind, createdAt: new Date(doc.created_at) },
        {
          confirmedAt: current.confirmed_at ? new Date(current.confirmed_at) : null,
          createdAt: new Date(current.created_at),
        },
      )
    ) {
      throw new CompositionError('document_is_photo');
    }
    // 8. The header: the revision the editor was drawn from.
    const header = await lockCompositionHeader(tx, lot.id, parsedInput.seenRev, actor.id);
    // 9. The sums, against the LOCKED totals.
    const sums = checkSums(parsed.lines, { boxCount: lot.box_count, kg: lot.kg, m3: lot.m3 });
    if (sums) throw refusalError(sums);

    const before = header ? (await compositionsFor([lot.id], tx)).get(lot.id) ?? null : null;
    // 10. A new token on every write — never a counter (ABA).
    const [saved] = (await tx.execute(sql`
      INSERT INTO lot_compositions (lot_id, attachment_id, seen_box_count, saved_by)
      VALUES (${lot.id}::uuid, ${attachmentId}::uuid, ${lot.box_count}, ${actor.id}::uuid)
      ON CONFLICT (lot_id) DO UPDATE SET
        attachment_id = EXCLUDED.attachment_id,
        seen_box_count = EXCLUDED.seen_box_count,
        rev = nextval('lot_composition_rev_seq'),
        saved_by = EXCLUDED.saved_by,
        saved_at = now(),
        updated_at = now()
      RETURNING rev
    `)) as unknown as { rev: string | number }[];
    // 11. The lines, replaced.
    await tx.delete(lotCompositionLines).where(eq(lotCompositionLines.lotId, lot.id));
    if (parsed.lines.length > 0) {
      await tx.insert(lotCompositionLines).values(
        parsed.lines.map((l) => ({
          lotId: lot.id,
          seq: l.seq,
          name: l.name,
          pieces: l.pieces,
          cartons: l.cartons,
          weightKg: fromUnits(l.kgUnits, KG_SCALE),
          volumeM3: fromUnits(l.m3Units, M3_SCALE),
          tnvedCode: l.tnvedCode,
        })),
      );
    }
    // 12. The audit, on the prixod the composition belongs to.
    const after = (await compositionsFor([lot.id], tx)).get(lot.id);
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before: { lotComposition: before ? compositionSummary({ id: lot.id, letter: lot.letter }, before) : null },
      after: { lotComposition: after ? compositionSummary({ id: lot.id, letter: lot.letter }, after) : null },
    });
    return { rev: Number(saved!.rev) };
  });
}

/**
 * Delete a lot's composition (the lines cascade); the papers print the lot
 * as one row again. Allowed on a voided prixod (see `compositionDoor`).
 */
export async function clearComposition(
  input: { lotId: string; seenRev: number },
  actor: CompositionActor,
  ctx: AuditContext,
): Promise<void> {
  const seenRev = Number(input.seenRev);
  if (!Number.isInteger(seenRev) || seenRev < 0) throw new CompositionError('composition_changed');
  const { receipt } = await compositionDoor(actor, input.lotId, { requireConfirmed: false });
  await db.transaction(async (tx) => {
    await compositionLockTimeout(tx);
    const lot = await lockCompositionLot(tx, input.lotId);
    const header = await lockCompositionHeader(tx, lot.id, seenRev, actor.id);
    if (!header) return;
    const before = (await compositionsFor([lot.id], tx)).get(lot.id) ?? null;
    await tx.execute(sql`DELETE FROM lot_compositions WHERE lot_id = ${lot.id}::uuid`);
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before: { lotComposition: before ? compositionSummary({ id: lot.id, letter: lot.letter }, before) : null },
      after: { lotComposition: null },
    });
  });
}

/** A TNVED code as typed on the Bojxona tab: '' clears, else 4-10 digits. */
function lineCodeOf(raw: string): string | null | undefined {
  const s = String(raw ?? '').replace(/[\s  .-]/g, '');
  if (s === '') return null;
  return /^\d{4,10}$/.test(s) ? s : undefined;
}

/**
 * The Bojxona tab's per-line codes for ONE lot, in ONE transaction ('' clears).
 * Never writes `tnved_assignments`: a line has no memory key (its name is a
 * person's Russian, not the lot's Chinese), and the memory answers for every
 * future truck of a product.
 */
export async function setLineCodes(
  input: { lotId: string; seenRev: number; codes: { lineId: string; code: string }[] },
  actor: CompositionActor,
  ctx: AuditContext,
): Promise<{ rev: number }> {
  const seenRev = Number(input.seenRev);
  if (!Number.isInteger(seenRev) || seenRev < 1) throw new CompositionError('composition_changed');
  const codes = input.codes.map((c) => {
    if (!UUID.test(c.lineId)) throw new CompositionError('composition_changed');
    const code = lineCodeOf(c.code);
    if (code === undefined) throw new CompositionError('bad_tnved');
    return { lineId: c.lineId, code };
  });
  const { receipt } = await compositionDoor(actor, input.lotId, { requireConfirmed: true });
  return db.transaction(async (tx) => {
    await compositionLockTimeout(tx);
    const header = await lockCompositionHeader(tx, input.lotId, seenRev, actor.id);
    if (!header) throw new CompositionError('composition_changed');
    const beforeCodes: string[] = [];
    const afterCodes: string[] = [];
    for (const c of codes) {
      const [old] = (await tx.execute(sql`
        SELECT name, tnved_code FROM lot_composition_lines
         WHERE id = ${c.lineId}::uuid AND lot_id = ${input.lotId}::uuid
      `)) as unknown as { name: string; tnved_code: string | null }[];
      if (!old) throw new CompositionError('composition_changed');
      if ((old.tnved_code ?? null) === c.code) continue;
      await tx.execute(sql`
        UPDATE lot_composition_lines SET tnved_code = ${c.code}
         WHERE id = ${c.lineId}::uuid AND lot_id = ${input.lotId}::uuid
      `);
      beforeCodes.push(`${old.name}: ${old.tnved_code ?? '∅'}`);
      afterCodes.push(`${old.name}: ${c.code ?? '∅'}`);
    }
    if (afterCodes.length === 0) return { rev: header.rev };
    const [bumped] = (await tx.execute(sql`
      UPDATE lot_compositions SET rev = nextval('lot_composition_rev_seq'), updated_at = now()
       WHERE lot_id = ${input.lotId}::uuid RETURNING rev
    `)) as unknown as { rev: string | number }[];
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before: { lotCompositionCodes: beforeCodes },
      after: { lotCompositionCodes: afterCodes },
    });
    return { rev: Number(bumped!.rev) };
  });
}

export interface CompositionView {
  lotId: string;
  rev: number;
  seenBoxCount: number;
  attachment: { id: string; fileName: string };
  savedBy: string | null;
  savedAt: Date;
  lines: (StoredLine & { id: string })[];
}

/** The lines of a header as ONE json array, ordered by seq — read beside the header. */
const LINES_JSON = sql`
  SELECT json_agg(json_build_object(
           'id', g.id, 'seq', g.seq, 'name', g.name, 'pieces', g.pieces, 'cartons', g.cartons,
           'kg', g.weight_kg::text, 'm3', g.volume_m3::text, 'tnvedCode', g.tnved_code)
         ORDER BY g.seq) AS lines
    FROM lot_composition_lines g`;

type JsonLine = StoredLine & { id?: string };

function jsonLines(raw: unknown): JsonLine[] {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(value)) return [];
  return value.map((l: Record<string, unknown>) => ({
    ...(typeof l.id === 'string' ? { id: l.id } : {}),
    seq: Number(l.seq),
    name: String(l.name),
    pieces: l.pieces === null || l.pieces === undefined ? null : Number(l.pieces),
    cartons: l.cartons === null || l.cartons === undefined ? null : Number(l.cartons),
    kg: String(l.kg),
    m3: String(l.m3),
    tnvedCode: l.tnvedCode === null || l.tnvedCode === undefined ? null : String(l.tnvedCode),
  }));
}

const uuidList = (ids: string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * ONE statement: headers ⋈ attachments ⋈ users ⋈ LATERAL json_agg(lines
 * ORDER BY seq) — two statements could tear (a clear between them gave a
 * header with no lines, which `compositionMode([])` reads as «mixed» and the
 * invoice prints as NO row: the lot vanishes from a customs paper). A view
 * with fewer than 2 lines is treated as no composition and logged. `exec`
 * DEFAULTS to `db` (`= db` in the signature, so the tx-pool fence classifies
 * it and flags an in-transaction call that forgets `tx`). A missing table
 * (the deploy morning, before `migrate`) answers an EMPTY map.
 */
export async function compositionsFor(lotIds: string[], exec: Db | Tx = db): Promise<Map<string, CompositionView>> {
  const out = new Map<string, CompositionView>();
  const ids = [...new Set(lotIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return out;
  let rows: {
    lot_id: string;
    rev: string | number;
    seen_box_count: number;
    attachment_id: string;
    file_name: string;
    saved_by_name: string | null;
    saved_at: string;
    lines: unknown;
  }[];
  try {
    rows = (await exec.execute(sql`
      SELECT lc.lot_id, lc.rev, lc.seen_box_count, lc.attachment_id, a.file_name,
             u.full_name AS saved_by_name, lc.saved_at::text AS saved_at, ln.lines
        FROM lot_compositions lc
        JOIN attachments a ON a.id = lc.attachment_id
        LEFT JOIN users u ON u.id = lc.saved_by
        LEFT JOIN LATERAL (${LINES_JSON} WHERE g.lot_id = lc.lot_id) ln ON true
       WHERE lc.lot_id IN (${uuidList(ids)})
    `)) as unknown as typeof rows;
  } catch (err) {
    if (isServerBehind(err)) {
      console.warn('[lot-composition] server behind', err);
      return out;
    }
    throw err;
  }
  for (const row of rows) {
    const lines = jsonLines(row.lines);
    if (lines.length < MIN_LINES) {
      console.warn(`[lot-composition] lot ${row.lot_id}: ${lines.length} line(s) — read as no composition`);
      continue;
    }
    out.set(row.lot_id, {
      lotId: row.lot_id,
      rev: Number(row.rev),
      seenBoxCount: Number(row.seen_box_count),
      attachment: { id: row.attachment_id, fileName: row.file_name },
      savedBy: row.saved_by_name,
      savedAt: new Date(row.saved_at),
      lines: lines.map((l) => ({ ...l, id: l.id ?? '' })),
    });
  }
  return out;
}

export interface PaperComposition {
  seenBoxCount: number;
  /** `id` only on a LIVE line — a frozen copy has none to address. */
  lines: (StoredLine & { id?: string })[];
  frozen: boolean;
  rev: number;
}

/**
 * What the PAPERS of one truck read: the frozen copy while the truck is
 * ticked «hujjat yuborildi» (a frozen `lines: null` = «no composition» for
 * that truck, so a composition stated later never rewrites a sent truck's
 * invoice), the live composition otherwise and for a lot that boarded after
 * the tick. ONE statement, the live and the frozen read the same instant.
 */
export async function paperCompositionsFor(
  batchId: string,
  lotIds: string[],
  exec: Db | Tx = db,
): Promise<Map<string, PaperComposition>> {
  const out = new Map<string, PaperComposition>();
  const ids = [...new Set(lotIds)].filter((id) => UUID.test(id));
  if (ids.length === 0 || !UUID.test(batchId)) return out;
  let rows: {
    lot_id: string;
    frozen: boolean;
    s_rev: string | number | null;
    s_seen: number | null;
    s_lines: unknown;
    rev: string | number | null;
    seen_box_count: number | null;
    lines: unknown;
  }[];
  try {
    rows = (await exec.execute(sql`
      SELECT ml.lot_id, (s.batch_id IS NOT NULL) AS frozen,
             s.rev AS s_rev, s.seen_box_count AS s_seen, s.lines AS s_lines,
             lc.rev, lc.seen_box_count, ln.lines
        FROM (VALUES ${sql.join(
          ids.map((id) => sql`(${id}::uuid)`),
          sql`, `,
        )}) AS ml(lot_id)
        LEFT JOIN batch_sent_compositions s ON s.batch_id = ${batchId}::uuid AND s.lot_id = ml.lot_id
        LEFT JOIN lot_compositions lc ON lc.lot_id = ml.lot_id
        LEFT JOIN LATERAL (${LINES_JSON} WHERE g.lot_id = lc.lot_id) ln ON lc.lot_id IS NOT NULL
    `)) as unknown as typeof rows;
  } catch (err) {
    if (isServerBehind(err)) {
      console.warn('[lot-composition] server behind', err);
      return out;
    }
    throw err;
  }
  for (const row of rows) {
    if (row.frozen) {
      if (row.s_lines === null || row.s_rev === null) continue;
      const lines = jsonLines(row.s_lines);
      if (lines.length < MIN_LINES) continue;
      out.set(row.lot_id, {
        seenBoxCount: Number(row.s_seen),
        lines,
        frozen: true,
        rev: Number(row.s_rev),
      });
      continue;
    }
    if (row.rev === null) continue;
    const lines = jsonLines(row.lines);
    if (lines.length < MIN_LINES) {
      console.warn(`[lot-composition] lot ${row.lot_id}: ${lines.length} line(s) — read as no composition`);
      continue;
    }
    out.set(row.lot_id, {
      seenBoxCount: Number(row.seen_box_count),
      lines,
      frozen: false,
      rev: Number(row.rev),
    });
  }
  return out;
}

export interface LotTruckRow {
  batchId: string;
  code: string;
  departedAt: string | null;
  createdAt: string;
  crosses: boolean;
  n: number;
  /**
   * The truck holds a frozen copy for THIS lot (a «hujjat yuborildi» tick,
   * or the pre-0122 backfill): its papers print the lot as they were sent,
   * whatever is saved now. Not `batches.sent_to_agent_at` — a lot that
   * boarded after the tick has no copy and reads live on that truck too.
   */
  frozen: boolean;
  /** The positions frozen with the copy (§2); null when none were stored. */
  frozenSegments: Segment[] | null;
}

/** A stored positions array (jsonb) → runs; anything else → null. */
function segmentsOf(raw: unknown): Segment[] | null {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(value)) return null;
  const out: Segment[] = [];
  for (const run of value) {
    if (!Array.isArray(run) || run.length !== 2) return null;
    const [s, e] = run.map(Number);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s! < 0 || e! < s!) return null;
    out.push([s!, e!]);
  }
  return out;
}

/**
 * The lot's trucks — the population of §2's cumulative rule AND the receipt
 * card's «sent» line, one home (#513): per lot, every non-cancelled truck
 * that carries or carried a carton of it (the live pointer UNION the
 * departure movement — `batchMemberFilter`'s two halves restated per LOT, as
 * CTEs, never `x.id IN (SELECT …)` in a join predicate, #152), with its
 * carton count and its frozen copy of THIS lot, if any. `exec` REQUIRED.
 * Empty `lotIds` → empty map, no query. A missing table (the deploy
 * morning, before `migrate`) → empty map on the POOL, as every other reader
 * here; inside a transaction it is rethrown, because the failed statement
 * has aborted the caller's transaction and an empty answer would only move
 * the error to the caller's next statement (the tick falls back on it).
 */
export async function lotTrucksFor(exec: Db | Tx, lotIds: string[]): Promise<Map<string, LotTruckRow[]>> {
  const out = new Map<string, LotTruckRow[]>();
  const ids = [...new Set(lotIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return out;
  const list = uuidList(ids);
  let rows: {
    lot_id: string;
    batch_id: string;
    code: string;
    departed_at: string | null;
    created_at: string;
    crosses: boolean;
    n: number;
    frozen: boolean;
    segments: unknown;
  }[];
  try {
    rows = (await exec.execute(sql`
      WITH member AS (
        SELECT b.lot_id, b.id AS box_id, b.current_batch_id AS batch_id
          FROM boxes b
         WHERE b.lot_id IN (${list}) AND b.current_batch_id IS NOT NULL
        UNION
        SELECT b.lot_id, b.id, m.ref_id
          FROM box_movements m
          JOIN boxes b ON b.id = m.box_id
         WHERE b.lot_id IN (${list}) AND m.ref_type = 'batch' AND m.cause = 'batch_departed'
      )
      SELECT mb.lot_id, t.id AS batch_id, t.code,
             to_char(t.departed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS departed_at,
             to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
             ${crossesBorderSql('o', 'd')} AS crosses,
             count(DISTINCT mb.box_id)::int AS n,
             (s.batch_id IS NOT NULL) AS frozen, s.segments
        FROM member mb
        JOIN batches t ON t.id = mb.batch_id AND t.status <> 'cancelled'
        JOIN warehouses o ON o.id = t.origin_warehouse_id
        JOIN warehouses d ON d.id = t.dest_warehouse_id
        LEFT JOIN batch_sent_compositions s ON s.batch_id = t.id AND s.lot_id = mb.lot_id
       GROUP BY mb.lot_id, t.id, o.country, d.country, s.batch_id, s.segments
    `)) as unknown as typeof rows;
  } catch (err) {
    if (isServerBehind(err) && exec === db) {
      console.warn('[lot-composition] server behind', err);
      return out;
    }
    throw err;
  }
  for (const r of rows) {
    const list2 = out.get(r.lot_id) ?? [];
    list2.push({
      batchId: r.batch_id,
      code: r.code,
      departedAt: r.departed_at,
      createdAt: r.created_at,
      crosses: r.crosses === true,
      n: Number(r.n),
      frozen: r.frozen === true,
      frozenSegments: r.frozen === true ? segmentsOf(r.segments) : null,
    });
    out.set(r.lot_id, list2);
  }
  return out;
}

/**
 * The tick's stamp: the (lot, rev, positions) of a truck's composed lots,
 * sorted, hashed (sha256 hex); '' when none. The Bojxona page posts it; the
 * freeze recomputes it from what it froze, in the same statement. The
 * POSITIONS are in it because a paper moves when they do (another truck of
 * the lot departing first) even while every composition stands still.
 */
export function paperStamp(
  pairs: readonly { lotId: string; rev: number | null; segments?: readonly Segment[] | null }[],
): string {
  const composed = pairs
    .filter((p) => p.rev !== null)
    .map((p) => `${p.lotId}:${p.rev}:${JSON.stringify(p.segments ?? null)}`)
    .sort();
  if (composed.length === 0) return '';
  return createHash('sha256').update(composed.join('\n')).digest('hex');
}

/**
 * Where this truck's cartons of each of its lots sit (§2) — the positions a
 * tick freezes and the stamp hashes; null for a lot on a truck that does not
 * cross the border (it has no place in the order). `lotIds` = the lots on
 * the truck.
 */
async function truckPositions(exec: Db | Tx, batchId: string, lotIds: string[]): Promise<Map<string, Segment[] | null>> {
  const out = new Map<string, Segment[] | null>();
  const trucks = await lotTrucksFor(exec, lotIds);
  for (const lotId of lotIds) {
    const ofLot = trucks.get(lotId) ?? [];
    const self = ofLot.find((t) => t.batchId === batchId);
    out.set(lotId, self?.crosses ? truckSegments(ofLot, batchId) : null);
  }
  return out;
}

/** The stamp of a truck's papers as they would print NOW — the page posts it with the tick. */
export async function paperStampFor(batchId: string): Promise<string> {
  if (!UUID.test(batchId)) return '';
  try {
    const rows = (await db.execute(sql`
      SELECT lc.lot_id, lc.rev
        FROM (SELECT DISTINCT boxes.lot_id FROM boxes WHERE ${batchMemberFilter(batchId)}) ml
        JOIN lot_compositions lc ON lc.lot_id = ml.lot_id
       WHERE (SELECT count(*) FROM lot_composition_lines g WHERE g.lot_id = lc.lot_id) >= ${MIN_LINES}
    `)) as unknown as { lot_id: string; rev: string | number }[];
    if (rows.length === 0) return '';
    const positions = await truckPositions(db, batchId, rows.map((r) => r.lot_id));
    return paperStamp(
      rows.map((r) => ({ lotId: r.lot_id, rev: Number(r.rev), segments: positions.get(r.lot_id) ?? null })),
    );
  } catch (err) {
    if (isServerBehind(err)) return '';
    throw err;
  }
}

/**
 * The «hujjat yuborildi» tick's copy (7a): the positions of every lot on the
 * truck read first (`truckPositions`, beside it in the same transaction),
 * then ONE `INSERT … SELECT … RETURNING` over every lot on the truck
 * (`batchMemberFilter` — the invoice's population), composed or not — so the
 * copy and the stamp the tick compares read the same instant. A lot with no
 * composition gets a row with `lines` NULL: a composition stated later must
 * not rewrite this truck's invoice. The POSITIONS are frozen with every row,
 * composed or not: the cumulative rule's offset is part of what the papers
 * printed, and without it a truck of the same lot departing first moved a
 * sent truck's lines (the review of the freeze). Returns the frozen (lot,
 * rev, positions).
 */
export async function freezeCompositionsInTx(
  tx: Tx,
  batchId: string,
): Promise<{ lotId: string; rev: number | null; segments: Segment[] | null }[]> {
  const onTruck = (await tx.execute(sql`
    SELECT DISTINCT boxes.lot_id FROM boxes WHERE ${batchMemberFilter(batchId)}
  `)) as unknown as { lot_id: string }[];
  const positions = await truckPositions(tx, batchId, onTruck.map((r) => r.lot_id));
  return copyCompositionsInTx(tx, batchId, positions);
}

/** The copy itself — ONE statement (fence rule 7). */
async function copyCompositionsInTx(
  tx: Tx,
  batchId: string,
  positions: Map<string, Segment[] | null>,
): Promise<{ lotId: string; rev: number | null; segments: Segment[] | null }[]> {
  const pos =
    positions.size > 0
      ? sql`(VALUES ${sql.join(
          [...positions].map(([lotId, segs]) => sql`(${lotId}::uuid, ${segs === null ? null : JSON.stringify(segs)}::jsonb)`),
          sql`, `,
        )}) AS pos(lot_id, segments)`
      : sql`(SELECT NULL::uuid AS lot_id, NULL::jsonb AS segments WHERE false) AS pos`;
  const rows = (await tx.execute(sql`
    INSERT INTO batch_sent_compositions (batch_id, lot_id, rev, seen_box_count, lines, segments)
    SELECT ${batchId}::uuid, ml.lot_id,
           CASE WHEN json_array_length(ln.lines) >= ${MIN_LINES} THEN lc.rev END,
           CASE WHEN json_array_length(ln.lines) >= ${MIN_LINES} THEN lc.seen_box_count END,
           CASE WHEN json_array_length(ln.lines) >= ${MIN_LINES} THEN ln.lines::jsonb END,
           pos.segments
      FROM (SELECT DISTINCT boxes.lot_id FROM boxes WHERE ${batchMemberFilter(batchId)}) ml
      LEFT JOIN ${pos} ON pos.lot_id = ml.lot_id
      LEFT JOIN lot_compositions lc ON lc.lot_id = ml.lot_id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'seq', g.seq, 'name', g.name, 'pieces', g.pieces, 'cartons', g.cartons,
                 'kg', g.weight_kg::text, 'm3', g.volume_m3::text, 'tnvedCode', g.tnved_code)
               ORDER BY g.seq) AS lines
          FROM lot_composition_lines g WHERE g.lot_id = lc.lot_id
      ) ln ON lc.lot_id IS NOT NULL
    ON CONFLICT (batch_id, lot_id) DO UPDATE SET
      rev = EXCLUDED.rev, seen_box_count = EXCLUDED.seen_box_count,
      lines = EXCLUDED.lines, segments = EXCLUDED.segments, frozen_at = now()
    RETURNING lot_id, rev, segments
  `)) as unknown as { lot_id: string; rev: string | number | null; segments: unknown }[];
  return rows.map((r) => ({
    lotId: r.lot_id,
    rev: r.rev === null ? null : Number(r.rev),
    segments: segmentsOf(r.segments),
  }));
}

/**
 * The un-tick: the truck's papers read the live compositions again. Answers
 * the COMPOSED lots it thawed — what the tick's audit counted (the review's
 * nit: every deleted row made one truck audit 1 on send and 10 on unsend).
 */
export async function thawCompositionsInTx(tx: Tx, batchId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    DELETE FROM batch_sent_compositions WHERE batch_id = ${batchId}::uuid RETURNING rev
  `)) as unknown as { rev: string | number | null }[];
  return rows.filter((r) => r.rev !== null).length;
}
