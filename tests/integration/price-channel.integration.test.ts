import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  calcExtras,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  events,
  leads,
  priceChannelChats,
  priceChannelMembers,
  priceChannelPosts,
  receipts,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { nowSec } from '@/modules/platform/telegram/waits';
import {
  __resetVetMemo,
  answerJoinRequest,
  answerMemberUpdate,
  recordChatMembership,
  sweepPriceChannelMembers,
  vetChannel,
} from '@/modules/platform/telegram/price-channel';
import { SETTINGS_AUDIT_ID } from '@/modules/platform/settings/service';
import { finishCalcRequest, openCalcRequest, returnCalcRequest } from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  createGroup,
  loadWorkspace,
  moveItemToGroup,
  recalcFromSealed,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';
import { queueMissedPrices, queuePriceChannelPost } from '@/modules/wms/calc/channel-queue';
import { drainPriceChannel, reconcilePriceChannelMarks, retryPriceChannelPost } from '@/modules/wms/calc/channel-send';
import { channelPanel } from '@/modules/wms/calc/channel-panel';
import { recheckChannelAction } from '@/app/(protected)/admin/narx-kanali/actions';

/**
 * The panel's «Qayta tekshirish» is pressed as a SERVER ACTION (I14): its
 * gate answers the fixture admin, and the request/cache seams it touches
 * outside a request are stubbed. Nothing else in this file calls them.
 */
const press = vi.hoisted(() => ({ actorId: '' }));
vi.mock('@/modules/platform/rbac/authorize', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/rbac/authorize')>()),
  authorize: async () => ({ id: press.actorId, permissions: new Set(['admin.settings.manage']) }),
}));
vi.mock('@/modules/platform/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'price-channel.integration' }),
}));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));

/**
 * One seam: a post build that throws (a database blip between the claim and
 * the send), switched on by a test. Everything else is the real module.
 */
const seam = vi.hoisted(() => ({ buildThrows: false, beforeThrow: null as null | (() => Promise<void>) }));
vi.mock('@/modules/wms/calc/channel-queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/channel-queue')>();
  return {
    ...real,
    buildChannelPostView: async (...args: Parameters<typeof real.buildChannelPostView>) => {
      if (seam.buildThrows) {
        if (seam.beforeThrow) await seam.beforeThrow();
        throw new Error('Connection terminated unexpectedly');
      }
      return real.buildChannelPostView(...args);
    },
  };
});

/**
 * The price channel end to end against a real database (his F, 2026-10-07),
 * with the Bot API replaced by a recorder (no network here, no token in CI).
 * No pg-boss: the test calls the drain, the reconcile and the sweep itself.
 *
 * The connected channel is CONFIGURATION for every later seal in the suite
 * (a connected row makes every seal post), so this file's chat, post and
 * member rows are deleted in afterAll, before its fixture users are
 * deactivated — directly, never through the toggle, which would REACTIVATE a
 * colleague a test deactivated (#183/#653).
 */
const SUFFIX = String(Date.now()).slice(-6);
const BOT_ID = 700_000_001;
const TOKEN = `${BOT_ID}:TESTTOKEN`;
const CHAT = '-1001234567890';
const CHAT_A = '-1001111111111';
const CHAT_ADOPT = '-1002222222222';
const tgBase = 6_100_000_000 + Number(SUFFIX) * 10;
const TG = { admin: tgBase + 1, colleague: tgBase + 2, seller: tgBase + 3, colleague2: tgBase + 4, colleague3: tgBase + 5, stranger: tgBase + 9 };

let tokenBefore: string | undefined;
let adminId = '';
let sellerId = '';
let colleagueId = '';
let colleague2Id = '';
let colleague3Id = '';
let leadId = '';
let noteId = '';
/**
 * Identity the CARD knows nothing about (F4 a): another client's manual code
 * and an unclaimed marking claimed to that client. Six digits at most, so the
 * phone rule cannot be what removes the code — only the book can.
 */
const MANUAL_CODE = `4${String(100_000 + Math.floor(Math.random() * 899_999)).slice(-5)}`;
const MARKING = `MANIKEN${SUFFIX}`;
/**
 * A third client of the book whose code carries LETTERS, typed in the goods
 * with Cyrillic А and К — only the fold in `codeCandidates` asks the book
 * about it (eight characters, so neither the phone rule nor the prefix can).
 */
const LOOKALIKE_CODE = `AK${SUFFIX}`;
const LOOKALIKE_TYPED = `\u0410\u041a${SUFFIX}`;
let manualClientId = '';
let lookalikeClientId = '';
let markingReceiptId = '';
/**
 * A card that OWNS a two-character code: no shape, no prefix and no length
 * rule of the book knows it, so only `forbiddenFor`'s own codes can take it
 * out of the post (chosen free in beforeAll).
 */
let ownShortCode = '';
let ownShortClientId = '';
let ownLeadId = '';
const photoKey = `test/price-channel/${SUFFIX}.jpg`;
const madeRequests: string[] = [];
const ctx = () => ({ actorId: sellerId });

