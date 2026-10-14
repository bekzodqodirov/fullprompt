import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { costAllocations, costEntries, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { getSetting } from '../../platform/settings/service';
import type { AllocationBasis } from './engine';
import { CostError } from './errors';
import { copyDigest, freightCopyFor, prepareFreightCopy, replaceFreightCopyInTx } from './freight-copy';
import { freightMoneySight } from './freight-offer';
import { bandForSight, bandsSummary, splitCents } from './freight-split';
import type { BandView, FreightCopy, FreightCopyDraft, RebasePreview, RecomputeVerdict } from './freight-types';
import { costPool } from './pool';
import { boxMeasures, recomputeEntry, scopeBoxIds } from './service';

/**
 * The re-basis door (docs/YOLKIRA-TAQSIMOT.md §8, his 5a): a truck bill's
 * split method changed AFTER it was saved, with a per-client «hozir → yangi»
 * preview first. Old bills stay as they are until a person presses this.
 *
 * It moves ONLY the basis, the frozen copy and the shares. Never the amount,
 * the currency, the dollars, the rate, the payer, the kassa, the merge or the
 * firm's charge — that is why it exists beside the void, which refuses a
 * merged cost, needs finance for a kassa-paid one, re-posts a firm's debt and
 * re-converts the dollars.
 *
 * The copy table is touched only when freight is on EITHER side (DS1): a
 * weight → volume re-basis is two tables a database one migration behind
 * already has.
 */

type Entry = typeof costEntries.$inferSelect;
export type RebaseTarget = Exclude<AllocationBasis, 'direct_to_client'>;

const REBASE_TARGETS: readonly string[] = ['weight', 'volume', 'chargeable', 'boxes', 'freight'];
export const isRebaseTarget = (v: unknown): v is RebaseTarget => typeof v === 'string' && REBASE_TARGETS.includes(v);

/** The from side's copy, for a freight bill only (DS1); the literal 'none' otherwise. */
type FromCopy = FreightCopy | 'missing' | 'invalid' | 'none';

const digestOf = (copy: FromCopy | FreightCopyDraft | null): string =>
  copy === null || typeof copy === 'string' ? (copy ?? 'none') : copyDigest(copy);

/**
 * The person's token (the twin idiom): what they SAW — the bill's from-part
 * and the after state, to the hundredth of a percent. A remap, a band edit or
 * a carton boarding between the preview and the press changes it.
 */
function tokenOf(
  entryId: string,
  amountUsd: string | null,
  fromBasis: string,
  fromCopy: FromCopy,
  toBasis: string,
  to: FreightCopyDraft | null,
  rows: [string, number, number][],
  held: unknown,
) {
  const canonical = JSON.stringify([
    entryId,
    // The dollars the «$ → $» columns were drawn from: a first conversion or
    // an /admin/fx re-price in between makes the preview stale (review).
    amountUsd ?? 'none',
    fromBasis,
    digestOf(fromCopy),
    toBasis,
    digestOf(to),
    // The «hozir» column too (a re-split under the current basis between the
    // two presses made it stale), and a held after-state's own lots (WHICH
    // lots are light is what the person read) — fix review.
    [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, before, after]) => [k, before.toFixed(2), after.toFixed(2)]),
    held ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 10000) / 100 : 0);

interface Planned {
  preview: RebasePreview;
  to: FreightCopyDraft | null;
  fromCopy: FromCopy;
}

/**
 * The preview, on the POOL (#714): the target's copy through the save's own
 * door (`prepareFreightCopy`, built from the bill ROW — its scope, truck and
 * date — and the origin's CURRENT column, so every §5 refusal applies), the
 * bill's current shares, and the after state from the recompute's own pool
 * over the recompute's own base.
 */
