import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { cardLink } from '../../platform/notifications/links';
import { userPermissions } from '../../platform/rbac/authorize';
import { mayOpenLead } from '../crm/lead-door';
import { isAnswerSql } from './credit';
import { canWriteDeal } from '../deals/service';
import { dealCarriesCalcSql } from '../deals/ved-work';

/**
 * The VED on the seller's card (the owner's 14a 15a 16a, docs/VED-TARIX.md
 * §10): «noaniqliklar bolganda ved hodimi hsoblashdan kartaga otib
 * aniqlashtirib oladi».
 *
 * ONE door, asked by every place that lets a calculator onto a card: the
 * karta route, the lenta (`ClientFeed`) and its note action, the 🧮 panel,
 * the Telegram thread and its pulse, the `crm_activity` file branch, and
 * every «Kartaga o'tish» link (`calcCardHref`).
 *
 * The rule: `ved.docs` AND the card carries a calculation request — any
 * status, because 15a's question is «which cards», and a closed job's card
 * is exactly where a VED goes back to ask why. Only cards that carry a
 * request: the VED is not given the funnel.
 *
 * What the door does NOT give is a write: the karta is read-only (no ✏️, no
 * stage, no win, no tasks) and the lenta takes a TEXT note on the lead or deal
 * itself. His 17a (2026-10-07) answered question 17 for the deal card the same
 * way: the card's writes split, and only its positions and prixods are the
 * VED's — see `deals/door.ts` `mayEditDealTerms`. The deal arm below is
 * `dealCarriesCalcSql`, the very sentence his deal board, his home row and
 * his ⌘K ask (`deals/ved-work.ts`, #513).
 */
/**
 * The STRICT uuid shape (review access-6). Every id below is cast `::uuid`,
 * and the loose «36 hex digits and dashes» admits strings postgres refuses
 * with 22P02 — a hand-typed karta URL was an error page instead of «no such
 * card» (#514). The tarix page and the chat routes already used this one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CalcCardReader {
  id: string;
  permissions: { has(code: string): boolean };
}

export interface CalcCardEntity {
  entityType: 'lead' | 'deal';
  entityId: string;
}

/**
 * Does a calculation request stand on this card?
 *
 * A LEAD also counts when a request's materials NOTE sits on it (review
 * tests-completeness-21): winning a lead moves every request to the new deal
 * (`rekeyLeadCalcRequests`) while its lenta stays on the lead, so the VED's
 * question and the seller's answer would vanish from every card he can open.
 * The note is the one stored link a won lead keeps to its requests. A request
 * opened with no materials leaves no such link — STATED: a deal-side pointer
 * to the lead it was won from is a schema change this round does not make.
 */
export async function calcCardExists(entity: CalcCardEntity): Promise<boolean> {
  if (entity.entityType !== 'lead' && entity.entityType !== 'deal') return false;
  if (!UUID.test(entity.entityId)) return false;
  if (entity.entityType === 'deal') {
    // The deal board's own fragment, through the deal ROW: a request naming a
    // deal that no longer exists stops counting — there is no card to open.
    const dealRows = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM deals d
         WHERE d.id = ${entity.entityId}::uuid AND ${dealCarriesCalcSql(sql`d`)}
      ) AS ok
    `);
    return Boolean(dealRows[0]?.ok);
  }
  // A lead: a request on the lead OR its materials note (below), unchanged.
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT (
      EXISTS (
        SELECT 1 FROM calc_requests r
         WHERE r.entity_type = ${entity.entityType} AND r.entity_id = ${entity.entityId}::uuid
      )
      OR (${entity.entityType} = 'lead' AND EXISTS (
        SELECT 1 FROM calc_requests r
          JOIN crm_activities a ON a.id = r.note_id
         WHERE a.entity_type = 'lead' AND a.entity_id = ${entity.entityId}::uuid
      ))
    ) AS ok
  `);
  return Boolean(rows[0]?.ok);
}

/**
 * Is this CLIENT the stored client of a calc card (review access-money-5)?
 *
 * The lenta of a calc card shows the card's client's notes too — the deal
 * card always has (`deal.client_id`), and the karta passes the lead's STORED
 * `client_id` (never the phone match, which SQL cannot restate) — so a file on
 * such a note must open for the VED reading it. ONE home for that reverse
 * question, asked by the `crm_activity` file branch alone; the forward half
 * is the two card pages passing exactly these columns.
 */
