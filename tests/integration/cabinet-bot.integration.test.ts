import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Round C, the client conversation's two writes that are not words.
 *
 * (1) A customer's own message reaches a PERSON (judge CX-1/PRIV-10): before
 * this round a linked customer who typed to the bot got silence and the words
 * went nowhere. `forwardClientMessage` is the whole decision — whose chat,
 * which person, how often — and the grammy handler only calls it, so it is
 * proven here rather than through a Telegram this container cannot reach.
 *
 * (2) A code that joins a chat takes the language the PERSON chose (CX-7), on
 * both doors that attach one: the sibling sweep and the new-code auto-link.
 *
 * The notification queue is stood in for (this suite never works pg-boss
 * jobs); the rows it would drain are what is asserted.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

const { db, pgClient } = await import('@/modules/platform/db/client');
const { clients, clientTelegramLinks, notifications, permissions, rolePermissions, telegramLinks, userRoles, users } =
  await import('@/modules/platform/db/schema');
const { ACK_QUIET_MS, FORWARD_MAX_PER_WINDOW, ackDue, autoLinkClientToVerifiedChats, forwardClientMessage } = await import(
  '@/modules/platform/telegram/client-cabinet'
);
const { usersWithPermission } = await import('@/modules/platform/notifications/service');
const { linkPhoneSiblings } = await import('@/modules/wms/client-cabinet/service');

const stamp = String(Date.now()).slice(-7);
let seq = 0;
const madeClients: string[] = [];
const madeUsers: string[] = [];