interface Call {
  method: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let nextMessageId = 100;
type Answer = { status: number; json: unknown } | 'throw-timeout' | 'throw-refused';
let override: (method: string, body: Record<string, unknown>) => Answer | undefined = () => undefined;

function defaultAnswer(method: string): { status: number; json: unknown } {
  const ok = (result: unknown) => ({ status: 200, json: { ok: true, result } });
  switch (method) {
    case 'getChat':
      return ok({ id: Number(CHAT), title: 'GSR narx', type: 'channel' });
    case 'getChatAdministrators':
      return ok([
        { status: 'creator', user: { id: TG.admin, is_bot: false, first_name: 'Owner' } },
        {
          status: 'administrator',
          user: { id: BOT_ID, is_bot: true, first_name: 'GSR bot' },
          can_post_messages: true,
          can_edit_messages: true,
          can_invite_users: true,
          can_restrict_members: true,
        },
      ]);
    case 'getChatMemberCount':
      return ok(2);
    case 'sendMediaGroup':
      return ok([{ message_id: (nextMessageId += 1) }]);
    case 'sendMessage':
    case 'sendPhoto':
      return ok({ message_id: (nextMessageId += 1) });
    case 'createChatInviteLink':
      return ok({ invite_link: 'https://t.me/+joinrequest' });
    case 'exportChatInviteLink':
      return ok('https://t.me/+primary');
    default:
      return ok(true);
  }
}

const sends = () => calls.filter((c) => ['sendMessage', 'sendPhoto', 'sendMediaGroup'].includes(c.method));
const channelSends = () => sends().filter((c) => String(c.body.chat_id) === CHAT);
const textOf = (c: Call) => String(c.body.text ?? c.body.caption ?? '');

async function postFor(requestId: string) {
  return db.query.priceChannelPosts.findFirst({ where: eq(priceChannelPosts.requestId, requestId) });
}

async function setConnected(on: boolean): Promise<void> {
  await db
    .update(priceChannelChats)
    .set(
      on
        ? { connectedAt: sql`now() - interval '1 minute'`, connectedByUserId: adminId, username: null, vettedAt: new Date() }
        : { connectedAt: null, connectedByUserId: null },
    )
    .where(eq(priceChannelChats.chatId, BigInt(CHAT)));
  __resetVetMemo();
}

async function drain() {
  return drainPriceChannel(new Date());
}

async function makeUser(name: string, role: string | null, tgId: number | null, phoneTail: string) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}${phoneTail}`, fullName: name, passwordHash: 'x' })
    .returning();
  if (role) {
    const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
    await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  }
  if (tgId !== null) {
    await db.insert(telegramLinks).values({
      userId: u!.id,
      telegramChatId: BigInt(tgId),
      status: 'linked',
      linkedAt: new Date(),
    });
  }
  return u!.id;
}

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
    const answer = override(method, body) ?? defaultAnswer(method);
    if (answer === 'throw-timeout') throw new DOMException('timeout', 'TimeoutError');
    if (answer === 'throw-refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return new Response(JSON.stringify(answer.json), { status: answer.status });
  });

  adminId = await makeUser(`Kanal Admin ${SUFFIX}`, 'admin', TG.admin, '01');
  press.actorId = adminId;
  sellerId = await makeUser(`Sotuvchi Bekmurod ${SUFFIX}`, 'sales_manager', TG.seller, '02');
  colleagueId = await makeUser(`Hamkasb Dilnoza ${SUFFIX}`, 'sales_manager', TG.colleague, '03');
  colleague2Id = await makeUser(`Hamkasb Jasur ${SUFFIX}`, 'sales_manager', TG.colleague2, '04');
  colleague3Id = await makeUser(`Hamkasb Kamola ${SUFFIX}`, 'sales_manager', TG.colleague3, '05');

  const leadStage = await db.execute<{ id: string }>(
    sql`SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  const [lead] = await db
    .insert(leads)
    .values({
      name: `Ali Valiyev ${SUFFIX}`,
      phone: '+998 90 123 45 67',
      company: 'Valiyev Savdo',
      stageId: leadStage[0]!.id,
      createdBy: sellerId,
    })
    .returning();
  leadId = lead!.id;

  const [note] = await db
    .insert(crmActivities)
    .values({ entityType: 'lead', entityId: leadId, kind: 'note', note: 'GS777 Ali +998901234567 materiallar', createdBy: sellerId })
    .returning();
  noteId = note!.id;
  // A tiny JPEG header is enough: the fake transport never decodes it.
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  await getStorage().put(photoKey, bytes, 'image/jpeg');
  await db.insert(attachments).values({
    entityType: 'crm_activity',
    entityId: noteId,
    kind: 'photo',
    storageKey: photoKey,
    fileName: 'kurtka.jpg',
    contentType: 'image/jpeg',
    sizeBytes: bytes.length,
    uploadedBy: sellerId,
  });

  const [manual] = await db
    .insert(clients)
    .values({ clientCode: MANUAL_CODE, name: `Boshqa mijoz ${SUFFIX}` })
    .returning({ id: clients.id });
  manualClientId = manual!.id;
  const [lookalike] = await db
    .insert(clients)
    .values({ clientCode: LOOKALIKE_CODE, name: `Uchinchi mijoz ${SUFFIX}` })
    .returning({ id: clients.id });
  lookalikeClientId = lookalike!.id;

  const taken = new Set(
    (await db.select({ code: clients.clientCode }).from(clients).where(sql`char_length(${clients.clientCode}) = 2`)).map(
      (r) => r.code,
    ),
  );
  ownShortCode = [...'QZJWVU'].flatMap((l) => [...'987654321'].map((d) => `${l}${d}`)).find((c) => !taken.has(c))!;
  const [own] = await db
    .insert(clients)
    .values({ clientCode: ownShortCode, name: `Egasi ${SUFFIX}` })
    .returning({ id: clients.id });
  ownShortClientId = own!.id;
  const [ownLead] = await db
    .insert(leads)
    .values({
      name: `Ali Valiyev ${SUFFIX}`,
      phone: '+998 90 123 45 67',
      company: 'Valiyev Savdo',
      stageId: leadStage[0]!.id,
      clientId: ownShortClientId,
      createdBy: sellerId,
    })
    .returning();
  ownLeadId = ownLead!.id;

  const [wh] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: wh!.id, clientId: manualClientId, unclaimedMarking: MARKING, createdBy: sellerId })
    .returning({ id: receipts.id });
  markingReceiptId = receipt!.id;

  await db.insert(priceChannelChats).values({
    chatId: BigInt(CHAT),
    title: 'GSR narx',
    status: 'administrator',
    rights: {
      can_post_messages: true,
      can_edit_messages: true,
      can_invite_users: true,
      can_restrict_members: true,
    },
    addedByUserId: adminId,
  });
  await setConnected(true);
});

afterEach(async () => {
  override = () => undefined;
  seam.buildThrows = false;
  seam.beforeThrow = null;
  calls = [];
  // Nothing this file queued may wait for the NEXT test's drain.
  if (madeRequests.length > 0) {
    await db
      .update(priceChannelPosts)
      .set({ status: 'skipped', skipReason: 'stale' })
      .where(and(inArray(priceChannelPosts.requestId, madeRequests), inArray(priceChannelPosts.status, ['pending', 'sending'])));
  }
});

afterAll(async () => {
  __setTelegramTransport(null);
  if (tokenBefore === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = tokenBefore;
  if (madeRequests.length > 0) {
    await db.delete(priceChannelPosts).where(inArray(priceChannelPosts.requestId, madeRequests));
  }
  await db.delete(priceChannelChats).where(inArray(priceChannelChats.chatId, [BigInt(CHAT), BigInt(CHAT_A), BigInt(CHAT_ADOPT)]));
  const fixtureUsers = [adminId, sellerId, colleagueId, colleague2Id, colleague3Id].filter(Boolean);
  await db.delete(priceChannelMembers).where(inArray(priceChannelMembers.userId, fixtureUsers));
  if (madeRequests.length > 0) {
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.update(calcRequests).set({ supersedesRequestId: null }).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  // The marking must not stay live: every later post carrying the word would
  // lose it (#183). Inserted bare, so nothing refers to either row.
  if (markingReceiptId) await db.delete(receipts).where(eq(receipts.id, markingReceiptId));
  if (manualClientId) await db.delete(clients).where(eq(clients.id, manualClientId));
  if (lookalikeClientId) await db.delete(clients).where(eq(clients.id, lookalikeClientId));
  if (ownLeadId) {
    await db.delete(crmActivities).where(eq(crmActivities.entityId, ownLeadId));
    await db.delete(leads).where(eq(leads.id, ownLeadId));
  }
  if (ownShortClientId) await db.delete(clients).where(eq(clients.id, ownShortClientId));
  await db.delete(attachments).where(eq(attachments.storageKey, photoKey));
  await getStorage().delete(photoKey).catch(() => {});
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, fixtureUsers));
  await db.delete(userRoles).where(inArray(userRoles.userId, fixtureUsers));
  await db.update(users).set({ active: false }).where(inArray(users.id, fixtureUsers));
  await pgClient.end();
});

