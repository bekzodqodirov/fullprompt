import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { userPermissions } from '../../platform/rbac/authorize';
import {
  THREAD_UUID,
  threadKey,
  type ThreadRef,
} from '../../platform/notifications/thread-ref';
import { calcCardExists, type CalcCardEntity } from '../calc/card-door';
import { mayOpenLead } from './lead-door';

/**
 * WHO may read a staff thread — and the writer is the reader (the owner's E
 * answers, 2026-10-07). ONE door, composed from the card doors that already
 * exist, asked by every surface: the lenta, its note box and its action, the
 * contact log's action, the calc page's Q&A and its action, the CalcPanel's
 * folds, the Telegram reply door, the dock list, the read mark and the pulse,
 * and the announce's audience. A surface that restates a door is the leak.
 *
 * The lenta's own gate used to be an inline expression inside ClientFeed
 * (`crm.leads || clients.manage`, then the VED's calc-card arm) and a second
 * copy inside its note action (`crm.leads` alone). It lives HERE now
 * (`lentaReaderOf`), so the lenta and the thread written on it cannot drift
 * apart (#513).
 *
 * The arms:
 *   - lead   — the CRM card's own rule (`mayOpenLead`: owner or the whole
 *              funnel), or the VED's calc-card arm (`ved.docs` and a request
 *              stands on the lead). The one arm with ownership, so E9 a (a
 *              handed-on lead stops reaching its old seller) bites here.
 *   - deal   — the LENTA's gate, never `canWriteDeal`: that one admits
 *              `ved.docs` on EVERY deal (17a), while the deal's lenta admits
 *              the VED only on a deal that carries a calculation.
 *   - client — `crm.leads || clients.manage`, the client lenta's gate (both
 *              imply `mayOpenClientCard`). Deal and client threads have no
 *              ownership, so E9 there is enforced in the AUDIENCE
 *              (internal-chat.ts), not here.
 *   - calc   — `ved.docs`, or the arm of the request's CURRENT card (where a
 *              won lead's request now stands, a deal).
 *
 * The lead's calc arm is `ved.docs && calcCard` and not the lenta's «viaCalc»
 * (which is `!crm && …`): a both-hats person — a seller who also calculates —
 * reaches a colleague's calc lead through the karta (the CRM card bounces him,
 * `calcCardHref`), the karta draws him the lenta and its box, and the box must
 * not refuse what the screen offered.
 */

type Grants = { permissions: { has(code: string): boolean } };
type Reader = { id: string; permissions: { has(code: string): boolean } };

/**
 * THE lenta gate — the one home of what ClientFeed wrote inline. Pure.
 *
 *   crm     = `crm.leads || clients.manage`
 *   viaCalc = not crm, `ved.docs`, and the lenta is drawn for a lead or deal
 *             that carries a calculation (the karta, the VED's deal card)
 *   null    = no lenta for you
 */
export function lentaReaderOf(
  actor: Grants,
  card: { calcCard: boolean },
): { crm: boolean; viaCalc: boolean } | null {
  const crm = actor.permissions.has('crm.leads') || actor.permissions.has('clients.manage');
  const viaCalc = !crm && actor.permissions.has('ved.docs') && card.calcCard;
  if (!crm && !viaCalc) return null;
  return { crm, viaCalc };
}

/**
 * The lenta's own question, asked with the facts loaded — `calcCardExists`
 * only for a reader the CRM grant does not already admit and who holds the
 * VED's grant, so a seller's card render pays nothing for it.
 */
export async function lentaAdmission(
  actor: Grants,
  calcCard: CalcCardEntity | null,
): Promise<{ crm: boolean; viaCalc: boolean } | null> {
  const crm = actor.permissions.has('crm.leads') || actor.permissions.has('clients.manage');
  const exists =
    !crm && calcCard !== null && actor.permissions.has('ved.docs') ? await calcCardExists(calcCard) : false;
  return lentaReaderOf(actor, { calcCard: exists });
}

/** The facts a card's arm needs — loaded by the caller, so the rule itself is pure. */
export type ThreadCard =
  | { kind: 'lead'; ownerId: string | null; calcCard: boolean }
  | { kind: 'deal'; calcCard: boolean }
  | { kind: 'client' };

/** The pure core — what the unit matrix runs over every seeded role. */
export function threadDoorOf(actor: Reader, card: ThreadCard): boolean {
  if (card.kind === 'lead') {
    const reader = { id: actor.id, permissions: actor.permissions as ReadonlySet<string> };
    return mayOpenLead(reader, { ownerId: card.ownerId }) || (actor.permissions.has('ved.docs') && card.calcCard);
  }
  if (card.kind === 'deal') return lentaReaderOf(actor, { calcCard: card.calcCard }) !== null;
  return lentaReaderOf(actor, { calcCard: false })?.crm === true;
}

