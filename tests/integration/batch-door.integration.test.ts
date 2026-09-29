import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The truck actions' door, PRESSED (docs/CARD-TABS.md, «Holes found on the
 * way»). The actions call `authorize`, which reads the session, so this file
 * stands in for three things and nothing else — the session, Next's cache and
 * the model: the actors are the seeded demo people with their real roles and
 * warehouses, read by the real `getActor`; the trucks, prixods and phones are
 * rows; the actions are the ones the buttons call. A service-level test of a
 * form-fed path proves the service, not the system (#531).
 *
 * The stand-in model COUNTS its calls — spending the AI budget on a lot of
 * somebody else's truck was half of the TNVED hole.
 *
 * What it leaves behind is the audit rows the presses wrote (audit_log refuses
 * DELETE), naming the demo people and warehouses; every row it made goes.
 */

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
const model = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'batch-door.integration' }),
}));
// revalidatePath needs the request store of a real Next request and throws
// without one; what it would invalidate is not this file's question.
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/wms/tnved/service', async (original) => ({
  ...(await original<typeof import('@/modules/wms/tnved/service')>()),
  suggestTnved: async (input: { nameZh: string }) => {
    model.calls.push(input.nameZh);
    return { tnved_code: '6109100000', name_ru: 'Футболка', confidence: 'high', reasoning: 'test' };
  },
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clients,
  driverDevices,
  receiptLots,
  receipts,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { AuthError } from '@/modules/platform/rbac/authorize';
import {
  createDriverDeviceAction,
  revokeDriverDeviceAction,
  setCustomsClearedAction,
  setCustomsFirmAction,
  setProfitTrackedAction,
  setReceiptCustomsAction,
  setSentToAgentAction,
  setTrackingCheckpointAction,
} from '@/app/(protected)/batches/batch-actions-server';
import { suggestTnvedForLotAction } from '@/app/(protected)/batches/[id]/tnved/actions';

const SUFFIX = String(Date.now()).slice(-6);
const NOWHERE = '00000000-0000-4000-8000-0000000b0d00';

/** The seeded demo people (scripts/seed-demo.ts) — real roles, real warehouses. */
const PHONES = {
  /** Wang Lei, warehouse_operator, scoped to Yiwu — the truck's ORIGIN. */
  yw: '+998900000006',
  /** Karim, warehouse_operator, scoped to Kashgar — the truck's DESTINATION. */
  ka: '+998900000008',
  /** Li Na, warehouse_operator, scoped to Guangzhou — a THIRD warehouse. */
  gz: '+998900000007',
  /** Unscoped; holds batches.vehicle_info and plans.manage. */
  logist: '+998900000003',
  /** ved_manager, unscoped. */
  ved: '+998900000004',
  /** accountant — finance.reports, unscoped. */
  accountant: '+998900000010',
} as const;
type Person = keyof typeof PHONES;

const people = new Map<Person, typeof users.$inferSelect>();
const wh: Record<'YW' | 'KA' | 'GZ' | 'AND' | 'TAS1', string> = { YW: '', KA: '', GZ: '', AND: '', TAS1: '' };
/** YW → KA: two of the three operators stand at one of its ends. */
let truck = '';
/** GZ → AND: a truck neither of them can open. */
let otherTruck = '';
/**
 * YW → TAS1, the through road via Kashgar and Kyrgyzstan: the truck the
 * pins are pressed on. YW → KA ends in China, so since the Horgos round its
 * road carries NO pin at all (`checkpointsFor`) — it is the not-on-route
 * proof instead.
 */
let pinTruck = '';
let clientId = '';
let receiptOn = '';
let receiptOff = '';
let lotOn = '';
let lotOff = '';
let otherPhone = '';
const madeBoxes: string[] = [];

