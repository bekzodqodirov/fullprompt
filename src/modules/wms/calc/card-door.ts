import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { mayOpenLead } from '../crm/lead-door';
import { canWriteDeal } from '../deals/service';

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
 * stage, no win, no tasks), the lenta takes a TEXT note on the lead or deal
 * itself, and the deal card's own writes are untouched this round (his
 * question 17 is open).
 */
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
  if (!/^[0-9a-f-]{36}$/i.test(entity.entityId)) return false;
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
  if (!/^[0-9a-f-]{36}$/i.test(entity.entityId)) return null;
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
  if (actor.permissions.has('ved.docs')) return `/hisoblash/${row.requestId}/karta`;
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