export async function isCalcCardClient(clientId: string): Promise<boolean> {
  if (!UUID.test(clientId)) return false;
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM calc_requests r
        LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
        LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
       WHERE d.client_id = ${clientId}::uuid OR l.client_id = ${clientId}::uuid
    ) AS ok
  `);
  return Boolean(rows[0]?.ok);
}

/**
 * Was this lead EVER priced — sealed or answered (review access-money-9)?
 *
 * The seal writes the VED's floor onto `leads.quoted_amount`, so once a job
 * is sealed that column is no longer what the seller wrote. The karta prints
 * it — labelled «sotuvchi yozgan taxmin» — only for a card no calculation has
 * ever priced; the seller's real price is the offers list (16a). «Ever», not
 * «stands»: a superseded or expired seal wrote the column just the same.
 */
export async function leadEverPriced(leadId: string): Promise<boolean> {
  if (!UUID.test(leadId)) return false;
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM calc_requests r
       WHERE (
               (r.entity_type = 'lead' AND r.entity_id = ${leadId}::uuid)
               OR EXISTS (
                 SELECT 1 FROM crm_activities a
                  WHERE a.id = r.note_id AND a.entity_type = 'lead' AND a.entity_id = ${leadId}::uuid
               )
             )
         AND (r.current_version_no > 0 OR ${isAnswerSql('r')})
    ) AS ok
  `);
  return Boolean(rows[0]?.ok);
}

/** May this person open the card as a CALCULATOR (read, and a text note)? */
export async function mayOpenCalcCard(
  actor: CalcCardReader,
  entity: CalcCardEntity,
): Promise<boolean> {
  if (!actor.permissions.has('ved.docs')) return false;
  return calcCardExists(entity);
}

/** The newest request on a card — where a ping to the karta points. */
export async function newestRequestOn(entity: CalcCardEntity): Promise<string | null> {
  if (!UUID.test(entity.entityId)) return null;
  const rows = await db.execute<{ id: string }>(sql`
    SELECT r.id::text AS id
      FROM calc_requests r
     WHERE (r.entity_type = ${entity.entityType} AND r.entity_id = ${entity.entityId}::uuid)
        OR (${entity.entityType} = 'lead' AND EXISTS (
              SELECT 1 FROM crm_activities a
               WHERE a.id = r.note_id AND a.entity_type = 'lead' AND a.entity_id = ${entity.entityId}::uuid
            ))
     ORDER BY r.requested_at DESC
     LIMIT 1
  `);
  return rows[0]?.id ?? null;
}

/**
 * The ONE link from a calc surface to the job's card (review
 * access-money-14): the queue, the workspace, the history, «Oxirgi
 * yakunlanganlar» and the card panel's «#» all ask it, so no surface draws a
 * door the destination bounces.
 *
 *   - a DEAL → `/bitimlar/<id>` for whoever the deal card admits
 *     (`canWriteDeal`), else no link — the accountant reads the history and
 *     cannot open a deal card, and a link that bounces home is a dead door;
 *   - a LEAD → the real `/crm/leads/<id>` when the CRM card admits this
 *     reader (`mayOpenLead` — `crm.leads` alone is not enough: a both-hats
 *     person who does not own the lead is bounced there, access-money-15);
 *   - else the karta `/hisoblash/<request>/karta` for `ved.docs` — the row
 *     IS a calculation request, so the card carries one by construction;
 *   - else nothing.
 */
export function calcCardHref(
  actor: CalcCardReader,
  row: { entityType: string; entityId: string; requestId: string; leadOwnerId?: string | null },
): string | null {
  if (row.entityType === 'deal') {
    return canWriteDeal(actor.permissions) ? `/bitimlar/${row.entityId}` : null;
  }
  if (row.entityType !== 'lead') return null;
  const reader = { id: actor.id, permissions: actor.permissions as ReadonlySet<string> };
  if (mayOpenLead(reader, { ownerId: row.leadOwnerId ?? null })) return `/crm/leads/${row.entityId}`;
  if (actor.permissions.has('ved.docs')) return kartaHref(row.requestId);
  return null;
}

/**
 * Lead NAMES on a calc surface (§10, review access-money-14): every row of
 * the queue and the history is a calc card by construction, so the VED reads
 * the name of the job he prices; the accountant (neither grant) keeps «Lid».
 * A NAME question, kept apart from the LINK question above.
 */
export function leadNameReadable(actor: { permissions: { has(code: string): boolean } }): boolean {
  return actor.permissions.has('crm.leads') || actor.permissions.has('ved.docs');
}