interface Card {
  entityId: string;
  items: { name: string; quantity: number }[];
  noteId: string | null;
}

/** A rastamojka request on the fixture lead, with the identity in its goods and the photo on its note. */
async function openRequest(section: 'rastamojka' | 'podklyuch' = 'rastamojka', card?: Card) {
  const request = await openCalcRequest(
    {
      entityType: 'lead',
      entityId: card?.entityId ?? leadId,
      section,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: card?.items ?? [
        { name: 'GS777 Ali kurtka', quantity: 100 },
        { name: 'GS555 shim', quantity: 50 },
        { name: 'B-000099 kurtka', quantity: 10 },
        { name: `${MANUAL_CODE} shim`, quantity: 10 },
        { name: `${MARKING} sumka`, quantity: 10 },
        { name: 'YW26-000123 kepka', quantity: 10 },
        { name: `${LOOKALIKE_TYPED} kepka`, quantity: 10 },
      ],
      noteId: card ? card.noteId : noteId,
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  return request.id;
}

async function priceAll(requestId: string, section: 'rastamojka' | 'podklyuch' = 'rastamojka') {
  const code = `6201${SUFFIX}`;
  const workspace = await loadWorkspace(requestId);
  let groupId = workspace!.groups[0]?.id ?? null;
  if (!groupId) groupId = await createGroup(requestId, { label: 'Guruh', tnvedCode: code }, ctx());
  for (const item of workspace!.ungrouped) {
    await moveItemToGroup(requestId, item.seq, groupId, ctx());
  }
  const after = await loadWorkspace(requestId);
  for (const g of after!.groups) {
    for (const item of g.items) {
      await setItemBaza(requestId, item.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
    }
    await setGroupRates(
      g.id,
      { tnvedCode: code, dutyPct: 10, vatPct: 12, dutyFree: false, vatFree: false, source: 'typed' },
      ctx(),
    );
  }
  if (section === 'podklyuch') await setFreightZone(requestId, 'cn', ctx());
  await confirmAllGroups(requestId, ctx());
}

async function seal(requestId: string, opts: { discountUsd?: number; band?: number | null } = {}) {
  await sealCalc(
    requestId,
    {
      discountUsd: opts.discountUsd ?? 0,
      discountReason: opts.discountUsd ? 'doimiy mijoz' : null,
      bandOverrideMin: opts.band ?? null,
      bandOverrideReason: opts.band ? 'zichlik' : null,
    },
    ctx(),
  );
  const version = await db.query.calcVersions.findFirst({ where: eq(calcVersions.requestId, requestId) });
  return version!.id;
}

async function sealedRequest(
  opts: { discountUsd?: number; band?: number | null; section?: 'rastamojka' | 'podklyuch'; card?: Card } = {},
) {
  const requestId = await openRequest(opts.section, opts.card);
  await priceAll(requestId, opts.section);
  const versionId = await seal(requestId, opts);
  return { requestId, versionId };
}

describe('I1 — one row per price, whatever calls it', () => {
  it('a seal queues exactly one pending row, and a burst of claims still leaves one', async () => {
    const { requestId, versionId } = await sealedRequest();
    const rows = await db.select().from(priceChannelPosts).where(eq(priceChannelPosts.requestId, requestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', kind: 'seal', dedupeKey: `seal:${versionId}` });
    await Promise.all([
      ...Array.from({ length: 5 }, () => queuePriceChannelPost({ kind: 'seal', requestId, versionId })),
      queueMissedPrices(),
    ]);
    expect(await db.select().from(priceChannelPosts).where(eq(priceChannelPosts.requestId, requestId))).toHaveLength(1);
  });
});

describe('I2 — F3 a: a discounted or band-overridden seal is not posted, and no channel means no post', () => {
  it('skips with the reason and the drain sends nothing for it', async () => {
    const discounted = await sealedRequest({ discountUsd: 1 });
    expect(await postFor(discounted.requestId)).toMatchObject({ status: 'skipped', skipReason: 'discount' });

    const banded = await openRequest('podklyuch');
    await priceAll(banded, 'podklyuch');
    await seal(banded, { band: 201 });
    expect(await postFor(banded)).toMatchObject({ status: 'skipped', skipReason: 'band_override' });

    await setConnected(false);
    try {
      const none = await sealedRequest();
      expect(await postFor(none.requestId)).toMatchObject({ status: 'skipped', skipReason: 'no_channel' });
    } finally {
      await setConnected(true);
    }
    await drain();
    expect(channelSends()).toHaveLength(0);
  });
});

describe('I3 — the post itself', () => {
  it('goes to the connected channel, protected, with the photo, and with no client identity', async () => {
    const { requestId } = await sealedRequest();
    const run = await drain();
    expect(run.sent).toBe(1);
    const sent = channelSends();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('sendPhoto');
    expect(sent[0]!.body.protect_content).toBe('true');
    const caption = textOf(sent[0]!);
    expect(caption).toContain('RASTAMOJKA');
    expect(caption).toContain(`Sotuvchi Bekmurod ${SUFFIX}`);
    expect(caption).toContain('kurtka');
    expect(caption).toContain('shim');
    expect(caption).toContain('sumka');
    expect(caption).toContain('kepka');
    expect(caption).not.toContain('GS777');
    expect(caption).not.toContain('GS555');
    // F4 a: codes the card does not know — a deal, the book's manual code, an
    // unclaimed marking, a box.
    expect(caption).not.toContain('B-000099');
    expect(caption).not.toContain(MANUAL_CODE);
    expect(caption).not.toContain(MARKING);
    expect(caption).not.toContain('YW26');
    // …and the book's code typed with Cyrillic look-alikes, in neither spelling.
    expect(caption).not.toContain(LOOKALIKE_TYPED);
    expect(caption).not.toContain(LOOKALIKE_CODE);
    expect(caption).not.toMatch(/\bAli\b/);
    expect(caption).not.toContain('Valiyev');
    expect(caption).not.toMatch(/\d{7}/);
    const row = await postFor(requestId);
    expect(row).toMatchObject({ status: 'sent', carrier: 'caption', photoCount: 1 });
    expect(row!.messageId).toBe(nextMessageId);
  });
});

describe('I3b — the card’s OWN code, which only the card knows', () => {
  it('a two-character client code of the card goes whole, lot form included, and leaves no debris', async () => {
    const { requestId } = await sealedRequest({
      card: {
        entityId: ownLeadId,
        noteId: null,
        items: [
          { name: `${ownShortCode} kurtka`, quantity: 10 },
          { name: `${ownShortCode}-B shim`, quantity: 10 },
        ],
      },
    });
    await drain();
    const sent = channelSends();
    expect(sent).toHaveLength(1);
    const caption = textOf(sent[0]!);
    expect(caption).not.toMatch(new RegExp(`(?<![\\p{L}\\p{N}])${ownShortCode}(?![\\p{L}\\p{N}])`, 'u'));
    expect(caption.split('\n')).toContain('📦 kurtka, shim');
    expect(await postFor(requestId)).toMatchObject({ status: 'sent' });
  });
});

describe('I4 — a «Готово» answer', () => {
  it('posts the amount by hand-given, and neither note', async () => {
    const requestId = await openRequest();
    await finishCalcRequest(
      requestId,
      { amountText: '1200', currency: 'USD', note: `SELLER-NOTE-${SUFFIX}`, internalNote: `INTERNAL-${SUFFIX}` },
      { actorId: adminId },
    );
    const row = await postFor(requestId);
    expect(row).toMatchObject({ kind: 'answer', status: 'pending', dedupeKey: `answer:${requestId}` });
    await drain();
    const text = textOf(channelSends()[0]!);
    expect(text).toContain('qo‘lda berilgan');
    expect(text).toContain('1 200.00');
    expect(text).not.toContain('SELLER-NOTE');
    expect(text).not.toContain('INTERNAL');
  });
});

describe('I5 — refusals keep the queue, and nothing is ever posted twice by the machine', () => {
  it('429 → back to pending with its wait, attempts unchanged, and the run stops', async () => {
    const a = await sealedRequest();
    await sealedRequest();
    override = (method) => (method === 'sendPhoto' ? { status: 429, json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } } } : undefined);
    await drain();
    expect(channelSends()).toHaveLength(1);
    const row = await postFor(a.requestId);
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);
    expect(row!.notBefore!.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it('403 → pending with the refusal written down', async () => {
    const a = await sealedRequest();
    override = (method) => (method === 'sendPhoto' ? { status: 403, json: { ok: false, description: 'Forbidden: bot is not a member of the channel chat' } } : undefined);
    await drain();
    const row = await postFor(a.requestId);
    expect(row!.status).toBe('pending');
    expect(row!.lastError).toContain('not a member');
  });

  it('no token → nothing called, nothing touched', async () => {
    const a = await sealedRequest();
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const run = await drain();
      expect(run.paused).toBe('no_bot');
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    }
    expect(calls).toHaveLength(0);
    expect(await postFor(a.requestId)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('a timeout is ambiguous: ONE send across two runs, then failed', async () => {
    const a = await sealedRequest();
    override = (method) => (method === 'sendPhoto' ? 'throw-timeout' : undefined);
    await drain();
    await db.update(priceChannelPosts).set({ notBefore: null }).where(eq(priceChannelPosts.requestId, a.requestId));
    await drain();
    expect(channelSends()).toHaveLength(1);
    expect(await postFor(a.requestId)).toMatchObject({ status: 'failed', lastError: 'ambiguous_send' });
  });

  it('a refused connect left nothing in Telegram: retried a minute later', async () => {
    const a = await sealedRequest();
    override = (method) => (method === 'sendPhoto' ? 'throw-refused' : undefined);
    await drain();
    const row = await postFor(a.requestId);
    expect(row!.status).toBe('pending');
    expect(row!.notBefore!.getTime()).toBeGreaterThan(Date.now() + 40_000);
  });

  it('a row that waited 25 hours is stale and never sent', async () => {
    const a = await sealedRequest();
    await db
      .update(priceChannelPosts)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(priceChannelPosts.requestId, a.requestId));
    await drain();
    expect(channelSends()).toHaveLength(0);
    expect(await postFor(a.requestId)).toMatchObject({ status: 'skipped', skipReason: 'stale' });
  });

  it('a seal whose correction already started is stale — the correction posts instead', async () => {
    const a = await sealedRequest();
    const child = await recalcFromSealed(a.requestId, ctx());
    madeRequests.push(child);
    await drain();
    expect(channelSends()).toHaveLength(0);
    expect(await postFor(a.requestId)).toMatchObject({ status: 'skipped', skipReason: 'stale' });
  });
});

describe('I6 — a correction edits the old post, derived from how the correction ended', () => {
  it('open → «qayta hisoblanmoqda», sealed → «yangi narx berildi» with the reply under it, then nothing', async () => {
    const v1 = await sealedRequest();
    override = (method) => (method === 'sendPhoto' ? { status: 200, json: { ok: true, result: { message_id: 77 } } } : undefined);
    await drain();
    override = () => undefined;
    expect((await postFor(v1.requestId))!.messageId).toBe(77);

    const child = await recalcFromSealed(v1.requestId, ctx());
    madeRequests.push(child);
    calls = [];
    await reconcilePriceChannelMarks();
    const edit = calls.find((c) => c.method === 'editMessageCaption');
    expect(edit?.body.message_id).toBe(77);
    expect(String(edit?.body.caption)).toContain('QAYTA HISOBLANMOQDA');
    expect((await postFor(v1.requestId))!.markedState).toBe('open');

    await priceAll(child);
    await seal(child);
    calls = [];
    await drain();
    const reply = channelSends()[0]!;
    expect(reply.method).toBe('sendMessage');
    expect((reply.body.reply_parameters as { message_id: number }).message_id).toBe(77);
    expect(textOf(reply)).toContain('o‘rniga');

    calls = [];
    await reconcilePriceChannelMarks();
    const second = calls.find((c) => c.method === 'editMessageCaption');
    expect(String(second?.body.caption)).toContain('yangi narx berildi');
    expect((await postFor(v1.requestId))!.markedState).toBe('sealed');

    calls = [];
    await reconcilePriceChannelMarks();
    expect(calls.filter((c) => c.method.startsWith('edit'))).toHaveLength(0);
  });

  it('a correction handed back → «qaytarildi»', async () => {
    const v1 = await sealedRequest();
    await drain();
    const child = await recalcFromSealed(v1.requestId, ctx());
    madeRequests.push(child);
    await reconcilePriceChannelMarks();
    await returnCalcRequest(child, 'ma’lumot yetmaydi', { actorId: adminId });
    calls = [];
    await reconcilePriceChannelMarks();
    const edit = calls.find((c) => c.method === 'editMessageCaption');
    expect(String(edit?.body.caption)).toContain('qaytarildi');
    expect((await postFor(v1.requestId))!.markedState).toBe('returned');
  });

  it('a correction sealed WITH a discount is not posted, and the old post never promises it', async () => {
    const v1 = await sealedRequest();
    await drain();
    const child = await recalcFromSealed(v1.requestId, ctx());
    madeRequests.push(child);
    await priceAll(child);
    await seal(child, { discountUsd: 1 });
    expect(await postFor(child)).toMatchObject({ status: 'skipped', skipReason: 'discount' });
    calls = [];
    await drain();
    expect(channelSends()).toHaveLength(0);
    await reconcilePriceChannelMarks();
    const edit = calls.find((c) => c.method === 'editMessageCaption');
    expect(String(edit?.body.caption)).toContain('qayta hisoblandi');
    expect(String(edit?.body.caption)).not.toContain('yangi narx berildi');
  });
});

describe('I7 — a row stuck in «sending» is never re-sent by the machine', () => {
  it('turns failed/stuck_sending with no transport call', async () => {
    const a = await sealedRequest();
    await db
      .update(priceChannelPosts)
      .set({ status: 'sending', claimedAt: sql`now() - interval '11 minutes'` })
      .where(eq(priceChannelPosts.requestId, a.requestId));
    await drain();
    expect(channelSends()).toHaveLength(0);
    expect(await postFor(a.requestId)).toMatchObject({ status: 'failed', lastError: 'stuck_sending' });
  });
});

describe('I8 — membership (F8 a)', () => {
  it('approves a colleague, declines a stranger and tells them', async () => {
    expect(await answerJoinRequest({ chat: { id: Number(CHAT) }, from: { id: TG.colleague }, user_chat_id: TG.colleague, date: nowSec() })).toBe('approved');
    expect(calls.some((c) => c.method === 'approveChatJoinRequest')).toBe(true);
    const row = await db.query.priceChannelMembers.findFirst({
      where: and(eq(priceChannelMembers.chatId, BigInt(CHAT)), eq(priceChannelMembers.tgUserId, BigInt(TG.colleague))),
    });
    expect(row).toMatchObject({ userId: colleagueId, removedAt: null });

    calls = [];
    expect(await answerJoinRequest({ chat: { id: Number(CHAT) }, from: { id: TG.stranger }, user_chat_id: TG.stranger, date: nowSec() })).toBe('declined');
    expect(calls.some((c) => c.method === 'declineChatJoinRequest')).toBe(true);
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(TG.stranger))).toBe(true);
  });

  // Q5 a (judge TG-9): the bot keeps its backlog now, so a join request can be
  // handled minutes late — and Telegram lets a bot write to a requester only
  // for five minutes, and only until the request is processed.
  it('I11a a fresh stranger is TOLD before the decline (after it, user_chat_id is dead)', async () => {
    expect(await answerJoinRequest({ chat: { id: Number(CHAT) }, from: { id: TG.stranger }, user_chat_id: TG.stranger, date: nowSec() })).toBe('declined');
    const told = calls.findIndex((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(TG.stranger));
    const declined = calls.findIndex((c) => c.method === 'declineChatJoinRequest');
    expect(told, 'the decline sentence').toBeGreaterThan(-1);
    expect(declined, 'the decline').toBeGreaterThan(-1);
    expect(told).toBeLessThan(declined);
  });

  it('I11b a stranger who asked ten minutes ago is declined in silence — the window has closed', async () => {
    expect(await answerJoinRequest({ chat: { id: Number(CHAT) }, from: { id: TG.stranger }, user_chat_id: TG.stranger, date: nowSec() - 600 })).toBe('declined');
    expect(calls.some((c) => c.method === 'declineChatJoinRequest')).toBe(true);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('I11c a late decline Telegram refuses (somebody processed it) is «ignored», with nothing said', async () => {
    override = (method) =>
      method === 'declineChatJoinRequest'
        ? { status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: HIDE_REQUESTER_MISSING' } }
        : undefined;
    expect(await answerJoinRequest({ chat: { id: Number(CHAT) }, from: { id: TG.stranger }, user_chat_id: TG.stranger, date: nowSec() - 600 })).toBe('ignored');
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('member updates: a stranger is removed (ban, then unban), a colleague admitted once, an admin left alone', async () => {
    const update = (id: number, status: string, isBot = false) => ({
      chat: { id: Number(CHAT) },
      old_chat_member: { status: 'left', user: { id, is_bot: isBot } },
      new_chat_member: { status, user: { id, is_bot: isBot } },
    });
    expect(await answerMemberUpdate(update(TG.stranger, 'member'))).toBe('evicted');
    expect(calls.map((c) => c.method)).toEqual(['banChatMember', 'unbanChatMember']);
    expect(calls[1]!.body.only_if_banned).toBe(true);
    expect(await db.query.priceChannelMembers.findFirst({ where: eq(priceChannelMembers.tgUserId, BigInt(TG.stranger)) })).toBeUndefined();

    calls = [];
    expect(await answerMemberUpdate(update(TG.colleague, 'member'))).toBe('admitted');
    const live = await db.select().from(priceChannelMembers).where(eq(priceChannelMembers.tgUserId, BigInt(TG.colleague)));
    expect(live).toHaveLength(1);
    expect(await answerMemberUpdate(update(TG.stranger, 'administrator'))).toBe('ignored');
    expect(calls).toHaveLength(0);
  });

  it('a deactivated colleague is removed from EVERY channel the bot let them into; a relinked one too; a leaver is marked', async () => {
    await db
      .insert(priceChannelMembers)
      .values({ chatId: BigInt(CHAT_A), tgUserId: BigInt(TG.colleague), userId: colleagueId })
      .onConflictDoNothing();
    await answerJoinRequest({ chat: { id: Number(CHAT) }, from: { id: TG.colleague }, user_chat_id: TG.colleague, date: nowSec() });
    await db.update(users).set({ active: false }).where(eq(users.id, colleagueId));
    calls = [];
    await sweepPriceChannelMembers();
    const bans = calls.filter((c) => c.method === 'banChatMember' && Number(c.body.user_id) === TG.colleague);
    expect(bans.map((c) => String(c.body.chat_id)).sort()).toEqual([CHAT_A, CHAT].sort());
    const rows = await db.select().from(priceChannelMembers).where(eq(priceChannelMembers.userId, colleagueId));
    expect(rows.every((r) => r.removedAt !== null && r.removeReason === 'inactive')).toBe(true);

    await answerJoinRequest({ chat: { id: Number(CHAT) }, from: { id: TG.colleague2 }, user_chat_id: TG.colleague2, date: nowSec() });
    await db
      .update(telegramLinks)
      .set({ telegramChatId: BigInt(TG.colleague2 + 100) })
      .where(eq(telegramLinks.userId, colleague2Id));
    await sweepPriceChannelMembers();
    const moved = await db.query.priceChannelMembers.findFirst({ where: eq(priceChannelMembers.userId, colleague2Id) });
    expect(moved).toMatchObject({ removeReason: 'relinked' });

    await db
      .update(priceChannelMembers)
      .set({ removedAt: null, removeReason: null })
      .where(eq(priceChannelMembers.userId, colleague2Id));
    await answerMemberUpdate({
      chat: { id: Number(CHAT) },
      old_chat_member: { status: 'member', user: { id: TG.colleague2 } },
      new_chat_member: { status: 'left', user: { id: TG.colleague2 } },
    });
    expect(await db.query.priceChannelMembers.findFirst({ where: eq(priceChannelMembers.userId, colleague2Id) })).toMatchObject({
      removeReason: 'left',
    });
  });
});

describe('I9 — adoption, vetting, and the drain’s authority', () => {
  const myChatMember = (from: number, chatId = CHAT_ADOPT) => ({
    chat: { id: Number(chatId), type: 'channel', title: 'Yangi kanal' },
    from: { id: from },
    new_chat_member: { status: 'administrator' },
  });

  it('a settings admin adopts a private empty channel; a public or populated one is recorded and not connected; nobody else records anything', async () => {
    await setConnected(false);
    try {
      override = (method) =>
        method === 'getChat' ? { status: 200, json: { ok: true, result: { id: Number(CHAT_ADOPT), title: 'Yangi kanal', type: 'channel', username: 'gsr_public' } } } : undefined;
      expect(await recordChatMembership(myChatMember(TG.admin))).toBe('recorded');
      let row = await db.query.priceChannelChats.findFirst({ where: eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)) });
      expect(row).toMatchObject({ lastError: 'public', connectedAt: null });

      override = (method) => (method === 'getChatMemberCount' ? { status: 200, json: { ok: true, result: 7 } } : undefined);
      expect(await recordChatMembership(myChatMember(TG.admin))).toBe('recorded');
      row = await db.query.priceChannelChats.findFirst({ where: eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)) });
      expect(row!.connectedAt).toBeNull();
      expect(row!.lastError).toBe('has_members:5');

      await db.delete(priceChannelChats).where(eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)));
      expect(await recordChatMembership(myChatMember(TG.seller))).toBe('ignored');
      expect(await recordChatMembership(myChatMember(TG.stranger))).toBe('ignored');
      expect(await db.query.priceChannelChats.findFirst({ where: eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)) })).toBeUndefined();

      override = () => undefined;
      calls = [];
      expect(await recordChatMembership(myChatMember(TG.admin))).toBe('adopted');
      row = await db.query.priceChannelChats.findFirst({ where: eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)) });
      expect(row!.connectedAt).not.toBeNull();
      expect(row!.connectedByUserId).toBe(adminId);
      expect(row!.inviteLink).toBe('https://t.me/+joinrequest');
      const link = calls.find((c) => c.method === 'createChatInviteLink');
      expect(link?.body.creates_join_request).toBe(true);
      expect(calls.some((c) => c.method === 'exportChatInviteLink')).toBe(true);
      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'settings'), eq(auditLog.entityId, SETTINGS_AUDIT_ID), eq(auditLog.actorId, adminId)));
      expect(audit.some((a) => (a.after as { priceChannel?: string } | null)?.priceChannel === CHAT_ADOPT)).toBe(true);
    } finally {
      await db.update(priceChannelChats).set({ connectedAt: null, connectedByUserId: null }).where(eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)));
      await setConnected(true);
    }
  });

  it('the drain pauses on a channel that went public, and on a connector who is no longer an admin', async () => {
    const a = await sealedRequest();
    // No update says a channel went public: the drain's own re-vet hears it from getChat.
    override = (method) =>
      method === 'getChat' ? { status: 200, json: { ok: true, result: { id: Number(CHAT), title: 'GSR narx', type: 'channel', username: 'x' } } } : undefined;
    __resetVetMemo();
    expect((await drain()).paused).toBe('public');
    override = () => undefined;
    expect(channelSends()).toHaveLength(0);
    await setConnected(true);

    await db.update(users).set({ active: false }).where(eq(users.id, adminId));
    try {
      expect((await drain()).paused).toBe('connector_gone');
      expect(channelSends()).toHaveLength(0);
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, adminId));
    }
    expect(await postFor(a.requestId)).toMatchObject({ status: 'pending' });
  });
});