async function plan(entry: Entry, toBasis: RebaseTarget, money: boolean): Promise<Planned> {
  if (entry.scope !== 'batch' || !entry.batchId) throw new CostError('rebase_batch_only');
  const to = await prepareFreightCopy({
    scope: entry.scope,
    batchId: entry.batchId,
    costTypeId: entry.costTypeId,
    costDate: entry.costDate,
    allocationBasis: toBasis,
  });
  const fromCopy: FromCopy = entry.allocationBasis === 'freight' ? await freightCopyFor(entry.id) : 'none';
  if (toBasis === entry.allocationBasis && (toBasis !== 'freight' || digestOf(fromCopy) === digestOf(to))) {
    throw new CostError('rebase_same');
  }

  const amountUsd = entry.amountUsd === null ? null : Number(entry.amountUsd);
  const before = (await db.execute(sql`
    SELECT CASE WHEN ca.client_id IS NOT NULL THEN 'c:' || ca.client_id::text ELSE 'r:' || rl.receipt_id::text END AS k,
           coalesce(min(cl.client_code), min(r.unclaimed_marking), min(r.number), '❓') AS label,
           sum(ca.amount_usd) AS usd
      FROM cost_allocations ca
      JOIN boxes b ON b.id = ca.box_id
      JOIN receipt_lots rl ON rl.id = b.lot_id
      JOIN receipts r ON r.id = rl.receipt_id
      LEFT JOIN clients cl ON cl.id = ca.client_id
     WHERE ca.cost_entry_id = ${entry.id}::uuid
     GROUP BY 1`)) as unknown as { k: string; label: string; usd: string }[];

  // The after state: the recompute's pool over the recompute's base. An
  // unconverted bill is drawn on a nominal 100 (% only — it has no dollars
  // to split yet).
  const factor = Number(await getSetting('chargeable_weight_factor'));
  const measures = await boxMeasures(await scopeBoxIds(entry));
  const verdict = costPool(
    { allocationBasis: toBasis, clientId: entry.clientId, amountUsd: amountUsd ?? 100 },
    measures,
    factor,
    toBasis === 'freight' ? { copy: to ?? 'missing', customs: false } : null,
  );
  const receiptOf = new Map(measures.map((m) => [m.boxId, m] as const));
  const after = new Map<string, number>();
  const labels = new Map<string, string>();
  // The band a freight target puts each group in — the price only to a money
  // reader, the same rule as the panel's preview (`splitView`).
  const bands = new Map<string, BandView>();
  if (verdict.kind === 'split') {
    for (const g of verdict.groups ?? []) {
      bands.set(g.key, bandForSight(g.band, money));
    }
    for (const s of verdict.shares) {
      const m = receiptOf.get(s.boxId)!;
      const key = s.clientId ? `c:${s.clientId}` : `r:${m.receiptId}`;
      after.set(key, (after.get(key) ?? 0) + s.amountUsd);
      labels.set(key, s.clientId ? (m.clientCode ?? '❓') : (m.unclaimedMarking ?? m.receiptNumber ?? '❓'));
    }
  }
  for (const b of before) labels.set(b.k, labels.get(b.k) ?? b.label);

  const keys = [...new Set([...before.map((b) => b.k), ...after.keys()])].sort((a, b) =>
    (labels.get(a) ?? '').localeCompare(labels.get(b) ?? ''),
  );
  const beforeUsd = keys.map((k) => Number(before.find((b) => b.k === k)?.usd ?? 0));
  const afterUsd = keys.map((k) => after.get(k) ?? 0);
  const beforeTotal = beforeUsd.reduce((a, n) => a + n, 0);
  const afterTotal = afterUsd.reduce((a, n) => a + n, 0);
  // Both columns to the bill's cents (M7): the largest remainder adds up.
  const showMoney = money && amountUsd !== null;
  const beforeCents = showMoney && beforeTotal > 0 ? splitCents(amountUsd!, beforeUsd) : null;
  const afterCents = showMoney && afterTotal > 0 ? splitCents(amountUsd!, afterUsd) : null;
  const rows = keys.map((key, i) => ({
    key,
    label: labels.get(key) ?? '❓',
    beforePct: pct(beforeUsd[i]!, beforeTotal),
    afterPct: pct(afterUsd[i]!, afterTotal),
    ...(beforeCents ? { beforeUsd: beforeCents[i]! } : {}),
    ...(afterCents ? { afterUsd: afterCents[i]! } : {}),
    ...(bands.has(key) ? { band: bands.get(key)! } : {}),
  }));

  let column: RebasePreview['column'];
  if (to) {
    const [wh] = await db.select({ code: warehouses.code }).from(warehouses).where(eq(warehouses.id, to.warehouseId));
    column = {
      warehouseCode: wh?.code ?? '',
      zone: to.zone,
      tariffFrom: to.tariffFrom,
      previousZone: typeof fromCopy === 'object' ? fromCopy.zone : null,
    };
  }
  const seen = tokenOf(
    entry.id,
    entry.amountUsd,
    entry.allocationBasis,
    fromCopy,
    toBasis,
    to,
    rows.map((r) => [r.key, r.beforePct, r.afterPct] as [string, number, number]),
    verdict.kind === 'held' ? verdict.held : null,
  );
  return {
    to,
    fromCopy,
    preview: {
      entryId: entry.id,
      fromBasis: entry.allocationBasis,
      toBasis,
      seen,
      money: showMoney,
      unconverted: amountUsd === null,
      rows,
      ...(verdict.kind === 'held' ? { held: verdict.held } : {}),
      // Cartons are there and the target finds no measure on them: the save
      // is allowed (as the create is) and the person is told before it.
      ...(verdict.kind === 'nothing' && measures.length > 0 ? { nowhere: true } : {}),
      ...(column ? { column } : {}),
    },
  };
}

