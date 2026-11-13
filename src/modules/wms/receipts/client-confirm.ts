import { createHash } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, lotClientConfirms, receipts, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { isUuidShaped } from '../../platform/audit/fields';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { cardLink } from '../../platform/notifications/links';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import { clientsForChat } from '../client-cabinet/service';
import { linkedChats } from '../notices/client-push';
import { RECLAIM_MINUTES } from '../notices/arrival';
import { SKIP_CLIENT_CHANGED } from '../notices/client-claims';
import { PUSH_LOT_LINES } from '../notices/client-text';
import { isBusyError, isServerBehind } from '../../platform/db/errors';
import { lockLotAnswersTx, lotCheckViewsFor, mayCheckLot, type LotCheckActor } from './lot-check';
import { askedTagReady, clientConfirmsReady, clientMeasuresReady } from './lot-check-ready';
import { lotShownKgSql, lotShownM3Sql, lotTarkibJoinSql, measuresLine } from './lot-check-sql';
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
 * THE SCOPE (0146, docs/PRIXOD-XABARI.md §A — the owner's «4 ha … og'irlik
 * va hajmga urg'u berilsin, tekshirib olsin klient va tasdiqlasin»): a
 * question asked from now on is `full` — it also asks about the lot's kilos
 * and cubic metres, its tag covers them, and its answer remembers them
 * (`shown_kg` / `shown_m3`, at the precision a customer reads). A question
 * sent before 0146 was `basic`; its buttons still carry the 0144 tag, and a
 * press on one is judged against that recipe (`basicTag`) and recorded as
 * what THAT message asked — so no button a customer already holds dies at
 * the deploy, and none is taken for more than it said.
 *
 * NO LOT OR PRIXOD LOCK, on purpose. The row is written from the facts just
 * read, and a ✅ is a snapshot every reader COMPARES (`lot-check-sql.ts`): a
 * row that raced a rename simply does not match the lot and reads stale,
 * exactly as if it had been written a second earlier. So the customer's
 * press — which runs on the bot's one-at-a-time poller — never takes a lock
 * the warehouse holds. Two things it does wait for, both bounded by a
 * three-second `lock_timeout` that answers «hozir band» and keeps the
 * buttons: the foreign key's own share lock on the lot row (behind an edit
 * of that lot in flight), and `lockLotAnswersTx` — the advisory lock that
 * orders an answer against a colleague's tick on the same lot, because a ❌
 * vetoes a tick that is not NEWER than it and «newer» must mean «pressed by
 * somebody who could see it».
 *
 * Identity is the CHAT, never an id a button carried (#273): the receipt
 * must be confirmed, live, and owned by one of the chat's linked codes, and
 * every other case answers the same neutral word.
 */

export const NOTICE_LOT_ASK = 'lot_ask';
/**
 * The question the system sends BY ITSELF after a re-weigh (the owner's «1 b»
 * of 2026-11-12, docs/PRIXOD-JAVOBLAR.md §1; `client-reask.ts`). A kind of
 * its own, never `lot_ask`'s row: that row remembers who ASKED (and tells
 * them the answer past their mute), its future due time reads «Telegram asked
 * us to wait», and a quiet skip there would erase the person's delivered
 * question from the card.
 */
export const NOTICE_LOT_REASK = 'lot_reask';

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
 * is nobody's. ONE sentence for the arm's «due», the re-arm's kept claim and
 * the person's door (the fixes' review, CONC-1/2/3) — written for the row as
 * `row` names it, which is the bare table inside an UPSERT's SET. 0147's
 * `asked_at`: the caller has asked `askedTagReady()`.
 */
export function reaskInFlightSql(row: SQL = sql`client_notices`): SQL {
  return sql`(${row}.status = 'sending'
    OR (${row}.status = 'pending' AND ${row}.claimed_at IS NOT NULL
        AND ${row}.claimed_at > now() - make_interval(mins => ${RECLAIM_MINUTES})
        AND ${row}.last_error IS NULL
        AND (${row}.asked_at IS NULL OR ${row}.asked_at < ${row}.claimed_at)))`;
}

/** «Mijozdan so'rash» is not offered again for this long after a question went out. */
export const ASK_COOLDOWN_MINUTES = 10;
/** A question longer than this is refused to the PRESSER — Telegram's own limit is 4096. */
export const ASK_MAX_CHARS = 3500;
/** …and so is one about more lots than a phone will be read through. */
export const ASK_MAX_LOTS = 30;

/** What a question asks about (§A.1): `full` = the 0144 five facts plus the lot's kilos and cubic metres. */
export type AskScope = 'basic' | 'full';

export interface ClientAskLot {
  lotId: string;
  letter: string | null;
  /** The stored Chinese name. */
  zh: string;
  /** The Russian name as every list SHOWS it (a tarkib's «first +N»); null, never ''. */
  ru: string | null;
  count: number;
  /** The lot's totals as STORED — what the push's own lines are checked against (`clientAskOffer`). */
  kg: number;
  m3: number;
  /**
   * …and as a customer reads them, rounded by the DATABASE (`lotShownKgSql`
   * / `lotShownM3Sql` — the sentence's own two expressions), as its text:
   * what a `full` tag hashes and a `full` answer remembers. Never rounded in
   * JS: the two round a half differently.
   */
  shownKg: string;
  shownM3: string;
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
  /** `full` on a server whose 0146 has landed (`clientMeasuresReady()`), `basic` otherwise. */
  scope: AskScope;
  /** The tag of exactly what a question of this scope prints. */
  tag: string;
  /** The 0144 recipe over the same facts — what a button sent before 0146 carries. */
  basicTag: string;
}

export type ClientAskSkip = 'receipt_gone' | 'voided' | 'not_confirmed' | 'no_client' | 'no_lots';

/**
 * A prixod there is nothing to ask about — with WHOSE it is, when it is
 * anybody's. A press needs the owner before it says anything at all: «this
 * is out of date» is a fact about the prixod, and it is said to its owner
 * alone (`answerClientAsk`).
 */
export interface ClientAskSkipped {
  skip: ClientAskSkip;
  clientId: string | null;
}

/**
 * Eight hex digits of what a question prints. Pure — the send and the press
 * both call it. `basic` is the 0144 recipe BYTE FOR BYTE (the buttons already
 * in customers' chats were hashed with it); `full` adds each lot's two
 * figures as the database's own text.
 */