describe('I10 — the net under the hooks', () => {
  it('a price whose hook never ran is queued and posted by the drain; one from before the connection is not', async () => {
    const lost = await sealedRequest();
    await db.delete(priceChannelPosts).where(eq(priceChannelPosts.requestId, lost.requestId));
    await drain();
    expect(await postFor(lost.requestId)).toMatchObject({ status: 'sent' });

    const old = await sealedRequest();
    await db.delete(priceChannelPosts).where(eq(priceChannelPosts.requestId, old.requestId));
    await db
      .update(calcVersions)
      .set({ sealedAt: sql`now() - interval '2 minutes'` })
      .where(eq(calcVersions.id, old.versionId));
    await drain();
    expect(await postFor(old.requestId)).toBeUndefined();
  });

  it('a «Готово» answer whose hook never ran is queued by the net too; one from before the connection is not', async () => {
    const lost = await openRequest();
    await finishCalcRequest(lost, { amountText: '1200', currency: 'USD', note: '', internalNote: 'x' }, { actorId: adminId });
    await db.delete(priceChannelPosts).where(eq(priceChannelPosts.dedupeKey, `answer:${lost}`));
    await drain();
    expect(await postFor(lost)).toMatchObject({ kind: 'answer', status: 'sent' });

    const old = await openRequest();
    await finishCalcRequest(old, { amountText: '900', currency: 'USD', note: '', internalNote: 'x' }, { actorId: adminId });
    await db.delete(priceChannelPosts).where(eq(priceChannelPosts.dedupeKey, `answer:${old}`));
    await db
      .update(calcRequests)
      .set({ completedAt: sql`now() - interval '2 minutes'` })
      .where(eq(calcRequests.id, old));
    await drain();
    expect(await postFor(old)).toBeUndefined();
  });
});