export type RebaseAnswer =
  | { kind: 'preview'; preview: RebasePreview }
  | { kind: 'changed'; preview: RebasePreview }
  | { kind: 'saved'; verdict: RecomputeVerdict | null; pending: boolean };

/**
 * The service behind `rebaseCostAction`. The caller has asked the DOOR (the
 * grant at the truck's origin, the cancelled truck, «own only»); this asks
 * what the bill and the tariff allow. No `seen` → the preview. A `seen` that
 * no longer matches → `changed` with a FRESH preview, so the words the person
 * reads come with the new column already in it.
 */
export async function rebaseCost(
  entry: Entry,
  toBasis: string,
  seen: string | null,
  ctx: AuditContext,
  actor: { permissions: ReadonlySet<string> },
): Promise<RebaseAnswer> {
  if (toBasis === 'direct_to_client') throw new CostError('rebase_direct');
  if (!isRebaseTarget(toBasis)) throw new CostError('validation');
  const money = freightMoneySight(actor.permissions);
  const planned = await plan(entry, toBasis, money);
  if (!seen) return { kind: 'preview', preview: planned.preview };
  if (seen !== planned.preview.seen) return { kind: 'changed', preview: planned.preview };

  const moved = await saveRebaseInTx(entry.id, toBasis, planned, ctx);
  if (moved === 'voided') throw new CostError('already_voided');
  if (moved === 'changed') {
    const fresh = await db.query.costEntries.findFirst({ where: eq(costEntries.id, entry.id) });
    if (!fresh || fresh.voidedAt) throw new CostError('already_voided');
    return { kind: 'changed', preview: (await plan(fresh, toBasis, money)).preview };
  }
  return afterCommit(entry.id, '[cost-rebase]', true);
}

/**
 * The SAVE half — the button's and the rollback script's (§8.8). ONE
 * transaction, the entry locked first (the recompute's lock order). A void
 * that committed between the preview and the press wins: no UPDATE, no copy,
 * no audit on a voided cost. A from-part that moved under us (a concurrent
 * re-basis) is `changed`. The shares are DELETED before the basis moves (E3):
 * if the split after the commit then fails, the bill reads «no share» —
 * which every ⚠ surface and the nightly `orphaned` net name — instead of the
 * OLD basis's shares under the new label, which no clause would ever find.
 */
