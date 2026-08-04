import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg, listConversations, tgViewerFor } from '@/modules/wms/crm/conversations';

/** The dock's conversation list — same gate as /suhbatlar (#296). */
export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!canReadTg(actor)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const rows = await listConversations(tgViewerFor(actor));
  return NextResponse.json({
    conversations: rows.slice(0, 100).map((row) => ({
      clientId: row.clientId,
      clientCode: row.clientCode,
      clientName: row.clientName,
      lastAt: row.lastAt.toISOString(),
      lastBody: row.lastBody,
      lastHasMedia: row.lastHasMedia,
      waitingOnUs: row.waitingOnUs,
    })),
  });
}
