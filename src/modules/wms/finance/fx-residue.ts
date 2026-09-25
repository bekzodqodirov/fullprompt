import { sql, type SQL } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { Db, Tx } from '../../platform/db/client';
import { clientTransactions, partnerTransactions } from '../../platform/db/schema';
import { writeAuditMany, type AuditContext } from '../../platform/audit/service';
import { CLIENT_NATIVE_SIGN, LEDGER_RULES, type ClientKind } from './ledger-kinds';
import { PARTNER_NATIVE_SIGN, partnerSignedSql } from '../partners/ledger-sign';

/**
 * Q14 (the owner's answer A, 2026-09-25): «qarz o'z valyutasida 0 ga tushsa,
 * tizim o'zi kurs farqini yozib dollar qoldig'ini yopsin».
 *
 * Every ledger row freezes its own dollars at its own day's rate, so a
 * 12,500,000 so'm charge paid with 12,500,000 so'm a month later reads
 * «$23.44 qarz» for ever — and the handover gate refuses the cargo over it.
 * The account's OWN money says the truth (zero); the dollars carry the rate
 * move. So wherever a currency's running native sum returns to zero, the
 * rows up to there are a closed CYCLE, and the system writes one `fx_diff`
 * row on the row that closed it: native 0, dollars = −(the cycle's residue).
 * The balance reads 0, the gate sees 0, and the P&L's «Kurs farqi» line says
 * what the company won or lost.
 *
 * The rule has ONE home, in SQL (`fxWalkSql`), because the handover deferral
 * needs it in SQL too (#513); there is no JS twin. `reconcileFxResidueTx`
 * runs in the SAME transaction as every write that can move a cycle (fence
 * F2), under a per-account advisory lock taken before any row is written:
 * a post-commit reconcile that a crash skipped would leave a client blocked
 * at the warehouse until a sweep ran.
 *
 * USD rows never walk (a USD residue is zero by construction) and a
 * cross-currency account closes nothing by itself (a dollar bill paid in
 * so'm) — that is the accountant's «Kurs farqi bilan yopish» (Q24 b), a USD
 * row this module never touches.
 */

export type FxLedger = 'client' | 'partner';

const LEDGERS = {
  client: { table: sql.raw('client_transactions'), owner: sql.raw('client_id'), deal: sql.raw('t.deal_id') },
  partner: { table: sql.raw('partner_transactions'), owner: sql.raw('partner_id'), deal: sql.raw('NULL::uuid') },
} as const;

/** The native amount a row moves its currency by — built from the sign tables, never typed input. */
export function nativeSql(ledger: FxLedger, a = 't'): SQL {
  const signs: Record<string, 1 | -1 | 'signed'> = ledger === 'client' ? CLIENT_NATIVE_SIGN : PARTNER_NATIVE_SIGN;
  const arms = Object.entries(signs).map(([kind, sign]) =>
    sql.raw(`WHEN '${kind}' THEN ${sign === -1 ? `-${a}.amount` : `${a}.amount`}`),
  );
  return sql`(CASE ${sql.raw(a)}.type ${sql.join(arms, sql` `)} ELSE 0 END)`;
}

/** The dollars a row adds to the balance: the ledger's own sign on amount_usd, on alias `a`. */
function signedUsdSql(ledger: FxLedger, a = 't'): SQL {
  if (ledger === 'partner') return partnerSignedSql('amount_usd', a);
  const arms = (Object.keys(LEDGER_RULES) as ClientKind[]).map((kind) => {
    const balance = LEDGER_RULES[kind].balance;
    return sql.raw(`WHEN '${kind}' THEN ${balance === -1 ? `-${a}.amount_usd` : `${a}.amount_usd`}`);
  });
  return sql`(CASE ${sql.raw(a)}.type ${sql.join(arms, sql` `)} ELSE ${sql.raw(a)}.amount_usd END)`;
}

