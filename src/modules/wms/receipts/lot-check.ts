import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { receiptLots, receipts } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import type { ScopedActor } from '../../platform/rbac/scope';
import { mayOpenBatchVed } from '../batches/card-door';
import { lockReceiptShareNoWait } from './grow-lot';
import {
  checkTermsSql,
  lotAskableSql,
  lotCheckStateSql,
  lotTarkibJoinSql,
  tarkibStandsSql,
  type LotCheckState,
} from './lot-check-sql';
import { lotChecksReady } from './lot-check-ready';
import { mayReadReceipt } from './read-door';

/**
 * «Yuk ma'lumoti tekshirildi» — the ONE writer of `lot_checks` (0123,
 * docs/YUK-TEKSHIRUV.md). The owner's flow: the logist (or the VED — his 1a)
 * asks the client «100 karobkangiz keldi, klaviatura ekan, to'g'rimi?» and,
 * if it is, ticks. The row SNAPSHOTS what the person saw (his 2b: the name,
 * the count, the client); every reader compares it with the lot through
 * `lot-check-sql.ts`, so no writer of those facts ever clears it.
 */

export type LotCheckRefusal = 'forbidden' | 'receipt_not_confirmed' | 'no_client' | 'lot_changed' | 'check_changed';

export class LotCheckError extends Error {
  constructor(public readonly code: LotCheckRefusal) {
    super(code);
  }
}

type Grants = { has(code: string): boolean };
export type LotCheckActor = ScopedActor & { id: string; permissions: Grants };

/**
 * Who ticks (his 1a): the logist and the admins, and the VED — the lot
 * tarkibi's own audience (`ved.docs ∨ plans.manage`), one rule for «yuk
 * ma'lumoti». No new permission code: a new one reaches nobody on his live
 * roles until somebody ticks it (#170). The page asks it to DRAW the
 * buttons, the service asks it again (#531).
 */
export function mayCheckLot(permissions: Grants): boolean {
  return mayOpenBatchVed(permissions);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const lotCheckInputSchema = z.object({
  lotId: z.string().uuid(),
  /** What the panel showed when the person pressed — compared with the locked lot. */
  seen: z.object({
    nameZh: z.string().max(400),
    nameRu: z.string().max(400),
    boxCount: z.number().int().positive(),
    /** '' when the panel drew none — answered `no_client` by the door, never a parse refusal. */
    clientId: z.union([z.string().uuid(), z.literal('')]),
  }),
  note: z.string().max(500).optional(),
  /**
   * The person's check as the panel DREW it (`checked_at::text`, null = none)
   * — compared under the lock, so a press never replaces or removes a
   * colleague's confirmation it did not see (`check_changed`).
   */
  seenCheckedAt: z.string().max(64).nullable(),
});
export type LotCheckInput = z.infer<typeof lotCheckInputSchema>;

export const lotUncheckInputSchema = z.object({
  lotId: z.string().uuid(),
  seenCheckedAt: z.string().max(64).nullable(),
});

/** '' and NULL are one value — the lot column stores an absent name as NULL. */
const orNull = (value: string | null | undefined): string | null => {
  const s = (value ?? '').trim();
  return s === '' ? null : s;
};

/**
 * The door, on the POOL before any transaction (`mayReadReceipt` reads the
 * pool — tests/unit/tx-pool.test.ts). A missing lot answers `forbidden` like
 * an unreadable one, so a refusal says nothing about which ids exist.
 */
async function lotCheckDoor(actor: LotCheckActor, lotId: string) {
  if (!mayCheckLot(actor.permissions)) throw new LotCheckError('forbidden');
  if (!UUID.test(lotId)) throw new LotCheckError('forbidden');
  const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lotId) });
  if (!lot) throw new LotCheckError('forbidden');
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, lot.receiptId) });
  if (!receipt) throw new LotCheckError('forbidden');
  if (!(await mayReadReceipt(actor, { id: receipt.id, warehouseId: receipt.warehouseId }))) {
    throw new LotCheckError('forbidden');
  }
  return { lot, receipt };
}

