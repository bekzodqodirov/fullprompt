import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { CustomsImportError, failCustomsImport, runCustomsImport } from './import-service';

/** The quarterly customs dump, parsed off the request (his answer 4). */
export const JOB_CUSTOMS_IMPORT = 'customs.import';

export interface CustomsImportJob {
  batchId: string;
  storageKey: string;
  fileName: string;
}

/**
 * Parse an uploaded customs dump into `customs_import_rows`.
 *
 * A refusal the ADMIN can act on («'Ед. из.' ustuni topilmadi») is written
 * onto the batch and NOT rethrown: retrying a file whose columns we cannot
 * read five times over changes nothing and hides the sentence behind a
 * queue. Anything else — a storage blip, a dead connection — is rethrown so
 * pg-boss retries it, and the batch keeps saying «processing» meanwhile.
 */
export async function registerCustomsImportWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CUSTOMS_IMPORT);
  await boss.work<CustomsImportJob>(JOB_CUSTOMS_IMPORT, async (jobs) => {
    for (const job of jobs) {
      const { batchId, storageKey, fileName } = job.data;
      try {
        const outcome = await runCustomsImport({ batchId, storageKey, fileName });
        logger.info({ batchId, ...outcome }, '[customs-import] batch ready');
      } catch (err) {
        if (err instanceof CustomsImportError) {
          const detail = err.detail ? `: ${err.detail}` : '';
          await failCustomsImport(batchId, `${err.reason}${detail}`);
          logger.error({ err, batchId }, '[customs-import] file refused');
          return;
        }
        logger.error({ err, batchId }, '[customs-import] job failed — will retry');
        throw err;
      }
    }
  });
}
