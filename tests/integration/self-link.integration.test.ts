import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, clientTelegramLinks } from '@/modules/platform/db/schema';
import { linkAllClientsForPhone } from '@/modules/platform/telegram/client-cabinet';
import { clientsForChat } from '@/modules/wms/client-cabinet/service';

/**
 * The self-service link (owner, item 13): a client shares their
 * Telegram-verified number and the cabinet connects with NO staff-minted
 * code — so the link row's author is honestly NULL (migration 0042).
 *
 * What only a real database can prove: the NULL author inserts, every code
 * under the phone joins the one chat, a repeat share duplicates nothing,
 * and an unknown number links nobody.
 */

const STAMP = Date.now();
const CHAT = Number(String(STAMP).slice(-9));
const PHONE = `+99893${String(STAMP).slice(-7)}`;

let firstId: string;
let secondId: string;

beforeAll(async () => {
  const [a] = await db
    .insert(clients)
    .values({ clientCode: `SL${STAMP}`.slice(0, 12), name: 'Self Link A', phones: [PHONE] })
    .returning({ id: clients.id });
  firstId = a!.id;
  // The same human, second marking code — the one-phone-many-codes rule.
  const [b] = await db
    .insert(clients)
    .values({ clientCode: `SM${STAMP}`.slice(0, 12), name: 'Self Link B', phones: [PHONE] })
    .returning({ id: clients.id });
  secondId = b!.id;
});

afterAll(async () => {
  await db.delete(clientTelegramLinks).where(eq(clientTelegramLinks.clientId, firstId));
  await db.delete(clientTelegramLinks).where(eq(clientTelegramLinks.clientId, secondId));
  await db.delete(clients).where(eq(clients.id, firstId));
  await db.delete(clients).where(eq(clients.id, secondId));
  await pgClient.end();
});

describe('linking by a shared number, no code and no staff actor', () => {
  it('connects every code under the phone, authored by nobody', async () => {
    const linked = await linkAllClientsForPhone(PHONE, CHAT, null);
    expect(new Set(linked.map((c) => c.clientCode))).toEqual(
      new Set([`SL${STAMP}`.slice(0, 12), `SM${STAMP}`.slice(0, 12)]),
    );
    const rows = await db
      .select()
      .from(clientTelegramLinks)
      .where(eq(clientTelegramLinks.clientId, firstId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('linked');
    expect(rows[0]!.createdBy).toBeNull();
  });

  it('sharing again duplicates nothing — duplicate rows mean duplicate pings', async () => {
    await linkAllClientsForPhone(PHONE, CHAT, null);
    const rows = await db
      .select()
      .from(clientTelegramLinks)
      .where(eq(clientTelegramLinks.clientId, secondId));
    expect(rows).toHaveLength(1);
    expect((await clientsForChat(BigInt(CHAT))).length).toBe(2);
  });

  it('an unknown number links nobody at all', async () => {
    const linkedBefore = (await clientsForChat(BigInt(CHAT + 1))).length;
    const result = await linkAllClientsForPhone('+998990000000', CHAT + 1, null);
    expect(result).toHaveLength(linkedBefore);
  });
});
