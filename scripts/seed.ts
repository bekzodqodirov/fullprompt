/**
 * Seed script — M0 slice of spec §18. Idempotent: upserts by natural keys,
 * safe to re-run. Grows with each milestone (DECISIONS.md #21).
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import {
  auditLog,
  clients,
  currencies,
  letterBlacklist,
  permissions,
  rolePermissions,
  roles,
  settings,
  userRoles,
  users,
  userWarehouses,
  warehouses,
} from '../src/modules/platform/db/schema';
import { hashPassword } from '../src/modules/platform/auth/password';
import {
  PERMISSION_CODES,
  ROLE_MATRIX,
  ROLE_NAMES,
  ROLE_CODES,
  type RoleCode,
} from '../src/modules/platform/rbac/catalog';
import { SETTING_DEFAULTS } from '../src/modules/platform/settings/service';

const DEMO_PASSWORD = 'demo1234';

const WAREHOUSES = [
  { code: 'GZ', name: 'Guangzhou', country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' },
  { code: 'YW', name: 'Yiwu', country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' },
  { code: 'UCH', name: 'Urumqi', country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' },
  { code: 'KA', name: 'Kashgar', country: 'CN', type: 'hub', timezone: 'Asia/Kashgar' },
  { code: 'AND', name: 'Andijan', country: 'UZ', type: 'customs', timezone: 'Asia/Tashkent' },
  { code: 'TAS1', name: 'Tashkent 1', country: 'UZ', type: 'distribution', timezone: 'Asia/Tashkent' },
  { code: 'TAS2', name: 'Tashkent 2', country: 'UZ', type: 'distribution', timezone: 'Asia/Tashkent' },
] as const;

const DEMO_USERS: {
  phone: string;
  fullName: string;
  role: RoleCode;
  warehouses?: string[];
  locale?: 'ru' | 'uz' | 'zh-CN';
}[] = [
  { phone: '+998900000001', fullName: 'Bekzod (Super admin)', role: 'super_admin' },
  { phone: '+998900000002', fullName: 'Admin Demo', role: 'admin' },
  { phone: '+998900000003', fullName: 'Logist Demo', role: 'logist' },
  { phone: '+998900000004', fullName: 'VED Demo', role: 'ved_manager' },
  { phone: '+998900000005', fullName: 'Aziz (YW manager)', role: 'warehouse_manager', warehouses: ['YW'] },
  { phone: '+998900000006', fullName: 'Wang Lei (YW operator)', role: 'warehouse_operator', warehouses: ['YW'], locale: 'zh-CN' },
  { phone: '+998900000007', fullName: 'Li Na (GZ operator)', role: 'warehouse_operator', warehouses: ['GZ'], locale: 'zh-CN' },
  { phone: '+998900000008', fullName: 'Karim (KA operator)', role: 'warehouse_operator', warehouses: ['KA'] },
  { phone: '+998900000009', fullName: 'Dilnoza (Sales)', role: 'sales_manager' },
  { phone: '+998900000010', fullName: 'Buxgalter Demo', role: 'accountant' },
  { phone: '+998900000011', fullName: 'Viewer Demo', role: 'viewer' },
];

async function main() {
  // --- Roles & permissions (spec §16 matrix as data) ---
  for (const code of PERMISSION_CODES) {
    await db.insert(permissions).values({ code }).onConflictDoNothing();
  }
  for (const code of ROLE_CODES) {
    await db.insert(roles).values({ code, name: ROLE_NAMES[code] }).onConflictDoNothing();
  }
  const roleIds = new Map(
    (await db.select().from(roles)).map((r) => [r.code as RoleCode, r.id] as const),
  );
  const permIds = new Map((await db.select().from(permissions)).map((p) => [p.code, p.id] as const));
  for (const [roleCode, permCodes] of Object.entries(ROLE_MATRIX)) {
    for (const permCode of permCodes) {
      await db
        .insert(rolePermissions)
        .values({ roleId: roleIds.get(roleCode as RoleCode)!, permissionId: permIds.get(permCode)! })
        .onConflictDoNothing();
    }
  }

  // --- Warehouses ---
  for (const wh of WAREHOUSES) {
    await db
      .insert(warehouses)
      .values({ ...wh, batchPrefix: wh.code })
      .onConflictDoNothing({ target: warehouses.code });
  }
  const whIds = new Map((await db.select().from(warehouses)).map((w) => [w.code, w.id] as const));

  // --- Users ---
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const demoUser of DEMO_USERS) {
    const existing = await db.query.users.findFirst({ where: eq(users.phone, demoUser.phone) });
    let userId = existing?.id;
    if (!userId) {
      const [row] = await db
        .insert(users)
        .values({
          phone: demoUser.phone,
          fullName: demoUser.fullName,
          passwordHash,
          locale: demoUser.locale ?? 'ru',
        })
        .returning({ id: users.id });
      userId = row!.id;
    }
    await db
      .insert(userRoles)
      .values({ userId, roleId: roleIds.get(demoUser.role)! })
      .onConflictDoNothing();
    for (const whCode of demoUser.warehouses ?? []) {
      await db
        .insert(userWarehouses)
        .values({ userId, warehouseId: whIds.get(whCode)! })
        .onConflictDoNothing();
    }
  }

  // --- Clients: GS777 → Dilnoza + 19 more demo clients ---
  const dilnoza = await db.query.users.findFirst({ where: eq(users.phone, '+998900000009') });
  const demoClients = [
    { clientCode: 'GS777', name: 'Alisher aka', salesManagerId: dilnoza?.id ?? null },
    { clientCode: 'GS102', name: 'Bobur Trading', salesManagerId: dilnoza?.id ?? null },
    { clientCode: 'GS205', name: 'Nodira opa', salesManagerId: dilnoza?.id ?? null },
    ...Array.from({ length: 17 }, (_, i) => ({
      clientCode: `GS${300 + i}`,
      name: `Demo mijoz ${i + 1}`,
      salesManagerId: dilnoza?.id ?? null,
    })),
  ];
  for (const client of demoClients) {
    await db
      .insert(clients)
      .values({ ...client, phones: [] })
      .onConflictDoNothing({ target: clients.clientCode });
  }

  // --- Currencies, letter blacklist, settings ---
  for (const currency of [
    { code: 'CNY', name: 'Chinese Yuan' },
    { code: 'USD', name: 'US Dollar' },
    { code: 'UZS', name: 'Uzbek Som' },
  ]) {
    await db.insert(currencies).values(currency).onConflictDoNothing();
  }
  for (const combo of ['AM', 'XU']) {
    await db.insert(letterBlacklist).values({ combo }).onConflictDoNothing();
  }
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await db
      .insert(settings)
      .values({ key, value: value as object })
      .onConflictDoNothing();
  }

  // --- M1: cost types, product dictionary, canonical GS777 receipt (§18) ---
  await seedM1(whIds);

  // --- Single audit marker for the seed run ---
  await db.insert(auditLog).values({
    actorId: null,
    entityType: 'system',
    entityId: '00000000-0000-0000-0000-000000000000',
    action: 'seed',
    after: { script: 'seed.ts', milestone: 'M0' },
  });

  const counts = await db.execute(sql`
    select
      (select count(*) from users) as users,
      (select count(*) from clients) as clients,
      (select count(*) from warehouses) as warehouses,
      (select count(*) from role_permissions) as grants
  `);
  console.log('seed complete:', counts[0]);
}

async function seedM1(whIds: Map<string, string>) {
  const { costTypes, productDictionary, attachments, receipts } = await import(
    '../src/modules/platform/db/schema'
  );
  const { confirmReceipt } = await import('../src/modules/wms/receipts/service');
  const { getStorage } = await import('../src/modules/platform/files/storage');
  const sharp = (await import('sharp')).default;

  for (const type of [
    { code: 'crating', name: 'Ящик / Yashik' },
    { code: 'unload', name: 'Разгрузка / Tushirish' },
    { code: 'other', name: 'Прочее / Boshqa' },
  ]) {
    await db.insert(costTypes).values(type).onConflictDoNothing();
  }

  for (const entry of [
    { zh: '化妆品', ru: 'Косметика', verified: true },
    { zh: '键盘', ru: 'Клавиатура', verified: true },
    { zh: '鼠标', ru: 'Мышь', verified: true },
  ]) {
    await db.insert(productDictionary).values(entry).onConflictDoNothing();
  }

  // Canonical example (spec §18): fixed ids ⇒ idempotent re-runs.
  const RECEIPT_GS777 = '018f0000-0000-7000-8000-000000000001';
  const RECEIPT_GS102 = '018f0000-0000-7000-8000-000000000002';
  const LOTS_GS777 = [
    '018f0000-0000-7000-8000-000000000101',
    '018f0000-0000-7000-8000-000000000102',
    '018f0000-0000-7000-8000-000000000103',
  ];
  const LOT_GS102 = '018f0000-0000-7000-8000-000000000201';

  const existing = await db.query.receipts.findFirst({ where: eq(receipts.id, RECEIPT_GS777) });
  if (existing) return;

  const operator = await db.query.users.findFirst({ where: eq(users.phone, '+998900000006') });
  const gs777 = await db.query.clients.findFirst({ where: eq(clients.clientCode, 'GS777') });
  const gs102 = await db.query.clients.findFirst({ where: eq(clients.clientCode, 'GS102') });
  const ywId = whIds.get('YW');
  if (!operator || !gs777 || !gs102 || !ywId) return;

  // Placeholder photo per lot (min-1-photo rule holds even for seed data).
  const storage = getStorage();
  for (const lotId of [...LOTS_GS777, LOT_GS102]) {
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 210, g: 220, b: 240 } },
    })
      .jpeg({ quality: 70 })
      .toBuffer();
    const storageKey = `receipt_lot/${lotId}/seed-photo`;
    await storage.put(storageKey, png, 'image/jpeg');
    await db
      .insert(attachments)
      .values({
        entityType: 'receipt_lot',
        entityId: lotId,
        kind: 'photo',
        storageKey,
        fileName: 'seed-photo.jpg',
        contentType: 'image/jpeg',
        sizeBytes: png.length,
        uploadedBy: operator.id,
      })
      .onConflictDoNothing({ target: attachments.storageKey });
  }

  const ctx = { actorId: operator.id };
  await confirmReceipt(
    {
      receiptId: RECEIPT_GS777,
      warehouseId: ywId,
      clientId: gs777.id,
      sourceNote: 'Seed: canonical example',
      lots: [
        {
          id: LOTS_GS777[0]!,
          productNameZh: '化妆品',
          productNameRu: 'Косметика',
          boxCount: 10,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 50,
          boxHeightCm: 50,
          boxWeightKg: 25,
        },
        {
          id: LOTS_GS777[1]!,
          productNameZh: '键盘',
          productNameRu: 'Клавиатура',
          boxCount: 50,
          dimsMode: 'uniform',
          boxLengthCm: 35,
          boxWidthCm: 35,
          boxHeightCm: 35,
          boxWeightKg: 30,
        },
        {
          id: LOTS_GS777[2]!,
          productNameZh: '鼠标',
          productNameRu: 'Мышь',
          boxCount: 40,
          dimsMode: 'mixed',
          totalWeightKg: 320,
          totalVolumeM3: 1.9,
        },
      ],
      extraCosts: [],
    },
    ctx,
  );

  await confirmReceipt(
    {
      receiptId: RECEIPT_GS102,
      warehouseId: ywId,
      clientId: gs102.id,
      sourceNote: 'Seed: next receipt starts at D',
      lots: [
        {
          id: LOT_GS102,
          productNameZh: '玩具',
          productNameRu: 'Игрушки',
          boxCount: 5,
          dimsMode: 'uniform',
          boxLengthCm: 60,
          boxWidthCm: 40,
          boxHeightCm: 40,
          boxWeightKg: 12,
        },
      ],
      extraCosts: [],
    },
    ctx,
  );
  console.log('M1 canonical receipts seeded (GS777 → A,B,C; GS102 → D)');
}

main()
  .then(() => pgClient.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
