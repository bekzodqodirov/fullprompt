import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { actorGrants, userPermissions } from '../../platform/rbac/authorize';
import {
  THREAD_UUID,
  idsByKind,
  threadKey,
  type ThreadRef,
} from '../../platform/notifications/thread-ref';
import { mayOpenBatchCard, type BatchEnds } from '../batches/card-door';
import { calcCardExists, type CalcCardEntity } from '../calc/card-door';
import { batchStands, receiptStands, type CargoStand } from '../inventory/stands';
import { mayReadReceipt, receiptsReadableBy } from '../receipts/read-door';
import { mayOpenLead } from './lead-door';

/**
 * WHO may read a staff thread — and the writer is the reader (the owner's E
 * answers, 2026-10-07). ONE door, composed from the card doors that already
 * exist, asked by every surface: the lenta, its note box and its action, the
 * contact log's action, the calc page's Q&A and its action, the CalcPanel's
 * folds, the prixod's and the truck's «❓ Savol-javob» and their action, the
 * Telegram reply door, the dock list, the read mark and the pulse, and the
 * announce's audience. A surface that restates a door is the leak.
 *
 * The lenta's own gate used to be an inline expression inside ClientFeed
 * (`crm.leads || clients.manage`, then the VED's calc-card arm) and a second
 * copy inside its note action (`crm.leads` alone). It lives HERE now
 * (`lentaReaderOf`), so the lenta and the thread written on it cannot drift
 * apart (#513).
 *
 * The arms:
 *   - lead    — the CRM card's own rule (`mayOpenLead`: owner or the whole
 *               funnel), or the VED's calc-card arm (`ved.docs` and a request
 *               stands on the lead). The one arm with ownership, so E9 a (a
 *               handed-on lead stops reaching its old seller) bites here.
 *   - deal    — the LENTA's gate, never `canWriteDeal`: that one admits
 *               `ved.docs` on EVERY deal (17a), while the deal's lenta admits
 *               the VED only on a deal that carries a calculation.
 *   - client  — `crm.leads || clients.manage`, the client lenta's gate (both
 *               imply `mayOpenClientCard`). Deal and client threads have no
 *               ownership, so E9 there is enforced in the AUDIENCE
 *               (internal-chat.ts), not here.
 *   - calc    — `ved.docs`, or the arm of the request's CURRENT card (where a
 *               won lead's request now stands, a deal).
 *   - receipt, batch (round 2, 0129 — the CARGO threads, E7 b «logistlar,
 *               rahbarlar va yuk turgan sklad hodimlari») — the card's OWN door
 *               AND either the office (an UNSCOPED `plans.manage` holder: the
 *               logist, the admins) or a warehouse-SCOPED person at a warehouse
 *               where the cargo stands NOW (`inventory/stands.ts`, Q4 a). Never
 *               a seller, the VED or the accountant; a scoped logist is judged
 *               as staff (scope intersects, catalog.ts). `cargoThreadDoorOf`.
 *
 * The lead's calc arm is `ved.docs && calcCard` and not the lenta's «viaCalc»
 * (which is `!crm && …`): a both-hats person — a seller who also calculates —
 * reaches a colleague's calc lead through the karta (the CRM card bounces him,
 * `calcCardHref`), the karta draws him the lenta and its box, and the box must
 * not refuse what the screen offered.
 */

type Grants = { permissions: { has(code: string): boolean } };

/**
 * The reader every thread door asks — the grants AND the warehouse scope
 * (round 2: the cargo arm is a question about WHERE a person works). REQUIRED
 * everywhere: never fill the two scope fields with `false`/`[]` to silence the
 * compiler — a scoped reader judged as unscoped is admitted by the office
 * arm's card door and handed a link that 404s. `getActor()`'s Actor and
 * `actorGrants` are supersets.
 */
export type ThreadReader = {
  id: string;
  permissions: { has(code: string): boolean };
  warehouseScoped: boolean;
  warehouseIds: string[];
};

/** The office's grant on a cargo thread (E7 b «logistlar, rahbarlar»): logist + admin + super_admin in the shipped matrix. */
export const CARGO_OFFICE_PERMISSION = 'plans.manage';

/**
 * Pure — the cargo arm. The card door is an INPUT: the thread door must imply
 * it, or a ping's link bounces.
 */
