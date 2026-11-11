import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, lotClientConfirms, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { isUuidShaped } from '../../platform/audit/fields';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { cardLink } from '../../platform/notifications/links';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import { clientsForChat } from '../client-cabinet/service';
import { linkedChats } from '../notices/client-push';
import { PUSH_LOT_LINES } from '../notices/client-text';
import { compositionsFor } from './lot-composition';
import { lotCheckViewsFor, mayCheckLot, type LotCheckActor } from './lot-check';
import { lotTarkibJoinSql } from './lot-check-sql';
import { lotRuShownSql } from './lot-name';
import { mayReadReceipt } from './read-door';

/**
 * The CLIENT's own ✅ / ❌ about their cargo, in Telegram (0144,
 * docs/TARKIB-TAKLIFLAR.md §4 — the owner's 5b, and «tarkibni mijozning o'zi
 * tasdiqlasin»). The ONE writer of `lot_client_confirms` and the one reader
 * of what a question shows.
 *
 * Two moments ask, one function answers:
 *   · the customer's «yukingiz qabul qilindi» push carries the ✅ / ❌ row by
 *     itself, when the cargo is still in China and nobody has confirmed it
 *     (`clientAskOffer`);
 *   · «Mijozdan so'rash» on the prixod card sends the question on a person's
 *     press, with every lot's goods listed — which is how a TARKIB, written
 *     days after the receipt, gets confirmed (`askClientAboutReceipt`).
 *
 * THE TAG is what makes a press mean something: eight hex digits of the
 * facts the question printed — per lot both name spellings, the carton count
 * and the tarkib's goods as printed (`goods_key`: names and pieces — never
 * the tarkib's `rev`, which moves on every TNVED code typed); and the owner.
 * A press carries the receipt and the tag; the answer is written only while
 * the facts read NOW give the same tag. A rename, a count correction, a new
 * owner or a tarkib written afterwards make every button sent before it
 * «eskirgan» — a client cannot confirm what they were not shown, the staff
 * tick's `lot_changed` in the customer's hands.
 *
 * NO LOCK, on purpose. The row is written from the facts just read, and it
 * is a snapshot every reader COMPARES (`lot-check-sql.ts`): a row that raced
 * a rename simply does not match the lot and reads stale, exactly as if it
 * had been written a second earlier. So the customer's press — which runs on
 * the bot's one-at-a-time poller — never waits on a warehouse's transaction
 * and can never deadlock with one.
 *
 * Identity is the CHAT, never an id a button carried (#273): the receipt
 * must be confirmed, live, and owned by one of the chat's linked codes, and
 * every other case answers the same neutral word.
 */

export const NOTICE_LOT_ASK = 'lot_ask';

/** «Mijozdan so'rash» is not offered again for this long after a question went out. */
export const ASK_COOLDOWN_MINUTES = 10;
/** A question longer than this is refused to the PRESSER — Telegram's own limit is 4096. */
export const ASK_MAX_CHARS = 3500;
/** …and so is one about more lots than a phone will be read through. */
export const ASK_MAX_LOTS = 30;

export interface ClientAskLot {
  lotId: string;
  letter: string | null;
  /** The stored Chinese name. */
  zh: string;
  /** The Russian name as every list SHOWS it (a tarkib's «first +N»); null, never ''. */
  ru: string | null;
  count: number;
  /**
   * The tarkib's goods as a question prints them, digested (`lot-check-sql.ts`
   * `goods_key` — the reader's own column, so the answer and the sentence
   * compare ONE value); null when no tarkib is written.
   */
  goodsKey: string | null;
  /** The tarkib's goods, in its own order; empty when none is written. */
  goods: { name: string; pieces: number | null }[];
}

export interface ClientAskFacts {
  receiptId: string;
  receiptNumber: string;
  clientId: string;
  clientCode: string;
  warehouseName: string;
  receivedAt: Date | null;
  lots: ClientAskLot[];
  tag: string;
}

export type ClientAskSkip = 'receipt_gone' | 'voided' | 'not_confirmed' | 'no_client' | 'no_lots';

