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
const gate = vi.hoisted(() => ({ actor: null as unknown, notesFail: false }));
// The card's notes read, made to throw on demand — OUR fault inside the queue
// write, which the doors must say as «failed», never as somebody's Telegram.
vi.mock('@/modules/platform/notes/service', async (original) => {
  const real = await original<typeof import('@/modules/platform/notes/service')>();
  return {
    ...real,
    newClientNotes: async (...args: Parameters<typeof real.newClientNotes>) => {
      if (gate.notesFail) throw new Error('itest: the notes read failed');
      return real.newClientNotes(...args);
    },
  };
});
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
  attachments,
  auditLog,
  clients,
  crmActivities,
  deals,
  events,
  leads,
  notifications,
  staffGroupPosts,
  staffNoteParts,
  staffNotes,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import { saveAttachment } from '@/modules/platform/files/service';
import type { NoteFile, NoteSend } from '@/modules/platform/notes/plan';
import {
  NOTE_ENTITY_TYPE,
  NoteError,
  filesForNote,
  newClientFlags,
  newClientNotes,
  saveNote,
  setNewClientFlag,
  setNoteShared,
  type NoteCtx,
} from '@/modules/platform/notes/service';
import { createClient } from '@/modules/platform/clients/service';
import { __resetTelegramPause, claimPendingTelegram, reclaimStaleTelegram, sendPendingTelegram } from '@/modules/platform/notifications/service';
import { queueStaffTelegram } from '@/modules/platform/notifications/staff';
import { __setPlanApi, sendPlan } from '@/modules/platform/telegram/note-send';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { createClientAction, quickCreateClientAction } from '@/app/(protected)/admin/clients/actions';
import { createLead, winLead } from '@/modules/wms/crm/service';
import { resendNewClientCard, sendNewClientCard } from '@/modules/wms/client-card/address-card';

const RUN = String(Date.now()).slice(-6);
const CHAT = { seller: 8_520_000_000 + Number(RUN) * 10 + 1, presser: 8_520_000_000 + Number(RUN) * 10 + 2 };
const TAG = `NCC${RUN}`;

