import 'dotenv/config';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clients,
  customFields,
  customFieldValues,
  receiptLots,
  receipts,
  tgMessages,
  tgOutbox,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { decideAttachmentRead } from '@/modules/wms/attachments/access';

/**
 * GET /api/attachments/[id] authenticated but never authorized: any staff
 * session could fetch ANY file by uuid — Telegram chat photos and CRM note
 * files included. The mapping under the (for now log-only) gate is the
 * predicate tested here, per #166: real function, real owning rows.
 */

const STAMP = Date.now();
let uploaderId: string;
let ywId: string;
let twId: string;
let lotId: string;
let tgMessageId: string;
let boundGroupId: string;

/** The shape the route hands the decision — permissions and scope only. */
const actor = (
  permissions: string[],
  opts: { id?: string; scoped?: boolean; warehouses?: string[] } = {},
) => ({
  id: opts.id ?? uuidv4(),
  permissions: new Set(permissions),
  warehouseScoped: opts.scoped ?? false,
  warehouseIds: opts.warehouses ?? [],
});

const att = (entityType: string, entityId: string) => ({
  id: uuidv4(),
  entityType,
  entityId,
  uploadedBy: uploaderId,
});

beforeAll(async () => {
  uploaderId = (await db.select().from(users).limit(1))[0]!.id;

  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({
        code,
        name: `AA ${code}`,
        country: 'CN',
        type: 'origin',
        timezone: 'Asia/Shanghai',
        batchPrefix: code,
      })
      .returning();
    return wh!.id;
  }
  ywId = await ensureWarehouse('AAYW');
  twId = await ensureWarehouse('AATW');

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `AA${STAMP}`.slice(0, 12), name: `Access ${STAMP}` })
    .returning();

  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: ywId, clientId: client!.id, status: 'confirmed', createdBy: uploaderId })
    .returning();
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      productNameZh: '测试货',
      boxCount: 1,
      totalWeightKg: '5',
      totalVolumeM3: '0.027',
    })
    .returning();
  lotId = lot!.id;

  const [tg] = await db
    .insert(tgMessages)
    .values({
      clientId: client!.id,
      managerUserId: uploaderId,
      peerId: BigInt(STAMP),
      tgMessageId: 777n,
      direction: 'in',
      body: 'rasm',
      sentAt: new Date(),
    })
    .returning();
  tgMessageId = tg!.id;

  // A file-typed field on DEALS, with its value bound to a record.
  const [field] = await db
    .insert(customFields)
    .values({ entityType: 'deal', label: `AA fayl ${STAMP}`, type: 'file' })
    .returning();
  boundGroupId = uuidv4();
  await db.insert(customFieldValues).values({
    fieldId: field!.id,
    entityType: 'deal',
    entityId: uuidv4(),
    valueRef: boundGroupId,
  });
});

afterAll(async () => {
  await pgClient.end();
});

