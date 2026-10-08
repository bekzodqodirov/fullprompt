import 'dotenv/config';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { Context } from 'grammy';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The prixod's and the truck's staff threads against a real database (round
 * 2, 0129 — the owner's E6 c warehouse half, E7 b, Q4 a): where the cargo
 * stands and that it is a subset of both card doors AT SEND TIME, the cargo
 * door over minted people, who hears an office writer and who hears a
 * warehouse writer, the cargo moving under a conversation, a truck's stages,
 * the fallbacks, the Telegram landing, the dock, the half-applied deploy, the
 * frame in the recipient's language, the mention path, what the box is told
 * and the attachment gate.
 *
 * Real receipts (`confirmReceipt`), real trucks (`submitPlan` → verdict →
 * load scans → `departBatch`), real reroutes and unloads; pointer-only states
 * (issued, void, a shelf write-off, a moved-on shelf) by UPDATE on minted
 * cartons — the function's input is the pointers. Nothing is drained:
 * assertions read `notifications` rows. Warehouses and people are minted per
 * run and DEACTIVATED at the end (audit FK); the two invented roles are
 * CONFIGURATION and are deleted (#183); thread notes, their pings, read marks
 * and this file's events go.
 *
 * Mocks, all hoisted (ESM exports cannot be spied): the session's meta, Next's
 * cache, the job queue, `getActor` (the web action's actor), and ONE toggle
 * object read by the thread writer, the reach check and the role list — each toggle SET inside
 * the one test that needs it and cleared in that test's `finally`.
 */
const override = vi.hoisted(() => ({
  actor: null as null | Record<string, unknown>,
  addThreadMessage: null as null | unknown,
  reachOf: null as null | unknown,
  usersWithRoles: null as null | string[],
}));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'cargo-threads.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async () => {},
}));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    getActor: async () => (override.actor ?? (await real.getActor())) as Awaited<ReturnType<typeof real.getActor>>,
  };
});
vi.mock('@/modules/wms/crm/thread', async (original) => {
  const real = await original<typeof import('@/modules/wms/crm/thread')>();
  return {
    ...real,
    addThreadMessage: async (...args: Parameters<typeof real.addThreadMessage>) => {
      if (override.addThreadMessage) throw override.addThreadMessage;
      return real.addThreadMessage(...args);
    },
  };
});
vi.mock('@/modules/platform/notifications/staff', async (original) => {
  const real = await original<typeof import('@/modules/platform/notifications/staff')>();
  return {
    ...real,
    reachOf: async (...args: Parameters<typeof real.reachOf>) => {
      if (override.reachOf) throw override.reachOf;
      return real.reachOf(...args);
    },
  };
});
vi.mock('@/modules/platform/notifications/service', async (original) => {
  const real = await original<typeof import('@/modules/platform/notifications/service')>();
  return {
    ...real,
    usersWithRoles: async (codes: string[]) => override.usersWithRoles ?? real.usersWithRoles(codes),
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  crmActivities,
  events,
  notifications,
  permissions,
  receipts,
  rolePermissions,
  roles,
  telegramLinks,
  userRoles,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { logger } from '@/modules/platform/logger';
import { actorGrants } from '@/modules/platform/rbac/authorize';
import { REPLY_SENTENCES, refuseMediaReply, threadReplyFromBot } from '@/modules/platform/telegram/reply-door';
import { decideAttachmentRead } from '@/modules/wms/attachments/access';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { rerouteBatch } from '@/modules/wms/batches/reroute';
import type { CargoThreadState } from '@/modules/wms/crm/cargo-thread';
import { postCargoThreadAction } from '@/modules/wms/crm/cargo-thread-actions';
import { announceNote } from '@/modules/wms/crm/internal-chat';
import {
  addThreadMessage,
  isThreadWriteBehind,
  markThreadRead,
  myThreads,
  threadLabels,
  threadReadMarks,
} from '@/modules/wms/crm/thread';
import { mayReadThread, threadDoorsFor, type ThreadReader } from '@/modules/wms/crm/thread-door';
import { landThreadReply } from '@/modules/wms/crm/thread-reply';
import { batchStands, receiptStands, truckWordOf, type CargoStand } from '@/modules/wms/inventory/stands';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { mayReadReceipt } from '@/modules/wms/receipts/read-door';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { NO_DOOR } from '@/modules/wms/scanning/count-rules';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { cancelBatch, finishUnload, ingestUnloadScans, resolveMissing } from '@/modules/wms/scanning/unload';

const S = String(Date.now()).slice(-6);
const META = { ip: null, userAgent: 'cargo-threads.integration' };
const APP = 'https://gsr.cargo-threads.test';
let seq = 0;
let chatSeq = 6_600_000_000 + Math.floor(Math.random() * 1_000_000);
let msgSeq = 70_000;

type Person = ThreadReader & {
  fullName: string;
  chat: bigint | null;
  roles: string[];
  permissions: Set<string>;
  roleGrants: ReadonlyMap<string, ReadonlySet<string>>;
};
type Wh = { id: string; code: string };

const W = {} as Record<'w0' | 'w1' | 'w2' | 'w3' | 'w4' | 'w6' | 'w7', Wh>;
const P = {} as Record<
  | 'logist'
  | 'logist2'
  | 'admin'
  | 'superAdmin'
  | 'seller'
  | 'ved'
  | 'accountant'
  | 'viewer'
  | 'opW0'
  | 'opW1'
  | 'mgrW1'
  | 'wang'
  | 'opW2'
  | 'opW3'
  | 'logistAtW1'
  | 'logistAtW3'
  | 'thinW1'
  | 'unscopedRowW1'
  | 'unlinkedW6'
  | 'mutedW6',
  Person
>;
const madeUsers: string[] = [];
const madeRoles: string[] = [];
const madeReceipts: string[] = [];
const madeTrucks: string[] = [];
const madeClients: string[] = [];
const madeAttachments: string[] = [];
let clientId = '';
const prevAppUrl = process.env.APP_URL;

const ctx = () => ({ actorId: P.logist.id, ip: null, userAgent: 'cargo-threads.integration' });

async function mintWarehouse(code: string, country: string, type = 'hub'): Promise<Wh> {
  const [row] = await db
    .insert(warehouses)
    .values({ code, name: `Savol ${code}`, country, type, timezone: 'Asia/Tashkent', batchPrefix: code })
    .returning({ id: warehouses.id, code: warehouses.code });
  return row!;
}

async function inventRole(code: string, scoped: boolean, grants: string[]): Promise<void> {
  const [role] = await db
    .insert(roles)
    .values({ code, name: `Savol ${code}`, isSystem: false, warehouseScoped: scoped })
    .returning({ id: roles.id });
  madeRoles.push(role!.id);
  for (const grant of grants) {
    const [permission] = await db.select({ id: permissions.id }).from(permissions).where(eq(permissions.code, grant));
    await db.insert(rolePermissions).values({ roleId: role!.id, permissionId: permission!.id });
  }
}

async function mintPerson(
  label: string,
  roleCodes: string[],
  warehouseIds: string[] = [],
  opts: { locale?: string; linked?: boolean; muted?: string[] } = {},
): Promise<Person> {
  seq += 1;
  const fullName = `Savol ${label} ${S}`;
  const [user] = await db
    .insert(users)
    .values({
      phone: `+9986${S}${String(seq).padStart(2, '0')}`,
      fullName,
      passwordHash: 'x',
      locale: opts.locale ?? 'uz',
      mutedNotificationTypes: opts.muted ?? [],
    })
    .returning({ id: users.id });
  madeUsers.push(user!.id);
  for (const code of roleCodes) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code));
    await db.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
  }
  for (const warehouseId of warehouseIds) await db.insert(userWarehouses).values({ userId: user!.id, warehouseId });
  let chat: bigint | null = null;
  if (opts.linked !== false) {
    chat = BigInt((chatSeq += 1));
    await db.insert(telegramLinks).values({ userId: user!.id, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  }
  return { id: user!.id, fullName, chat, ...(await actorGrants(user!.id)) } as Person;
}

/**
 * A real confirmed prixod at `warehouseId`: a photo, one lot of `boxCount`
 * cartons — the spec's client's, or an UNCLAIMED intake under `marking`.
 */
async function makeReceipt(warehouseId: string, boxCount: number, opts: { marking?: string } = {}) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `cargo-threads-test/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: P.logist.id,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId: opts.marking ? null : clientId,
      unclaimedMarking: opts.marking ?? '',
      lots: [
        {
          id: lotId,
          productNameZh: '问答货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 40,
          boxWidthCm: 40,
          boxHeightCm: 40,
          boxWeightKg: 7,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  madeReceipts.push(receiptId);
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(asc(boxes.seqInLot));
  return { id: receiptId, lotId, boxIds: rows.map((b) => b.id), codes: rows.map((b) => b.shortCode) };
}

function scan(batchId: string, code: string) {
  return { clientEventUuid: uuidv4(), batchId, code, method: 'qr' as const, scannedAt: new Date().toISOString() };
}

/** A planned truck (approved, status forming) carrying `count` cartons of the lot. */
async function planTruck(originId: string, destId: string, lotId: string, count: number): Promise<{ id: string; code: string }> {
  const sub = await submitPlan({ originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId, boxCount: count }] }, ctx());
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
  madeTrucks.push(batch!.id);
  return { id: batch!.id, code: batch!.code };
}

async function loadAndDepart(truckId: string, codes: string[]): Promise<void> {
  for (const code of codes) {
    const [ack] = await ingestLoadScans([{ ...scan(truckId, code), addedOnSpot: false }], ctx());
    expect(ack!.result).toBe('ok');
  }
  await departBatch(truckId, ctx());
}

async function unload(truckId: string, codes: string[]): Promise<void> {
  for (const code of codes) {
    const [ack] = await ingestUnloadScans([scan(truckId, code)], ctx(), NO_DOOR);
    expect(['ok', 'auto_transfer']).toContain(ack!.result);
  }
}

/** The web action, pressed as `who`. */
async function post(who: Person, ref: { kind: 'receipt' | 'batch'; id: string }, body: string): Promise<CargoThreadState> {
  override.actor = { ...who, locale: 'uz', phone: null } as unknown as Record<string, unknown>;
  try {
    const form = new FormData();
    form.set('kind', ref.kind);
    form.set('id', ref.id);
    form.set('body', body);
    return await postCargoThreadAction({}, form);
  } finally {
    override.actor = null;
  }
}

/** A prixod's number, as `confirmReceipt` minted it. */
async function numberOf(receiptId: string): Promise<string> {
  const [row] = await db.select({ number: receipts.number }).from(receipts).where(eq(receipts.id, receiptId));
  return row!.number!;
}

/** The newest note on a card — what the last press wrote. */
async function lastNote(cardId: string): Promise<string> {
  const [row] = await db
    .select({ id: crmActivities.id })
    .from(crmActivities)
    .where(eq(crmActivities.entityId, cardId))
    .orderBy(sql`${crmActivities.createdAt} DESC`)
    .limit(1);
  return row!.id;
}

/** The pings one note produced, by its own row id. */
async function pingsOf(activityId: string) {
  return db
    .select({ userId: notifications.userId, type: notifications.type, payload: notifications.payload })
    .from(notifications)
    .where(sql`${notifications.payload} -> 'thread' ->> 'activityId' = ${activityId}`);
}
const textOf = (payload: unknown) => String((payload as { text?: unknown }).text ?? '');
const pinged = (rows: { userId: string }[], who: Person) => rows.some((row) => row.userId === who.id);

/** The Telegram landing announces OFF the poller (`void`) — wait for its rows. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let last = await read();
  for (let i = 0; i < 50 && !ok(last); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  return last;
}

/** A ping the drain SENT — its `payload.tg` is what a reply names. */
async function sentPing(who: Person, type: string, thread: { kind: string; id: string; activityId: string }): Promise<number> {
  const messageId = (msgSeq += 1);
  await db.insert(notifications).values({
    userId: who.id,
    channel: 'telegram',
    type,
    status: 'sent',
    sentAt: new Date(),
    payload: { text: 'x', thread, tg: { chatId: Number(who.chat), messageId } },
  });
  return messageId;
}

const scopedAt = (warehouseId: string) => ({ warehouseScoped: true, warehouseIds: [warehouseId] });

/** Every receipt stand section 1 saw, for section 2's subset proof. */
const receiptCases: { name: string; receiptId: string; receivingWarehouseId: string; stand: CargoStand }[] = [];
const truckCases: { name: string; ends: { originWarehouseId: string; destWarehouseId: string }; stand: CargoStand }[] = [];

async function standOfReceipt(name: string, receiptId: string): Promise<CargoStand> {
  const row = (await receiptStands([receiptId])).get(receiptId);
  expect(row, name).toBeDefined();
  receiptCases.push({ name, receiptId, receivingWarehouseId: row!.receivingWarehouseId, stand: row!.stand });
  return row!.stand;
}

async function standOfTruck(name: string, truckId: string) {
  const row = (await batchStands([truckId])).get(truckId);
  expect(row, name).toBeDefined();
  truckCases.push({ name, ends: row!.ends, stand: row!.stand });
  return row!;
}

beforeAll(async () => {
  process.env.APP_URL = APP;
  W.w0 = await mintWarehouse(`CQ0${S}`, 'CN', 'origin');
  W.w1 = await mintWarehouse(`CQ1${S}`, 'UZ');
  W.w2 = await mintWarehouse(`CQ2${S}`, 'UZ');
  W.w3 = await mintWarehouse(`CQ3${S}`, 'UZ');
  W.w4 = await mintWarehouse(`CQ4${S}`, 'UZ');
  W.w6 = await mintWarehouse(`CQ6${S}`, 'UZ');
  W.w7 = await mintWarehouse(`CQ7${S}`, 'UZ');
  await inventRole(`savol_thin_${S}`, true, ['reports.own_warehouse']);
  await inventRole(`savol_unscoped_${S}`, false, ['reports.own_warehouse']);

  P.logist = await mintPerson('logist bir', ['logist']);
  P.logist2 = await mintPerson('logist ikki', ['logist']);
  P.admin = await mintPerson('admin', ['admin']);
  P.superAdmin = await mintPerson('rahbar', ['super_admin']);
  P.seller = await mintPerson('sotuvchi', ['sales_manager']);
  P.ved = await mintPerson('ved', ['ved_manager']);
  P.accountant = await mintPerson('buxgalter', ['accountant']);
  P.viewer = await mintPerson('kuzatuvchi', ['viewer']);
  P.opW0 = await mintPerson('Yiwu skladchi', ['warehouse_operator'], [W.w0.id]);
  P.opW1 = await mintPerson('Odil skladchi', ['warehouse_operator'], [W.w1.id]);
  P.mgrW1 = await mintPerson('Botir mudir', ['warehouse_manager'], [W.w1.id]);
  P.wang = await mintPerson('Wang Lei', ['warehouse_operator'], [W.w1.id], { locale: 'zh-CN' });
  P.opW2 = await mintPerson('Jasur skladchi', ['warehouse_operator'], [W.w2.id]);
  P.opW3 = await mintPerson('Sardor skladchi', ['warehouse_operator'], [W.w3.id]);
  P.logistAtW1 = await mintPerson('Toshkent logisti', ['logist', 'warehouse_operator'], [W.w1.id]);
  P.logistAtW3 = await mintPerson('Andijon logisti', ['logist', 'warehouse_operator'], [W.w3.id]);
  P.thinW1 = await mintPerson('ingichka rol', [`savol_thin_${S}`], [W.w1.id]);
  P.unscopedRowW1 = await mintPerson('qatorli rol', [`savol_unscoped_${S}`], [W.w1.id]);
  P.unlinkedW6 = await mintPerson('ulanmagan', ['warehouse_operator'], [W.w6.id], { linked: false });
  P.mutedW6 = await mintPerson('jim', ['warehouse_operator'], [W.w6.id], { muted: ['InternalNote'] });

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `SQ${S}`, name: `Savol mijoz ${S}` })
    .returning({ id: clients.id });
  clientId = client!.id;
  madeClients.push(clientId);
}, 120_000);

afterAll(async () => {
  process.env.APP_URL = prevAppUrl;
  const cards = [...madeReceipts, ...madeTrucks, ...madeClients];
  if (cards.length) {
    const notes = await db.select({ id: crmActivities.id }).from(crmActivities).where(inArray(crmActivities.entityId, cards));
    const noteIds = notes.map((n) => n.id);
    await db.execute(sql`DELETE FROM notifications
      WHERE payload -> 'thread' ->> 'id' IN (${sql.join(cards.map((id) => sql`${id}`), sql`, `)})`);
    if (madeAttachments.length) await db.delete(attachments).where(inArray(attachments.id, madeAttachments));
    if (noteIds.length) await db.delete(crmActivities).where(inArray(crmActivities.id, noteIds));
    const mine = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${events.entityId} IN (${sql.join(cards.map((t) => sql`${t}::uuid`), sql`, `)})
              OR ${events.payload}->>'batchId' IN (${sql.join(cards.map((t) => sql`${t}`), sql`, `)})
              OR ${events.payload}->>'receiptId' IN (${sql.join(cards.map((t) => sql`${t}`), sql`, `)})`);
    if (mine.length) {
      await db.delete(notifications).where(inArray(notifications.eventId, mine.map((e) => e.id)));
      await db.delete(events).where(inArray(events.id, mine.map((e) => e.id)));
    }
  }
  if (madeUsers.length) {
    await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
    await db.execute(sql`DELETE FROM thread_reads WHERE user_id IN (${sql.join(madeUsers.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
    await db.delete(userWarehouses).where(inArray(userWarehouses.userId, madeUsers));
    await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  }
  // The invented roles are CONFIGURATION: every role screen would list them.
  if (madeRoles.length) {
    await db.delete(userRoles).where(inArray(userRoles.roleId, madeRoles));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, madeRoles));
    await db.delete(roles).where(inArray(roles.id, madeRoles));
  }
  if (madeClients.length) await db.update(clients).set({ active: false }).where(inArray(clients.id, madeClients));
  const whs = Object.values(W).map((w) => w.id);
  if (whs.length) await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, whs));
  await pgClient.end();
});

describe('1. where a prixod stands — the live pointers, then the fallbacks', () => {
  it('a shelf; a PLANNED carton stays on its origin shelf; in transit = both ends; half and half', async () => {
    const ra = await makeReceipt(W.w0.id, 1);
    expect((await standOfReceipt('shelf', ra.id)).warehouseIds).toEqual([W.w0.id]);

    const rb = await makeReceipt(W.w0.id, 2);
    await planTruck(W.w0.id, W.w1.id, rb.lotId, 2);
    const planned = await standOfReceipt('planned', rb.id);
    expect(planned.warehouseIds, 'a planned carton does NOT reach the truck’s destination').toEqual([W.w0.id]);

    const rc = await makeReceipt(W.w0.id, 2);
    const tc = await planTruck(W.w0.id, W.w1.id, rc.lotId, 2);
    await loadAndDepart(tc.id, rc.codes);
    const road = await standOfReceipt('in transit', rc.id);
    expect(road.warehouseIds).toEqual([W.w0.id, W.w1.id]);
    expect(road.places).toEqual([
      expect.objectContaining({ kind: 'road', batchId: tc.id, truckStatus: 'in_transit', boxes: 2 }),
    ]);

    const rd = await makeReceipt(W.w0.id, 2);
    const td = await planTruck(W.w0.id, W.w1.id, rd.lotId, 1);
    const [planned1] = await db.select({ code: boxes.shortCode }).from(boxes).where(eq(boxes.currentBatchId, td.id));
    await loadAndDepart(td.id, [planned1!.code]);
    const half = await standOfReceipt('half and half', rd.id);
    expect(half.warehouseIds).toEqual([W.w0.id, W.w1.id]);
    expect(half.places.map((p) => p.kind)).toEqual(['shelf', 'road']);
  }, 60_000);

  it('landed at W1 → W1', async () => {
    const re = await makeReceipt(W.w0.id, 2);
    const te = await planTruck(W.w0.id, W.w1.id, re.lotId, 2);
    await loadAndDepart(te.id, re.codes);
    await unload(te.id, re.codes);
    expect((await standOfReceipt('landed', re.id)).warehouseIds).toEqual([W.w1.id]);
  }, 60_000);

  it('nothing live: issued, shelf-lost by the stocktake, both; void and road-lost and a draft fall back to the receiving warehouse', async () => {
    const rf = await makeReceipt(W.w0.id, 2);
    await db
      .update(boxes)
      .set({ status: 'issued', currentWarehouseId: W.w1.id, currentBatchId: null })
      .where(eq(boxes.lotId, rf.lotId));
    const issued = await standOfReceipt('issued', rf.id);
    expect(issued.warehouseIds).toEqual([W.w1.id]);
    expect(issued.places).toEqual([{ kind: 'issued', warehouseId: W.w1.id, boxes: 2 }]);

    const rg = await makeReceipt(W.w0.id, 2);
    await db
      .update(boxes)
      .set({ status: 'lost', statusReason: 'inventory', currentWarehouseId: W.w1.id, currentBatchId: null })
      .where(eq(boxes.lotId, rg.lotId));
    const shelfLost = await standOfReceipt('stocktake lost', rg.id);
    expect(shelfLost.places).toEqual([{ kind: 'lost', warehouseId: W.w1.id, boxes: 2 }]);

    const rh = await makeReceipt(W.w0.id, 2);
    await db.update(boxes).set({ status: 'issued', currentWarehouseId: W.w1.id }).where(eq(boxes.id, rh.boxIds[0]!));
    await db.update(boxes).set({ status: 'lost', statusReason: 'inventory', currentWarehouseId: W.w2.id }).where(eq(boxes.id, rh.boxIds[1]!));
    expect((await standOfReceipt('issued + lost', rh.id)).warehouseIds).toEqual([W.w1.id, W.w2.id]);

    const ri = await makeReceipt(W.w0.id, 2);
    await db.update(boxes).set({ status: 'void' }).where(eq(boxes.lotId, ri.lotId));
    expect((await standOfReceipt('all void', ri.id)).places).toEqual([
      { kind: 'received', warehouseId: W.w0.id, receiptStatus: 'confirmed' },
    ]);

    const [draft] = await db
      .insert(receipts)
      .values({ warehouseId: W.w0.id, status: 'draft', createdBy: P.logist.id })
      .returning({ id: receipts.id });
    madeReceipts.push(draft!.id);
    expect((await standOfReceipt('draft', draft!.id)).places).toEqual([
      { kind: 'received', warehouseId: W.w0.id, receiptStatus: 'draft' },
    ]);

    const rl = await makeReceipt(W.w0.id, 1);
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, rl.id));
    await db.update(boxes).set({ status: 'void' }).where(eq(boxes.lotId, rl.lotId));
    expect((await standOfReceipt('voided', rl.id)).places).toEqual([
      { kind: 'received', warehouseId: W.w0.id, receiptStatus: 'voided' },
    ]);
  }, 60_000);

  it('road-lost is NEVER followed to its road-loss truck — the receiving warehouse answers', async () => {
    const rj = await makeReceipt(W.w0.id, 1);
    const tj = await planTruck(W.w0.id, W.w1.id, rj.lotId, 1);
    await loadAndDepart(tj.id, rj.codes);
    await finishUnload(tj.id, ctx(), { mayCloseWithMissing: true });
    await resolveMissing({ boxId: rj.boxIds[0]!, resolution: 'lost_in_transit', reason: 'Yo‘lda yo‘qoldi' }, ctx());
    const [box] = await db.select().from(boxes).where(eq(boxes.id, rj.boxIds[0]!));
    expect([box!.status, box!.currentWarehouseId, box!.currentBatchId]).toEqual(['lost', null, null]);
    expect((await standOfReceipt('road lost', rj.id)).places).toEqual([
      { kind: 'received', warehouseId: W.w0.id, receiptStatus: 'confirmed' },
    ]);
  }, 60_000);

  it('a live carton with neither pointer (an invariant broken on purpose) hides no fallback', async () => {
    const rm = await makeReceipt(W.w0.id, 2);
    await db.update(boxes).set({ currentWarehouseId: null, currentBatchId: null }).where(eq(boxes.id, rm.boxIds[0]!));
    await db.update(boxes).set({ status: 'issued', currentWarehouseId: W.w1.id }).where(eq(boxes.id, rm.boxIds[1]!));
    expect((await standOfReceipt('unplaceable', rm.id)).places).toEqual([{ kind: 'issued', warehouseId: W.w1.id, boxes: 1 }]);
  }, 60_000);
});

describe('3. the cargo door over minted people', () => {
  it('the office and the W1 staff read a W1 prixod; W2 staff, the seller, the VED, the accountant and the viewer do not', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    const ref = { kind: 'receipt' as const, id: r.id };
    const answers = Object.fromEntries(
      await Promise.all(
        (
          ['logist', 'admin', 'superAdmin', 'opW1', 'mgrW1', 'opW2', 'seller', 'ved', 'accountant', 'viewer', 'thinW1', 'unscopedRowW1'] as const
        ).map(async (key) => [key, await mayReadThread(P[key], ref)] as const),
      ),
    );
    expect(answers).toEqual({
      logist: true,
      admin: true,
      superAdmin: true,
      opW1: true,
      mgrW1: true,
      opW2: false,
      seller: false,
      ved: false,
      accountant: false,
      viewer: false,
      // The arm is the SCOPE: an invented scoped role with no plans grant reads…
      thinW1: true,
      // …and an unscoped role holding a W1 assignment does not.
      unscopedRowW1: false,
    });
  }, 60_000);

  it('a logist SCOPED at W1 reads where the cargo stands at W1 — never through the card door’s wider arms', async () => {
    const atW1 = await makeReceipt(W.w1.id, 1);
    expect(await mayReadThread(P.logistAtW1, { kind: 'receipt', id: atW1.id })).toBe(true);

    const left = await makeReceipt(W.w1.id, 1);
    await db.update(boxes).set({ currentWarehouseId: W.w2.id }).where(eq(boxes.lotId, left.lotId));
    expect(await mayReadReceipt(P.logistAtW1, { id: left.id, warehouseId: W.w1.id }), 'the card admits him').toBe(true);
    expect(await mayReadThread(P.logistAtW1, { kind: 'receipt', id: left.id })).toBe(false);

    const plannedHere = await makeReceipt(W.w0.id, 1);
    await planTruck(W.w0.id, W.w1.id, plannedHere.lotId, 1);
    expect(
      await mayReadReceipt(P.logistAtW1, { id: plannedHere.id, warehouseId: W.w0.id }),
      'the card admits him through the planned truck’s destination',
    ).toBe(true);
    expect(await mayReadThread(P.logistAtW1, { kind: 'receipt', id: plannedHere.id })).toBe(false);
  }, 60_000);

  it('threadDoorsFor answers a mixed batch of refs for a W1 operator', async () => {
    const atW1 = await makeReceipt(W.w1.id, 1);
    const atW2 = await makeReceipt(W.w2.id, 1);
    const onRoadLot = await makeReceipt(W.w0.id, 1);
    const onRoad = await planTruck(W.w0.id, W.w1.id, onRoadLot.lotId, 1);
    await loadAndDepart(onRoad.id, onRoadLot.codes);
    const closedLot = await makeReceipt(W.w0.id, 1);
    const closed = await planTruck(W.w0.id, W.w2.id, closedLot.lotId, 1);
    await loadAndDepart(closed.id, closedLot.codes);
    await unload(closed.id, closedLot.codes);
    await db.execute(sql`UPDATE batches SET status = 'closed' WHERE id = ${closed.id}::uuid`);
    const refs = [
      { kind: 'receipt' as const, id: atW1.id },
      { kind: 'receipt' as const, id: atW2.id },
      { kind: 'batch' as const, id: onRoad.id },
      { kind: 'batch' as const, id: closed.id },
    ];
    const admitted = await threadDoorsFor(P.opW1, refs);
    expect([...admitted].sort()).toEqual([`receipt:${atW1.id}`, `batch:${onRoad.id}`].sort());
  }, 60_000);
});

describe('4. E6 c — the office asks the warehouse', () => {
  it('the logist’s question reaches every W1 staffer, with the place line and the #ichki link LAST — and nobody else', async () => {
    const r = await makeReceipt(W.w1.id, 2);
    const out = await post(P.logist, { kind: 'receipt', id: r.id }, 'Ikkita karobka bormi?');
    expect(out.ok).toBe(true);
    const pings = await pingsOf(await lastNote(r.id));
    for (const who of [P.opW1, P.mgrW1]) {
      const row = pings.find((p) => p.userId === who.id && p.type === 'InternalNote');
      expect(row, who.fullName).toBeDefined();
      expect((row!.payload as { thread: unknown }).thread).toEqual({
        kind: 'receipt',
        id: r.id,
        activityId: await lastNote(r.id),
      });
      const lines = textOf(row!.payload).split('\n');
      expect(lines.at(-1)).toBe(`🔗 ${APP}/receipts/${r.id}#ichki`);
      expect(lines.find((line) => line.startsWith('📍'))).toContain(W.w1.code);
    }
    for (const who of [P.opW2, P.seller, P.ved, P.admin, P.logist]) expect(pinged(pings, who), who.fullName).toBe(false);
  }, 60_000);
});

