import { apkFileName, currentDriverApk, readDriverApk } from '@/modules/wms/tracking/driver-apk';

/**
 * The download itself — deliberately PUBLIC.
 *
 * A driver is not a user of this system: they have no login and never will,
 * and the phone is handed over in a warehouse yard. Putting the APK behind
 * the staff session would mean a warehouse worker downloading it on their own
 * phone and passing the file across by Bluetooth, which is the three-step
 * dance this replaces.
 *
 * Nothing here is a secret. The APK carries no credentials — a phone is
 * useless until somebody pairs it with a six-character code minted on the
 * batch screen, and that code is what authorises a trip.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const bytes = await readDriverApk();
  if (!bytes) return new Response('not published', { status: 404 });
  const meta = await currentDriverApk();
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(bytes.length),
      // `attachment` so Android downloads it rather than trying to render it,
      // and a name that says which build the driver ended up with.
      'content-disposition': `attachment; filename="${apkFileName(meta)}"`,
      // A new build reuses this URL, so the answer must never be cached.
      'cache-control': 'no-store',
    },
  });
}