describe("telegram chat photos follow the thread's own-account rule (2026-07-29)", () => {
  // The uploader short-circuit would mask the branch under test, so the file
  // is "uploaded" by a third party (the listener writes these rows anyway).
  const tgAtt = (entityId: string) => ({
    id: uuidv4(),
    entityType: 'tg_message',
    entityId,
    uploadedBy: uuidv4(),
  });

  it('a viewer holding only report permissions is refused, for real', async () => {
    const decision = await decideAttachmentRead(
      actor(['reports.all_warehouses']),
      tgAtt(tgMessageId),
    );
    expect(decision).toEqual({ allow: false, rule: 'tg-no-permission', enforce: true });
  });

  it("permission alone no longer opens a colleague's chat photo — the leak the owner reported", async () => {
    // crm.leads or clients.manage used to be enough; now the photo reads only
    // for the manager whose Telegram the message lives in.
    expect(
      await decideAttachmentRead(actor(['crm.leads']), tgAtt(tgMessageId)),
    ).toEqual({ allow: false, rule: 'tg-not-own-account', enforce: true });
    expect(
      await decideAttachmentRead(actor(['clients.manage']), tgAtt(tgMessageId)),
    ).toEqual({ allow: false, rule: 'tg-not-own-account', enforce: true });

    // The manager themselves still reads their own thread's photo.
    const own = await decideAttachmentRead(
      actor(['crm.leads'], { id: uploaderId }),
      tgAtt(tgMessageId),
    );
    expect(own).toEqual({ allow: true, rule: 'tg-own-thread' });

    // And the BOSS reads everyone's (round 21): the super_admin role is the
    // supervision view, same rule as the screens' tgViewerFor.
    const boss = await decideAttachmentRead(
      { ...actor(['crm.leads']), roles: ['super_admin'] },
      tgAtt(tgMessageId),
    );
    expect(boss).toEqual({ allow: true, rule: 'tg-own-thread' });
  });

  it('the widened supervision view reads too — vedchi and admin (round 33)', async () => {
    // The vedchi holds NEITHER CRM grant, and that is the point: the calc
    // files arrive in whichever manager's chat the client uses, and a photo
    // URL must open exactly as far as the screens do.
    const ved = await decideAttachmentRead(
      { ...actor(['ved.docs']), roles: ['ved_manager'] },
      tgAtt(tgMessageId),
    );
    expect(ved).toEqual({ allow: true, rule: 'tg-own-thread' });

    const admin = await decideAttachmentRead(
      { ...actor([]), roles: ['admin'] },
      tgAtt(tgMessageId),
    );
    expect(admin).toEqual({ allow: true, rule: 'tg-own-thread' });

    // A warehouse actor with an invented role gains nothing.
    expect(
      await decideAttachmentRead({ ...actor(['scan.load']), roles: ['x_custom'] }, tgAtt(tgMessageId)),
    ).toEqual({ allow: false, rule: 'tg-no-permission', enforce: true });
  });

  it('a message row that does not exist is an orphan, not a pass', async () => {
    const decision = await decideAttachmentRead(actor(['crm.leads']), tgAtt(uuidv4()));
    expect(decision).toEqual({ allow: false, rule: 'orphan', enforce: true });
  });
});

describe('queued outgoing photos mirror the same gate', () => {
  it('a viewer is refused, crm reads it, a missing queue row is an orphan', async () => {
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `AO${STAMP}`.slice(0, 12), name: `Access out ${STAMP}` })
      .returning();
    const [queued] = await db
      .insert(tgOutbox)
      .values({
        clientId: client!.id,
        managerUserId: uploaderId,
        peerId: BigInt(STAMP + 1),
        body: 'rasm ketmoqda',
        status: 'queued',
        queuedBy: uploaderId,
      })
      .returning();
    // Same third-party uploader trick as the tg_message describe: the branch,
    // not the uploader short-circuit, must decide.
    const outAtt = (entityId: string) => ({
      id: uuidv4(),
      entityType: 'tg_outbox',
      entityId,
      uploadedBy: uuidv4(),
    });
    expect(
      await decideAttachmentRead(actor(['reports.all_warehouses']), outAtt(queued!.id)),
    ).toEqual({ allow: false, rule: 'tg-no-permission', enforce: true });
    // A colleague with the permission is still not the account it leaves from.
    expect(await decideAttachmentRead(actor(['crm.leads']), outAtt(queued!.id))).toEqual({
      allow: false,
      rule: 'tg-not-own-account',
      enforce: true,
    });
    // The manager it goes out from reads it.
    expect(
      (await decideAttachmentRead(actor(['crm.leads'], { id: uploaderId }), outAtt(queued!.id)))
        .allow,
    ).toBe(true);
    expect(await decideAttachmentRead(actor(['crm.leads']), outAtt(uuidv4()))).toEqual({
      allow: false,
      rule: 'orphan',
      enforce: true,
    });

    // A QUEUED outbox row for the primary manager is not inert leftovers —
    // the outbox spec's claimNext would pick it up as a real job (#154). It
    // only ever survived because the file ordering happened to run outbox
    // first; clean it here where it was made.
    await db.delete(tgOutbox).where(eq(tgOutbox.id, queued!.id));
    await db.delete(clients).where(eq(clients.id, client!.id));
  });
});

describe('receipt photos follow the warehouse scope, nothing more', () => {
  it('an operator scoped to the OTHER warehouse is refused', async () => {
    const decision = await decideAttachmentRead(
      actor(['receipts.create'], { scoped: true, warehouses: [twId] }),
      att('receipt_lot', lotId),
    );
    // Round 30: a coded deny REFUSES now — the log-only period is over.
    expect(decision).toEqual({ allow: false, rule: 'out-of-scope', enforce: true });
  });

  it('an operator scoped to the receipt warehouse reads it', async () => {
    const decision = await decideAttachmentRead(
      actor(['receipts.create'], { scoped: true, warehouses: [ywId] }),
      att('receipt_lot', lotId),
    );
    expect(decision.allow).toBe(true);
  });

  it('an unscoped user reads it with no permission code — the TNVED editor traffic must not log', async () => {
    const decision = await decideAttachmentRead(actor([]), att('receipt_lot', lotId));
    expect(decision.allow).toBe(true);
  });
});

