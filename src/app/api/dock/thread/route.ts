import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg, conversationClient, conversationFor, tgViewerFor } from '@/modules/wms/crm/conversations';
import { conversationManagers, replyAccountFor, sendContextFor } from '@/modules/wms/crm/outbox';
import { canQueue } from '@/modules/wms/crm/telegram-send';

/**
 * One client's thread for the dock, with the same honest reply verdict the
 * card composer shows: can this PERSON answer here, and if not — why.
 * The gate is the conversation gate (#296); the verdict repeats the checks
 * the send action re-asks, so the panel can never offer what the door would
 * refuse.
 */
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!canReadTg(actor)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const clientId = new URL(request.url).searchParams.get('client') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
    return NextResponse.json({ error: 'bad_client' }, { status: 400 });
  }

  const [client, messages, account, managers] = await Promise.all([
    conversationClient(clientId),
    conversationFor(clientId, tgViewerFor(actor), 80),
    replyAccountFor(clientId, actor.id),
    conversationManagers(clientId),
  ]);
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let reason: string | null = null;
  if (!account) {
    reason = managers.length === 0 ? 'no_chat' : 'not_your_conversation';
  } else {
    const verdict = canQueue(
      'x',
      await sendContextFor({
        clientId,
        managerUserId: account.managerUserId,
        peerId: account.peerId,
      }),
    );
    if (!verdict.ok) reason = verdict.reason;
  }

  return NextResponse.json({
    client: { id: client.id, code: client.clientCode, name: client.name },
    canReply: reason === null,
    reason,
    managers,
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body,
      hasMedia: m.hasMedia,
      sentAt: m.sentAt.toISOString(),
      manager: m.manager,
      photos: m.photos,
    })),
  });
}
