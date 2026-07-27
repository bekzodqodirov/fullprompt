import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';
import { db } from '@/modules/platform/db/client';
import {
  DRIVER_APP_AUDIT_ID,
  DriverApkError,
  publishDriverApk,
} from '@/modules/wms/tracking/driver-apk';

/**
 * Publishing a build, as a route handler rather than a server action.
 *
 * Server actions cap their request body at 1 MB by default and the APK is
 * 2.3 MB — the first real upload failed on it. Raising that cap would have
 * raised it for EVERY form in the app, which is the wrong trade for one
 * screen; a route handler has no such limit, and the 150 MB ceiling this
 * module already enforces is the one that should decide.
 */
export async function POST(request: Request) {
  try {
    const actor = await authorize('admin.settings.manage');
    const form = await request.formData();
    const file = form.get('apk');
    if (!(file instanceof File)) return Response.json({ error: 'no_file' }, { status: 400 });

    const meta = await publishDriverApk(Buffer.from(await file.arrayBuffer()), {
      version: String(form.get('version') ?? ''),
      uploadedBy: actor.id,
    });
    // Audited like any other change to what the business runs on: this
    // replaces the file every driver's phone is about to install.
    await writeAudit(db, { actorId: actor.id, ...(await requestMeta()) }, {
      entityType: 'driver_app',
      entityId: DRIVER_APP_AUDIT_ID,
      action: 'update',
      after: meta as unknown as Record<string, unknown>,
    });
    return Response.json({ ok: true, version: meta.version });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    if (err instanceof DriverApkError) {
      return Response.json({ error: err.reason }, { status: 400 });
    }
    throw err;
  }
}
