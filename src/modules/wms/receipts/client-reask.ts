import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { receiptLots } from '../../platform/db/schema';
import { writeAudit } from '../../platform/audit/service';
import { isUuidShaped } from '../../platform/audit/fields';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import { linkedChats } from '../notices/client-push';
import { NOTICE_RECEIVED, SKIP_CLIENT_CHANGED } from '../notices/client-claims';
import {
  ASK_MAX_LOTS,
  clientAskFacts,
  NOTICE_LOT_ASK,
  NOTICE_LOT_REASK,
  REASK_SUPERSEDED,
  type ClientAskFacts,
} from './client-confirm';
import { askFits } from './client-confirm-text';
import { lotCheckViewsFor, type LotCheckView } from './lot-check';
import { askedTagReady, clientMeasuresReady } from './lot-check-ready';

/**
 * «Yuk qayta tortilganda mijozga savol o'zi qayta borsin» — the owner's «1 b»
 * of 2026-11-12 (docs/PRIXOD-JAVOBLAR.md §1). When a re-weigh makes the
 * question the client HOLDS describe cargo that no longer exists, the system
 * asks again by itself, ten minutes after the last correction.
 *
 * THE TRIGGER (`reaskDue`): a client's ✅ / ❌ is one press under one message
 * about one prixod, and it counts only while the facts read now give the
 * message's tag (`askTag`). So «the question the client holds» is the newest
 * question with buttons DELIVERED to the prixod's owner — the receipt push
 * (when it carried buttons), a person's «Mijozdan so'rash», or this module's
 * own — whose tag the sweep remembered at delivery (`client_notices
 * .asked_tag`, 0147). Due = that tag is not the tag of the question that
 * would be sent now: every button the client holds answers «eskirgan»,
 * whether they had answered or not. A question delivered before 0147 left no
 * tag; for it, an ANSWER that no longer holds is the trigger (the 0146
 * comparison, read through `lotCheckViewsFor` — never restated, #513).
 *
 * WHO ARMS IT: the three writers that move an existing lot's totals, after
 * their commit (`editLot`'s `.then`, `afterLotGrown` for the two count
 * doors). Never inside their transactions — every read here is pooled (#714)
 * — and never failing them (U41): `armClientReask` logs and returns.
 *
 * THE ROW: `lot_reask`, one per (client, prixod) by `client_notices_once`,
 * due `REASK_SETTLE_MINUTES` after the LAST correction — a pending row's
 * window slides, so an office walk of several presses asks once, about where
 * it ended; and the person whose record changed hears it first (#834's rule,
 * kept in that half — his «1 b» reversed its «never the client»).
 *
 * THE SEND (`reaskSendable`): everything above is proved again at send time,
 * from the database, by the sweep's preparer (`arrival-jobs.ts`).
 */

/** How long after the LAST correction the client is asked — the house's correction window. */
export const REASK_SETTLE_MINUTES = 10;

/** The kinds that put a question with buttons in the client's hands. */
const ASKING_KINDS = [NOTICE_RECEIVED, NOTICE_LOT_ASK, NOTICE_LOT_REASK] as const;

/**
 * Is the question the client holds about this prixod out of date? `views` is
 * the caller's own read of the prixod's lots (`lotCheckViewsFor`).
 */