export function askTag(
  clientId: string,
  lots: readonly Pick<ClientAskLot, 'lotId' | 'zh' | 'ru' | 'count' | 'goodsKey' | 'shownKg' | 'shownM3'>[],
  scope: AskScope = 'basic',
): string {
  const facts = [
    clientId,
    lots.map((l) =>
      scope === 'full'
        ? [l.lotId, l.zh, l.ru ?? '', l.count, l.goodsKey ?? '', l.shownKg, l.shownM3]
        : [l.lotId, l.zh, l.ru ?? '', l.count, l.goodsKey ?? ''],
    ),
  ];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 8);
}

/**
 * What a question about this prixod says NOW — the receipt, its owner, every
 * lot by letter, and the tag of exactly that. Pooled.
 */
export async function clientAskFacts(receiptId: string): Promise<ClientAskFacts | ClientAskSkipped> {
  if (!isUuidShaped(receiptId)) return { skip: 'receipt_gone', clientId: null };
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
  if (!receipt) return { skip: 'receipt_gone', clientId: null };
  if (receipt.voidedAt || receipt.status === 'voided') return { skip: 'voided', clientId: receipt.clientId };
  if (receipt.status !== 'confirmed') return { skip: 'not_confirmed', clientId: receipt.clientId };
  if (!receipt.clientId || !receipt.clientCode) return { skip: 'no_client', clientId: null };
  // Asked of the probe HERE, by the question's own door (never a flag another
  // screen remembered): can this server remember kilos and cubic metres?
  const scope: AskScope = (await clientMeasuresReady()) ? 'full' : 'basic';

  // ONE statement for the names, the counts, the measures, the goods and
  // their digest: the tag vouches for exactly what the message prints, and
  // two reads would let a tarkib saved between them print one list under the
  // other's tag.
  const rows = (await db.execute(sql`
    SELECT l.id, l.letter, l.product_name_zh AS zh, NULLIF(${lotRuShownSql(sql`l`)}, '') AS ru,
           l.box_count, lot_tarkib.goods_key,
           l.total_weight_kg::text AS kg, l.total_volume_m3::text AS m3,
           ${lotShownKgSql(sql`l`)}::text AS kg_shown, ${lotShownM3Sql(sql`l`)}::text AS m3_shown,
           (SELECT coalesce(json_agg(json_build_object('name', cl.name, 'pieces', cl.pieces) ORDER BY cl.seq), '[]'::json)
              FROM lot_composition_lines cl WHERE cl.lot_id = l.id) AS goods
      FROM receipt_lots l
      LEFT JOIN ${lotTarkibJoinSql()} ON lot_tarkib.lot_id = l.id
     WHERE l.receipt_id = ${receiptId}::uuid
     ORDER BY l.letter NULLS LAST, l.seq, l.id
  `)) as unknown as {
    id: string;
    letter: string | null;
    zh: string;
    ru: string | null;
    box_count: number;
    goods_key: string | null;
    kg: string;
    m3: string;
    // Named apart from the answer's own columns (`shown_kg` / `shown_m3`): these
    // are read off the LOT and exist on every server.
    kg_shown: string;
    m3_shown: string;
    goods: { name: string; pieces: number | null }[] | string | null;
  }[];
  if (rows.length === 0) return { skip: 'no_lots', clientId: receipt.clientId };

  const lots: ClientAskLot[] = rows.map((row) => {
    const goods = typeof row.goods === 'string' ? (JSON.parse(row.goods) as { name: string; pieces: number | null }[]) : (row.goods ?? []);
    return {
      lotId: row.id,
      letter: row.letter,
      zh: row.zh,
      ru: row.ru,
      count: Number(row.box_count),
      kg: Number(row.kg),
      m3: Number(row.m3),
      shownKg: row.kg_shown,
      shownM3: row.m3_shown,
      goodsKey: row.goods_key,
      // A tarkib that is WRITTEN prints its goods; none written, none printed.
      goods: row.goods_key === null ? [] : goods.map((line) => ({ name: line.name, pieces: line.pieces === null ? null : Number(line.pieces) })),
    };
  });
  return {
    receiptId: receipt.id,
    // A confirmed prixod always has its number; the type allows a draft's NULL.
    receiptNumber: receipt.number ?? '',
    clientId: receipt.clientId,
    clientCode: receipt.clientCode,
    warehouseName: receipt.warehouseName || receipt.warehouseCode,
    receivedAt: receipt.receivedAt,
    lots,
    scope,
    tag: askTag(receipt.clientId, lots, scope),
    basicTag: askTag(receipt.clientId, lots, 'basic'),
  };
}

/** One lot line as the «qabul qilindi» push prints it. */
export interface PrintedLot {
  lotId: string;
  name: string;
  boxCount: number;
  /** The totals the line printed its kilos and cubic metres FROM (`receivedFacts`' own read). */
  weightKg: number;
  volumeM3: number;
}

/**
 * Does the «yukingiz qabul qilindi» push carry the ✅ / ❌ row? Asked at SEND
 * time, so the correction window stays a window. Yes only when: the switch
 * is on and 0144 has landed; the prixod is this client's; the push prints
 * every lot (at most `PUSH_LOT_LINES` — a client cannot confirm a line they
 * were not shown); no lot has a tarkib written (the push prints «Клавиатура
 * +2» and cannot list the goods — that question is «Mijozdan so'rash»'s); at
 * least one lot is still worth asking about — a live carton in China and no
 * ✅ yet (his 4a: cargo in Uzbekistan is never asked); and the lines the push
 * is about to PRINT are the lines the tag vouches for (`printed`, with the
 * push's own name rule handed in) — the text and the tag come from two
 * reads, and a rename landing between them must cost the buttons, never
 * record a ✅ for a name the client was not shown. A `full` question ties the
 * two reads by the kilos and cubic metres too: a re-weigh landing between
 * them must not record a ✅ for a weight the message did not print.
 */
export async function clientAskOffer(
  receiptId: string,
  clientId: string,
  printed: readonly PrintedLot[],
  nameOf: (ru: string | null, zh: string) => string,
): Promise<{ receiptId: string; tag: string; scope: AskScope } | null> {
  if ((await getSetting('client_confirm_on_receipt')) !== true) return null;
  if (!(await clientConfirmsReady())) return null;
  const facts = await clientAskFacts(receiptId);
  if ('skip' in facts || facts.clientId !== clientId) return null;
  if (facts.lots.length > PUSH_LOT_LINES) return null;
  if (facts.lots.some((lot) => lot.goodsKey !== null)) return null;
  const shown = new Map(printed.map((line) => [line.lotId, line]));
  const asPrinted =
    printed.length === facts.lots.length &&
    facts.lots.every((lot) => {
      const line = shown.get(lot.lotId);
      return (
        line !== undefined &&
        line.boxCount === lot.count &&
        line.name === nameOf(lot.ru, lot.zh) &&
        (facts.scope === 'basic' || (line.weightKg === lot.kg && line.volumeM3 === lot.m3))
      );
    });
  if (!asPrinted) return null;
  const views = await lotCheckViewsFor(facts.lots.map((lot) => lot.lotId));
  const worthAsking = facts.lots.some((lot) => {
    const view = views.get(lot.lotId);
    return view !== undefined && view.askable && (view.state === 'none' || view.state === 'stale');
  });
  return worthAsking ? { receiptId, tag: facts.tag, scope: facts.scope } : null;
}

