import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';

/**
 * E9 on DEAL and CLIENT threads (§3.4 filter 2) — ONE rule asked from both
 * ends: by the audience («who of these people is still involved with this
 * client?», internal-chat.ts) and by the dock («which of these threads am I
 * still involved with?», thread.ts `myThreads`). Their doors have no
 * ownership, so a plain `crm.leads` seller who once wrote on a client stays
 * in its conversation only while he still WORKS it; asked twice in two
 * spellings, the ping would stop while the dock went on listing the thread
 * with a new ● on every message (#513).
 *
 * The relation, one row per fact: a person is involved with a CLIENT when he
 * is its seller, or owns an OPEN lead or an OPEN deal of it; with a DEAL when
 * he owns that deal (any stage). A deal thread asks both: the deal's own row,
 * and its client's. Filters are pushed into each arm by the planner (a plain
 * UNION ALL subquery), each arm on its own index — `clients_sales_manager_idx`
 * / `leads_owner_idx` / `deals_owner_idx` from the person's side, the client
 * columns from the thread's.
 */
function involvementSql() {
  return sql`(
    SELECT c.sales_manager_id AS user_id, c.id AS client_id, NULL::uuid AS deal_id
      FROM clients c WHERE c.sales_manager_id IS NOT NULL
    UNION ALL
    SELECT l.owner_id, l.client_id, NULL::uuid
      FROM leads l JOIN lead_stages s ON s.id = l.stage_id
     WHERE s.kind = 'open' AND l.owner_id IS NOT NULL AND l.client_id IS NOT NULL
    UNION ALL
    SELECT d.owner_id, d.client_id, NULL::uuid
      FROM deals d JOIN deal_stages s ON s.id = d.stage_id
     WHERE s.kind = 'open' AND d.owner_id IS NOT NULL AND d.client_id IS NOT NULL
    UNION ALL
    SELECT d.owner_id, NULL::uuid, d.id
      FROM deals d WHERE d.owner_id IS NOT NULL
  )`;
}

/** Everyone involved with one deal or client thread — the audience's side. */
export async function involvedWith(thread: { kind: 'deal' | 'client'; id: string }): Promise<Set<string>> {
  const rows = await db.execute<{ id: string }>(
    thread.kind === 'client'
      ? sql`SELECT DISTINCT inv.user_id::text AS id FROM ${involvementSql()} inv WHERE inv.client_id = ${thread.id}::uuid`
      : sql`SELECT DISTINCT inv.user_id::text AS id FROM ${involvementSql()} inv
             WHERE inv.deal_id = ${thread.id}::uuid
                OR inv.client_id = (SELECT client_id FROM deals WHERE id = ${thread.id}::uuid)`,
  );
  return new Set(rows.map((r) => r.id));
}

/** Every client and deal one person is involved with — the dock's side. */
export async function involvementOf(viewerId: string): Promise<{ clients: Set<string>; deals: Set<string> }> {
  const rows = await db.execute<{ client_id: string | null; deal_id: string | null }>(sql`
    SELECT DISTINCT inv.client_id::text AS client_id, inv.deal_id::text AS deal_id
      FROM ${involvementSql()} inv WHERE inv.user_id = ${viewerId}::uuid
  `);
  const out = { clients: new Set<string>(), deals: new Set<string>() };
  for (const row of rows) {
    if (row.client_id) out.clients.add(row.client_id);
    if (row.deal_id) out.deals.add(row.deal_id);
  }
  return out;
}

/** «Is this deal mine to hear about?» — the deal itself, or its client. */
export function involvedInDeal(
  mine: { clients: ReadonlySet<string>; deals: ReadonlySet<string> },
  deal: { id: string; clientId: string | null },
): boolean {
  return mine.deals.has(deal.id) || (deal.clientId !== null && mine.clients.has(deal.clientId));
}

/** Plain `crm.leads` and nothing that reads every card — the filter-2 standing. */
export function plainSeller(grants: { has(code: string): boolean }): boolean {
  return (
    grants.has('crm.leads') &&
    !grants.has('crm.leads.view_all') &&
    !grants.has('clients.manage') &&
    !grants.has('ved.docs')
  );
}
