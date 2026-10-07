import { authorize, AuthError } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { requestClock } from '@/modules/wms/calc/workspace';

/**
 * «Did this calculation change under me?» — the phone sheet's probe (his
 * B6 a: another VED may edit too, with a «boshqa kishi hozirgina
 * o'zgartirdi» warning, never a lock).
 *
 * One indexed read of the request's clock: the rev, whether a live AI pass
 * holds it, whether it closed. The screen refreshes only when the answer
 * MOVED, so an open sheet costs one tiny SELECT per 15 seconds and a full
 * workspace load only when somebody actually wrote.
 *
 * A STATIC `rev` segment first: `/api/calc/[versionId]` owns the dynamic slot
 * at this level, and Next refuses two slug names on one path. The door is the
 * page's own (`ved.docs`); this app has no middleware, so every /api route
 * states it (#721-726). `private, no-store`, and the service worker routes it
 * NetworkOnly — a cached clock answers «nothing changed» for ever.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  const { requestId } = await params;
  // The strict shape first: a 36-character non-uuid must not reach `::uuid`.
  if (!UUID.test(requestId)) return Response.json({ error: 'not_found' }, { status: 404, headers });
  try {
    await authorize('ved.docs');
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403, headers });
    throw err;
  }
  try {
    const clock = await requestClock(requestId);
    if (!clock) return Response.json({ error: 'not_found' }, { status: 404, headers });
    return Response.json(clock, { headers });
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, requestId }, '[calc-clock] probe: server behind');
    // A screen ahead of its migration must not read «changed» for ever.
    return Response.json({ state: 'behind' }, { headers });
  }
}