async function user(name: string, over: Partial<typeof users.$inferInsert> = {}) {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${stamp}${seq}`, fullName: `${name} ${stamp}`, passwordHash: 'x', ...over })
    .returning();
  madeUsers.push(u!.id);
  return u!;
}

/**
 * A member of staff a Telegram message would REACH — a linked staff chat.
 * Without one the drain settles the row `muted` for ever, and the forward
 * rightly refuses to promise such a person to a customer.
 */
async function reachable(name: string, over: Partial<typeof users.$inferInsert> = {}) {
  const u = await user(name, over);
  seq += 1;
  await db
    .insert(telegramLinks)
    .values({ userId: u.id, telegramChatId: BigInt(`7${stamp}${String(seq).padStart(2, '0')}`), status: 'linked', linkedAt: new Date() });
  return u;
}

async function client(over: Partial<typeof clients.$inferInsert> = {}) {
  seq += 1;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `BT${stamp.slice(-4)}${seq}`, name: `Bot mijoz ${stamp}`, phones: [], ...over })
    .returning();
  madeClients.push(c!.id);
  return c!;
}

function chat(): bigint {
  seq += 1;
  return BigInt(`8${stamp}${String(seq).padStart(2, '0')}`);
}

async function link(clientId: string, chatId: bigint, at = new Date()) {
  await db.insert(clientTelegramLinks).values({ clientId, telegramChatId: chatId, status: 'linked', linkedAt: at });
}

/** The staff copies this file's customers produced — found by the run's stamp. */
async function forwarded() {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.type, 'ClientBotMessage'), sql`${notifications.payload}->>'text' LIKE ${`%${stamp}%`}`));
}

afterAll(async () => {
  // The forward is keyed by its Telegram message now (Q5 a): this file's
  // chats are `8<stamp>…`, so are its keys.
  await db.execute(sql`DELETE FROM telegram_once WHERE key LIKE ${`m:8${stamp}%`}`);
  await db
    .delete(notifications)
    .where(and(eq(notifications.type, 'ClientBotMessage'), sql`${notifications.payload}->>'text' LIKE ${`%${stamp}%`}`));
  if (madeClients.length) {
    await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, madeClients));
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  if (madeUsers.length) {
    await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
    await db.delete(users).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('a customer’s own words reach a person', () => {
  it('a text goes to the code’s manager, quoted, and the customer is told who', async () => {
    const manager = await reachable('Menejer');
    const c = await client({ salesManagerId: manager.id, name: `Alisher ${stamp}` });
    const chatId = chat();
    await link(c.id, chatId);

    const outcome = await forwardClientMessage({ chatId, messageId: 11, text: 'Yukim qachon keladi?', media: false });
    expect(outcome).toEqual({ to: 'manager', managerName: manager.fullName, locale: null });

    const rows = (await forwarded()).filter((r) => r.userId === manager.id);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.text).toContain(`💬 ${c.clientCode} (Alisher ${stamp}) botga yozdi:`);
    expect(payload.text).toContain('«Yukim qachon keladi?»');
    // A text is quoted; only a FILE asks the drain to forward the message.
    expect(payload.forwardFrom).toBeUndefined();
  });

  it('a file carries the message to forward (contract 2)', async () => {
    const manager = await reachable('Fayl menejer');
    const c = await client({ salesManagerId: manager.id });
    const chatId = chat();
    await link(c.id, chatId);

    await forwardClientMessage({ chatId, messageId: 42, text: 'quti singan', media: true });
    const [row] = (await forwarded()).filter((r) => r.userId === manager.id);
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.forwardFrom).toEqual({ chatId: Number(chatId), messageId: 42 });
    expect(payload.text).toContain('botga fayl yubordi');
    expect(payload.text).toContain('«quti singan»');
  });

  it('a long question with an emoji at the cut is quoted whole-charactered AND forwarded in full (CONV-2/7)', async () => {
    const manager = await reachable('Uzun menejer');
    const c = await client({ salesManagerId: manager.id });
    const chatId = chat();
    await link(c.id, chatId);
    // 698 letters, then an emoji whose two UTF-16 halves straddle the 699th
    // unit — where a `slice` used to cut, leaving a lone surrogate that
    // postgres's jsonb refuses (the whole message was lost with an error).
    const long = `${'a'.repeat(698)}😀${'b'.repeat(60)}`;

    const outcome = await forwardClientMessage({ chatId, messageId: 77, text: long, media: false });
    expect(outcome?.to).toBe('manager');
    const [row] = (await forwarded()).filter((r) => r.userId === manager.id);
    const payload = row!.payload as Record<string, unknown>;
    expect(String(payload.text)).toContain(`${'a'.repeat(698)}😀…»`);
    // The quote ends at «…»; the whole question travels as the message itself.
    expect(payload.forwardFrom).toEqual({ chatId: Number(chatId), messageId: 77 });
  });

  it('a contact card and a location say what they are in the staff copy', async () => {
    const manager = await reachable('Kontakt menejer');
    const c = await client({ salesManagerId: manager.id });
    const chatId = chat();
    await link(c.id, chatId);
    await forwardClientMessage({ chatId, messageId: 81, text: 'Aziz +998901112233', media: true, kind: 'contact' });
    await forwardClientMessage({ chatId, messageId: 82, text: null, media: true, kind: 'location' });
    const texts = (await forwarded()).filter((r) => r.userId === manager.id).map((r) => String((r.payload as { text: string }).text));
    expect(texts.some((t) => t.startsWith(`📇 ${c.clientCode}`) && t.includes('kontakt yubordi') && t.includes('Aziz +998901112233'))).toBe(true);
    expect(texts.some((t) => t.startsWith(`📍 ${c.clientCode}`) && t.includes('joylashuv yubordi'))).toBe(true);
  });

  it('with no manager — or one who has LEFT — it goes to the office, never to nobody', async () => {
    // An office member this file can reach: the client-book role and a linked
    // chat. The demo seed's office people have no Telegram linked, so they are
    // exactly the ones a message would be muted for.
    const [grant] = await db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(permissions.code, 'clients.manage'))
      .limit(1);
    const desk = await reachable('Ofis');
    await db.insert(userRoles).values({ userId: desk.id, roleId: grant!.roleId });
    const office = await usersWithPermission('clients.manage');
    expect(office).toContain(desk.id);
    const unlinked = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, office), sql`NOT EXISTS (SELECT 1 FROM telegram_links t WHERE t.user_id = ${users.id} AND t.status = 'linked')`));
    expect(unlinked.length, 'the seed carries an office member with no Telegram').toBeGreaterThan(0);

    const gone = await reachable('Ketgan', { active: false });
    for (const c of [await client(), await client({ salesManagerId: gone.id })]) {
      const chatId = chat();
      await link(c.id, chatId);
      const outcome = await forwardClientMessage({ chatId, messageId: 1, text: `salom ${c.clientCode}`, media: false });
      expect(outcome).toEqual({ to: 'office', locale: null });
      const got = (await forwarded())
        .filter((r) => (r.payload as { text: string }).text.includes(c.clientCode))
        .map((r) => r.userId);
      expect(got).toContain(desk.id);
      expect(got).not.toContain(gone.id);
      // Only people it would REACH, while anybody can be reached.
      for (const u of unlinked) expect(got).not.toContain(u.id);
    }
  });

  it('a manager the message would not REACH is not promised — no linked Telegram, or muting these', async () => {
    const quiet = await user('Ulanmagan');
    const muting = await reachable('Jim', { mutedNotificationTypes: ['ClientBotMessage'] });
    for (const m of [quiet, muting]) {
      const c = await client({ salesManagerId: m.id });
      const chatId = chat();
      await link(c.id, chatId);
      const outcome = await forwardClientMessage({ chatId, messageId: 1, text: 'savol', media: false });
      // «Xabaringiz menejeringizga yetkazildi: …» about a row the drain would
      // settle `muted` for ever is exactly the lie phase C's hasLinkedChat
      // exists to prevent.
      expect(outcome?.to, m.fullName).toBe('office');
      expect((await forwarded()).filter((r) => r.userId === m.id)).toHaveLength(0);
    }
  });

  it('a stranger’s chat and a STAFF chat are not the cabinet’s to forward', async () => {
    expect(await forwardClientMessage({ chatId: chat(), messageId: 1, text: 'hello', media: false })).toBeNull();

    // A chat that is both staff and client: its words are the staff bot's.
    const staff = await user('Hodim');
    const c = await client({ salesManagerId: staff.id });
    const chatId = chat();
    await link(c.id, chatId);
    await db.insert(telegramLinks).values({ userId: staff.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date() });
    expect(await forwardClientMessage({ chatId, messageId: 1, text: 'GS777', media: false })).toBeNull();
    expect((await forwarded()).filter((r) => r.userId === staff.id)).toHaveLength(0);
  });

  it('at most ten a window per chat — the eleventh is answered but not forwarded', async () => {
    const manager = await reachable('Band menejer');
    const c = await client({ salesManagerId: manager.id });
    const chatId = chat();
    await link(c.id, chatId);
    const now = new Date('2030-01-01T09:00:00Z');
    for (let i = 0; i < FORWARD_MAX_PER_WINDOW; i += 1) {
      const out = await forwardClientMessage({ chatId, messageId: i, text: `${i}`, media: false, now });
      expect(out?.to).toBe('manager');
    }
    const eleventh = await forwardClientMessage({ chatId, messageId: 99, text: 'yana', media: false, now });
    expect(eleventh).toEqual({ to: 'throttled', managerName: manager.fullName, locale: null });
    expect((await forwarded()).filter((r) => r.userId === manager.id)).toHaveLength(FORWARD_MAX_PER_WINDOW);
    // Ten minutes later the window has moved on.
    const later = await forwardClientMessage({
      chatId,
      messageId: 100,
      text: 'keyin',
      media: false,
      now: new Date(now.getTime() + 11 * 60_000),
    });
    expect(later?.to).toBe('manager');
  });
});

describe('one «yetkazildi» speaks for a conversation (CONV-8)', () => {
  const said = (to: 'manager' | 'office' | 'throttled') =>
    to === 'office' ? { to, locale: null } : { to, managerName: 'D', locale: null };

  it('the lines after an answer are not each answered; news always is', () => {
    const chatId = chat();
    const t0 = Date.UTC(2030, 5, 1, 9);
    expect(ackDue(chatId, said('manager'), null, t0)).toBe(true);
    expect(ackDue(chatId, said('manager'), null, t0 + 30_000)).toBe(false);
    expect(ackDue(chatId, said('manager'), null, t0 + 90_000)).toBe(false);
    // The limit is news: that message reached NOBODY.
    expect(ackDue(chatId, said('throttled'), null, t0 + 100_000)).toBe(true);
    expect(ackDue(chatId, said('throttled'), null, t0 + 110_000)).toBe(false);
    // A quiet pause, then a new question: answered again.
    expect(ackDue(chatId, said('throttled'), null, t0 + 110_000 + ACK_QUIET_MS)).toBe(true);
  });

  it('an album is answered once, however slowly its photos arrive', () => {
    const chatId = chat();
    const t0 = Date.UTC(2030, 5, 2, 9);
    expect(ackDue(chatId, said('manager'), 'alb-x', t0)).toBe(true);
    expect(ackDue(chatId, said('manager'), 'alb-x', t0 + 1_000)).toBe(false);
    expect(ackDue(chatId, said('manager'), 'alb-x', t0 + ACK_QUIET_MS * 3)).toBe(false);
    expect(ackDue(chatId, said('manager'), 'alb-y', t0 + ACK_QUIET_MS * 3)).toBe(true);
  });
});

describe('an album is ONE thing the customer said', () => {
  it('its photos are each forwarded but spend one slot, so the words after it still arrive', async () => {
    const manager = await reachable('Albom menejer');
    const c = await client({ salesManagerId: manager.id });
    const chatId = chat();
    await link(c.id, chatId);
    const now = new Date('2030-02-01T09:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      const out = await forwardClientMessage({ chatId, messageId: 200 + i, text: null, media: true, albumId: 'alb-1', now });
      expect(out?.to, `album photo ${i}`).toBe('manager');
    }
    for (let i = 0; i < FORWARD_MAX_PER_WINDOW - 1; i += 1) {
      const out = await forwardClientMessage({ chatId, messageId: 300 + i, text: `gap ${i}`, media: false, now });
      expect(out?.to, `text ${i}`).toBe('manager');
    }
    const rows = (await forwarded()).filter((r) => r.userId === manager.id);
    expect(rows).toHaveLength(5 + FORWARD_MAX_PER_WINDOW - 1);
    expect(
      rows.filter((r) => (r.payload as { forwardFrom?: unknown }).forwardFrom).map((r) => (r.payload as { forwardFrom: { messageId: number } }).forwardFrom.messageId).sort(),
    ).toEqual([200, 201, 202, 203, 204]);
    // The window is now full; a second album is refused whole, every photo of it.
    for (let i = 0; i < 3; i += 1) {
      const out = await forwardClientMessage({ chatId, messageId: 400 + i, text: null, media: true, albumId: 'alb-2', now });
      expect(out?.to).toBe('throttled');
    }
  });
});

describe('a code that joins a chat speaks the person’s language (CX-7)', () => {
  it('the sibling sweep copies the chat’s choice onto a NULL code, and only onto a NULL one', async () => {
    const phone = `+99893${stamp}`;
    const first = await client({ phones: [phone], locale: 'uz' });
    const silent = await client({ phones: [phone] });
    const chosen = await client({ phones: [phone], locale: 'en' });
    const chatId = chat();
    await link(first.id, chatId);

    expect(await linkPhoneSiblings(chatId)).toBe(2);
    const rows = await db.select().from(clients).where(inArray(clients.id, [silent.id, chosen.id]));
    expect(rows.find((r) => r.id === silent.id)?.locale).toBe('uz');
    // A code whose own language somebody set keeps it.
    expect(rows.find((r) => r.id === chosen.id)?.locale).toBe('en');
  });

  it('a new code auto-linked to a verified chat takes the chat’s language', async () => {
    const phone = `+99894${stamp}`;
    const actor = await user('Kod ochuvchi');
    const existing = await client({ phones: [phone], locale: 'ru' });
    const chatId = chat();
    await link(existing.id, chatId);

    const fresh = await client({ phones: [phone] });
    expect(await autoLinkClientToVerifiedChats(fresh.id, actor.id)).toBe(1);
    const [row] = await db.select().from(clients).where(eq(clients.id, fresh.id));
    expect(row!.locale).toBe('ru');
    const linked = await db
      .select()
      .from(clientTelegramLinks)
      .where(and(eq(clientTelegramLinks.clientId, fresh.id), eq(clientTelegramLinks.telegramChatId, chatId)));
    expect(linked).toHaveLength(1);
  });
});