/**
 * Which card a karta URL draws (docs/VED-TARIX.md §10).
 *
 * The karta is keyed by the REQUEST, because that is what every calc surface
 * holds. A request on a lead draws that lead; a request on a deal is the deal
 * card's (`/bitimlar/<id>` — the karta redirects there). `?lid=` names the
 * LEAD a won request came from (review tests-completeness-21): winning moves
 * every request onto the new deal while the lenta — the VED's question and
 * the seller's answer — stays on the lead, so a ping about a note on that
 * lead links here with `lid`, and the lead is drawn when the request's own
 * materials note sits on it. A `lid` the request has no stored link to is
 * ignored, never trusted (#514).
 */
export type KartaCard =
  /** `wonDealId`: the deal this lead's request moved to when it was won. */
  | { kind: 'lead'; leadId: string; requestId: string; wonDealId: string | null }
  | { kind: 'deal'; dealId: string; requestId: string };

export async function kartaCardFor(
  requestId: string,
  leadParam?: string | null,
): Promise<KartaCard | null> {
  if (!UUID.test(requestId)) return null;
  const rows = await db.execute<{ entity_type: string; entity_id: string; note_lead: string | null }>(sql`
    SELECT r.entity_type, r.entity_id::text AS entity_id, a.entity_id::text AS note_lead
      FROM calc_requests r
      LEFT JOIN crm_activities a ON a.id = r.note_id AND a.entity_type = 'lead'
     WHERE r.id = ${requestId}::uuid
  `);
  const row = rows[0];
  if (!row) return null;
  const lid = leadParam && UUID.test(leadParam) ? leadParam.toLowerCase() : null;
  if (lid && ((row.entity_type === 'lead' && row.entity_id === lid) || row.note_lead === lid)) {
    const wonDealId = row.entity_type === 'deal' ? row.entity_id : null;
    return { kind: 'lead', leadId: lid, requestId, wonDealId };
  }
  if (row.entity_type === 'lead') {
    return { kind: 'lead', leadId: row.entity_id, requestId, wonDealId: null };
  }
  if (row.entity_type === 'deal') return { kind: 'deal', dealId: row.entity_id, requestId };
  return null;
}

/** The karta's address — `lid` only for a lead the request was won away from. */
export function kartaHref(requestId: string, leadId?: string | null): string {
  return `/hisoblash/${requestId}/karta${leadId ? `?lid=${leadId}` : ''}`;
}

/**
 * Where a note ping links EACH recipient (review access-money-4,
 * tests-completeness-16).
 *
 * The seller answers the VED's question on the card, and the answer reaches
 * the VED as an InternalNote or a MentionedInNote — whose link went to
 * `/crm/leads/<id>`, which the CRM layout bounces him from. So the link is
 * chosen per person: the card itself for whoever the card admits, the karta
 * for a calculator the card does not admit but the calc door does, and NO
 * link for anybody else (a link that bounces home is a dead door).
 *
 * A client entity keeps the card link for everybody — no karta writes there
 * (the VED's note is forced onto the lead or the deal).
 */
export async function noteLinksFor(
  entity: { entityType: 'client' | 'lead' | 'deal'; entityId: string },
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const card = cardLink(entity.entityType, entity.entityId);
  if (entity.entityType === 'client') {
    for (const id of userIds) out.set(id, card);
    return out;
  }
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  let owner: string | null = null;
  if (entity.entityType === 'lead') {
    const rows = await db.execute<{ owner_id: string | null }>(sql`
      SELECT owner_id::text AS owner_id FROM leads WHERE id = ${entity.entityId}::uuid
    `);
    owner = rows[0]?.owner_id ?? null;
  }
  // The karta link is the same for every calculator — read once, lazily.
  let karta: string | null | undefined;
  for (const id of userIds) {
    const permissions = await userPermissions(id);
    const cardAdmits =
      entity.entityType === 'lead'
        ? mayOpenLead({ id, permissions }, { ownerId: owner })
        : canWriteDeal(permissions);
    if (cardAdmits) {
      out.set(id, card);
      continue;
    }
    if (permissions.has('ved.docs')) {
      if (karta === undefined) {
        const requestId = await newestRequestOn({
          entityType: entity.entityType,
          entityId: entity.entityId,
        });
        karta = requestId
          ? `${appUrl}${kartaHref(requestId, entity.entityType === 'lead' ? entity.entityId : null)}`
          : null;
      }
      out.set(id, karta);
      continue;
    }
    out.set(id, null);
  }
  return out;
}
