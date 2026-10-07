import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { isThreadRef } from '@/modules/platform/notifications/thread-ref';
import { mayReadThread } from '@/modules/wms/crm/thread-door';
import { threadToken } from '@/modules/wms/crm/thread';

/**
 * The calc page's Q&A pulse (0127): a token that moves when a message lands —
 * the count and the newest moment — behind the thread's OWN door, so the
 * pulse is never a way to learn about a thread the reader may not open. The
 * page refreshes only when the token moves (round 108's pattern, ChatPulse).
 * A database a release behind answers `{ token: null }`, and the pulse stops.
 */
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(request.url);
  const ref = { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') };
  if (!isThreadRef(ref)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const headers = { 'cache-control': 'private, no-store' };
  try {
    if (!(await mayReadThread(actor, ref))) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
    }
    return NextResponse.json({ token: await threadToken(ref) }, { headers });
  } catch (err) {
    if (!isServerBehind(err)) {
      logger.warn({ err }, '[thread] pulse failed');
      return NextResponse.json({ error: 'failed' }, { status: 500, headers });
    }
    return NextResponse.json({ token: null }, { headers });
  }
}
