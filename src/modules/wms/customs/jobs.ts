import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import {
  BatchGoneError,
  CustomsImportError,
  failCustomsImport,
  runCustomsImport,
  sweepStuckImports,
} from './import-service';

/** The quarterly customs dump, parsed off the request (his answer 4). */
export const JOB_CUSTOMS_IMPORT = 'customs.import';
/** The watchdog over it — an import that stopped breathing. */
export const JOB_CUSTOMS_IMPORT_SWEEP = 'customs.import-sweep';

export interface CustomsImportJob {
  batchId: string;
  storageKey: string;
  fileName: string;
}

/**
 * What the ADMIN reads when a file is refused.
 *
 * The reason used to be stored raw, so the person who uploaded the file saw
 * «missing_columns: Ед. из.» — a code, on the one screen whose whole purpose
 * is to say what went wrong in words (#512's shape, one module over). The
 * detail is kept where it is the answer: which column is absent.
 */
export function importFailureText(err: CustomsImportError): string {
  const detail = err.detail ? ` (${err.detail})` : '';
  switch (err.reason) {
    case 'missing_columns':
      return `Faylda kerakli ustun topilmadi${detail}. Sarlavha qatorini tekshiring.`;
    case 'no_rows':
      return "Faylda o'qiladigan bironta qator yo'q — bo'sh varaqmi yoki boshqa fayl?";
    case 'unreadable':
      return `Fayl o'qilmadi${detail}. Excel'da qayta saqlab ko'ring.`;
    case 'in_use':
      // `in_use` is the DELETE's refusal and never a parse's — it is raised
      // by `deleteImportBatch` and read by the button, which has its own
      // translated sentence in all four bundles. A second copy here would be
      // one rule with two homes (#513), and this one is unreachable: the
      // parse cannot raise it.
      return "Bu bazadan narx olingan — o'chirib bo'lmaydi.";
  }
}

/**
 * Parse an uploaded customs dump into `customs_import_rows`.
 *
 * TWO kinds of failure, and until 0095 only one of them was ever written
 * down. A refusal the ADMIN can act on («'Ед. из.' ustuni topilmadi») is put
 * on the batch and NOT rethrown: retrying a file whose columns we cannot
 * read five times over changes nothing and hides the sentence behind a
 * queue. Anything else — a storage blip, a dead connection, a disk with no
 * room — IS worth a retry, and used to be rethrown and forgotten: once
 * pg-boss spent the retries it dropped the job, and the batch went on saying
 * «processing» for ever with nothing anywhere to say why. So the LAST
 * attempt writes the real error onto the row before it gives up. What even
 * that cannot reach — a process killed mid-parse, which runs no catch at all
 * — is the sweep's, below.
 */
export async function registerCustomsImportWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CUSTOMS_IMPORT);
  await boss.work<CustomsImportJob>(
    JOB_CUSTOMS_IMPORT,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        const { batchId, storageKey, fileName } = job.data;
        try {
          const outcome = await runCustomsImport({ batchId, storageKey, fileName });
          logger.info({ batchId, ...outcome }, '[customs-import] batch ready');
        } catch (err) {
          if (err instanceof BatchGoneError) {
            // Not the file's failure and not ours: the batch was swept or
            // deleted while this parse was reading. Nothing to write on (the
            // row may be gone) and nothing to retry — a person has already
            // been told and has already acted.
            logger.info({ batchId }, '[customs-import] batch gone — parse stood down');
            continue;
          }
          if (err instanceof CustomsImportError) {
            await failCustomsImport(batchId, importFailureText(err));
            logger.error({ err, batchId }, '[customs-import] file refused');
            // `continue`, never `return`: pg-boss hands the handler an ARRAY,
            // and one refused file must not abandon the others in the batch.
            continue;
          }
          // `includeMetadata` is asked for exactly this: the handler cannot
          // otherwise know it is the last time it will run.
          const meta = job as unknown as { retryCount?: number; retryLimit?: number };
          const last = (meta.retryCount ?? 0) >= (meta.retryLimit ?? 0);
          if (last) {
            const why = err instanceof Error ? err.message : String(err);
            await failCustomsImport(batchId, `Xatolik: ${why}`);
          }
          logger.error(
            { err, batchId, retryCount: meta.retryCount, last },
            last
              ? '[customs-import] job failed for the last time'
              : '[customs-import] job failed — will retry',
          );
          throw err;
        }
      }
    },
  );
}

/**
 * The watchdog: a batch that stopped saying it was alive is failed.
 *
 * Every five minutes, like the calc lateness sweep, and for the same reason
 * — the person is standing at the screen now, not tomorrow. It settles
 * nothing that is running (the parse beats every ten seconds), and settling
 * a batch is only a WORD: the rows already read stay, and the admin can
 * remove the row or upload the file again.
 */
export async function registerCustomsImportSweep(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CUSTOMS_IMPORT_SWEEP);
  await boss.schedule(JOB_CUSTOMS_IMPORT_SWEEP, '*/5 * * * *');
  await boss.work(JOB_CUSTOMS_IMPORT_SWEEP, async () => {
    try {
      await sweepStuckImports();
    } catch (err) {
      logger.error({ err }, '[customs-import] stuck sweep failed');
      throw err;
    }
  });
}
