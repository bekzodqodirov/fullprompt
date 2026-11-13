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
  clientDisputeSql,
  clientFactsHoldSql,
  clientHoldsSql,
  clientMeasuresHoldSql,
  lotAskableSql,
  lotCheckStateSql,
  lotShownKgSql,
  lotShownM3Sql,
  lotTarkibJoinSql,
  tarkibStandsSql,
  type LotCheckState,
} from './lot-check-sql';
import {
  clientConfirmsReady,
  lotChecksReady,
  lotClientConfirmsReady,
  lotClientMeasuresReady,
  lotTickMeasuresReady,
  tickMeasuresReady,
} from './lot-check-ready';
import { lotRuShownSql } from './lot-name';
import { mayReadReceipt } from './read-door';

/**
 * «Yuk ma'lumoti tekshirildi» — the ONE writer of `lot_checks` (0123,
 * docs/YUK-TEKSHIRUV.md). The owner's flow: the logist (or the VED — his 1a)
 * asks the client «100 karobkangiz keldi, klaviatura ekan, to'g'rimi?» and,
 * if it is, ticks. The row SNAPSHOTS what the person saw (his 2b: the name,
 * the count, the client — and since 0147 the kilos and cubic metres as a list
 * prints them, his «2 b» of 2026-11-12); every reader compares it with the lot
 * through `lot-check-sql.ts`, so no writer of those facts ever clears it.
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
    /**
     * The lot's kilos and cubic metres as the card PRINTED them (0147): the
     * stored totals, compared with the locked row as numbers. Absent on a page
     * opened before the deploy — the press is then judged by the other four.
     */
    kg: z.string().max(40).optional(),
    m3: z.string().max(40).optional(),
  }),
  note: z.string().max(500).optional(),
  /**
   * The person's check as the panel DREW it (`checked_at::text`, null = none)
   * — compared under the lock, so a press never replaces or removes a
   * colleague's confirmation it did not see (`check_changed`).
   */
  seenCheckedAt: z.string().max(64).nullable(),
  /**
   * The CLIENT's own answer as the panel drew it (`answered_at::text`, null =
   * none — 0144). A tick pressed after a ❌ lifts it, so the person must have
   * SEEN that ❌: an answer that arrived after the page was drawn refuses the
   * press (`check_changed`). Absent on a page opened before the deploy — the
   * press is then judged by the two clocks alone.
   */
  seenClientAt: z.string().max(64).nullable().optional(),
});
export type LotCheckInput = z.infer<typeof lotCheckInputSchema>;

/**
 * A tick and a client's answer about ONE lot are ordered (0144): whichever
 * commits second has seen the first. Taken by `checkLot` and by the client's
 * answer (`client-confirm.ts`) just before each reads the other's row — an
 * advisory lock of its own, never the lot's or the prixod's, so the client's
 * press waits behind a colleague's tick for milliseconds and behind nothing
 * the warehouse holds.
 */
export async function lockLotAnswersTx(tx: Tx, lotId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lot-answer:${lotId}`}, 0))`);
}

/**
 * The client's row on a lot, as the tick needs it: its token, and whether it
 * outranks the standing tick.
 *
 * `clientSide` is the PROBE's answer, asked by the press itself on the pool
 * before its transaction — never the remembered flag. A writer that reads
 * what another screen remembered is right only while that screen has run in
 * its own module instance, and a server action has an instance of its own:
 * after every restart the tick read «no such table», posted `null` against
 * the token the card had drawn, and refused `check_changed` for ever (the
 * as-built review, L1-1; `tests/integration/lot-check-probe…`).
 */
async function clientAnswerFor(
  tx: Tx,
  lotId: string,
  clientId: string,
  clientSide: boolean,
): Promise<{ token: string | null; outranksTick: boolean }> {
  if (!clientSide) return { token: null, outranksTick: false };
  await lockLotAnswersTx(tx, lotId);
  const rows = (await tx.execute(sql`
    SELECT cc.answered_at::text AS token,
           (cc.verdict = 'no' AND cc.shown_client_id = ${clientId}::uuid
            AND coalesce(k.checked_at <= cc.answered_at, false)) AS outranks
      FROM lot_client_confirms cc
      LEFT JOIN lot_checks k ON k.lot_id = cc.lot_id
     WHERE cc.lot_id = ${lotId}::uuid
  `)) as unknown as { token: string; outranks: boolean }[];
  const row = rows[0];
  return { token: row?.token ?? null, outranksTick: row?.outranks === true };
}

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
  /** The stored totals, as the database's text — what the card prints. */
  total_kg: string;
  total_m3: string;
  /** …and as a list reads them, rounded by the DATABASE (`lotShownKgSql` / `lotShownM3Sql`). */
  shown_kg: string;
  shown_m3: string;
}

