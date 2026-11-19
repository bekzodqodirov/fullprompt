import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, notInArray, sql } from 'drizzle-orm';
import { Api } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The new-client address card (0151) against a database: the tick's one
 * writer and its reader, the three doors that queue the card — exactly one
 * row, for the right person — and the drain's per-step cursor.
 *
 * The app doors are server actions: the actor they read, the request's meta,
 * the page refresh and the full form's redirect are stood in for; everything
 * behind them is the actions' own code. pg-boss is never started here.
 *
 * Ticked notes are CONFIGURATION for every other file that mints a code with
 * a linked seller (#183): each test's notes are this file's own and deleted
 * at the end, and nothing here ticks a note it did not make.
 */
const gate = vi.hoisted(() => ({ actor: null as unknown }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => ({
  ...(await original<typeof import('@/modules/platform/rbac/authorize')>()),
  getActor: async () => gate.actor,
  authorize: async () => gate.actor,
}));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'new-client-card.integration' }),
}));
vi.mock('next/cache', async (original) => ({ ...(await original<typeof import('next/cache')>()), revalidatePath: () => {} }));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  clients,
  crmActivities,
  deals,
  events,
  leads,
  notifications,
  staffGroupPosts,
  staffNotes,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import {
  NoteError,
  newClientFlags,
  newClientNotes,
  saveNote,
  setNewClientFlag,
  setNoteShared,
  type NoteCtx,
} from '@/modules/platform/notes/service';
import { createClient } from '@/modules/platform/clients/service';
import { __resetTelegramPause, sendPendingTelegram } from '@/modules/platform/notifications/service';
import { queueStaffTelegram } from '@/modules/platform/notifications/staff';
import { __setPlanApi } from '@/modules/platform/telegram/note-send';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { createClientAction, quickCreateClientAction } from '@/app/(protected)/admin/clients/actions';
import { createLead, winLead } from '@/modules/wms/crm/service';
import { resendNewClientCard, sendNewClientCard } from '@/modules/wms/client-card/address-card';

const RUN = String(Date.now()).slice(-6);
const CHAT = { seller: 8_520_000_000 + Number(RUN) * 10 + 1, presser: 8_520_000_000 + Number(RUN) * 10 + 2 };
const TAG = `NCC${RUN}`;

const people = { seller: '', presser: '', unlinked: '' };
const madeNotes: string[] = [];
const madeClients: string[] = [];
const madeLeads: string[] = [];
const parked = new Set<string>();
const savedToken = process.env.TELEGRAM_BOT_TOKEN;

const noteCtx = (canShare = true): NoteCtx => ({ actorId: people.presser, canShare, ip: null, userAgent: 'new-client-card' });
const ctx = (actorId: string) => ({ actorId, ip: null, userAgent: 'new-client-card' });
const actor = (id: string, perms: string[]) => ({
  id,
  fullName: 'x',
  roles: [],
  permissions: new Set(perms),
  roleGrants: new Map(),
  warehouseIds: [],
  warehouseScoped: false,
});

async function person(key: keyof typeof people, n: number, chat: number | null): Promise<void> {
  const [row] = await db
    .insert(users)
    .values({ phone: `+9989${n}${RUN.padStart(7, '0')}`, fullName: `${TAG} ${key}`, passwordHash: 'x', locale: 'uz' })
    .returning({ id: users.id });
  people[key] = row!.id;
  if (chat !== null) {
    await db.insert(telegramLinks).values({ userId: row!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  }
}

/** A company note, this file's own. */
async function companyNote(title: string, body: string): Promise<string> {
  const id = randomUUID();
  await saveNote({ id, title: `${title} ${RUN}`, body, shared: true }, noteCtx());
  madeNotes.push(id);
  return id;
}

async function cardRows(clientId: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.type, 'NewClientCard'), sql`${notifications.payload}->>'clientId' = ${clientId}`));
}

beforeAll(async () => {
  await person('seller', 1, CHAT.seller);
  await person('presser', 2, CHAT.presser);
  await person('unlinked', 3, null);
});

