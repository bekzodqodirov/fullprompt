import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { isServerBehind } from '@/modules/platform/db/errors';
import { openStopsForOwner, stopReceivability } from '@/modules/wms/pickups/service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The receive door's question (docs/ZAVOD-YOPISH.md §3, his 3a): which open
 * factory trips heading to this warehouse carry an UNANSWERED line of this
 * owner. Asked by the wizard the moment a client is chosen or a marking is
 * accepted. The screen's own gate — `receipts.create` AT the warehouse (a
 * bare login would hand any colleague the trips of a warehouse they do not
 * work in) — and never cached: a stale answer re-asks about a line another
 * phone just received (the service worker lists it NetworkOnly too).
 */
export async function GET(request: Request) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }
  const params = new URL(request.url).searchParams;
  const wh = params.get('wh') ?? '';
  const stop = params.get('stop') ?? '';
  // The draft-restore check: is the stop this draft carries still receivable?
  if (stop) {
    if (!UUID.test(wh) || !UUID.test(stop)) return Response.json({ error: 'validation' }, { status: 400 });
    if (!actor.permissions.has('receipts.create') || !inScope(actor, wh)) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    try {
      const found = await stopReceivability(stop);
      // A stop of another warehouse's trip answers like a missing one.
      const body = found && found.destWarehouseId === wh ? { status: found.status, answered: found.answered } : { status: null, answered: [] };
      return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (err) {
      if (isServerBehind(err)) return Response.json({ status: 'unknown', answered: [] });
      throw err;
    }
  }
  const clientId = params.get('c') ?? '';
  const marking = (params.get('m') ?? '').trim();
  if (!UUID.test(wh) || (clientId && !UUID.test(clientId)) || (!clientId && !marking) || marking.length > 100) {
    return Response.json({ error: 'validation' }, { status: 400 });
  }
  if (!actor.permissions.has('receipts.create') || !inScope(actor, wh)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    const stops = await openStopsForOwner(wh, clientId ? { clientId } : { marking });
    return Response.json({ stops }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    // One migration behind: the door asks nothing rather than failing the screen.
    if (isServerBehind(err)) return Response.json({ stops: [] }, { headers: { 'Cache-Control': 'private, no-store' } });
    throw err;
  }
}
