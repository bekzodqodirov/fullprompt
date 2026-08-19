import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { chatPulseForClient, chatPulseForLead } from '@/modules/wms/crm/pulse';

/**
 * The chat surfaces' heartbeat (round 108): answers «has this thread's
 * screen anything new to draw?» in a token, so an open card polls a few
 * cheap indexed selects instead of re-rendering its whole page blind.
 * Every fence is re-derived here from the actor — the ids on the wire are
 * a caller's to invent (#514), the answer is not.
 */
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const clientId = params.get('client');
  const leadId = params.get('lead');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let pulse = null;
  if (clientId && uuid.test(clientId)) {
    pulse = await chatPulseForClient(actor, clientId, {
      sibling: params.get('sibling') === '1',
    });
  } else if (leadId && uuid.test(leadId)) {
    pulse = await chatPulseForLead(actor, leadId);
  } else {
    return NextResponse.json({ error: 'bad_target' }, { status: 400 });
  }

  // The same 404 for «no such row» and «not yours» — an oracle must not
  // distinguish them (round 83's one-constant-answer rule).
  if (!pulse) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(pulse, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