afterAll(async () => {
  __setPlanApi(null);
  __setTelegramTransport(null);
  if (parked.size) {
    await db
      .update(notifications)
      .set({ status: 'pending', claimedAt: null })
      .where(and(inArray(notifications.id, [...parked]), eq(notifications.status, 'sending')));
  }
  const ids = Object.values(people).filter(Boolean);
  await db.delete(notifications).where(inArray(notifications.userId, ids));
  if (madeNotes.length) await db.delete(staffNotes).where(inArray(staffNotes.id, madeNotes));
  const minted = await db.select({ id: clients.id }).from(clients).where(like(clients.name, `${TAG}%`));
  const clientIds = [...new Set([...madeClients, ...minted.map((c) => c.id)])];
  if (clientIds.length) {
    const dealIds = (await db.select({ id: deals.id }).from(deals).where(inArray(deals.clientId, clientIds))).map((d) => d.id);
    const entities = [...clientIds, ...dealIds, ...madeLeads];
    await db.delete(events).where(inArray(events.entityId, entities));
    await db.delete(staffGroupPosts).where(inArray(staffGroupPosts.dedupeKey, clientIds.map((id) => `client:${id}`)));
    await db.delete(deals).where(inArray(deals.clientId, clientIds));
  }
  if (madeLeads.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  if (clientIds.length) await db.update(clients).set({ active: false }).where(inArray(clients.id, clientIds));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, ids));
  // Audited actors: deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(inArray(users.id, ids));
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  await pgClient.end();
});

describe('the tick — one writer, a company note only', () => {
  it('ticks a company note, the reader carries it with the person the card goes to, and a second press writes nothing', async () => {
    const id = await companyNote('Xitoy sklad', 'Ivu · Guanchjou · Xorgos');
    await setNewClientFlag(id, true, noteCtx());
    expect((await newClientFlags(people.seller))?.has(id)).toBe(true);
    const carried = await newClientNotes(people.seller);
    expect(carried.map((one) => one.note.id)).toContain(id);
    expect(carried.find((one) => one.note.id === id)?.note.body).toBe('Ivu · Guanchjou · Xorgos');

    const audits = async () =>
      (await db.select({ after: auditLog.after }).from(auditLog).where(eq(auditLog.entityId, id))).filter(
        (row) => (row.after as Record<string, unknown> | null)?.forNewClient !== undefined,
      ).length;
    expect(await audits()).toBe(1);
    await setNewClientFlag(id, true, noteCtx());
    expect(await audits()).toBe(1);

    await setNewClientFlag(id, false, noteCtx());
    expect((await newClientFlags(people.seller))?.has(id)).toBe(false);
  });

  it('refuses a personal note in words, refuses a person who may not publish, and the database refuses it too', async () => {
    const own = randomUUID();
    await saveNote({ id: own, title: `Shaxsiy ${RUN}`, body: 'meniki', shared: false }, noteCtx());
    madeNotes.push(own);
    await expect(setNewClientFlag(own, true, noteCtx())).rejects.toMatchObject({ code: 'not_company' });
    const company = await companyNote('Ruxsat', 'x');
    await expect(setNewClientFlag(company, true, noteCtx(false))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setNewClientFlag(randomUUID(), true, noteCtx())).rejects.toBeInstanceOf(NoteError);
    // 0151's CHECK: a tick on somebody's own note cannot exist at all.
    await expect(db.execute(sql`UPDATE staff_notes SET for_new_client = true WHERE id = ${own}::uuid`)).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('moving a ticked note into somebody’s own list takes the tick with it, in the same statement, and History says so', async () => {
    const id = await companyNote('Kochadi', 'manzil');
    await setNewClientFlag(id, true, noteCtx());
    await setNoteShared(id, false, noteCtx());
    const [row] = (await db.execute(sql`SELECT user_id::text AS user_id, for_new_client FROM staff_notes WHERE id = ${id}::uuid`)) as unknown as {
      user_id: string | null;
      for_new_client: boolean;
    }[];
    expect(row!.user_id).toBe(people.presser);
    expect(row!.for_new_client).toBe(false);
    const [audit] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), sql`${auditLog.after}->>'shared' = 'false'`));
    expect(audit!.before).toMatchObject({ shared: true, forNewClient: true });
    expect(audit!.after).toMatchObject({ shared: false, forNewClient: false });
  });
});