export type ClientVerdict = 'yes' | 'no';

export type ClientAnswer =
  /** Not this chat's to answer, or nothing there any more — one neutral word for all of it. */
  | { outcome: 'unknown' }
  /**
   * The facts moved since the message: the buttons are about data that no
   * longer exists. Said to the prixod's OWNER alone, so it names them — what
   * the customer writes next is about that client's cargo.
   */
  | { outcome: 'stale'; clientId: string }
  /** Every lot already holds this very answer about these very facts. */
  | { outcome: 'already'; verdict: ClientVerdict }
  /** A lot of this prixod is being edited this very second — nothing written, the buttons stay. */
  | { outcome: 'busy' }
  /** `scope` = what the pressed message asked: its thanks name exactly that. */
  | { outcome: 'recorded'; verdict: ClientVerdict; facts: ClientAskFacts; scope: AskScope };


/**
 * `键盘 (Клавиатура) × 100` — the History's value for one lot of an answer;
 * `… × 100 · 200 kg · 1.5 m³` when the answer covered the measures.
 */
function shownLine(lot: Pick<ClientAskLot, 'zh' | 'ru' | 'count'>, kg: string | null = null, m3: string | null = null): string {
  return `${lot.zh}${lot.ru ? ` (${lot.ru})` : ''} × ${lot.count}${measuresLine(kg, m3)}`;
}

/** The History's key for a lot's answer — per LOT, as the staff tick's (`lotCheck:A`). */
export function clientConfirmAuditKey(letter: string | null): string {
  return `clientConfirm:${letter ?? '?'}`;
}

/**
 * The last question asked about this prixod — of the prixod's CURRENT owner
 * (a prixod that changed owner holds one row per client): who asked and when
 * it went out. Null when only the receipt's own push has asked.
 *
 * Two askers since the owner's «1 b»: a person's «Mijozdan so'rash»
 * (`lot_ask`, who pressed it) and the system's own question after a re-weigh
 * (`lot_reask`, nobody). The newer DELIVERY wins — an answer is given to the
 * newest message the client holds — except that a person's question still
 * WAITING keeps its asker, as it always has: they pressed, and they are told.
 */
async function lastAsk(clientId: string, receiptId: string): Promise<{ askedBy: string | null; sentAt: Date | null } | null> {
  // The system's question is read only where 0147 remembers its delivery
  // (`asked_at` — never cleared by a later quiet skip, which nulls `sent_at`).
  const withAuto = await askedTagReady();
  const rows = (await db.execute(sql`
    SELECT kind, status, asked_by::text AS asked_by, sent_at,
           ${withAuto ? sql`asked_at` : sql`NULL::timestamptz AS asked_at`}
      FROM client_notices
     WHERE client_id = ${clientId}::uuid AND kind IN (${NOTICE_LOT_ASK}, ${withAuto ? NOTICE_LOT_REASK : NOTICE_LOT_ASK})
       AND ref_type = 'receipt' AND ref_id = ${receiptId}::uuid
  `)) as unknown as { kind: string; status: string; asked_by: string | null; sent_at: string | Date | null; asked_at: string | Date | null }[];
  const person = rows.find((row) => row.kind === NOTICE_LOT_ASK);
  const auto = rows.find((row) => row.kind === NOTICE_LOT_REASK);
  const autoAt = auto?.asked_at ? new Date(auto.asked_at) : null;
  // A person's question is delivered at `sent_at` — or, once a later skip of
  // the same row nulled that, at the `asked_at` 0147 remembered for it.
  const personSent = person?.sent_at ?? person?.asked_at ?? null;
  const personAt = personSent ? new Date(personSent) : null;
  const personWaiting = person !== undefined && (person.status === 'pending' || person.status === 'sending');
  // The system's question is the last one once it WENT, unless a person has
  // asked since — delivered later, or pressed and still waiting to go.
  if (autoAt && !personWaiting && (personAt === null || personAt.getTime() < autoAt.getTime())) {
    // …and a person who asked BEFORE it and has had no answer since is still
    // waiting for one: they pressed, and they are told — the answer is to the
    // newer message, the asker is theirs (TARKIB-TAKLIFLAR §7.3; the owner
    // lens, O3 — a VED holds no `plans.manage`, so a ❌ would otherwise
    // reach nobody who asked).
    if (person?.asked_by && personAt && !(await answeredSince(clientId, receiptId, personAt))) {
      return { askedBy: person.asked_by, sentAt: autoAt };
    }
    return { askedBy: null, sentAt: autoAt };
  }
  return person ? { askedBy: person.asked_by, sentAt: personAt } : null;
}

/** Has this owner answered anything about this prixod since `at`? On the pool, before the answer's transaction. */
async function answeredSince(clientId: string, receiptId: string, at: Date): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM lot_client_confirms c
      JOIN receipt_lots l ON l.id = c.lot_id
     WHERE l.receipt_id = ${receiptId}::uuid AND c.shown_client_id = ${clientId}::uuid
       AND c.answered_at >= ${at.toISOString()}::timestamptz
     LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * The staff's sentence about an answer — plain Uzbek, the card's link last
 * (the drain makes it a button). The lots print what the answer was ABOUT:
 * their kilos and cubic metres only when the pressed message asked.
 */
