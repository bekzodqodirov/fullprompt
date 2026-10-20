import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  leads,
  leadStages,
  roles,
  staffGroupChats,
  staffGroupMedia,
  staffGroupPosts,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { activeStaffGroup, recordGroupMembership } from '@/modules/platform/telegram/staff-group';
import {
  drainStaffGroup,
  pickGroupMedia,
  queueGroupPost,
  retryGroupPost,
} from '@/modules/platform/telegram/staff-group-posts';
import { STAFF_GROUP_MEDIA_ENTITY, STAFF_GROUP_MEDIA_TYPE } from '@/modules/platform/telegram/staff-group-media';
import { celebrateFirstCargo, celebrateLeadWon, celebrateNewClient } from '@/modules/wms/staff/celebrate';
import { postWeeklyRating, ratingViewFor } from '@/modules/wms/staff/rating';
import { ratingWindowEnding } from '@/modules/wms/staff/rating-math';
import { receiveStamped, removeStamped } from '../fixtures/stamped-cargo';

/**
 * The staff group end to end against a real database (0134), the Bot API
 * replaced by a recorder (no network here, no token in CI). No pg-boss: the
 * test calls the drain itself.
 *
 * An active staff group is CONFIGURATION — while it stands, every won lead
 * and every first prixod anywhere in the suite queues a post — so this file's
 * chat rows are deleted in afterAll before anything else, and its fixture
 * users are deactivated, never deleted (#183/#653).
 *
 * The rating's cargo is received in 1695, a year no other file uses, so the
 * window reads this file's prixods and nobody else's.
 */
const SUFFIX = String(Date.now()).slice(-6);
const BOT_ID = 700_000_134;
const TOKEN = `${BOT_ID}:TESTTOKEN`;
const GROUP = '-1003400000001';
const SUPER = '-1003400000002';
const STRANGERS = '-1003400000003';
const tgBase = 6_200_000_000 + Number(SUFFIX) * 10;
const TG = { admin: tgBase + 1, seller: tgBase + 2, seller2: tgBase + 3, stranger: tgBase + 9 };

interface Call {
  method: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let nextMessageId = 500;
type Answer = { status: number; json: unknown } | 'throw-timeout';
let override: (method: string, body: Record<string, unknown>) => Answer | undefined = () => undefined;

function defaultAnswer(method: string, body: Record<string, unknown>): { status: number; json: unknown } {
  const ok = (result: unknown) => ({ status: 200, json: { ok: true, result } });
  switch (method) {
    case 'getChat':
      return ok({ id: Number(body.chat_id), title: 'GSR jamoa', type: 'supergroup' });
    case 'getChatMember':
      return ok({ status: 'member', user: { id: BOT_ID, is_bot: true } });
    case 'getChatMemberCount':
      return ok(12);
    case 'sendMessage':
      return ok({ message_id: (nextMessageId += 1) });
    case 'sendAnimation':
      return ok({ message_id: (nextMessageId += 1), animation: { file_id: `anim-${nextMessageId}` } });
    default:
      return ok(true);
  }
}

const sends = () => calls.filter((c) => ['sendMessage', 'sendAnimation', 'sendPhoto'].includes(c.method));

let tokenBefore: string | undefined;
let adminId = '';
let sellerId = '';
let seller2Id = '';
let clientId = '';
let client2Id = '';
const receiptIds: string[] = [];
const attachmentIds: string[] = [];
let leadId = '';
let openLeadId = '';

async function makeUser(name: string, role: string | null, tgId: number | null, tail: string) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning();
  if (role) {
    const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
    await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  }
  if (tgId !== null) {
    await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: BigInt(tgId), status: 'linked', linkedAt: new Date() });
  }
  return u!.id;
}

const added = (chatId: string, fromId: number, status = 'member', type = 'supergroup') => ({
  chat: { id: Number(chatId), type, title: `Jamoa ${chatId}` },
  from: { id: fromId },
  new_chat_member: { status },
});

const postBy = (key: string) => db.query.staffGroupPosts.findFirst({ where: eq(staffGroupPosts.dedupeKey, key) });

