import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, clients, clientTelegramLinks, settings, tgAccounts, users } from '@/modules/platform/db/schema';
import { chatLocaleFor, setChatLocale } from '@/modules/platform/telegram/cabinet-locale';
import { AGENT_SEAT_KEY } from '@/modules/platform/settings/agent-seat';
import { SETTINGS_AUDIT_ID } from '@/modules/platform/settings/service';
import { managersFor } from '@/modules/wms/client-cabinet/service';
import { readClientAiContact, SEAT_TITLE, setClientAiContact } from '@/modules/wms/agent/seat-contact';
import { AgentConfigError } from '@/modules/wms/agent/config';

/**
 * Round C's two shared reads: who a customer writes to, and what language a
 * chat speaks. Both have more than one consumer (the bot, the Mini App, the
 * pushes), which is exactly why each is one function with one test.
 */
const stamp = String(Date.now()).slice(-7);
const madeClients: string[] = [];
const madeUsers: string[] = [];

async function user(name: string, over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99890${stamp}${madeUsers.length}`, fullName: name, passwordHash: 'x', ...over })
    .returning();
  madeUsers.push(u!.id);
  return u!;
}

async function client(code: string, over: Partial<typeof clients.$inferInsert> = {}) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `${code}${stamp.slice(-4)}`, name: `Contact ${code}`, phones: [], ...over })
    .returning();
  madeClients.push(c!.id);
  return c!;
}

afterAll(async () => {
  if (madeClients.length) {
    await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, madeClients));
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  if (madeUsers.length) {
    await db.delete(tgAccounts).where(inArray(tgAccounts.managerUserId, madeUsers));
    // A user may be referenced by an audit row a service wrote; none here, so
    // the rows go (they carry no history of their own).
    await db.delete(users).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('managersFor — who the customer writes to', () => {
  it('a FRESH verified handle wins, then the typed one, then a phone link; a departed manager is nobody', async () => {
    const verified = await user('Verified Mgr', { telegramUsername: 'typed_one' });
    await db.insert(tgAccounts).values({
      managerUserId: verified.id,
      tgPhone: `+99899${stamp}1`,
      status: 'active',
      lastSeenAt: new Date(),
      tgUsername: 'real_handle',
      tgUsernameCheckedAt: new Date(),
    });
    const typed = await user('Typed Mgr', { telegramUsername: 'only_typed' });
    const phoneOnly = await user('Phone Mgr');
    const departed = await user('Gone Mgr', { active: false, telegramUsername: 'gone_one' });

    const a = await client('MA', { salesManagerId: verified.id });
    const b = await client('MB', { salesManagerId: typed.id });
    const c = await client('MC', { salesManagerId: phoneOnly.id });
    const d = await client('MD', { salesManagerId: departed.id });
    const e = await client('ME');

    const map = await managersFor([a.id, b.id, c.id, d.id, e.id], null);
    // The offer PDF's number (the owner's «standart»), never the connected
    // account's personal Telegram number.
    expect(map.get(a.id)).toEqual({
      name: 'Verified Mgr',
      phone: verified.phone,
      telegramUrl: 'https://t.me/real_handle',
    });
    expect(map.get(b.id)?.telegramUrl).toBe('https://t.me/only_typed');
    expect(map.get(c.id)?.telegramUrl).toBe(`https://t.me/+${phoneOnly.phone!.replace(/\D/g, '')}`);
    expect(map.has(d.id)).toBe(false);
    expect(map.has(e.id)).toBe(false);
  });

  it('a verified handle nobody has re-read for two hours is not trusted (round 113’s rule)', async () => {
    // A released handle can be registered by a stranger; a customer who owes
    // money must never be sent to one (judge PRIV-1).
    const m = await user('Stale Mgr', { telegramUsername: 'fallback_typed' });
    await db.insert(tgAccounts).values({
      managerUserId: m.id,
      tgPhone: `+99899${stamp}2`,
      status: 'active',
      lastSeenAt: new Date(),
      tgUsername: 'stale_handle',
      tgUsernameCheckedAt: new Date(Date.now() - 2 * 3600_000),
    });
    const k = await client('MF', { salesManagerId: m.id });
    const got = (await managersFor([k.id], null)).get(k.id)!;
    expect(got.telegramUrl).toBe('https://t.me/fallback_typed');
    expect(got.phone).toBe(m.phone);
  });

  it('what reaches a customer carries exactly three keys — no staff id (judge PRIV-13)', async () => {
    const m = await user('Shape Mgr');
    const k = await client('MG', { salesManagerId: m.id });
    expect(Object.keys((await managersFor([k.id], null)).get(k.id)!).sort()).toEqual(['name', 'phone', 'telegramUrl']);
  });

  it('asks nothing for nobody', async () => {
    expect((await managersFor([], null)).size).toBe(0);
  });
});

