// Browser walk for the annul round (one-off dev probe): the receipt-card
// fold as SUPER ADMIN, the registry + bulk tool, and the two bounces (#792:
// a permission fix is half-verified until somebody who is not an admin opens
// the screen). Stages by SQL on gsr_ci, walks at 360×800, screenshots, cleans.
import { chromium } from '@playwright/test';
import postgres from 'postgres';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_ci';
const APP = 'http://127.0.0.1:3000';
const OUT = process.env.OUT_DIR ?? '/tmp/annul-shots';
const sql = postgres(DB, { max: 2 });
const stamp = String(Date.now()).slice(-6);

async function stage() {
  const [admin] = await sql`select id from users where phone = '+998900000001'`;
  const [whO] = await sql`select id from warehouses where type = 'origin' and active limit 1`;
  const [whD] = await sql`select id from warehouses where type in ('customs','distribution') and active limit 1`;
  const code = `TST${stamp}`.slice(0, 10);
  const [client] = await sql`insert into clients (id, client_code, name)
    values (gen_random_uuid(), ${code}, ${'Test mijoz ' + stamp}) returning id, client_code`;
  const [receipt] = await sql`insert into receipts (id, number, warehouse_id, client_id, status, confirmed_at, created_by)
    values (gen_random_uuid(), ${'AN-' + stamp}, ${whO.id}, ${client.id}, 'confirmed', now(), ${admin.id})
    returning id, number`;
  const [lot] = await sql`insert into receipt_lots
    (id, receipt_id, seq, letter, dims_mode, product_name_zh, product_name_ru, box_count, total_weight_kg, total_volume_m3)
    values (gen_random_uuid(), ${receipt.id}, 1, 'A', 'mixed', '测试', ${'Тест товар ' + stamp}, 2, 40, 1.1) returning id`;
  const boxIds = [];
  for (const i of [0, 1]) {
    const [b] = await sql`insert into boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
      values (gen_random_uuid(), ${lot.id}, ${'AN' + stamp + '-' + i}, ${i + 1}, 'issued', ${whD.id}) returning id`;
    boxIds.push(b.id);
  }
  const [type] = await sql`select id from cost_types limit 1`;
  const [entry] = await sql`insert into cost_entries
    (id, scope, receipt_id, cost_type_id, amount, currency, amount_usd, fx_rate_used, cost_date, allocation_basis, entered_by)
    values (gen_random_uuid(), 'receipt', ${receipt.id}, ${type.id}, 55, 'USD', 55, 1, '2026-08-01', 'boxes', ${admin.id})
    returning id`;
  for (const b of boxIds)
    await sql`insert into cost_allocations (cost_entry_id, box_id, client_id, amount_usd)
      values (${entry.id}, ${b}, ${client.id}, 27.5)`;
  return { client, receipt, lot, boxIds, entry };
}

async function login(page, phone) {
  await page.goto(`${APP}/login`);
  await page.fill('input[name="identifier"]', phone);
  await page.fill('input[name="password"]', 'demo1234');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'));
}
const width = (page) => page.evaluate(() => document.documentElement.scrollWidth);

const s = await stage();
console.log('staged', s.receipt.number, 'client', s.client.client_code);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  // ---- LOGIST (holds receipts.void, is NOT super_admin): no fold, registry bounces
  let ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  let page = await ctx.newPage();
  await login(page, '+998900000003');
  await page.goto(`${APP}/receipts/${s.receipt.id}`);
  console.log('logist sees annul-open:', await page.getByTestId('annul-open').count(), '(expect 0)');
  await page.goto(`${APP}/admin/anulirovka`);
  await page.waitForLoadState('networkidle');
  console.log('logist on /admin/anulirovka lands at:', new URL(page.url()).pathname, '(expect /)');
  await ctx.close();

  // ---- SUPER ADMIN: preview → annul → registry
  ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  page = await ctx.newPage();
  await login(page, '+998900000001');
  await page.goto(`${APP}/receipts/${s.receipt.id}`);
  await page.getByTestId('annul-open').click();
  await page.waitForSelector('[data-testid="annul-panel"]');
  await page.screenshot({ path: `${OUT}/1-annul-panel.png`, fullPage: false });
  console.log('panel width', await width(page));
  page.on('dialog', (d) => d.accept());
  await page.fill('[data-testid="annul-reason"]', 'test tozalash — walk');
  await page.getByTestId('annul-confirm').click();
  await page.waitForSelector('[data-testid="annul-done"]');
  await page.screenshot({ path: `${OUT}/2-annul-done.png` });
  const [r] = await sql`select status from receipts where id = ${s.receipt.id}`;
  const [b] = await sql`select count(*)::int n from boxes where lot_id = ${s.lot.id} and status = 'void'`;
  const [e] = await sql`select voided_at from cost_entries where id = ${s.entry.id}`;
  console.log('after: receipt', r.status, '· void boxes', b.n, '· entry voided:', !!e.voided_at);

  await page.goto(`${APP}/admin/anulirovka`);
  await page.waitForSelector('[data-testid="annul-row"]');
  await page.screenshot({ path: `${OUT}/3-registry.png`, fullPage: true });
  console.log('registry width', await width(page));

  // the bulk tool finds the (now cleaned) client
  await page.goto(`${APP}/admin/anulirovka?mijoz=${s.client.client_code}`);
  await page.waitForSelector('[data-testid="annul-bulk"]');
  await page.screenshot({ path: `${OUT}/4-bulk.png` });
  await ctx.close();
} finally {
  await browser.close();
  await sql`delete from cost_allocations where cost_entry_id = ${s.entry.id}`;
  await sql`delete from cost_entries where id = ${s.entry.id}`;
  await sql`delete from box_movements where box_id in ${sql(s.boxIds)}`;
  await sql`delete from boxes where id in ${sql(s.boxIds)}`;
  await sql`delete from receipt_lots where id = ${s.lot.id}`;
  await sql`delete from receipts where id = ${s.receipt.id}`;
  await sql`update clients set active = false where id = ${s.client.id}`;
  await sql.end();
}
console.log('WALK DONE');