beforeAll(async () => {
  tokenBefore = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  __setTelegramTransport(async (url, init) => {
    const method = url.split('/').pop()!;
    const form = init.body instanceof FormData ? init.body : null;
    const body = form
      ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>']))
      : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ method, body });
    const answer = override(method, body) ?? defaultAnswer(method, body);
    if (answer === 'throw-timeout') throw new DOMException('timeout', 'TimeoutError');
    return new Response(JSON.stringify(answer.json), { status: answer.status });
  });
  // No group may be active from an earlier run that died: this file owns the
  // one-active slot while it runs.
  await db.update(staffGroupChats).set({ activeFrom: null, activeByUserId: null }).where(sql`active_from IS NOT NULL`);
  adminId = await makeUser(`Guruh Admin ${SUFFIX}`, 'admin', TG.admin, '01');
  sellerId = await makeUser(`Aziz Sotuvchi ${SUFFIX}`, 'sales_manager', TG.seller, '02');
  seller2Id = await makeUser(`Bekzod <Sotuvchi> ${SUFFIX}`, 'sales_manager', null, '03');
  const [c1] = await db
    .insert(clients)
    .values({ clientCode: `SG${SUFFIX}`, name: `Guruh mijoz ${SUFFIX}`, phones: [], salesManagerId: sellerId })
    .returning();
  const [c2] = await db
    .insert(clients)
    .values({ clientCode: `SH${SUFFIX}`, name: `Guruh mijoz 2 ${SUFFIX}`, phones: [], salesManagerId: seller2Id })
    .returning();
  clientId = c1!.id;
  client2Id = c2!.id;
});

beforeEach(() => {
  calls = [];
  override = () => undefined;
});

afterAll(async () => {
  // Configuration first: the active group and every row this file wrote.
  await db.delete(staffGroupChats).where(inArray(staffGroupChats.chatId, [BigInt(GROUP), BigInt(SUPER), BigInt(STRANGERS)]));
  await db.delete(staffGroupPosts).where(
    sql`dedupe_key LIKE ${`%${SUFFIX}%`} OR subject_user_id IN (${sql.join([adminId, sellerId, seller2Id].map((id) => sql`${id}::uuid`), sql`, `)})
        OR dedupe_key IN (${sql`'client:' || ${clientId}`}, ${sql`'first_cargo:' || ${clientId}`}, ${sql`'first_cargo:' || ${client2Id}`}, 'rating:1695-03-12')
        OR dedupe_key IN (${`won:${leadId}`}, ${`won:${openLeadId}`})`,
  );
  if (attachmentIds.length) await db.delete(attachments).where(inArray(attachments.id, attachmentIds));
  await removeStamped(receiptIds);
  await db.delete(leads).where(inArray(leads.id, [leadId, openLeadId].filter(Boolean)));
  await db.delete(clients).where(inArray(clients.id, [clientId, client2Id]));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, [adminId, sellerId]));
  await db.update(users).set({ active: false }).where(inArray(users.id, [adminId, sellerId, seller2Id]));
  __setTelegramTransport(null);
  process.env.TELEGRAM_BOT_TOKEN = tokenBefore;
});

describe('the group is adopted only from a colleague', () => {
  it('a stranger’s group writes nothing', async () => {
    expect(await recordGroupMembership(added(STRANGERS, TG.stranger))).toBe('ignored');
    expect(await db.query.staffGroupChats.findFirst({ where: eq(staffGroupChats.chatId, BigInt(STRANGERS)) })).toBeUndefined();
  });

  it('the settings admin adds the bot and the group starts working', async () => {
    expect(await recordGroupMembership(added(GROUP, TG.admin))).toBe('adopted');
    const active = await activeStaffGroup();
    expect(active?.chatId.toString()).toBe(GROUP);
    expect(active?.canPost).toBe(true);
    expect(active?.memberCount).toBe(12);
  });

  it('a seller’s second group is recorded and waits; nothing moves the active one', async () => {
    expect(await recordGroupMembership(added(STRANGERS, TG.seller))).toBe('recorded');
    expect((await activeStaffGroup())?.chatId.toString()).toBe(GROUP);
  });
});

