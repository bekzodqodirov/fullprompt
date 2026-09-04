'use server';

import { revalidatePath } from 'next/cache';
import { authorize, AuthError } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';
import { db } from '@/modules/platform/db/client';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { CustomsImportError, deleteImportBatch } from '@/modules/wms/customs/import-service';

export interface ImportActionState {
  ok?: boolean;
  error?: string;
}

/**
 * Remove an import.
 *
 * A failed one always; a ready one only while no calculation is priced off
 * it — the service decides, and it is asked again there because a button is
 * not a gate (#531). The refusal reaches the screen as a sentence.
 */
export async function deleteImportBatchAction(batchId: string): Promise<ImportActionState> {
  let actor;
  try {
    actor = await authorize('admin.dictionaries.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  try {
    await deleteImportBatch(batchId);
    await writeAudit(db, { actorId: actor.id, ...(await requestMeta()) }, {
      entityType: 'customs_import',
      entityId: batchId,
      action: 'void',
      after: { deleted: true },
    });
  } catch (err) {
    if (err instanceof CustomsImportError) return { error: err.reason };
    if (isServerBehind(err)) {
      logger.error({ err }, '[customs-import] delete: server behind');
      return { error: 'server_behind' };
    }
    throw err;
  }
  revalidatePath('/admin/bojxona-import');
  return { ok: true };
}
