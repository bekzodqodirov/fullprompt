import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';
import { db } from '@/modules/platform/db/client';
import { CALLS_APP_AUDIT_ID, CallsApkError, publishCallsApk } from '@/modules/wms/calls/apk';

/**
 * Publishing a build of the calls app — a route handler because the APK is
 * megabytes (#291), gated and audited exactly like the driver app's.
 */
export async function POST(request: Request) {
  try {
    const actor = await authorize('admin.settings.manage');
    const form = await request.formData();
    const file = form.get('apk');
    if (!(file instanceof File)) return Response.json({ error: 'no_file' }, { status: 400 });

    const meta = await publishCallsApk(Buffer.from(await file.arrayBuffer()), {
      version: String(form.get('version') ?? ''),
      uploadedBy: actor.id,
    });
    await writeAudit(db, { actorId: actor.id, ...(await requestMeta()) }, {
      entityType: 'calls_app',
      entityId: CALLS_APP_AUDIT_ID,
      action: 'update',
      after: meta as unknown as Record<string, unknown>,
    });
    return Response.json({ ok: true, version: meta.version });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    if (err instanceof CallsApkError) {
      return Response.json({ error: err.reason }, { status: 400 });
    }
    throw err;
  }
}