export function cargoThreadDoorOf(
  actor: ThreadReader,
  card: { stands: readonly string[]; cardDoor: boolean },
): boolean {
  if (!card.cardDoor) return false;
  // Arm (a), the office — UNSCOPED holders only. For a scoped person the card
  // door is wider than «stands» (the receiving warehouse for ever,
  // read-door.ts; the planned carton's truck destination, near.ts), so a
  // grant that short-circuited would hand a scoped logist every prixod his
  // warehouse ever received.
  if (!actor.warehouseScoped && actor.permissions.has(CARGO_OFFICE_PERMISSION)) return true;
  // Arm (b), the staff — and any SCOPED person, logist or not: scope
  // intersects, narrowest wins (catalog.ts). The SCOPE, never a permission:
  // «a person whose job is AT a warehouse» is the role's column (0049).
  return actor.warehouseScoped && card.stands.some((w) => actor.warehouseIds.includes(w));
}

/** Can this person pass EITHER cargo arm anywhere — the gate before a cargo fact is loaded for him. */
function mayReadCargoThreads(actor: ThreadReader): boolean {
  return (
    (!actor.warehouseScoped && actor.permissions.has(CARGO_OFFICE_PERMISSION)) ||
    (actor.warehouseScoped && actor.warehouseIds.length > 0)
  );
}

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
  | { kind: 'client' }
  | { kind: 'receipt'; stands: readonly string[]; cardDoor: boolean }
  | { kind: 'batch'; stands: readonly string[]; cardDoor: boolean };

/** The pure core — what the unit matrix runs over every seeded role. */
export function threadDoorOf(actor: ThreadReader, card: ThreadCard): boolean {
  switch (card.kind) {
    case 'lead': {
      const reader = { id: actor.id, permissions: actor.permissions as ReadonlySet<string> };
      return mayOpenLead(reader, { ownerId: card.ownerId }) || (actor.permissions.has('ved.docs') && card.calcCard);
    }
    case 'deal':
      return lentaReaderOf(actor, { calcCard: card.calcCard }) !== null;
    case 'client':
      return lentaReaderOf(actor, { calcCard: false })?.crm === true;
    case 'receipt':
    case 'batch':
      return cargoThreadDoorOf(actor, card);
    default: {
      const never: never = card;
      return never;
    }
  }
}

/**
 * «Can this person EVER have a thread row» — the dock's «👥 Ichki» tab
 * (layout.tsx). The door's own people, never a restated grant list: the CRM
 * lenta's readers, the VED, and the two cargo arms exactly as
 * `cargoThreadDoorOf` writes them (an unscoped office holder, or a scoped
 * person with a warehouse).
 */
export function mayHaveThreads(actor: ThreadReader): boolean {
  return (
    lentaReaderOf(actor, { calcCard: false }) !== null ||
    actor.permissions.has('ved.docs') ||
    (!actor.warehouseScoped && actor.permissions.has(CARGO_OFFICE_PERMISSION)) ||
    (actor.warehouseScoped && actor.warehouseIds.length > 0)
  );
}