function signIn(person: Person) {
  const row = people.get(person)!;
  session.user = {
    id: row.id,
    phone: row.phone,
    username: row.username,
    fullName: row.fullName,
    locale: row.locale,
    active: true,
    sessionId: NOWHERE,
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/**
 * `null` when the press went through, else the refusal's code — thrown as
 * authorize's `AuthError`, or RETURNED in words by an action that answers its
 * refusals (the map pin, since the Horgos round: `{ error }`).
 */
async function refusal(press: Promise<unknown>): Promise<string | null> {
  try {
    const answer = await press;
    if (answer && typeof answer === 'object' && 'error' in answer) {
      return String((answer as { error: unknown }).error);
    }
    return null;
  } catch (err) {
    if (err instanceof AuthError) return err.code;
    throw err;
  }
}

const truckRow = async (id = truck) => (await db.query.batches.findFirst({ where: eq(batches.id, id) }))!;
const pinOf = async (id = pinTruck) =>
  ((await truckRow(id)).trackingCheckpoint as { key?: string } | null)?.key ?? null;

beforeAll(async () => {
  for (const code of Object.keys(wh) as (keyof typeof wh)[]) {
    const row = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    expect(row, `demo warehouse ${code}`).toBeDefined();
    wh[code] = row!.id;
  }
  for (const [person, phone] of Object.entries(PHONES) as [Person, string][]) {
    const row = await db.query.users.findFirst({ where: eq(users.phone, phone) });
    expect(row, `demo person ${person}`).toBeDefined();
    people.set(person, row!);
  }
  // The premise, read off the rows rather than assumed: the three operators
  // stand where this file says they stand.
  for (const [person, code] of [['yw', 'YW'], ['ka', 'KA'], ['gz', 'GZ']] as const) {
    const rows = await db
      .select({ id: userWarehouses.warehouseId })
      .from(userWarehouses)
      .where(eq(userWarehouses.userId, people.get(person)!.id));
    expect(rows.map((r) => r.id), person).toEqual([wh[code]]);
  }

  const author = people.get('logist')!.id;
  [truck, otherTruck, pinTruck] = (
    await db
      .insert(batches)
      .values([
        {
          code: `ESH${SUFFIX}-1`,
          originWarehouseId: wh.YW,
          destWarehouseId: wh.KA,
          status: 'in_transit',
          departedAt: new Date(),
          createdBy: author,
        },
        {
          code: `ESH${SUFFIX}-2`,
          originWarehouseId: wh.GZ,
          destWarehouseId: wh.AND,
          status: 'in_transit',
          departedAt: new Date(),
          createdBy: author,
        },
        {
          code: `ESH${SUFFIX}-3`,
          originWarehouseId: wh.YW,
          destWarehouseId: wh.TAS1,
          status: 'in_transit',
          departedAt: new Date(),
          createdBy: author,
        },
      ])
      .returning({ id: batches.id })
  ).map((row) => row.id) as [string, string, string];

  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `ESH${SUFFIX}`, name: `Eshik mijoz ${SUFFIX}` })
      .returning({ id: clients.id })
  )[0]!.id;
  [receiptOn, receiptOff] = (
    await db
      .insert(receipts)
      .values([
        { warehouseId: wh.YW, clientId, status: 'confirmed', createdBy: author },
        { warehouseId: wh.GZ, clientId, status: 'confirmed', createdBy: author },
      ])
      .returning({ id: receipts.id })
  ).map((row) => row.id) as [string, string];
  [lotOn, lotOff] = (
    await db
      .insert(receiptLots)
      .values(
        [receiptOn, receiptOff].map((receiptId, i) => ({
          receiptId,
          seq: 1,
          productNameZh: `${i === 0 ? '上衣' : '裤子'}${SUFFIX}`,
          boxCount: 1,
          dimsMode: 'mixed',
          totalWeightKg: '10',
          totalVolumeM3: '0.1',
        })),
      )
      .returning({ id: receiptLots.id })
  ).map((row) => row.id) as [string, string];
  // One carton on each truck, in transit: the live pointer is what both the
  // riders (the customs rows) and the manifest (the TNVED lots) read before
  // the truck lands.
  const rows = await db
    .insert(boxes)
    .values([
      { lotId: lotOn, shortCode: `ESHA${SUFFIX}`, seqInLot: 1, status: 'in_transit', currentBatchId: truck },
      { lotId: lotOff, shortCode: `ESHB${SUFFIX}`, seqInLot: 1, status: 'in_transit', currentBatchId: otherTruck },
    ] as (typeof boxes.$inferInsert)[])
    .returning({ id: boxes.id });
  madeBoxes.push(...rows.map((row) => row.id));

  otherPhone = (
    await db
      .insert(driverDevices)
      .values({ batchId: otherTruck, label: `Boshqa fura ${SUFFIX}`, createdBy: author })
      .returning({ id: driverDevices.id })
  )[0]!.id;
});