describe('I11 — vetting what the channel became (review fixes)', () => {
  const chatRow = (chatId = CHAT) => db.query.priceChannelChats.findFirst({ where: eq(priceChannelChats.chatId, BigInt(chatId)) });

  it('a linked discussion group refuses the channel — every post would be copied to people the bot never checked', async () => {
    override = (method) =>
      method === 'getChat'
        ? { status: 200, json: { ok: true, result: { id: Number(CHAT), title: 'GSR narx', type: 'channel', linked_chat_id: -1009876543210 } } }
        : undefined;
    try {
      expect(await vetChannel(CHAT)).toEqual({ ok: false, verdict: 'has_discussion' });
      expect((await chatRow())!.lastError).toBe('has_discussion');
      expect((await drain()).paused).toBe('not_vetted');
      expect(channelSends()).toHaveLength(0);
    } finally {
      override = () => undefined;
      await db.update(priceChannelChats).set({ lastError: null }).where(eq(priceChannelChats.chatId, BigInt(CHAT)));
      await setConnected(true);
    }
  });

  it('an admitted colleague later made admin does not hide one stranger from the count', async () => {
    await db
      .insert(priceChannelMembers)
      .values({ chatId: BigInt(CHAT), tgUserId: BigInt(TG.colleague3), userId: colleague3Id })
      .onConflictDoUpdate({
        target: [priceChannelMembers.chatId, priceChannelMembers.tgUserId],
        set: { removedAt: null, removeReason: null },
      });
    const admins = (defaultAnswer('getChatAdministrators').json as { result: unknown[] }).result;
    override = (method) =>
      method === 'getChatAdministrators'
        ? { status: 200, json: { ok: true, result: [...admins, { status: 'administrator', user: { id: TG.colleague3, is_bot: false, first_name: 'Kamola' } }] } }
        : method === 'getChatMemberCount'
          ? { status: 200, json: { ok: true, result: 4 } } // owner, bot, the promoted colleague, one stranger
          : undefined;
    try {
      expect(await vetChannel(CHAT)).toEqual({ ok: false, verdict: 'has_members', detail: '1' });
    } finally {
      override = () => undefined;
      await db.delete(priceChannelMembers).where(eq(priceChannelMembers.userId, colleague3Id));
      await db.update(priceChannelChats).set({ lastError: null }).where(eq(priceChannelChats.chatId, BigInt(CHAT)));
      await setConnected(true);
    }
  });

  it('a channel the drain refused is re-checked by the drain itself, and posts again once fixed', async () => {
    const a = await sealedRequest();
    const t0 = Date.now();
    override = (method) =>
      method === 'getChat' ? { status: 200, json: { ok: true, result: { id: Number(CHAT), title: 'GSR narx', type: 'channel', username: 'gsr_public' } } } : undefined;
    try {
      expect((await drainPriceChannel(new Date(t0))).paused).toBe('public');
      override = () => undefined; // he made it private again
      // Inside the ten minutes the refusal stands (the rate limit on asking Telegram)…
      expect((await drainPriceChannel(new Date(t0 + 60_000))).paused).toBe('public');
      expect(channelSends()).toHaveLength(0);
      // …and after them the drain asks again by itself and posts.
      const run = await drainPriceChannel(new Date(t0 + 11 * 60_000));
      expect(run.paused).toBeNull();
      expect(await postFor(a.requestId)).toMatchObject({ status: 'sent' });
      expect((await chatRow())!.vettedAt).not.toBeNull();
    } finally {
      override = () => undefined;
      await setConnected(true);
    }
  });

  it('a bot removed and re-added by ANYBODY is vetted at once — a ten-minute-old «ok» never flushes the queue to new subscribers', async () => {
    await drain(); // the drain's «ok» memo
    const b = await sealedRequest();
    const update = (status: string) => ({
      chat: { id: Number(CHAT), type: 'channel', title: 'GSR narx' },
      from: { id: TG.seller },
      new_chat_member: { status },
    });
    try {
      expect(await recordChatMembership(update('left'))).toBe('updated');
      override = (method) => (method === 'getChatMemberCount' ? { status: 200, json: { ok: true, result: 7 } } : undefined);
      expect(await recordChatMembership(update('administrator'))).toBe('updated');
      calls = [];
      expect((await drain()).paused).toBe('not_vetted');
      expect(channelSends()).toHaveLength(0);
      expect(await postFor(b.requestId)).toMatchObject({ status: 'pending' });
    } finally {
      override = () => undefined;
      await db
        .update(priceChannelChats)
        .set({ status: 'administrator', lastError: null })
        .where(eq(priceChannelChats.chatId, BigInt(CHAT)));
      await setConnected(true);
    }
  });
});

