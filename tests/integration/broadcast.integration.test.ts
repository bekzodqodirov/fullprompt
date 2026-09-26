import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from 'grammy';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  broadcastRecipients,
  broadcasts,
  clientTelegramLinks,
  clients,
  notifications,
  receiptLots,
  receipts,
  users,
} from '@/modules/platform/db/schema';
import { audienceChats, createBroadcast, BroadcastError } from '@/modules/platform/broadcast/service';
import { runBroadcast } from '@/modules/platform/broadcast/send';
import { alertBirthdays, birthdaysOn } from '@/modules/platform/broadcast/birthdays';
import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * The owner's item 6 (2026-09-26): a message to the bot's clients from the
 * system, narrowed by the words on the client cards, and the birthday
 * reminder. The bot itself is a stand-in `Api` — this container has no
 * Telegram, and what is under test is WHO gets it and how many times.
 */
const S = `${Date.now()}`.slice(-6);
const TAG = `bcast${S}`;
let actorId = '';
const made: string[] = [];
const broadcastIds: string[] = [];
const chat = (n: number) => BigInt(`9${S}${n}`);

async function client(code: string, fields: Partial<typeof clients.$inferInsert>, chats: bigint[]) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: code, name: `${TAG} ${code}`, ...fields })
    .returning();
  made.push(c!.id);
  for (const id of chats) {
    await db.insert(clientTelegramLinks).values({ clientId: c!.id, telegramChatId: id, status: 'linked' });
  }
  return c!;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  // A: clothing, «Kiyim» typed with a capital; B: shoes; C and D share ONE
  // chat (one person, two codes); E has no chat at all.
  await client(`BA${S}`, { sector: `Kiyim${S}`, cargoKinds: [`Ko'ylak${S}`], locale: 'ru' }, [chat(1)]);
  await client(`BB${S}`, { sector: `poyabzal${S}`, cargoKinds: [`krossovka${S}`] }, [chat(2)]);
  await client(`BC${S}`, { sector: `kiyim${S}` }, [chat(3)]);
  await client(`BD${S}`, { sector: `kiyim${S}` }, [chat(3)]);
  await client(`BE${S}`, { sector: `kiyim${S}` }, []);
});

afterAll(async () => {
  if (broadcastIds.length) {
    await db.delete(broadcasts).where(inArray(broadcasts.id, broadcastIds));
    await db.delete(attachments).where(inArray(attachments.entityId, broadcastIds));
  }
  await db.delete(notifications).where(sql`${notifications.payload}->>'text' LIKE ${`%${TAG}%`}`);
  await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, made));
  await db.update(clients).set({ active: false, birthday: null }).where(inArray(clients.id, made));
  await pgClient.end();
});

const base = { sectors: [], cargoKinds: [], locales: [], codes: [] };

describe('who a broadcast reaches', () => {
  it('a trade, case-blind, once per CHAT, and never a client with no chat', async () => {
    const got = await audienceChats({ ...base, sectors: [`KIYIM${S}`] });
    expect(got.map((c) => c.chatId).sort()).toEqual([chat(1), chat(3)]);
    // The shared chat is kept under its oldest code.
    expect(got.find((c) => c.chatId === chat(3))!.clientCode).toBe(`BC${S}`);
  });

  it('a cargo kind, a language, and typed codes narrow it', async () => {
    expect((await audienceChats({ ...base, cargoKinds: [`KROSSOVKA${S}`] })).map((c) => c.chatId)).toEqual([chat(2)]);
    const ru = await audienceChats({ ...base, codes: [`BA${S}`, `BB${S}`], locales: ['ru'] });
    expect(ru.map((c) => c.chatId)).toEqual([chat(1)]);
  });

  it('a search finds by the GOODS a client brought, and by name or trade (2026-09-26, item 4)', async () => {
    // «who brings chairs» lives in the prixods, not in a tag somebody typed.
    const wh = await db.query.warehouses.findFirst();
    const [bb] = await db.select().from(clients).where(eq(clients.clientCode, `BB${S}`));
    const [receipt] = await db
      .insert(receipts)
      .values({ warehouseId: wh!.id, clientId: bb!.id, status: 'confirmed', createdBy: actorId })
      .returning();
    const [voided] = await db
      .insert(receipts)
      .values({ warehouseId: wh!.id, clientId: made[0]!, status: 'voided', createdBy: actorId })
      .returning();
    try {
      await db.insert(receiptLots).values([
        { receiptId: receipt!.id, seq: 1, productNameZh: '椅子', productNameRu: `Стул офисный ${S}`, boxCount: 1, totalWeightKg: '1', totalVolumeM3: '0.1' },
        // A voided prixod is not what the client brings.
        { receiptId: voided!.id, seq: 1, productNameZh: '椅子', productNameRu: `Стул офисный ${S}`, boxCount: 1, totalWeightKg: '1', totalVolumeM3: '0.1' },
      ]);
      const byGoods = await audienceChats({ ...base, query: `стул офисный ${S}` });
      expect(byGoods.map((c) => c.chatId)).toEqual([chat(2)]);
      expect((await audienceChats({ ...base, query: `poyabzal${S}` })).map((c) => c.chatId)).toEqual([chat(2)]);
      expect((await audienceChats({ ...base, query: `${TAG} BA${S}` })).map((c) => c.chatId)).toEqual([chat(1)]);
      // A LIKE wildcard typed by a person is a character, not «anything».
      expect(await audienceChats({ ...base, query: '%' })).toEqual([]);
    } finally {
      await db.delete(receiptLots).where(inArray(receiptLots.receiptId, [receipt!.id, voided!.id]));
      await db.delete(receipts).where(inArray(receipts.id, [receipt!.id, voided!.id]));
    }
  });
});