const people = { seller: '', presser: '', unlinked: '', unlinked2: '' };
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
  await person('unlinked2', 4, null);
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
  if (madeNotes.length) {
    // A note owns bytes: its uploads go with it (the album's two photos).
    await db
      .delete(attachments)
      .where(and(eq(attachments.entityType, NOTE_ENTITY_TYPE), inArray(attachments.entityId, madeNotes)));
    await db.delete(staffNotes).where(inArray(staffNotes.id, madeNotes));
  }
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
    const lines = payload.text.split('\n');
    expect(lines[0]).toBe(`🆕 ${res.code} · ${TAG} tez`);
    expect(lines[1]).toBe('Pastdagi 1 ta xabarni belgilab mijozga forward qiling ⬇️');
    // A phone the bot can match: no warning about it.
    expect(payload.text).not.toContain('telefon yo‘q');
    // No bot token in this part of the file: the bot line is not in the card, and the seller is told.
    expect(payload.text).toContain('⚠ Bot havolasi qo‘shilmadi');
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
    const rows = await cardRows(id);
    expect(rows.map((row) => row.userId)).toEqual([people.presser]);
    // No phone on the card: the bot link can never connect this customer, and the staff line says so (CUST-1).
    expect((rows[0]!.payload as { text: string }).text).toContain(
      '⚠ Mijoz kartasida telefon yo‘q — botdagi havola uni ulay olmaydi: raqamini kartaga yozdiring (admin)',
    );
  });

  it('a seller who MUTED the card: nobody gets it — not the presser — and the redirect says why (judge R14)', async () => {
    await db.update(users).set({ mutedNotificationTypes: ['NewClientCard'] }).where(eq(users.id, people.seller));
    try {
      gate.actor = actor(people.presser, ['clients.manage']);
      const form = new FormData();
      form.set('clientCode', '');
      form.set('name', `${TAG} ochirgan`);
      form.set('phones', `+99870${RUN}4`);
      form.set('salesManagerId', people.seller);
      const to = await createClientAction({}, form).then(
        () => '',
        (err: Error) => err.message,
      );
      expect(to).toMatch(/\?manzil=muted$/);
      const id = to.slice('REDIRECT:/admin/clients/'.length, to.indexOf('?'));
      madeClients.push(id);
      expect(await cardRows(id)).toEqual([]);
    } finally {
      await db.update(users).set({ mutedNotificationTypes: [] }).where(eq(users.id, people.seller));
    }
  });

  it('our own failure is said as «failed», never blamed on anybody’s Telegram (P1-DOORS-8)', async () => {
    gate.notesFail = true;
    try {
      gate.actor = actor(people.seller, ['crm.leads']);
      const res = await quickCreateClientAction({ name: `${TAG} xato`, phones: '' });
      expect(res.ok).toBe(true);
      madeClients.push(res.id!);
      expect(res.addressCard).toBe('failed');
      expect(await cardRows(res.id!)).toEqual([]);

      gate.actor = actor(people.presser, ['clients.manage']);
      const form = new FormData();
      form.set('clientCode', '');
      form.set('name', `${TAG} xato forma`);
      form.set('phones', '');
      form.set('salesManagerId', people.seller);
      const to = await createClientAction({}, form).then(
        () => '',
        (err: Error) => err.message,
      );
      expect(to).toMatch(/\?manzil=failed$/);
      madeClients.push(to.slice('REDIRECT:/admin/clients/'.length, to.indexOf('?')));
    } finally {
      gate.notesFail = false;
    }
  });

  it('nobody reachable: no row at all, and the «+» says so', async () => {
    gate.actor = actor(people.unlinked, ['crm.leads']);
    const res = await quickCreateClientAction({ name: `${TAG} hechkim`, phones: '' });
    expect(res.ok).toBe(true);
    madeClients.push(res.id!);
    expect(res.addressCard).toBe('nobody');
    expect(await cardRows(res.id!)).toEqual([]);
  });

  it('a seller winning his OWN lead with no Telegram is told about his own Telegram — the dialog’s «self» (review W-1)', async () => {
    const lead = await createLead({ name: `${TAG} oz lid`, ownerId: people.unlinked }, ctx(people.unlinked));
    madeLeads.push(lead.id);
    const won = await winLead(lead.id, { name: `${TAG} oz lid`, token: randomUUID() }, ctx(people.unlinked));
    madeClients.push(won.clientId);
    expect(won.addressCard).toBe('nobody');
    expect(won.addressCardSelf).toBe(true);
    // An unowned advert lead mints the presser as its seller: the same.
    const advert = await createLead({ name: `${TAG} reklama lid` }, ctx(people.unlinked));
    madeLeads.push(advert.id);
    const fromAdvert = await winLead(advert.id, { token: randomUUID() }, ctx(people.unlinked));
    madeClients.push(fromAdvert.clientId);
    expect(fromAdvert).toMatchObject({ addressCard: 'nobody', addressCardSelf: true });
    expect(await cardRows(fromAdvert.clientId)).toEqual([]);
  });

  it('a colleague’s lead, both Telegrams unlinked: «unlinked», never «take it with 📨» (review W-4)', async () => {
    const lead = await createLead({ name: `${TAG} ikkalasi`, ownerId: people.unlinked }, ctx(people.unlinked2));
    madeLeads.push(lead.id);
    const won = await winLead(lead.id, { token: randomUUID() }, ctx(people.unlinked2));
    madeClients.push(won.clientId);
    expect(won).toMatchObject({ addressCard: 'unlinked', addressCardSelf: false });
    expect(await cardRows(won.clientId)).toEqual([]);

    // The full form says the same through its redirect.
    gate.actor = actor(people.unlinked2, ['clients.manage']);
    const form = new FormData();
    form.set('clientCode', '');
    form.set('name', `${TAG} ikkalasi forma`);
    form.set('phones', '');
    form.set('salesManagerId', people.unlinked);
    const to = await createClientAction({}, form).then(
      () => '',
      (err: Error) => err.message,
    );
    expect(to).toMatch(/\?manzil=unlinked$/);
    madeClients.push(to.slice('REDIRECT:/admin/clients/'.length, to.indexOf('?')));
  });

  it('a won lead: the press that MINTS sends it once; a re-win onto the same client sends nothing', async () => {
    const lead = await createLead({ name: `${TAG} lid`, phone: `+99870${RUN}3`, ownerId: people.seller }, ctx(people.presser));
    madeLeads.push(lead.id);
    const won = await winLead(lead.id, { name: `${TAG} lid`, token: randomUUID() }, ctx(people.presser));
    madeClients.push(won.clientId);
    expect(won.minted).toBe(true);
    expect(won.addressCard).toBe('seller');
    // The presser is not the seller here: the dialog speaks about the seller.
    expect(won.addressCardSelf).toBe(false);
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

  it('never for a DEACTIVATED code: refused in words, no row written (P1-DOORS-4)', async () => {
    const retired = await createClient(
      { clientCode: '', name: `${TAG} eski`, phones: [`+99870${RUN}5`], salesManagerId: people.seller },
      ctx(people.presser),
    );
    madeClients.push(retired.id);
    await db.update(clients).set({ active: false }).where(eq(clients.id, retired.id));
    expect(await resendNewClientCard(retired.id, people.presser)).toBe('inactive');
    expect(await cardRows(retired.id)).toEqual([]);
  });
});

