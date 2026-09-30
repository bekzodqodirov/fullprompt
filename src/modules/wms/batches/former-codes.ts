import { cache } from 'react';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { auditLog, users } from '../../platform/db/schema';

/**
 * The names a truck has WORN — the only home of `before->>'code'` in the
 * system (a fence in tests/unit/batch-rename-wire.test.ts says so).
 *
 * There is no table for it: every rename writes one immutable `audit_log` row
 * (`batches/rename.ts`, protected from DELETE and UPDATE by 0001's trigger),
 * and that row already says who, when, from what, to what and why. A second
 * copy could only ever disagree with it.
 *
 * What makes the audit trail safe to READ as data is that the predicate is
 * SELF-DESCRIBING: an `update` on a batch whose before AND after both carry a
 * code, and the two differ. A future batch audit that snapshots a whole row
 * cannot enter the set unless the code really changed — which is a rename.
 * The fence pins the other half: every batch `writeAudit` in `src/` passes
 * `before` as an object literal, and only rename.ts puts a `code` in one.
 *
 * The literals are INLINED (`sql.raw` of a constant — no user input ever
 * reaches it), so even a generic prepared plan can prove the partial index's
 * predicate; 0121 repeats `FORMER_CODE_PREDICATE('')` and
 * `FORMER_CODE_KEY('')` character for character (fenced).
 */
export const FORMER_CODE_PREDICATE = (p: string): string =>
  `${p}entity_type = 'batch' AND ${p}action = 'update' AND (${p}before->>'code') IS NOT NULL AND (${p}after->>'code') IS NOT NULL AND (${p}before->>'code') <> (${p}after->>'code')`;

export const FORMER_CODE_KEY = (p: string): string => `upper(${p}before->>'code')`;

const PRED_A = sql.raw(FORMER_CODE_PREDICATE('a.'));
const KEY_A = sql.raw(FORMER_CODE_KEY('a.'));

/**
 * One name at a time, for the whole transaction: a rename TO a name and a
 * counter walk REACHING it serialise here, so «ever worn» is enforced and not
 * merely checked (the audit half has no unique index to be the arbiter). A
 * `hashtext` collision only over-serialises. The fx-residue / count-rules
 * idiom; outside a transaction it is released at the end of its statement.
 */