/**
 * Stage 1a «Hajm» (his 7 b): with «AI raqamini ko'rsatish» on, a chat no seller of ours answers is pointed at the AI
 * seat's own @handle — by the ONE per-chat predicate the broadcast asks too (J13). A chat holding a seller's code is
 * that seller's customer and never sees the seat; a chat whose only code names a leaver does.
 *
 * CONFIGURATION (#183): the seat setting, the switch, the persona and the agent's holder are snapshotted and put back
 * before the file's own cleanup deletes the people.
 */
describe('managersFor — the AI seat for a chat with no seller of its own (his 7 b)', () => {
  const KEYS = [AGENT_SEAT_KEY, 'client_ai_contact', 'agent_persona_name'];
  const before = new Map<string, unknown>();
  let holderBefore: string | null = null;
  let seatId = '';
  let accountId = '';
  const handle = `aiseat${stamp}`;
  const chat = (n: number) => BigInt(`8${stamp}${n}`);

  // `updatedBy` cleared too: the writer stamps its actor, and the file's cleanup deletes that person.
  async function put(key: string, value: unknown) {
    if (value === null) await db.delete(settings).where(eq(settings.key, key));
    else
      await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: null } });
  }

  async function link(chatId: bigint, ...clientIds: string[]) {
    for (const clientId of clientIds) {
      await db.insert(clientTelegramLinks).values({ clientId, telegramChatId: chatId, status: 'linked', linkedAt: new Date() });
    }
  }

  /** The seat, holding the agent's account, with a handle Telegram confirmed a minute ago — and the switch on. */
  async function healthy() {
    await put(AGENT_SEAT_KEY, seatId);
    await put('client_ai_contact', true);
    await put('agent_persona_name', 'Sinov');
    await db.execute(sql`UPDATE agent_config SET owner_user_id = ${seatId}::uuid WHERE id = 1`);
    await db
      .update(tgAccounts)
      .set({ tgUsername: handle, tgUsernameCheckedAt: new Date(Date.now() - 60_000) })
      .where(eq(tgAccounts.id, accountId));
  }

  beforeAll(async () => {
    for (const key of KEYS) {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
      before.set(key, row ? row.value : null);
    }
    holderBefore =
      ((await db.execute(sql`SELECT owner_user_id::text AS h FROM agent_config WHERE id = 1`)) as unknown as { h: string | null }[])[0]
        ?.h ?? null;
    const seat = await user('AI o‘rni');
    seatId = seat.id;
    const [acc] = await db
      .insert(tgAccounts)
      .values({ managerUserId: seat.id, tgPhone: `+99899${stamp}7`, status: 'active', lastSeenAt: new Date() })
      .returning({ id: tgAccounts.id });
    accountId = acc!.id;
  });

  afterAll(async () => {
    // The holder first: it names the seat, and the file's own cleanup deletes the seat.
    await db.execute(sql`UPDATE agent_config SET owner_user_id = ${holderBefore}::uuid WHERE id = 1`);
    for (const [key, value] of before) await put(key, value);
  });

  it('a chat whose one code has no seller is shown the seat: its title and name, its handle, never a phone', async () => {
    await healthy();
    const k = await client('SA');
    await link(chat(1), k.id);
    const got = (await managersFor([k.id], chat(1))).get(k.id);
    expect(got).toEqual({ name: `${SEAT_TITLE} Sinov`, phone: null, telegramUrl: `https://t.me/${handle}` });
    // What crosses to a customer is still the three keys (PRIV-13).
    expect(Object.keys(got!).sort()).toEqual(['name', 'phone', 'telegramUrl']);
  });

  it('J13 (1): a chat holding a seller’s code AND a sellerless code is the seller’s customer — never the seat', async () => {
    await healthy();
    const seller = await user('Live Seller');
    const own = await client('SB', { salesManagerId: seller.id });
    const bare = await client('SC');
    await link(chat(2), own.id, bare.id);
    const map = await managersFor([own.id, bare.id], chat(2));
    expect(map.get(own.id)?.name).toBe('Live Seller');
    // The office card answers for the bare code, as before 1a.
    expect(map.has(bare.id)).toBe(false);
  });

  it('J13 (2): a chat whose only code names a leaver — or a person who never signs in — is shown the seat', async () => {
    await healthy();
    const gone = await user('Left Seller', { active: false });
    const payroll = await user('Payroll Only', { loginEnabled: false, passwordHash: null, phone: null });
    const left = await client('SD', { salesManagerId: gone.id });
    const unpaid = await client('SE', { salesManagerId: payroll.id });
    await link(chat(3), left.id);
    await link(chat(4), unpaid.id);
    expect((await managersFor([left.id], chat(3))).get(left.id)?.telegramUrl).toBe(`https://t.me/${handle}`);
    expect((await managersFor([unpaid.id], chat(4))).get(unpaid.id)?.telegramUrl).toBe(`https://t.me/${handle}`);
  });

  it('only with the switch on, a handle confirmed within the hour, and the seat holding the account', async () => {
    const k = await client('SF');
    await link(chat(5), k.id);
    const seen = async () => (await managersFor([k.id], chat(5))).has(k.id);

    await healthy();
    expect(await seen()).toBe(true);

    await put('client_ai_contact', false);
    expect(await seen()).toBe(false);

    await healthy();
    await db
      .update(tgAccounts)
      .set({ tgUsernameCheckedAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(tgAccounts.id, accountId));
    expect(await seen()).toBe(false);

    // The agent re-pointed to a colleague whose own account is connected and freshly verified: still not the seat's
    // number, so nothing — the holder clause alone refuses it.
    await healthy();
    const other = await user('Other Holder');
    await db.insert(tgAccounts).values({
      managerUserId: other.id,
      tgPhone: `+99899${stamp}8`,
      status: 'active',
      lastSeenAt: new Date(),
      tgUsername: `other${stamp}`,
      tgUsernameCheckedAt: new Date(),
    });
    await db.execute(sql`UPDATE agent_config SET owner_user_id = ${other.id}::uuid WHERE id = 1`);
    expect(await seen()).toBe(false);

    await healthy();
    await put(AGENT_SEAT_KEY, null);
    expect(await seen()).toBe(false);
  });

  it('a caller with no chat (the forward of a customer’s words) never shows it', async () => {
    await healthy();
    const k = await client('SG');
    await link(chat(6), k.id);
    expect((await managersFor([k.id], null)).has(k.id)).toBe(false);
  });

  it('no persona name: the title alone; a stored name the shape refuses is no name', async () => {
    await healthy();
    const k = await client('SH');
    await link(chat(7), k.id);
    await put('agent_persona_name', '');
    expect((await managersFor([k.id], chat(7))).get(k.id)?.name).toBe(SEAT_TITLE);
    await put('agent_persona_name', 'Ali 2');
    expect((await managersFor([k.id], chat(7))).get(k.id)?.name).toBe(SEAT_TITLE);
  });

  it('the switch is the super_admin’s, audited', async () => {
    await put('client_ai_contact', false);
    const seller = await user('Not Admin');
    await expect(setClientAiContact({ id: seller.id, roles: ['sales_manager'] }, true, { actorId: seller.id })).rejects.toThrow(
      AgentConfigError,
    );
    expect(await readClientAiContact()).toBe(false);
    const admin = await user('Super Admin');
    // Anchored on the ledger's top before the write: an earlier run's row must not answer for this one (#1790).
    const { top } = ((await db.execute(sql`SELECT coalesce(max(id), 0)::text AS top FROM audit_log`)) as unknown as {
      top: string;
    }[])[0]!;
    await setClientAiContact({ id: admin.id, roles: ['super_admin'] }, true, { actorId: null });
    await setClientAiContact({ id: admin.id, roles: ['super_admin'] }, true, { actorId: null }); // unchanged: nothing
    expect(await readClientAiContact()).toBe(true);
    const rows = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'settings'),
          eq(auditLog.entityId, SETTINGS_AUDIT_ID),
          sql`${auditLog.id} > ${top}::bigint`,
          sql`${auditLog.after} ? 'client_ai_contact'`,
        ),
      );
    expect(rows).toEqual([{ before: { client_ai_contact: false }, after: { client_ai_contact: true } }]);
  });
});

