import { cache } from 'react';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { auditLog, users } from '../../platform/db/schema';

/**
 * The names a truck WORE ON THE ROAD — the only home of `before->>'code'` in
 * the system (a fence in tests/unit/batch-rename-wire.test.ts says so).
 *
 * There is no table for it: every rename writes one immutable `audit_log` row
 * (`batches/rename.ts`, protected from DELETE and UPDATE by 0001's trigger),
 * and that row already says who, when, from what, to what and why. A second
 * copy could only ever disagree with it.
 *
 * ONLY a rename made on the road counts, and the row says so itself: it is
 * the one that carries a `reason` (the road asks for one, the forming screen
 * never did). A name that reached the road is on the invoice, the manifest,
 * what the customs agent holds, what the bot and ⌘K answered — so it stays
 * findable and is never given to another truck. A name typed and changed
 * again BEFORE departure reached none of that: a typo, or the partner's plate
 * put on the wrong forming truck, frees at once exactly as it did before
 * #122 was reversed, so it can go to the right truck and never sends ⌘K or
 * the bot to the wrong one.
 *
 * What makes the audit trail safe to READ as data is that the predicate is
 * SELF-DESCRIBING: an `update` on a batch whose before AND after both carry a
 * code, the two differ, and the after carries a reason. A future batch audit
 * that snapshots a whole row cannot enter the set unless the code really
 * changed on the road — which is a road rename. The fence pins the other
 * half: every batch `writeAudit` in `src/` passes `before` as an object
 * literal, and only rename.ts puts a `code` in one.
 *
 * The literals are INLINED (`sql.raw` of a constant — no user input ever
 * reaches it), so even a generic prepared plan can prove the partial index's
 * predicate; 0121 repeats `FORMER_CODE_PREDICATE('')` and
 * `FORMER_CODE_KEY('')` character for character (fenced).
 */
export const FORMER_CODE_PREDICATE = (p: string): string =>
  `${p}entity_type = 'batch' AND ${p}action = 'update' AND (${p}before->>'code') IS NOT NULL AND (${p}after->>'code') IS NOT NULL AND (${p}before->>'code') <> (${p}after->>'code') AND (${p}after->>'reason') IS NOT NULL`;

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
 * code, or any name it wore on the road before a rename. ONE statement, so both halves
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

/** Did THIS truck wear this name on the road? (It may come back as another rename.) */
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