describe('5. the warehouse asks the office — on EVERY message', () => {
  it('the operator’s message reaches the logists, not his colleague; an admin who wrote joins; every later message reaches the logists again', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    const ref = { kind: 'receipt' as const, id: r.id };
    await post(P.opW1, ref, 'Bu yuk kimniki?');
    let pings = await pingsOf(await lastNote(r.id));
    expect(pinged(pings, P.logist)).toBe(true);
    expect(pinged(pings, P.logist2)).toBe(true);
    expect(pinged(pings, P.mgrW1), 'not the other staff of his warehouse').toBe(false);
    expect(pinged(pings, P.admin), 'an admin hears by involvement').toBe(false);

    await post(P.admin, ref, 'Mijoz GS777.');
    await post(P.opW1, ref, 'Rahmat, yana bitta savol.');
    pings = await pingsOf(await lastNote(r.id));
    expect(pinged(pings, P.admin), 'a past author').toBe(true);
    expect(pinged(pings, P.logist)).toBe(true);
    expect(pinged(pings, P.logist2)).toBe(true);
    expect(pinged(pings, P.mgrW1)).toBe(false);
  }, 60_000);
});

describe('6. the internal leg — a logist scoped at W1 is staff, not office', () => {
  it('a walk-in received at W1 that landed at W2: the W2 operator’s question reaches the unscoped logists only', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    const truck = await planTruck(W.w1.id, W.w2.id, r.lotId, 1);
    await loadAndDepart(truck.id, r.codes);
    await unload(truck.id, r.codes);
    expect((await receiptStands([r.id])).get(r.id)!.stand.warehouseIds).toEqual([W.w2.id]);
    await post(P.opW2, { kind: 'receipt', id: r.id }, 'Bu karobka bizda, kimniki?');
    const pings = await pingsOf(await lastNote(r.id));
    expect(pinged(pings, P.logist)).toBe(true);
    expect(pinged(pings, P.logist2)).toBe(true);
    expect(pinged(pings, P.logistAtW1), 'the W1-scoped logist').toBe(false);
    expect(await mayReadThread(P.logistAtW1, { kind: 'receipt', id: r.id })).toBe(false);
    expect(await mayReadReceipt(P.logistAtW1, { id: r.id, warehouseId: W.w1.id }), 'the «elsewhere» line').toBe(true);
  }, 60_000);
});

