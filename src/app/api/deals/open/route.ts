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
 */
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor?.permissions.has('receipts.create')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const clientId = new URL(request.url).searchParams.get('client');
  if (!clientId) return NextResponse.json({ results: [] });
  return NextResponse.json({ results: await openDealsForClient(clientId) });
}
