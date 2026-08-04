import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { JOB_RECOMPUTE_COSTS } from './boss';

export interface RecomputeCostsPayload {
  costEntryId?: string;
  currency?: string;
  batchId?: string;
  receiptId?: string;
}

/**
 * Idempotent allocation recompute (spec 6.9): fired after any cost entry or
 * FX rate edit and after a batch departs (its actual load is the ground
 * truth for batch-scope shares).
 */
export async function registerCostRecomputeWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_RECOMPUTE_COSTS);
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
