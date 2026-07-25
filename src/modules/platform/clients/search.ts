import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients, users } from '../db/schema';

export interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
  managerName: string | null;
}

/**
 * Client autocomplete (receiving, issue, finance).
 *
 * Digits in a client code are meaningful: GS500 and GS300 are DIFFERENT
 * customers, yet trigram similarity called them a match — an operator typing
 * an unknown GS500 was offered GS300 (owner's report). So a query carrying
 * digits matches codes LITERALLY (exact / prefix / substring); fuzziness is
 * reserved for names and for digit-free code typos.
 */
export async function searchClients(query: string, limit = 8): Promise<ClientHit[]> {
  const q = query.trim();
  if (!q) return [];
  const hasDigits = /\d/.test(q);
  const like = `%${q}%`;
  const upper = q.toUpperCase();
  const codeFuzzy = hasDigits
    ? sql`false`
    : sql`similarity(${clients.clientCode}, ${upper}) > 0.4`;

  return db
    .select({
      id: clients.id,
      clientCode: clients.clientCode,
      name: clients.name,
      managerName: users.fullName,
    })
    .from(clients)
    .leftJoin(users, eq(clients.salesManagerId, users.id))
    .where(
      sql`${clients.active} AND (${clients.clientCode} ILIKE ${like} OR ${clients.name} ILIKE ${like} OR similarity(${clients.name}, ${q}) > 0.4 OR ${codeFuzzy})`,
    )
    .orderBy(
      sql`(${clients.clientCode} = ${upper}) DESC, (${clients.clientCode} ILIKE ${q + '%'}) DESC, similarity(${clients.clientCode}, ${upper}) DESC`,
    )
    .limit(limit);
}
