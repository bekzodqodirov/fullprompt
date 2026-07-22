import { getLocalDriver } from '@/modules/platform/files/storage';

/**
 * Signed local-file serving (dev / STORAGE_DRIVER=local only). S3 deployments
 * serve files straight from presigned object-storage URLs instead.
 */
export async function GET(request: Request) {
  const local = getLocalDriver();
  if (!local) return new Response('Not found', { status: 404 });

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig');
  if (!key || !exp || !sig || !local.verify(key, exp, sig)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const body = await local.get(key);
    return new Response(new Uint8Array(body), {
      headers: { 'cache-control': 'private, max-age=600' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