interface LockedLot {
  id: string;
  receipt_id: string;
  letter: string | null;
  name_zh: string;
  name_ru: string | null;
  box_count: number;
}

/**
 * The lot, FOR NO KEY UPDATE — the composition writer's prefix, so the lot
 * tarkibi, `editLot` and the count doors (FOR UPDATE) all meet this as a
 * wait and never as a cycle.
 */
async function lockLot(tx: Tx, lotId: string): Promise<LockedLot> {
  const rows = (await tx.execute(sql`
    SELECT id, receipt_id, letter, product_name_zh AS name_zh, NULLIF(product_name_ru, '') AS name_ru, box_count
      FROM receipt_lots WHERE id = ${lotId}::uuid FOR NO KEY UPDATE
  `)) as unknown as LockedLot[];
  const lot = rows[0];
  if (!lot) throw new LotCheckError('forbidden');
  return { ...lot, box_count: Number(lot.box_count) };
}

/**
 * The History's keys carry the LOT (`lotCheck:A`): the tab nets a run of
 * one person's edits per KEY, so a shared `lotCheck` turned «ticked A, B and
 * C in one call» into one line about C, and «undo A, tick B» into what reads
 * as A renamed to B. `AUDIT_FIELD_LABELS` resolves the prefix.
 */
export function lotCheckAuditKeys(letter: string | null): { check: string; note: string } {
  const item = letter ?? '?';
  return { check: `lotCheck:${item}`, note: `lotCheckNote:${item}` };
}

/** The History's value: «A: 键盘 (Клавиатура) × 100 · GS777» — a re-check after a rename reads different. */
function summary(
  letter: string | null,
  zh: string,
  ru: string | null,
  count: number,
  code: string | null,
): string {
  return `${letter ?? ''}: ${zh}${ru ? ` (${ru})` : ''} × ${count} · ${code ?? '?'}`;
}

