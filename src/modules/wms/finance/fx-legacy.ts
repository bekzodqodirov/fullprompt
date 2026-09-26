import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, type Db } from '../../platform/db/client';
import { withoutJit } from '../../platform/db/no-jit';
import {
  clients,
  clientTransactions,
  partners,
  partnerTransactions,
  partnerTypes,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import {
  fxCyclesFor,
  fxSettingsTx,
  legacyState,
  lockOwnersTx,
  ownersSql,
  reconcileFxResidueTx,
  type FxCycle,
  type FxLedger,
  type LegacyState,
} from './fx-residue';
import { staffPartnerSql } from '../partners/staff';

/**
 * «Kurs qoldiqlari» (0103, design §5.5.8) — the residues from BEFORE the
 * deploy that nobody's rule closes by itself.
 *
 * A cycle is LEGACY when it closed at a native zero with dollars left over and
 * no kurs farqi row was ever anchored on it (`managed`). The reconciler closes
 * a client's by itself on that client's next write (`auto` — the deploy
 * script only brings it forward); a firm's is closed by a PERSON here, because
 * #415 documented a hand close (a signed USD adjust) and closing it again
 * would count it twice (`hand` / `check`, `legacyState`).
 *
 * Every read is on the POOL and every write takes the account's own money
 * lock inside its transaction (#714); the same walk as the reconciler.
 */

export class FxLegacyError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface LegacyFxRow {
  ledger: FxLedger;
  ownerId: string;
  /** The client code; null for a firm. */
  code: string | null;
  name: string;
  staff: boolean;
  currency: string;
  anchorId: string;
  /** The day the currency hit zero — the P&L month the close lands in. */
  anchorDate: string;
  /** The dollars left over, as the balance adds them (+ = the account still reads «owes»). */
  residueUsd: number;
  state: LegacyState;
  usdAdjusts: FxCycle['usdAdjusts'];
}

/** Closed at a native zero, dollars left, nobody manages it. */
export function isLegacyCycle(c: Pick<FxCycle, 'closed' | 'residueCents' | 'managed' | 'anchorId'>): boolean {
  return c.closed && c.residueCents !== 0 && !c.managed && c.anchorId !== null;
}

const STATE_ORDER: Record<LegacyState, number> = { auto: 0, check: 1, closable: 2, hand: 3 };

async function legacyCycles(
  ledger: FxLedger,
  owners: SQL,
  exec: Pick<Db, 'execute'> = db,
): Promise<{ cycle: FxCycle; state: LegacyState }[]> {
  const { since, autoOn } = await fxSettingsTx(exec);
  const cycles = await fxCyclesFor(exec, ledger, owners, since);
  return cycles.filter(isLegacyCycle).map((cycle) => ({ cycle, state: legacyState(cycle, autoOn) }));
}

/**
 * Every legacy residue, one row per cycle. Staff accounts only for whoever
 * may see staff money (`includeStaff` = `maySeeStaffMoney`, M3a).
 */
export async function legacyFxResidues(opts: { includeStaff: boolean }): Promise<LegacyFxRow[]> {
  // The whole company's walk: JIT off (measured on 60k client rows, 1.2 s of
  // which the compile was ~0.55 s; `platform/db/no-jit.ts`).
  const [clientCycles, partnerCycles] = await Promise.all([
    withoutJit((exec) => legacyCycles('client', sql`true`, exec)),
    withoutJit((exec) => legacyCycles('partner', sql`true`, exec)),
  ]);
  const clientIds = [...new Set(clientCycles.map(({ cycle }) => cycle.ownerId))];
  const partnerIds = [...new Set(partnerCycles.map(({ cycle }) => cycle.ownerId))];
  const [clientRows, partnerRows] = await Promise.all([
    clientIds.length
      ? db
          .select({ id: clients.id, code: clients.clientCode, name: clients.name })
          .from(clients)
          .where(inArray(clients.id, clientIds))
      : Promise.resolve([]),
    partnerIds.length
      ? db
          .select({ id: partners.id, name: partners.name, staff: sql<boolean>`${staffPartnerSql()}` })
          .from(partners)
          .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
          .where(inArray(partners.id, partnerIds))
      : Promise.resolve([]),
  ]);
  const clientById = new Map(clientRows.map((row) => [row.id, row]));
  const partnerById = new Map(partnerRows.map((row) => [row.id, row]));
  const rows: LegacyFxRow[] = [];
  const push = ({ cycle, state }: { cycle: FxCycle; state: LegacyState }, owner: { code: string | null; name: string; staff: boolean }) =>
    rows.push({
      ledger: cycle.ledger,
      ownerId: cycle.ownerId,
      code: owner.code,
      name: owner.name,
      staff: owner.staff,
      currency: cycle.currency,
      anchorId: cycle.anchorId!,
      anchorDate: cycle.anchorDate!,
      residueUsd: cycle.residueCents / 100,
      state,
      usdAdjusts: cycle.usdAdjusts,
    });
  for (const entry of clientCycles) {
    const owner = clientById.get(entry.cycle.ownerId);
    if (owner) push(entry, { code: owner.code, name: owner.name, staff: false });
  }
  for (const entry of partnerCycles) {
    const owner = partnerById.get(entry.cycle.ownerId);
    if (!owner) continue;
    if (owner.staff === true && !opts.includeStaff) continue;
    push(entry, { code: null, name: owner.name, staff: owner.staff === true });
  }
  return rows.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.anchorDate.localeCompare(a.anchorDate),
  );
}

