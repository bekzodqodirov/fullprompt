import 'dotenv/config';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, clientTelegramLinks } from '@/modules/platform/db/schema';
import { clientsForChat, linkPhoneSiblings } from '@/modules/wms/client-cabinet/service';

/**
 * «meni nomerimda 4 5 ta kod bolsa hammasini emas faqat 1 tasini
 * korsatyabti» — a chat linked by a staff code holds one client, and the same
 * person's other codes (one phone) stayed outside their own cabinet.
 */
const stamp = String(Date.now()).slice(-7);
const phone = `+99897${stamp}`;
const chatId = BigInt(`9${stamp}11`);
const made: string[] = [];

async function client(code: string, phones: string[]) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `${code}${stamp.slice(-4)}`, name: `Sibling ${code}`, phones })
    .returning();
  made.push(c!.id);
  return c!;
}

afterAll(async () => {
  if (made.length) {
    await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, made));
    await db.delete(clients).where(inArray(clients.id, made));
  }
  await pgClient.end();
});

describe('one person, every code, one cabinet', () => {
  it('links the same phone’s other codes, and never hands back a revoked one', async () => {
    const a = await client('SA', [phone]);
    const b = await client('SB', [phone]);
    const revoked = await client('SC', [phone]);
    const stranger = await client('SD', [`+99893${stamp}`]);
    await db.insert(clientTelegramLinks).values([
      { clientId: a.id, telegramChatId: chatId, status: 'linked', linkedAt: new Date() },
      // A person took this one away on purpose; a sweep must not undo it.
      { clientId: revoked.id, telegramChatId: chatId, status: 'revoked' },
    ]);

    expect(await linkPhoneSiblings(chatId)).toBe(1);
    const ids = (await clientsForChat(chatId)).map((c) => c.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(ids).not.toContain(stranger.id);
    // Idempotent: the second open adds nothing.
    expect(await linkPhoneSiblings(chatId)).toBe(0);
  });

  it('a chat holding nobody is left alone', async () => {
    expect(await linkPhoneSiblings(BigInt(`8${stamp}22`))).toBe(0);
  });
});