describe('a chat’s language — one writer', () => {
  it('sets every code in the chat, and a new code reads the person’s choice', async () => {
    const chatId = BigInt(`7${stamp}33`);
    const first = await client('LA');
    const second = await client('LB');
    const elsewhere = await client('LC');
    await db.insert(clientTelegramLinks).values([
      { clientId: first.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date(Date.now() - 60_000) },
      { clientId: second.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date() },
      { clientId: elsewhere.id, telegramChatId: BigInt(`6${stamp}44`), status: 'linked', linkedAt: new Date() },
    ]);
    expect(await chatLocaleFor(chatId)).toBeNull();

    const ids = await setChatLocale(chatId, 'uz');
    expect(ids.sort()).toEqual([first.id, second.id].sort());
    const rows = await db.select().from(clients).where(inArray(clients.id, [first.id, second.id, elsewhere.id]));
    expect(rows.find((r) => r.id === first.id)?.locale).toBe('uz');
    expect(rows.find((r) => r.id === second.id)?.locale).toBe('uz');
    expect(rows.find((r) => r.id === elsewhere.id)?.locale).toBeNull();

    // A third code joins the chat with no language of its own.
    const third = await client('LD');
    await db.insert(clientTelegramLinks).values({ clientId: third.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date() });
    expect(await chatLocaleFor(chatId)).toBe('uz');
    const [t] = await db.select().from(clients).where(eq(clients.id, third.id));
    expect(t!.locale).toBeNull();
  });

  it('a chat holding nobody changes nothing', async () => {
    expect(await setChatLocale(BigInt(`5${stamp}55`), 'ru')).toEqual([]);
  });
});