function staffText(
  facts: ClientAskFacts,
  verdict: ClientVerdict,
  opts: { withdraws?: boolean; scope?: AskScope } = {},
): string {
  const full = opts.scope === 'full';
  // An answer that covered the name and the count only, on a server whose
  // questions ask about the weight too: a button under a message sent before
  // 0146 was pressed. Said in words — the lots below print no kilos, and a
  // reader must not take that for «the weight was confirmed and is not shown».
  const narrower =
    opts.scope === 'basic' && facts.scope === 'full'
      ? ['Eski xabardagi tugma bosildi: bu javob faqat tovar nomi va quti soniga tegishli — og‘irlik va hajm so‘ralmagan.']
      : [];
  const lots = facts.lots
    .slice(0, 12)
    .map(
      (lot) =>
        `${lot.letter ? `${lot.letter} · ` : ''}${lot.ru ?? lot.zh} — ${lot.count} quti${full ? measuresLine(lot.shownKg, lot.shownM3) : ''}`,
    );
  if (facts.lots.length > 12) lots.push(`… yana ${facts.lots.length - 12} ta lot`);
  const link = cardLink('receipt', facts.receiptId);
  const head =
    verdict === 'no'
      ? ['❌ Mijoz yuk ma’lumotini «xato» dedi', `${facts.clientCode} · prixod ${facts.receiptNumber}`]
      : ['✅ Mijoz yuk ma’lumotini tasdiqladi', `${facts.clientCode} · prixod ${facts.receiptNumber}`];
  // One button answers the whole message: on a prixod of several lots the ❌
  // is written on every lot listed, and the sentence says so — the client
  // may have meant one of them.
  const tail =
    verdict === 'no'
      ? [
          facts.lots.length > 1
            ? `Mijoz Telegram’da «Xato bor» ni bosdi — bitta tugma, shuning uchun belgi yuqoridagi ${facts.lots.length} ta lotning hammasiga qo‘yildi. Qaysi biri noto‘g‘riligini aniqlang.`
            : 'Mijoz Telegram’da «Xato bor» ni bosdi. Nima noto‘g‘riligini aniqlang.',
          // What really ends a ❌ (§7.3): a correction alone lifts nothing on a
          // lot without a tarkib — somebody still has to tick or close it.
          // …and WHO presses: the alert's first reader is the client's seller,
          // who has neither button (they are `mayCheckLot`'s — the logist's and
          // the VED's). «Bosilguncha» alone sent him to look for a button his
          // card does not draw.
          'Lot ❓ bo‘lib turadi — logist yoki VED kartada «✅ To‘g‘ri» yoki «E’tirozni yopish» ni bosguncha (yoki mijoz qayta ✅ deguncha). Ma’lumot xato bo‘lsa, avval uni tuzating.',
        ]
      : opts.withdraws
        ? ['Mijozning avvalgi «Xato bor» javobi shu bilan bekor bo‘ldi.']
      : [];
  return [...head, ...lots, ...narrower, ...tail, ...(link ? [link] : [])].join('\n');
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
  // No button was ever drawn by a server whose 0144 has not landed (#472).
  if (!(await clientConfirmsReady())) return { outcome: 'unknown' };
  const facts = await clientAskFacts(input.receiptId);
  // WHOSE prixod, before anything is said about it. Somebody else's — or one
  // that WAS this chat's and was corrected to another client, or to nobody —
  // answers the same word as a prixod that does not exist, whatever became of
  // it. «Stale» said first told any linked chat which uuids are voided, draft
  // or unclaimed prixods, and invited a stranger's ❌ to write to a manager
  // about cargo that is not theirs (the as-built review, L2-6).
  const ownerId = facts.clientId;
  if (ownerId === null || !linked.some((client) => client.id === ownerId)) return { outcome: 'unknown' };
  if ('skip' in facts) return { outcome: 'stale', clientId: ownerId };
  // What the pressed MESSAGE asked: the tag of today's question, or — on a
  // message sent before 0146 — the 0144 recipe over the same facts. Anything
  // else is about data that has since moved.
  const scope: AskScope | null =
    input.tag === facts.tag ? facts.scope : facts.scope === 'full' && input.tag === facts.basicTag ? 'basic' : null;
  if (scope === null) return { outcome: 'stale', clientId: ownerId };
  /** The two figures this answer remembers for a lot: the scope's, or none. */
  const kgOf = (lot: ClientAskLot): string | null => (scope === 'full' ? lot.shownKg : null);
  const m3Of = (lot: ClientAskLot): string | null => (scope === 'full' ? lot.shownM3 : null);
  // The measure columns are named only where they exist — `facts.scope` is
  // the probe's own answer, asked a moment ago by `clientAskFacts`.
  const measuresHere = facts.scope === 'full';

  const lotIds = facts.lots.map((lot) => lot.lotId);
  // His 4a, and the question's own door: an answer is taken while some lot
  // of the prixod is still worth asking about — a live carton in China. A
  // button stays under its message for ever and a truck moving changes no
  // tag; a ❌ tapped on an old message after the cargo reached Tashkent would
  // take the ✅ off /stock, stand on no list (the worklist is China's) and
  // alarm the seller and every logist about papers already made.
  const views = await lotCheckViewsFor(lotIds);
  if (!lotIds.some((id) => views.get(id)?.askable === true)) return { outcome: 'stale', clientId: ownerId };
  // Read on the pool BEFORE the transaction (tx-pool): the last question a
  // person sent, and who is told.
  const ask = await lastAsk(facts.clientId, facts.receiptId);
  const askedBy = ask?.askedBy ?? null;
  // Bound as text (#156): a Date in a raw fragment is refused by the driver.
  const askedAt = ask?.sentAt ? ask.sentAt.toISOString() : null;

  const [owner] = await db.select({ seller: clients.salesManagerId }).from(clients).where(eq(clients.id, facts.clientId));
  // ❌ → the client's seller and everyone who plans (the logists and the
  // admins — the people who can correct the lot, plus the one who knows the
  // client). A plain ✅ on the receipt's own push tells nobody: the ❓ list
  // shrinking is the news. But a ✅ that WITHDRAWS a ❌ those same people
  // were alarmed about is told to them — or the seller goes on chasing a
  // dispute the customer has already taken back (decided under the locks,
  // below). The person who pressed «Mijozdan so'rash» hears either answer.
  // Read here, on the pool, before the transaction (tx-pool).
  const alarmed = [...new Set([owner?.seller, ...(await usersWithPermission('plans.manage'))].filter((id): id is string => Boolean(id)))].filter(
    (id) => id !== askedBy,
  );
  const mark = (verdict: string) => (verdict === 'yes' ? '✅' : '❌');

  let written: boolean;
  try {
   written = await db.transaction(async (tx) => {
    // Bounded: the customer is answered «hozir band» and keeps the buttons,
    // never a wait on the bot's one poller.
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    // Ordered against a colleague's tick on each lot, in one order for every
    // answer (`lockLotAnswersTx`).
    for (const id of [...lotIds].sort()) await lockLotAnswersTx(tx, id);

    // What stands on these lots — read UNDER the locks, with the two things
    // only the database can compare exactly (microseconds): was it given
    // after the last question went out, and has a colleague ticked since.
    // Read before the locks, a ❌ pressed while a lifting tick was in flight
    // — or while «E'tirozni yopish» was deleting the row — was judged against
    // a row that no longer stood (the as-built review, L1-2).
    const held = (await tx.execute(sql`
      SELECT cc.lot_id, cc.verdict, cc.shown_zh, cc.shown_ru, cc.shown_count, cc.shown_client_id, cc.shown_goods_key,
             ${measuresHere ? sql`cc.shown_kg::text AS shown_kg, cc.shown_m3::text AS shown_m3` : sql`NULL::text AS shown_kg, NULL::text AS shown_m3`},
             (${askedAt}::timestamptz IS NULL OR cc.answered_at > ${askedAt}::timestamptz) AS after_ask,
             coalesce(k.checked_at > cc.answered_at, false) AS ticked_since
        FROM lot_client_confirms cc
        LEFT JOIN lot_checks k ON k.lot_id = cc.lot_id
       WHERE cc.lot_id IN (${sql.join(
         lotIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `)) as unknown as {
      lot_id: string;
      verdict: ClientVerdict;
      shown_zh: string;
      shown_ru: string | null;
      shown_count: number;
      shown_client_id: string;
      shown_goods_key: string | null;
      shown_kg: string | null;
      shown_m3: string | null;
      after_ask: boolean;
      ticked_since: boolean;
    }[];
    const heldBy = new Map(held.map((row) => [row.lot_id, row]));
    /**
     * The lot holds this very answer about these very facts — in the terms of
     * the SCOPE that was pressed. A `full` press compares the two measures
     * too: over a `basic` answer it says MORE and is written. A `basic` press
     * compares the five facts it asked about and nothing else: it can say
     * nothing about a weight.
     */
    const same = (lot: ClientAskLot): boolean => {
      const row = heldBy.get(lot.lotId);
      if (
        row === undefined ||
        row.verdict !== input.verdict ||
        row.shown_zh !== lot.zh ||
        (row.shown_ru ?? null) !== lot.ru ||
        Number(row.shown_count) !== lot.count ||
        row.shown_client_id !== facts.clientId ||
        (row.shown_goods_key ?? null) !== lot.goodsKey
      ) {
        return false;
      }
      return scope === 'basic' || ((row.shown_kg ?? null) === lot.shownKg && (row.shown_m3 ?? null) === lot.shownM3);
    };
    /**
     * A NARROWER ✅ never replaces a WIDER one (the design judge, A1): the
     * lot holds this owner's ✅ to a question that asked about the kilos and
     * cubic metres, and the press is on a message sent before 0146, which
     * did not. Written, it would strip the figures — and where the lot has
     * been re-weighed since, turn «o'zgardi» back into ✅ by a button under
     * a message that printed the OLD weight. Such a lot is left exactly as it
     * is, whatever else is written by this press. A ❌ is never narrower:
     * an objection is an objection.
     */
    const keeps = (lot: ClientAskLot): boolean => {
      const row = heldBy.get(lot.lotId);
      return (
        scope === 'basic' &&
        input.verdict === 'yes' &&
        row !== undefined &&
        row.verdict === 'yes' &&
        row.shown_client_id === facts.clientId &&
        (row.shown_kg ?? null) !== null
      );
    };
    const writes = facts.lots.filter((lot) => !keeps(lot));
    // «Already» = every lot holds this very answer about these very facts,
    // it was given after the last question went out, AND — for a ❌ — no
    // colleague has ticked the lot since.
    //   · The same answer pressed again on a NEW question is that question's
    //     answer: the person who re-asked must hear it, and the card's date
    //     must move (the design judge).
    //   · A tick newer than the ❌ has OUTRANKED it (`lotCheckStateSql`, arm
    //     3). The push goes to every linked chat with its own buttons: chat 1
    //     says ❌, the logist phones and ticks, chat 2 presses ❌ on its copy
    //     — the same tag, the same facts. That is a new objection, not a
    //     second tap: written, its clock makes it veto again, and the people
    //     who can fix the lot are told. (Any tick since, holding or not: the
    //     rule errs toward writing, never toward swallowing a customer's ❌.)
    const settled = (lot: ClientAskLot): boolean => {
      const row = heldBy.get(lot.lotId);
      return row !== undefined && same(lot) && row.after_ask === true && !(input.verdict === 'no' && row.ticked_since === true);
    };
    if (writes.every(settled)) return false;

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const lot of writes) {
      const key = clientConfirmAuditKey(lot.letter);
      const prev = heldBy.get(lot.lotId);
      before[key] = prev
        ? `${mark(prev.verdict)} ${shownLine({ zh: prev.shown_zh, ru: prev.shown_ru, count: Number(prev.shown_count) }, prev.shown_kg ?? null, prev.shown_m3 ?? null)}`
        : null;
      // Every lot of the message is written again, so every lot is a line —
      // and the same answer about the same facts says that it was given
      // AGAIN. Skipping those left the re-answer's row with nothing under it
      // («Tizim · o'zgartirdi» over an empty box, #502).
      after[key] = `${mark(input.verdict)} Telegram · ${shownLine(lot, kgOf(lot), m3Of(lot))}${same(lot) ? ' · qayta' : ''}`;
    }

    await tx
      .insert(lotClientConfirms)
      .values(
        writes.map((lot) => ({
          lotId: lot.lotId,
          verdict: input.verdict,
          shownZh: lot.zh,
          shownRu: lot.ru,
          shownCount: lot.count,
          shownClientId: facts.clientId,
          shownGoodsKey: lot.goodsKey,
          chatId: input.chatId,
          askedBy,
          // The WALL clock, not the transaction's start: this press may have
          // waited behind a tick that began after it, and a ❌ must be newer
          // than every tick that could not see it.
          answeredAt: sql`clock_timestamp()`,
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
          answeredAt: sql`clock_timestamp()`,
        },
      });
    // The two measures (0146) — SQL-only columns, so a statement of their own
    // beside the upsert, in the same transaction and under the same locks.
    // ALWAYS written where the columns exist: a `basic` answer that replaces
    // a `full` one must not keep the old kilos (the upsert's SET does not
    // name them), or the row would claim a weight nobody was asked about.
    if (measuresHere) {
      await tx.execute(sql`
        UPDATE lot_client_confirms AS cc
           SET shown_kg = v.kg::numeric, shown_m3 = v.m3::numeric
          FROM (VALUES ${sql.join(
            writes.map((lot) => sql`(${lot.lotId}::uuid, ${kgOf(lot)}::text, ${m3Of(lot)}::text)`),
            sql`, `,
          )}) AS v(lot_id, kg, m3)
         WHERE cc.lot_id = v.lot_id
      `);
    }
    // Nobody of ours pressed: the actor is null and the VALUE says «Telegram».
    await writeAudit(tx, { actorId: null }, { entityType: 'receipt', entityId: facts.receiptId, action: 'update', before, after });
    // Queued in the SAME transaction as the answer: a crash between the two
    // would leave a redelivered press reading «already» and telling nobody.
    const type = input.verdict === 'no' ? 'ClientLotDisputed' : 'ClientLotConfirmed';
    // This ✅ takes back a ❌ of the same owner that stood on one of the lots.
    const withdraws = input.verdict === 'yes' && held.some((row) => row.verdict === 'no' && row.shown_client_id === facts.clientId);
    const others = input.verdict === 'no' || withdraws ? alarmed : [];
    // The lots this press WROTE: one left alone (`keeps`) was not answered about.
    const text = staffText({ ...facts, lots: writes }, input.verdict, { withdraws, scope });
    if (others.length > 0) await queueStaffTelegram(tx, { userIds: others, type, text });
    // The asker pressed a button and is waiting for this very answer: it goes
    // past their own mute, as the re-run a seller started does.
    if (askedBy) await queueStaffTelegram(tx, { userIds: [askedBy], type, text, ignoreMute: true });
    return true;
   });
  } catch (err) {
    if (isBusyError(err) || isBusyError((err as { cause?: unknown } | null)?.cause)) return { outcome: 'busy' };
    throw err;
  }
  if (!written) return { outcome: 'already', verdict: input.verdict };
  await kickTelegramDrain().catch(() => {});
  return { outcome: 'recorded', verdict: input.verdict, facts, scope };
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
  | 'too_soon'
  /** 0144 has not landed on this server (#472) — the question has nowhere to be answered. */
  | 'server_behind';

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
  if (!(await clientConfirmsReady())) throw new ClientAskError('server_behind');
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
  // The system's own question about this prixod (his «1 b»): on its way right
  // now, or delivered within the cooldown — the client has just been asked,
  // and the same question again minutes later is the noise the cooldown is for.
  // The check, the person's row and the stand-down are ONE transaction that
  // holds the system's row (the as-built review, DLV-3): the sweep's claim
  // (`FOR UPDATE SKIP LOCKED`) either committed first — and is read here as
  // `sending` — or skips the held row and then finds it stood down. A check
  // read on its own and a write made after it let both questions go.
  const withAuto = await askedTagReady();
  const armed = await db.transaction(async (tx) => {
    if (withAuto) {
      // On its way by the arm's own sentence — `sending`, or re-armed while it
      // was out (the fixes' review, CONC-2). «Just went» by the later of the
      // settle and the remembered delivery: between the two the row reads
      // `sent` with the previous `asked_at`.
      const [auto] = (await tx.execute(sql`
        SELECT ${reaskInFlightSql()} AS in_flight,
               greatest(asked_at, sent_at) > now() - make_interval(mins => ${ASK_COOLDOWN_MINUTES}) AS recent
          FROM client_notices
         WHERE client_id = ${facts.clientId}::uuid AND kind = ${NOTICE_LOT_REASK}
           AND ref_type = 'receipt' AND ref_id = ${receiptId}::uuid
           FOR UPDATE
      `)) as unknown as { in_flight: boolean | null; recent: boolean | null }[];
      if (auto?.in_flight === true) throw new ClientAskError('already_queued');
      if (auto?.recent === true) throw new ClientAskError('too_soon');
    }
    // ONE row per (client, kind, prixod) — `client_notices_once`. A question
    // that already went out is re-armed (the unique row is the cooldown's
    // clock); one still waiting or going out is left alone.
    const rows = (await tx
      .execute(sql`
      INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, asked_by)
      VALUES (${facts.clientId}::uuid, ${NOTICE_LOT_ASK}, 'receipt', ${receiptId}::uuid, now(), now(), ${actor.id}::uuid)
      ON CONFLICT (client_id, kind, ref_type, ref_id) DO UPDATE
         SET status = 'pending', send_after = now(), attempts = 0, last_error = NULL, claimed_at = NULL, asked_by = EXCLUDED.asked_by
       WHERE client_notices.status IN ('sent', 'failed', 'skipped')
         AND (client_notices.sent_at IS NULL OR client_notices.sent_at < now() - make_interval(mins => ${ASK_COOLDOWN_MINUTES}))
      RETURNING id
    `)
      .catch((err: unknown) => {
        // `asked_by` is 0144's column: a server that lost it between the probe
        // and here says so in words, never a digest.
        if (isServerBehind(err)) throw new ClientAskError('server_behind');
        throw err;
      })) as unknown as { id: string }[];
    // A person asked NOW: the system's own question about the same prixod, if
    // one is still held, stands down — the client must not get two questions
    // minutes apart (docs/PRIXOD-JAVOBLAR.md §1.9). A question already on its
    // way was refused above; the held row is ours until commit.
    if (rows.length > 0) {
      await tx.execute(sql`
        UPDATE client_notices SET status = 'skipped', last_error = ${REASK_SUPERSEDED}, claimed_at = NULL
         WHERE client_id = ${facts.clientId}::uuid AND kind = ${NOTICE_LOT_REASK}
           AND ref_type = 'receipt' AND ref_id = ${receiptId}::uuid AND status = 'pending'
      `);
    }
    return rows;
  });
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

/**
 * Why the system's own question was RIGHTLY not sent (docs/PRIXOD-JAVOBLAR.md
 * §1.7) — a closed list the card never prints as a failure: a person asked
 * instead, the change was taken back, the cargo left China, or the switch is
 * off. Every other reason it is skipped for is a word like any question's.
 */
export const REASK_SUPERSEDED = 'superseded';
export const REASK_QUIET = ['switched_off', REASK_SUPERSEDED, 'not_askable', 'not_needed'] as const;

/**
 * Why a question did not reach the client — a CLOSED list of words for the
 * card, never the row's `last_error` (that is a Bot API sentence in English,
 * «403 Forbidden: bot was blocked by the user», or one of our own codes).
 */
export type AskFailure = 'no_chat' | 'client_changed' | 'too_long' | 'receipt_changed' | 'blocked' | 'telegram';

/** Every reason the sweep SKIPS a question for (`prepareLotAsk`, `deliverNotice`) → its word. */
const SKIP_FAILURE: Record<ClientAskSkip | 'client_changed' | 'too_long' | 'no_linked_chat' | 'client_gone' | 'unknown_kind', AskFailure> = {
  receipt_gone: 'receipt_changed',
  voided: 'receipt_changed',
  not_confirmed: 'receipt_changed',
  no_client: 'receipt_changed',
  no_lots: 'receipt_changed',
  client_gone: 'receipt_changed',
  client_changed: 'client_changed',
  too_long: 'too_long',
  no_linked_chat: 'no_chat',
  unknown_kind: 'telegram',
};

/**
 * …and for the system's own question (`lot_reask`): null too for a skip that
 * was RIGHT (`REASK_QUIET` — nothing failed, nothing is drawn).
 */
export function reaskFailureOf(status: string, reason: string | null): AskFailure | null {
  if (status === 'skipped' && (REASK_QUIET as readonly string[]).includes(reason ?? '')) return null;
  return askFailureOf(status, reason);
}

/** The word for a question that was not delivered; null while it waits or once it went. */
export function askFailureOf(status: string, reason: string | null): AskFailure | null {
  if (status === 'skipped') return (SKIP_FAILURE as Record<string, AskFailure>)[reason ?? ''] ?? 'telegram';
  if (status !== 'failed') return null;
  // Every chat refused for good: the client blocked the bot, or the chat is gone.
  return /blocked by the user|user is deactivated|chat not found/i.test(reason ?? '') ? 'blocked' : 'telegram';
}

/** A waiting question is «stuck» once it has been due this long… */
export const ASK_STUCK_MINUTES = 5;
/** …and «held» when it is due this far ahead. */
export const ASK_LATER_MINUTES = 2;

/** The last question about a prixod, for its card: when it went, or why it has not. */
export interface ClientAskStatus {
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  /** When the question went out to the client's Telegram; null while it waits or when it never went. */
  deliveredAt: Date | null;
  /**
   * When a question that has NOT gone yet is due (`send_after`): now for one
   * just asked, later for one Telegram asked us to hold. The card words the
   * wait by it — a question due long ago and still here cannot be sent at all.
   */
  dueAt: Date | null;
  /**
   * How that wait reads, judged by the DATABASE's clock (the one that wrote
   * `send_after` — never the app's): `soon` = due now; `later` = due more
   * than `ASK_LATER_MINUTES` ahead (Telegram asked us to hold it); `stuck` =
   * due more than `ASK_STUCK_MINUTES` ago and still here — the sweep cannot
   * send at all (no bot token, a refused one). Null once it has gone.
   */
  wait: 'soon' | 'later' | 'stuck' | null;
  /** The row's own `last_error` — for the log and the tests; the card reads `failure`. */
  reason: string | null;
  failure: AskFailure | null;
  askedBy: string | null;
  /**
   * When a person's question last REACHED the client — `sent_at`, or, after a
   * later attempt was skipped (which nulls `sent_at`), the delivery 0147
   * remembered (`asked_at`). What the card measures the system's question
   * against (the as-built review, C1); `deliveredAt` stays the line's own.
   */
  lastDeliveredAt: Date | null;
}

/** Of the prixod's CURRENT owner — a prixod that changed owner holds a row per client. */
export async function clientAskStatusFor(receiptId: string): Promise<ClientAskStatus | null> {
  if (!isUuidShaped(receiptId)) return null;
  // The card's read of a column 0144 added: one migration behind there is no
  // question to report on, and the card must still draw.
  if (!(await clientConfirmsReady())) return null;
  // …and the remembered delivery is 0147's (L1-1: asked of the probe here).
  const withAsked = await askedTagReady();
  const rows = (await db.execute(sql`
    SELECT n.status, n.sent_at, n.send_after, n.last_error, u.full_name AS asked_by,
           ${withAsked ? sql`n.asked_at` : sql`NULL::timestamptz AS asked_at`},
           CASE WHEN n.status NOT IN ('pending', 'sending') THEN NULL
                WHEN n.send_after < now() - make_interval(mins => ${ASK_STUCK_MINUTES}) THEN 'stuck'
                WHEN n.send_after > now() + make_interval(mins => ${ASK_LATER_MINUTES}) THEN 'later'
                ELSE 'soon' END AS wait
      FROM client_notices n
      JOIN receipts r ON r.id = n.ref_id AND r.client_id = n.client_id
      LEFT JOIN users u ON u.id = n.asked_by
     WHERE n.kind = ${NOTICE_LOT_ASK} AND n.ref_type = 'receipt' AND n.ref_id = ${receiptId}::uuid
     LIMIT 1
  `)) as unknown as {
    status: ClientAskStatus['status'];
    sent_at: string | Date | null;
    send_after: string | Date | null;
    last_error: string | null;
    asked_by: string | null;
    asked_at: string | Date | null;
    wait: ClientAskStatus['wait'];
  }[];
  const row = rows[0];
  if (!row) return null;
  const waiting = row.status === 'pending' || row.status === 'sending';
  const lastDelivered = row.sent_at ?? row.asked_at;
  return {
    status: row.status,
    deliveredAt: row.sent_at ? new Date(row.sent_at) : null,
    lastDeliveredAt: lastDelivered ? new Date(lastDelivered) : null,
    dueAt: waiting && row.send_after ? new Date(row.send_after) : null,
    wait: waiting ? (row.wait ?? 'soon') : null,
    reason: row.last_error,
    failure: askFailureOf(row.status, row.last_error),
    askedBy: row.asked_by,
  };
}

/**
 * The system's own question about a prixod, for its card (the owner's «1 b»,
 * docs/PRIXOD-JAVOBLAR.md §1.9): held until `at`, sent at `at`, or not
 * delivered for a reason with a word. Null = none, or one RIGHTLY not sent
 * (`REASK_QUIET`) — the card draws nothing of it. Of the prixod's CURRENT
 * owner, as the person's question is.
 */
export interface ClientReaskStatus {
  state: 'waiting' | 'sent' | 'failed';
  /**
   * When it is due (waiting), when it last went (sent), or when it was due
   * and did not go (failed — it cannot have failed earlier; the card hides a
   * failure a person's later question has overtaken, DLV-1).
   */
  at: Date | null;
  /**
   * A waiting question worded by its age, on the DATABASE's clock — the
   * person's question's own rule (TARKIB-TAKLIFLAR §7.3, L3-4): `stuck` =
   * due more than `ASK_STUCK_MINUTES` ago and still here (no bot token, a
   * refused one). Null unless waiting.
   */
  wait: 'soon' | 'stuck' | null;
  failure: AskFailure | null;
}

export async function clientReaskStatusFor(receiptId: string): Promise<ClientReaskStatus | null> {
  if (!isUuidShaped(receiptId)) return null;
  // Its rows and the column that remembers its delivery are 0147's.
  if (!(await askedTagReady())) return null;
  const rows = (await db.execute(sql`
    SELECT n.status, n.send_after, n.last_error, n.asked_at,
           (n.send_after < now() - make_interval(mins => ${ASK_STUCK_MINUTES})) AS stuck
      FROM client_notices n
      JOIN receipts r ON r.id = n.ref_id AND r.client_id = n.client_id
     WHERE n.kind = ${NOTICE_LOT_REASK} AND n.ref_type = 'receipt' AND n.ref_id = ${receiptId}::uuid
     LIMIT 1
  `)) as unknown as {
    status: string;
    send_after: string | Date | null;
    last_error: string | null;
    asked_at: string | Date | null;
    stuck: boolean | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'pending' || row.status === 'sending') {
    return {
      state: 'waiting',
      at: row.send_after ? new Date(row.send_after) : null,
      wait: row.stuck === true ? 'stuck' : 'soon',
      failure: null,
    };
  }
  // «Owner changed» read HERE is about an owner who went and came back — this
  // reader takes the current owner's row alone — and the correction that
  // brought them back re-decided the question (`assignReceiptClient` → the
  // arm): re-armed, it reads «waiting»; not due, nothing is owed. Drawn as a
  // failure it stood on the card for good, inviting a press nobody needed
  // (the fixes' review, CONC-4).
  const failure = row.status === 'skipped' && row.last_error === SKIP_CLIENT_CHANGED ? null : reaskFailureOf(row.status, row.last_error);
  if (failure) return { state: 'failed', at: row.send_after ? new Date(row.send_after) : null, wait: null, failure };
  // Delivered — read from `asked_at`, which no later outcome clears: a
  // question that went and was then rightly NOT sent again (the correction
  // taken back) is still the one the client holds.
  return row.asked_at ? { state: 'sent', at: new Date(row.asked_at), wait: null, failure: null } : null;
}

/**
 * What the prixod card's «Mijozdan so'rash» block needs, in one call: is the
 * client's side there at all (0144 — null when not, and the card draws
 * nothing of it), can the client be reached, the last question's fate — and
 * the system's own question's (`auto`, his «1 b»).
 * Never throws at the card: a block that cannot be read is a block not drawn.
 */
export async function clientAskCardFor(
  receiptId: string,
  clientId: string | null,
): Promise<{ hasChat: boolean; status: ClientAskStatus | null; full: boolean; auto: ClientReaskStatus | null } | null> {
  if (!clientId) return null;
  try {
    if (!(await clientConfirmsReady())) return null;
    const [chats, status, full, auto] = await Promise.all([
      linkedChats(clientId),
      clientAskStatusFor(receiptId),
      clientMeasuresReady(),
      clientReaskStatusFor(receiptId),
    ]);
    return { hasChat: chats.length > 0, status, full, auto };
  } catch (err) {
    logger.warn({ err, receiptId }, '[client-confirm] the card could not read the last question');
    return null;
  }
}

export type ClientDisputeRefusal = 'forbidden' | 'receipt_not_confirmed' | 'check_changed' | 'server_behind';

export class ClientDisputeError extends Error {
  constructor(public readonly code: ClientDisputeRefusal) {
    super(code);
  }
}

/**
 * «E'tirozni yopish»: a person with the lot-check door takes the client's ❌
 * off one lot — or off every disputed lot of the prixod in one press — after
 * talking to them, or because it was pressed by mistake. The rows are
 * DELETED (the History keeps what they said and who closed them), so the lot
 * reads as it would had the client never answered. A ✅ is never closed by a
 * person: the client's own word stands until the data moves.
 *
 * Only the ❌ the card DREW (`token` = `answered_at::text`, the tick's own
 * compare-and-set): a second ❌ that landed after the page was drawn — the
 * client pressed again on a new question — must not be erased by somebody
 * who never saw it. Every posted lot or none (`check_changed`). On a
 * confirmed prixod only, as «Bekor qilish» is.
 */
export async function dismissClientDisputes(
  input: { receiptId: string; seen: readonly { lotId: string; token: string }[]; note?: string | null },
  actor: LotCheckActor,
  ctx: AuditContext,
): Promise<{ lots: number }> {
  if (!mayCheckLot(actor.permissions) || !isUuidShaped(input.receiptId)) throw new ClientDisputeError('forbidden');
  const seen = [...new Map(input.seen.map((row) => [row.lotId, row])).values()];
  if (
    seen.length === 0 ||
    seen.length > ASK_MAX_LOTS * 4 ||
    seen.some((row) => !isUuidShaped(row.lotId) || typeof row.token !== 'string' || row.token === '' || row.token.length > 64)
  ) {
    throw new ClientDisputeError('forbidden');
  }
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, input.receiptId) });
  if (!receipt) throw new ClientDisputeError('forbidden');
  if (!(await mayReadReceipt(actor, { id: receipt.id, warehouseId: receipt.warehouseId }))) throw new ClientDisputeError('forbidden');
  if (receipt.status !== 'confirmed') throw new ClientDisputeError('receipt_not_confirmed');
  if (!(await clientConfirmsReady())) throw new ClientDisputeError('server_behind');
  const note = (input.note ?? '').trim().slice(0, 500) || null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const gone = (await tx.execute(sql`
      DELETE FROM lot_client_confirms cc
       USING receipt_lots l, receipts r
       WHERE l.id = cc.lot_id AND r.id = l.receipt_id AND l.receipt_id = ${input.receiptId}::uuid AND cc.verdict = 'no'
         -- The ❌ the card draws is the OWNER's: a previous owner's is nobody's
         -- to close (were the prixod corrected back, it would be gone unseen).
         AND cc.shown_client_id = r.client_id
         AND (cc.lot_id, cc.answered_at::text) IN (${sql.join(
           seen.map((row) => sql`(${row.lotId}::uuid, ${row.token})`),
           sql`, `,
         )})
      RETURNING cc.lot_id, l.letter, cc.shown_zh, cc.shown_ru, cc.shown_count
    `)) as unknown as { lot_id: string; letter: string | null; shown_zh: string; shown_ru: string | null; shown_count: number }[];
    // Fewer than posted = the client answered again, or a colleague closed it
    // already: nothing is closed, and the page is told to look again.
    if (gone.length !== seen.length) throw new ClientDisputeError('check_changed');
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const row of [...gone].sort((x, y) => (x.letter ?? '').localeCompare(y.letter ?? ''))) {
      const key = clientConfirmAuditKey(row.letter);
      before[key] = `❌ ${shownLine({ zh: row.shown_zh, ru: row.shown_ru, count: Number(row.shown_count) })}`;
      after[key] = note ? `e’tiroz yopildi: ${note}` : 'e’tiroz yopildi';
    }
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before,
      after,
    });
  });
  return { lots: seen.length };
}
