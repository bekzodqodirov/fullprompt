import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { callsApkFileName, currentCallsApk, readCallsApk } from '@/modules/wms/calls/apk';

/**
 * The staff download. AUTHED, unlike the driver's public `/driver`: the
 * person installing this app has a login by definition — the pairing code
 * sits on their /profile — so there is no reason to hand the file to the
 * open internet.
 */
export async function GET() {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Not found', { status: 404 });
    throw err;
  }
  const bytes = await readCallsApk();
  if (!bytes) return new Response('Not found', { status: 404 });
  const meta = await currentCallsApk();
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': `attachment; filename="${callsApkFileName(meta)}"`,
      'cache-control': 'private, no-store',
    },
  });
}