describe('I12 — the drain never posts what it no longer holds (review fixes)', () => {
  it('a photo read that never answers costs the photo, not the post', async () => {
    const a = await sealedRequest();
    const storage = getStorage();
    const realGet = storage.get.bind(storage);
    storage.get = (key: string) => (key === photoKey ? new Promise<Buffer>(() => {}) : realGet(key));
    try {
      const run = await drainPriceChannel(new Date(), { photoReadMs: 50 });
      expect(run.sent).toBe(1);
    } finally {
      storage.get = realGet;
    }
    const sent = channelSends();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('sendMessage');
    expect(await postFor(a.requestId)).toMatchObject({ status: 'sent', carrier: 'text', photoCount: 0 });
  }, 5_000);

  it('a run that lost its claim during the photo read sends nothing — the price goes out ONCE', async () => {
    const a = await sealedRequest();
    const storage = getStorage();
    const realGet = storage.get.bind(storage);
    let interfered = false;
    storage.get = async (key: string) => {
      if (key === photoKey && !interfered) {
        interfered = true;
        // Meanwhile: the stuck step gave up on it, and a person pressed «Qayta yuborish».
        const [row] = await db
          .update(priceChannelPosts)
          .set({ status: 'failed', lastError: 'stuck_sending' })
          .where(eq(priceChannelPosts.requestId, a.requestId))
          .returning({ id: priceChannelPosts.id });
        expect(await retryPriceChannelPost(row!.id)).toBe(true);
      }
      return realGet(key);
    };
    try {
      await drain();
    } finally {
      storage.get = realGet;
    }
    expect(channelSends()).toHaveLength(1);
    expect(await postFor(a.requestId)).toMatchObject({ status: 'sent' });
  });

  it('a throw before the send releases the row instead of calling it «may have been sent»', async () => {
    const a = await sealedRequest();
    seam.buildThrows = true;
    await drain();
    let row = await postFor(a.requestId);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row!.lastError).toMatch(/^prepare_failed:/);
    expect(row!.notBefore!.getTime()).toBeGreaterThan(Date.now() + 40_000);
    expect(channelSends()).toHaveLength(0);

    // A throw that happens every time ends `failed` with the plain reason, never stuck_sending.
    await db.update(priceChannelPosts).set({ attempts: 4, notBefore: null }).where(eq(priceChannelPosts.requestId, a.requestId));
    await drain();
    row = await postFor(a.requestId);
    expect(row).toMatchObject({ status: 'failed', lastError: 'prepare_failed' });
  });

  it('a run that lost the row before its throw releases nothing — a «may have been sent» is never turned back into a retry', async () => {
    const a = await sealedRequest();
    seam.buildThrows = true;
    // Meanwhile the stuck step (or another run) took the row away from this one.
    seam.beforeThrow = async () => {
      await db
        .update(priceChannelPosts)
        .set({ status: 'failed', lastError: 'stuck_sending' })
        .where(eq(priceChannelPosts.requestId, a.requestId));
    };
    await drain();
    expect(await postFor(a.requestId)).toMatchObject({ status: 'failed', lastError: 'stuck_sending' });
    expect(channelSends()).toHaveLength(0);
  });

  it('«Qayta yuborish» on a failure older than a day posts it — the clock restarts at the press', async () => {
    const a = await sealedRequest();
    const [row] = await db
      .update(priceChannelPosts)
      .set({ status: 'failed', lastError: 'ambiguous_send', createdAt: sql`now() - interval '25 hours'` })
      .where(eq(priceChannelPosts.requestId, a.requestId))
      .returning({ id: priceChannelPosts.id });
    expect(await retryPriceChannelPost(row!.id)).toBe(true);
    await drain();
    expect(channelSends()).toHaveLength(1);
    expect(await postFor(a.requestId)).toMatchObject({ status: 'sent' });
  });

  it('a price queued for one channel never lands in the channel connected after it', async () => {
    const a = await sealedRequest();
    expect(await postFor(a.requestId)).toMatchObject({ status: 'pending', chatId: BigInt(CHAT) });
    await db
      .insert(priceChannelChats)
      .values({ chatId: BigInt(CHAT_ADOPT), title: 'Yangi kanal', status: 'administrator', addedByUserId: adminId })
      .onConflictDoUpdate({ target: priceChannelChats.chatId, set: { status: 'administrator' } });
    try {
      await db.update(priceChannelChats).set({ connectedAt: null, connectedByUserId: null }).where(eq(priceChannelChats.chatId, BigInt(CHAT)));
      await db
        .update(priceChannelChats)
        .set({ connectedAt: new Date(), connectedByUserId: adminId, username: null, vettedAt: new Date() })
        .where(eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)));
      __resetVetMemo();
      const run = await drain();
      expect(sends()).toHaveLength(0);
      expect(run.skipped).toBeGreaterThanOrEqual(1);
      expect(await postFor(a.requestId)).toMatchObject({ status: 'skipped', skipReason: 'channel_changed' });
    } finally {
      await db.update(priceChannelChats).set({ connectedAt: null, connectedByUserId: null }).where(eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)));
      await setConnected(true);
    }
  });
});

