import { sql, type SQL } from 'drizzle-orm';
import { leads } from '../../platform/db/schema';

/**
 * Who may open a LEAD card — one sentence, asked by every door that points
 * at one.
 *
 * It used to live twice, as the same inline `if` on the card page and in the
 * lead pulse, and nowhere else needed it while nothing else linked to a lead.
 * The lead chats round (the owner's 4a, «lidlarning chatlari ham mijoz
 * chatlari kabi») changed that: a lead's conversation now appears on
 * «Suhbatlar», in the dock and in the 30-minute nudge, and a chat regularly
 * sits on one manager's account while the LEAD belongs to another —
 * `leadForChat` reuses any open lead carrying the number whoever owns it, a
 * website visitor lands on their earlier lead, and bulk assign moves owners
 * after the chat has started. A row or a button that opens onto the card's
 * bounce is a broken door (the design judge's first finding), so everything
 * that draws one asks THIS before it draws the link.
 *
 * The rule itself is unchanged from the card's: `crm.leads`, and then either
 * the whole funnel (`crm.leads.view_all`) or your own lead. Two people
 * calling the same person about the same cargo is the thing it prevents.
 */
export interface LeadReader {
  id: string;
  permissions: ReadonlySet<string>;
}

export function mayOpenLead(reader: LeadReader, lead: { ownerId: string | null }): boolean {
  if (!reader.permissions.has('crm.leads')) return false;
  return reader.permissions.has('crm.leads.view_all') || lead.ownerId === reader.id;
}

/**
 * The same rule as a boolean column of a statement that joins `leads`
 * (unaliased — drizzle renders the column as `"leads"."owner_id"`).
 */
export function mayOpenLeadSql(reader: LeadReader): SQL {
  if (!reader.permissions.has('crm.leads')) return sql`false`;
  if (reader.permissions.has('crm.leads.view_all')) return sql`true`;
  return sql`(${leads.ownerId} IS NOT DISTINCT FROM ${reader.id}::uuid)`;
}