describe('7. a reroute is followed by the live column', () => {
  it('the truck thread reaches the origin and the NEW destination, not the old one', async () => {
    const lot = await makeReceipt(W.w0.id, 1);
    const truck = await planTruck(W.w0.id, W.w2.id, lot.lotId, 1);
    await loadAndDepart(truck.id, lot.codes);
    await rerouteBatch(P.logist, truck.id, { destWarehouseId: W.w3.id, seenDestWarehouseId: W.w2.id, reason: 'Chegara yopiq' }, META);
    const stand = await standOfTruck('rerouted', truck.id);
    expect(stand.stand.warehouseIds).toEqual([W.w0.id, W.w3.id]);
    await post(P.logist, { kind: 'batch', id: truck.id }, 'Qachon yetadi?');
    const pings = await pingsOf(await lastNote(truck.id));
    expect(pinged(pings, P.opW0)).toBe(true);
    expect(pinged(pings, P.opW3)).toBe(true);
    expect(pinged(pings, P.opW2), 'the destination it was rerouted away from').toBe(false);
  }, 60_000);
});

describe('8. the cargo moves under the conversation (Q4 a)', () => {
  it('from W0 to the road to W1: the audience follows, the W0 operator is told in words', async () => {
    const r = await makeReceipt(W.w0.id, 2);
    const ref = { kind: 'receipt' as const, id: r.id };
    await post(P.logist, ref, 'Ikkala karobka ham shu yerdami?');
    expect(pinged(await pingsOf(await lastNote(r.id)), P.opW0)).toBe(true);
    expect((await post(P.opW0, ref, 'Ha, ikkalasi ham.')).ok).toBe(true);

    const truck = await planTruck(W.w0.id, W.w1.id, r.lotId, 2);
    await loadAndDepart(truck.id, r.codes);
    await post(P.logist, ref, 'Yo‘lga chiqdimi?');
    let pings = await pingsOf(await lastNote(r.id));
    expect(pinged(pings, P.opW0)).toBe(true);
    expect(pinged(pings, P.opW1)).toBe(true);

    await unload(truck.id, r.codes);
    await post(P.logist, ref, 'Yetib keldimi?');
    pings = await pingsOf(await lastNote(r.id));
    expect(pinged(pings, P.opW1)).toBe(true);
    expect(pinged(pings, P.opW0), 'a past author the door no longer admits').toBe(false);
    expect((await myThreads(P.opW0)).some((row) => row.kind === 'receipt' && row.id === r.id)).toBe(false);

    const before = await lastNote(r.id);
    const reply = await landThreadReply(P.opW0, {
      ref,
      ping: 'InternalNote',
      text: 'Kech javob',
      tg: { chatId: P.opW0.chat!, messageId: (msgSeq += 1) },
    });
    expect(reply.outcome).toBe('cargo_moved');
    expect(await lastNote(r.id), 'nothing was written').toBe(before);
    expect(await post(P.opW0, ref, 'Webdan ham')).toEqual({ error: 'cargo_moved' });
  }, 60_000);

  it('the intermediate warehouse — a STATED limit (an old link 404s), characterised, no red', async () => {
    const r = await makeReceipt(W.w0.id, 1);
    const ref = { kind: 'receipt' as const, id: r.id };
    const truck = await planTruck(W.w0.id, W.w1.id, r.lotId, 1);
    await loadAndDepart(truck.id, r.codes);
    await unload(truck.id, r.codes);
    await post(P.logist, ref, 'W1 da turibdimi?');
    expect(pinged(await pingsOf(await lastNote(r.id)), P.opW1)).toBe(true);
    // A second leg's end state: the cartons moved on to W2.
    await db.update(boxes).set({ currentWarehouseId: W.w2.id }).where(eq(boxes.lotId, r.lotId));
    expect(await mayReadReceipt(P.opW1, { id: r.id, warehouseId: W.w0.id }), 'his old ping opens a 404').toBe(false);
    expect((await myThreads(P.opW1)).some((row) => row.kind === 'receipt' && row.id === r.id)).toBe(false);
    const reply = await landThreadReply(P.opW1, {
      ref,
      ping: 'InternalNote',
      text: 'Bizda yo‘q',
      tg: { chatId: P.opW1.chat!, messageId: (msgSeq += 1) },
    });
    expect(reply.outcome).toBe('cargo_moved');
  }, 60_000);
});