/** The drain as Telegram sees it: send.ts's transport and the card's grammy Api, both recorders. */
describe('the drain sends the card in steps, and a replay starts where it stopped', () => {
  let order: { via: string; method: string; text: string; parseMode: unknown; markup: unknown }[] = [];
  /** The n-th call through the card's Api (1-based) answers with this instead. */
  let failOn = new Map<number, { error_code: number; description: string; parameters?: { retry_after?: number } } | Error>();
  let planCall = 0;
  let seq = 700_000;
  let planApi: Api | null = null;
  /** Run at a staff-line send whose text holds this needle — another drain's move, landing mid-run. */
  let onSend: { needle: string; run: () => Promise<void> } | null = null;
  /** Run at the n-th call through the card's Api (1-based), before it is answered. */
  let onPlanCall = new Map<number, () => Promise<void>>();

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
      if (onSend && String(body.text ?? '').includes(onSend.needle)) await onSend.run();
      return new Response(JSON.stringify({ ok: true, result: { message_id: (seq += 1) } }), { status: 200 });
    });
    planApi = new Api('TEST:TOKEN');
    planApi.config.use(async (_prev, method, payload) => {
      const body = (payload ?? {}) as Record<string, unknown>;
      order.push({ via: 'plan', method, text: String(body.text ?? body.caption ?? ''), parseMode: body.parse_mode, markup: body.reply_markup });
      planCall += 1;
      await onPlanCall.get(planCall)?.();
      const error = failOn.get(planCall);
      if (error instanceof Error) throw error;
      if (error) return { ok: false, ...error } as never;
      return { ok: true, result: { message_id: (seq += 1), date: 0, chat: { id: 0, type: 'private' } } } as never;
    });
    __setPlanApi(planApi);
  });

  beforeEach(async () => {
    order = [];
    failOn = new Map();
    planCall = 0;
    onSend = null;
    onPlanCall = new Map();
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

  async function handMade(steps: NoteSend[], done = 0, userId = people.seller): Promise<string> {
    const clientId = randomUUID();
    await queueStaffTelegram(db, {
      userIds: [userId],
      type: 'NewClientCard',
      text: `🆕 ${TAG} · Qo‘lda\nPastdagi ${steps.length} ta xabarni belgilab mijozga forward qiling ⬇️`,
      extra: { clientId, card: { steps, done, head: done > 0 ? 1 : null, ids: done > 0 ? [1] : [], maybe: [] } },
    });
    const [row] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'clientId' = ${clientId}`));
    return row!.id;
  }

  /** An ordinary staff row for the seller — anything else that could land in his chat. */
  async function plainRow(text: string, userId = people.seller): Promise<string> {
    await queueStaffTelegram(db, { userIds: [userId], type: 'InternalNote', text });
    const [row] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'text' = ${text}`));
    return row!.id;
  }

  /** A row as another drain left it: claimed, `minutes` ago. */
  async function claimedAgo(id: string, minutes: number): Promise<void> {
    await db.execute(sql`
      UPDATE notifications SET status = 'sending', claimed_at = now() - ${minutes}::int * interval '1 minute'
       WHERE id = ${id}::uuid`);
  }

  /** Only the claim's clock moved back — a run that took long, the row still this run's. */
  async function ageClaim(id: string, minutes: number): Promise<void> {
    await db.execute(sql`UPDATE notifications SET claimed_at = now() - ${minutes}::int * interval '1 minute' WHERE id = ${id}::uuid`);
  }

  async function rowOf(id: string) {
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    return row!;
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
    expect(order[0]!.text).toContain('Pastdagi 1 ta xabarni');
    // The bot's name came in time: no «Bot havolasi qo‘shilmadi» on this one.
    expect(order[0]!.text).not.toContain('Bot havolasi');
    // The first line is the code and the name alone — short enough for the drain to bold it (RG-2).
    expect(order[0]!.text.split('\n')[0]).toMatch(/^<b>🆕 .+ · .+<\/b>$/);
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

  it('a photo whose bytes are gone is NOT a «maybe»: retried, and on the LAST attempt stepped over so the rest still go (P1-DLV-2, FR1-4)', async () => {
    // A plan Api whose fetch READS the multipart body, as a real upload does:
    // the stored file is opened only then.
    let uploads = 0;
    const sent: string[] = [];
    __setPlanApi(
      new Api('TEST:TOKEN', {
        fetch: (async (url: string, init: { body?: unknown }) => {
          const method = url.slice(url.lastIndexOf('/') + 1);
          if (method === 'sendPhoto') uploads += 1;
          if (init.body && typeof init.body !== 'string') for await (const _chunk of init.body as AsyncIterable<Uint8Array>) void _chunk;
          else if (typeof init.body === 'string') sent.push(`${method}:${String((JSON.parse(init.body) as { text?: string }).text)}`);
          return new Response(JSON.stringify({ ok: true, result: { message_id: (seq += 1), date: 0, chat: { id: 0, type: 'private' } } }), {
            status: 200,
          });
        }) as never,
      }),
    );
    try {
      const id = await handMade([
        {
          kind: 'media',
          as: 'photo',
          caption: `Xitoy sklad ${RUN}\n\nMarkirovka / 唛头: GS777`,
          files: [
            {
              partId: randomUUID(),
              attachmentId: randomUUID(),
              fileName: 'sklad.jpg',
              storageKey: `staff_note/${TAG}/gone-${RUN}.jpg`,
              sizeBytes: 1000,
              sendAs: 'photo',
              telegramFileId: null,
              telegramSentAs: null,
            },
          ],
        },
        { kind: 'text', text: `Bot havolasi ${RUN}` },
      ]);
      await drain();
      const first = await cursorOf(id);
      // Telegram cannot have it — the body never completed — so the step is not stepped over.
      expect(first.status).toBe('pending');
      expect(first.card).toMatchObject({ done: 1, maybe: [] });
      const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
      expect(row!.attempts).toBe(1);
      expect(row!.error).toMatch(/^source_unreadable sklad\.jpg/);
      // Nothing after the unreadable photo went: the card's order is kept while the budget lasts.
      expect(sent).toEqual([]);

      // The bytes never come back: on the row's LAST attempt the photo is stepped over and the rest still go.
      for (let run = 0; run < 8; run += 1) {
        __resetTelegramPause();
        await drain();
      }
      const [last] = await db.select().from(notifications).where(eq(notifications.id, id));
      expect(last!.status).toBe('sent');
      expect(last!.attempts).toBe(5);
      // Said on the row, naming the file — not «maybe»: it is certainly not in the chat.
      expect(last!.error).toMatch(/^skipped step 1: source_unreadable sklad\.jpg/);
      const card = (last!.payload as { card: { done: number; maybe: number[]; skipped: number[] } }).card;
      expect(card).toMatchObject({ done: 3, maybe: [], skipped: [1] });
      // The staff line went ONCE, the photo was attempted on every run the budget allowed, and the rest went once —
      // then ONE closing staff line tells the seller the card is short (third review WORDS-5), with the card's link.
      const staffSends = order.filter((one) => one.via === 'send');
      expect(staffSends).toHaveLength(2);
      expect(staffSends[1]!.text).toContain('1 ta fayl o‘qilmadi va yuborilmadi');
      expect(staffSends[1]!.text).toContain('📨 Manzil xabarini menga yuborish');
      // The staff line's own button (its card link), whatever that row carried.
      expect(staffSends[1]!.markup).toEqual(staffSends[0]!.markup);
      expect(uploads).toBe(6);
      expect(sent).toEqual([`sendMessage:Bot havolasi ${RUN}`]);
    } finally {
      __setPlanApi(planApi);
    }
  });

  it('a card that stops part-way holds the seller’s later rows back, so nothing lands inside it (P1-DLV-4)', async () => {
    const card = await handMade([
      { kind: 'text', text: 'A' },
      { kind: 'text', text: 'B' },
    ]);
    const later = await plainRow(`Keyingi xabar ${RUN}`);
    // A goes; B is refused by Telegram (a «no», retried next run).
    failOn.set(2, { error_code: 400, description: 'Bad Request: message is too long' });
    await drain();
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual([expect.stringMatching(/^send:/), 'plan:A', 'plan:B']);
    const [held] = await db.select().from(notifications).where(eq(notifications.id, later));
    // Handed back untouched: still pending, no attempt counted, no claim left on it.
    expect(held).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null });

    order = [];
    failOn = new Map();
    planCall = 0;
    await drain();
    // The card's remainder first, then the seller's other message.
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual(['plan:B', expect.stringContaining(`send:Keyingi xabar ${RUN}`)]);
    expect((await cursorOf(card)).status).toBe('sent');
  });

  it('a card part-way in the chat is finished before an OLDER row of the same seller (P1-DLV-4)', async () => {
    const older = await plainRow(`Eski xabar ${RUN}`);
    const card = await handMade([{ kind: 'text', text: 'Qolgani' }], 1);
    await drain();
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual(['plan:Qolgani', expect.stringContaining(`send:Eski xabar ${RUN}`)]);
    expect((await cursorOf(card)).status).toBe('sent');
    const [row] = await db.select().from(notifications).where(eq(notifications.id, older));
    expect(row!.status).toBe('sent');
  });

  it('a card ANOTHER run left part-way holds the seller’s rows back in this run too — a live one included (FR1-1)', async () => {
    // A drain killed mid-card by a deploy (or one still sending it): 'sending', one step in the chat.
    const card = await handMade([{ kind: 'text', text: 'Qolgani' }], 1);
    await claimedAgo(card, 4);
    const later = await plainRow(`Prixod keldi ${RUN}`);
    await drain();
    // Nothing of his went into the middle of the card he forwards.
    expect(order).toEqual([]);
    expect(await rowOf(later)).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null });
    // Four minutes is a card a live drain may still be sending: left alone, no attempt charged.
    expect(await rowOf(card)).toMatchObject({ status: 'sending', attempts: 0 });
  });

  it('the claim itself passes a held seller’s rows by, so his backlog never fills a run’s slots and the others still go (third review DRN-3)', async () => {
    const card = await handMade([{ kind: 'text', text: 'Qolgani' }], 1);
    await claimedAgo(card, 4);
    // His backlog is the OLDEST pending (created before the other person's row).
    const backlog: string[] = [];
    for (let i = 0; i < 3; i += 1) backlog.push(await plainRow(`Navbat ${i} ${RUN}`));
    const other = await plainRow(`Boshqa odam ${RUN}`, people.presser);
    const claimed = await claimPendingTelegram(2);
    // Two slots, three older rows of the held seller: the claim spent them on somebody else.
    expect(claimed).toContain(other);
    for (const id of backlog) expect(claimed).not.toContain(id);
    // Handed back as the drain hands a row back: pending, no attempt, no claim.
    await db.update(notifications).set({ status: 'pending', claimedAt: null }).where(inArray(notifications.id, claimed));
    await drain();
    expect(order.map((one) => one.text)).toEqual([expect.stringContaining(`Boshqa odam ${RUN}`)]);
    for (const id of backlog) expect(await rowOf(id)).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null });
  });

  it('a card whose heartbeat says no holds its seller for the rest of the run (third review DRN-1)', async () => {
    // The card is claimed with this run, then its claim moves elsewhere while the row ahead is sent (another
    // drain took it — or the heartbeat's own write failed): whichever, it may be part-way in his chat, so the
    // seller's later row must not land inside it. (A card already part-way would be sent FIRST — this one is
    // fresh, so the row ahead goes before it.)
    const ahead = await plainRow(`Oldinroq ${RUN}`, people.presser);
    const card = await handMade([{ kind: 'text', text: 'B' }]);
    const later = await plainRow(`Prixod keldi ${RUN}`);
    onSend = {
      needle: `Oldinroq ${RUN}`,
      run: async () => {
        await db.execute(sql`UPDATE notifications SET attempts = attempts + 1, claimed_at = now() WHERE id = ${card}::uuid`);
      },
    };
    await drain();
    expect(order.map((one) => one.text)).toEqual([expect.stringContaining(`Oldinroq ${RUN}`)]);
    expect(await rowOf(ahead)).toMatchObject({ status: 'sent' });
    expect(await rowOf(later)).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null });
  });

  it('a dead drain’s card is put back after the card’s short window, and finished FIRST; other rows keep ten minutes (FR1-1)', async () => {
    const card = await handMade([
      { kind: 'text', text: 'A' },
      { kind: 'text', text: 'B' },
    ], 1);
    await claimedAgo(card, 6);
    const later = await plainRow(`Prixod keldi ${RUN}`);
    // Another person's row, as a dead drain left it the same minute: not a card, so not put back yet.
    const stuck = await plainRow(`Eski ${RUN}`, people.presser);
    await claimedAgo(stuck, 6);
    await drain();
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual(['plan:A', 'plan:B', expect.stringContaining(`send:Prixod keldi ${RUN}`)]);
    // The reclaim counted the dead drain's attempt.
    expect(await rowOf(card)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await rowOf(later)).toMatchObject({ status: 'sent' });
    expect(await rowOf(stuck)).toMatchObject({ status: 'sending', attempts: 0 });
  });

  it('a LIVE drain keeps its card’s heartbeat: the short window never puts back a card being sent (FR1-1)', async () => {
    // Two cards part-way, the presser's first in the run; the seller's has two steps left.
    const first = await handMade([{ kind: 'text', text: 'P' }], 1, people.presser);
    const card = await handMade([
      { kind: 'text', text: 'A' },
      { kind: 'text', text: 'B' },
    ], 1);
    // The rows ahead took long: by the time the drain reaches the seller's card its claim is six minutes old.
    onPlanCall.set(1, () => ageClaim(card, 6));
    // Reaching it, the drain moved its heartbeat — a reclaim now finds nothing — and then its first step
    // takes long too…
    onPlanCall.set(2, async () => {
      await reclaimStaleTelegram();
      await ageClaim(card, 6);
    });
    // …and the step's stamp moved it again.
    onPlanCall.set(3, () => reclaimStaleTelegram());
    await drain();
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual(['plan:P', 'plan:A', 'plan:B']);
    expect(await rowOf(card)).toMatchObject({ status: 'sent', attempts: 0 });
    expect(await rowOf(first)).toMatchObject({ status: 'sent', attempts: 0 });
  });

  it('a card the short reclaim gave to ANOTHER drain while this run sent the rows ahead is never sent from this run’s copy (FR1-1)', async () => {
    const ahead = await plainRow(`Oldinroq ${RUN}`, people.presser);
    const card = await handMade([{ kind: 'text', text: 'A' }]);
    // While the row ahead is sent, the card is reclaimed and claimed again elsewhere: its attempts moved.
    onSend = {
      needle: `Oldinroq ${RUN}`,
      run: async () => {
        await db.execute(sql`UPDATE notifications SET attempts = attempts + 1, claimed_at = now() WHERE id = ${card}::uuid`);
      },
    };
    await drain();
    expect(order.map((one) => `${one.via}:${one.text}`)).toEqual([expect.stringContaining(`Oldinroq ${RUN}`)]);
    expect(await rowOf(ahead)).toMatchObject({ status: 'sent' });
    // Untouched: the other drain's claim, its attempt, its cursor.
    const left = await rowOf(card);
    expect(left).toMatchObject({ status: 'sending', attempts: 1 });
    expect((left.payload as { card: { done: number } }).card.done).toBe(0);
  });
});