/**
 * The lot, FOR NO KEY UPDATE — the composition writer's prefix, so the lot
 * tarkibi, `editLot` and the count doors (FOR UPDATE) all meet this as a
 * wait and never as a cycle.
 *
 * `name_ru` is the Russian name the screens SHOW: the tarkib's label while
 * one is written, else the lot's own (docs/TARKIB-TUZATISH.md §9.3). It is
 * read in a SECOND statement, after the lock — the composition's save and
 * clear take this same lock first, so the label cannot move under the
 * snapshot — and on the transaction's own handle, as a statement of its own
 * (#714: the pooled reader would ask an eleventh connection of ten). The lock
 * itself stays on the lot row ALONE (a locking read over a join can lose the
 * row after a wait, #1585).
 */
async function lockLot(tx: Tx, lotId: string): Promise<LockedLot> {
  const rows = (await tx.execute(sql`
    SELECT id, receipt_id, letter, product_name_zh AS name_zh, box_count,
           total_weight_kg::text AS total_kg, total_volume_m3::text AS total_m3
      FROM receipt_lots WHERE id = ${lotId}::uuid FOR NO KEY UPDATE
  `)) as unknown as Omit<LockedLot, 'name_ru' | 'shown_kg' | 'shown_m3'>[];
  const lot = rows[0];
  if (!lot) throw new LotCheckError('forbidden');
  const [named] = (await tx.execute(sql`
    SELECT NULLIF(${lotRuShownSql(sql`l`)}, '') AS shown,
           ${lotShownKgSql(sql`l`)}::text AS shown_kg, ${lotShownM3Sql(sql`l`)}::text AS shown_m3
      FROM receipt_lots l WHERE l.id = ${lot.id}::uuid
  `)) as unknown as { shown: string | null; shown_kg: string; shown_m3: string }[];
  return {
    ...lot,
    name_ru: named?.shown ?? null,
    box_count: Number(lot.box_count),
    shown_kg: named?.shown_kg ?? '',
    shown_m3: named?.shown_m3 ?? '',
  };
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

/**
 * The History's value: «键盘 (Клавиатура) × 100 · GS777» — a re-check after a
 * rename reads different. The lot's letter is in the KEY (`lotCheck:A`).
 */
function summary(
  zh: string,
  ru: string | null,
  count: number,
  code: string | null,
  measures: { kg: string | null; m3: string | null } = { kg: null, m3: null },
): string {
  // The kilos and cubic metres the tick vouched for (0147), as a list prints
  // them: a re-tick that moves only the weight must not read as a History row
  // whose before equals its after (`visibleChanges` drops those, #502).
  const kgM3 = measures.kg !== null && measures.m3 !== null ? ` · ${Number(measures.kg)} kg · ${Number(measures.m3)} m³` : '';
  return `${zh}${ru ? ` (${ru})` : ''} × ${count}${kgM3} · ${code ?? '?'}`;
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
  // Asked HERE, on the pool (a pooled read inside the transaction is #714's
  // freeze): is the client's answer table there at all (0144)? Does the tick
  // remember kilos and cubic metres (0147)? Asked of the probe by the press
  // itself, never a flag another screen remembered (L1-1).
  const clientSide = await clientConfirmsReady();
  const tickSide = await tickMeasuresReady();

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
      parsed.seen.clientId !== current.client_id ||
      // The figures the card printed (0147): a re-weigh that landed after the
      // page was drawn is a lot the person did not see.
      (parsed.seen.kg !== undefined && Number(parsed.seen.kg) !== Number(lot.total_kg)) ||
      (parsed.seen.m3 !== undefined && Number(parsed.seen.m3) !== Number(lot.total_m3))
    ) {
      throw new LotCheckError('lot_changed');
    }

    // What the tick will remember (0147): the lot's figures as a list prints
    // them, read under the lock. A lot whose totals cannot be a measure (NaN,
    // negative — the column CHECK refuses them) remembers none, which holds.
    const measured = tickSide && isMeasure(lot.shown_kg) && isMeasure(lot.shown_m3);
    const seenKg = measured ? lot.shown_kg : null;
    const seenM3 = measured ? lot.shown_m3 : null;

    const prev = await lockCheckRow(tx, lot.id, tickSide);
    const holdsNow =
      prev !== null &&
      prev.seen_name_zh === lot.name_zh &&
      prev.seen_name_ru === lot.name_ru &&
      Number(prev.seen_box_count) === lot.box_count &&
      prev.seen_client_id === current.client_id &&
      // A snapshot that remembers no measures says LESS than this press would
      // (0146's rule for a basic answer): the same person's re-tick is WRITTEN.
      (!tickSide || (prev.seen_kg === seenKg && prev.seen_m3 === seenM3));
    // The client's own answer (0144). A ❌ not older than the standing tick
    // outranks it (`lotCheckStateSql`, arm 3), so the same press by the same
    // person is then NOT «already confirmed»: it must write, and its new
    // `checked_at` is what lifts the ❌. And the press must have SEEN the
    // answer it lifts.
    const answer = await clientAnswerFor(tx, lot.id, current.client_id, clientSide);
    if (holdsNow && prev.note === note && prev.checked_by === actor.id && !answer.outranksTick) return { changed: false };
    if ((prev?.checked_at ?? null) !== parsed.seenCheckedAt) throw new LotCheckError('check_changed');
    if (parsed.seenClientAt !== undefined && answer.token !== parsed.seenClientAt) throw new LotCheckError('check_changed');

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
    // The two measures (0147) — SQL-only columns, so a statement of their own
    // beside the upsert, in the same transaction and under the same locks.
    // ALWAYS written where the columns exist: a re-tick must not keep the
    // kilos an earlier tick remembered (the upsert's SET does not name them).
    if (tickSide) {
      await tx.execute(sql`
        UPDATE lot_checks SET seen_kg = ${seenKg}::numeric, seen_m3 = ${seenM3}::numeric
         WHERE lot_id = ${lot.id}::uuid
      `);
    }

    const codes = await clientCodesOf(tx, [current.client_id, ...(prev ? [prev.seen_client_id] : [])]);
    const keys = lotCheckAuditKeys(lot.letter);
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before: {
        [keys.check]: prev
          ? summary(prev.seen_name_zh, prev.seen_name_ru, Number(prev.seen_box_count), codes.get(prev.seen_client_id) ?? null, {
              kg: prev.seen_kg,
              m3: prev.seen_m3,
            })
          : null,
        [keys.note]: prev?.note ?? null,
      },
      after: {
        // A re-tick past the client's ❌ changes no word of the snapshot —
        // the History must still show that somebody answered for it.
        [keys.check]:
          summary(lot.name_zh, lot.name_ru, lot.box_count, codes.get(current.client_id) ?? null, { kg: seenKg, m3: seenM3 }) +
          (answer.outranksTick ? ' · mijozning ❌ idan keyin qayta tasdiqlandi' : ''),
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
  /** The measures it remembered (0147), as the database's text; null = none (or a server before 0147). */
  seen_kg: string | null;
  seen_m3: string | null;
  note: string | null;
  checked_by: string;
  checked_at: string;
}

/**
 * The person's check, FOR UPDATE, with `checked_at` as TEXT — the token the
 * panel posts back. Its two measures only where their columns exist
 * (`tickSide`, the probe's answer — 0147).
 */
async function lockCheckRow(tx: Tx, lotId: string, tickSide: boolean): Promise<CheckRow | null> {
  const rows = (await tx.execute(sql`
    SELECT seen_name_zh, seen_name_ru, seen_box_count, seen_client_id,
           ${tickSide ? sql`seen_kg::text AS seen_kg, seen_m3::text AS seen_m3` : sql`NULL::text AS seen_kg, NULL::text AS seen_m3`},
           note, checked_by, checked_at::text AS checked_at
      FROM lot_checks WHERE lot_id = ${lotId}::uuid FOR UPDATE
  `)) as unknown as CheckRow[];
  return rows[0] ?? null;
}

/** A figure the tick may remember: finite and not negative (the column's CHECK). */
function isMeasure(text: string): boolean {
  const value = Number(text);
  return text !== '' && Number.isFinite(value) && value >= 0;
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
  // On the pool, before the transaction (#714, L1-1).
  const tickSide = await tickMeasuresReady();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const lot = await lockLot(tx, parsed.lotId);
    // The prixod under the same lock order as checkLot: a void in flight
    // answers «busy», one that landed a moment ago is seen.
    await lockReceiptShareNoWait(tx, lot.receipt_id);
    const [current] = (await tx.execute(sql`
      SELECT status FROM receipts WHERE id = ${lot.receipt_id}::uuid
    `)) as unknown as { status: string }[];
    if (!current || current.status !== 'confirmed') throw new LotCheckError('receipt_not_confirmed');
    const row = await lockCheckRow(tx, lot.id, tickSide);
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
        [keys.check]: summary(row.seen_name_zh, row.seen_name_ru, Number(row.seen_box_count), codes.get(row.seen_client_id) ?? null, {
          kg: row.seen_kg,
          m3: row.seen_m3,
        }),
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
  /** The tarkib stands, so it vouches for the lot — «✅ tarkib bo'yicha». */
  byDocument: boolean;
  /** A tarkib exists and no longer matches the lot. */
  documentStale: boolean;
  /** The person's row, when there is one, and which of its terms moved. */
  person: {
    by: string | null;
    at: Date;
    /** `checked_at::text` — the token the panel posts back (`seenCheckedAt`). */
    token: string;
    note: string | null;
    holds: boolean;
    /** Which term moved: `measures` = the kilos or cubic metres it remembered (0147, his «2 b»). */
    moved: { name: boolean; count: boolean; client: boolean; measures: boolean };
    /**
     * It remembers the kilos and cubic metres (0147) — a re-weigh turns it
     * «o'zgardi». False on a server one migration behind and on a tick an
     * old process wrote without them (the NULL arm: it holds through one).
     */
    measures: boolean;
  } | null;
  /**
   * The client's own answer in Telegram (0144, `client-confirm.ts`), when
   * there is one. `holds` = it is about what the lists still show (the same
   * comparison the sentence makes): a ✅ that holds vouches for the lot, a ❌
   * that holds is the veto the card must show; one that does not hold is
   * about data that has since moved.
   */
  client: {
    verdict: 'yes' | 'no';
    at: Date;
    /** `answered_at::text` — the token «E'tirozni yopish» and the tick post back. */
    token: string;
    holds: boolean;
    /**
     * A ❌ that is why the lot reads ❓ right now — computed from the
     * sentence's own state, never re-derived by a page: this owner's ❌ with
     * nothing vouching past it. While true the card leads with the ❌ and
     * draws every ✅ line as history.
     */
    vetoes: boolean;
    /** The answer is the prixod's CURRENT owner's — a previous owner's is nobody's. */
    ofOwner: boolean;
    /**
     * The question asked about the lot's kilos and cubic metres too (0146 —
     * the owner's «4 ha»), and the answer remembers them. False = it was
     * about the name and the count: every answer from before 0146.
     */
    measures: boolean;
    /**
     * …and they are WHY it stopped holding: the five facts every question
     * printed still stand and only the two figures moved. False when
     * something else moved too — the card then says «ma'lumot o'zgardi», as
     * it always has, and never blames a weight for a renamed lot.
     */
    measuresMoved: boolean;
    /** Who pressed «Mijozdan so'rash»; null = the receipt's own push asked. */
    askedBy: string | null;
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
  // The client's answers only where their table exists (0144, #472): one
  // migration behind, the card draws the two bases it has always drawn.
  const withClient = lotClientConfirmsReady();
  // …and their two measures only where THOSE columns exist (0146).
  const measureColumns =
    withClient && lotClientMeasuresReady()
      ? sql`(lot_client.shown_kg IS NOT NULL) AS client_measures,
             (${clientFactsHoldSql(refs)} AND NOT ${clientMeasuresHoldSql(sql`l`)}) AS client_measures_moved`
      : sql`FALSE AS client_measures, FALSE AS client_measures_moved`;
  const clientColumns = withClient
    ? sql`lot_client.verdict AS client_verdict, lot_client.answered_at AS client_at,
           lot_client.answered_at::text AS client_token,
           ${clientHoldsSql(refs)} AS client_holds, ${clientDisputeSql(refs)} AS client_dispute,
           (lot_client.shown_client_id IS NOT DISTINCT FROM r.client_id) AS client_of_owner,
           ua.full_name AS client_asked_by, ${measureColumns}`
    : sql`NULL::text AS client_verdict, NULL::timestamptz AS client_at, NULL::text AS client_token,
           NULL::boolean AS client_holds, NULL::boolean AS client_dispute, NULL::boolean AS client_of_owner,
           NULL::text AS client_asked_by, ${measureColumns}`;
  const clientJoins = withClient
    ? sql`LEFT JOIN lot_client_confirms AS lot_client ON lot_client.lot_id = l.id
      LEFT JOIN users ua ON ua.id = lot_client.asked_by`
    : sql``;
  const rows = (await exec.execute(sql`
    SELECT l.id AS lot_id,
           ${lotCheckStateSql(refs)} AS state,
           ${lotAskableSql(sql`l`)} AS askable,
           ${tarkibStandsSql(sql`l`)} AS document_stands,
           (lot_tarkib.lot_id IS NOT NULL) AS has_document,
           lc.lot_id IS NOT NULL AS has_person,
           ${terms.name} AS name_ok,
           ${terms.count} AS count_ok,
           ${terms.client} AS client_ok,
           ${terms.measures} AS measures_ok,
           ${lotTickMeasuresReady() ? sql`(lc.seen_kg IS NOT NULL)` : sql`FALSE`} AS person_measures,
           lc.note, lc.checked_at::text AS checked_at, u.full_name AS checked_by,
           ${clientColumns}
      FROM receipt_lots l
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN lot_checks lc ON lc.lot_id = l.id
      LEFT JOIN ${lotTarkibJoinSql()} ON lot_tarkib.lot_id = l.id
      LEFT JOIN users u ON u.id = lc.checked_by
      ${clientJoins}
     WHERE l.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as {
    lot_id: string;
    state: LotCheckState;
    askable: boolean;
    document_stands: boolean | null;
    has_document: boolean;
    has_person: boolean;
    name_ok: boolean | null;
    count_ok: boolean | null;
    client_ok: boolean | null;
    measures_ok: boolean | null;
    person_measures: boolean | null;
    note: string | null;
    checked_at: string | null;
    checked_by: string | null;
    client_verdict: 'yes' | 'no' | null;
    client_at: string | Date | null;
    client_token: string | null;
    client_holds: boolean | null;
    client_dispute: boolean | null;
    client_of_owner: boolean | null;
    client_asked_by: string | null;
    client_measures: boolean | null;
    client_measures_moved: boolean | null;
  }[];
  return new Map(
    rows.map((row) => {
      // The sentence's own four terms (`checkTermsSql`): a holding tick here is
      // exactly a `ticked` there, or the card would draw ✅ beside a lot every
      // list calls «o'zgardi».
      const moved = {
        name: row.name_ok !== true,
        count: row.count_ok !== true,
        client: row.client_ok !== true,
        measures: row.measures_ok !== true,
      };
      return [
        row.lot_id,
        {
          state: row.state,
          askable: row.askable === true,
          // Any standing tarkib vouches (2026-11-10 — the screens print its
          // name now, `receipts/lot-name.ts`); one that no longer matches the
          // lot is «the tarkib moved».
          byDocument: row.document_stands === true,
          documentStale: row.has_document && row.document_stands !== true,
          person: row.has_person
            ? {
                by: row.checked_by,
                at: new Date(row.checked_at!),
                token: row.checked_at!,
                note: row.note,
                holds: !moved.name && !moved.count && !moved.client && !moved.measures,
                moved,
                measures: row.person_measures === true,
              }
            : null,
          client: row.client_verdict
            ? {
                verdict: row.client_verdict,
                at: new Date(row.client_at!),
                token: row.client_token!,
                holds: row.client_holds === true,
                // The sentence's arm 5: this owner's ❌, and nothing vouched
                // past it (the state would be «checked» if anything had).
                vetoes: row.client_dispute === true && row.state === 'none',
                ofOwner: row.client_of_owner === true,
                askedBy: row.client_asked_by,
                measures: row.client_measures === true,
                measuresMoved: row.client_measures === true && row.client_measures_moved === true,
              }
            : null,
        },
      ];
    }),
  );
}