describe('9. a truck’s stages on real trucks, and its words', () => {
  it('forming, on the road, unloaded with a missing carton, resolved, cancelled', async () => {
    const lot = await makeReceipt(W.w0.id, 2);
    const truck = await planTruck(W.w0.id, W.w1.id, lot.lotId, 2);
    let row = await standOfTruck('forming', truck.id);
    expect([row.stand.warehouseIds, truckWordOf(row.status, 0)]).toEqual([[W.w0.id], 'loading']);

    await loadAndDepart(truck.id, lot.codes);
    row = await standOfTruck('in transit', truck.id);
    expect([row.stand.warehouseIds, truckWordOf(row.status, 2)]).toEqual([[W.w0.id, W.w1.id], 'road']);

    await unload(truck.id, [lot.codes[0]!]);
    await finishUnload(truck.id, ctx(), { mayCloseWithMissing: true });
    row = await standOfTruck('unloaded, one missing', truck.id);
    expect(row.status).toBe('unloaded');
    expect(row.stand.warehouseIds).toEqual([W.w0.id, W.w1.id]);
    expect(row.stand.places[0]).toEqual(expect.objectContaining({ kind: 'truck', aboard: 1 }));
    expect(truckWordOf(row.status, 1)).toBe('missing');

    await resolveMissing({ boxId: lot.boxIds[1]!, resolution: 'lost_in_transit', reason: 'Yo‘lda yo‘qoldi' }, ctx());
    row = await standOfTruck('resolved', truck.id);
    expect([row.stand.warehouseIds, truckWordOf(row.status, 0)]).toEqual([[W.w1.id], 'arrived']);

    const lot2 = await makeReceipt(W.w0.id, 1);
    const cancelled = await planTruck(W.w0.id, W.w1.id, lot2.lotId, 1);
    await cancelBatch(cancelled.id, 'Sinov bekor', ctx());
    row = await standOfTruck('cancelled', cancelled.id);
    expect([row.status, row.stand.warehouseIds, truckWordOf(row.status, 0)]).toEqual(['cancelled', [W.w0.id], 'cancelled']);
  }, 60_000);
});