afterAll(async () => {
  session.user = null;
  // Children first (the phones, cartons, lots and prixods all point up).
  const trucks = [truck, otherTruck, pinTruck].filter(Boolean);
  if (trucks.length) await db.delete(driverDevices).where(inArray(driverDevices.batchId, trucks));
  if (madeBoxes.length) await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  const lots = [lotOn, lotOff].filter(Boolean);
  if (lots.length) await db.delete(receiptLots).where(inArray(receiptLots.id, lots));
  const made = [receiptOn, receiptOff].filter(Boolean);
  if (made.length) await db.delete(receipts).where(inArray(receipts.id, made));
  if (clientId) await db.delete(clients).where(eq(clients.id, clientId));
  if (trucks.length) await db.delete(batches).where(inArray(batches.id, trucks));
  await pgClient.end();
});

describe('the map pin — batches.vehicle_info, which the seed gives to SCOPED roles', () => {
  const pin = (key: string, batchId = pinTruck) =>
    setTrackingCheckpointAction(null, form({ batchId, key }));

  // The destination-operator case («a trip belongs to both ends») left this
  // file with the Horgos round: its truck ended at Kashgar, whose road
  // carries no pin, and the demo has no Tashkent operator to stand at the far
  // end of a truck that does. The two-end rule itself is the card door's and
  // stays proven over every seeded role in tests/unit/batch-authorize.test.ts.

  it('the operator at the truck’s origin moves it', async () => {
    signIn('yw');
    expect(await refusal(pin('at_border'))).toBeNull();
    expect(await pinOf()).toBe('at_border');
  });

  it('an operator at a third warehouse is refused, and the customer’s stage stays where it was', async () => {
    signIn('gz');
    expect(await refusal(pin('in_uz'))).toBe('forbidden');
    expect(await pinOf()).toBe('at_border');
  });

  it('the logist, who is scoped to nothing, is admitted on any truck', async () => {
    signIn('logist');
    expect(await refusal(pin('in_uz'))).toBeNull();
    expect(await pinOf()).toBe('in_uz');
  });

  it('a pin the truck’s road does not carry is refused IN WORDS, and nothing is written', async () => {
    // YW → KA ends in China: no border, no Kyrgyzstan, no Uzbekistan on it.
    signIn('logist');
    expect(await refusal(pin('at_border', truck))).toBe('not_on_route');
    expect(await pinOf(truck)).toBeNull();
  });
});

describe('the driver’s phone', () => {
  const phonesOn = async (id: string) =>
    db.select().from(driverDevices).where(eq(driverDevices.batchId, id));

  it('an operator at a third warehouse cannot mint a pairing code for the truck', async () => {
    signIn('gz');
    expect(await refusal(createDriverDeviceAction(form({ batchId: truck, label: 'x' })))).toBe('forbidden');
    expect(await phonesOn(truck)).toHaveLength(0);
  });

  it('the operator at its origin can', async () => {
    signIn('yw');
    expect(await refusal(createDriverDeviceAction(form({ batchId: truck, label: `Redmi ${SUFFIX}` })))).toBeNull();
    expect(await phonesOn(truck)).toHaveLength(1);
  });

  it('another truck’s phone cannot be revoked through this truck’s door, and it keeps working', async () => {
    signIn('yw');
    const press = revokeDriverDeviceAction(form({ deviceId: otherPhone, batchId: truck }));
    expect(await refusal(press)).toBe('forbidden');
    const row = await db.query.driverDevices.findFirst({ where: eq(driverDevices.id, otherPhone) });
    expect(row!.revokedAt).toBeNull();
  });

  it('the truck’s own phone is revoked', async () => {
    signIn('yw');
    const [own] = await phonesOn(truck);
    expect(await refusal(revokeDriverDeviceAction(form({ deviceId: own!.id, batchId: truck })))).toBeNull();
    const row = await db.query.driverDevices.findFirst({ where: eq(driverDevices.id, own!.id) });
    expect(row!.revokedAt).not.toBeNull();
  });
});

