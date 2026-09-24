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
  await boss.schedule(JOB_RECOMPUTE_COSTS, '40 20 * * *', { unconverted: true, pickups: true });
  await boss.work<RecomputeCostsPayload>(JOB_RECOMPUTE_COSTS, async (jobs) => {
    const { recomputeAll, recomputeEntry } = await import('../../wms/costing/service');
    for (const job of jobs) {
      const p = job.data ?? {};
      if (p.costEntryId) {
        await recomputeEntry(p.costEntryId);
      } else {
        const n = await recomputeAll(p);
        logger.info({ ...p, n }, 'cost allocations recomputed');
      }
    }
  });
}