describe('the ledger says each thing once', () => {
  it('one claim per key: a second queue is refused, the drain sends one message', async () => {
    const key = `test:${SUFFIX}:once`;
    expect(await queueGroupPost({ kind: 'test', dedupeKey: key, html: '<b>bir</b>' })).toBe(true);
    expect(await queueGroupPost({ kind: 'test', dedupeKey: key, html: '<b>ikki</b>' })).toBe(false);
    const run = await drainStaffGroup();
    expect(run.sent).toBeGreaterThanOrEqual(1);
    const mine = sends().filter((c) => String(c.body.text ?? '').includes('bir'));
    expect(mine).toHaveLength(1);
    expect(String(mine[0]!.body.chat_id)).toBe(GROUP);
    const row = await postBy(key);
    expect(row?.status).toBe('sent');
    expect(row?.messageId).toBeGreaterThan(0);
    expect(row?.chatId?.toString()).toBe(GROUP);
  });

  it('an answer that may have published is failed, never re-sent by the machine', async () => {
    const key = `test:${SUFFIX}:ambiguous`;
    override = (method) => (method === 'sendMessage' ? 'throw-timeout' : undefined);
    await queueGroupPost({ kind: 'test', dedupeKey: key, html: 'balki' });
    await drainStaffGroup();
    expect((await postBy(key))?.status).toBe('failed');
    expect((await postBy(key))?.lastError).toBe('ambiguous_send');
    override = () => undefined;
    calls = [];
    await drainStaffGroup();
    expect(sends().filter((c) => String(c.body.text ?? '').includes('balki'))).toHaveLength(0);
    // A person's press re-arms it.
    const row = await postBy(key);
    expect(await retryGroupPost(row!.id)).toBe(true);
    await drainStaffGroup();
    expect((await postBy(key))?.status).toBe('sent');
  });

  it('a group that became a supergroup is followed, and the post goes to the new id', async () => {
    const key = `test:${SUFFIX}:migrate`;
    override = (method, body) =>
      method === 'sendMessage' && String(body.chat_id) === GROUP
        ? {
            status: 400,
            json: {
              ok: false,
              description: 'Bad Request: group chat was upgraded to a supergroup chat',
              parameters: { migrate_to_chat_id: Number(SUPER) },
            },
          }
        : undefined;
    await queueGroupPost({ kind: 'test', dedupeKey: key, html: 'kochdi' });
    await drainStaffGroup();
    expect((await activeStaffGroup())?.chatId.toString()).toBe(SUPER);
    const row = await postBy(key);
    expect(row?.status).toBe('sent');
    expect(row?.chatId?.toString()).toBe(SUPER);
  });

  it('with no group connected the claim is written skipped — connecting later floods nothing', async () => {
    const group = (await activeStaffGroup())!;
    await db.update(staffGroupChats).set({ activeFrom: null, activeByUserId: null }).where(eq(staffGroupChats.chatId, group.chatId));
    const key = `test:${SUFFIX}:nogroup`;
    await queueGroupPost({ kind: 'test', dedupeKey: key, html: 'hech kim' });
    const row = await postBy(key);
    expect(row?.status).toBe('skipped');
    expect(row?.skipReason).toBe('no_group');
    await db
      .update(staffGroupChats)
      .set({ activeFrom: new Date(), activeByUserId: adminId })
      .where(eq(staffGroupChats.chatId, group.chatId));
    await drainStaffGroup();
    expect(sends().filter((c) => String(c.body.text ?? '').includes('hech kim'))).toHaveLength(0);
  });
});

