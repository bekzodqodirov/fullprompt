import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  customFields,
  customFieldValues,
  receiptLots,
  receipts,
  tgMessages,
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

describe('telegram chat photos mirror the /suhbatlar gate', () => {
  it('a viewer holding only report permissions is refused', async () => {
    const decision = await decideAttachmentRead(
      actor(['reports.all_warehouses']),
      att('tg_message', tgMessageId),
    );
    expect(decision).toEqual({ allow: false, rule: 'tg-no-permission' });
  });

  it('crm.leads reads them, clients.manage reads them', async () => {
    expect(
      (await decideAttachmentRead(actor(['crm.leads']), att('tg_message', tgMessageId))).allow,
    ).toBe(true);
    expect(
      (await decideAttachmentRead(actor(['clients.manage']), att('tg_message', tgMessageId)))
        .allow,
    ).toBe(true);
  });

  it('a message row that does not exist is an orphan, not a pass', async () => {
    const decision = await decideAttachmentRead(
      actor(['crm.leads']),
      att('tg_message', uuidv4()),
    );
    expect(decision).toEqual({ allow: false, rule: 'orphan' });
  });
});

describe('receipt photos follow the warehouse scope, nothing more', () => {
  it('an operator scoped to the OTHER warehouse is refused', async () => {
    const decision = await decideAttachmentRead(
      actor(['receipts.create'], { scoped: true, warehouses: [twId] }),
      att('receipt_lot', lotId),
    );
    expect(decision).toEqual({ allow: false, rule: 'out-of-scope' });
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

describe('custom-field file groups follow the record they hang on', () => {
  it('a deal field admits ved.docs and refuses warehouse-only permissions', async () => {
    expect(
      (await decideAttachmentRead(actor(['ved.docs']), att('custom_field', boundGroupId))).allow,
    ).toBe(true);
    expect(
      await decideAttachmentRead(actor(['scan.load']), att('custom_field', boundGroupId)),
    ).toEqual({ allow: false, rule: 'custom_field-no-permission' });
  });

  it('a group not yet bound to any record is uploader-only', async () => {
    const unbound = att('custom_field', uuidv4());
    expect(await decideAttachmentRead(actor(['crm.leads']), unbound)).toEqual({
      allow: false,
      rule: 'custom_field-unbound',
    });
    expect(
      (await decideAttachmentRead(actor([], { id: uploaderId }), unbound)).rule,
    ).toBe('uploader');
  });
});

describe('everything else', () => {
  it('a legacy entity type is refused and named, uploader still reads it', async () => {
    const legacy = att('something_legacy', uuidv4());
    expect(await decideAttachmentRead(actor(['admin.users.manage']), legacy)).toEqual({
      allow: false,
      rule: 'unmapped',
    });
    expect((await decideAttachmentRead(actor([], { id: uploaderId }), legacy)).allow).toBe(true);
  });
});