describe('the three doors queue exactly one card, for the right person', () => {
  let noteId = '';
  beforeAll(async () => {
    noteId = await companyNote('Manzillar', `Ivu ombori ${RUN}`);
    await setNewClientFlag(noteId, true, noteCtx());
  });

  it('the «+»: the presser is the seller — one row for him, the ticked note and the marking line in it', async () => {
    gate.actor = actor(people.seller, ['crm.leads']);
    const res = await quickCreateClientAction({ name: `${TAG} tez`, phones: `+99870${RUN}1` });
    expect(res.ok).toBe(true);
    madeClients.push(res.id!);
    expect(res.addressCard).toBe('seller');
    const rows = await cardRows(res.id!);
    expect(rows.map((row) => row.userId)).toEqual([people.seller]);
    const payload = rows[0]!.payload as { text: string; card: { steps: { kind: string; text?: string }[] } };
    expect(payload.text.startsWith(`🆕 ${res.code} · ${TAG} tez — pastdagi 1 ta xabarni`)).toBe(true);
    const forwarded = payload.card.steps.map((step) => step.text ?? '').join('\n');
    expect(forwarded).toContain(`Ivu ombori ${RUN}`);
    expect(forwarded).toContain(`Markirovka / 唛头: ${res.code}`);
  });

  it('the full form: the picked seller gets it, not the admin who pressed', async () => {
    gate.actor = actor(people.presser, ['clients.manage']);
    const form = new FormData();
    form.set('clientCode', '');
    form.set('name', `${TAG} forma`);
    form.set('phones', `+99870${RUN}2`);
    form.set('salesManagerId', people.seller);
    const to = await createClientAction({}, form).then(
      () => '',
      (err: Error) => err.message,
    );
    expect(to).toMatch(/^REDIRECT:\/admin\/clients\/[0-9a-f-]{36}$/);
    const id = to.slice('REDIRECT:/admin/clients/'.length);
    madeClients.push(id);
    expect((await cardRows(id)).map((row) => row.userId)).toEqual([people.seller]);
  });

  it('a seller the bot cannot reach: the presser gets it, and the redirect says so', async () => {
    gate.actor = actor(people.presser, ['clients.manage']);
    const form = new FormData();
    form.set('clientCode', '');
    form.set('name', `${TAG} ulanmagan`);
    form.set('phones', '');
    form.set('salesManagerId', people.unlinked);
    const to = await createClientAction({}, form).then(
      () => '',
      (err: Error) => err.message,
    );
    expect(to).toMatch(/\?manzil=presser$/);
    const id = to.slice('REDIRECT:/admin/clients/'.length, to.indexOf('?'));
    madeClients.push(id);
    expect((await cardRows(id)).map((row) => row.userId)).toEqual([people.presser]);
  });

  it('nobody reachable: no row at all, and the «+» says so', async () => {
    gate.actor = actor(people.unlinked, ['crm.leads']);
    const res = await quickCreateClientAction({ name: `${TAG} hechkim`, phones: '' });
    expect(res.ok).toBe(true);
    madeClients.push(res.id!);
    expect(res.addressCard).toBe('nobody');
    expect(await cardRows(res.id!)).toEqual([]);
  });

  it('a won lead: the press that MINTS sends it once; a re-win onto the same client sends nothing', async () => {
    const lead = await createLead({ name: `${TAG} lid`, phone: `+99870${RUN}3`, ownerId: people.seller }, ctx(people.presser));
    madeLeads.push(lead.id);
    const won = await winLead(lead.id, { name: `${TAG} lid`, token: randomUUID() }, ctx(people.presser));
    madeClients.push(won.clientId);
    expect(won.minted).toBe(true);
    expect(won.addressCard).toBe('seller');
    expect((await cardRows(won.clientId)).map((row) => row.userId)).toEqual([people.seller]);

    const again = await winLead(lead.id, { token: randomUUID() }, ctx(people.presser));
    expect(again.minted).toBe(false);
    expect(again.addressCard).toBeUndefined();
    expect(await cardRows(won.clientId)).toHaveLength(1);
  });

  it('a won lead ATTACHED to an existing code sends nothing — no code was minted', async () => {
    const existing = await createClient(
      { clientCode: '', name: `${TAG} bor`, phones: [], salesManagerId: people.seller },
      ctx(people.presser),
    );
    madeClients.push(existing.id);
    const lead = await createLead({ name: `${TAG} biriktir`, ownerId: people.seller }, ctx(people.presser));
    madeLeads.push(lead.id);
    const won = await winLead(lead.id, { attachCode: existing.clientCode, token: randomUUID() }, ctx(people.presser));
    expect(won.minted).toBe(false);
    expect(won.addressCard).toBeUndefined();
    expect(await cardRows(existing.id)).toEqual([]);
  });

  it('createClient itself never sends one — the import mints the whole book through it', async () => {
    const row = await createClient(
      { clientCode: '', name: `${TAG} import`, phones: [], salesManagerId: people.seller },
      ctx(people.presser),
    );
    madeClients.push(row.id);
    expect(await cardRows(row.id)).toEqual([]);
  });

  it('the card’s own button sends it to whoever pressed, past their own mute; an unlinked presser is told', async () => {
    const id = madeClients[0]!;
    await db.update(users).set({ mutedNotificationTypes: ['NewClientCard'] }).where(eq(users.id, people.presser));
    try {
      expect(await resendNewClientCard(id, people.presser)).toBe('queued');
      const rows = (await cardRows(id)).filter((row) => row.userId === people.presser);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('pending');
      expect(await resendNewClientCard(id, people.unlinked)).toBe('no_chat');
    } finally {
      await db.update(users).set({ mutedNotificationTypes: [] }).where(eq(users.id, people.presser));
    }
  });
});