describe('a photo follows the cargo, not the desk it was received at', () => {
  /**
   * The owner, testing as the Kashgar warehouse operator: «bazi tovarlarning
   * rasimlar ochmayabti». A receipt's warehouse is where the goods were
   * RECEIVED; by the time anybody wants the photograph the box is usually
   * somewhere else, which is the entire point of the company. Measured on his
   * real data the same day: 1,362 of 4,403 goods photos were unopenable by
   * the operator standing next to the box.
   */
  let movedLotId: string;
  let transitLotId: string;
  let batchId: string;
  let strangerWhId: string;
  let receiptIds: string[] = [];
  /**
   * A counter, not the clock. #598: two calls in the same millisecond mint
   * the same client code, and the unique violation then arrives disguised —
   * see the note on the cleanup hook below.
   */
  let seq = 0;

  const makeLot = async () => {
    seq += 1;
    const [client] = await db
      .insert(clients)
      .values({ // The counter goes FIRST: `slice(0, 12)` cut it off the end and both
      // rows came out identical anyway.
      clientCode: `AC${seq}${STAMP}`.slice(0, 12), name: `Cargo ${STAMP}-${seq}` })
      .returning();
    const [receipt] = await db
      .insert(receipts)
      .values({ warehouseId: ywId, clientId: client!.id, status: 'confirmed', createdBy: uploaderId })
      .returning();
    receiptIds.push(receipt!.id);
    const [lot] = await db
      .insert(receiptLots)
      .values({
        receiptId: receipt!.id,
        seq: 1,
        productNameZh: '搬运货',
        boxCount: 1,
        totalWeightKg: '5',
        totalVolumeM3: '0.027',
      })
      .returning();
    return { lotId: lot!.id, clientId: client!.id };
  };

  beforeAll(async () => {
    // A warehouse the cargo never touched. TAKEN, not created: an extra
    // active warehouse would show up in the e2e suite's dropdowns, and
    // configuration left behind is worse than data (#183).
    // Ordered, because an unordered read is not the same read twice (#524):
    // this file runs beside others that mint warehouses of their own.
    const stranger = await db.query.warehouses.findFirst({
      where: and(eq(warehouses.active, true), notInArray(warehouses.id, [ywId, twId])),
      orderBy: (t, { asc }) => [asc(t.code)],
    });
    strangerWhId = stranger!.id;

    // (1) Received in Yiwu, standing in the other warehouse now.
    const moved = await makeLot();
    movedLotId = moved.lotId;
    await db.insert(boxes).values({
      lotId: movedLotId,
      seqInLot: 1,
      shortCode: `AAMOVED${STAMP}`.slice(0, 24),
      status: 'in_stock',
      currentWarehouseId: twId,
    });

    // (2) Received in Yiwu, on a truck heading to the other warehouse and
    // standing in NO warehouse at all — the case a plain scope check cannot
    // express.
    const transit = await makeLot();
    transitLotId = transit.lotId;
    const [batch] = await db
      .insert(batches)
      .values({
        code: `AAB${STAMP}`.slice(0, 24),
        type: 'export',
        status: 'in_transit',
        originWarehouseId: ywId,
        destWarehouseId: twId,
        createdBy: uploaderId,
      })
      .returning();
    batchId = batch!.id;
    await db.insert(boxes).values({
      lotId: transitLotId,
      seqInLot: 1,
      shortCode: `AATRANS${STAMP}`.slice(0, 24),
      status: 'in_transit',
      currentWarehouseId: null,
      currentBatchId: batchId,
    });
  });

  /**
   * Guarded, and that is not tidiness. An unguarded cleanup hook binds
   * `undefined` when the SETUP failed, postgres refuses it, and the error
   * vitest shows is the hook's — «UNDEFINED_VALUE» — with the real failure
   * nowhere on screen. That cost this fix twenty minutes.
   */
  afterAll(async () => {
    const lots = [movedLotId, transitLotId].filter(Boolean);
    if (lots.length) await db.delete(boxes).where(inArray(boxes.lotId, lots));
    if (batchId) await db.delete(batches).where(eq(batches.id, batchId));
    if (lots.length) await db.delete(receiptLots).where(inArray(receiptLots.id, lots));
    for (const id of receiptIds) await db.delete(receipts).where(eq(receipts.id, id));
    receiptIds = [];
  });

  it('the operator holding the box reads its photo, though it was received elsewhere', async () => {
    const decision = await decideAttachmentRead(
      actor(['receipts.create'], { scoped: true, warehouses: [twId] }),
      att('receipt_lot', movedLotId),
    );
    expect(decision).toEqual({ allow: true, rule: 'cargo-here' });
  });

  it('the destination reads a photo of cargo still on the truck', async () => {
    const decision = await decideAttachmentRead(
      actor(['receipts.create'], { scoped: true, warehouses: [twId] }),
      att('receipt_lot', transitLotId),
    );
    expect(decision).toEqual({ allow: true, rule: 'cargo-here' });
  });

  it('the sending warehouse keeps it too — it received the goods', async () => {
    const decision = await decideAttachmentRead(
      actor(['receipts.create'], { scoped: true, warehouses: [ywId] }),
      att('receipt_lot', movedLotId),
    );
    expect(decision.allow).toBe(true);
  });

  it('a third warehouse the cargo never touched is still refused', async () => {
    const decision = await decideAttachmentRead(
      actor(['receipts.create'], { scoped: true, warehouses: [strangerWhId] }),
      att('receipt_lot', movedLotId),
    );
    expect(decision).toEqual({ allow: false, rule: 'out-of-scope', enforce: true });
  });
});

