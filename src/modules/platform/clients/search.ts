import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients, users } from '../db/schema';
import { phoneNeedle } from './phone';

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
 *
 * A query that looks like a PHONE also searches the phone list, because the
 * commonest reason to open this box is that the client is on the line. The
 * comparison strips formatting on both sides and works on the last nine
 * digits, exactly as the Telegram cabinet's check does (DECISIONS #111).
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
  // Only when the query really is a number; five digits is the floor, or a
  // phone search buries the code and name hits it was meant to help.
  const needle = phoneNeedle(q);
  const byPhone = needle
    ? sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${clients.phones}) AS p
        WHERE right(regexp_replace(p, '[^0-9]', '', 'g'), 9) LIKE ${'%' + needle + '%'}
      )`
    : sql`false`;

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
      sql`${clients.active} AND (${clients.clientCode} ILIKE ${like} OR ${clients.name} ILIKE ${like} OR similarity(${clients.name}, ${q}) > 0.4 OR ${codeFuzzy} OR ${byPhone})`,
    )
    .orderBy(
      sql`(${clients.clientCode} = ${upper}) DESC, (${clients.clientCode} ILIKE ${q + '%'}) DESC, similarity(${clients.clientCode}, ${upper}) DESC`,
    )
    .limit(limit);
}