/**
 * The truck that HOLDS a minted number — the cancel's give-back asks it of
 * every number it walks (docs/NARX-VA-RAQAM.md §3.2.1). Here because it reads
 * `before->>'code'`, and this file is that read's one home (fenced).
 *
 * The truck WEARING the string now, first; and when nobody wears it, among
 * the trucks with a batch audit row renaming AWAY from it (before and after
 * both carry a code and they differ — any stage, with or without a reason,
 * the give-back's own row included): the truck that CARRIED it on the road
 * (a rename away from it with a `reason`, the newest such row), else the
 * truck that MINTED it — the newest one BORN with it (`bornNameSql`,
 * `firstNameOf`'s rule).
 *
 * The road truck first (review RVF3-2): a number given back and then worn on
 * the road by another truck under a hand rename is burned for good (the
 * former-name predicate), and the truck to name for it is the one that took
 * it out — the one `batchByFormerCode` answers ⌘K and the bot with, not the
 * cancelled minter that never left («P-002 (bekor) nomi bilan jo‘nagan» was
 * what the dry run read to him). A road rename happens only on a departed
 * truck, so this only ever names the truck behind a stop the `roadFormer`
 * belt already makes; it never changes whether a number comes back. Every
 * case before departure still goes to the minter.
 *
 * The rename-away half is why a truck renamed to its plate before it left
 * and then cancelled is still found: his 4a says its number comes back, and
 * «nobody wears it» alone would have stopped the walk there for ever. The
 * MINTER and not merely the newest renamer (review C2): a forming truck may
 * be renamed by hand to a colleague's just-vacated mint string and away
 * again, and the newest row would make IT the holder — cancel it and the
 * live plate-named minter's number is released and minted a second time
 * (the unique index never sees it, the plate is what the minter wears). The
 * NEWEST minter, so a number released and handed out again belongs to the
 * truck that took it last. Only when no truck carried it on the road and
 * none was born with it (rows from before the create audit, a hand-moved
 * counter) does the newest rename-away row answer.
 *
 * Plain statements and no lock: the release reads it first, takes its locks
 * only when the answer is «releasable», and then reads it again. `wears`
 * false is the rename-away case. `atAgent` is the 7a rule on the NUMBER, not
 * on the holder alone (review RVF3-1): the holder's tick standing now or ever
 * pressed (an untick does not un-send papers, §3.2.3) — and, for a holder
 * the verdict would otherwise release (cancelled, never departed), a tick on
 * ANY truck that ever wore this exact string: the one wearing it now, and
 * every truck with a rename row from it or to it. The minter rule (C2) made
 * the minter the holder of a string a colleague wore by hand while ticked and
 * then left; the agent holds THAT truck's papers under the number, and a
 * holder-only tick released it and minted it a second time. Conservative on
 * purpose — the tick row names no code, so a truck ticked under another name
 * that later passed through this one keeps it too: a gap, never a duplicate
 * at the agent. Outside that one case the field is the holder's own tick;
 * the verdict reads it only there (`numberVerdict`), so the wider scan is
 * paid on a cancel, a cancelled card and the dry run's cancelled numbers —
 * never per live truck. `roadFormer` is the former-name predicate over the
 * number itself: a name that reached the road is never given out again.
 *
 * The rename-away half has no partial index of its own (0121's covers road
 * renames only) and rides `audit_entity_idx`'s leading column over the batch
 * rows — a few thousand on the live server, read on a cancel, a cancelled
 * truck's card and the dry run, never on a list. No migration for it. The
 * born-name question is then asked only of the handful of trucks that
 * renamed away from this one string, one `audit_entity_idx` probe each
 * (`entity_type`, `entity_id`) — never a scan per number.
 */
export interface NumberHolder {
  id: string;
  code: string;
  status: string;
  originWarehouseId: string;
  departed: boolean;
  atAgent: boolean;
  wears: boolean;
  roadFormer: boolean;
}

