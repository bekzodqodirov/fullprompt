import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg, markThreadRead, threadClientFor, tgViewerFor } from '@/modules/wms/crm/conversations';

/**
 * "I have this chat open" — the CRM's own half of the read mark (round 88).
 *
 * The browser sends a client id and NOTHING else: how far that reads is
 * re-derived from the stored messages, and whose mark moves is the signed-in
 * actor. A hand-posted body can therefore only ever mark the poster's own
 * chat read up to a message that already exists — which is exactly what
 * opening the screen means.
 *
 * `threadClientFor` because a person's several GS codes share one phone and
 * the chat lives on whichever one the import matched (#407): the screen the
 * manager is looking at must move the mark of the thread it is showing.
 */
export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!canReadTg(actor)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { clientId?: unknown } | null;
  const clientId = typeof body?.clientId === 'string' ? body.clientId : null;
  if (!clientId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const resolved = await threadClientFor(clientId, tgViewerFor(actor));
  if (resolved) await markThreadRead(resolved, actor.id);
  return NextResponse.json({ ok: true });
}
