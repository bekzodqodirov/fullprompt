import { eq, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, users } from '@/modules/platform/db/schema';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';

/** Fuzzy client autocomplete for the receiving wizard (`gs777` → GS777). */
export async function GET(request: Request) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (!q) return Response.json({ results: [] });

  const rows = await db
    .select({
      id: clients.id,
      clientCode: clients.clientCode,
      name: clients.name,
      managerName: users.fullName,
    })
    .from(clients)
    .leftJoin(users, eq(clients.salesManagerId, users.id))
    .where(
      sql`${clients.active} AND (${clients.clientCode} ILIKE ${'%' + q + '%'} OR ${clients.name} ILIKE ${'%' + q + '%'} OR similarity(${clients.clientCode}, ${q.toUpperCase()}) > 0.3)`,
    )
    .orderBy(sql`(${clients.clientCode} = ${q.toUpperCase()}) DESC, similarity(${clients.clientCode}, ${q.toUpperCase()}) DESC`)
    .limit(8);

  return Response.json({ results: rows });
}