async function clientCodesOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT id, client_code FROM clients WHERE id IN (${sql.join(
      wanted.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; client_code: string }[];
  return new Map(rows.map((row) => [row.id, row.client_code]));
}

/**
 * «✅ To'g'ri — mijoz tasdiqladi». On the pool: the door, a confirmed prixod
 * with a client. In ONE transaction, in this lock order — lot (NO KEY UPDATE)
 * → prixod (SHARE NOWAIT, raw — #1174) → the check row (FOR UPDATE) — two
 * compare-and-sets: the posted snapshot against the LOCKED lot and prixod (a
 * person cannot confirm a name they did not see: `lot_changed`), and the
 * check the panel drew against the row (`check_changed`: a colleague
 * confirmed meanwhile). The row is written FROM the locked values, never from
 * the post. The same press again by the same person is no write and no audit
 * (a double tap, never a refusal).
 */
export async function checkLot(
  input: unknown,
  actor: LotCheckActor,
  ctx: AuditContext,
): Promise<{ changed: boolean }> {
  const parsed = lotCheckInputSchema.parse(input);
  const { receipt } = await lotCheckDoor(actor, parsed.lotId);
  if (receipt.status !== 'confirmed') throw new LotCheckError('receipt_not_confirmed');
  if (!receipt.clientId) throw new LotCheckError('no_client');
  const note = orNull(parsed.note);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const lot = await lockLot(tx, parsed.lotId);
    await lockReceiptShareNoWait(tx, lot.receipt_id);
    const [current] = (await tx.execute(sql`
      SELECT status, client_id FROM receipts WHERE id = ${lot.receipt_id}::uuid
    `)) as unknown as { status: string; client_id: string | null }[];
    if (!current || current.status !== 'confirmed') throw new LotCheckError('receipt_not_confirmed');
    if (!current.client_id) throw new LotCheckError('no_client');
    if (
      parsed.seen.nameZh.trim() !== lot.name_zh.trim() ||
      orNull(parsed.seen.nameRu) !== orNull(lot.name_ru) ||
      parsed.seen.boxCount !== lot.box_count ||
      parsed.seen.clientId !== current.client_id
    ) {
      throw new LotCheckError('lot_changed');
    }

    const prev = await lockCheckRow(tx, lot.id);
    const holdsNow =
      prev !== null &&
      prev.seen_name_zh === lot.name_zh &&
      prev.seen_name_ru === lot.name_ru &&
      Number(prev.seen_box_count) === lot.box_count &&
      prev.seen_client_id === current.client_id;
    if (holdsNow && prev.note === note && prev.checked_by === actor.id) return { changed: false };
    if ((prev?.checked_at ?? null) !== parsed.seenCheckedAt) throw new LotCheckError('check_changed');

    await tx.execute(sql`
      INSERT INTO lot_checks (lot_id, seen_name_zh, seen_name_ru, seen_box_count, seen_client_id, note, checked_by)
      VALUES (${lot.id}::uuid, ${lot.name_zh}, ${lot.name_ru}, ${lot.box_count}, ${current.client_id}::uuid, ${note}, ${actor.id}::uuid)
      ON CONFLICT (lot_id) DO UPDATE SET
        seen_name_zh = EXCLUDED.seen_name_zh,
        seen_name_ru = EXCLUDED.seen_name_ru,
        seen_box_count = EXCLUDED.seen_box_count,
        seen_client_id = EXCLUDED.seen_client_id,
        note = EXCLUDED.note,
        checked_by = EXCLUDED.checked_by,
        checked_at = now()
    `);

    const codes = await clientCodesOf(tx, [current.client_id, ...(prev ? [prev.seen_client_id] : [])]);
    const keys = lotCheckAuditKeys(lot.letter);
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before: {
        [keys.check]: prev
          ? summary(lot.letter, prev.seen_name_zh, prev.seen_name_ru, Number(prev.seen_box_count), codes.get(prev.seen_client_id) ?? null)
          : null,
        [keys.note]: prev?.note ?? null,
      },
      after: {
        [keys.check]: summary(lot.letter, lot.name_zh, lot.name_ru, lot.box_count, codes.get(current.client_id) ?? null),
        [keys.note]: note,
      },
    });
    return { changed: true };
  });
}

interface CheckRow {
  seen_name_zh: string;
  seen_name_ru: string | null;
  seen_box_count: number;
  seen_client_id: string;
  note: string | null;
  checked_by: string;
  checked_at: string;
}

/** The person's check, FOR UPDATE, with `checked_at` as TEXT — the token the panel posts back. */
async function lockCheckRow(tx: Tx, lotId: string): Promise<CheckRow | null> {
  const rows = (await tx.execute(sql`
    SELECT seen_name_zh, seen_name_ru, seen_box_count, seen_client_id, note, checked_by, checked_at::text AS checked_at
      FROM lot_checks WHERE lot_id = ${lotId}::uuid FOR UPDATE
  `)) as unknown as CheckRow[];
  return rows[0] ?? null;
}

/**
 * «Bekor qilish» — the person's confirmation taken back, only the one the
 * panel drew (`check_changed` otherwise), on a confirmed prixod (a voided one
 * is off every shelf; its row stays as history). A composition's ✅ is not
 * touched — it is undone by clearing the composition.
 */
export async function uncheckLot(
  input: unknown,
  actor: LotCheckActor,
  ctx: AuditContext,
): Promise<{ changed: boolean }> {
  const parsed = lotUncheckInputSchema.parse(input);
  const { receipt } = await lotCheckDoor(actor, parsed.lotId);
  if (receipt.status !== 'confirmed') throw new LotCheckError('receipt_not_confirmed');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const lot = await lockLot(tx, parsed.lotId);
    const row = await lockCheckRow(tx, lot.id);
    if (!row) return { changed: false };
    if (row.checked_at !== parsed.seenCheckedAt) throw new LotCheckError('check_changed');
    await tx.execute(sql`DELETE FROM lot_checks WHERE lot_id = ${lot.id}::uuid`);
    const codes = await clientCodesOf(tx, [row.seen_client_id]);
    const keys = lotCheckAuditKeys(lot.letter);
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before: {
        [keys.check]: summary(lot.letter, row.seen_name_zh, row.seen_name_ru, Number(row.seen_box_count), codes.get(row.seen_client_id) ?? null),
        [keys.note]: row.note,
      },
      after: { [keys.check]: null, [keys.note]: null },
    });
    return { changed: true };
  });
}