/** The calc arm over its loaded request — `ved.docs`, or the current card's arm. */
function calcDoorOf(actor: Reader, request: CalcRow | undefined): boolean {
  if (!request) return false;
  if (actor.permissions.has('ved.docs')) return true;
  // A request stands on its card by construction, so the card IS a calc card.
  if (request.entityType === 'lead') {
    return threadDoorOf(actor, { kind: 'lead', ownerId: request.leadOwnerId, calcCard: true });
  }
  if (request.entityType === 'deal') return threadDoorOf(actor, { kind: 'deal', calcCard: true });
  return false;
}

interface LeadRow {
  id: string;
  ownerId: string | null;
  calcCard: boolean;
}
interface CalcRow {
  id: string;
  entityType: string;
  entityId: string;
  leadOwnerId: string | null;
}

/** The lead facts for a set of ids — the owner and «a request stands here», in ONE statement. */
async function leadFacts(ids: string[]): Promise<Map<string, LeadRow>> {
  const out = new Map<string, LeadRow>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ id: string; owner_id: string | null; calc_card: boolean }>(sql`
    SELECT l.id::text AS id, l.owner_id::text AS owner_id,
           (EXISTS (SELECT 1 FROM calc_requests r WHERE r.entity_type = 'lead' AND r.entity_id = l.id)
            OR EXISTS (SELECT 1 FROM calc_requests r JOIN crm_activities a ON a.id = r.note_id
                        WHERE a.entity_type = 'lead' AND a.entity_id = l.id)) AS calc_card
      FROM leads l
     WHERE l.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  for (const row of rows) out.set(row.id, { id: row.id, ownerId: row.owner_id, calcCard: Boolean(row.calc_card) });
  return out;
}

/** The deal facts: it exists, and whether a request stands on it (`dealCarriesCalcSql`'s sentence). */
async function dealFacts(ids: string[]): Promise<Map<string, { calcCard: boolean }>> {
  const out = new Map<string, { calcCard: boolean }>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ id: string; calc_card: boolean }>(sql`
    SELECT d.id::text AS id,
           EXISTS (SELECT 1 FROM calc_requests r WHERE r.entity_type = 'deal' AND r.entity_id = d.id) AS calc_card
      FROM deals d
     WHERE d.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  for (const row of rows) out.set(row.id, { calcCard: Boolean(row.calc_card) });
  return out;
}