describe('the GIFs take turns (his «zerkarli bolmasin»)', () => {
  it('least recently shown first, round and round', async () => {
    // Earlier files may have left none; this file's three are the only ones
    // whose order it asserts, so any other is parked as «just shown».
    await db.execute(sql`
      INSERT INTO staff_group_media (attachment_id, last_used_at)
      SELECT id, now() + interval '1 day' FROM attachments
       WHERE entity_type = ${STAFF_GROUP_MEDIA_TYPE} AND entity_id = ${STAFF_GROUP_MEDIA_ENTITY}::uuid
      ON CONFLICT (attachment_id) DO UPDATE SET last_used_at = now() + interval '1 day'`);
    for (const n of [1, 2, 3]) {
      const [a] = await db
        .insert(attachments)
        .values({
          entityType: STAFF_GROUP_MEDIA_TYPE,
          entityId: STAFF_GROUP_MEDIA_ENTITY,
          kind: 'file',
          storageKey: `test/staff-group/${SUFFIX}-${n}.gif`,
          fileName: `tabrik-${n}.gif`,
          contentType: 'image/gif',
          sizeBytes: 10,
          uploadedBy: adminId,
          createdAt: new Date(Date.UTC(2000, 0, n)),
        })
        .returning();
      attachmentIds.push(a!.id);
      // Telegram already knows these bytes — the cache is what a send reuses.
      await db.insert(staffGroupMedia).values({ attachmentId: a!.id, telegramFileId: `known-${n}`, telegramSentAs: 'animation' });
    }
    const order = [await pickGroupMedia(), await pickGroupMedia(), await pickGroupMedia(), await pickGroupMedia()];
    expect(order).toEqual([attachmentIds[0], attachmentIds[1], attachmentIds[2], attachmentIds[0]]);
  });

  it('a celebration goes as the GIF with the words as its caption, by the cached id', async () => {
    await celebrateNewClient(clientId, sellerId);
    await drainStaffGroup();
    const anim = calls.filter((c) => c.method === 'sendAnimation');
    expect(anim).toHaveLength(1);
    expect(anim[0]!.body.animation).toMatch(/^known-/);
    expect(String(anim[0]!.body.caption)).toContain(`<b>SG${SUFFIX}</b>`);
    expect(String(anim[0]!.body.caption)).toContain(`tg://user?id=${TG.seller}`);
    expect(String(anim[0]!.body.caption)).toContain('📈 Bu oyning birinchi yangi mijozi!');
    // The same client again: nobody is praised twice.
    calls = [];
    await celebrateNewClient(clientId, sellerId);
    await drainStaffGroup();
    expect(sends()).toHaveLength(0);
  });
});

