import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { receiptLots } from '../../platform/db/schema';
import { writeAudit } from '../../platform/audit/service';
import { isUuidShaped } from '../../platform/audit/fields';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import { linkedChats } from '../notices/client-push';
import { NOTICE_RECEIVED, SKIP_CLIENT_CHANGED } from '../notices/client-claims';
import { PUSH_LOT_LINES } from '../notices/client-text';
import { RECLAIM_MINUTES } from '../notices/arrival';
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
  // Nothing on the ❓ list, nothing to ask: every lot that can still be asked
  // about reads ✅ now — a client's ✅ that holds again after a correction
  // was taken back, a colleague's tick, a document. A question then would
  // ask the client to confirm what they already confirmed (the owner lens,
  // O9: 40 → 45, the system asked about 45, back to 40 — the ✅ on 40 stands).
  const open = facts.lots.some((lot) => {
    const view = views.get(lot.lotId);
    return view?.askable === true && view.state !== 'checked';
  });
  if (!open) return false;
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
  // No question with buttons is remembered — delivered before 0147, or never
  // delivered at all. Then a CONFIRMATION that the correction broke is what
  // says the client is to be asked again:
  //  - a FULL answer of this owner that no longer holds (a basic one never
  //    asked a weight; an unanswered pre-0147 question left no trace —
  //    stated, §1.1);
  //  - a colleague's tick about this owner that no longer holds — «To'g'ri —
  //    mijoz tasdiqladi», the client confirmed by phone, before 0147 or with
  //    no chat linked then, or under a receipt push that went without buttons
  //    because the lot was ticked. His «2 b» breaks such a tick on a re-weigh,
  //    and his «1 b» asks the client rather than leave it to a person (the
  //    owner lens, O6). A tick about a PREVIOUS owner vouched for nobody here.
  //  Only on a lot still on the ❓ list — one that reads ✅ (a standing tarkib,
  //  the client's own ✅) needs nobody asked — and, for the tick, only where
  //  the kilos, the cubic metres or the count moved: a rename or a tarkib's
  //  label alone asks nothing by itself (the as-built review, TICK-1).
  return facts.lots.some((lot) => {
    const view = views.get(lot.lotId);
    if (view?.askable !== true || view.state === 'checked') return false;
    const client = view.client;
    if (client && client.ofOwner && client.measures && !client.holds) return true;
    const person = view.person;
    return person !== null && !person.holds && !person.moved.client && (person.moved.measures || person.moved.count);
  });
}

/**
 * Will the receipt's own push carry the ✅ / ❌ row? The PURE half of
 * `clientAskOffer` (the switch, at most `PUSH_LOT_LINES` lots, no tarkib
 * written) — the half that does not depend on what the push prints. A push
 * that goes WITHOUT buttons asks nothing, so it must never stand a re-ask
 * down (the design judge).
 */
async function receivedPushAsks(facts: Pick<ClientAskFacts, 'lots'>): Promise<boolean> {
  if ((await getSetting('client_confirm_on_receipt')) !== true) return false;
  return facts.lots.length <= PUSH_LOT_LINES && facts.lots.every((lot) => lot.goodsKey === null);
}

/**
 * The system's own question about a prixod is ON ITS WAY — a FACT about the
 * row, not a clock (docs/PRIXOD-JAVOBLAR.md §1.6, §8.2): claimed and being
 * sent (`sending`; a dead run's too — the sweep sends it again on reclaim),
 * or RE-ARMED while it was out: `pending` with the claim the re-arm kept, no
 * delivery remembered since that claim (`asked_at`, written the moment a
 * delivery lands), and no retry's error (a transient failure settles
 * `pending` with its error and the claim of the attempt that did not go —
 * nothing of that is still on its way). Bounded by the reclaim window: a run
 * that died mid-send remembers nothing, and `RECLAIM_MINUTES` later its claim
 * is nobody's. ONE sentence for the arm's «due», its stand-down and the
 * re-arm's kept claim (the fixes' review, CONC-1/3) — written for the row as
 * `row` names it, which is the bare table inside an UPSERT's SET. The
 * person's door does NOT ask it (`askClientAboutReceipt`: a re-armed row's
 * message predates a correction, so a press sends the fresh figures now).
 * 0147's `asked_at`: the caller has asked `askedTagReady()`.
 */
function reaskInFlightSql(row: SQL = sql`client_notices`): SQL {
  return sql`(${row}.status = 'sending'
    OR (${row}.status = 'pending' AND ${row}.claimed_at IS NOT NULL
        AND ${row}.claimed_at > now() - make_interval(mins => ${RECLAIM_MINUTES})
        AND ${row}.last_error IS NULL
        AND (${row}.asked_at IS NULL OR ${row}.asked_at < ${row}.claimed_at)))`;
}