/**
 * What the P&L's gap note says: the legacy residues still waiting — `auto`,
 * `check` and `closable`, never `hand` (that one is already in the P&L as a
 * hand adjust). The walk is called by the P&L page ONLY (fence F8) — never
 * from `pnlGaps`, whose other readers (the dashboard, the XLSX) must not pay
 * for a walk of the company's whole history; the kurs-farqi page counts the
 * rows it has already walked (`legacyFxCountOf`), not a second walk.
 */
export async function legacyFxCount(opts: { includeStaff: boolean }): Promise<{ accounts: number; cycles: number; usd: number }> {
  return legacyFxCountOf(await legacyFxResidues(opts));
}

export function legacyFxCountOf(listed: LegacyFxRow[]): { accounts: number; cycles: number; usd: number } {
  const rows = listed.filter((row) => row.state !== 'hand');
  const accounts = new Set(rows.map((row) => `${row.ledger}|${row.ownerId}`)).size;
  const usd = Math.round(rows.reduce((sum, row) => sum + Math.abs(row.residueUsd), 0) * 100) / 100;
  return { accounts, cycles: rows.length, usd };
}

/** Does this one account carry a legacy residue? (the cards' link to «Kurs qoldiqlari»). */
export async function hasLegacyFx(ledger: FxLedger, ownerId: string): Promise<boolean> {
  const cycles = await legacyCycles(ledger, ownersSql(ledger, [ownerId]));
  return cycles.some(({ state }) => state !== 'hand');
}

type LegacyDoor = { mayClassify: boolean; maySeeStaff: boolean };

async function isStaffOwner(ledger: FxLedger, ownerId: string): Promise<boolean> {
  if (ledger !== 'partner') return false;
  const [row] = await db
    .select({ staff: sql<boolean>`${staffPartnerSql()}` })
    .from(partners)
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .where(eq(partners.id, ownerId))
    .limit(1);
  return row?.staff === true;
}

/**
 * Close ONE legacy residue by hand: a kurs farqi row of −residue on the
 * anchor, in one transaction under the account's lock, re-checked there —
 * the list the person pressed on may be minutes old. The cycle is then
 * managed, so the reconciler keeps it for ever (and voids it if a later
 * write reopens the currency). A firm row in `check` must be classified
 * first (its USD adjust may BE this close); a `hand` row is refused (it is
 * already in the P&L).
 */
export async function closeLegacyFxResidue(
  target: { ledger: FxLedger; ownerId: string; anchorId: string; currency: string },
  ctx: AuditContext,
  door: LegacyDoor,
): Promise<{ amountUsd: number }> {
  if (!ctx.actorId) throw new FxLegacyError('unauthenticated');
  if (!door.mayClassify) throw new FxLegacyError('forbidden');
  if (!door.maySeeStaff && (await isStaffOwner(target.ledger, target.ownerId))) throw new FxLegacyError('forbidden');
  const owners = target.ledger === 'client' ? { clientIds: [target.ownerId] } : { partnerIds: [target.ownerId] };
  return db.transaction(async (tx) => {
    await lockOwnersTx(tx, owners);
    const { since, autoOn } = await fxSettingsTx(tx);
    const cycles = await fxCyclesFor(tx, target.ledger, ownersSql(target.ledger, [target.ownerId]), since);
    const cycle = cycles.find((c) => c.anchorId === target.anchorId && c.currency === target.currency);
    if (!cycle || !isLegacyCycle(cycle)) throw new FxLegacyError('fx_legacy_changed');
    const state = legacyState(cycle, autoOn);
    if (state === 'hand') throw new FxLegacyError('fx_legacy_hand');
    if (state === 'check' && target.ledger === 'partner') throw new FxLegacyError('fx_legacy_check');
    const amountUsd = Math.round(-cycle.residueCents) / 100;
    const id = uuidv4();
    const base = {
      id,
      type: 'fx_diff' as const,
      amount: '0',
      currency: cycle.currency,
      rateToUsd: '0',
      amountUsd: amountUsd.toFixed(2),
      txDate: cycle.anchorDate!,
      fxAnchorId: cycle.anchorId!,
      createdBy: ctx.actorId!,
    };
    if (target.ledger === 'client') {
      await tx.insert(clientTransactions).values({ ...base, clientId: target.ownerId });
    } else {
      await tx.insert(partnerTransactions).values({ ...base, partnerId: target.ownerId });
    }
    await reconcileFxResidueTx(tx, owners, ctx);
    await writeAudit(tx, ctx, {
      entityType: target.ledger === 'client' ? 'client_transaction' : 'partner_transaction',
      entityId: id,
      action: 'create',
      after: { from: 'fx_legacy', anchorId: cycle.anchorId, currency: cycle.currency, amountUsd },
    });
    return { amountUsd };
  });
}

