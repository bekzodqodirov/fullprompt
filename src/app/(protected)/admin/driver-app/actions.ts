'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { db } from '@/modules/platform/db/client';
import { DriverApkError, publishDriverApk } from '@/modules/wms/tracking/driver-apk';

/**
 * Publish a new build of the driver app.
 *
 * Audited like any other change to what the business runs on: this replaces
 * the file every driver's phone is about to install, and "who put that there
 * and when" has to be answerable afterwards.
 */
export async function publishDriverApkAction(formData: FormData): Promise<void> {
  const actor = await getActor();
  if (!actor?.permissions.has('admin.settings.manage')) throw new Error('forbidden');

  const file = formData.get('apk');
  if (!(file instanceof File)) throw new Error('no file');

  try {
    const meta = await publishDriverApk(Buffer.from(await file.arrayBuffer()), {
      version: String(formData.get('version') ?? ''),
      uploadedBy: actor.id,
    });
    await writeAudit(
      db,
      { actorId: actor.id },
      {
        entityType: 'driver_app',
        entityId: 'current',
        action: 'update',
        after: meta as unknown as Record<string, unknown>,
      },
    );
  } catch (err) {
    if (err instanceof DriverApkError) throw new Error(`apk:${err.reason}`);
    throw err;
  }
  revalidatePath('/admin/driver-app');
  revalidatePath('/driver');
}