describe('I13 — the panel and the broom (review fixes)', () => {
  it('a recorded channel the bot was removed from is no longer offered under «Boshqa kanallar»', async () => {
    await db
      .insert(priceChannelChats)
      .values({ chatId: BigInt(CHAT_ADOPT), title: 'Yangi kanal', status: 'administrator', addedByUserId: adminId })
      .onConflictDoUpdate({ target: priceChannelChats.chatId, set: { status: 'administrator', connectedAt: null } });
    expect((await channelPanel()).others.map((c) => c.chatId)).toContain(CHAT_ADOPT);
    await db.update(priceChannelChats).set({ status: 'left' }).where(eq(priceChannelChats.chatId, BigInt(CHAT_ADOPT)));
    expect((await channelPanel()).others.map((c) => c.chatId)).not.toContain(CHAT_ADOPT);
  });

  it('removals that fail for ever in dead channels never crowd a leaver of the LIVE channel out of the sweep', async () => {
    const dead = Array.from({ length: 50 }, (_, i) => BigInt(`-10077${SUFFIX}${String(i).padStart(3, '0')}`));
    // The live row goes in LAST, physically: VACUUM FULL leaves no free slot to
    // reuse and one statement appends in order, so a sweep with no ORDER BY
    // (the defect) deterministically fills its batch with the dead fifty
    // (#525 — a nondeterministic bug must be made to fail on demand).
    await db.delete(priceChannelMembers).where(eq(priceChannelMembers.userId, colleague3Id));
    await db.execute(sql`VACUUM FULL price_channel_members`);
    await db.insert(priceChannelMembers).values([
      ...dead.map((chatId) => ({ chatId, tgUserId: BigInt(TG.colleague3), userId: colleague3Id, approvedAt: sql`now() - interval '1 day'` })),
      { chatId: BigInt(CHAT), tgUserId: BigInt(TG.colleague3), userId: colleague3Id },
    ]);
    await db.update(users).set({ active: false }).where(eq(users.id, colleague3Id));
    override = (method, body) =>
      method === 'banChatMember' && String(body.chat_id) !== CHAT
        ? { status: 400, json: { ok: false, description: 'Bad Request: chat not found' } }
        : undefined;
    try {
      await sweepPriceChannelMembers();
      expect(calls.some((c) => c.method === 'banChatMember' && String(c.body.chat_id) === CHAT && Number(c.body.user_id) === TG.colleague3)).toBe(true);
      const live = await db.query.priceChannelMembers.findFirst({
        where: and(eq(priceChannelMembers.chatId, BigInt(CHAT)), eq(priceChannelMembers.tgUserId, BigInt(TG.colleague3))),
      });
      expect(live).toMatchObject({ removeReason: 'inactive' });
    } finally {
      override = () => undefined;
      await db.delete(priceChannelMembers).where(eq(priceChannelMembers.userId, colleague3Id));
    }
  });
});