export async function numberHolderOf(handle: Db | Tx, code: string): Promise<NumberHolder | null> {
  const wearer = (await handle.execute(sql`
    SELECT b.id FROM batches b WHERE upper(b.code) = upper(${code}::text) LIMIT 1
  `)) as unknown as { id: string }[];
  let id = [...wearer][0]?.id ?? null;
  const wears = id !== null;
  if (!id) {
    // The truck that carried it on the ROAD first (its newest road rename
    // away from it — `batchByFormerCode`'s answer); then the newest MINTER
    // (born with it), by the truck's own birth; then, with neither, the
    // newest rename-away row. MATERIALIZED so the born-name probe runs once
    // per candidate, not once per sort key.
    const away = (await handle.execute(sql`
      WITH away AS (
        SELECT a.entity_id AS id, b.created_at, max(a.id) AS last_away,
               max(a.id) FILTER (WHERE (a.after->>'reason') IS NOT NULL) AS last_road
          FROM audit_log a JOIN batches b ON b.id = a.entity_id
         WHERE a.entity_type = 'batch' AND a.action = 'update'
           AND upper(a.before->>'code') = upper(${code}::text)
           AND (a.after->>'code') IS NOT NULL
           AND upper(a.after->>'code') <> upper(${code}::text)
         GROUP BY a.entity_id, b.created_at
      ), judged AS MATERIALIZED (
        SELECT away.*, coalesce(upper(${bornNameSql(sql`away.id`)}) = upper(${code}::text), false) AS minted
          FROM away
      )
      SELECT id FROM judged
       ORDER BY last_road DESC NULLS LAST, minted DESC, (CASE WHEN minted THEN created_at END) DESC NULLS LAST, last_away DESC
       LIMIT 1
    `)) as unknown as { id: string }[];
    id = [...away][0]?.id ?? null;
  }
  if (!id) return null;
  // The holder's own tick always; every truck that ever wore the string only
  // where the verdict would otherwise give the number back (the CASE is what
  // keeps the wider scan off a live or departed holder — Postgres evaluates
  // a CASE branch's subquery only when its condition holds).
  const rows = (await handle.execute(sql`
    SELECT b.id, b.code, b.status, b.origin_warehouse_id,
           (b.departed_at IS NOT NULL) AS departed,
           (b.sent_to_agent_at IS NOT NULL OR EXISTS (
              SELECT 1 FROM audit_log t
               WHERE t.entity_type = 'batch' AND t.entity_id = b.id AND (t.after->>'sentToAgent') = 'true'
           ) OR CASE WHEN b.status = 'cancelled' AND b.departed_at IS NULL THEN EXISTS (
              SELECT 1 FROM batches w
               WHERE w.id IN (${everWoreSql(code)})
                 AND (w.sent_to_agent_at IS NOT NULL OR EXISTS (
                       SELECT 1 FROM audit_log t2
                        WHERE t2.entity_type = 'batch' AND t2.entity_id = w.id
                          AND (t2.after->>'sentToAgent') = 'true'))
           ) ELSE false END) AS at_agent,
           EXISTS (SELECT 1 FROM audit_log a WHERE ${PRED_A} AND ${KEY_A} = upper(${code}::text)) AS road_former
      FROM batches b WHERE b.id = ${id}::uuid
  `)) as unknown as {
    id: string;
    code: string;
    status: string;
    origin_warehouse_id: string;
    departed: boolean;
    at_agent: boolean;
    road_former: boolean;
  }[];
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    originWarehouseId: row.origin_warehouse_id,
    departed: row.departed === true,
    atAgent: row.at_agent === true,
    wears,
    roadFormer: row.road_former === true,
  };
}

/**
 * A truck's oldest rename's «from» — the name it was born with, when it was
 * ever renamed (NULL otherwise). ONE fragment for `firstNameOf` and the
 * holder's «who minted it» (`numberHolderOf`), so the two can never disagree
 * about which truck a number was minted for. `entity` is the truck's id
 * expression in the caller's query; one `audit_entity_idx` probe.
 */
function bornNameSql(entity: SQL): SQL {
  return sql`(SELECT f.before->>'code' FROM audit_log f
      WHERE f.entity_type = 'batch' AND f.entity_id = ${entity} AND f.action = 'update'
        AND (f.before->>'code') IS NOT NULL
      ORDER BY f.id ASC LIMIT 1)`;
}

/**
 * Every truck that ever WORE this exact string — the one wearing it now
 * (upper-cased, as `codeEverWorn` compares), and every truck with a rename
 * row FROM it or TO it, at any stage, the give-back's own row included (only
 * rename.ts puts a `code` in `before`, fenced; `after.code` alone is also the
 * load-removed row's carton code, so a row must carry both). The 7a agent
 * rule on the number asks a tick of each (`numberHolderOf`, review RVF3-1).
 * A row orphaned by a test that deleted its truck drops out at the caller's
 * join to `batches`. An id list for `IN (…)`: the code index for the wearer,
 * one pass over the batch audit rows for the rest.
 */
function everWoreSql(code: string): SQL {
  return sql`SELECT o.id FROM batches o WHERE upper(o.code) = upper(${code}::text)
     UNION
     SELECT r.entity_id FROM audit_log r
      WHERE r.entity_type = 'batch' AND r.action = 'update'
        AND (r.before->>'code') IS NOT NULL AND (r.after->>'code') IS NOT NULL
        AND (upper(r.before->>'code') = upper(${code}::text) OR upper(r.after->>'code') = upper(${code}::text))`;
}