async function clientFacts(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.execute<{ id: string }>(sql`
    SELECT c.id::text AS id FROM clients c
     WHERE c.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  return new Set(rows.map((r) => r.id));
}

/** A request's current card and, when that is a lead, its owner. */
async function calcFacts(ids: string[]): Promise<Map<string, CalcRow>> {
  const out = new Map<string, CalcRow>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ id: string; entity_type: string; entity_id: string; lead_owner: string | null }>(sql`
    SELECT r.id::text AS id, r.entity_type, r.entity_id::text AS entity_id, l.owner_id::text AS lead_owner
      FROM calc_requests r
      LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
     WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  for (const row of rows) {
    out.set(row.id, { id: row.id, entityType: row.entity_type, entityId: row.entity_id, leadOwnerId: row.lead_owner });
  }
  return out;
}

/**
 * The batch — for the dock and the audiences: at most FOUR queries whatever
 * the row count (#432), one per kind present. Returns the admitted refs'
 * keys (`threadKey`). A forged id is simply not admitted (#514).
 */
export async function threadDoorsFor(actor: Reader, refs: readonly ThreadRef[]): Promise<Set<string>> {
  const valid = refs.filter((ref) => THREAD_UUID.test(ref.id)).map((ref) => ({ kind: ref.kind, id: ref.id.toLowerCase() }));
  const idsOf = (kind: ThreadRef['kind']) => [...new Set(valid.filter((r) => r.kind === kind).map((r) => r.id))];
  const [leadRows, dealRows, clientRows, calcRows] = await Promise.all([
    leadFacts(idsOf('lead')),
    dealFacts(idsOf('deal')),
    clientFacts(idsOf('client')),
    calcFacts(idsOf('calc')),
  ]);
  const out = new Set<string>();
  for (const ref of valid) {
    let ok = false;
    if (ref.kind === 'lead') {
      const row = leadRows.get(ref.id);
      ok = row !== undefined && threadDoorOf(actor, { kind: 'lead', ownerId: row.ownerId, calcCard: row.calcCard });
    } else if (ref.kind === 'deal') {
      const row = dealRows.get(ref.id);
      ok = row !== undefined && threadDoorOf(actor, { kind: 'deal', calcCard: row.calcCard });
    } else if (ref.kind === 'client') {
      ok = clientRows.has(ref.id) && threadDoorOf(actor, { kind: 'client' });
    } else {
      ok = calcDoorOf(actor, calcRows.get(ref.id));
    }
    if (ok) out.add(threadKey(ref));
  }
  return out;
}

/**
 * One thread's facts, loaded ONCE — for a caller that asks the door of many
 * people about the same thread (the announce's audience): the facts are the
 * thread's, the grants are each person's, and `threadDoorWith` is pure.
 * Null = no such thread (a forged id, a deleted card).
 */
export type ThreadFacts =
  | { kind: 'lead'; ownerId: string | null; calcCard: boolean }
  | { kind: 'deal'; calcCard: boolean }
  | { kind: 'client' }
  | { kind: 'calc'; entityType: string; leadOwnerId: string | null };

export async function threadFacts(ref: ThreadRef): Promise<ThreadFacts | null> {
  if (!THREAD_UUID.test(ref.id)) return null;
  const id = ref.id.toLowerCase();
  if (ref.kind === 'lead') {
    const row = (await leadFacts([id])).get(id);
    return row ? { kind: 'lead', ownerId: row.ownerId, calcCard: row.calcCard } : null;
  }
  if (ref.kind === 'deal') {
    const row = (await dealFacts([id])).get(id);
    return row ? { kind: 'deal', calcCard: row.calcCard } : null;
  }
  if (ref.kind === 'client') return (await clientFacts([id])).has(id) ? { kind: 'client' } : null;
  const row = (await calcFacts([id])).get(id);
  return row ? { kind: 'calc', entityType: row.entityType, leadOwnerId: row.leadOwnerId } : null;
}

/** The door over loaded facts — pure, the same arms as `threadDoorsFor`. */
export function threadDoorWith(actor: Reader, facts: ThreadFacts | null): boolean {
  if (!facts) return false;
  if (facts.kind === 'calc') {
    return calcDoorOf(actor, { id: '', entityType: facts.entityType, entityId: '', leadOwnerId: facts.leadOwnerId });
  }
  return threadDoorOf(actor, facts);
}

/** May this person read (and so write in) this thread? */
export async function mayReadThread(actor: Reader, ref: ThreadRef): Promise<boolean> {
  if (!THREAD_UUID.test(ref.id)) return false;
  return (await threadDoorsFor(actor, [ref])).has(threadKey(ref));
}

/** One name for the writer's question, the same answer — the writer is the reader. */
export const mayWriteThread = mayReadThread;

/** The same rule for a user id — the audience filter. Loads the person's grants. */
export async function userMayReadThread(userId: string, ref: ThreadRef): Promise<boolean> {
  return mayReadThread({ id: userId, permissions: await userPermissions(userId) }, ref);
}

/**
 * Who STANDS on a thread although the door may not admit him — re-derived
 * from the rows, never a payload (§3.4 «standing», G4 a). Two people:
 *
 *   - the person carrying the record: the lead's or deal's CURRENT owner, for
 *     its card thread and for a calculation standing on it. A bot intake lands
 *     a stranger's request on a NEW lead created under the sender, so a
 *     warehouse operator or an accountant can own a lead and fail
 *     `mayOpenLead`; the note pings have always reached him, and keeping him
 *     is not a widening;
 *   - for a calc thread, the request's `requested_by` WHEN he lacks
 *     `crm.leads` — «🧮 Hisoblatish» is open to all staff (G4 a). A CRM
 *     seller-requester is given no standing: a lead handed on drops him like
 *     anybody (E9 a).
 *
 * Standing is REPLY-ONLY: the ping carries no link, the dock does not list
 * it, and the web never shows the thread for it.
 */
export async function threadStanding(userId: string, ref: ThreadRef): Promise<boolean> {
  if (!THREAD_UUID.test(ref.id) || !THREAD_UUID.test(userId)) return false;
  if (ref.kind === 'client') return false;
  if (ref.kind === 'lead' || ref.kind === 'deal') {
    const table = ref.kind === 'lead' ? sql`leads` : sql`deals`;
    const rows = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = ${ref.id}::uuid AND t.owner_id = ${userId}::uuid) AS ok
    `);
    return Boolean(rows[0]?.ok);
  }
  const rows = await db.execute<{ requested_by: string | null; owner_id: string | null }>(sql`
    SELECT r.requested_by::text AS requested_by,
           COALESCE(l.owner_id, d.owner_id)::text AS owner_id
      FROM calc_requests r
      LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
      LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
     WHERE r.id = ${ref.id}::uuid
  `);
  const row = rows[0];
  if (!row) return false;
  if (row.owner_id === userId) return true;
  if (row.requested_by === userId) {
    return !(await userPermissions(userId)).has('crm.leads');
  }
  return false;
}