describe('the VED’s papers on the truck', () => {
  const customsOf = async (id: string) =>
    (await db.query.receipts.findFirst({ where: eq(receipts.id, id) }))!.customsByClient;

  it('per-prixod customs refuses a prixod that does not ride the truck, and writes nothing', async () => {
    signIn('ved');
    expect(await refusal(setReceiptCustomsAction(truck, receiptOff, 'client'))).toBe('forbidden');
    expect(await customsOf(receiptOff)).toBeNull();
  });

  it('…and answers for one that does', async () => {
    signIn('ved');
    expect(await refusal(setReceiptCustomsAction(truck, receiptOn, 'client'))).toBeNull();
    expect(await customsOf(receiptOn)).toBe(true);
  });

  it('the truck-level papers still press through the new door', async () => {
    signIn('ved');
    expect(await refusal(setSentToAgentAction(form({ batchId: truck })))).toBeNull();
    expect(await refusal(setCustomsFirmAction(truck, 'client'))).toBeNull();
    expect(await refusal(setCustomsClearedAction(form({ batchId: truck })))).toBeNull();
    const row = await truckRow();
    expect(row.sentToAgentAt).not.toBeNull();
    expect(row.customsByClient).toBe(true);
    expect(row.customsClearedAt).not.toBeNull();
  });

  it('so does the «Partiya» mark, for the accountant', async () => {
    signIn('accountant');
    expect(await refusal(setProfitTrackedAction(form({ batchId: truck, tracked: '1' })))).toBeNull();
    expect((await truckRow()).profitTracked).toBe(true);
  });

  it('the permission is still asked first — an operator holds no ved.docs', async () => {
    signIn('yw');
    expect(await refusal(setCustomsClearedAction(form({ batchId: truck })))).toBe('forbidden');
    expect((await truckRow()).customsClearedAt).not.toBeNull();
  });

  it('a truck that is not there is a quiet no-op, as it always was — a garbage id included', async () => {
    signIn('ved');
    expect(await refusal(setCustomsClearedAction(form({ batchId: NOWHERE })))).toBeNull();
    expect(await refusal(setCustomsClearedAction(form({ batchId: 'not-a-truck' })))).toBeNull();
    expect(await refusal(setCustomsFirmAction(NOWHERE, 'client'))).toBeNull();
  });
});

describe('the TNVED suggestion', () => {
  it('refuses a lot that does not ride the truck, and the model is never asked', async () => {
    signIn('logist');
    model.calls.length = 0;
    expect(await suggestTnvedForLotAction(truck, lotOff)).toEqual({ ok: false, error: 'forbidden' });
    expect(model.calls).toEqual([]);
  });

  it('refuses a truck that is not there the same way', async () => {
    signIn('logist');
    model.calls.length = 0;
    expect(await suggestTnvedForLotAction(NOWHERE, lotOn)).toEqual({ ok: false, error: 'forbidden' });
    expect(model.calls).toEqual([]);
  });

  it('a lot that is not there still answers «not found», as it always did', async () => {
    signIn('logist');
    model.calls.length = 0;
    expect(await suggestTnvedForLotAction(truck, NOWHERE)).toEqual({ ok: false, error: 'not_found' });
    expect(model.calls).toEqual([]);
  });

  it('answers for a lot on the truck', async () => {
    signIn('logist');
    model.calls.length = 0;
    const answer = await suggestTnvedForLotAction(truck, lotOn);
    expect(answer.ok).toBe(true);
    expect(answer.suggestion?.tnved_code).toBe('6109100000');
    expect(model.calls).toEqual([`上衣${SUFFIX}`]);
  });

  it('a person without the permission is refused before the truck is read', async () => {
    signIn('yw');
    model.calls.length = 0;
    expect(await suggestTnvedForLotAction(truck, lotOn)).toEqual({ ok: false, error: 'forbidden' });
    expect(model.calls).toEqual([]);
  });
});