/** The calc arm over its loaded request — `ved.docs`, or the current card's arm. */
function calcDoorOf(actor: ThreadReader, request: CalcRow | undefined): boolean {
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

type ReceiptStandRow = { receivingWarehouseId: string; stand: CargoStand };
type BatchStandRow = { ends: BatchEnds; status: string; stand: CargoStand };

/**
 * The batch — for the dock and the audiences: at most NINE statements
 * whatever the row count (#432): one per CRM kind present (four), two for the
 * prixods' stands, two for the trucks' (their rows + `awaitingUnloadCounts`),
 * and the prixods' card door once (`receiptsReadableBy` — none at all for an
 * unscoped reader). A reader who can pass NEITHER cargo arm — every seller,
 * the VED, the accountant — is answered false for every cargo ref with no
 * fact loaded. Returns the admitted refs' keys (`threadKey`). A forged id is
 * simply not admitted (#514).
 */
export async function threadDoorsFor(actor: ThreadReader, refs: readonly ThreadRef[]): Promise<Set<string>> {
  const ids = idsByKind(refs);
  const cargo = mayReadCargoThreads(actor);
  const [leadRows, dealRows, clientRows, calcRows, receiptRows, batchRows] = await Promise.all([
    leadFacts(ids.lead),
    dealFacts(ids.deal),
    clientFacts(ids.client),
    calcFacts(ids.calc),
    cargo ? receiptStands(ids.receipt) : Promise.resolve(new Map<string, ReceiptStandRow>()),
    cargo ? batchStands(ids.batch) : Promise.resolve(new Map<string, BatchStandRow>()),
  ]);
  // The prixod card's own door, asked ONCE for every receipt ref (read-door.ts).
  const receiptCards =
    receiptRows.size > 0
      ? await receiptsReadableBy(
          actor,
          [...receiptRows].map(([id, row]) => ({ id, warehouseId: row.receivingWarehouseId })),
        )
      : new Set<string>();
  const out = new Set<string>();
  for (const ref of refs) {
    if (!THREAD_UUID.test(ref.id)) continue;
    const id = ref.id.toLowerCase();
    let ok = false;
    switch (ref.kind) {
      case 'lead': {
        const row = leadRows.get(id);
        ok = row !== undefined && threadDoorOf(actor, { kind: 'lead', ownerId: row.ownerId, calcCard: row.calcCard });
        break;
      }
      case 'deal': {
        const row = dealRows.get(id);
        ok = row !== undefined && threadDoorOf(actor, { kind: 'deal', calcCard: row.calcCard });
        break;
      }
      case 'client':
        ok = clientRows.has(id) && threadDoorOf(actor, { kind: 'client' });
        break;
      case 'calc':
        ok = calcDoorOf(actor, calcRows.get(id));
        break;
      case 'receipt': {
        const row = receiptRows.get(id);
        ok =
          row !== undefined &&
          threadDoorOf(actor, { kind: 'receipt', stands: row.stand.warehouseIds, cardDoor: receiptCards.has(id) });
        break;
      }
      case 'batch': {
        const row = batchRows.get(id);
        ok =
          row !== undefined &&
          threadDoorOf(actor, {
            kind: 'batch',
            stands: row.stand.warehouseIds,
            cardDoor: mayOpenBatchCard(actor, row.ends),
          });
        break;
      }
      default: {
        // A kind the union does not know (a malformed row) is nobody's thread.
        const never: never = ref.kind;
        void never;
        ok = false;
      }
    }
    if (ok) out.add(threadKey({ kind: ref.kind, id }));
  }
  return out;
}

/**
 * One thread's facts, loaded ONCE — for a caller that asks the door of many
 * people about the same thread (the announce's audience, the mentions, the
 * ping's frame): the facts are the thread's, the grants are each person's.
 * Null = no such thread (a forged id, a deleted card).
 */
export type ThreadFacts =
  | { kind: 'lead'; ownerId: string | null; calcCard: boolean }
  | { kind: 'deal'; calcCard: boolean }
  | { kind: 'client' }
  | { kind: 'calc'; entityType: string; leadOwnerId: string | null }
  | { kind: 'receipt'; receiptId: string; receivingWarehouseId: string; stand: CargoStand }
  | { kind: 'batch'; ends: BatchEnds; status: string; stand: CargoStand };

export async function threadFacts(ref: ThreadRef): Promise<ThreadFacts | null> {
  if (!THREAD_UUID.test(ref.id)) return null;
  const id = ref.id.toLowerCase();
  switch (ref.kind) {
    case 'lead': {
      const row = (await leadFacts([id])).get(id);
      return row ? { kind: 'lead', ownerId: row.ownerId, calcCard: row.calcCard } : null;
    }
    case 'deal': {
      const row = (await dealFacts([id])).get(id);
      return row ? { kind: 'deal', calcCard: row.calcCard } : null;
    }
    case 'client':
      return (await clientFacts([id])).has(id) ? { kind: 'client' } : null;
    case 'calc': {
      const row = (await calcFacts([id])).get(id);
      return row ? { kind: 'calc', entityType: row.entityType, leadOwnerId: row.leadOwnerId } : null;
    }
    case 'receipt': {
      const row = (await receiptStands([id])).get(id);
      return row
        ? { kind: 'receipt', receiptId: id, receivingWarehouseId: row.receivingWarehouseId, stand: row.stand }
        : null;
    }
    case 'batch': {
      const row = (await batchStands([id])).get(id);
      return row ? { kind: 'batch', ends: row.ends, status: row.status, stand: row.stand } : null;
    }
    default: {
      const never: never = ref.kind;
      void never;
      return null;
    }
  }
}

/**
 * The door over loaded facts, for MANY people and one thread — the
 * audience's, the mentions'. Returns the admitted people's ids. The CRM kinds
 * are pure per person; the truck's card door is pure (its two ends); the
 * prixod's card door is `mayReadReceipt` ITSELF, asked once per DISTINCT
 * warehouse among the scoped people (`{warehouseScoped: true, warehouseIds:
 * [w]}`) — the rule decomposes over a person's warehouses (`inScope` is
 * membership, `cargoNearActor` an OR over them), so an unscoped person costs
 * no query and ten operators of one warehouse cost one.
 */
export async function threadDoorsWith(
  people: readonly ThreadReader[],
  facts: ThreadFacts | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!facts) return out;
  switch (facts.kind) {
    case 'calc': {
      const request = { id: '', entityType: facts.entityType, entityId: '', leadOwnerId: facts.leadOwnerId };
      for (const person of people) if (calcDoorOf(person, request)) out.add(person.id);
      return out;
    }
    case 'lead':
    case 'deal':
    case 'client':
      for (const person of people) if (threadDoorOf(person, facts)) out.add(person.id);
      return out;
    case 'receipt': {
      const memo = new Map<string, Promise<boolean>>();
      const cardAt = (warehouseId: string): Promise<boolean> => {
        let answer = memo.get(warehouseId);
        if (!answer) {
          answer = mayReadReceipt(
            { warehouseScoped: true, warehouseIds: [warehouseId] },
            { id: facts.receiptId, warehouseId: facts.receivingWarehouseId },
          );
          memo.set(warehouseId, answer);
        }
        return answer;
      };
      for (const person of people) {
        if (!mayReadCargoThreads(person)) continue;
        let cardDoor = !person.warehouseScoped;
        if (!cardDoor) {
          // The standing warehouses first: by the subset property they open the card.
          const order = [
            ...person.warehouseIds.filter((w) => facts.stand.warehouseIds.includes(w)),
            ...person.warehouseIds.filter((w) => !facts.stand.warehouseIds.includes(w)),
          ];
          for (const w of order) {
            if (await cardAt(w)) {
              cardDoor = true;
              break;
            }
          }
        }
        if (threadDoorOf(person, { kind: 'receipt', stands: facts.stand.warehouseIds, cardDoor })) out.add(person.id);
      }
      return out;
    }
    case 'batch':
      for (const person of people) {
        const cardDoor = mayOpenBatchCard(person, facts.ends);
        if (threadDoorOf(person, { kind: 'batch', stands: facts.stand.warehouseIds, cardDoor })) out.add(person.id);
      }
      return out;
    default: {
      const never: never = facts;
      void never;
      return out;
    }
  }
}