/**
 * The asking rows of this owner and prixod and where each stands: the
 * receipt push, a person's question, the system's own.
 */
async function askingRows(facts: Pick<ClientAskFacts, 'clientId' | 'receiptId'>): Promise<AskingRow[]> {
  return (await db.execute(sql`
    SELECT kind, status, ${reaskInFlightSql()} AS in_flight
      FROM client_notices
     WHERE client_id = ${facts.clientId}::uuid AND ref_type = 'receipt' AND ref_id = ${facts.receiptId}::uuid
       AND kind IN (${sql.join(
         ASKING_KINDS.map((kind) => sql`${kind}`),
         sql`, `,
       )})
  `)) as unknown as AskingRow[];
}

interface AskingRow {
  kind: string;
  status: string;
  /** On its way right now, by `reaskInFlightSql` — meaningful for our own row; any `sending` row reads true. */
  in_flight: boolean | null;
}

/**
 * A question to this owner about this prixod still WAITING to be claimed —
 * a person's «Mijozdan so'rash» pressed a moment ago, or the receipt push in
 * its correction window when it will carry the buttons. It is rendered from
 * the facts at SEND time, carries the new figures itself, and — being due
 * first — is delivered (and its tag remembered) before ours is looked at.
 */
async function questionWaiting(facts: Pick<ClientAskFacts, 'clientId' | 'receiptId' | 'lots'>, rows: AskingRow[]): Promise<boolean> {
  if (rows.some((row) => row.kind === NOTICE_LOT_ASK && row.status === 'pending')) return true;
  return rows.some((row) => row.kind === NOTICE_RECEIVED && row.status === 'pending') && (await receivedPushAsks(facts));
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
    const rows = await askingRows(facts);
    if (await questionWaiting(facts, rows)) return;
    // A question ON ITS WAY right now (claimed, being sent): what it carries is
    // unknown — it may have read the facts before this correction committed.
    // So it counts as «due», and the send-time check compares the facts with
    // the tag that delivery remembers (the design judge's first blocker). Our
    // OWN question re-armed while it was out is still on its way — for every
    // correction inside the same send, not only the first (the fixes' review,
    // CONC-1): no correction may stand it down against a tag that delivery has
    // not yet remembered (the as-built review, DLV-4). One sentence,
    // `reaskInFlightSql`, for this check, the stand-down and the re-arm.
    const inFlight = rows.some((row) => row.in_flight === true);
    if (!inFlight && !(await reaskDue(facts, views))) {
      // Not due — and a question held from an earlier correction that this one
      // took back is stood down now, so the card stops promising it. What it
      // delivered before (`asked_tag` / `asked_at`) is never touched; a row
      // that went on its way since the read is not ours to stand down.
      await db.execute(sql`
        UPDATE client_notices SET status = 'skipped', last_error = 'not_needed', claimed_at = NULL
         WHERE client_id = ${facts.clientId}::uuid AND kind = ${NOTICE_LOT_REASK}
           AND ref_type = 'receipt' AND ref_id = ${facts.receiptId}::uuid AND status = 'pending'
           AND NOT ${reaskInFlightSql()}
      `);
      return;
    }
    // The re-arm keeps the claim of a question still on its way — by the same
    // sentence, read on the row as it stood: a `sending` row's, and a re-armed
    // one's whose delivery is not yet remembered, so the NEXT correction inside
    // the same send still finds it on its way (CONC-1). A retried row's failed
    // claim, and one a delivery has answered, are nobody's.
    await db.execute(sql`
      INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at)
      VALUES (${facts.clientId}::uuid, ${NOTICE_LOT_REASK}, 'receipt', ${facts.receiptId}::uuid,
              now() + make_interval(mins => ${REASK_SETTLE_MINUTES}), now())
      ON CONFLICT (client_id, kind, ref_type, ref_id) DO UPDATE
         SET status = 'pending', send_after = EXCLUDED.send_after, attempts = 0, last_error = NULL,
             claimed_at = CASE WHEN ${reaskInFlightSql()} THEN client_notices.claimed_at END
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
  // A person's question waiting or on its way, or the receipt push that will
  // carry buttons still waiting: it asks the new figures itself.
  const rows = await askingRows(facts);
  if (rows.some((row) => row.kind === NOTICE_LOT_ASK && row.status === 'sending') || (await questionWaiting(facts, rows))) {
    return { skip: REASK_SUPERSEDED };
  }
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