describe('I14 — «Qayta tekshirish» says what the DRAIN will do (review fixes)', () => {
  const chatRow = () => db.query.priceChannelChats.findFirst({ where: eq(priceChannelChats.chatId, BigInt(CHAT)) });

  it('a clean vet over a channel whose connector is no longer an admin answers the pause, not «prices post again»', async () => {
    await setConnected(true);
    await db.update(users).set({ active: false }).where(eq(users.id, adminId));
    try {
      expect((await drain()).paused).toBe('connector_gone');
      expect(await recheckChannelAction()).toEqual({ ok: false, paused: 'connector_gone' });
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, adminId));
    }
    expect(await recheckChannelAction()).toEqual({ ok: true });
  });

  it('a missed «bot is admin again» update is healed by the press: the vet writes the status the admin list states', async () => {
    await setConnected(true);
    // The bot was removed, then made admin again while nothing was listening:
    // the row still says «left», and the drain stops before it ever vets.
    await db.update(priceChannelChats).set({ status: 'left' }).where(eq(priceChannelChats.chatId, BigInt(CHAT)));
    try {
      expect((await drain()).paused).toBe('bot_removed');
      expect(await recheckChannelAction()).toEqual({ ok: true });
      expect((await chatRow())!.status).toBe('administrator');
      expect((await drain()).paused).toBeNull();
      // …and a vet that finds the bot OFF the admin list writes that down too.
      __resetVetMemo();
      override = (method) =>
        method === 'getChatAdministrators'
          ? { status: 200, json: { ok: true, result: [{ status: 'creator', user: { id: TG.admin, is_bot: false, first_name: 'Owner' } }] } }
          : method === 'getChatMemberCount'
            ? { status: 200, json: { ok: true, result: 1 } }
            : undefined;
      expect(await recheckChannelAction()).toEqual({ ok: false, error: 'bot_not_admin' });
      expect((await chatRow())!.status).toBe('member');
      override = () => undefined;
      expect((await drain()).paused).toBe('bot_removed');
    } finally {
      override = () => undefined;
      await db
        .update(priceChannelChats)
        .set({ status: 'administrator', lastError: null })
        .where(eq(priceChannelChats.chatId, BigInt(CHAT)));
      await setConnected(true);
    }
  });
});