describe('2. the subset AT SEND TIME — a ping link never bounces when it is sent', () => {
  it('every warehouse of every prixod stand above opens that prixod’s card for a person scoped only there', async () => {
    expect(receiptCases.length).toBeGreaterThanOrEqual(12);
    for (const c of receiptCases) {
      for (const w of c.stand.warehouseIds) {
        expect(await mayReadReceipt(scopedAt(w), { id: c.receiptId, warehouseId: c.receivingWarehouseId }), `${c.name} @ ${w}`).toBe(
          true,
        );
      }
    }
  });

  it('every warehouse of every truck stand above — the rerouted one included — opens the truck card', () => {
    expect(truckCases.length).toBeGreaterThanOrEqual(5);
    for (const c of truckCases) {
      for (const w of c.stand.warehouseIds) expect(mayOpenBatchCard(scopedAt(w), c.ends), `${c.name} @ ${w}`).toBe(true);
    }
  });
});

describe('10. the fallback audiences', () => {
  it('issued at W1 → W1’s staff, not the receiving W0’s; shelf-lost at W1 → W1’s; voided → the receiving warehouse’s', async () => {
    const issued = await makeReceipt(W.w0.id, 1);
    await db
      .update(boxes)
      .set({ status: 'issued', currentWarehouseId: W.w1.id, currentBatchId: null })
      .where(eq(boxes.lotId, issued.lotId));
    await post(P.logist, { kind: 'receipt', id: issued.id }, 'Kim olib ketdi?');
    let pings = await pingsOf(await lastNote(issued.id));
    expect(pinged(pings, P.opW1)).toBe(true);
    expect(pinged(pings, P.opW0)).toBe(false);

    const lost = await makeReceipt(W.w0.id, 1);
    await db
      .update(boxes)
      .set({ status: 'lost', statusReason: 'inventory', currentWarehouseId: W.w1.id, currentBatchId: null })
      .where(eq(boxes.lotId, lost.lotId));
    await post(P.logist, { kind: 'receipt', id: lost.id }, 'Qayerda yo‘qoldi?');
    pings = await pingsOf(await lastNote(lost.id));
    expect(pinged(pings, P.opW1)).toBe(true);

    const voided = await makeReceipt(W.w0.id, 1);
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, voided.id));
    await db.update(boxes).set({ status: 'void' }).where(eq(boxes.lotId, voided.lotId));
    await post(P.logist, { kind: 'receipt', id: voided.id }, 'Nega bekor qilindi?');
    pings = await pingsOf(await lastNote(voided.id));
    expect(pinged(pings, P.opW0)).toBe(true);
  }, 60_000);
});