/** Eight hex digits of what a question prints. Pure — the send and the press both call it. */
export function askTag(
  clientId: string,
  lots: readonly Pick<ClientAskLot, 'lotId' | 'zh' | 'ru' | 'count' | 'goodsKey'>[],
): string {
  const facts = [clientId, lots.map((l) => [l.lotId, l.zh, l.ru ?? '', l.count, l.goodsKey ?? ''])];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 8);
}

/**
 * What a question about this prixod says NOW — the receipt, its owner, every
 * lot by letter, and the tag of exactly that. Pooled.
 */
export async function clientAskFacts(receiptId: string): Promise<ClientAskFacts | { skip: ClientAskSkip }> {
  if (!isUuidShaped(receiptId)) return { skip: 'receipt_gone' };
  const [receipt] = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      status: receipts.status,
      voidedAt: receipts.voidedAt,
      clientId: receipts.clientId,
      clientCode: clients.clientCode,
      receivedAt: receipts.receivedAt,
      warehouseName: warehouses.name,
      warehouseCode: warehouses.code,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(receipts.id, receiptId));
  if (!receipt) return { skip: 'receipt_gone' };
  if (receipt.voidedAt || receipt.status === 'voided') return { skip: 'voided' };
  if (receipt.status !== 'confirmed') return { skip: 'not_confirmed' };
  if (!receipt.clientId || !receipt.clientCode) return { skip: 'no_client' };

  const rows = (await db.execute(sql`
    SELECT l.id, l.letter, l.product_name_zh AS zh, NULLIF(${lotRuShownSql(sql`l`)}, '') AS ru,
           l.box_count, lot_tarkib.goods_key
      FROM receipt_lots l
      LEFT JOIN ${lotTarkibJoinSql()} ON lot_tarkib.lot_id = l.id
     WHERE l.receipt_id = ${receiptId}::uuid
     ORDER BY l.letter NULLS LAST, l.seq, l.id
  `)) as unknown as { id: string; letter: string | null; zh: string; ru: string | null; box_count: number; goods_key: string | null }[];
  if (rows.length === 0) return { skip: 'no_lots' };

  const composed = rows.filter((row) => row.goods_key !== null).map((row) => row.id);
  const tarkibs = composed.length > 0 ? await compositionsFor(composed) : new Map();
  const lots: ClientAskLot[] = rows.map((row) => ({
    lotId: row.id,
    letter: row.letter,
    zh: row.zh,
    ru: row.ru,
    count: Number(row.box_count),
    goodsKey: row.goods_key,
    goods: (tarkibs.get(row.id)?.lines ?? []).map((line: { name: string; pieces: number | null }) => ({
      name: line.name,
      pieces: line.pieces,
    })),
  }));
  return {
    receiptId: receipt.id,
    receiptNumber: receipt.number,
    clientId: receipt.clientId,
    clientCode: receipt.clientCode,
    warehouseName: receipt.warehouseName || receipt.warehouseCode,
    receivedAt: receipt.receivedAt,
    lots,
    tag: askTag(receipt.clientId, lots),
  };
}

/**
 * Does the «yukingiz qabul qilindi» push carry the ✅ / ❌ row? Asked at SEND
 * time, so the correction window stays a window. Yes only when: the switch
 * is on; the prixod is this client's; the push prints every lot (at most
 * `PUSH_LOT_LINES` — a client cannot confirm a line they were not shown);
 * no lot has a tarkib written (the push prints «Клавиатура +2» and cannot
 * list the goods — that question is «Mijozdan so'rash»'s); and at least one
 * lot is still worth asking about — a live carton in China and no ✅ yet
 * (his 4a: cargo in Uzbekistan is never asked).
 */
export async function clientAskOffer(receiptId: string, clientId: string): Promise<{ receiptId: string; tag: string } | null> {
  if ((await getSetting('client_confirm_on_receipt')) !== true) return null;
  const facts = await clientAskFacts(receiptId);
  if ('skip' in facts || facts.clientId !== clientId) return null;
  if (facts.lots.length > PUSH_LOT_LINES) return null;
  if (facts.lots.some((lot) => lot.goodsKey !== null)) return null;
  const views = await lotCheckViewsFor(facts.lots.map((lot) => lot.lotId));
  const worthAsking = facts.lots.some((lot) => {
    const view = views.get(lot.lotId);
    return view !== undefined && view.askable && (view.state === 'none' || view.state === 'stale');
  });
  return worthAsking ? { receiptId, tag: facts.tag } : null;
}