export async function reaskDue(facts: ClientAskFacts, views: Map<string, LotCheckView>): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT asked_tag FROM client_notices
     WHERE client_id = ${facts.clientId}::uuid AND ref_type = 'receipt' AND ref_id = ${facts.receiptId}::uuid
       AND kind IN (${sql.join(
         ASKING_KINDS.map((kind) => sql`${kind}`),
         sql`, `,
       )})
       AND asked_tag IS NOT NULL
     ORDER BY asked_at DESC
     LIMIT 1
  `)) as unknown as { asked_tag: string }[];
  const held = rows[0];
  if (held) return held.asked_tag !== facts.tag;
  // Delivered before 0147 — no tag remembered: a FULL answer of this owner
  // that no longer holds is the one thing that says the client was asked about
  // a weight that has since moved. (A basic answer never asked a weight; an
  // unanswered question left no trace — stated, §1.1.)
  return facts.lots.some((lot) => {
    const client = views.get(lot.lotId)?.client;
    return client !== null && client !== undefined && client.ofOwner && client.measures && !client.holds;
  });
}

/**
 * A question to this owner about this prixod still WAITING to be claimed by
 * the sweep — the receipt push in its correction window, or a person's
 * «Mijozdan so'rash» pressed a moment ago. It is rendered from the facts at
 * SEND time and carries the new figures itself.
 */
async function questionWaiting(facts: Pick<ClientAskFacts, 'clientId' | 'receiptId'>): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM client_notices
     WHERE client_id = ${facts.clientId}::uuid AND ref_type = 'receipt' AND ref_id = ${facts.receiptId}::uuid
       AND kind IN (${NOTICE_RECEIVED}, ${NOTICE_LOT_ASK}) AND status = 'pending'
     LIMIT 1
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}

/** The switch (default on — his «b»): off, nothing is armed and a held question is not sent. */
async function reaskOn(): Promise<boolean> {
  return (await getSetting('client_reask_on_reweigh')) === true;
}

/**
 * After a committed change of a lot's totals: arm the system's question about
 * its prixod, or slide the one already held. Never throws (U41) — the
 * correction has committed, and a question not armed is a lot on the ❓
 * worklist with «Mijozdan so'rash» beside it, today's ⭐a.
 */
export async function armClientReask(lotId: string): Promise<void> {
  try {
    if (!isUuidShaped(lotId)) return;
    if (!(await reaskOn())) return;
    // Asked of the probe by this door itself (L1-1): the full question's
    // columns (0146) and the remembered tag's (0147).
    if (!(await clientMeasuresReady()) || !(await askedTagReady())) return;
    const [lot] = await db.select({ receiptId: receiptLots.receiptId }).from(receiptLots).where(eq(receiptLots.id, lotId));
    if (!lot) return;
    const facts = await clientAskFacts(lot.receiptId);
    if ('skip' in facts) return;
    // The person's door's own refusals, by its own functions (§1.2): never a
    // row that the sweep would settle with a ⚠ about a question nobody meant.
    if ((await linkedChats(facts.clientId)).length === 0) return;
    if (facts.lots.length > ASK_MAX_LOTS || !askFits(facts, { reason: 'updated' })) return;
    const views = await lotCheckViewsFor(facts.lots.map((l) => l.lotId));
    if (!facts.lots.some((l) => views.get(l.lotId)?.askable === true)) return;
    if (await questionWaiting(facts)) return;
    if (!(await reaskDue(facts, views))) return;
    await db.execute(sql`
      INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at)
      VALUES (${facts.clientId}::uuid, ${NOTICE_LOT_REASK}, 'receipt', ${facts.receiptId}::uuid,
              now() + make_interval(mins => ${REASK_SETTLE_MINUTES}), now())
      ON CONFLICT (client_id, kind, ref_type, ref_id) DO UPDATE
         SET status = 'pending', send_after = EXCLUDED.send_after, attempts = 0, last_error = NULL, claimed_at = NULL
    `);
  } catch (err) {
    logger.warn({ err, lotId }, '[client-reask] the automatic question was not armed');
  }
}

/**
 * At SEND time, for the sweep's preparer: the facts to ask about, or why not
 * — a word the card prints (`SKIP_FAILURE`), or one of `REASK_QUIET` (rightly
 * not sent, nothing drawn). Everything the arm proved, proved again from the
 * database: the window was minutes, and the bot may have been down for days.
 */
export async function reaskSendable(notice: { clientId: string; refId: string }): Promise<ClientAskFacts | { skip: string }> {
  if (!(await reaskOn())) return { skip: 'switched_off' };
  const facts = await clientAskFacts(notice.refId);
  if ('skip' in facts) return { skip: facts.skip };
  if (facts.clientId !== notice.clientId) return { skip: SKIP_CLIENT_CHANGED };
  if (facts.lots.length > ASK_MAX_LOTS || !askFits(facts, { reason: 'updated' })) return { skip: 'too_long' };
  if (await questionWaiting(facts)) return { skip: REASK_SUPERSEDED };
  const views = await lotCheckViewsFor(facts.lots.map((l) => l.lotId));
  if (!facts.lots.some((l) => views.get(l.lotId)?.askable === true)) return { skip: 'not_askable' };
  if (!(await reaskDue(facts, views))) return { skip: 'not_needed' };
  return facts;
}

/**
 * The History's line for a question the system sent by itself — after the
 * delivery, actor null («Tizim»), as the person's door writes one under its
 * presser. Never throws: the question went.
 */
export async function recordReaskSent(receiptId: string, warehouseId: string | null, lots: number): Promise<void> {
  try {
    await writeAudit(db, { actorId: null, warehouseId }, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: null,
      after: { clientAsk: `Telegram · ma’lumot o’zgargani uchun o’zi qayta so’raldi · ${lots} lot` },
    });
  } catch (err) {
    logger.warn({ err, receiptId }, '[client-reask] the sent question was not audited');
  }
}
