import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { linkablePath, mintDownloadToken } from '@/modules/platform/auth/download-link';

/**
 * Mint a download link for the signed-in person (`download-link.ts`). Asked
 * by the page the moment a file link is pressed, WITH the cookie — the link
 * it returns is what the phone's download manager fetches WITHOUT one.
 *
 * `{ url: null }` is an answer, not an error: no key on this server, or a path
 * that is not a file route. The page then follows the plain address, which is
 * exactly what it did before links existed.
 */
export async function POST(request: Request) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }
  // A cross-site form can post text/plain and nothing else; asking for JSON by
  // its header keeps a minted link to a request only this app's page makes.
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    return Response.json({ error: 'bad_request' }, { status: 415 });
  }
  let body: { path?: unknown };
  try {
    body = (await request.json()) as { path?: unknown };
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const path = linkablePath(body.path);
  if (!path) return Response.json({ error: 'bad_path' }, { status: 400 });
  const token = mintDownloadToken(actor.id, path);
  return Response.json(
    { url: token ? `/api/dl/${token}` : null },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