/** The bulk close's bound — a press, not a migration (design §5.5.8). */
export const LEGACY_BULK_CAP = 500;

/**
 * «Hammasini yopish»: every `auto` and `closable` row, ONE transaction per
 * account (a client's `auto` cycles are closed by the reconciler itself —
 * the very rule that would close them on the next write), capped and
 * counted. A row that changed since the list was drawn is counted as
 * changed, never forced.
 */
export async function closeAllLegacyFx(
  ctx: AuditContext,
  door: LegacyDoor,
): Promise<{ closed: number; changed: number }> {
  if (!ctx.actorId) throw new FxLegacyError('unauthenticated');
  if (!door.mayClassify) throw new FxLegacyError('forbidden');
  const rows = (await legacyFxResidues({ includeStaff: door.maySeeStaff }))
    .filter((row) => row.state === 'auto' || row.state === 'closable')
    .slice(0, LEGACY_BULK_CAP);
  let closed = 0;
  let changed = 0;
  const autoClients = [...new Set(rows.filter((row) => row.state === 'auto' && row.ledger === 'client').map((row) => row.ownerId))];
  for (const clientId of autoClients) {
    const expected = rows.filter((row) => row.ledger === 'client' && row.ownerId === clientId && row.state === 'auto').length;
    const changes = await db.transaction(async (tx) => {
      await lockOwnersTx(tx, { clientIds: [clientId] });
      return reconcileFxResidueTx(tx, { clientIds: [clientId] }, ctx);
    });
    const made = changes.filter((change) => change.action === 'create').length;
    closed += Math.min(made, expected);
    changed += Math.max(0, expected - made);
  }
  for (const row of rows.filter((entry) => !(entry.state === 'auto' && entry.ledger === 'client'))) {
    try {
      await closeLegacyFxResidue(
        { ledger: row.ledger, ownerId: row.ownerId, anchorId: row.anchorId, currency: row.currency },
        ctx,
        door,
      );
      closed += 1;
    } catch (err) {
      if (!(err instanceof FxLegacyError)) throw err;
      changed += 1;
    }
  }
  return { closed, changed };
}

export interface UnclassifiedAdjust {
  id: string;
  partnerId: string;
  partnerName: string;
  txDate: string;
  amount: number;
  currency: string;
  amountUsd: number;
  note: string | null;
  authorName: string | null;
}

/**
 * The corrections nobody has said the kind of (Q12's split) — the P&L's
 * «turi aytilmagan» gap, row by row, for the two buttons. Newest first,
 * bounded like every list of its kind.
 */
export async function unclassifiedAdjusts(opts: { includeStaff: boolean; limit?: number }): Promise<UnclassifiedAdjust[]> {
  const rows = await db
    .select({
      id: partnerTransactions.id,
      partnerId: partnerTransactions.partnerId,
      partnerName: partners.name,
      staff: sql<boolean>`${staffPartnerSql()}`,
      txDate: partnerTransactions.txDate,
      amount: partnerTransactions.amount,
      currency: partnerTransactions.currency,
      amountUsd: partnerTransactions.amountUsd,
      note: partnerTransactions.note,
      authorName: users.fullName,
    })
    .from(partnerTransactions)
    .innerJoin(partners, eq(partnerTransactions.partnerId, partners.id))
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .leftJoin(users, eq(partnerTransactions.createdBy, users.id))
    .where(
      and(
        eq(partnerTransactions.type, 'adjust'),
        isNull(partnerTransactions.adjustKind),
        isNull(partnerTransactions.voidedAt),
      ),
    )
    .orderBy(desc(partnerTransactions.txDate), asc(partnerTransactions.createdAt))
    .limit(opts.limit ?? 200);
  return rows
    .filter((row) => opts.includeStaff || row.staff !== true)
    .map((row) => ({
      id: row.id,
      partnerId: row.partnerId,
      partnerName: row.partnerName,
      txDate: row.txDate,
      amount: Number(row.amount),
      currency: row.currency,
      amountUsd: Number(row.amountUsd),
      note: row.note,
      authorName: row.authorName,
    }));
}