describe('11. the Telegram landing on a cargo thread', () => {
  it('a reply lands once with its pair and pings the office; a @-named seller may reply but never sees the card', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    const ref = { kind: 'receipt' as const, id: r.id };
    await post(P.logist, ref, `@${P.seller.fullName} bu mijozning yuki qayerda turibdi?`);
    const asked = await lastNote(r.id);
    const askPings = await pingsOf(asked);
    const sellerPing = askPings.find((p) => p.userId === P.seller.id);
    expect(sellerPing?.type).toBe('MentionedInNote');
    expect(textOf(sellerPing!.payload), 'the card’s facts are not his').not.toContain('📍');
    expect(textOf(sellerPing!.payload)).not.toContain('🔗');
    const opPing = askPings.find((p) => p.userId === P.opW1.id);
    expect(textOf(opPing!.payload)).toContain('📍');

    const thread = { kind: 'receipt', id: r.id, activityId: asked };
    const replyTo = await sentPing(P.opW1, 'InternalNote', thread);
    const incoming = (msgSeq += 1);
    const reply = () =>
      threadReplyFromBot(P.opW1.chat!, { replyToMessageId: replyTo, replyToForwarded: false, text: 'TAS1 da, 2-qator', incomingMessageId: incoming });
    const label = `📦 ${await numberOf(r.id)} · SQ${S}`;
    expect((await reply())?.text).toBe(`✅ Javob kartaga yozildi: ${label}`);
    const [landed] = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM crm_activities
       WHERE entity_id = ${r.id}::uuid AND tg_chat_id = ${P.opW1.chat!.toString()}::bigint AND tg_message_id = ${incoming}`);
    expect(landed).toBeDefined();
    const officePings = await eventually(
      () => pingsOf(landed!.id),
      (rows) => pinged(rows, P.logist),
    );
    expect(pinged(officePings, P.logist)).toBe(true);
    expect((await reply())?.text).toBe('✅ Bu javob allaqachon yozilgan.');
    await new Promise((r2) => setTimeout(r2, 300));
    expect((await pingsOf(landed!.id)).length, 'no second ping set').toBe(officePings.length);

    const mentionTo = await sentPing(P.seller, 'MentionedInNote', thread);
    const sellerReply = await threadReplyFromBot(P.seller.chat!, {
      replyToMessageId: mentionTo,
      replyToForwarded: false,
      text: 'Mijoz ertaga oladi',
      incomingMessageId: (msgSeq += 1),
    });
    // A prixod's label is its identity — the same words for a door-less replier.
    expect(sellerReply?.text, 'E2 a: the named person replies').toBe(`✅ Javob kartaga yozildi: ${label}`);
    expect((await myThreads(P.seller)).some((row) => row.kind === 'receipt' && row.id === r.id)).toBe(false);

    const plainTo = await sentPing(P.seller, 'InternalNote', thread);
    const refused = await threadReplyFromBot(P.seller.chat!, {
      replyToMessageId: plainTo,
      replyToForwarded: false,
      text: 'yana',
      incomingMessageId: (msgSeq += 1),
    });
    expect(refused?.text).toBe('Bu kartani endi ocha olmaysiz — javob yozilmadi.');
  }, 60_000);

  it('a photo sent as a reply to a cargo ping is told the cargo sentence; to a client-card ping, the card one', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    await post(P.logist, { kind: 'receipt', id: r.id }, 'Karobkaning rasmi kerak');
    const cargoTo = await sentPing(P.opW1, 'InternalNote', { kind: 'receipt', id: r.id, activityId: await lastNote(r.id) });
    const cardTo = await sentPing(P.seller, 'InternalNote', { kind: 'client', id: clientId, activityId: uuidv4() });
    // The bot's own context, reduced to what `refuseMediaReply` reads: a reply
    // to one of the bot's own messages, and a `reply` that records the words.
    const media = async (chat: bigint, replyTo: number) => {
      const said: string[] = [];
      const bot = { id: 7_000_001 };
      const ctx = {
        me: bot,
        message: { photo: [{ file_id: 'x' }], reply_to_message: { message_id: replyTo, from: bot } },
        reply: async (text: string) => {
          said.push(text);
        },
      } as unknown as Context;
      return { handled: await refuseMediaReply(ctx, chat), said };
    };
    expect(await media(P.opW1.chat!, cargoTo)).toEqual({ handled: true, said: [REPLY_SENTENCES.mediaCargo] });
    expect(await media(P.seller.chat!, cardTo)).toEqual({ handled: true, said: [REPLY_SENTENCES.mediaCard] });
  }, 60_000);
});

describe('12. the dock', () => {
  it('a pinged operator lists the prixod thread, new until he reads it; the logist lists the truck thread by its route', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    const ref = { kind: 'receipt' as const, id: r.id };
    await post(P.logist, ref, 'Dok uchun savol');
    let row = (await myThreads(P.opW1)).find((x) => x.kind === 'receipt' && x.id === r.id);
    expect(row?.href).toBe(`/receipts/${r.id}#ichki`);
    expect(row?.label).toBe(`📦 ${await numberOf(r.id)} · SQ${S}`);
    expect(row?.unread).toBe(true);
    const [mark] = await threadReadMarks([ref]);
    await markThreadRead(P.opW1.id, ref, mark!.asOf!);
    row = (await myThreads(P.opW1)).find((x) => x.kind === 'receipt' && x.id === r.id);
    expect(row?.unread).toBe(false);

    const lot = await makeReceipt(W.w0.id, 1);
    const truck = await planTruck(W.w0.id, W.w1.id, lot.lotId, 1);
    await loadAndDepart(truck.id, lot.codes);
    await post(P.logist, { kind: 'batch', id: truck.id }, 'Mashina qayerda?');
    const truckRow = (await myThreads(P.logist)).find((x) => x.kind === 'batch' && x.id === truck.id);
    expect(truckRow?.label).toBe(`🚚 ${truck.code} · ${W.w0.code} → ${W.w1.code}`);
    expect(truckRow?.href).toBe(`/batches/${truck.id}#ichki`);
  }, 60_000);

  it('a prixod is named the way its box says it: the marking big, else the client code — an empty marking is no marking', async () => {
    const unclaimed = await makeReceipt(W.w1.id, 1, { marking: `MK${S}` });
    // Claimed later: `assignReceiptClient` KEEPS the marking (round 98), so both stand.
    const claimed = await makeReceipt(W.w1.id, 1, { marking: `MKC${S}` });
    await db.update(receipts).set({ clientId }).where(eq(receipts.id, claimed.id));
    // An empty marking beside a client — an old row's shape; it must not print «📦 R · ».
    const blank = await makeReceipt(W.w1.id, 1);
    await db.update(receipts).set({ unclaimedMarking: '  ' }).where(eq(receipts.id, blank.id));
    const refs = [unclaimed, claimed, blank].map((x) => ({ kind: 'receipt' as const, id: x.id }));
    const labels = await threadLabels(refs);
    expect(labels.get(`receipt:${unclaimed.id}`)?.label).toBe(`📦 ${await numberOf(unclaimed.id)} · MK${S}`);
    expect(labels.get(`receipt:${claimed.id}`)?.label).toBe(`📦 ${await numberOf(claimed.id)} · MKC${S}`);
    expect(labels.get(`receipt:${blank.id}`)?.label).toBe(`📦 ${await numberOf(blank.id)} · SQ${S}`);
  }, 60_000);
});

