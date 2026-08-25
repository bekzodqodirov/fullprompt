// Browser walk for the warehouse-corrections round (one-off dev probe, the
// dev-scan-decoder-probe.mjs family): stages fixtures by SQL on gsr_ci,
// walks the three new surfaces at 360×800 as the REAL roles (operator for
// the scan doors, manager for the write-off — #792), screenshots each, and
// cleans its rows. Run from the repo root with the standalone server up.
import { chromium } from '@playwright/test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_ci';
const APP = 'http://127.0.0.1:3000';
const OUT = process.env.OUT_DIR ?? '/tmp/walk-shots';
const sql = postgres(DB, { max: 2 });

const stamp = String(Date.now()).slice(-6);
async function stage() {
  const [op] = await sql`select u.id, u.full_name from users u
    join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id
    where u.phone = '+998900000006'`;
  const [opWh] = await sql`select w.id, w.code from warehouses w
    join user_warehouses uw on uw.warehouse_id = w.id where uw.user_id = ${op.id} limit 1`;
  const [otherWh] = await sql`select id, code from warehouses
    where active = true and id <> ${opWh.id} and type = 'origin' limit 1`;
  const [client] = await sql`select id, client_code from clients where active = true limit 1`;

  const receiptId = randomUUID();
  await sql`insert into receipts (id, number, warehouse_id, client_id, status, confirmed_at, created_by)
    values (${receiptId}, ${'WLK-' + stamp}, ${opWh.id}, ${client.id}, 'confirmed', now(), ${op.id})`;
  const [lot] = await sql`insert into receipt_lots
    (id, receipt_id, seq, letter, dims_mode, product_name_zh, box_count, total_weight_kg, total_volume_m3)
    values (gen_random_uuid(), ${receiptId}, 1, 'A', 'mixed', ${'测试 walk ' + stamp}, 3, 90, 1.2) returning id`;
  const codes = [0, 1, 2].map((i) => `WLK${stamp}-${i}`);
  for (const [i, code] of codes.entries()) {
    await sql`insert into boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
      values (gen_random_uuid(), ${lot.id}, ${code}, ${i + 1}, 'in_stock', ${opWh.id})`;
  }
  const [batch] = await sql`insert into batches
    (id, code, origin_warehouse_id, dest_warehouse_id, status, created_by)
    values (gen_random_uuid(), ${'WLKB-' + stamp}, ${opWh.id}, ${otherWh.id}, 'loading', ${op.id})
    returning id, code`;
  // Box 0 rides the still-loading truck (the remove sheet's subject); box 1
  // is "recorded at another warehouse" for the found-here accept.
  await sql`update boxes set status = 'loading', current_batch_id = ${batch.id}
    where short_code = ${codes[0]}`;
  await sql`update boxes set current_warehouse_id = ${otherWh.id} where short_code = ${codes[1]}`;
  return { opWh, otherWh, receiptId, batch, codes };
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
console.log('staged', s.batch.code, s.codes.join(','), 'wh', s.opWh.code);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  // ---- operator: the remove sheet on the loading screen
  let ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  let page = await ctx.newPage();
  await login(page, '+998900000006');
  await page.goto(`${APP}/batches/${s.batch.id}/load`);
  await page.getByTestId('remove-loaded-open').click();
  await page.screenshot({ path: `${OUT}/1-remove-sheet.png` });
  console.log('remove sheet width', await width(page));
  await page.getByTestId('remove-row').first().click();
  await page.getByTestId('remove-confirm').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/2-remove-done.png` });
  const box0 = await sql`select status, current_batch_id from boxes where short_code = ${s.codes[0]}`;
  console.log('after remove:', box0[0]);

  // ---- operator: /inventory mode chooser + single accept
  await page.goto(`${APP}/inventory?warehouseId=${s.opWh.id}`);
  await page.screenshot({ path: `${OUT}/3-inventory-modes.png` });
  await page.getByTestId('inventory-mode-bitta').click();
  await page.fill('[data-testid="accept-code"]', s.codes[1]);
  await page.keyboard.press('Enter');
  await page.getByTestId('accept-confirm').click();
  await page.waitForSelector('[data-testid="accept-done"]');
  await page.screenshot({ path: `${OUT}/4-accept-done.png` });
  console.log('inventory width', await width(page));
  const box1 = await sql`select status, current_warehouse_id from boxes where short_code = ${s.codes[1]}`;
  console.log('after accept:', box1[0].status, box1[0].current_warehouse_id === s.opWh.id ? 'AT-OP-WH' : 'WRONG');
  await ctx.close();

  // ---- manager: the write-off fold on the receipt card
  ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  page = await ctx.newPage();
  await login(page, '+998900000005');
  await page.goto(`${APP}/receipts/${s.receiptId}`);
  // Locale-proof: find the fold by the control it contains, not its words.
  await page.locator('details:has([data-testid="mark-lost-box"]) > summary').first().click();
  await page.selectOption('[data-testid="mark-lost-box"]', { label: s.codes[2] });
  await page.fill('[data-testid="mark-lost-reason"]', 'suv tegdi — walk');
  await page.screenshot({ path: `${OUT}/5-marklost-form.png` });
  await page.getByTestId('mark-lost-submit').click();
  await page.waitForSelector('[data-testid="mark-lost-done"]');
  await page.screenshot({ path: `${OUT}/6-marklost-done.png` });
  const box2 = await sql`select status, status_reason from boxes where short_code = ${s.codes[2]}`;
  console.log('after marklost:', box2[0]);
  console.log('receipt width', await width(page));

  // ---- operator must NOT see the fold (law of the door)
  const ctx2 = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const p2 = await ctx2.newPage();
  await login(p2, '+998900000006');
  await p2.goto(`${APP}/receipts/${s.receiptId}`);
  const folds = await p2.locator('details:has([data-testid="mark-lost-box"])').count();
  console.log('operator sees write-off fold:', folds, folds === 0 ? 'OK-HIDDEN' : 'LEAK');
  await ctx2.close();
} finally {
  await browser.close();
  // cleanup: movements → boxes → lots → receipt → batch → notifications
  const boxIds = (await sql`select id from boxes where short_code like ${'WLK' + stamp + '%'}`).map((r) => r.id);
  if (boxIds.length) await sql`delete from box_movements where box_id in ${sql(boxIds)}`;
  await sql`delete from boxes where id in ${sql(boxIds)}`;
  await sql`delete from receipt_lots where receipt_id = ${s.receiptId}`;
  await sql`delete from receipts where id = ${s.receiptId}`;
  await sql`delete from batches where id = ${s.batch.id}`;
  await sql`delete from notifications where type in ('BoxFoundHere','BoxLost','ReceiptMeasureCorrected') and payload->>'text' like ${'%WLK' + stamp + '%'}`;
  await sql.end();
}
console.log('WALK DONE');
