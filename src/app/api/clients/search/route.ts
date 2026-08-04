import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { searchClients } from '@/modules/platform/clients/search';

/** Fuzzy client autocomplete for the receiving wizard (`gs777` → GS777). */
export async function GET(request: Request) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  const results = await searchClients(q);
  return Response.json({
    results,
    exact: results.some((r) => r.clientCode === q.toUpperCase()),
  });
}
