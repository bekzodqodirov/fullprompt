import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { myThreads } from '@/modules/wms/crm/thread';

/**
 * The dock's «👥 Ichki» list (0127) — the threads this person is in, behind
 * every thread's own door: `myThreads` asks `threadDoorsFor` for the whole
 * page and drops every row the reader may not READ. A route rather than a
 * server component for the dock's reason: it opens on top of whatever page is
 * already rendered and must cost nothing until it does.
 *
 * A database a release behind (0127 not landed) answers an empty list that
 * SAYS so — `behind: true`, and the tab prints «the system is updating»
 * instead of «you have no threads», which would be a lie.
 */
export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const headers = { 'cache-control': 'private, no-store' };
  try {
    return NextResponse.json({ rows: await myThreads(actor) }, { headers });
  } catch (err) {
    if (!isServerBehind(err)) {
      logger.warn({ err }, '[thread] dock list failed');
      return NextResponse.json({ error: 'failed' }, { status: 500, headers });
    }
    return NextResponse.json({ rows: [], behind: true }, { headers });
  }
}
