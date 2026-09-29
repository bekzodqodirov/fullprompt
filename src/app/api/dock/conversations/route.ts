import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg, listConversations, tgViewerFor } from '@/modules/wms/crm/conversations';
import type { DockConversation } from '@/modules/wms/crm/conversation-row';

/** The dock's conversation list — same gate as /suhbatlar (#296). */
export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!canReadTg(actor)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // The same list as /suhbatlar, lead rows and their door included (#513):
  // the drawer and the screen must never disagree about who is waiting.
  const rows = await listConversations(tgViewerFor(actor), undefined, undefined, {
    leadsFor: actor,
  });
  // Typed as the ONE shape the drawer reads, so a renamed field is a compile
  // error here and there alike — `res.json()` is where typecheck goes blind.
  const conversations: DockConversation[] = rows.slice(0, 100).map((row) => ({
    kind: row.kind,
    clientId: row.clientId,
    leadId: row.leadId,
    code: row.code,
    name: row.name,
    href: row.href,
    leadOwner: row.leadOwner,
    lastAt: row.lastAt.toISOString(),
    lastBody: row.lastBody,
    lastHasMedia: row.lastHasMedia,
    waitingOnUs: row.waitingOnUs,
  }));
  return NextResponse.json({ conversations });
}
