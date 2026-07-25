import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { clients, crmPeople, leads } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { phonesOverlap } from '../client-cabinet/service';
import { CrmError } from './service';

/**
 * One human being, several client codes (owner: "ha birlashtiraylik").
 *
 * Deliberately a layer ABOVE clients rather than a merge of them. Each code
 * keeps its own letters, stock, cargo history and cabinet link — merging the
 * rows would rewrite years of receipts and break every printed label — while
 * the person ties them together for the sales side: one contact history, one
 * follow-up, one answer to "how much does this guy actually ship".
 *
 * This resolves DECISIONS #40, which had been parked since M1.
 */

export const personSchema = z.object({
  name: z.string().trim().min(2).max(200),
  phones: z.array(z.string().trim().max(40)).max(20).default([]),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

export async function savePerson(
  input: z.infer<typeof personSchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const values = {
    name: input.name,
    phones: input.phones.filter(Boolean),
    note: input.note || null,
  };
  const [row] = input.id
    ? await db
        .update(crmPeople)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(crmPeople.id, input.id))
        .returning()
    : await db
        .insert(crmPeople)
        .values({ ...values, createdBy: ctx.actorId })
        .returning();
  if (!row) throw new CrmError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'crm_person',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

export async function attachClient(clientId: string, personId: string | null, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new CrmError('not_found');
  if (personId) {
    const person = await db.query.crmPeople.findFirst({ where: eq(crmPeople.id, personId) });
    if (!person) throw new CrmError('person_not_found');
  }
  await db.update(clients).set({ personId }).where(eq(clients.id, clientId));
  await writeAudit(db, ctx, {
    entityType: 'client',
    entityId: clientId,
    action: 'update',
    before: { personId: client.personId },
    after: { personId },
  });
}

/**
 * Make a person out of a client card and pull its siblings in.
 *
 * The shortcut the owner will actually use: he opens GS777, presses "this is
 * the same person as…", and the codes that share a phone come along.
 */
export async function personFromClient(clientId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new CrmError('not_found');
  if (client.personId) return client.personId;

  const person = await savePerson(
    {
      name: client.name,
      phones: Array.isArray(client.phones) ? (client.phones as string[]) : [],
    },
    ctx,
  );
  await attachClient(clientId, person.id, ctx);
  return person.id;
}

/** Every code that belongs to a person, with what each one is worth. */
export async function personCodes(personId: string) {
  return db
    .select({
      id: clients.id,
      code: clients.clientCode,
      name: clients.name,
      active: clients.active,
      balanceUsd: sql<string>`coalesce((
        SELECT sum(CASE WHEN ct.type = 'charge' THEN ct.amount_usd ELSE -ct.amount_usd END)
        FROM client_transactions ct
        WHERE ct.client_id = ${clients}.id AND ct.voided_at IS NULL
      ), 0)`,
      lastReceiptAt: sql<string | null>`(
        SELECT max(r.received_at) FROM receipts r
        WHERE r.client_id = ${clients}.id AND r.status = 'confirmed'
      )`,
    })
    .from(clients)
    .where(eq(clients.personId, personId))
    .orderBy(asc(clients.clientCode));
}

export async function personForClient(clientId: string) {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client?.personId) return null;
  const person = await db.query.crmPeople.findFirst({ where: eq(crmPeople.id, client.personId) });
  if (!person) return null;
  return { person, codes: await personCodes(person.id) };
}

export async function listPeople(limit = 300) {
  const rows = await db
    .select({
      person: crmPeople,
      codes: sql<number>`(SELECT count(*) FROM clients c WHERE c.person_id = ${crmPeople}.id)`,
    })
    .from(crmPeople)
    .orderBy(asc(crmPeople.name))
    .limit(limit);
  return rows.map((row) => ({ ...row.person, codes: Number(row.codes) }));
}

/**
 * Codes that look like the same human being, by shared phone number.
 *
 * The owner has hundreds of client cards and will not group them by hand, so
 * the screen offers the obvious pairs and he confirms. Matching reuses the
 * cabinet's last-9-digits rule (DECISIONS #111), which is what already
 * decides whether a phone belongs to a client.
 */
export async function suggestGroups(limit = 50) {
  const rows = await db
    .select({
      id: clients.id,
      code: clients.clientCode,
      name: clients.name,
      phones: clients.phones,
    })
    .from(clients)
    .where(and(eq(clients.active, true), isNull(clients.personId)));

  const groups: { phone: string; members: typeof rows }[] = [];
  const used = new Set<string>();
  for (const client of rows) {
    if (used.has(client.id)) continue;
    const phones = Array.isArray(client.phones) ? (client.phones as string[]) : [];
    if (phones.length === 0) continue;
    const members = rows.filter(
      (other) => other.id !== client.id && !used.has(other.id) && phonesOverlap(client.phones, other.phones),
    );
    if (members.length === 0) continue;
    for (const member of [client, ...members]) used.add(member.id);
    groups.push({ phone: phones[0]!, members: [client, ...members] });
    if (groups.length >= limit) break;
  }
  return groups;
}

/** Group a set of codes under one (new or existing) person in one action. */
export async function groupClients(
  clientIds: string[],
  input: { personId?: string; name?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  if (clientIds.length < 1) throw new CrmError('nothing_to_group');

  let personId = input.personId;
  if (!personId) {
    const first = await db.query.clients.findFirst({ where: eq(clients.id, clientIds[0]!) });
    if (!first) throw new CrmError('not_found');
    // Collect every phone the codes carry, so the person card holds all the
    // numbers the group is reachable on rather than just the first one's.
    const members = await db.select({ phones: clients.phones }).from(clients).where(
      sql`${clients.id} IN ${clientIds}`,
    );
    const phones = [
      ...new Set(
        members.flatMap((row) => (Array.isArray(row.phones) ? (row.phones as string[]) : [])),
      ),
    ];
    const person = await savePerson({ name: input.name?.trim() || first.name, phones }, ctx);
    personId = person.id;
  }

  for (const clientId of clientIds) await attachClient(clientId, personId, ctx);
  return personId;
}

/** Leads already converted for this person, for the person card's history. */
export async function personLeads(personId: string) {
  return db
    .select()
    .from(leads)
    .where(and(eq(leads.personId, personId), ne(leads.name, '')))
    .orderBy(asc(leads.createdAt));
}
