import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { isThreadReadMark, type ThreadReadMark } from '@/modules/platform/notifications/thread-ref';
import { mayReadThread } from '@/modules/wms/crm/thread-door';
import { markThreadRead } from '@/modules/wms/crm/thread';

/**
 * «I have this thread on screen» — the staff thread's read mark (0127).
 *
 * The body names at most four threads (a card and its client, a calc page),
 * each with the moment of the newest message the screen drew (`asOf` —
 * never «now», which would read a note that landed after the render), and
 * NOTHING else: whose mark moves is the signed-in actor, and a thread the
 * door does not admit is refused SILENTLY — 204 either way, because the mark
 * is the viewer's own state and a refusal here is information about a card
 * the viewer may not open. A database a release behind answers 204 too: the
 * mark is a convenience, never a reason for an error on the card.
 */
export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { refs?: unknown } | null;
  const refs = Array.isArray(body?.refs) ? body.refs.filter(isThreadReadMark).slice(0, 4) : [];
  try {
    for (const ref of refs as ThreadReadMark[]) {
      const thread = { kind: ref.kind, id: ref.id };
      if (await mayReadThread(actor, thread)) await markThreadRead(actor.id, thread, ref.asOf);
    }
  } catch (err) {
    if (!isServerBehind(err)) logger.warn({ err }, '[thread] read mark failed');
  }
  return new NextResponse(null, { status: 204 });
}
