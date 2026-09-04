import { randomUUID } from 'node:crypto';
import { db } from '@/modules/platform/db/client';
import { customsImportBatches } from '@/modules/platform/db/schema';
import { authorize, AuthError } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';
import { getStorage } from '@/modules/platform/files/storage';
import { enqueue } from '@/modules/platform/jobs/boss';
import { JOB_CUSTOMS_IMPORT } from '@/modules/wms/customs/jobs';
import { logger } from '@/modules/platform/logger';

/**
 * The admin's upload of the quarterly customs dump.
 *
 * A ROUTE HANDLER and not a server action, for the same reason the driver
 * APK is one: an action's body caps at 1 MB and this file is 40-80 MB
 * (#291). And the parse happens in the JOB, never here — his own sentence
 * about the upload was «sistemamiz tez ishlashi kerak», so the request's
 * whole job is to store the bytes and hand the work to the queue.
 */

const MAX_BYTES = 200 * 1024 * 1024;
/** Every xlsx is a ZIP; a CSV is text and is accepted by extension + parse. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export async function POST(request: Request) {
  let actor;
  try {
    actor = await authorize('admin.dictionaries.manage');
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'no_file' }, { status: 400 });
  if (file.size === 0) return Response.json({ error: 'empty' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: 'too_large' }, { status: 413 });

  const fileName = file.name || 'baza.xlsx';
  const bytes = Buffer.from(await file.arrayBuffer());
  const isCsv = /\.csv$/i.test(fileName);
  // By CONTENT, not by name (#284): a renamed PDF must not become a batch
  // that fails an hour later in a log nobody reads.
  if (!isCsv && !bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    return Response.json({ error: 'not_xlsx' }, { status: 400 });
  }

  const storageKey = `customs-import/${randomUUID()}${isCsv ? '.csv' : '.xlsx'}`;
  await getStorage().put(
    storageKey,
    bytes,
    isCsv ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  const [batch] = await db
    .insert(customsImportBatches)
    .values({ fileName, uploadedBy: actor.id, status: 'processing' })
    .returning({ id: customsImportBatches.id });

  await writeAudit(db, { actorId: actor.id, ...(await requestMeta()) }, {
    entityType: 'customs_import',
    entityId: batch!.id,
    action: 'create',
    after: { fileName, sizeBytes: bytes.length },
  });

  try {
    await enqueue(JOB_CUSTOMS_IMPORT, { batchId: batch!.id, storageKey, fileName });
  } catch (err) {
    // The bytes are stored and the batch exists; a queue that refused the
    // job leaves a row saying so, rather than a silent «processing» for ever.
    logger.error({ err, batchId: batch!.id }, '[customs-import] enqueue failed');
    const { failCustomsImport } = await import('@/modules/wms/customs/import-service');
    await failCustomsImport(batch!.id, 'navbatga qo‘shilmadi — qayta yuklang');
    return Response.json({ error: 'enqueue_failed' }, { status: 500 });
  }

  return Response.json({ ok: true, batchId: batch!.id });
}
