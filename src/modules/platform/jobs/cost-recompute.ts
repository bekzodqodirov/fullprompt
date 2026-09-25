import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { JOB_RECOMPUTE_COSTS } from './boss';

export interface RecomputeCostsPayload {
  costEntryId?: string;
  currency?: string;
  batchId?: string;
  receiptId?: string;
  unconverted?: boolean;
  pickups?: boolean;
  pickupId?: string;
  /**
   * Converted costs with no share, shares left on void boxes (U20/U41), and a
   * truck cost with no share on a carton that rode it unscanned (U25).
   */
  orphaned?: boolean;
  /**
   * Every cost shared over one lot — the durable retry of a door's own
   * post-commit re-split (editLot's measure fix) when that re-split failed:
   * the correction is saved, so the money must follow it without a person
   * pressing anything again.
   */
  lotId?: string;
}

/**
 * Idempotent allocation recompute (spec 6.9): fired after any cost entry or
 * FX rate edit and after a batch departs (its actual load is the ground
 * truth for batch-scope shares).
 */
export async function registerCostRecomputeWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_RECOMPUTE_COSTS);
  // The repair sweep: a cost typed in the receive wizard was inserted with no
  // dollar figure and nothing ever converted it (a USD rate is never saved,
  // so the FX trigger never fired for USD) — «kurs yo'q» and $0 of tannarx
  // for ever. confirmReceipt now converts its own; this finds the old ones
  // and any whose rate arrived later. Nightly, before the backup. It also
  // re-splits every factory-truck cost (0100): that base grows as prixods are
  // linked, and this is the repair for a post-commit recompute a crash skipped.
  // And it re-splits what a broken split left behind (U20/U41): a converted
  // cost with no share at all, and a share sitting on a void box. The first
  // night that is the backlog voidReceipt and the box card left before they
  // learned to re-split — its trucks' tannarx moves, the RECORDED correction
  // #849 already announced; dollars are frozen (R1), so only the split moves.
  await boss.schedule(JOB_RECOMPUTE_COSTS, '40 20 * * *', {
    unconverted: true,
    pickups: true,
    orphaned: true,
  });
  await boss.work<RecomputeCostsPayload>(JOB_RECOMPUTE_COSTS, async (jobs) => {
    const { recomputeAll, recomputeEntry, recomputeForLot } = await import('../../wms/costing/service');
    for (const job of jobs) {
      const p = job.data ?? {};
      if (p.costEntryId) {
        await recomputeEntry(p.costEntryId);
      } else if (p.lotId) {
        const n = await recomputeForLot(p.lotId);
        logger.info({ lotId: p.lotId, n }, 'cost allocations recomputed for a lot');
      } else {
        const n = await recomputeAll(p);
        logger.info({ ...p, n }, 'cost allocations recomputed');
      }
    }
  });
}
