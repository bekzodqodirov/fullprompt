import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { queueGroupPost, type GroupPostKind } from '../../platform/telegram/staff-group-posts';
import { clientMintedHtml, firstCargoHtml, leadWonHtml, type Hero } from './celebrate-text';

/**
 * Praise in front of everybody (0134, the owner, 2026-10-20: «client code
 * ochilganda client code ochgan odamni qutlab hammani oldida maqtaydigan …
 * yokida lead yutilganda», and «qolgani sen aytkandek» = the first cargo of a
 * new client too, because a code is free to open and a carton is not).
 *
 * Each of the three is ONE claim keyed on the thing praised — the client, the
 * lead, the client's first cargo — so a retried job, a re-won lead or two
 * receipts of a new client confirmed the same minute never praise twice.
 * Every function here runs AFTER its door's own work committed and never
 * throws at it: a celebration is an addition.
 */

/** The person, and their Telegram user when they have a linked staff chat (the mention). */
async function heroOf(userId: string): Promise<Hero | null> {
  const rows = await db.execute<{ full_name: string; tg: string | null }>(sql`
    SELECT u.full_name,
           CASE WHEN l.status = 'linked' THEN l.telegram_chat_id::text END AS tg
      FROM users u
      LEFT JOIN telegram_links l ON l.user_id = u.id
     WHERE u.id = ${userId}::uuid`);
  const row = rows[0];
  return row ? { name: row.full_name, telegramUserId: row.tg } : null;
}

/** The n-th post of a kind takes the n-th sentence (celebrate-text.ts's rotation). */
async function rotationIndex(kind: GroupPostKind): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM staff_group_posts WHERE kind = ${kind}`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * A code minted at one of the two APP doors (the «+» and the client form) —
 * called there, beside the round-111 deal, and NOT in `createClient`, for the
 * deal's two reasons: the client import mints the whole book through the
 * service (1,700 posts), and a won lead mints its client inside `winLead`,
 * which is celebrated as the WIN — one person, one moment, one message.
 * The hero is whoever pressed the button: his «client code ochgan odamni».
 */
export async function celebrateNewClient(clientId: string, minterId: string): Promise<void> {
  try {
    const rows = await db.execute<{ client_code: string }>(sql`
      SELECT client_code FROM clients WHERE id = ${clientId}::uuid`);
    const client = rows[0];
    const hero = await heroOf(minterId);
    if (!client || !hero) return;
    const html = clientMintedHtml(hero, client.client_code, await rotationIndex('client'));
    await queueGroupPost({ kind: 'client', dedupeKey: `client:${clientId}`, html, subjectUserId: minterId, withMedia: true });
  } catch (err) {
    logger.error({ err, clientId }, '[staff-group] client celebration failed');
  }
}

/**
 * A lead moved into a WON stage — heard from `LeadStageChanged`, which every
 * stage door announces (the win dialog, the board, the ✏️ form, a bulk move),
 * so no door can win a lead silently. Keyed on the LEAD: a re-win that opens a
 * second deal is still one lead won once. The hero is the lead's owner (the
 * seller whose lead it is), else whoever moved it.
 */
export async function celebrateLeadWon(event: {
  payload: Record<string, unknown>;
  actorId: string | null;
}): Promise<void> {
  if (event.payload.stageKind !== 'won') return;
  const leadId = typeof event.payload.leadId === 'string' ? event.payload.leadId : null;
  if (!leadId) return;
  try {
    const rows = await db.execute<{ owner_id: string | null; client_code: string | null }>(sql`
      SELECT l.owner_id::text AS owner_id, c.client_code
        FROM leads l
        LEFT JOIN clients c ON c.id = l.client_id
       WHERE l.id = ${leadId}::uuid`);
    const lead = rows[0];
    const heroId = lead?.owner_id ?? event.actorId;
    if (!lead || !heroId) return;
    const hero = await heroOf(heroId);
    if (!hero) return;
    const html = leadWonHtml(hero, lead.client_code, await rotationIndex('won'));
    await queueGroupPost({ kind: 'won', dedupeKey: `won:${leadId}`, html, subjectUserId: heroId, withMedia: true });
  } catch (err) {
    logger.error({ err, leadId }, '[staff-group] lead-won celebration failed');
  }
}

/**
 * A NEW client's first cargo — heard from `ReceiptConfirmed`. «First» is this
 * prixod being the client's only confirmed one; the claim is keyed on the
 * CLIENT, so even two first receipts confirmed the same minute praise once.
 * The hero is the receipt's own seller stamp (0117) — the same person the
 * Saturday rating credits with this kub — and a prixod nobody was named on
 * praises nobody. Claimed cargo (a marking given its client later) is not
 * this event and is not celebrated (stated).
 */
export async function celebrateFirstCargo(event: { payload: Record<string, unknown> }): Promise<void> {
  const receiptId = typeof event.payload.receiptId === 'string' ? event.payload.receiptId : null;
  const clientId = typeof event.payload.clientId === 'string' ? event.payload.clientId : null;
  if (!receiptId || !clientId) return;
  try {
    const rows = await db.execute<{
      seller_id: string | null;
      client_code: string;
      m3: string;
      kg: string;
      place: string | null;
      earlier: boolean;
    }>(sql`
      SELECT r.sales_manager_id::text AS seller_id, c.client_code,
             coalesce(sum(rl.total_volume_m3), 0)::text AS m3,
             coalesce(sum(rl.total_weight_kg), 0)::text AS kg,
             w.name AS place,
             EXISTS (SELECT 1 FROM receipts o
                      WHERE o.client_id = r.client_id AND o.id <> r.id AND o.status = 'confirmed') AS earlier
        FROM receipts r
        JOIN clients c ON c.id = r.client_id
        LEFT JOIN warehouses w ON w.id = r.warehouse_id
        LEFT JOIN receipt_lots rl ON rl.receipt_id = r.id
       WHERE r.id = ${receiptId}::uuid AND r.status = 'confirmed'
       GROUP BY r.id, r.sales_manager_id, c.client_code, w.name`);
    const row = rows[0];
    if (!row || row.earlier || !row.seller_id) return;
    const hero = await heroOf(row.seller_id);
    if (!hero) return;
    const html = firstCargoHtml(
      hero,
      row.client_code,
      { m3: Number(row.m3), kg: Number(row.kg), place: row.place },
      await rotationIndex('first_cargo'),
    );
    await queueGroupPost({
      kind: 'first_cargo',
      dedupeKey: `first_cargo:${clientId}`,
      html,
      subjectUserId: row.seller_id,
      withMedia: true,
    });
  } catch (err) {
    logger.error({ err, receiptId }, '[staff-group] first-cargo celebration failed');
  }
}

/**
 * The event drain's door (platform/notifications reaches it by dynamic import,
 * beside the deal auto-stage — platform never imports wms). Fenced by the
 * caller's own try/catch as well.
 */
export async function runCelebrations(event: {
  type: string;
  payload: Record<string, unknown>;
  actorId: string | null;
}): Promise<void> {
  if (event.type === 'LeadStageChanged') await celebrateLeadWon(event);
  if (event.type === 'ReceiptConfirmed') await celebrateFirstCargo(event);
}