/** The drain as Telegram sees it: send.ts's transport and the card's grammy Api, both recorders. */
describe('the drain sends the card in steps, and a replay starts where it stopped', () => {
  let order: { via: string; method: string; text: string; parseMode: unknown; markup: unknown }[] = [];
  /** The n-th call through the card's Api (1-based) answers with this instead. */
  let failOn = new Map<number, { error_code: number; description: string; parameters?: { retry_after?: number } } | Error>();
  let planCall = 0;
  let seq = 700_000;

  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    __setTelegramTransport(async (url, init) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      // The bot's own name, for the footer's link — asked once, not a message.
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'gsr_card_bot' } }), { status: 200 });
      }
      order.push({ via: 'send', method, text: String(body.text ?? ''), parseMode: body.parse_mode, markup: body.reply_markup });
      return new Response(JSON.stringify({ ok: true, result: { message_id: (seq += 1) } }), { status: 200 });
    });
    const api = new Api('TEST:TOKEN');
    api.config.use(async (_prev, method, payload) => {
      const body = (payload ?? {}) as Record<string, unknown>;
      order.push({ via: 'plan', method, text: String(body.text ?? body.caption ?? ''), parseMode: body.parse_mode, markup: body.reply_markup });
      planCall += 1;
      const error = failOn.get(planCall);
      if (error instanceof Error) throw error;
      if (error) return { ok: false, ...error } as never;
      return { ok: true, result: { message_id: (seq += 1), date: 0, chat: { id: 0, type: 'private' } } } as never;
    });
    __setPlanApi(api);
  });

  beforeEach(async () => {
    order = [];
    failOn = new Map();
    planCall = 0;
    __resetTelegramPause();
    await db.delete(notifications).where(inArray(notifications.userId, Object.values(people)));
  });

  /** Only this file's rows are claimable while the drain runs. */
  async function drain(): Promise<void> {
    const others = await db
      .update(notifications)
      .set({ status: 'sending', claimedAt: new Date() })
      .where(
        and(
          eq(notifications.channel, 'telegram'),
          eq(notifications.status, 'pending'),
          notInArray(notifications.userId, Object.values(people)),
        ),
      )
      .returning({ id: notifications.id });
    for (const row of others) parked.add(row.id);
    await sendPendingTelegram().catch(() => {});
  }

  async function handMade(steps: { kind: 'text'; text: string }[]): Promise<string> {
    await queueStaffTelegram(db, {
      userIds: [people.seller],
      type: 'NewClientCard',
      text: `🆕 ${TAG} · Qo‘lda — pastdagi ${steps.length} ta xabarni belgilab mijozga forward qiling`,
      extra: { clientId: randomUUID(), card: { steps, done: 0, head: null, ids: [], maybe: [] } },
    });
    const [row] = await db.select().from(notifications).where(eq(notifications.userId, people.seller));
    return row!.id;
  }

  async function cursorOf(id: string) {
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    return { status: row!.status, card: (row!.payload as { card: { done: number; ids: number[]; maybe: number[] } }).card };
  }

  it('the staff line FIRST through the staff sender, then the forwardable part bare — and the row remembers both', async () => {
    const id = madeClients[0]!;
    expect(await sendNewClientCard(id, people.seller)).toBe('seller');
    await drain();
    expect(order.map((one) => `${one.via}:${one.method}`)).toEqual(['send:sendMessage', 'plan:sendMessage']);
    expect(order[0]!.text).toContain('pastdagi 1 ta xabarni');
    expect(order[0]!.parseMode).toBe('HTML');
    // The customer's message: no HTML mode, no keyboard — forwarded as it stands.
    expect(order[1]!.text).toContain('Markirovka / 唛头:');
    // The generic link, built from the bot's own name — no code in it.
    expect(order[1]!.text).toContain('https://t.me/gsr_card_bot?start=mijoz');
    expect(order[1]!.parseMode).toBeUndefined();
    expect(order[1]!.markup).toBeUndefined();
    const [row] = await cardRows(id);
    expect(row!.status).toBe('sent');
    const stored = row!.payload as { card: { done: number; head: number; ids: number[] }; tg: { messageId: number } };
    expect(stored.card).toMatchObject({ done: 2 });
    expect(stored.card.ids).toHaveLength(2);
    // The row's own message is the STAFF line — the one carrying the card's link.
    expect(stored.tg.messageId).toBe(stored.card.head);
    expect(stored.card.head).toBe(stored.card.ids[0]);
  });

  it('a 429 in the middle: the drain pauses, and the replay sends only what had not gone', async () => {
    const id = await handMade([
      { kind: 'text', text: 'A' },
      { kind: 'text', text: 'B' },
      { kind: 'text', text: 'C' },
    ]);
    // A goes; B is refused «too fast».
    failOn.set(2, { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    await drain();
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual([
      expect.stringMatching(/^send:/),
      'plan:A',
      'plan:B',
    ]);
    const paused = await cursorOf(id);
    expect(paused.status).toBe('pending');
    expect(paused.card.done).toBe(2);

    order = [];
    failOn = new Map();
    __resetTelegramPause();
    await drain();
    // Not the staff line again, not A again: B and C, in order.
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual(['plan:B', 'plan:C']);
    const done = await cursorOf(id);
    expect(done.status).toBe('sent');
    expect(done.card.done).toBe(4);
  });

  it('an answer that never came is never sent again: marked «maybe», stepped over, the rest still go', async () => {
    const id = await handMade([
      { kind: 'text', text: 'A' },
      { kind: 'text', text: 'B' },
    ]);
    failOn.set(1, new Error('The operation was aborted due to timeout'));
    await drain();
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual([expect.stringMatching(/^send:/), 'plan:A', 'plan:B']);
    const after = await cursorOf(id);
    expect(after.status).toBe('sent');
    expect(after.card).toMatchObject({ done: 3, maybe: [1] });

    // A second run has nothing left to send.
    order = [];
    await drain();
    expect(order).toEqual([]);
  });
});