/** `since` as the walk's «fresh» test — built in JS, never an untyped `$n IS NULL` (#156). */
function freshSql(since: string | null): SQL {
  return since && !Number.isNaN(Date.parse(since)) ? sql`(t.created_at >= ${since}::timestamptz)` : sql`true`;
}

/**
 * «Where does a currency's running native sum return to zero?» — the live,
 * non-fx_diff, non-USD rows of `owners` (a predicate on `t`; pass `sql.join`
 * lists — a bound JS array is not a postgres array), ordered
 * (tx_date, created_at, id) per owner and currency. `amount` is
 * numeric(14,2), so `run = 0` is exact. Columns: id, owner_id, currency,
 * tx_date, created_at, created_by, usd (signed as the balance adds it),
 * deal_id, fresh, pos, run, last_zero_pos, cycle_no.
 */
export function fxWalkSql(ledger: FxLedger, owners: SQL, since: string | null): SQL {
  const L = LEDGERS[ledger];
  return sql`
    SELECT w.*,
           max(w.pos) FILTER (WHERE w.run = 0) OVER (PARTITION BY w.owner_id, w.currency) AS last_zero_pos,
           coalesce(sum(CASE WHEN w.run = 0 THEN 1 ELSE 0 END) OVER (
             PARTITION BY w.owner_id, w.currency ORDER BY w.pos
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cycle_no
      FROM (
        SELECT t.id, t.${L.owner} AS owner_id, t.currency, t.tx_date, t.created_at, t.created_by,
               ${signedUsdSql(ledger)} AS usd,
               ${L.deal} AS deal_id,
               ${freshSql(since)} AS fresh,
               row_number() OVER o AS pos,
               sum(${nativeSql(ledger)}) OVER (o ROWS UNBOUNDED PRECEDING) AS run
          FROM ${L.table} t
         WHERE t.voided_at IS NULL AND t.type <> 'fx_diff' AND t.currency <> 'USD' AND ${owners}
        WINDOW o AS (PARTITION BY t.${L.owner}, t.currency ORDER BY t.tx_date, t.created_at, t.id)
      ) w`;
}

export interface FxCycle {
  ledger: FxLedger;
  ownerId: string;
  currency: string;
  cycleNo: number;
  /** The cycle ends at a native zero. */
  closed: boolean;
  /** The row where it closed (null while open). */
  anchorId: string | null;
  anchorDate: string | null;
  anchorCreatedBy: string | null;
  /** Σ of its rows' dollars as the balance adds them, in integer cents. */
  residueCents: number;
  /** Every row typed on or after `fx_residue_since`. */
  allFresh: boolean;
  rowIds: string[];
  /** A kurs farqi row (live OR voided) in this currency was ever anchored on a row of this cycle. */
  managed: boolean;
  /** A live USD row of this owner, dated on or after the anchor, whose dollars cancel the residue (±1¢). */
  usdOffset: boolean;
  /** Partner: a live USD adjust dated on or after the anchor that nobody has classified. */
  usdAdjustOpen: boolean;
  /** Partner: a live USD adjust dated on or after the anchor classified «kurs farqi». */
  usdAdjustFx: boolean;
  /** Partner: the unclassified or fx-classified USD adjusts named for the list. */
  usdAdjusts: { id: string; txDate: string; usd: number; kind: string | null }[];
}

/** Anything that can run a read: the pool, a transaction, or `withoutJit`'s handle. */
type Handle = Pick<Db, 'execute'>;

