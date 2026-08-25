// Browser walk for the second corrections round (one-off dev probe): the bin
// scan, the two unload gates seen as an OPERATOR and as a MANAGER, and the
// warehouse-fill block on the owner's home. Stages by SQL on gsr_ci, walks at
// 360×800 as the real roles (#792: a permission fix is half-verified until
// somebody who is not an admin opens the screen), screenshots, cleans up.
import { chromium } from '@playwright/test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_ci';
const APP = 'http://127.0.0.1:3000';
const OUT = process.env.OUT_DIR ?? '/tmp/walk2-shots';
const sql = postgres(DB, { max: 2 });
const stamp = String(Date.now()).slice(-6);

async function stage() {
  const [op] = await sql`select u.id from users u where u.phone = '+998900000006'`;
  const [mgr] = await sql`select u.id from users u where u.phone = '+998900000005'`;
  const [wh] = await sql`select w.id, w.code from warehouses w
    join user_warehouses uw on uw.warehouse_id = w.id where uw.user_id = ${op.id} limit 1`;
  const [dest] = await sql`select id, code from warehouses
    where active = true and type in ('customs','distribution') limit 1`;
  const [client] = await sql`select id, client_code from clients where active = true limit 1`;

  const receiptId = randomUUID();
  await sql`insert into receipts (id, number, warehouse_id, client_id, status, confirmed_at, created_by)
    values (${receiptId}, ${'R2-' + stamp}, ${wh.id}, ${client.id}, 'confirmed', now(), ${op.id})`;
  const [lot] = await sql`insert into receipt_lots
    (id, receipt_id, seq, letter, dims_mode, product_name_zh, box_count, total_weight_kg, total_volume_m3)
    values (gen_random_uuid(), ${receiptId}, 1, 'A', 'mixed', ${'测试 r2 ' + stamp}, 2, 60, 1.4)
    returning id`;
  const codes = [0, 1].map((i) => `R2${stamp}-${i}`);
  for (const [i, code] of codes.entries()) {
    await sql`insert into boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
      values (gen_random_uuid(), ${lot.id}, ${code}, ${i + 1}, 'in_stock', ${wh.id})`;
  }
  // A truck standing at the destination with one carton still unscanned: the
  // two shortcut buttons are about exactly this state.
  const [batch] = await sql`insert into batches
    (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
    values (gen_random_uuid(), ${'R2B-' + stamp}, ${wh.id}, ${dest.id}, 'in_transit', now(), ${op.id})
    returning id, code`;
  const late = `R2${stamp}-9`;
  await sql`insert into boxes (id, lot_id, short_code, seq_in_lot, status, current_batch_id)
    values (gen_random_uuid(), ${lot.id}, ${late}, 3, 'in_transit', ${batch.id})`;
  return { op, mgr, wh, dest, receiptId, batch, codes, late };
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
console.log('staged', s.batch.code, s.codes.join(','), 'at', s.wh.code, '→', s.dest.code);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  // ---- OPERATOR: no bin tile, no shortcut buttons
  let ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  let page = await ctx.newPage();
  await login(page, '+998900000006');
  await page.goto(`${APP}/inventory?warehouseId=${s.wh.id}`);
  await page.screenshot({ path: `${OUT}/1-operator-modes.png` });
  console.log(
    'operator sees bin tile:',
    await page.getByTestId('inventory-mode-musor').count(),
    '(expect 0)',
  );
  await page.goto(`${APP}/batches/${s.batch.id}`);
  const opAccept = await page.getByTestId('accept-all').count();
  const opFinish = await page.getByTestId('finish-unload').count();
  const opHint = await page.getByTestId('unload-scan-hint').count();
  console.log(`operator: accept-all=${opAccept} finish=${opFinish} hint=${opHint} (expect 0 0 1)`);
  await page.screenshot({ path: `${OUT}/2-operator-unload.png` });
  console.log('unload width', await width(page));
  await ctx.close();

  // ---- MANAGER: bin tile + both shortcuts
  ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  page = await ctx.newPage();
  await login(page, '+998900000005');
  await page.goto(`${APP}/batches/${s.batch.id}`);
  const mAccept = await page.getByTestId('accept-all').count();
  const mFinish = await page.getByTestId('finish-unload').count();
  console.log(`manager: accept-all=${mAccept} finish=${mFinish} (expect 1 1)`);
  await page.screenshot({ path: `${OUT}/3-manager-unload.png` });

  await page.goto(`${APP}/inventory?warehouseId=${s.wh.id}`);
  await page.screenshot({ path: `${OUT}/4-manager-modes.png` });
  await page.getByTestId('inventory-mode-musor').click();
  await page.fill('[data-testid="bin-code"]', s.codes[0]);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="bin-pending"]');
  await page.fill('[data-testid="bin-reason"]', 'suvda qoldi — walk');
  await page.screenshot({ path: `${OUT}/5-bin-pending.png` });
  await page.getByTestId('bin-confirm').click();
  await page.waitForSelector('[data-testid="bin-done"]');
  await page.screenshot({ path: `${OUT}/6-bin-done.png` });
  console.log('bin width', await width(page));
  const [gone] = await sql`select status, status_reason from boxes where short_code = ${s.codes[0]}`;
  console.log('after bin:', gone);

  // a carton standing at ANOTHER warehouse must be refused, not binned
  await page.fill('[data-testid="bin-code"]', s.late);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="bin-error"]');
  console.log('foreign code refused:', (await page.getByTestId('bin-error').innerText()).slice(0, 60));
  await ctx.close();

  // ---- OWNER: the fill block on the home screen
  ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  page = await ctx.newPage();
  await login(page, '+998900000001');
  await page.goto(`${APP}/`);
  await page.waitForSelector('[data-testid="wh-fill"]');
  const rows = await page.getByTestId('wh-fill-row').count();
  const ages = await page.getByTestId('wh-fill-age').count();
  console.log(`owner home: fill rows=${rows} with age=${ages}`);
  await page.screenshot({ path: `${OUT}/7-owner-home.png`, fullPage: true });
  console.log('home width', await width(page));
  await ctx.close();
} finally {
  await browser.close();
  const ids = (await sql`select id from boxes where short_code like ${'R2' + stamp + '%'}`).map((r) => r.id);
  if (ids.length) {
    await sql`delete from box_movements where box_id in ${sql(ids)}`;
    await sql`delete from scan_events where box_id in ${sql(ids)}`;
    await sql`delete from boxes where id in ${sql(ids)}`;
  }
  await sql`delete from receipt_lots where receipt_id = ${s.receiptId}`;
  await sql`delete from receipts where id = ${s.receiptId}`;
  await sql`delete from client_notices where ref_id = ${s.batch.id}`;
  await sql`delete from batches where id = ${s.batch.id}`;
  await sql`delete from notifications where type in ('BoxLost','BoxFoundHere') and payload->>'text' like ${'%R2' + stamp + '%'}`;
  await sql.end();
}
console.log('WALK DONE');