describe('custom-field file groups follow the record they hang on', () => {
  it('a deal field admits ved.docs and refuses warehouse-only permissions', async () => {
    expect(
      (await decideAttachmentRead(actor(['ved.docs']), att('custom_field', boundGroupId))).allow,
    ).toBe(true);
    expect(
      await decideAttachmentRead(actor(['scan.load']), att('custom_field', boundGroupId)),
    ).toEqual({ allow: false, rule: 'custom_field-no-permission', enforce: true });
  });

  it('a group not yet bound to any record is uploader-only', async () => {
    const unbound = att('custom_field', uuidv4());
    expect(await decideAttachmentRead(actor(['crm.leads']), unbound)).toEqual({
      allow: false,
      rule: 'custom_field-unbound',
      enforce: true,
    });
    expect(
      (await decideAttachmentRead(actor([], { id: uploaderId }), unbound)).rule,
    ).toBe('uploader');
  });
});

describe('everything else', () => {
  it('a legacy entity type logs but does NOT enforce — old real files, not private chats', async () => {
    const legacy = att('something_legacy', uuidv4());
    // Deliberately no `enforce`: these are the free-form entity types from
    // before the upload allowlist. The warn line stays their inventory, and
    // 404ing history the code never learned to name would break real files
    // for no security gain (round 30's one stated exception).
    expect(await decideAttachmentRead(actor(['admin.users.manage']), legacy)).toEqual({
      allow: false,
      rule: 'unmapped',
    });
    expect((await decideAttachmentRead(actor([], { id: uploaderId }), legacy)).allow).toBe(true);
  });
});

describe('a partner bank receipt is company money, not a seller’s book', () => {
  it('refuses finance.view, allows the money managers', async () => {
    // The pre-go-live audit's find: this branch still asked the round-90
    // question (`finance.view || finance.manage`), and round 91 had since
    // made `finance.view` a SELLER's own-book grant. A counterparty receipt
    // names another client and a sum and belongs to no seller's book — so
    // the file must ask the same predicate its screen does (`seesAllMoney`),
    // or a scoped screen sits beside an open file, which is round 91's own
    // lesson one level down.
    const proof = att('partner_transaction', uuidv4());

    expect(await decideAttachmentRead(actor(['finance.view']), proof)).toEqual({
      allow: false,
      rule: 'partner-tx-no-permission',
      enforce: true,
    });
    expect((await decideAttachmentRead(actor(['finance.manage']), proof)).allow).toBe(true);
    expect((await decideAttachmentRead(actor(['clients.manage']), proof)).allow).toBe(true);
    // The uploader keeps their own file, as every branch allows.
    expect((await decideAttachmentRead(actor([], { id: uploaderId }), proof)).allow).toBe(true);
  });
});