/** The owners predicate, as a join of cast literals — never a bound JS array. */
export function ownersSql(ledger: FxLedger, ids: string[]): SQL {
  const col = sql.raw(`t.${ledger === 'client' ? 'client_id' : 'partner_id'}`);
  if (ids.length === 0) return sql`false`;
  return sql`${col} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/**
 * The cycles of some owners, one statement per ledger — the reconciler, the
 * legacy list, the deploy script and the re-price plan all read this.
 * Dates come back as TEXT from a raw execute (#923): used only as strings.
 *
 * «Is there a USD row after the anchor that cancels it / an adjust nobody
 * classified» is ONE join of the owners' live USD rows onto the closed
 * cycles (`after`), not an EXISTS per cycle: that was a scan of the owner's
 * rows for every cycle — measured on 60k client rows (17,560 cycles) at
 * ~600 ms of the company-wide walk, the whole of what the «Kurs qoldiqlari»
 * list and the P&L's count paid beyond the walk itself.
 */
export async function fxCyclesFor(
  handle: Handle,
  ledger: FxLedger,
  owners: SQL,
  since: string | null,
): Promise<FxCycle[]> {
  const L = LEDGERS[ledger];
  const partner = ledger === 'partner';
  const rows = (await handle.execute(sql`
    WITH w AS (${fxWalkSql(ledger, owners, since)}),
    c AS (
      SELECT w.owner_id, w.currency, w.cycle_no,
             bool_or(w.run = 0) AS closed,
             (array_agg(w.id) FILTER (WHERE w.run = 0))[1] AS anchor_id,
             (array_agg(w.tx_date::text) FILTER (WHERE w.run = 0))[1] AS anchor_date,
             (array_agg(w.created_by) FILTER (WHERE w.run = 0))[1] AS anchor_created_by,
             round(sum(w.usd) * 100)::bigint AS residue_cents,
             bool_and(w.fresh) AS all_fresh,
             array_agg(w.id) AS row_ids
        FROM w
       GROUP BY w.owner_id, w.currency, w.cycle_no
    ),
    usd AS (
      SELECT t.${L.owner} AS owner_id, t.id, t.type, t.tx_date, t.created_at, t.amount_usd,
             ${partner ? sql`t.adjust_kind` : sql`NULL::text`} AS adjust_kind,
             ${signedUsdSql(ledger)} * 100 AS cents
        FROM ${L.table} t
       WHERE t.voided_at IS NULL AND t.currency = 'USD' AND t.type <> 'fx_diff' AND ${owners}
    ),
    after AS (
      SELECT c.owner_id, c.currency, c.cycle_no,
             bool_or(abs(u.cents + c.residue_cents) <= 1) AS usd_offset,
             bool_or(u.type = 'adjust' AND u.adjust_kind IS NULL) AS usd_adjust_open,
             bool_or(u.type = 'adjust' AND u.adjust_kind = 'fx') AS usd_adjust_fx,
             json_agg(json_build_object('id', u.id, 'txDate', u.tx_date::text, 'usd', u.amount_usd, 'kind', u.adjust_kind)
                      ORDER BY u.tx_date, u.created_at)
               FILTER (WHERE u.type = 'adjust' AND (u.adjust_kind IS NULL OR u.adjust_kind = 'fx')) AS usd_adjusts
        FROM c
        JOIN usd u ON u.owner_id = c.owner_id AND u.tx_date >= c.anchor_date::date
       WHERE c.anchor_date IS NOT NULL
       GROUP BY c.owner_id, c.currency, c.cycle_no
    )
    SELECT c.*,
           EXISTS (SELECT 1 FROM ${L.table} f
                    WHERE f.type = 'fx_diff' AND f.currency = c.currency AND f.fx_anchor_id = ANY(c.row_ids)) AS managed,
           coalesce(a.usd_offset, false) AS usd_offset,
           ${
             partner
               ? sql`coalesce(a.usd_adjust_open, false) AS usd_adjust_open,
           coalesce(a.usd_adjust_fx, false) AS usd_adjust_fx,
           coalesce(a.usd_adjusts, '[]'::json) AS usd_adjusts`
               : sql`false AS usd_adjust_open, false AS usd_adjust_fx, '[]'::json AS usd_adjusts`
           }
      FROM c
      LEFT JOIN after a ON a.owner_id = c.owner_id AND a.currency = c.currency AND a.cycle_no = c.cycle_no
     ORDER BY c.owner_id, c.currency, c.cycle_no
  `)) as unknown as {
    owner_id: string;
    currency: string;
    cycle_no: string | number;
    closed: boolean;
    anchor_id: string | null;
    anchor_date: string | null;
    anchor_created_by: string | null;
    residue_cents: string | number;
    all_fresh: boolean;
    row_ids: string[];
    managed: boolean;
    usd_offset: boolean;
    usd_adjust_open: boolean;
    usd_adjust_fx: boolean;
    usd_adjusts: { id: string; txDate: string; usd: string | number; kind: string | null }[] | string;
  }[];
  return [...rows].map((row) => {
    const adjusts = typeof row.usd_adjusts === 'string' ? JSON.parse(row.usd_adjusts) : row.usd_adjusts;
    return {
      ledger,
      ownerId: row.owner_id,
      currency: row.currency,
      cycleNo: Number(row.cycle_no),
      closed: row.closed === true,
      anchorId: row.closed ? row.anchor_id : null,
      anchorDate: row.closed ? row.anchor_date : null,
      anchorCreatedBy: row.closed ? row.anchor_created_by : null,
      residueCents: Number(row.residue_cents),
      allFresh: row.all_fresh === true,
      rowIds: row.row_ids,
      managed: row.managed === true,
      usdOffset: row.usd_offset === true,
      usdAdjustOpen: row.usd_adjust_open === true,
      usdAdjustFx: row.usd_adjust_fx === true,
      usdAdjusts: (adjusts ?? []).map((a: { id: string; txDate: string; usd: string | number; kind: string | null }) => ({
        id: a.id,
        txDate: a.txDate,
        usd: Number(a.usd),
        kind: a.kind,
      })),
    };
  });
}

/**
 * Which cycles the SYSTEM closes (the owner's Q14 A) — one pure predicate the
 * reconciler, the legacy list and the re-price plan all ask.
 *
 * The two ledgers differ on history on purpose (the owner judge): the client
 * ledger never had a hand close (production held only charge/payment), so
 * its history is the system's unless a same-size USD row after the anchor
 * already cancels the residue; the partner ledger has #415's documented hand
 * close (a signed USD adjust), so a partner cycle holding any row typed
 * before the deploy is closed by a PERSON on /accounting/kurs-farqi. «All
 * rows fresh», not the anchor's own time, is what keeps a void + re-entry of
 * a legacy closing payment from posting beside the hand adjust.
 */
export function isAutomatic(c: Pick<FxCycle, 'closed' | 'residueCents' | 'managed' | 'allFresh' | 'ledger' | 'usdOffset'>, autoOn: boolean): boolean {
  if (!c.closed || c.residueCents === 0) return false;
  if (c.managed) return true; // once managed, maintained — even with the switch off
  if (!autoOn) return false; // the kill-switch: nothing NEW
  if (c.allFresh) return true; // typed after the deploy
  return c.ledger === 'client' && !c.usdOffset; // client history is the system's
}

export type LegacyState = 'auto' | 'hand' | 'check' | 'closable';

/**
 * A closed, non-zero cycle nobody manages — what the «Kurs qoldiqlari» list
 * says about it. `hand`: a person already booked this residue as a partner
 * «kurs farqi» adjust (it is in the P&L as fx:adjust; closing it again would
 * count it twice). `check`: a USD adjust nobody classified, or a same-size
 * USD row, may already have closed it — the person decides. `auto`: the
 * system closes it itself. `closable`: a firm's residue a person closes.
 */
export function legacyState(
  c: Pick<FxCycle, 'closed' | 'residueCents' | 'managed' | 'allFresh' | 'ledger' | 'usdOffset' | 'usdAdjustOpen' | 'usdAdjustFx'>,
  autoOn: boolean,
): LegacyState {
  if (isAutomatic(c, autoOn)) return 'auto';
  if (c.ledger === 'partner' && c.usdAdjustFx) return 'hand';
  if ((c.ledger === 'partner' && c.usdAdjustOpen) || c.usdOffset) return 'check';
  return 'closable';
}

/**
 * The per-account money locks — ONE namespace for every writer of an
 * account (the refund cap's, the reconciler's, the re-price's). Clients
 * BEFORE partners, each sorted, so two writers never wait on each other in
 * opposite orders. Transaction-scoped and re-entrant, so a writer may take it
 * and the reconciler take it again.
 */
export async function lockOwnersTx(tx: Tx, owners: { clientIds?: string[]; partnerIds?: string[] }): Promise<void> {
  for (const id of [...new Set(owners.clientIds ?? [])].filter(Boolean).sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('client-money'), hashtext(${id}::text))`);
  }
  for (const id of [...new Set(owners.partnerIds ?? [])].filter(Boolean).sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('partner-money'), hashtext(${id}::text))`);
  }
}

/** The two settings, read through the transaction — never `getSetting` (the pool, #714). */
export async function fxSettingsTx(tx: Handle): Promise<{ since: string | null; autoOn: boolean }> {
  const rows = (await tx.execute(sql`
    SELECT key, value #>> '{}' AS v FROM settings WHERE key IN ('fx_residue_since', 'fx_residue_auto')
  `)) as unknown as { key: string; v: string | null }[];
  const found = new Map([...rows].map((row) => [row.key, row.v]));
  const since = found.get('fx_residue_since') ?? null;
  const auto = found.get('fx_residue_auto');
  return { since: since && !Number.isNaN(Date.parse(since)) ? since : null, autoOn: auto === undefined || auto === null ? true : auto !== 'false' };
}

export interface FxChange {
  ledger: FxLedger;
  ownerId: string;
  anchorId: string;
  currency: string;
  /** The P&L month of the change, YYYY-MM. */
  month: string;
  /** The row's dollars (−residue); the P&L effect is FX_PNL_SIGN × this. */
  amountUsd: number;
  action: 'create' | 'void';
}

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Make the owners' kurs farqi rows match their cycles, in the CALLER's
 * transaction: every automatic closed cycle has exactly one live row of
 * −residue on its anchor, and no other system row stands. Idempotent — a
 * second run finds desired == existing and writes nothing. Reads nothing on
 * the pool (#714).
 */
export async function reconcileFxResidueTx(
  tx: Tx,
  owners: { clientIds?: string[]; partnerIds?: string[] },
  ctx: AuditContext,
  /** What the audit rows say wrote them — the deploy script says `fx_history`. */
  source: 'fx_residue' | 'fx_history' = 'fx_residue',
): Promise<FxChange[]> {
  const clientIds = [...new Set(owners.clientIds ?? [])].filter(Boolean);
  const partnerIds = [...new Set(owners.partnerIds ?? [])].filter(Boolean);
  if (clientIds.length === 0 && partnerIds.length === 0) return [];
  await lockOwnersTx(tx, { clientIds, partnerIds });
  const { since, autoOn } = await fxSettingsTx(tx);
  const changes: FxChange[] = [];
  const audits: Parameters<typeof writeAuditMany>[2] = [];

  for (const [ledger, ids] of [
    ['client', clientIds],
    ['partner', partnerIds],
  ] as const) {
    if (ids.length === 0) continue;
    const ownerCol = sql.raw(ledger === 'client' ? 'client_id' : 'partner_id');
    const cycles = await fxCyclesFor(tx, ledger, ownersSql(ledger, ids), since);
    const desired = new Map<string, FxCycle>();
    for (const cycle of cycles) {
      if (isAutomatic(cycle, autoOn) && cycle.anchorId) desired.set(`${cycle.anchorId}|${cycle.currency}`, cycle);
    }
    // The system's rows are in the cycle's currency; a USD row is the
    // accountant's own cross-currency close (Q24 b) and is not ours to move.
    const existing = (await tx.execute(sql`
      SELECT t.id, t.${ownerCol} AS owner_id, t.fx_anchor_id AS anchor_id, t.currency, t.amount_usd, t.tx_date::text AS tx_date
        FROM ${sql.raw(ledger === 'client' ? 'client_transactions' : 'partner_transactions')} t
       WHERE t.type = 'fx_diff' AND t.voided_at IS NULL AND t.currency <> 'USD' AND ${ownersSql(ledger, ids)}
    `)) as unknown as { id: string; owner_id: string; anchor_id: string; currency: string; amount_usd: string; tx_date: string }[];

    const kept = new Set<string>();
    const voids: typeof existing = [];
    for (const row of existing) {
      const key = `${row.anchor_id}|${row.currency}`;
      const want = desired.get(key);
      if (want && !kept.has(key) && Math.round(Number(row.amount_usd) * 100) === -want.residueCents) {
        kept.add(key);
      } else {
        voids.push(row);
      }
    }
    if (voids.length) {
      const voidedAt = new Date();
      await tx.execute(sql`
        UPDATE ${sql.raw(ledger === 'client' ? 'client_transactions' : 'partner_transactions')}
           SET voided_at = ${voidedAt.toISOString()}::timestamptz, voided_by = ${ctx.actorId}::uuid,
               void_reason = 'kurs farqi qayta hisoblandi'
         WHERE id IN (${sql.join(
           voids.map((row) => sql`${row.id}::uuid`),
           sql`, `,
         )}) AND voided_at IS NULL`);
      for (const row of voids) {
        changes.push({
          ledger,
          ownerId: row.owner_id,
          anchorId: row.anchor_id,
          currency: row.currency,
          month: row.tx_date.slice(0, 7),
          amountUsd: -Number(row.amount_usd),
          action: 'void',
        });
        audits.push({
          entityType: ledger === 'client' ? 'client_transaction' : 'partner_transaction',
          entityId: row.id,
          action: 'void',
          after: { from: source, anchorId: row.anchor_id, currency: row.currency, residueUsd: -Number(row.amount_usd) },
        });
      }
    }
    const inserts = [...desired.entries()].filter(([key]) => !kept.has(key)).map(([, cycle]) => cycle);
    if (inserts.length) {
      const values = inserts.map((cycle) => {
        const amountUsd = cents(-cycle.residueCents / 100);
        const base = {
          id: uuidv4(),
          type: 'fx_diff' as const,
          amount: '0',
          currency: cycle.currency,
          rateToUsd: '0',
          amountUsd: amountUsd.toFixed(2),
          txDate: cycle.anchorDate!,
          fxAnchorId: cycle.anchorId!,
          // Never NULL: the ledger screens INNER-join the author (#600).
          createdBy: ctx.actorId ?? cycle.anchorCreatedBy!,
        };
        return { cycle, base };
      });
      if (ledger === 'client') {
        await tx.insert(clientTransactions).values(values.map(({ cycle, base }) => ({ ...base, clientId: cycle.ownerId })));
      } else {
        await tx.insert(partnerTransactions).values(values.map(({ cycle, base }) => ({ ...base, partnerId: cycle.ownerId })));
      }
      for (const { cycle, base } of values) {
        changes.push({
          ledger,
          ownerId: cycle.ownerId,
          anchorId: base.fxAnchorId,
          currency: base.currency,
          month: base.txDate.slice(0, 7),
          amountUsd: Number(base.amountUsd),
          action: 'create',
        });
        audits.push({
          entityType: ledger === 'client' ? 'client_transaction' : 'partner_transaction',
          entityId: base.id,
          action: 'create',
          after: { from: source, anchorId: base.fxAnchorId, currency: base.currency, residueUsd: cycle.residueCents / 100 },
        });
      }
    }
  }
  if (audits.length) await writeAuditMany(tx, ctx, audits);
  return changes;
}