describe('sending it', () => {
  it('each chat gets the words and the file once; a blocked chat fails alone', async () => {
    const id = crypto.randomUUID();
    broadcastIds.push(id);
    await db.insert(attachments).values({
      entityType: 'broadcast',
      entityId: id,
      kind: 'file',
      storageKey: `test/${id}.pdf`,
      fileName: 'narxlar.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      uploadedBy: actorId,
    });
    const made = await createBroadcast(
      { id, body: `Juma muborak ${TAG}`, audience: { ...base, sectors: [`kiyim${S}`] } },
      { actorId },
    );
    expect(made.total).toBe(2);

    const calls: { method: string; chat: number; media?: unknown }[] = [];
    const api = {
      sendMessage: async (chatId: number) => {
        calls.push({ method: 'message', chat: chatId });
        if (BigInt(chatId) === chat(3)) throw new Error('Forbidden: bot was blocked by the user');
        return {};
      },
      sendDocument: async (chatId: number, media: unknown) => {
        calls.push({ method: 'document', chat: chatId, media });
        return { document: { file_id: 'FILE-ID-1' } };
      },
      sendPhoto: async () => ({}),
    } as unknown as Api;
    // The stand-in never reads storage: the first send's InputFile is only
    // constructed, and the second chat must be handed the returned id.
    const sent = await runBroadcast(id, api);
    expect(sent).toBe(1);
    const row = await db.query.broadcasts.findFirst({ where: eq(broadcasts.id, id) });
    expect(row).toMatchObject({ total: 2, sent: 1, failed: 1 });
    expect(row!.finishedAt).not.toBeNull();
    expect(calls.filter((c) => c.method === 'message')).toHaveLength(2);
    const states = await db
      .select({ chatId: broadcastRecipients.chatId, status: broadcastRecipients.status })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.broadcastId, id));
    expect(new Map(states.map((s) => [s.chatId, s.status]))).toEqual(
      new Map([
        [chat(1), 'sent'],
        [chat(3), 'failed'],
      ]),
    );
    // Run again: nothing is pending, nobody is sent to twice.
    calls.length = 0;
    expect(await runBroadcast(id, api)).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses an empty message and an audience with nobody in it', async () => {
    const id = crypto.randomUUID();
    await expect(createBroadcast({ id, body: '  ', audience: base }, { actorId })).rejects.toThrow(BroadcastError);
    await expect(
      createBroadcast({ id, body: 'x', audience: { ...base, codes: [`BE${S}`] } }, { actorId }),
    ).rejects.toThrow('no_recipients');
  });
});

describe('birthdays', () => {
  it('today’s are listed, and reminded once a day', async () => {
    const today = tashkentDay();
    await db
      .update(clients)
      .set({ birthday: `1990-${today.slice(5)}`, birthdayAlertedOn: null })
      .where(eq(clients.clientCode, `BA${S}`));
    await db
      .update(clients)
      .set({ birthday: `1990-${addDays(today, 1).slice(5)}` })
      .where(eq(clients.clientCode, `BB${S}`));
    const codes = (await birthdaysOn(today)).map((b) => b.clientCode);
    expect(codes).toContain(`BA${S}`);
    expect(codes).not.toContain(`BB${S}`);

    await alertBirthdays(today);
    const count = async () =>
      Number(
        (
          await db.execute<{ n: string }>(
            sql`SELECT count(*) AS n FROM notifications WHERE type = 'ClientBirthday' AND payload->>'text' LIKE ${`%BA${S}%`}`,
          )
        )[0]!.n,
      );
    const first = await count();
    expect(first).toBeGreaterThan(0);
    await alertBirthdays(today);
    expect(await count()).toBe(first);
  });
});