export type ClientVerdict = 'yes' | 'no';

export type ClientAnswer =
  /** Not this chat's to answer, or nothing there any more — one neutral word for all of it. */
  | { outcome: 'unknown' }
  /** The facts moved since the message: the buttons are about data that no longer exists. */
  | { outcome: 'stale' }
  /** Every lot already holds this very answer about these very facts. */
  | { outcome: 'already'; verdict: ClientVerdict }
  | { outcome: 'recorded'; verdict: ClientVerdict; facts: ClientAskFacts };

/** `键盘 (Клавиатура) × 100` — the History's value for one lot of an answer. */
function shownLine(lot: Pick<ClientAskLot, 'zh' | 'ru' | 'count'>): string {
  return `${lot.zh}${lot.ru ? ` (${lot.ru})` : ''} × ${lot.count}`;
}

/** The History's key for a lot's answer — per LOT, as the staff tick's (`lotCheck:A`). */
export function clientConfirmAuditKey(letter: string | null): string {
  return `clientConfirm:${letter ?? '?'}`;
}

/**
 * The last «Mijozdan so'rash» for this prixod — of the prixod's CURRENT
 * owner (a prixod that changed owner holds one row per client): who pressed
 * it and when it went out. Null when only the receipt's own push has asked.
 */
async function lastAsk(clientId: string, receiptId: string): Promise<{ askedBy: string | null; sentAt: Date | null } | null> {
  const rows = (await db.execute(sql`
    SELECT asked_by::text AS asked_by, sent_at FROM client_notices
     WHERE client_id = ${clientId}::uuid AND kind = ${NOTICE_LOT_ASK} AND ref_type = 'receipt' AND ref_id = ${receiptId}::uuid
  `)) as unknown as { asked_by: string | null; sent_at: string | Date | null }[];
  const row = rows[0];
  return row ? { askedBy: row.asked_by, sentAt: row.sent_at ? new Date(row.sent_at) : null } : null;
}

/** The staff's sentence about an answer — plain Uzbek, the card's link last (the drain makes it a button). */
function staffText(facts: ClientAskFacts, verdict: ClientVerdict): string {
  const lots = facts.lots
    .slice(0, 12)
    .map((lot) => `${lot.letter ? `${lot.letter} · ` : ''}${lot.ru ?? lot.zh} — ${lot.count} quti`);
  if (facts.lots.length > 12) lots.push(`… yana ${facts.lots.length - 12} ta lot`);
  const link = cardLink('receipt', facts.receiptId);
  const head =
    verdict === 'no'
      ? ['❌ Mijoz yuk ma’lumotini «xato» dedi', `${facts.clientCode} · prixod ${facts.receiptNumber}`]
      : ['✅ Mijoz yuk ma’lumotini tasdiqladi', `${facts.clientCode} · prixod ${facts.receiptNumber}`];
  const tail =
    verdict === 'no'
      ? ['Mijoz Telegram’da «Xato bor» ni bosdi. Nima noto‘g‘riligini aniqlab, ma’lumotni tuzating — tuzatilguncha lot ❓ bo‘lib turadi.']
      : [];
  return [...head, ...lots, ...tail, ...(link ? [link] : [])].join('\n');
}

/**
 * A press on ✅ / ❌. Never throws for a reason of the customer's making;
 * a fault of ours (a server behind) is the caller's to word.
 */
