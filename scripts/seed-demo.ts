/**
 * DEMO data — warehouses, staff with a published password, example clients and
 * the canonical GS777 receipt.
 *
 * This lives in its OWN script, and that is the whole point (owner, after a
 * deploy: «demo userlarni o'zi emas, hamma demo ma'lumotlarni olib tashlash
 * kerak koddan … productionga chiqazganimda seed bilan birga ko'chirib
 * qo'yyabti warehouse, users va boshqa hamma demo datalarni»). It used to sit
 * inside `seed.ts` behind a flag, and a flag is the wrong kind of protection
 * for this: `seed.ts` runs on EVERY deploy from the compose `migrate` service,
 * so the demo blocks were one condition away from a real installation for ever.
 * Now the production seed does not contain this code at all — there is nothing
 * left to get the condition wrong about.
 *
 * Who runs it: the test databases. CI calls it right after `pnpm db:seed`, and
 * the browser suite signs in as these accounts.
 *
 *   pnpm db:seed        # reference data — safe anywhere, runs on every deploy
 *   pnpm db:seed:demo   # everything below — test databases only
 *
 * It still refuses to run on a real installation, because a script that is
 * safe only when nobody makes a mistake is not safe. `SEED_DEMO=1` overrides,
 * for the one case that needs it: re-seeding a test database that already has
 * users in it.
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import {
  attachments,
  clients,
  fxRates,
  receipts,
  roles,
  userRoles,
  users,
  userWarehouses,
  warehouses,
} from '../src/modules/platform/db/schema';
import { hashPassword } from '../src/modules/platform/auth/password';
import { getStorage } from '../src/modules/platform/files/storage';
import { confirmReceipt } from '../src/modules/wms/receipts/service';
import type { RoleCode } from '../src/modules/platform/rbac/catalog';

const DEMO_PASSWORD = 'demo1234';

const WAREHOUSES = [
  { code: 'GZ', name: 'Guangzhou', country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' },
  { code: 'YW', name: 'Yiwu', country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' },
  { code: 'UCH', name: 'Urumqi', country: 'CN', type: 'origin', timezone: 'Asia/Shanghai' },
  { code: 'KA', name: 'Kashgar', country: 'CN', type: 'hub', timezone: 'Asia/Kashgar' },
  { code: 'AND', name: 'Andijan', country: 'UZ', type: 'customs', timezone: 'Asia/Tashkent' },
  {
    code: 'TAS1',
    name: 'Tashkent 1',
    country: 'UZ',
    type: 'distribution',
    timezone: 'Asia/Tashkent',
  },
  {
    code: 'TAS2',
    name: 'Tashkent 2',
    country: 'UZ',
    type: 'distribution',
    timezone: 'Asia/Tashkent',
  },
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
  {
    phone: '+998900000005',
    fullName: 'Aziz (YW manager)',
    role: 'warehouse_manager',
    warehouses: ['YW'],
  },
  {
    phone: '+998900000006',
    fullName: 'Wang Lei (YW operator)',
    role: 'warehouse_operator',
    warehouses: ['YW'],
    locale: 'zh-CN',
  },
  {
    phone: '+998900000007',
    fullName: 'Li Na (GZ operator)',
    role: 'warehouse_operator',
    warehouses: ['GZ'],
    locale: 'zh-CN',
  },
  {
    phone: '+998900000008',
    fullName: 'Karim (KA operator)',
    role: 'warehouse_operator',
    warehouses: ['KA'],
  },
  { phone: '+998900000009', fullName: 'Dilnoza (Sales)', role: 'sales_manager' },
  { phone: '+998900000010', fullName: 'Buxgalter Demo', role: 'accountant' },
  { phone: '+998900000011', fullName: 'Viewer Demo', role: 'viewer' },
];

const DEMO_PHONES = new Set(DEMO_USERS.map((u) => u.phone));

/**
 * Is this a database it is safe to write demo data into?
 *
 * Empty, or holding nothing but these same demo accounts — the second case is
 * a test database being re-seeded, which happens constantly. One real person's
 * login is enough to refuse.
 */
async function safeToSeed(): Promise<boolean> {
  if (process.env.SEED_DEMO === '1') return true;
  const rows = await db.select({ phone: users.phone }).from(users);
  return rows.every((row) => DEMO_PHONES.has(row.phone ?? ''));
}

async function main() {
  if (!(await safeToSeed())) {
    console.log(
      'seed-demo: this database has real accounts in it — refusing. ' +
        'Set SEED_DEMO=1 if you are certain it is a test database.',
    );
    return;
  }

  for (const wh of WAREHOUSES) {
    await db
      .insert(warehouses)
      // Clients collect from the Uzbek end only (owner: TAS and AND) — the
      // same rule migration 0024 applied to the live rows.
      .values({
        ...wh,
        batchPrefix: wh.code,
        issuesToClients: ['customs', 'distribution'].includes(wh.type),
      })
      .onConflictDoNothing({ target: warehouses.code });
  }
  const whIds = new Map((await db.select().from(warehouses)).map((w) => [w.code, w.id] as const));

  const roleIds = new Map(
    (await db.select().from(roles)).map((r) => [r.code as RoleCode, r.id] as const),
  );
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
    const roleId = roleIds.get(demoUser.role);
    if (roleId) {
      await db.insert(userRoles).values({ userId, roleId }).onConflictDoNothing();
    }
    for (const whCode of demoUser.warehouses ?? []) {
      const whId = whIds.get(whCode);
      if (whId) {
        await db.insert(userWarehouses).values({ userId, warehouseId: whId }).onConflictDoNothing();
      }
    }
  }

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

  // FX rates for the §6.9 worked example. A live system has real dated rates
  // and must never get example numbers back — which is exactly why they are
  // in this file and not in the other one.
  const seedAdmin = (await db.select().from(users).limit(1))[0];
  if (seedAdmin) {
    for (const rate of [
      { currency: 'CNY', rateToUsd: '0.14', effectiveDate: '2026-07-01' },
      { currency: 'UZS', rateToUsd: '0.00008', effectiveDate: '2026-07-01' },
    ]) {
      await db
        .insert(fxRates)
        .values({ ...rate, enteredBy: seedAdmin.id })
        .onConflictDoNothing();
    }
  }

  await seedCanonicalReceipts(whIds);

  const counts = await db.execute(sql`
    select
      (select count(*) from users) as users,
      (select count(*) from clients) as clients,
      (select count(*) from warehouses) as warehouses
  `);
  console.log('seed-demo complete:', counts[0]);
}

/**
 * The canonical example of spec §18: fixed ids, so re-runs are idempotent and
 * the box letters land where the spec says they do.
 */
async function seedCanonicalReceipts(whIds: Map<string, string>) {
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

  // Placeholder photo per lot (the min-1-photo rule holds even for seed data).
  const sharp = (await import('sharp')).default;
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
    } as Parameters<typeof confirmReceipt>[0],
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
    } as Parameters<typeof confirmReceipt>[0],
    ctx,
  );
}

main()
  .then(() => pgClient.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