/** May this person read (and so write in) this thread? */
export async function mayReadThread(actor: ThreadReader, ref: ThreadRef): Promise<boolean> {
  if (!THREAD_UUID.test(ref.id)) return false;
  return (await threadDoorsFor(actor, [ref])).has(threadKey(ref));
}

/** One name for the writer's question, the same answer — the writer is the reader. */
export const mayWriteThread = mayReadThread;

/** The same rule for a user id — the audience filter. Loads the person's grants AND scope. */
export async function userMayReadThread(userId: string, ref: ThreadRef): Promise<boolean> {
  return mayReadThread({ id: userId, ...(await actorGrants(userId)) }, ref);
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
 * A cargo card (receipt, batch) has no owner and no requester: the mention is
 * its only reply-only door (E2 a).
 *
 * Standing is REPLY-ONLY: the ping carries no link, the dock does not list
 * it, and the web never shows the thread for it.
 */
export async function threadStanding(userId: string, ref: ThreadRef): Promise<boolean> {
  if (!THREAD_UUID.test(ref.id) || !THREAD_UUID.test(userId)) return false;
  switch (ref.kind) {
    case 'client':
    case 'receipt':
    case 'batch':
      return false;
    case 'lead':
      return ownsRecord(sql`leads`, ref.id, userId);
    case 'deal':
      return ownsRecord(sql`deals`, ref.id, userId);
    case 'calc':
      return calcStanding(userId, ref.id);
    default: {
      const never: never = ref.kind;
      void never;
      return false;
    }
  }
}

/** Is this person the record's CURRENT owner? */
async function ownsRecord(table: ReturnType<typeof sql>, id: string, userId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = ${id}::uuid AND t.owner_id = ${userId}::uuid) AS ok
  `);
  return Boolean(rows[0]?.ok);
}

/** The calc arm of `threadStanding`: the current card's owner, or a non-CRM requester. */
async function calcStanding(userId: string, requestId: string): Promise<boolean> {
  const rows = await db.execute<{ requested_by: string | null; owner_id: string | null }>(sql`
    SELECT r.requested_by::text AS requested_by,
           COALESCE(l.owner_id, d.owner_id)::text AS owner_id
      FROM calc_requests r
      LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
      LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
     WHERE r.id = ${requestId}::uuid
  `);
  const row = rows[0];
  if (!row) return false;
  if (row.owner_id === userId) return true;
  if (row.requested_by === userId) {
    return !(await userPermissions(userId)).has('crm.leads');
  }
  return false;
}