/** What the prixod card and the client card draw for one lot. */
export interface LotCheckView {
  state: LotCheckState;
  /**
   * Any live carton still in China (`lotAskableSql`, his 4a): only then does
   * the card ask ❓ / ⚠ and offer the button — elsewhere it shows ✅ or nothing.
   */
  askable: boolean;
  /** The composition stands — «✅ hujjat bo'yicha». */
  byDocument: boolean;
  /** A composition exists that no longer matches the lot. */
  documentStale: boolean;
  /** The person's row, when there is one, and which of its terms moved. */
  person: {
    by: string | null;
    at: Date;
    /** `checked_at::text` — the token the panel posts back (`seenCheckedAt`). */
    token: string;
    note: string | null;
    holds: boolean;
    moved: { name: boolean; count: boolean; client: boolean };
  } | null;
}

/**
 * Every lot's view in ONE statement, over the same sentence the lists ask
 * (`lotCheckStateSql`, its terms, `tarkibStandsSql`) — the card cannot say ✅
 * about a lot the stock table calls ❓. Empty on a server whose migration has
 * not landed (#472). Defaults its handle to the pool (the tx-pool fence's
 * seed shape).
 */
export async function lotCheckViewsFor(lotIds: string[], exec: Db | Tx = db): Promise<Map<string, LotCheckView>> {
  const ids = [...new Set(lotIds)].filter((id) => UUID.test(id));
  if (ids.length === 0 || !(await lotChecksReady())) return new Map();
  const refs = { lot: sql`l`, receipt: sql`r`, check: sql`lc` };
  const terms = checkTermsSql(refs);
  const rows = (await exec.execute(sql`
    SELECT l.id AS lot_id,
           ${lotCheckStateSql(refs)} AS state,
           ${lotAskableSql(sql`l`)} AS askable,
           ${tarkibStandsSql(sql`l`)} AS by_document,
           (lot_tarkib.lot_id IS NOT NULL) AS has_document,
           lc.lot_id IS NOT NULL AS has_person,
           ${terms.name} AS name_ok,
           ${terms.count} AS count_ok,
           ${terms.client} AS client_ok,
           lc.note, lc.checked_at::text AS checked_at, u.full_name AS checked_by
      FROM receipt_lots l
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN lot_checks lc ON lc.lot_id = l.id
      LEFT JOIN ${lotTarkibJoinSql()} ON lot_tarkib.lot_id = l.id
      LEFT JOIN users u ON u.id = lc.checked_by
     WHERE l.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as {
    lot_id: string;
    state: LotCheckState;
    askable: boolean;
    by_document: boolean;
    has_document: boolean;
    has_person: boolean;
    name_ok: boolean | null;
    count_ok: boolean | null;
    client_ok: boolean | null;
    note: string | null;
    checked_at: string | null;
    checked_by: string | null;
  }[];
  return new Map(
    rows.map((row) => {
      const moved = { name: row.name_ok !== true, count: row.count_ok !== true, client: row.client_ok !== true };
      return [
        row.lot_id,
        {
          state: row.state,
          askable: row.askable === true,
          byDocument: row.by_document === true,
          documentStale: row.has_document && row.by_document !== true,
          person: row.has_person
            ? {
                by: row.checked_by,
                at: new Date(row.checked_at!),
                token: row.checked_at!,
                note: row.note,
                holds: !moved.name && !moved.count && !moved.client,
                moved,
              }
            : null,
        },
      ];
    }),
  );
}
