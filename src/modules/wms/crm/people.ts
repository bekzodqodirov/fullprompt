import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { clients, crmPeople, leads } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { phoneDigits, phonesOverlap } from '../client-cabinet/service';
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
        SELECT sum(CASE WHEN ct.type = 'payment' THEN -ct.amount_usd ELSE ct.amount_usd END)
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

/**
 * Every person with their codes, for the list screen.
 *
 * ONE query for the codes rather than `people.map(personCodes)` — that is a
 * per-row query on a list screen, and this list only gets longer as the
 * grouping gets used (#432/#526). The money columns `personCodes` computes
 * are deliberately NOT here: the list prints code chips, and two correlated
 * subqueries per code would be paid for nothing.
 */
export async function peopleWithCodes(limit = 300) {
  const people = await listPeople(limit);
  if (people.length === 0) return [];
  const codes = await db
    .select({ personId: clients.personId, id: clients.id, code: clients.clientCode })
    .from(clients)
    .where(inArray(clients.personId, people.map((person) => person.id)))
    .orderBy(asc(clients.clientCode));
  const byPerson = new Map<string, { id: string; code: string }[]>();
  for (const row of codes) {
    if (!row.personId) continue;
    const list = byPerson.get(row.personId);
    if (list) list.push({ id: row.id, code: row.code });
    else byPerson.set(row.personId, [{ id: row.id, code: row.code }]);
  }
  return people.map((person) => ({ ...person, codeList: byPerson.get(person.id) ?? [] }));
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
 * Phone buckets — the prefilter that makes the suggestion pass linear.
 *
 * `phonesMatch` compares the last `min(9, …)` digits, so it is not an
 * equivalence over one key and cannot be bucketed exactly. The last SEVEN
 * digits can, and it is a strict SUPERSET of the real rule — equal on the
 * last n with n ≥ 9 implies equal on the last 7, so a bucket never loses a
 * true pair. That is `activeClientsByPhone`'s own SQL prefilter (round 108)
 * restated in memory rather than invented here, and the exact rule stays the
 * arbiter inside each bucket.
 *
 * Why it matters: the old pass ran `phonesOverlap` over every OTHER row for
 * every row — `rows.filter` scans the whole list whether a row is already
 * spoken for or not. At the owner's ~1,700 codes that is ~2.9 million
 * iterations, each normalising two arrays of strings, on the one Node
 * process that serves every screen (#432). Buckets turn it into one pass
 * plus a handful of exact comparisons per number actually shared; the unit
 * test measures both at 1,700 rows rather than asserting a ratio.
 */
export function phoneBuckets<T extends { phones: unknown }>(rows: T[]): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const phones = Array.isArray(row.phones) ? (row.phones as unknown[]) : [];
    const keys = new Set<string>();
    for (const phone of phones) {
      if (typeof phone !== 'string') continue;
      const digits = phoneDigits(phone);
      if (digits.length < 7) continue;
      keys.add(digits.slice(-7));
    }
    for (const key of keys) {
      const list = buckets.get(key);
      if (list) list.push(row);
      else buckets.set(key, [row]);
    }
  }
  return buckets;
}

interface SuggestRow {
  id: string;
  code: string;
  name: string;
  phones: unknown;
  personId: string | null;
  personName: string | null;
}

export type GroupSuggestion =
  /** Codes nobody has grouped yet that look like one another. */
  | { kind: 'new'; phone: string; members: SuggestRow[] }
  /** An ungrouped code that looks like a person who already exists. */
  | { kind: 'join'; phone: string; personId: string; personName: string; members: SuggestRow[] };

/**
 * Codes that look like the same human being, by shared phone number.
 *
 * The owner has hundreds of client cards and will not group them by hand, so
 * the screen offers the obvious pairs and he confirms. Matching reuses the
 * cabinet's last-9-digits rule (DECISIONS #111), which is what already
 * decides whether a phone belongs to a client.
 *
 * **A code can be put BACK, which is why the grouped rows are loaded too.**
 * The first version asked only about codes where BOTH sides were ungrouped,
 * so taking one code out of a person made it unsuggestable for ever — there
 * is no other door, and the owner chose «tizim taklif qiladi … keyin tuzatish
 * ham mumkin» precisely because it must be correctable. A match against a
 * code that already belongs to somebody is therefore a JOIN suggestion
 * naming that person, and `groupClients` has always been able to take one.
 *
 * An ungrouped code matching TWO different people is skipped rather than
 * guessed at: a suggestion that can file cargo under the wrong human being is
 * worse than no suggestion, and the person card's own picker is one tap away
 * (round 32's rule for the same ambiguity).
 */
export async function suggestGroups(limit = 50): Promise<GroupSuggestion[]> {
  const rows: SuggestRow[] = await db
    .select({
      id: clients.id,
      code: clients.clientCode,
      name: clients.name,
      phones: clients.phones,
      personId: clients.personId,
      personName: crmPeople.name,
    })
    .from(clients)
    .leftJoin(crmPeople, eq(clients.personId, crmPeople.id))
    .where(eq(clients.active, true));

  const buckets = phoneBuckets(rows);
  const suggestions: GroupSuggestion[] = [];
  const used = new Set<string>();

  for (const client of rows) {
    if (client.personId || used.has(client.id)) continue;
    const phones = Array.isArray(client.phones) ? (client.phones as string[]) : [];
    if (phones.length === 0) continue;

    // Candidates: everything sharing any of this code's last-7 keys, then the
    // exact rule. A code may sit in several buckets (several numbers), so the
    // set is deduplicated by id.
    const seen = new Set<string>([client.id]);
    const matches: SuggestRow[] = [];
    for (const phone of phones) {
      const digits = phoneDigits(phone);
      if (digits.length < 7) continue;
      for (const other of buckets.get(digits.slice(-7)) ?? []) {
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        if (phonesOverlap(client.phones, other.phones)) matches.push(other);
      }
    }
    if (matches.length === 0) continue;

    const people = [...new Set(matches.filter((m) => m.personId).map((m) => m.personId!))];
    if (people.length > 1) continue; // ambiguous — say nothing
    const phone = phones[0]!;

    if (people.length === 1) {
      const personId = people[0]!;
      const named = matches.find((m) => m.personId === personId)!;
      // Only the UNGROUPED matches are offered — a code already on this
      // person needs nothing, and one belonging to somebody else was ruled
      // out by the ambiguity check above.
      const members = [client, ...matches.filter((m) => !m.personId && !used.has(m.id))];
      for (const member of members) used.add(member.id);
      suggestions.push({
        kind: 'join',
        phone,
        personId,
        personName: named.personName ?? named.name,
        members,
      });
    } else {
      const members = [client, ...matches.filter((m) => !used.has(m.id))];
      for (const member of members) used.add(member.id);
      suggestions.push({ kind: 'new', phone, members });
    }
    if (suggestions.length >= limit) break;
  }
  return suggestions;
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