export async function lockBatchCode(tx: Db | Tx, code: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('batch-code'), hashtext(upper(${code}::text)))`,
  );
}

/**
 * Has any truck — `exceptBatchId` aside — ever been called this? Its current
 * code, or any name it wore before a rename. ONE statement, so both halves
 * answer from one snapshot. The JOIN to `batches` ignores rows orphaned by
 * tests that delete trucks; production never deletes a batch.
 */
export async function codeEverWorn(
  tx: Db | Tx,
  code: string,
  exceptBatchId: string | null,
): Promise<boolean> {
  const rows = (await tx.execute(codeEverWornSql(code, exceptBatchId))) as unknown as unknown[];
  return rows.length > 0;
}

/** `codeEverWorn`'s one statement — exported so a test can EXPLAIN exactly it. */
export function codeEverWornSql(code: string, exceptBatchId: string | null): SQL {
  const notCurrent = exceptBatchId ? sql` AND b.id <> ${exceptBatchId}` : sql``;
  const notFormer = exceptBatchId ? sql` AND a.entity_id <> ${exceptBatchId}` : sql``;
  return sql`
    SELECT 1 FROM batches b WHERE upper(b.code) = upper(${code}::text)${notCurrent}
    UNION ALL
    SELECT 1 FROM audit_log a JOIN batches b ON b.id = a.entity_id
     WHERE ${PRED_A} AND ${KEY_A} = upper(${code}::text)${notFormer}
    LIMIT 1
  `;
}

/** Was THIS truck ever called this? (A name may come back as another rename.) */
export async function isOwnFormerCode(tx: Db | Tx, batchId: string, code: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 FROM audit_log a
     WHERE ${PRED_A} AND ${KEY_A} = upper(${code}::text) AND a.entity_id = ${batchId}
     LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * The truck that USED to be called this, for the bot's last fallback. A name
 * a truck still wears is not «former» (`upper(b.code) <> …`); pre-rule history
 * may hold one name on two trucks, and the newest rename answers.
 */
export async function batchByFormerCode(
  code: string,
): Promise<{ batchId: string; formerCode: string } | null> {
  const rows = (await db.execute(sql`
    SELECT a.entity_id AS batch_id, a.before->>'code' AS former_code
      FROM audit_log a JOIN batches b ON b.id = a.entity_id
     WHERE ${PRED_A} AND ${KEY_A} = upper(${code}::text) AND upper(b.code) <> upper(${code}::text)
     ORDER BY a.id DESC
     LIMIT 1
  `)) as unknown as { batch_id: string; former_code: string }[];
  const row = rows[0];
  return row ? { batchId: row.batch_id, formerCode: row.former_code } : null;
}

export interface FormerCodeRow {
  from: string;
  to: string;
  /** Null on a rename made before departure — no reason was ever asked. */
  reason: string | null;
  at: Date;
  by: string | null;
}

/**
 * Every rename of one truck, oldest first. The drizzle builder and not
 * `db.execute`, because raw timestamps come back as TEXT (#923).
 */
export async function formerCodesFor(batchId: string): Promise<FormerCodeRow[]> {
  const rows = await db
    .select({
      from: sql<string>`${auditLog.before}->>'code'`,
      to: sql<string>`${auditLog.after}->>'code'`,
      reason: sql<string | null>`${auditLog.after}->>'reason'`,
      at: auditLog.createdAt,
      by: users.fullName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(
      and(
        eq(auditLog.entityType, 'batch'),
        eq(auditLog.entityId, batchId),
        sql.raw(FORMER_CODE_PREDICATE('"audit_log".')),
      ),
    )
    .orderBy(asc(auditLog.id));
  return rows.map((row) => ({ ...row, reason: row.reason?.trim() ? row.reason : null }));
}

/** The card's copy, memoised per request (every tab renders the header). */
export const formerCodesOf = cache(formerCodesFor);

/**
 * «Oldingi nomi»: the distinct names, oldest first, never the CURRENT one —
 * a round trip X → Y → X does not list X as a name it used to have.
 */
export function formerNames(rows: readonly Pick<FormerCodeRow, 'from'>[], current: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const name = row.from;
    if (!name || name === current || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * ONE text match for ⌘K AND the /batches archive: the current code, the
 * plate, the driver — and any name the truck used to wear.
 *
 * Wrapped in ONE outer bracket on purpose: drizzle's `and()` brackets the
 * list, not each member, so a bare `x OR y` handed in beside a warehouse
 * fence renders `x OR (y AND fence)` and a scoped reader finds every truck by
 * its old names (round 99's `(filter AND open) OR closed`, on the batches
 * group). The columns are written `"batches".…` explicitly, so the fragment
 * means the same in a single-table select and in the archive's joined one
 * (#128). The subquery is uncorrelated — a hashed subplan over the partial
 * index, never a probe per row (#152).
 */
export function batchTextMatchSql(like: string): SQL {
  return sql`("batches"."code" ILIKE ${like} OR "batches"."vehicle_plate" ILIKE ${like} OR "batches"."driver_name" ILIKE ${like} OR "batches"."id" IN (SELECT a.entity_id FROM audit_log a WHERE ${PRED_A} AND (a.before->>'code') ILIKE ${like}))`;
}

/**
 * Which former name matched — NULL when the current code already did, so a
 * hit found by its own name carries no «oldingi nomi» at all.
 */
export function formerCodeHitSql(like: string): SQL<string | null> {
  return sql<string | null>`CASE WHEN "batches"."code" ILIKE ${like} THEN NULL ELSE (SELECT a.before->>'code' FROM audit_log a WHERE ${PRED_A} AND a.entity_id = "batches"."id" AND (a.before->>'code') ILIKE ${like} ORDER BY a.id DESC LIMIT 1) END`;
}

/**
 * Does something else ALREADY answer to this name in the bot — a client, a
 * crate, a box? On the POOL and before any transaction (#714). Crates and
 * boxes by their indexed columns; clients by the bot's own comparison.
 */
export async function codeShadows(code: string): Promise<'client' | 'crate' | 'box' | null> {
  const rows = (await db.execute(sql`
    SELECT 'client' AS kind FROM clients WHERE upper(client_code) = upper(${code}::text)
    UNION ALL
    SELECT 'crate' FROM crates WHERE code = upper(${code}::text)
    UNION ALL
    SELECT 'box' FROM boxes WHERE upper(short_code) = upper(${code}::text)
    LIMIT 1
  `)) as unknown as { kind: 'client' | 'crate' | 'box' }[];
  return rows[0]?.kind ?? null;
}
