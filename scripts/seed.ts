/**
 * Seed script — M0 slice of spec §18. Idempotent: upserts by natural keys,
 * safe to re-run. Grows with each milestone (DECISIONS.md #21).
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { syncEntityRegistry } from '../src/modules/platform/fields/service';
import {
  auditLog,
  clients,
  currencies,
  fxRates,
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
  isWarehouseScoped,
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

/**
 * Demo data (users with the well-known password, demo clients, the canonical
 * GS777 receipt) is seeded ONLY into an empty database — the bootstrap that
 * gives a fresh install someone to log in as. On a live system the seed still
 * runs on every deploy, but it must never resurrect a demo account the owner
 * deleted, nor re-grant a role they took away. `SEED_DEMO=1` forces it back
 * for test environments.
 */
async function shouldSeedDemo(): Promise<boolean> {
  if (process.env.SEED_DEMO === '1') return true;
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(users);
  return Number(row?.n ?? 0) === 0;
}

async function main() {
  const seedDemo = await shouldSeedDemo();
  if (!seedDemo) {
    console.log('seed: existing installation — reference data only, no demo accounts');
  }

  // --- Roles & permissions (spec §16 matrix as data) ---
  //
  // The matrix BOOTSTRAPS a role; it does not own it. The moment someone
  // edits a role on the admin screen, `grants_customised` flips and the seed
  // steps away from that role for good — otherwise the next deploy would
  // silently restore every permission the owner had just removed, which is
  // exactly how people learn not to trust a permissions screen.
  for (const code of PERMISSION_CODES) {
    await db.insert(permissions).values({ code }).onConflictDoNothing();
  }
  for (const code of ROLE_CODES) {
    // The scoping flag rides the INSERT only: after birth the /admin/roles
    // screen owns it, and a seed that re-asserted it would betray an owner
    // who deliberately unticked a shipped role (the grants_customised
    // lesson, applied to one boolean).
    await db
      .insert(roles)
      .values({ code, name: ROLE_NAMES[code], warehouseScoped: isWarehouseScoped([code]) })
      .onConflictDoNothing();
  }
  const roleRows = await db.select().from(roles);
  const roleIds = new Map(roleRows.map((r) => [r.code as RoleCode, r.id] as const));
  const customised = new Set(roleRows.filter((r) => r.grantsCustomised).map((r) => r.code));
  const permIds = new Map((await db.select().from(permissions)).map((p) => [p.code, p.id] as const));
  const skipped: string[] = [];
  for (const [roleCode, permCodes] of Object.entries(ROLE_MATRIX)) {
    if (customised.has(roleCode)) {
      skipped.push(roleCode);
      continue;
    }
    for (const permCode of permCodes) {
      await db
        .insert(rolePermissions)
        .values({ roleId: roleIds.get(roleCode as RoleCode)!, permissionId: permIds.get(permCode)! })
        .onConflictDoNothing();
    }
  }
  if (skipped.length) {
    // Said out loud: a new permission shipped in this release did NOT reach
    // these roles, and somebody has to tick it on the admin screen.
    console.log(`roles left alone (edited by an admin): ${skipped.join(', ')}`);
  }

  // --- Which objects may carry custom fields ---
  // Insert-and-reactivate from the registry. A code that leaves the registry
  // is deactivated, never deleted: its fields and every answer to them hang
  // off it by foreign key.
  await syncEntityRegistry();

  // --- Warehouses (bootstrap only: a deleted one must stay deleted) ---
  if (seedDemo) {
    for (const wh of WAREHOUSES) {
      await db
        .insert(warehouses)
        // Clients collect from the Uzbek end only (owner: TAS and AND) —
        // the same rule migration 0024 applied to the live rows.
        .values({
          ...wh,
          batchPrefix: wh.code,
          issuesToClients: ['customs', 'distribution'].includes(wh.type),
        })
        .onConflictDoNothing({ target: warehouses.code });
    }
  }
  const whIds = new Map((await db.select().from(warehouses)).map((w) => [w.code, w.id] as const));

  // --- Demo users (bootstrap only — never resurrect deleted accounts) ---
  if (seedDemo) {
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
        const whId = whIds.get(whCode);
        if (whId) {
          await db.insert(userWarehouses).values({ userId, warehouseId: whId }).onConflictDoNothing();
        }
      }
    }
  }

  // --- Demo clients: GS777 → Dilnoza + 19 more (bootstrap only) ---
  if (seedDemo) {
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
  // FX rates for the §6.9 worked example (bootstrap only — a live system has
  // real dated rates and must not get example numbers back).
  const seedAdmin = seedDemo ? (await db.select().from(users).limit(1))[0] : undefined;
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
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await db
      .insert(settings)
      .values({ key, value: value as object })
      .onConflictDoNothing();
  }

  // --- M1: cost types, product dictionary, canonical GS777 receipt (§18) ---
  await seedM1(whIds, seedDemo);
  await seedAccounting();
  await seedCrm();

  // --- Single audit marker for the seed run ---
  await db.insert(auditLog).values({
    actorId: null,
    entityType: 'system',
    entityId: '00000000-0000-0000-0000-000000000000',
    action: 'seed',
    after: { script: 'seed.ts', milestone: 'M0', demo: seedDemo },
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

async function seedM1(whIds: Map<string, string>, seedDemo: boolean) {
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
    // The owner's grid columns (round 29: «columnlarni rastamojka,
    // zatamojka, CCT va boshqa deb belgilab ber»). Idempotent by code; the
    // admin screen owns names/active after birth.
    { code: 'customs', name: 'Растаможка / Rastamojka' },
    { code: 'zatamojka', name: 'Затаможка / Zatamojka' },
    { code: 'cct', name: 'CCT' },
    { code: 'freight', name: "Дорога / Yo'lkira" },
  ]) {
    await db.insert(costTypes).values(type).onConflictDoNothing();
  }

  // Truck presets for the M3 plan editor (idempotent by name).
  const { truckPresets } = await import('../src/modules/platform/db/schema');
  const { eq: eqOp } = await import('drizzle-orm');
  for (const preset of [
    { name: 'Фура 13.6м тент — 90 м³ / 24 т', maxKg: '24000', maxM3: '90' },
    { name: 'Фура 17.5м — 130 м³ / 28 т', maxKg: '28000', maxM3: '130' },
  ]) {
    const existing = await db
      .select({ id: truckPresets.id })
      .from(truckPresets)
      .where(eqOp(truckPresets.name, preset.name))
      .limit(1);
    if (existing.length === 0) await db.insert(truckPresets).values(preset);
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

  // Everything above is reference data (cost types, truck presets, product
  // dictionary) and stays on every run; the canonical receipt is demo data.
  if (!seedDemo) return;
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

/**
 * Starter expense categories and cash accounts (owner's own list).
 *
 * Seeded ONLY into empty tables. Both are meant to be edited by hand from the
 * admin pages, and a category the owner deleted must not reappear on the next
 * deploy — the same rule that stopped demo users coming back (DECISIONS #117).
 */
async function seedAccounting() {
  const { expenseCategories, moneyAccounts } = await import(
    '../src/modules/platform/db/schema'
  );

  const existingCategories = await db.select({ id: expenseCategories.id }).from(expenseCategories).limit(1);
  if (existingCategories.length === 0) {
    await db.insert(expenseCategories).values([
      { name: 'Ijara (sklad, ofis)', sortOrder: 10 },
      { name: 'Ish haqi', sortOrder: 20 },
      { name: 'Ish haqi soliqlari va ajratmalar', sortOrder: 30 },
      { name: 'Kommunal (svet, suv, isitish)', sortOrder: 40 },
      { name: 'Aloqa va internet', sortOrder: 50 },
      { name: 'Transport (yoqilg‘i, ta’mir, sug‘urta)', sortOrder: 60 },
      { name: 'Sklad sarf materiallari', sortOrder: 70 },
      { name: 'Dasturiy ta’minot va serverlar', sortOrder: 80 },
      { name: 'Bank xizmatlari va komissiyalar', sortOrder: 90 },
      { name: 'Yuridik va buxgalteriya xizmati', sortOrder: 100 },
      { name: 'Reklama va marketing', sortOrder: 110 },
      // Never leaves the bank account, so it stays out of the cash flow.
      { name: 'Amortizatsiya', cash: false, sortOrder: 120 },
      { name: 'Boshqa', sortOrder: 200 },
    ]);
    console.log('expense categories seeded (editable in the admin pages)');
  }

  const existingAccounts = await db.select({ id: moneyAccounts.id }).from(moneyAccounts).limit(1);
  if (existingAccounts.length === 0) {
    await db.insert(moneyAccounts).values([
      { name: 'Xitoy — naqd (USD)', currency: 'USD', kind: 'cash', sortOrder: 10 },
      { name: 'O‘zbekiston — naqd (USD)', currency: 'USD', kind: 'cash', sortOrder: 20 },
      { name: 'O‘zbekiston — naqd (so‘m)', currency: 'UZS', kind: 'cash', sortOrder: 30 },
      { name: 'O‘zbekiston — karta (so‘m)', currency: 'UZS', kind: 'card', sortOrder: 40 },
      { name: 'O‘zbekiston — firma hisobi (so‘m)', currency: 'UZS', kind: 'bank', sortOrder: 50 },
    ]);
    console.log('money accounts seeded (owner list; editable)');
  }
}

/**
 * A starter funnel and a starter source list — both are DATA the owner edits,
 * so these only ever fill an empty table. `kind` is what the code reasons
 * about; the names are his to rename.
 */
async function seedCrm() {
  const { leadSources, leadStages } = await import('../src/modules/platform/db/schema');

  const existingSources = await db.select({ id: leadSources.id }).from(leadSources).limit(1);
  if (existingSources.length === 0) {
    // The owner's list, verbatim; the screen adds and removes them freely.
    await db.insert(leadSources).values([
      { name: 'Instagram', sortOrder: 10 },
      { name: 'Facebook', sortOrder: 20 },
      { name: 'YouTube', sortOrder: 30 },
      { name: 'Telegram', sortOrder: 40 },
      { name: 'WeChat', sortOrder: 50 },
      { name: 'Tavsiya (tanish orqali)', sortOrder: 60 },
      { name: 'Reklama', sortOrder: 70 },
      { name: 'Sayt', sortOrder: 80 },
      { name: 'O‘zi keldi', sortOrder: 90 },
      { name: 'Boshqa', sortOrder: 200 },
    ]);
    console.log('lead sources seeded (editable)');
  }

  const existingStages = await db.select({ id: leadStages.id }).from(leadStages).limit(1);
  if (existingStages.length === 0) {
    // The owner's funnel, verbatim. Stages can be added, renamed, recoloured,
    // reordered and removed — only `kind` (open/won/lost) is code.
    await db.insert(leadStages).values([
      { name: 'Yangi', kind: 'open', color: 'gray', sortOrder: 10 },
      { name: 'Bog‘lanildi', kind: 'open', color: 'blue', sortOrder: 20 },
      { name: 'Ma’lumot olindi', kind: 'open', color: 'blue', sortOrder: 30 },
      { name: 'Hisoblanilyapti', kind: 'open', color: 'purple', sortOrder: 40 },
      { name: 'Narx aytildi', kind: 'open', color: 'amber', sortOrder: 50 },
      { name: 'Javob kutilyapti', kind: 'open', color: 'teal', sortOrder: 60 },
      { name: 'Sotuv', kind: 'won', color: 'green', sortOrder: 70 },
      { name: 'Yo‘qotildi', kind: 'lost', color: 'red', sortOrder: 80 },
    ]);
    console.log('lead stages seeded (editable)');
  }
}

main()
  .then(() => pgClient.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
