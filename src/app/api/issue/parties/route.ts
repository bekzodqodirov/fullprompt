import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { issueParties } from '@/modules/wms/issue/parties';

const querySchema = z.object({ warehouseId: z.string().uuid() });

/**
 * Who is waiting for cargo at this warehouse (owner's item 3).
 *
 * Its own route rather than server-rendered with the page, because the
 * operator switches warehouse on the screen and the box list next to it is
 * fetched the same way. The gate is the screen's own — `scan.issue` AT this
 * warehouse — which is also what keeps the phone numbers where they belong:
 * a uuid in the address bar cannot read another warehouse's customers.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({ warehouseId: url.searchParams.get('warehouseId') });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });
  try {
    await authorize('scan.issue', { warehouseId: query.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }
  const data = await issueParties(query.data.warehouseId);
  return Response.json(data, { headers: { 'cache-control': 'private, no-store' } });
}
