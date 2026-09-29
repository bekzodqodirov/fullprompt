import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { leads } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import {
  canReadTg,
  markLeadThreadRead,
  markThreadRead,
  threadClientFor,
  tgViewerFor,
} from '@/modules/wms/crm/conversations';
import { mayOpenLead } from '@/modules/wms/crm/lead-door';

/** A uuid, checked BEFORE it reaches a `::uuid` cast — a bad one is a 22P02, i.e. a 500 (#514). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "I have this chat open" — the CRM's own half of the read mark (round 88).
 *
 * The browser sends a client id — or, since the lead chats round, a LEAD id —
 * and NOTHING else: how far that reads is re-derived from the stored
 * messages, and whose mark moves is the signed-in actor. A hand-posted body
 * can therefore only ever mark the poster's own chat read up to a message
 * that already exists — which is exactly what opening the screen means.
 *
 * `threadClientFor` because a person's several GS codes share one phone and
 * the chat lives on whichever one the import matched (#407): the screen the
 * manager is looking at must move the mark of the thread it is showing.
 *
 * A lead's thread is read on the LEAD CARD, so its mark passes the card's own
 * door (`mayOpenLead`): reading on a screen you may not open is not reading.
 */
export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!canReadTg(actor)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as {
    clientId?: unknown;
    leadId?: unknown;
  } | null;

  if (typeof body?.leadId === 'string') {
    const leadId = body.leadId;
    if (!UUID.test(leadId)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    const [lead] = await db
      .select({ ownerId: leads.ownerId })
      .from(leads)
      .where(eq(leads.id, leadId));
    if (!lead || !mayOpenLead(actor, lead)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    // The actor's own id, never one from the body: the WHERE inside is the
    // fence, and a supervisor's glance writes nothing (#650).
    await markLeadThreadRead(leadId, actor.id);
    return NextResponse.json({ ok: true });
  }

  const clientId = typeof body?.clientId === 'string' ? body.clientId : null;
  if (!clientId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const resolved = await threadClientFor(clientId, tgViewerFor(actor));
  if (resolved) await markThreadRead(resolved, actor.id);
  return NextResponse.json({ ok: true });
}