/**
 * The name a truck was BORN with — its oldest rename's «from», else the name
 * it wears. The minted number of a truck renamed before it left (the plate
 * case) is only here; the cancelled truck's card falls back to it when no
 * number in its history is its own any more (§3.2.4).
 */
export async function firstNameOf(handle: Db | Tx, batchId: string): Promise<string | null> {
  const rows = (await handle.execute(sql`
    SELECT coalesce(${bornNameSql(sql`b.id`)}, b.code) AS first
      FROM batches b WHERE b.id = ${batchId}::uuid
  `)) as unknown as { first: string | null }[];
  return [...rows][0]?.first ?? null;
}

/**
 * Every name a truck renamed AWAY from, oldest first and once each — the
 * minted strings it may still HOLD by the holder rule after wearing another
 * (a plate, or a colleague's vacated number: review C1). The cancelled
 * truck's card asks the holder of each; nothing here decides.
 */
export async function namesWornBy(handle: Db | Tx, batchId: string): Promise<string[]> {
  const rows = (await handle.execute(sql`
    SELECT a.before->>'code' AS name, min(a.id) AS first_at
      FROM audit_log a
     WHERE a.entity_type = 'batch' AND a.entity_id = ${batchId}::uuid AND a.action = 'update'
       AND (a.before->>'code') IS NOT NULL
     GROUP BY a.before->>'code'
     ORDER BY first_at ASC
  `)) as unknown as { name: string }[];
  return [...rows].map((row) => row.name);
}

/**
 * «YW-010 (bekor)», «YW-010 (bekor 2)» — the name the give-back puts on a
 * cancelled truck, matched from the number people know (§3.2.5). The bot's
 * exact lookup finds nothing for a released number until it is minted again,
 * and this is its fallback. Upper-cased both sides, the needle escaped with
 * `!` (a prefix is free text: `_` and `%` are its own characters here).
 */
export function releasedNameSql(code: string): SQL {
  const needle = code.toUpperCase().replace(/[!%_]/g, (ch) => `!${ch}`);
  return sql`upper("batches"."code") LIKE ${`${needle} (BEKOR%`} ESCAPE '!'`;
}

/** The newest cancelled truck that gave this number back, for the bot. */
export async function batchByReleasedName(code: string): Promise<{ batchId: string } | null> {
  const rows = (await db.execute(sql`
    SELECT "batches"."id" AS batch_id FROM batches
     WHERE "batches"."status" = 'cancelled' AND ${releasedNameSql(code)}
     ORDER BY "batches"."created_at" DESC LIMIT 1
  `)) as unknown as { batch_id: string }[];
  const row = [...rows][0];
  return row ? { batchId: row.batch_id } : null;
}

export interface FormerCodeRow {
  from: string;
  to: string;
  /** Always there: only a road rename is a former name, and the road asks why. */
  reason: string;
  at: Date;
  by: string | null;
}

/**
 * Every road rename of one truck, oldest first. The drizzle builder and not
 * `db.execute`, because raw timestamps come back as TEXT (#923).
 */
export async function formerCodesFor(batchId: string): Promise<FormerCodeRow[]> {
  return db
    .select({
      from: sql<string>`${auditLog.before}->>'code'`,
      to: sql<string>`${auditLog.after}->>'code'`,
      reason: sql<string>`${auditLog.after}->>'reason'`,
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
 * «The code starts with …» — the truck-bill picker's second rank (SARFLAR
 * §8.5), here beside the match so every ILIKE over a truck's code has one
 * home (#1252's fence). `prefix` is `prefixNeedle(q)`, escaped.
 */
export function codePrefixSql(prefix: string): SQL {
  return sql`("batches"."code" ILIKE ${prefix})`;
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
