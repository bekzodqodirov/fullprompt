import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import {
  canReadTg,
  conversationClient,
  conversationFor,
  tgViewerFor,
  threadClientFor,
} from '@/modules/wms/crm/conversations';
import {
  conversationManagers,
  pendingFor,
  replyAccountFor,
  sendContextFor,
} from '@/modules/wms/crm/outbox';
import { canQueue } from '@/modules/wms/crm/telegram-send';
import { templatesFor } from '@/modules/wms/crm/templates';

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
  const asked = new URL(request.url).searchParams.get('client') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(asked)) {
    return NextResponse.json({ error: 'bad_client' }, { status: 400 });
  }

  // The chat may live under a phone-SIBLING code: one person routinely holds
  // several GS codes on one number, and the import pinned the conversation to
  // whichever code the phone matched (round 32). The card's own panel has
  // resolved that since #407; the dock never did, so the same card showed the
  // conversation in one place and «no chat» in the other, and a manager could
  // read a thread in the panel that the dock refused to let them answer.
  // One resolver, both doors.
  const viewer = tgViewerFor(actor);
  const clientId = (await threadClientFor(asked, viewer)) ?? asked;

  const [client, messages, account, managers, pending] = await Promise.all([
    conversationClient(clientId),
    conversationFor(clientId, viewer, 80),
    replyAccountFor(clientId, actor.id),
    conversationManagers(clientId),
    // Replies that have not left yet. The dock showed none, so pressing send
    // made the words disappear — nothing in the thread, nothing waiting, and
    // the message only reappeared when the listener's echo landed (owner,
    // 2026-08-07). Scoped by the same viewer as the thread itself.
    pendingFor(clientId, viewer),
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

  // Filled HERE, against the resolved client — the browser is never told a
  // customer's name in order to write a greeting, and the dock's composer
  // offers exactly what the card's composer offers.
  const templates = await templatesFor(actor.id, {
    name: client.name,
    code: client.clientCode,
  });

  return NextResponse.json({
    // The RESOLVED id, so the composer posts against the code that actually
    // holds the chat rather than the marker the card put on the page.
    client: { id: client.id, code: client.clientCode, name: client.name },
    templates,
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
      audios: m.audios,
    })),
    pending: pending.map((row) => ({
      id: row.id,
      body: row.body,
      status: row.status,
      queuedAt: row.queuedAt.toISOString(),
      attachmentId: row.attachmentId,
      lastError: row.lastError,
    })),
  });
}