describe('13. the half-applied deploy (0129 not landed yet)', () => {
  async function errorOf(statement: ReturnType<typeof sql>): Promise<unknown> {
    try {
      await db.execute(statement);
    } catch (err) {
      return err;
    }
    throw new Error('the statement did not fail');
  }

  it('a 23514 on the two widened CHECKs is «behind»; the pair CHECK is a real fault; the action and the bot say so in words', async () => {
    const entityErr = await errorOf(sql`
      INSERT INTO crm_activities (id, entity_type, entity_id, kind, note)
      VALUES (${uuidv4()}::uuid, 'shipment', ${uuidv4()}::uuid, 'note', 'x')`);
    expect(isThreadWriteBehind(entityErr)).toBe(true);
    const readErr = await errorOf(sql`
      INSERT INTO thread_reads (user_id, thread_kind, thread_id) VALUES (${P.logist.id}::uuid, 'shipment', ${uuidv4()}::uuid)`);
    expect(isThreadWriteBehind(readErr)).toBe(true);
    const pairErr = await errorOf(sql`
      INSERT INTO crm_activities (id, entity_type, entity_id, kind, note, tg_chat_id)
      VALUES (${uuidv4()}::uuid, 'receipt', ${uuidv4()}::uuid, 'note', 'x', 1)`);
    expect(isThreadWriteBehind(pairErr)).toBe(false);

    const r = await makeReceipt(W.w1.id, 1);
    const ref = { kind: 'receipt' as const, id: r.id };
    const errors = vi.spyOn(logger, 'error');
    override.addThreadMessage = entityErr;
    try {
      expect(await post(P.logist, ref, 'Ertalabki savol')).toEqual({ error: 'server_behind' });
      expect(errors).not.toHaveBeenCalled();
      const reply = await landThreadReply(P.opW1, {
        ref,
        ping: 'InternalNote',
        text: 'javob',
        tg: { chatId: P.opW1.chat!, messageId: (msgSeq += 1) },
      });
      expect(reply.outcome).toBe('server_behind');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      override.addThreadMessage = null;
      errors.mockRestore();
    }
  }, 60_000);
});

describe('14. the frame follows the recipient’s language; a round-1 ping does not change', () => {
  it('zh-CN and uz operators read their own frame; a client-card note to a zh-CN seller is round 1’s Uzbek', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    await post(P.logist, { kind: 'receipt', id: r.id }, 'Nechta karobka?');
    const pings = await pingsOf(await lastNote(r.id));
    const zh = pings.find((p) => p.userId === P.wang.id)!;
    expect((zh.payload as { textLocale?: unknown }).textLocale).toBe('zh-CN');
    expect(textOf(zh.payload)).toContain('📍 货物现在：');
    expect(textOf(zh.payload)).toContain('↩️ 回复');
    const uz = pings.find((p) => p.userId === P.opW1.id)!;
    expect(textOf(uz.payload)).toContain('📍 Yuk hozir:');

    const zhSeller = await mintPerson('Li sotuvchi', ['sales_manager'], [], { locale: 'zh-CN' });
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `SR${S}`, name: `Savol mijoz 2 ${S}`, salesManagerId: zhSeller.id })
      .returning({ id: clients.id });
    madeClients.push(client!.id);
    const note = await addThreadMessage({ ref: { kind: 'client', id: client!.id }, body: 'Mijoz bilan gaplashdingizmi?' }, ctx());
    await announceNote({
      entityType: note.entityType,
      entityId: note.entityId,
      note: 'Mijoz bilan gaplashdingizmi?',
      authorId: P.logist.id,
      activityId: note.activityId,
      calcRequestId: null,
    });
    const crm = (await pingsOf(note.activityId)).find((p) => p.userId === zhSeller.id)!;
    expect(crm).toBeDefined();
    expect((crm.payload as { textLocale?: unknown }).textLocale).toBeUndefined();
    expect(textOf(crm.payload)).toContain('↩️ Javob uchun shu xabarga reply qiling');
  }, 60_000);
});

describe('15. the frame on the mention path', () => {
  it('a @-named zh-CN operator’s ONLY ping is the mention — framed in his language, the link last', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    await post(P.logist, { kind: 'receipt', id: r.id }, `@${P.wang.fullName} 3 ta karobka qayerda?`);
    const mine = (await pingsOf(await lastNote(r.id))).filter((p) => p.userId === P.wang.id);
    expect(mine.map((p) => p.type)).toEqual(['MentionedInNote']);
    const text = textOf(mine[0]!.payload);
    expect((mine[0]!.payload as { textLocale?: unknown }).textLocale).toBe('zh-CN');
    expect(text).toContain('📍 货物现在：');
    expect(text).toContain('↩️ 回复');
    expect(text.split('\n').at(-1)).toBe(`🔗 ${APP}/receipts/${r.id}#ichki`);
  }, 60_000);
});

