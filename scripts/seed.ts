/**
 * Seed script — REFERENCE DATA ONLY. Idempotent: upserts by natural keys,
 * safe to re-run (DECISIONS.md #21).
 *
 * This file runs on EVERY deploy, from the compose `migrate` service, against
 * the owner's live database. So it may only ever write things that are true of
 * every installation: permissions, roles and their starting grants, settings,
 * currencies, cost types, truck presets, the funnel's starting stages.
 *
 * Demo data — warehouses, the accounts with a published password, example
 * clients, the canonical receipt of spec §18 — is NOT in this file and must
 * never come back to it. It lives in `seed-demo.ts`, and only the test
 * databases run it. It used to sit here behind a flag, and the owner found out
 * what that is worth by deploying: one wrong condition stood between a live
 * company and a set of demo warehouses with demo staff in them.
 *
 * `tests/unit/seed-demo-gate.test.ts` reads this file as TEXT and refuses the
 * demo password, the demo phone numbers, the demo warehouse names and the flag
 * itself — which is why none of them is written out above.
 */
import 'dotenv/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { syncEntityRegistry } from '../src/modules/platform/fields/service';
import {
  auditLog,
  currencies,
  letterBlacklist,
  permissions,
  rolePermissions,
  roles,
  settings,
} from '../src/modules/platform/db/schema';
import {
  PERMISSION_CODES,
  ROLE_MATRIX,
  ROLE_NAMES,
  ROLE_CODES,
  isWarehouseScoped,
  type RoleCode,
} from '../src/modules/platform/rbac/catalog';
import { SETTING_DEFAULTS } from '../src/modules/platform/settings/service';

async function main() {
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
  const permIds = new Map(
    (await db.select().from(permissions)).map((p) => [p.code, p.id] as const),
  );
  const skipped: string[] = [];
  for (const [roleCode, permCodes] of Object.entries(ROLE_MATRIX)) {
    if (customised.has(roleCode)) {
      skipped.push(roleCode);
      continue;
    }
    for (const permCode of permCodes) {
      await db
        .insert(rolePermissions)
        .values({
          roleId: roleIds.get(roleCode as RoleCode)!,
          permissionId: permIds.get(permCode)!,
        })
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

  // --- M1 reference data: cost types, truck presets, product dictionary ---
  await seedM1();
  await seedAccounting();
  await seedCrm();

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

async function seedM1() {
  const { costTypes, productDictionary } = await import('../src/modules/platform/db/schema');

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
}

async function seedAccounting() {
  const { expenseCategories, moneyAccounts } = await import('../src/modules/platform/db/schema');

  const existingCategories = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .limit(1);
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

  // Counterparty types (round 39). A starter list, not a compiled one: the
  // owner adds his own and «Boshqa» carries whatever has no box yet.
  const { partnerTypes } = await import('../src/modules/platform/db/schema');
  const existingPartnerTypes = await db.select({ id: partnerTypes.id }).from(partnerTypes).limit(1);
  if (existingPartnerTypes.length === 0) {
    await db.insert(partnerTypes).values([
      { code: 'transport', name: 'Transport firmasi', sortOrder: 10 },
      { code: 'customs', name: 'Rastamojka firmasi', sortOrder: 20 },
      { code: 'cash', name: 'Naqd almashtiruvchi', sortOrder: 30 },
      { code: 'other', name: 'Boshqa', sortOrder: 200 },
    ]);
    console.log('partner types seeded (editable)');
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

  // A source an ADVERT can name needs a stable handle, because the name stays
  // the owner's to edit (migration 0065). This runs on every seed and is
  // idempotent in the only way that is safe on a live table: a key that
  // already has a holder is left completely alone, a row carrying the default
  // name is stamped, and only when neither is true is a row added. So his
  // «Instagram» becomes the instagram key without being renamed, and a source
  // he renamed years ago keeps its leads.
  const KEYED: { key: string; name: string; sortOrder: number }[] = [
    { key: 'meta', name: 'Instagram/Facebook reklama', sortOrder: 5 },
    { key: 'instagram', name: 'Instagram', sortOrder: 10 },
    { key: 'facebook', name: 'Facebook', sortOrder: 20 },
    { key: 'telegram', name: 'Telegram', sortOrder: 40 },
    { key: 'tiktok', name: 'TikTok', sortOrder: 45 },
    { key: 'google', name: 'Google', sortOrder: 55 },
    { key: 'sayt', name: 'Sayt', sortOrder: 80 },
    { key: 'other', name: 'Boshqa', sortOrder: 200 },
  ];
  for (const want of KEYED) {
    const [held] = await db
      .select({ id: leadSources.id })
      .from(leadSources)
      .where(eq(leadSources.key, want.key))
      .limit(1);
    if (held) continue;
    const [named] = await db
      .select({ id: leadSources.id })
      .from(leadSources)
      .where(and(eq(leadSources.name, want.name), isNull(leadSources.key)))
      .limit(1);
    if (named) {
      await db.update(leadSources).set({ key: want.key }).where(eq(leadSources.id, named.id));
    } else {
      await db.insert(leadSources).values(want);
    }
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