async function saveRebaseInTx(
  entryId: string,
  toBasis: RebaseTarget,
  planned: Pick<Planned, 'to' | 'fromCopy'> & { preview: Pick<RebasePreview, 'fromBasis'> },
  ctx: AuditContext,
  extra: Record<string, unknown> = {},
): Promise<'saved' | 'voided' | 'changed'> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(costEntries).where(eq(costEntries.id, entryId)).for('update');
    if (!locked || locked.voidedAt) return 'voided';
    const fromBasis = locked.allocationBasis;
    if (fromBasis !== planned.preview.fromBasis) return 'changed';
    const fromCopy: FromCopy = fromBasis === 'freight' ? await freightCopyFor(entryId, tx) : 'none';
    if (digestOf(fromCopy) !== digestOf(planned.fromCopy)) return 'changed';

    await tx.delete(costAllocations).where(eq(costAllocations.costEntryId, entryId));
    await tx
      .update(costEntries)
      .set({ allocationBasis: toBasis, ...(fromBasis === 'direct_to_client' ? { clientId: null } : {}) })
      .where(eq(costEntries.id, entryId));
    if (fromBasis === 'freight' || toBasis === 'freight') await replaceFreightCopyInTx(tx, entryId, planned.to);
    // The bands ride too, so a same-date re-freeze of new prices (same zone,
    // same date) is a visible line in History, not an empty one (review).
    const copyFields = (c: FromCopy | FreightCopyDraft | null) =>
      c !== null && typeof c === 'object'
        ? { tariffZone: c.zone, tariffFrom: c.tariffFrom, tariffBands: bandsSummary(c.bands) }
        : {};
    // Leaving a direct bill clears its client — a money fact, so whose it
    // was is recorded on both sides (review: «this fee was GS100's» existed
    // nowhere once it was re-based).
    const clientFields = fromBasis === 'direct_to_client' ? { before: { clientId: locked.clientId }, after: { clientId: null } } : null;
    await writeAudit(tx, ctx, {
      entityType: 'cost_entry',
      entityId: entryId,
      action: 'update',
      before: { allocationBasis: fromBasis, ...copyFields(fromCopy), ...(clientFields?.before ?? {}) },
      after: { allocationBasis: toBasis, ...copyFields(planned.to), ...(clientFields?.after ?? {}), ...extra },
    });
    return 'saved';
  });
}

/**
 * After the commit: the split, the edit.ts idiom. The basis change HAS
 * committed, so a failed split is never an error to the person. The button's
 * path queues it (`queue`); the rollback script's does not — it runs in the
 * one-off container — and both leave the nightly `orphaned` net under it.
 */
async function afterCommit(entryId: string, tag: string, queue: boolean): Promise<RebaseAnswer> {
  try {
    return { kind: 'saved', verdict: await recomputeEntry(entryId), pending: false };
  } catch (error) {
    console.error(`${tag} split after the re-basis failed${queue ? ', queued for retry' : ''}`, entryId, error);
    // The rollback script runs in the one-off `migrate` container: starting
    // pg-boss there leaves its timers alive and the process never exits. Its
    // net is the nightly orphaned sweep and the §10 count check (review).
    if (!queue) return { kind: 'saved', verdict: null, pending: true };
    try {
      const { enqueue, JOB_RECOMPUTE_COSTS } = await import('../../platform/jobs/boss');
      await enqueue(JOB_RECOMPUTE_COSTS, { costEntryId: entryId });
    } catch (queueError) {
      // The nightly orphaned net (a converted cost with no share) is the
      // last net under this one.
      console.error(`${tag} split retry could not be queued`, entryId, queueError);
    }
    return { kind: 'saved', verdict: null, pending: true };
  }
}

/**
 * The ROLLBACK (§8.8, DS3): a live freight bill back to weight through the
 * same SAVE half — no preview, no token; the entry locked, the shares
 * deleted, the copy removed, an audit row with `reason: 'rollback'`, then the
 * split. For `pnpm freight-to-weight --apply`, run through `migrate` when
 * this release's own cost screen is the reason for going back.
 */
export async function rollbackFreightBill(
  entryId: string,
  ctx: AuditContext,
): Promise<{ moved: 'saved' | 'voided' | 'changed'; split: RecomputeVerdict['kind'] | 'pending' | null }> {
  const fromCopy = await freightCopyFor(entryId);
  const moved = await saveRebaseInTx(
    entryId,
    'weight',
    { to: null, fromCopy, preview: { fromBasis: 'freight' } },
    ctx,
    { reason: 'rollback' },
  );
  if (moved !== 'saved') return { moved, split: null };
  const after = await afterCommit(entryId, '[freight-to-weight]', false);
  if (after.kind !== 'saved') return { moved, split: null };
  return { moved, split: after.pending ? 'pending' : (after.verdict?.kind ?? null) };
}