describe('the three celebrations', () => {
  it('a won lead, once, naming its owner and its client code', async () => {
    const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'won') });
    const [lead] = await db
      .insert(leads)
      .values({
        name: `Lid ${SUFFIX}`,
        stageId: stage!.id,
        ownerId: seller2Id,
        clientId: client2Id,
        createdBy: adminId,
        // His «nech pullik necha kub necha kg» — the lead's own quote. closed_at
        // is left NULL on purpose: a legacy door that never stamped it must not
        // drop the win from its own month.
        quotedAmount: '2450.00',
        quotedCurrency: 'USD',
        quotedVolumeM3: '18.500',
        quotedWeightKg: '2300.000',
      })
      .returning();
    leadId = lead!.id;
    const event = { payload: { leadId, stageKind: 'won' }, actorId: adminId };
    await celebrateLeadWon(event);
    await celebrateLeadWon(event);
    const rows = await db.select().from(staffGroupPosts).where(eq(staffGroupPosts.dedupeKey, `won:${leadId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectUserId).toBe(seller2Id);
    // No linked chat → the name in bold, escaped, never a mention.
    expect(rows[0]!.html).toContain(`<b>Bekzod &lt;Sotuvchi&gt; ${SUFFIX}</b>`);
    expect(rows[0]!.html).not.toContain('tg://');
    expect(rows[0]!.html).toContain(`SH${SUFFIX}`);
    const nb = (text: string) => text.replace(/(\d) (\d)/g, '$1\u00a0$2');
    expect(rows[0]!.html).toContain(nb('💰 Narx: <b>$2 450</b>'));
    expect(rows[0]!.html).toContain(nb('📦 Yuk: <b>18.5 kub</b> · <b>2 300 kg</b>'));
    expect(rows[0]!.html).toContain("🔥 Bu oyning birinchi g'alabasi!");
  });

  it('a lead moved to an OPEN stage is not a win — a real lead, with an owner and a client', async () => {
    const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
    const [lead] = await db
      .insert(leads)
      .values({ name: `Ochiq lid ${SUFFIX}`, stageId: stage!.id, ownerId: sellerId, clientId, createdBy: adminId })
      .returning();
    openLeadId = lead!.id;
    await celebrateLeadWon({ payload: { leadId: openLeadId, stageKind: 'open' }, actorId: adminId });
    expect(await postBy(`won:${openLeadId}`)).toBeUndefined();
  });

  it('a new client’s FIRST prixod, praised for its stamp, and never the second', async () => {
    const first = await receiveStamped({ clientId, actorId: adminId, sellerId, m3: 2.456, kg: 310, boxes: 2 });
    receiptIds.push(first.receiptId);
    await celebrateFirstCargo({ payload: { receiptId: first.receiptId, clientId } });
    const row = await postBy(`first_cargo:${clientId}`);
    expect(row?.subjectUserId).toBe(sellerId);
    expect(row?.html).toContain('2.46 kub · 310 kg');
    const second = await receiveStamped({ clientId, actorId: adminId, sellerId, m3: 1, kg: 100 });
    receiptIds.push(second.receiptId);
    await celebrateFirstCargo({ payload: { receiptId: second.receiptId, clientId } });
    const all = await db.select().from(staffGroupPosts).where(eq(staffGroupPosts.dedupeKey, `first_cargo:${clientId}`));
    expect(all).toHaveLength(1);
  });

  it('a client that already had a prixod is not «first» — even with no claim yet', async () => {
    const before = await receiveStamped({ clientId: client2Id, actorId: adminId, sellerId: seller2Id, m3: 1, kg: 1 });
    const later = await receiveStamped({ clientId: client2Id, actorId: adminId, sellerId: seller2Id, m3: 1, kg: 1 });
    receiptIds.push(before.receiptId, later.receiptId);
    await celebrateFirstCargo({ payload: { receiptId: later.receiptId, clientId: client2Id } });
    expect(await postBy(`first_cargo:${client2Id}`)).toBeUndefined();
  });
});

describe('the Saturday rating', () => {
  // Saturday 1695-03-12, 18:00 Tashkent. Only this file's prixods live in 1695.
  const SAT = new Date('1695-03-12T13:00:00Z');
  const at = (iso: string) => new Date(iso);

  it('reads the KPI’s own cargo, ranks by kub, and is posted once per week', async () => {
    const rows = [
      // Inside the window [03-05 18:00, 03-12 18:00) Tashkent.
      await receiveStamped({ clientId, actorId: adminId, sellerId, m3: 4, kg: 400, receivedAt: at('1695-03-06T06:00:00Z') }),
      await receiveStamped({ clientId: client2Id, actorId: adminId, sellerId: seller2Id, m3: 6, kg: 500, receivedAt: at('1695-03-12T12:59:00Z') }),
      // Saturday 18:00 sharp belongs to the NEXT week.
      await receiveStamped({ clientId, actorId: adminId, sellerId, m3: 50, kg: 5000, receivedAt: at('1695-03-12T13:00:00Z') }),
      // The week before — for ▲▼.
      await receiveStamped({ clientId, actorId: adminId, sellerId, m3: 1, kg: 50, receivedAt: at('1695-03-01T06:00:00Z') }),
      // Nobody's: counted apart, never in a seller's line.
      await receiveStamped({ clientId, actorId: adminId, sellerId: null, m3: 2, kg: 20, receivedAt: at('1695-03-07T06:00:00Z') }),
    ];
    receiptIds.push(...rows.map((r) => r.receiptId));
    const w = ratingWindowEnding(SAT);
    expect(w.key).toBe('1695-03-12');
    const { view, standings } = await ratingViewFor(w, { withHistory: true });
    const mine = standings.filter((s) => s.userId === sellerId || s.userId === seller2Id);
    expect(mine.map((s) => [s.userId, s.m3])).toEqual([
      [seller2Id, 6],
      [sellerId, 4],
    ]);
    const azizLine = view.rows.find((r) => r.userId === sellerId)!;
    expect(azizLine.before).toBe(1);
    expect(view.unstamped.m3).toBeGreaterThanOrEqual(2);

    expect(await postWeeklyRating(SAT)).toBe('queued');
    expect(await postWeeklyRating(SAT)).toBe('already');
    const post = await postBy('rating:1695-03-12');
    expect(post?.kind).toBe('rating');
    expect(post?.html).toContain('Haftalik reyting');
    expect((post?.standings as { key: string }).key).toBe('1695-03-12');
  });
});
