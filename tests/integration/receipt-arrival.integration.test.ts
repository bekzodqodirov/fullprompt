import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  // Nothing is really queued: the drain is run by hand below.
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxMovements,
  boxes,
  clients,
  deals,
  events,
  notifications,
  receiptLots,
  receipts,
  roles,
  telegramLinks,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { emitEvent } from '@/modules/platform/events/service';
import { FOUNDERS } from '@/modules/platform/notifications/mutes';
import { processPendingEvents, renderTelegramText } from '@/modules/platform/notifications/service';
import { buttonsFor } from '@/modules/platform/telegram/staff-bot';
import { createDeal } from '@/modules/wms/deals/service';
import { assignReceiptClient } from '@/modules/wms/receipts/edit';
import { confirmReceipt } from '@/modules/wms/receipts/service';

/**
 * «Prixod keldi» — who is told, once, and under which mute (the owner,
 * 2026-11-11: «prixod kelganda bitim tuzilmagan va prixod keldi deb 2 marta
 * sms boryabti»; docs/PRIXOD-XABARI.md §C.3).
 *
 * The fold's most delicate part is not its words but its ROWS: a seller who
 * used to get the prixod and then its deal alarm must get one message and
 * lose nothing — whichever of the two groups they silenced — and the alarm's
 * own promise must hold when nobody is there to hear it. Proven here against
 * real prixods, real drains and stored mute lists, per person.
 *
 * Also R6 (his «mijozdan tasdiq bosmasa ham sklad yuk kelgan zahoti borsin
 * habar»): the seller's row is born by the drain that follows the confirm,
 * and nothing in its path asks the customer anything.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId = '';
let warehouseId = '';
const ctx = () => ({ actorId });

const made = { receipts: [] as string[], deals: [] as string[], clients: [] as string[], users: [] as string[], events: [] as string[] };
let chatSeq = 0;

type Person = { id: string; clientId: string };
const sellers = {} as Record<'plain' | 'ops' | 'alerts' | 'both' | 'nochat', Person>;
let adminId = '';
let orphanClientId = '';

async function mintUser(tag: string, opts: { muted?: string[]; chat?: boolean; role: string }): Promise<string> {
  chatSeq += 1;
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99877${SUFFIX}${chatSeq}`,
      fullName: `PX ${tag} ${SUFFIX}`,
      passwordHash: 'x',
      locale: 'uz',
      active: true,
      mutedNotificationTypes: opts.muted ?? [],
    })
    .returning({ id: users.id });
  made.users.push(user!.id);
  const role = await db.query.roles.findFirst({ where: eq(roles.code, opts.role) });
  await db.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
  if (opts.chat !== false) {
    await db.insert(telegramLinks).values({
      userId: user!.id,
      telegramChatId: BigInt(`77${SUFFIX}${chatSeq}`),
      status: 'linked',
      linkedAt: new Date(),
    });
  }
  return user!.id;
}

let clientSeq = 0;
async function mintClient(sellerId: string | null): Promise<string> {
  clientSeq += 1;
  // The counter at the FRONT (#631): codes cap at ten characters.
  const row = await createClient(
    { clientCode: `PX${clientSeq}${SUFFIX.slice(-5)}`, name: `Prixod mijoz ${SUFFIX}-${clientSeq}`, phones: [] },
    ctx(),
  );
  made.clients.push(row.id);
  if (sellerId) await db.update(clients).set({ salesManagerId: sellerId }).where(eq(clients.id, row.id));
  return row.id;
}

async function mintDeal(clientId: string, priced: boolean): Promise<{ id: string; code: string }> {
  const id = await createDeal(
    {
      clientId,
      title: `Prixod bitim ${SUFFIX}`,
      quotedVolumeM3: 1,
      quotedWeightKg: 100,
      quotedAmount: priced ? 200 : null,
      quotedCurrency: priced ? 'USD' : null,
    } as Parameters<typeof createDeal>[0],
    ctx(),
  );
  made.deals.push(id);
  const row = await db.query.deals.findFirst({ where: eq(deals.id, id) });
  return { id, code: row!.code };
}

/** A confirmed prixod of one lot — exactly the quote's size, so no deviation alarm joins the picture. */
async function receive(clientId: string | null, dealId: string | null = null): Promise<string> {
  const receiptId = crypto.randomUUID();
  const lotId = crypto.randomUUID();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `prixodtest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  const result = await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      sourceNote: '',
      unclaimedMarking: clientId ? '' : `PXM${SUFFIX}${made.receipts.length}`,
      dealId,
      lots: [
        {
          id: lotId,
          productNameZh: `货 ${SUFFIX}`,
          productNameRu: 'Tovar',
          boxCount: 10,
          dimsMode: 'mixed',
          totalWeightKg: 100,
          totalVolumeM3: 1,
          note: '',
        },
      ],
      extraCosts: [],
    } as Parameters<typeof confirmReceipt>[0],
    ctx(),
  );
  made.receipts.push(result.receiptId);
  return result.receiptId;
}

/** Each person's Telegram rows about one prixod. */
async function rowsAbout(receiptId: string) {
  const rows = await db
    .select({
      userId: notifications.userId,
      type: notifications.type,
      status: notifications.status,
      error: notifications.error,
      payload: notifications.payload,
    })
    .from(notifications)
    .where(and(eq(notifications.channel, 'telegram'), sql`${notifications.payload}->>'receiptId' = ${receiptId}`));
  const of = (userId: string) => rows.filter((row) => row.userId === userId);
  return { rows, of };
}

async function eventsOf(receiptId: string) {
  const rows = await db.select().from(events).where(eq(events.entityId, receiptId));
  return (type: string) => rows.filter((row) => row.type === type).map((row) => row.payload as Record<string, unknown>);
}

beforeAll(async () => {
  const staff = await db
    .select({ id: users.id, code: roles.code })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(users.active, true));
  actorId = staff.find((row) => row.code === 'super_admin')!.id;
  warehouseId = (await db.select({ id: warehouses.id }).from(warehouses).limit(1))[0]!.id;

  const mutes = {
    plain: [] as string[],
    ops: [...FOUNDERS.operations],
    alerts: [...FOUNDERS.alerts],
    both: [...FOUNDERS.operations, ...FOUNDERS.alerts],
    nochat: [] as string[],
  };
  for (const tag of ['plain', 'ops', 'alerts', 'both', 'nochat'] as const) {
    const id = await mintUser(tag, { muted: mutes[tag], chat: tag !== 'nochat', role: 'sales_manager' });
    sellers[tag] = { id, clientId: await mintClient(id) };
  }
  adminId = await mintUser('admin', { role: 'admin' });
  orphanClientId = await mintClient(null);
  // The queue as it stood: whatever earlier files left pending is drained
  // now, so the rows counted below are this file's own.
  await processPendingEvents();
});

afterAll(async () => {
  for (const id of made.receipts) {
    const lots = await db.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, id));
    if (lots.length) {
      const lotIds = lots.map((l) => l.id);
      const rows = await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds));
      if (rows.length) await db.delete(boxMovements).where(inArray(boxMovements.boxId, rows.map((b) => b.id)));
      await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
      await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
      await db.delete(receiptLots).where(eq(receiptLots.receiptId, id));
    }
    await db.execute(sql`DELETE FROM client_notices WHERE ref_id = ${id}::uuid`);
    await db.delete(notifications).where(sql`${notifications.payload}->>'receiptId' = ${id}`);
    await db.delete(events).where(eq(events.entityId, id));
    await db.delete(receipts).where(eq(receipts.id, id));
  }
  for (const id of made.events) {
    await db.delete(notifications).where(sql`${notifications.payload}->>'receiptId' = ${id}`);
    await db.delete(events).where(eq(events.entityId, id));
  }
  for (const id of made.deals) {
    await db.delete(events).where(eq(events.entityId, id));
    await db.delete(deals).where(eq(deals.id, id));
  }
  for (const id of made.clients) await db.delete(clients).where(eq(clients.id, id));
  // People are DEACTIVATED, never deleted (audit_log points at them), and
  // their chats revoked so no later file's fan-out finds them.
  if (made.users.length) {
    await db.delete(notifications).where(inArray(notifications.userId, made.users));
    await db.update(telegramLinks).set({ status: 'revoked' }).where(inArray(telegramLinks.userId, made.users));
    await db.delete(userRoles).where(inArray(userRoles.userId, made.users));
    await db.update(users).set({ active: false, mutedNotificationTypes: [] }).where(inArray(users.id, made.users));
  }
  await pgClient.end();
});

describe('one message, where there were two', () => {
  it('no deal at all: the seller gets ONE row — the prixod, with the alarm inside — and the alert EVENT is still written', async () => {
    const receiptId = await receive(sellers.plain.clientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(sellers.plain.id).map((r) => [r.type, r.status])).toEqual([['ReceiptConfirmed', 'pending']]);
    // The admin hears nothing: the seller is there to act.
    expect(of(adminId)).toEqual([]);

    const row = of(sellers.plain.id)[0]!;
    const payload = row.payload as Record<string, unknown>;
    expect(payload.dealState).toBe('none');
    const text = renderTelegramText(row.type, payload, 'uz');
    expect(text.split('\n')[0]).toMatch(/^📥 Prixod keldi — /);
    expect(text).toContain(`Mijoz: PX1${SUFFIX.slice(-5)} (Prixod mijoz ${SUFFIX}-1)`);
    expect(text).toContain('⚠️ Narxlangan bitimi yo‘q — narxlatib qo‘ying');
    expect(text).toContain('10 kor., 100 kg, 1 m³');
    expect(buttonsFor(row.type, payload)).toEqual([[{ text: '📎 Fayl qo‘shish', callback_data: `pf:${receiptId}` }]]);

    // The alarm is still an EVENT — the owner's automation rules listen to
    // it — and says that it was told through the prixod's own row.
    const ev = await eventsOf(receiptId);
    expect(ev('UnquotedCargo')).toHaveLength(1);
    expect(ev('UnquotedCargo')[0]!.folded).toBe(true);
    expect(ev('UnlinkedCargo')).toHaveLength(0);
    const confirmed = ev('ReceiptConfirmed')[0]!;
    expect(confirmed).toMatchObject({ dealState: 'none', dealCode: null, boxCount: 10, weightKg: 100, volumeM3: 1 });
  });

  it('a deal to attach to: one row, «biriktiring», the open deals named', async () => {
    const deal = await mintDeal(sellers.plain.clientId, true);
    const receiptId = await receive(sellers.plain.clientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(sellers.plain.id).map((r) => [r.type, r.status])).toEqual([['ReceiptConfirmed', 'pending']]);
    const payload = of(sellers.plain.id)[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ dealState: 'attachable', openDealCodes: [deal.code] });
    expect(renderTelegramText('ReceiptConfirmed', payload, 'uz')).toContain(`Ochiq bitimlar: ${deal.code}`);
    const ev = await eventsOf(receiptId);
    expect(ev('UnlinkedCargo')).toHaveLength(1);
    expect(ev('UnlinkedCargo')[0]!.folded).toBe(true);
    expect(ev('UnquotedCargo')).toHaveLength(0);
  });

  it('on a deal that carries no price: one row, the deal named; on a priced one: one row and no alarm at all', async () => {
    const unpriced = await mintDeal(sellers.plain.clientId, false);
    const first = await receive(sellers.plain.clientId, unpriced.id);
    const priced = await mintDeal(sellers.plain.clientId, true);
    const second = await receive(sellers.plain.clientId, priced.id);
    await processPendingEvents();

    const a = await rowsAbout(first);
    expect(a.of(sellers.plain.id).map((r) => [r.type, r.status])).toEqual([['ReceiptConfirmed', 'pending']]);
    expect(a.of(sellers.plain.id)[0]!.payload).toMatchObject({ dealState: 'unpriced', dealCode: unpriced.code });
    expect((await eventsOf(first))('UnquotedCargo')[0]).toMatchObject({ folded: true, openDealCodes: [unpriced.code] });

    const b = await rowsAbout(second);
    expect(b.of(sellers.plain.id).map((r) => [r.type, r.status])).toEqual([['ReceiptConfirmed', 'pending']]);
    expect(b.of(sellers.plain.id)[0]!.payload).toMatchObject({ dealState: 'priced', dealCode: priced.code });
    const ev = await eventsOf(second);
    expect(ev('UnquotedCargo')).toHaveLength(0);
    expect(ev('UnlinkedCargo')).toHaveLength(0);
  });
});

describe('nobody loses what they hear today', () => {
  it('«Operatsiya xabarlari» muted, the alarms kept: the deal-less prixod is still heard — as the alarm — and a priced one is silent', async () => {
    const alarmed = await receive(sellers.ops.clientId);
    const deal = await mintDeal(sellers.ops.clientId, true);
    const quiet = await receive(sellers.ops.clientId, deal.id);
    await processPendingEvents();
    expect((await rowsAbout(alarmed)).of(sellers.ops.id).map((r) => [r.type, r.status])).toEqual([['UnquotedCargo', 'pending']]);
    // …and the bell's row is the same one: both rows are born under the type the person still hears.
    const bell = await db
      .select({ type: notifications.type })
      .from(notifications)
      .where(
        and(
          eq(notifications.channel, 'in_app'),
          eq(notifications.userId, sellers.ops.id),
          sql`${notifications.payload}->>'receiptId' = ${alarmed}`,
        ),
      );
    expect(bell.map((r) => r.type)).toEqual(['UnquotedCargo']);
    expect((await rowsAbout(quiet)).of(sellers.ops.id).map((r) => [r.type, r.status, r.error])).toEqual([
      ['ReceiptConfirmed', 'muted', 'muted by user'],
    ]);
  });

  it('the alarms muted, operations kept: still hears every prixod', async () => {
    const receiptId = await receive(sellers.alerts.clientId);
    await processPendingEvents();
    expect((await rowsAbout(receiptId)).of(sellers.alerts.id).map((r) => [r.type, r.status])).toEqual([
      ['ReceiptConfirmed', 'pending'],
    ]);
  });

  it('both muted: one silent row — and a mute is the person’s own choice, so no admin is told instead', async () => {
    const receiptId = await receive(sellers.both.clientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(sellers.both.id).map((r) => [r.type, r.status, r.error])).toEqual([['ReceiptConfirmed', 'muted', 'muted by user']]);
    expect(of(adminId)).toEqual([]);
  });
});

describe('the alarm reaches somebody who can act', () => {
  it('a client with no seller: the admins hear the deal-less prixod, typed as the alarm, with the client on it', async () => {
    const receiptId = await receive(orphanClientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(adminId).map((r) => [r.type, r.status])).toEqual([['UnquotedCargo', 'pending']]);
    const row = of(adminId)[0]!;
    const text = renderTelegramText(row.type, row.payload as Record<string, unknown>, 'uz');
    expect(text.split('\n')[0]).toMatch(/^📥 Prixod keldi — /);
    expect(text).toContain(`(Prixod mijoz ${SUFFIX}-6)`);
    expect(text).not.toContain('undefined');
    // WHY it came to an admin — on the admins' copy alone.
    expect(text).toContain('👤 Mijozning sotuvchisi yo‘q — sizga yuborildi');
    expect(buttonsFor(row.type, row.payload as Record<string, unknown>)).toEqual([
      [{ text: '📎 Fayl qo‘shish', callback_data: `pf:${receiptId}` }],
    ]);
  });

  it('…and a PRICED prixod of such a client goes to nobody, as it always did', async () => {
    const deal = await mintDeal(orphanClientId, true);
    const receiptId = await receive(orphanClientId, deal.id);
    await processPendingEvents();
    expect((await rowsAbout(receiptId)).rows).toEqual([]);
  });

  it('a seller whose Telegram was never linked: their row is born unsendable, so the admins hear the alarm too', async () => {
    const receiptId = await receive(sellers.nochat.clientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(sellers.nochat.id).map((r) => [r.type, r.status, r.error])).toEqual([
      ['ReceiptConfirmed', 'muted', 'telegram not linked'],
    ]);
    expect(of(adminId).map((r) => [r.type, r.status])).toEqual([['UnquotedCargo', 'pending']]);
    // The admin is told it is HIS to act on: the client's card names a
    // seller, and without this line he would assume that seller was told.
    const admins = renderTelegramText('UnquotedCargo', of(adminId)[0]!.payload as Record<string, unknown>, 'uz');
    expect(admins).toContain(`👤 Sotuvchi PX nochat ${SUFFIX} bu xabarni ololmaydi`);
    // …and the seller's own copy says nothing of the kind.
    const own = renderTelegramText('ReceiptConfirmed', of(sellers.nochat.id)[0]!.payload as Record<string, unknown>, 'uz');
    expect(own).not.toContain('👤');
  });

  it('a seller who LEFT keeps his linked chat — and is still nobody: the admins hear it', async () => {
    // The realistic leaver: deactivating a person flips `users.active` and
    // nothing else, so his Telegram link stays `linked` and his clients go on
    // pointing at him. «Has a linked chat» alone would call him reachable.
    const leaverId = await mintUser('leaver', { role: 'sales_manager' });
    const clientId = await mintClient(leaverId);
    await db.update(users).set({ active: false }).where(eq(users.id, leaverId));
    const receiptId = await receive(clientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(adminId).map((r) => [r.type, r.status])).toEqual([['UnquotedCargo', 'pending']]);
  });

  it('an admin who is himself the client’s seller, and unreachable, is not told twice — the OTHER admins hear it', async () => {
    const bossId = await mintUser('boss', { role: 'admin', chat: false });
    const clientId = await mintClient(bossId);
    const receiptId = await receive(clientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(bossId).map((r) => [r.type, r.status, r.error])).toEqual([['ReceiptConfirmed', 'muted', 'telegram not linked']]);
    expect(of(adminId).map((r) => [r.type, r.status])).toEqual([['UnquotedCargo', 'pending']]);
  });
});

describe('what the fold must not touch', () => {
  it('an event pair queued from before the fold still tells the seller twice — exactly as it was written', async () => {
    const fake = crypto.randomUUID();
    made.events.push(fake);
    const old = {
      receiptId: fake,
      number: `OLD-${SUFFIX}`,
      warehouseCode: 'YW',
      clientId: sellers.plain.clientId,
      lots: [{ letter: 'A', productNameZh: '货', productNameRu: null, boxCount: 1, totalWeightKg: 1, totalVolumeM3: 1 }],
      dealLinked: false,
      openDealCodes: [],
    };
    await db.transaction(async (tx) => {
      await emitEvent(tx, { type: 'ReceiptConfirmed', payload: old, entityType: 'receipt', entityId: fake, actorId });
      await emitEvent(tx, {
        type: 'UnquotedCargo',
        payload: { ...old, clientCode: 'X', clientName: 'Y', volumeM3: 1, weightKg: 1, boxCount: 1 },
        entityType: 'receipt',
        entityId: fake,
        actorId,
      });
    });
    await processPendingEvents();
    const { of } = await rowsAbout(fake);
    expect(of(sellers.plain.id).map((r) => r.type).sort()).toEqual(['ReceiptConfirmed', 'UnquotedCargo']);
    const prixod = of(sellers.plain.id).find((r) => r.type === 'ReceiptConfirmed')!;
    expect(renderTelegramText('ReceiptConfirmed', prixod.payload as Record<string, unknown>, 'uz').split('\n')[0]).toBe(
      `📥 Prixod OLD-${SUFFIX}`,
    );
    expect(buttonsFor('ReceiptConfirmed', prixod.payload as Record<string, unknown>)).toBeNull();
  });

  it('the claim door: the new owner’s seller, alone — «biriktirildi», the two buttons, and no alarm to any admin', async () => {
    const receiptId = await receive(null);
    await processPendingEvents();
    await assignReceiptClient(receiptId, sellers.plain.clientId, ctx());
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    const mine = of(sellers.plain.id).filter((r) => r.type === 'ReceiptConfirmed');
    expect(mine.map((r) => r.status)).toEqual(['pending']);
    const payload = mine[0]!.payload as Record<string, unknown>;
    expect(payload.via).toBe('assign');
    expect(renderTelegramText('ReceiptConfirmed', payload, 'uz').split('\n')[0]).toMatch(/^📥 Prixod mijozga biriktirildi — /);
    expect(buttonsFor('ReceiptConfirmed', payload)).toEqual([[{ text: '📎 Fayl qo‘shish', callback_data: `pf:${receiptId}` }]]);
    // No alarm of any kind was written for the claim, to anybody.
    expect(of(adminId).filter((r) => r.type !== 'UnknownCargoReceived')).toEqual([]);
    const ev = await eventsOf(receiptId);
    expect(ev('UnquotedCargo')).toHaveLength(0);
    expect(ev('UnlinkedCargo')).toHaveLength(0);
  });

  it('the claim door reads the deal by the same rule: a deal the prixod carried under its PREVIOUS client is no deal of the new one’s', async () => {
    // A → B: the correction moves the client and leaves `deal_id` on A's job.
    const previous = await mintDeal(sellers.plain.clientId, true);
    const receiptId = await receive(sellers.plain.clientId, previous.id);
    await processPendingEvents();
    await assignReceiptClient(receiptId, sellers.alerts.clientId, ctx());
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    const row = of(sellers.alerts.id).find((r) => (r.payload as Record<string, unknown>).via === 'assign')!;
    const payload = row.payload as Record<string, unknown>;
    // B's seller is never shown A's job: «attach it» (B has a deal of its own
    // from the test above) or «price it» — and no code of A's anywhere.
    expect(['none', 'attachable']).toContain(payload.dealState);
    expect(payload.dealCode).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(previous.code);
    expect(renderTelegramText(row.type, payload, 'uz')).not.toContain(previous.code);
  });

  it('…and the claim is no «first cargo»: the staff group is not told a seller brought in cargo that came weeks ago', async () => {
    // `staff_group_posts` holds one claimed row per thing said (skipped when
    // no group is linked) — the claim door must write none.
    const fresh = await mintClient(sellers.plain.id);
    const receiptId = await receive(null);
    await processPendingEvents();
    await assignReceiptClient(receiptId, fresh, ctx());
    await processPendingEvents();
    const posts = await db.execute(sql`SELECT 1 FROM staff_group_posts WHERE dedupe_key = ${`first_cargo:${fresh}`}`);
    expect(posts).toHaveLength(0);
    // The control: the same client's own CONFIRMED prixod is one.
    const second = await mintClient(sellers.plain.id);
    await receive(second);
    await processPendingEvents();
    const said = await db.execute(sql`SELECT 1 FROM staff_group_posts WHERE dedupe_key = ${`first_cargo:${second}`}`);
    expect(said).toHaveLength(1);
    await db.execute(sql`DELETE FROM staff_group_posts WHERE dedupe_key IN (${`first_cargo:${fresh}`}, ${`first_cargo:${second}`})`);
  });

  it('the claim door for a client with no seller tells nobody, as it always did', async () => {
    const receiptId = await receive(null);
    await processPendingEvents();
    await assignReceiptClient(receiptId, orphanClientId, ctx());
    await processPendingEvents();
    const { rows } = await rowsAbout(receiptId);
    expect(rows.filter((r) => r.type !== 'UnknownCargoReceived')).toEqual([]);
  });

  it('a deal of ANOTHER client is no deal of this prixod’s: never named to this client’s seller, never compared against', async () => {
    const foreign = await mintDeal(sellers.alerts.clientId, true);
    const receiptId = await receive(sellers.ops.clientId, foreign.id);
    await processPendingEvents();
    const ev = await eventsOf(receiptId);
    const confirmed = ev('ReceiptConfirmed')[0]!;
    // The seller of `ops` already has a priced deal of their own (minted
    // above), so the honest ask is «attach it» — and never the stranger's code.
    expect(confirmed.dealCode).toBeNull();
    expect(confirmed.dealState).toBe('attachable');
    expect(JSON.stringify(confirmed)).not.toContain(foreign.code);
    expect(ev('DealDeviation')).toHaveLength(0);
    expect(ev('UnlinkedCargo')).toHaveLength(1);
  });
});

describe('R6 — the seller hears when the warehouse confirms, whatever the customer does', () => {
  it('the row is born by the drain that follows the confirm, while no customer has been asked or has answered anything', async () => {
    const receiptId = await receive(sellers.plain.clientId);
    await processPendingEvents();
    const { of } = await rowsAbout(receiptId);
    expect(of(sellers.plain.id).map((r) => r.status)).toEqual(['pending']);
    const lots = await db.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, receiptId));
    const answers = await db.execute(
      sql`SELECT count(*)::int AS n FROM lot_client_confirms WHERE lot_id IN ${sql`(${sql.join(lots.map((l) => sql`${l.id}::uuid`), sql`, `)})`}`,
    );
    expect((answers[0] as { n: number }).n).toBe(0);
    // …and the customer's own «qabul qilindi» for this prixod, where one was
    // claimed at all, has not gone out yet: the seller's message waits for
    // neither the customer's push nor their ✅.
    const sent = await db.execute(
      sql`SELECT count(*)::int AS n FROM client_notices WHERE ref_id = ${receiptId}::uuid AND status = 'sent'`,
    );
    expect((sent[0] as { n: number }).n).toBe(0);
  });
});
