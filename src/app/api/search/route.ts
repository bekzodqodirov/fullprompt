import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { globalSearch } from '@/modules/wms/search/service';

/**
 * The command palette's data.
 *
 * Deliberately the SAME function the `/search` page calls, so the overlay and
 * the page can never disagree about what somebody may find — a second query
 * here would be a second set of permission rules to keep in step, and the one
 * that drifts is always the one nobody looks at.
 */
export async function GET(request: Request) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }

  const q = new URL(request.url).searchParams.get('q') ?? '';
  const hits = await globalSearch(actor, q);

  return Response.json(
    { hits },
    {
      // A search answer is about this person and this instant; a shared cache
      // in front of it would hand one warehouse's results to another.
      headers: { 'cache-control': 'private, no-store' },
    },
  );
}