export async function answerClientAsk(input: {
  chatId: bigint;
  receiptId: string;
  verdict: ClientVerdict;
  tag: string;
}): Promise<ClientAnswer> {
  const linked = await clientsForChat(input.chatId);
  if (linked.length === 0) return { outcome: 'unknown' };
  const facts = await clientAskFacts(input.receiptId);
  if ('skip' in facts) return { outcome: facts.skip === 'receipt_gone' ? 'unknown' : 'stale' };
  // Somebody else's prixod — or one that WAS this chat's and was corrected to
  // another client: the same word as a prixod that does not exist.
  if (!linked.some((client) => client.id === facts.clientId)) return { outcome: 'unknown' };
  if (facts.tag !== input.tag) return { outcome: 'stale' };

  const lotIds = facts.lots.map((lot) => lot.lotId);
  const held = await db
    .select()
    .from(lotClientConfirms)
    .where(sql`${lotClientConfirms.lotId} IN (${sql.join(
      lotIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  const heldBy = new Map(held.map((row) => [row.lotId, row]));
  const same = (lot: ClientAskLot): boolean => {
    const row = heldBy.get(lot.lotId);
    return (
      row !== undefined &&
      row.verdict === input.verdict &&
      row.shownZh === lot.zh &&
      (row.shownRu ?? null) === lot.ru &&
      row.shownCount === lot.count &&
      row.shownClientId === facts.clientId &&
      (row.shownGoodsKey ?? null) === lot.goodsKey
    );
  };
  // Read on the pool BEFORE the transaction (tx-pool): the last question a
  // person sent, and who is told.
  const ask = await lastAsk(facts.clientId, facts.receiptId);
  const askedBy = ask?.askedBy ?? null;
  // «Already» = every lot holds this very answer about these very facts AND
  // it was given after the last question went out. The same ❌ pressed again
  // on a NEW question is that question's answer: the person who re-asked
  // must hear it, and the card's date must move (the design judge).
  const answersTheLastAsk = (lot: ClientAskLot): boolean => {
    const row = heldBy.get(lot.lotId);
    return row !== undefined && (ask?.sentAt === null || ask?.sentAt === undefined || row.answeredAt > ask.sentAt);
  };
  if (facts.lots.every((lot) => same(lot) && answersTheLastAsk(lot))) return { outcome: 'already', verdict: input.verdict };

  const [owner] = await db.select({ seller: clients.salesManagerId }).from(clients).where(eq(clients.id, facts.clientId));
  // ❌ → the client's seller and the logists (the people who can correct the
  // lot); ✅ on the receipt's own push tells nobody — the ❓ list shrinking is
  // the news. The person who pressed «Mijozdan so'rash» hears either answer.
  const others =
    input.verdict === 'no'
      ? [...new Set([owner?.seller, ...(await usersWithPermission('plans.manage'))].filter((id): id is string => Boolean(id)))].filter(
          (id) => id !== askedBy,
        )
      : [];

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const lot of facts.lots) {
    if (same(lot)) continue;
    const key = clientConfirmAuditKey(lot.letter);
    const prev = heldBy.get(lot.lotId);
    before[key] = prev ? `${prev.verdict === 'yes' ? '✅' : '❌'} ${shownLine({ zh: prev.shownZh, ru: prev.shownRu, count: prev.shownCount })}` : null;
    after[key] = `${input.verdict === 'yes' ? '✅' : '❌'} Telegram · ${shownLine(lot)}`;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(lotClientConfirms)
      .values(
        facts.lots.map((lot) => ({
          lotId: lot.lotId,
          verdict: input.verdict,
          shownZh: lot.zh,
          shownRu: lot.ru,
          shownCount: lot.count,
          shownClientId: facts.clientId,
          shownGoodsKey: lot.goodsKey,
          chatId: input.chatId,
          askedBy,
        })),
      )
      .onConflictDoUpdate({
        target: lotClientConfirms.lotId,
        set: {
          verdict: sql`excluded.verdict`,
          shownZh: sql`excluded.shown_zh`,
          shownRu: sql`excluded.shown_ru`,
          shownCount: sql`excluded.shown_count`,
          shownClientId: sql`excluded.shown_client_id`,
          shownGoodsKey: sql`excluded.shown_goods_key`,
          chatId: sql`excluded.chat_id`,
          askedBy: sql`excluded.asked_by`,
          answeredAt: sql`now()`,
        },
      });
    // Nobody of ours pressed: the actor is null and the VALUE says «Telegram».
    await writeAudit(tx, { actorId: null }, { entityType: 'receipt', entityId: facts.receiptId, action: 'update', before, after });
    // Queued in the SAME transaction as the answer: a crash between the two
    // would leave a redelivered press reading «already» and telling nobody.
    const type = input.verdict === 'no' ? 'ClientLotDisputed' : 'ClientLotConfirmed';
    const text = staffText(facts, input.verdict);
    if (others.length > 0) await queueStaffTelegram(tx, { userIds: others, type, text });
    // The asker pressed a button and is waiting for this very answer: it goes
    // past their own mute, as the re-run a seller started does.
    if (askedBy) await queueStaffTelegram(tx, { userIds: [askedBy], type, text, ignoreMute: true });
  });
  await kickTelegramDrain().catch(() => {});
  return { outcome: 'recorded', verdict: input.verdict, facts };
}

export type ClientAskRefusal =
  | 'forbidden'
  | 'receipt_not_confirmed'
  | 'no_client'
  | 'no_lots'
  | 'no_chat'
  | 'not_askable'
  | 'too_long'
  | 'already_queued'
  | 'too_soon';

export class ClientAskError extends Error {
  constructor(public readonly code: ClientAskRefusal) {
    super(code);
  }
}

/**
 * «Mijozdan so'rash»: queue the question for this prixod's client. The door
 * is the lot check's own (`ved.docs ∨ plans.manage` and the card's read
 * door); the message goes out with the next sweep of the customer pushes.
 *
 * `fits` is the question's renderer, asked for each customer language — the
 * caller hands it in, so this module does not import the words.
 */
export async function askClientAboutReceipt(
  receiptId: string,
  actor: LotCheckActor,
  ctx: AuditContext,
  fits: (facts: ClientAskFacts) => boolean,
): Promise<{ lots: number }> {
  if (!mayCheckLot(actor.permissions) || !isUuidShaped(receiptId)) throw new ClientAskError('forbidden');
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) throw new ClientAskError('forbidden');
  if (!(await mayReadReceipt(actor, { id: receipt.id, warehouseId: receipt.warehouseId }))) throw new ClientAskError('forbidden');
  const facts = await clientAskFacts(receiptId);
  if ('skip' in facts) {
    throw new ClientAskError(
      facts.skip === 'no_client' ? 'no_client' : facts.skip === 'no_lots' ? 'no_lots' : facts.skip === 'receipt_gone' ? 'forbidden' : 'receipt_not_confirmed',
    );
  }
  if ((await linkedChats(facts.clientId)).length === 0) throw new ClientAskError('no_chat');
  // The panel's own rule (his 4a): a question is for cargo still in China —
  // on a Chinese shelf, or on a truck out of China. Once every carton stands
  // in Uzbekistan the papers are made, and a ❌ there would stand on no list.
  const views = await lotCheckViewsFor(facts.lots.map((lot) => lot.lotId));
  if (!facts.lots.some((lot) => views.get(lot.lotId)?.askable === true)) throw new ClientAskError('not_askable');
  if (facts.lots.length > ASK_MAX_LOTS || !fits(facts)) throw new ClientAskError('too_long');

  // ONE row per (client, kind, prixod) — `client_notices_once`. A question
  // that already went out is re-armed (the unique row is the cooldown's
  // clock); one still waiting or going out is left alone.
  const armed = (await db.execute(sql`
    INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, asked_by)
    VALUES (${facts.clientId}::uuid, ${NOTICE_LOT_ASK}, 'receipt', ${receiptId}::uuid, now(), now(), ${actor.id}::uuid)
    ON CONFLICT (client_id, kind, ref_type, ref_id) DO UPDATE
       SET status = 'pending', send_after = now(), attempts = 0, last_error = NULL, claimed_at = NULL, asked_by = EXCLUDED.asked_by
     WHERE client_notices.status IN ('sent', 'failed', 'skipped')
       AND (client_notices.sent_at IS NULL OR client_notices.sent_at < now() - make_interval(mins => ${ASK_COOLDOWN_MINUTES}))
    RETURNING id
  `)) as unknown as { id: string }[];
  if (armed.length === 0) {
    const [standing] = (await db.execute(sql`
      SELECT status FROM client_notices
       WHERE client_id = ${facts.clientId}::uuid AND kind = ${NOTICE_LOT_ASK} AND ref_type = 'receipt' AND ref_id = ${receiptId}::uuid
    `)) as unknown as { status: string }[];
    throw new ClientAskError(standing?.status === 'pending' || standing?.status === 'sending' ? 'already_queued' : 'too_soon');
  }
  await writeAudit(db, ctx, {
    entityType: 'receipt',
    entityId: receiptId,
    action: 'update',
    before: null,
    after: { clientAsk: `Telegram · ${facts.lots.length} lot` },
  }).catch((err) => logger.warn({ err, receiptId }, '[client-confirm] ask not audited'));
  return { lots: facts.lots.length };
}

/** The last question about a prixod, for its card: when it went, or why it has not. */
export interface ClientAskStatus {
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  sentAt: Date | null;
  reason: string | null;
  askedBy: string | null;
}

/** Of the prixod's CURRENT owner — a prixod that changed owner holds a row per client. */
export async function clientAskStatusFor(receiptId: string): Promise<ClientAskStatus | null> {
  if (!isUuidShaped(receiptId)) return null;
  const rows = (await db.execute(sql`
    SELECT n.status, n.sent_at, n.last_error, u.full_name AS asked_by
      FROM client_notices n
      JOIN receipts r ON r.id = n.ref_id AND r.client_id = n.client_id
      LEFT JOIN users u ON u.id = n.asked_by
     WHERE n.kind = ${NOTICE_LOT_ASK} AND n.ref_type = 'receipt' AND n.ref_id = ${receiptId}::uuid
     LIMIT 1
  `)) as unknown as { status: ClientAskStatus['status']; sent_at: string | Date | null; last_error: string | null; asked_by: string | null }[];
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    sentAt: row.sent_at ? new Date(row.sent_at) : null,
    reason: row.last_error,
    askedBy: row.asked_by,
  };
}

export class ClientDisputeError extends Error {
  constructor(public readonly code: 'forbidden' | 'nothing_to_close') {
    super(code);
  }
}

/**
 * «E'tirozni yopish»: a person with the lot-check door takes the client's ❌
 * off a lot — after talking to them, or because it was pressed by mistake.
 * The row is DELETED (the History keeps what it said and who closed it), so
 * the lot reads as it would had the client never answered. A ✅ is never
 * closed by a person: the client's own word stands until the data moves.
 */
export async function dismissClientDispute(
  input: { lotId: string; note?: string | null },
  actor: LotCheckActor,
  ctx: AuditContext,
): Promise<void> {
  if (!mayCheckLot(actor.permissions) || !isUuidShaped(input.lotId)) throw new ClientDisputeError('forbidden');
  const [lot] = await db
    .select({ id: receiptLots.id, letter: receiptLots.letter, receiptId: receiptLots.receiptId, warehouseId: receipts.warehouseId })
    .from(receiptLots)
    .innerJoin(receipts, eq(receipts.id, receiptLots.receiptId))
    .where(eq(receiptLots.id, input.lotId));
  if (!lot) throw new ClientDisputeError('forbidden');
  if (!(await mayReadReceipt(actor, { id: lot.receiptId, warehouseId: lot.warehouseId }))) throw new ClientDisputeError('forbidden');
  const note = (input.note ?? '').trim().slice(0, 500) || null;
  await db.transaction(async (tx) => {
    const gone = await tx
      .delete(lotClientConfirms)
      .where(and(eq(lotClientConfirms.lotId, input.lotId), eq(lotClientConfirms.verdict, 'no')))
      .returning();
    const row = gone[0];
    if (!row) throw new ClientDisputeError('nothing_to_close');
    const key = clientConfirmAuditKey(lot.letter);
    await writeAudit(tx, ctx, {
      entityType: 'receipt',
      entityId: lot.receiptId,
      action: 'update',
      before: { [key]: `❌ ${shownLine({ zh: row.shownZh, ru: row.shownRu, count: row.shownCount })}` },
      after: { [key]: note ? `e’tiroz yopildi: ${note}` : 'e’tiroz yopildi' },
    });
  });
}

/** The lots of a prixod in the order a question lists them — for a caller that only needs ids. */
export async function askLotIds(receiptId: string): Promise<string[]> {
  const rows = await db
    .select({ id: receiptLots.id })
    .from(receiptLots)
    .where(eq(receiptLots.receiptId, receiptId))
    .orderBy(asc(receiptLots.letter), asc(receiptLots.seq));
  return rows.map((row) => row.id);
}