/**
 * An album of real zametka parts through the zametka sender — the card merges
 * every ticked note's files into ONE media group, and a group had neither of
 * the single photo's two repairs (review P1-DLV-3).
 */
describe('an album Telegram refuses is sent again once, as one call', () => {
  let calls: { method: string; media: { type: string; media: unknown; caption?: string }[] }[] = [];
  let answers: ({ error_code: number; description: string } | unknown[])[] = [];
  /** Ids Telegram no longer knows: a group offering one is refused before any answer is used. */
  let staleIds = new Set<string>();
  let parts: NoteFile[] = [];
  let albumNote = '';
  const api = new Api('TEST:TOKEN');
  api.config.use(async (_prev, method, payload) => {
    const body = (payload ?? {}) as { media?: { type: string; media: unknown; caption?: string }[] };
    calls.push({ method, media: body.media ?? [] });
    if ((body.media ?? []).some((m) => typeof m.media === 'string' && staleIds.has(m.media))) {
      return { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' } as never;
    }
    const answer = answers.shift();
    if (answer && !Array.isArray(answer)) return { ok: false, ...(answer as object) } as never;
    return { ok: true, result: answer ?? [] } as never;
  });

  beforeAll(async () => {
    const noteId = randomUUID();
    albumNote = noteId;
    for (const name of ['ivu.jpg', 'xorgos.jpg']) {
      await saveAttachment(
        {
          entityType: NOTE_ENTITY_TYPE,
          entityId: noteId,
          fileName: name,
          contentType: 'image/jpeg',
          body: Buffer.from(`itest album ${name}`),
          uploadedBy: people.presser,
        },
        { thumbnails: 'skip' },
      );
    }
    await saveNote({ id: noteId, title: `Albom ${RUN}`, body: 'ikki rasm', shared: true }, noteCtx());
    madeNotes.push(noteId);
    parts = await filesForNote(noteId);
    expect(parts.map((part) => part.sendAs)).toEqual(['photo', 'photo']);
  });

  beforeEach(async () => {
    calls = [];
    answers = [];
    staleIds = new Set();
    // Every case starts from parts with nothing cached, as freshly attached.
    await db
      .update(staffNoteParts)
      .set({ sendAs: 'photo', telegramFileId: null, telegramSentAs: null })
      .where(inArray(staffNoteParts.id, parts.map((part) => part.partId)));
  });

  const setPart = (i: number, fileId: string | null, sentAs: 'photo' | 'document' | null) =>
    db.update(staffNoteParts).set({ telegramFileId: fileId, telegramSentAs: sentAs }).where(eq(staffNoteParts.id, parts[i]!.partId));

  const partRows = async () =>
    db
      .select({ sendAs: staffNoteParts.sendAs, fileId: staffNoteParts.telegramFileId, sentAs: staffNoteParts.telegramSentAs })
      .from(staffNoteParts)
      .where(inArray(staffNoteParts.id, parts.map((part) => part.partId)))
      .orderBy(staffNoteParts.sortOrder);

  it('a photo-shape refusal: once more as DOCUMENTS, caption on the first — and no downgrade is persisted', async () => {
    answers = [
      { error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' },
      [
        { message_id: 1, document: { file_id: 'DOC-1' } },
        { message_id: 2, document: { file_id: 'DOC-2' } },
      ],
    ];
    const out = await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: parts, caption: 'Manzillar' }], {
      onRateLimit: 'return',
    });
    expect(out.stop).toBeNull();
    expect(out.sent).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(['sendMediaGroup', 'sendMediaGroup']);
    expect(calls[0]!.media.map((m) => m.type)).toEqual(['photo', 'photo']);
    expect(calls[1]!.media.map((m) => m.type)).toEqual(['document', 'document']);
    expect(calls[1]!.media.map((m) => m.caption ?? null)).toEqual(['Manzillar', null]);
    // The culprit is unknown, so nothing is downgraded for good — and the documents' ids are NOT
    // cached onto parts that are photos (FR1-5): a document id in a photo's cache is one nothing
    // ever offers again, and one the next documents retry would offer stale (ALB-1).
    expect(await partRows()).toEqual([
      { sendAs: 'photo', fileId: null, sentAs: null },
      { sendAs: 'photo', fileId: null, sentAs: null },
    ]);
  });

  it('from the stuck state an earlier build left (document ids on photo parts, gone stale): the retry is the BYTES (ALB-1)', async () => {
    await setPart(0, 'DOC-1', 'document');
    await setPart(1, 'DOC-2', 'document');
    staleIds = new Set(['DOC-1', 'DOC-2']);
    const stuck = await filesForNote(albumNote);
    answers = [
      { error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' },
      [
        { message_id: 5, document: { file_id: 'DOC-NEW-1' } },
        { message_id: 6, document: { file_id: 'DOC-NEW-2' } },
      ],
    ];
    const out = await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: stuck, caption: 'Manzillar' }], {
      onRateLimit: 'return',
    });
    expect(out.stop).toBeNull();
    expect(calls.map((call) => call.media.map((m) => `${m.type}:${typeof m.media === 'string' ? m.media : 'bytes'}`))).toEqual([
      ['photo:bytes', 'photo:bytes'],
      ['document:bytes', 'document:bytes'],
    ]);
  });

  it('the good members keep their PHOTO ids through a documents retry, and the next send offers them by id (FR1-5, ALB-3)', async () => {
    // Note A's photo went before and is cached; the second photo is new and tall.
    await setPart(0, 'PH-1', 'photo');
    answers = [
      { error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' },
      [
        { message_id: 7, document: { file_id: 'DOC-1' } },
        { message_id: 8, document: { file_id: 'DOC-2' } },
      ],
    ];
    const first = await filesForNote(albumNote);
    expect((await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: first, caption: null }], { onRateLimit: 'return' })).stop).toBeNull();
    expect(await partRows()).toEqual([
      { sendAs: 'photo', fileId: 'PH-1', sentAs: 'photo' },
      { sendAs: 'photo', fileId: null, sentAs: null },
    ]);
    // The next card: the good photo by its id, only the culprit's bytes uploaded.
    calls = [];
    answers = [{ error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }, []];
    await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: await filesForNote(albumNote), caption: null }], {
      onRateLimit: 'return',
    });
    expect(calls[0]!.media.map((m) => (typeof m.media === 'string' ? m.media : 'bytes'))).toEqual(['PH-1', 'bytes']);
  });

  it('the two repairs CHAIN: a stale-id resend refused for its shape goes on to documents, each repair once (ALB-2)', async () => {
    await setPart(0, 'OLD-1', 'photo');
    staleIds = new Set(['OLD-1']);
    const frozen = await filesForNote(albumNote);
    answers = [
      { error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' },
      [
        { message_id: 9, document: { file_id: 'DOC-1' } },
        { message_id: 10, document: { file_id: 'DOC-2' } },
      ],
    ];
    const out = await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: frozen, caption: 'Manzillar' }], {
      onRateLimit: 'return',
    });
    expect(out.stop).toBeNull();
    expect(calls.map((call) => call.media.map((m) => `${m.type}:${typeof m.media === 'string' ? m.media : 'bytes'}`))).toEqual([
      ['photo:OLD-1', 'photo:bytes'],
      ['photo:bytes', 'photo:bytes'],
      ['document:bytes', 'document:bytes'],
    ]);
    expect(calls[2]!.media.map((m) => m.caption ?? null)).toEqual(['Manzillar', null]);
    // The stale id was forgotten; nothing of the documents' answer is cached onto the photos.
    expect(await partRows()).toEqual([
      { sendAs: 'photo', fileId: null, sentAs: null },
      { sendAs: 'photo', fileId: null, sentAs: null },
    ]);
  });

  it('a documents retry refused again is not repaired a second time — at most three calls, the stop handed back', async () => {
    answers = [
      { error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' },
      { error_code: 400, description: 'Bad Request: file is too big' },
    ];
    const out = await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: await filesForNote(albumNote), caption: null }], {
      onRateLimit: 'return',
    });
    expect(calls).toHaveLength(2);
    expect(out.stop).toMatchObject({ index: 0, status: 400 });
  });

  it('a stale cached id: every cached id in the group forgotten, the group sent again with the bytes', async () => {
    await db.update(staffNoteParts).set({ telegramFileId: 'OLD-1', telegramSentAs: 'photo' }).where(eq(staffNoteParts.id, parts[0]!.partId));
    await db.update(staffNoteParts).set({ telegramFileId: 'OLD-2', telegramSentAs: 'photo' }).where(eq(staffNoteParts.id, parts[1]!.partId));
    const cached = await filesForNote(albumNote);
    expect(cached.map((part) => part.telegramFileId)).toEqual(['OLD-1', 'OLD-2']);
    answers = [
      { error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' },
      [
        { message_id: 3, photo: [{ file_id: 'small' }, { file_id: 'NEW-1' }] },
        { message_id: 4, photo: [{ file_id: 'small' }, { file_id: 'NEW-2' }] },
      ],
    ];
    const out = await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: cached, caption: 'Manzillar' }], {
      onRateLimit: 'return',
    });
    expect(out.stop).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(['sendMediaGroup', 'sendMediaGroup']);
    expect(calls[0]!.media.map((m) => m.media)).toEqual(['OLD-1', 'OLD-2']);
    // The resend carries the BYTES (InputFiles), never the ids Telegram forgot.
    expect(calls[1]!.media.every((m) => typeof m.media !== 'string')).toBe(true);
    expect(calls[1]!.media.map((m) => m.type)).toEqual(['photo', 'photo']);
    expect(await partRows()).toEqual([
      { sendAs: 'photo', fileId: 'NEW-1', sentAs: 'photo' },
      { sendAs: 'photo', fileId: 'NEW-2', sentAs: 'photo' },
    ]);
  });

  it('any other refusal is not retried — one call, the stop handed back', async () => {
    answers = [{ error_code: 400, description: 'Bad Request: chat not found' }];
    const out = await sendPlan(api, 42n, [{ kind: 'media', as: 'photo', files: parts, caption: null }], { onRateLimit: 'return' });
    expect(calls).toHaveLength(1);
    expect(out.stop).toMatchObject({ index: 0, status: 400 });
  });
});