describe('16. the mention path judges the scope', () => {
  it('a W1 operator @-named on a W1 prixod gets his link; a W2 operator gets neither link nor place', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    await post(P.logist, { kind: 'receipt', id: r.id }, `@${P.opW1.fullName} va @${P.opW2.fullName}, ko‘rib chiqing`);
    const pings = await pingsOf(await lastNote(r.id));
    const w1 = pings.find((p) => p.userId === P.opW1.id)!;
    expect(w1.type).toBe('MentionedInNote');
    expect(textOf(w1.payload).split('\n').at(-1)).toBe(`🔗 ${APP}/receipts/${r.id}#ichki`);
    const w2 = pings.find((p) => p.userId === P.opW2.id)!;
    expect(w2.type).toBe('MentionedInNote');
    expect(textOf(w2.payload)).not.toContain('🔗');
    expect(textOf(w2.payload)).not.toContain('📍');
  }, 60_000);

  it('a door-less mention on a truck thread is told the truck by its code — the route goes with the «📍» line', async () => {
    const lot = await makeReceipt(W.w0.id, 1);
    const truck = await planTruck(W.w0.id, W.w1.id, lot.lotId, 1);
    await loadAndDepart(truck.id, lot.codes);
    const ref = { kind: 'batch' as const, id: truck.id };
    const route = `🚚 ${truck.code} · ${W.w0.code} → ${W.w1.code}`;
    await post(P.logist, ref, `@${P.opW2.fullName} bu mashina qachon keladi?`);
    const asked = await lastNote(truck.id);
    const pings = await pingsOf(asked);
    const w2 = pings.find((p) => p.userId === P.opW2.id)!;
    expect(w2.type).toBe('MentionedInNote');
    const text = textOf(w2.payload);
    expect(text.split('\n')[0]).toBe(`📣 ${P.logist.fullName} · 🚚 ${truck.code}`);
    // (The truck's code carries its origin's batch prefix — that is its name,
    // not the route; the destination and the arrow are the route.)
    for (const fact of ['→', W.w1.code, '📍', '🔗']) expect(text, fact).not.toContain(fact);
    // The staff where the truck stands still read the card's own label.
    const w1 = pings.find((p) => p.userId === P.opW1.id)!;
    expect(w1.type).toBe('InternalNote');
    expect(textOf(w1.payload).split('\n')[0]).toBe(`📝 ${P.logist.fullName} · ${route}`);

    // His answer's confirmation says it the way his ping did; a door-holder's keeps the route.
    const thread = { kind: 'batch', id: truck.id, activityId: asked };
    const answer = (who: Person, replyTo: number, text2: string) =>
      threadReplyFromBot(who.chat!, { replyToMessageId: replyTo, replyToForwarded: false, text: text2, incomingMessageId: (msgSeq += 1) });
    const mentionTo = await sentPing(P.opW2, 'MentionedInNote', thread);
    expect((await answer(P.opW2, mentionTo, 'Bilmayman'))?.text).toBe(`✅ Javob kartaga yozildi: 🚚 ${truck.code}`);
    const plainTo = await sentPing(P.opW1, 'InternalNote', thread);
    expect((await answer(P.opW1, plainTo, 'Ertaga keladi'))?.text).toBe(`✅ Javob kartaga yozildi: ${route}`);
  }, 60_000);
});

describe('17. what the box is told — each line one fact', () => {
  it('nobody assigned where it stands → «did not go THERE» and «nobody»; a staffed origin on the road → only «not there»', async () => {
    const lonely = await makeReceipt(W.w4.id, 1);
    const out = await post(P.logist, { kind: 'receipt', id: lonely.id }, 'Bu yerda kim bor?');
    expect(out).toEqual(
      expect.objectContaining({ ok: true, noStaffAt: [W.w4.code], nobody: true, unreachable: [], noOffice: false }),
    );

    const lot = await makeReceipt(W.w0.id, 1);
    const truck = await planTruck(W.w0.id, W.w4.id, lot.lotId, 1);
    await loadAndDepart(truck.id, lot.codes);
    const road = await post(P.logist, { kind: 'receipt', id: lot.id }, 'Yo‘lda ekanmi?');
    expect(road).toEqual(expect.objectContaining({ ok: true, noStaffAt: [W.w4.code], nobody: false }));
  }, 60_000);

  it('a mention alone is not «nobody» — the logist @-names the seller on an unstaffed prixod', async () => {
    const lonely = await makeReceipt(W.w4.id, 1);
    const out = await post(P.logist, { kind: 'receipt', id: lonely.id }, `@${P.seller.fullName} bu yerda kim bor?`);
    const pings = await pingsOf(await lastNote(lonely.id));
    expect(pings.map((p) => [p.userId === P.seller.id, p.type])).toEqual([[true, 'MentionedInNote']]);
    expect(out).toEqual(expect.objectContaining({ ok: true, noStaffAt: [W.w4.code], nobody: false }));
  }, 60_000);

  it('a read that fails AFTER the save is never «not sent» — one press, one note, ok', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    const warn = vi.spyOn(logger, 'warn');
    override.reachOf = new Error('connection reset by peer');
    let out: CargoThreadState;
    let logged: unknown[] = [];
    try {
      out = await post(P.logist, { kind: 'receipt', id: r.id }, 'Saqlangandan keyin uzildi');
      logged = warn.mock.calls.map((call) => call[1]);
    } finally {
      override.reachOf = null;
      warn.mockRestore();
    }
    expect(out).toEqual(
      expect.objectContaining({ ok: true, unreachable: [], unreachableMore: 0, noStaffAt: [], nobody: false }),
    );
    expect(logged).toContain('[thread] cargo reach check failed');
    const [notes] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM crm_activities WHERE entity_type = 'receipt' AND entity_id = ${r.id}::uuid`);
    expect(notes!.n).toBe(1);
    expect(pinged(await pingsOf(await lastNote(r.id)), P.opW1), 'the announce ran before the failed read').toBe(true);
  }, 60_000);

  it('an unlinked and a muted staffer are named with their reason; seven unlinked → five and «yana 2»', async () => {
    const r6 = await makeReceipt(W.w6.id, 1);
    const out = await post(P.logist, { kind: 'receipt', id: r6.id }, 'Kim javob beradi?');
    expect(new Set(out.unreachable)).toEqual(
      new Set([
        { name: P.unlinkedW6.fullName, reason: 'no_chat' },
        { name: P.mutedW6.fullName, reason: 'muted' },
      ]),
    );
    expect(out.unreachableMore).toBe(0);

    for (let i = 1; i <= 7; i += 1) await mintPerson(`yetti ${i}`, ['warehouse_operator'], [W.w7.id], { linked: false });
    const r7 = await makeReceipt(W.w7.id, 1);
    const seven = await post(P.logist, { kind: 'receipt', id: r7.id }, 'Hammaga savol');
    expect(seven.unreachable).toHaveLength(5);
    expect(seven.unreachableMore).toBe(2);
    expect(seven.nobody).toBe(false);
  }, 60_000);

  it('a warehouse writer whose message reached no logist is told so — and «nobody» only when nobody heard', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    const ref = { kind: 'receipt' as const, id: r.id };
    override.usersWithRoles = [P.logistAtW3.id];
    try {
      const first = await post(P.opW1, ref, 'Logistlar, savol bor');
      expect(first).toEqual(expect.objectContaining({ ok: true, noOffice: true, unreachable: [], nobody: true }));
    } finally {
      override.usersWithRoles = null;
    }
    await post(P.admin, ref, 'Men shu yerdaman');
    override.usersWithRoles = [P.logistAtW3.id];
    try {
      const second = await post(P.opW1, ref, 'Yana savol');
      expect(second).toEqual(expect.objectContaining({ ok: true, noOffice: true, nobody: false }));
    } finally {
      override.usersWithRoles = null;
    }
    const third = await post(P.opW1, ref, 'Endi logistlarga');
    expect(third).toEqual(expect.objectContaining({ ok: true, noOffice: false, nobody: false }));
  }, 60_000);
});

describe('18. the attachment gate — cargo threads are text', () => {
  it('a file on a prixod-thread note is refused to a seller (enforced) and opens for its uploader', async () => {
    const r = await makeReceipt(W.w1.id, 1);
    await post(P.opW1, { kind: 'receipt', id: r.id }, 'Rasm keyin');
    const noteId = await lastNote(r.id);
    const [file] = await db
      .insert(attachments)
      .values({
        entityType: 'crm_activity',
        entityId: noteId,
        kind: 'photo',
        storageKey: `cargo-threads-test/note-${noteId}`,
        fileName: 'x.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1,
        uploadedBy: P.opW1.id,
      })
      .returning();
    madeAttachments.push(file!.id);
    const row = { id: file!.id, entityType: 'crm_activity', entityId: noteId, uploadedBy: P.opW1.id };
    expect(await decideAttachmentRead(P.seller, row)).toEqual({ allow: false, rule: 'cargo-thread-no-files', enforce: true });
    expect(await decideAttachmentRead(P.opW1, row)).toEqual({ allow: true, rule: 'uploader' });
  }, 60_000);
});
