import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, boxes, clients, clientTelegramLinks, users, warehouses } from '@/modules/platform/db/schema';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import {
  authenticateCabinet,
  cabinetPayload,
  changeCabinetLocale,
  LOCALE_CHANGE_GAP_MS,
} from '@/modules/wms/client-cabinet/miniapp';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { POST } from '@/app/api/cabinet/locale/route';

/**
 * Round C's Mini App additions against a real database: what the payload now
 * carries about the people a customer may contact (and nothing more), where
 * ready cargo stands, and the language switch's door — its refusals, its
 * no-op, its brake, and the message it sends so the chat's keyboard follows.
 *
 * Telegram is a captured transport: nothing leaves the machine, and what the
 * bot WOULD have sent is asserted rather than assumed.
 */

const APP_TOKEN = '930000111:MINI-APP-LOCALE-TEST';
const stamp = String(Date.now()).slice(-6);
const CHAT = Number(`93${stamp}`);
const STRANGER = Number(`94${stamp}`);
const READY_CHAT = Number(`95${stamp}`);

let saved: { token?: string; appUrl?: string };
let managerId: string;
let managedId: string;
let bareId: string;
let readyClientId: string;
let readyLotId: string;
const noReceiptClients: string[] = [];

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];

/** Telegram's construction, written out independently of the source. */
function signFor(userId: number, token = APP_TOKEN): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'Client', language_code: 'en' }),
  };
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function post(body: unknown, initData: string | null) {
  return POST(
    new Request('http://localhost/api/cabinet/locale', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(initData !== null ? { 'x-telegram-init-data': initData } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function localesOf(ids: string[]) {
  const rows = await db.select({ id: clients.id, locale: clients.locale }).from(clients).where(inArray(clients.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.locale]));
}

beforeAll(async () => {
  saved = { token: process.env.TELEGRAM_BOT_TOKEN, appUrl: process.env.APP_URL };
  process.env.TELEGRAM_BOT_TOKEN = APP_TOKEN;
  // The corner button is only ever set on public HTTPS (#275).
  process.env.APP_URL = 'https://cabinet.test';
  __setTelegramTransport(async (url, init) => {
    const method = url.split('/').pop() ?? '';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const [m] = await db
    .insert(users)
    .values({ phone: `+99893${stamp}7`, fullName: 'Dilnoza Locale', passwordHash: 'x', telegramUsername: 'dilnoza_gsr' })
    .returning();
  managerId = m!.id;
  const [a] = await db
    .insert(clients)
    .values({ clientCode: `LM${stamp}`, name: 'Managed', phones: [], salesManagerId: managerId })
    .returning();
  const [b] = await db.insert(clients).values({ clientCode: `LN${stamp}`, name: 'Bare', phones: [] }).returning();
  managedId = a!.id;
  bareId = b!.id;
  noReceiptClients.push(managedId, bareId);
  await db.insert(clientTelegramLinks).values([
    { clientId: managedId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date(Date.now() - 60_000) },
    { clientId: bareId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() },
  ]);

  // Ready cargo: a receipt at an Uzbek warehouse whose boxes are then marked
  // ready, and a second one of the SAME code still standing in China — the
  // case the ready card's place exists for. Linked AFTER the receipts are
  // confirmed, so no customer notice is claimed for this fixture (a claim
  // needs a linked chat).
  const warehouse = async (code: string, name: string, country: 'UZ' | 'CN', type: 'origin' | 'distribution') => {
    const found = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (found) return found.id;
    const tz = country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent';
    return (
      await db.insert(warehouses).values({ code, name, country, type, timezone: tz, batchPrefix: code }).returning()
    )[0]!.id;
  };
  const uzWarehouse = await warehouse('PCCWH', 'Locale Test Ombor', 'UZ', 'distribution');
  const cnWarehouse = await warehouse('PCCCN', 'Locale Test Yiwu', 'CN', 'origin');
  const [r] = await db.insert(clients).values({ clientCode: `LR${stamp}`, name: 'Ready', phones: [] }).returning();
  readyClientId = r!.id;
  const actorId = (await db.select().from(users).limit(1))[0]!.id;
  const receive = async (warehouseId: string, lotId: string) => {
    // A receipt is confirmed only with a photograph of each lot.
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: lotId,
      kind: 'photo',
      storageKey: `pcc-locale/${lotId}`,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });
    await confirmReceipt(
      {
        receiptId: uuidv4(),
        warehouseId,
        clientId: readyClientId,
        unclaimedMarking: '',
        lots: [
          {
            id: lotId,
            productNameZh: '准备好',
            boxCount: 2,
            dimsMode: 'uniform',
            boxLengthCm: 30,
            boxWidthCm: 30,
            boxHeightCm: 30,
            boxWeightKg: 5,
          },
        ],
        extraCosts: [],
      },
      { actorId },
    );
  };
  readyLotId = uuidv4();
  await receive(uzWarehouse, readyLotId);
  await receive(cnWarehouse, uuidv4());
  await db.update(boxes).set({ status: 'ready_for_pickup' }).where(eq(boxes.lotId, readyLotId));
  await db.insert(clientTelegramLinks).values({
    clientId: readyClientId,
    telegramChatId: BigInt(READY_CHAT),
    status: 'linked',
    linkedAt: new Date(),
  });
});

beforeEach(() => {
  calls = [];
});

afterAll(async () => {
  __setTelegramTransport(null);
  if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = saved.token;
  if (saved.appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved.appUrl;
  // The ready boxes go back to plain stock, the state every other fixture of
  // this kind leaves (client-cabinet's C22WH): a READY box is a customer
  // waiting on the handover screen of whatever spec runs next (#183).
  if (readyLotId) await db.update(boxes).set({ status: 'in_stock' }).where(eq(boxes.lotId, readyLotId));
  const linked = [...noReceiptClients, readyClientId].filter(Boolean);
  if (linked.length) await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, linked));
  if (noReceiptClients.length) await db.delete(clients).where(inArray(clients.id, noReceiptClients));
  if (managerId) await db.delete(users).where(eq(users.id, managerId));
  await pgClient.end();
});

describe('what the payload says about people', () => {
  it('names the manager and the office with exactly their keys — nothing staff-side rides along', async () => {
    const auth = await authenticateCabinet(signFor(CHAT));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const payload = await cabinetPayload(auth);
    const managed = payload.clients.find((c) => c.id === managedId)!;
    const bare = payload.clients.find((c) => c.id === bareId)!;

    expect(Object.keys(managed.manager!).sort()).toEqual(['name', 'phone', 'telegramUrl']);
    expect(managed.manager).toEqual({
      name: 'Dilnoza Locale',
      phone: `+99893${stamp}7`,
      telegramUrl: 'https://t.me/dilnoza_gsr',
    });
    // No manager is an ANSWER (the office card), not a missing field.
    expect(bare.manager).toBeNull();
    expect(Object.keys(payload.office!).sort()).toEqual(['name', 'phone']);
    // The code's stored language is the chat's business, not a field on the screen.
    expect(Object.keys(managed)).not.toContain('locale');
    // Nobody has chosen yet: the screen speaks Telegram's guess, and the
    // switch highlights nothing.
    expect(payload.storedLocale).toBeNull();
    expect(payload.locale).toBe('en');
  });

  it('says where READY boxes stand, by name — not where the same code’s other cargo waits', async () => {
    const auth = await authenticateCabinet(signFor(READY_CHAT));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const payload = await cabinetPayload(auth);
    const ready = payload.clients.find((c) => c.id === readyClientId)!;
    // The code also has two boxes in «Locale Test Yiwu»: naming that place on
    // the «come and collect» card would send the customer toward China.
    expect(ready.cargo.flatMap((l) => l.warehousePlaces).sort()).toEqual(['Locale Test Ombor', 'Locale Test Yiwu']);
    expect(ready.readyPlaces).toEqual([{ name: 'Locale Test Ombor', address: null }]);
    expect(ready.cargo.find((l) => l.lotId === readyLotId)?.groups[0]?.stage).toBe('ready');

    const other = await authenticateCabinet(signFor(CHAT));
    if (!other.ok) throw new Error('fixture chat not linked');
    const elsewhere = await cabinetPayload(other);
    expect(elsewhere.clients.every((c) => (c.readyPlaces ?? []).length === 0)).toBe(true);
  });
});

describe('the language switch door', () => {
  it('refuses a request with no signed blob, and a chat nobody linked', async () => {
    const none = await post({ locale: 'uz' }, null);
    expect(none.status).toBe(401);
    const stranger = await post({ locale: 'uz' }, signFor(STRANGER));
    expect(stranger.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a language the cabinet does not speak, and a body that is not a choice', async () => {
    const res = await post({ locale: 'de' }, signFor(CHAT));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_locale' });
    expect((await post('not json', signFor(CHAT))).status).toBe(400);
    expect((await post({ locale: 'uz', pad: 'x'.repeat(500) }, signFor(CHAT))).status).toBe(400);
    expect(Object.values(await localesOf([managedId, bareId]))).toEqual([null, null]);
    expect(calls).toHaveLength(0);
  });

  it('a change re-languages every code in the chat, sets the corner button and sends the keyboard', async () => {
    const res = await post({ locale: 'uz' }, signFor(CHAT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, locale: 'uz', changed: true });
    expect(await localesOf([managedId, bareId])).toEqual({ [managedId]: 'uz', [bareId]: 'uz' });

    expect(calls.map((c) => c.method)).toEqual(['setChatMenuButton', 'sendMessage']);
    const menu = calls[0]!.body as { chat_id: number; menu_button: { text: string } };
    expect(menu.chat_id).toBe(CHAT);
    expect(menu.menu_button.text).toBe(clientLabels('uz').appTitle);
    const sent = calls[1]!.body as { chat_id: number; text: string; reply_markup?: { keyboard?: { text: string }[][] } };
    expect(sent.chat_id).toBe(CHAT);
    expect(sent.text).toBe(clientLabels('uz').languageSet);
    // The keyboard the chat is owed, in the new language — the only way a
    // reply keyboard ever changes is by a message carrying it.
    const labels = (sent.reply_markup?.keyboard ?? []).flat().map((b) => b.text);
    expect(labels).toContain(clientLabels('uz').btnCargo);
    expect(labels).toContain(clientLabels('uz').btnManager);

    const auth = await authenticateCabinet(signFor(CHAT));
    if (!auth.ok) throw new Error('fixture chat not linked');
    expect((await cabinetPayload(auth)).storedLocale).toBe('uz');
  });

  it('a press that changes nothing writes nothing and sends nothing', async () => {
    const res = await post({ locale: 'uz' }, signFor(CHAT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, locale: 'uz', changed: false });
    expect(calls).toHaveLength(0);
  });

  it('a second real change inside ten seconds is refused, and the window reopens', async () => {
    const res = await post({ locale: 'ru' }, signFor(CHAT));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too_fast' });
    expect(await localesOf([managedId, bareId])).toEqual({ [managedId]: 'uz', [bareId]: 'uz' });
    expect(calls).toHaveLength(0);

    const auth = await authenticateCabinet(signFor(CHAT));
    if (!auth.ok) throw new Error('fixture chat not linked');
    const later = await changeCabinetLocale(auth, 'ru', Date.now() + LOCALE_CHANGE_GAP_MS + 1);
    expect(later).toEqual({ ok: true, changed: true, locale: 'ru' });
    expect(await localesOf([managedId, bareId])).toEqual({ [managedId]: 'ru', [bareId]: 'ru' });
  });
});
