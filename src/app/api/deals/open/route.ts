import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { openDealsForClient } from '@/modules/wms/deals/service';

/**
 * The client's open jobs, for the receiving screen's picker.
 *
 * A warehouse operator holds none of the deal-write permissions and must still
 * see this list: linking cargo to the job it belongs to is the ONE moment the
 * price-control alert depends on, and hiding the picker from the person
 * standing in front of the boxes would leave every receipt "unquoted". So the
 * gate is `receipts.create` — the permission to be on that screen at all —
 * and the response carries nothing but a code, a title and the agreed price.
 *
 * PRICED deals only, and filtered HERE rather than in `openDealsForClient`:
 * that function has a second consumer — the receipt card's repair door (round
 * 38) — where somebody who CAN read the job is meant to attach cargo to
 * whichever deal it belongs to, empty or not. On THIS screen an unpriced shell
 * is worse than no option at all: round 111 opens one with every client code,
 * so the picker would offer every new customer a line with no price in it, and
 * choosing it silences the «no agreed price» alarm the picker exists to feed.
 */
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor?.permissions.has('receipts.create')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const clientId = new URL(request.url).searchParams.get('client');
  if (!clientId) return NextResponse.json({ results: [] });
  const open = await openDealsForClient(clientId);
  return NextResponse.json({
    results: open.filter((deal) => deal.quotedAmount !== null),
  });
}
