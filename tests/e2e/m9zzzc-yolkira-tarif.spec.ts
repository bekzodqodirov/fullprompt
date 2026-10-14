import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Yo'lkira tarifi bo'yicha» in a real browser on the phone (docs/
 * YOLKIRA-TAQSIMOT.md §11, his 1a 2c 3a 4a 5a 6):
 *
 *  1. the owner sets YW's tariff column to «cn» through the warehouse form
 *     (the real door), with the select drawn at 360 px;
 *  2. on a truck from YW carrying A (2 m³ at 600 kg/m³), B (1 m³ at 160) and
 *     an unclaimed prixod whose marking is 46 characters with no break in it
 *     (a fixture that cannot reach the failing width is evidence about the
 *     fixture, #576), «＋» proposes the yo'lkira type and the freight basis by
 *     itself, and the preview splits 350 by the cn column's values —
 *     A $300 × 2 = 600, B $160, the prixod $110 × 0.5 = 55 of 815 —
 *     73.62 % / 19.63 % / 6.75 %, to the cent 257.67 / 68.71 / 23.62;
 *  3. the saved row says which column split it, its «Qanday bo'lindi?» fold
 *     opens, and the Narx tab's breakdown names A's band;
 *  4. #171 behaviourally: an address-only save of YW keeps the column;
 *  5. cleanup, a final TEST: the column back to «—» through the form, the
 *     fixture gone (#183 — a column is CONFIGURATION every later spec's
 *     yo'lkira bill would read).
 *
 * seed-demo writes no column on purpose: m9zzzb enters a yo'lkira bill and
 * must keep today's weight default. Serial: every step reads the one before.
 */

const OWNER = '+998900000001';
const DEMO_PASSWORD = 'demo1234';
const RUN = String(Date.now()).slice(-6);
const TRUCK_CODE = `YLT${RUN}-001`;
const CODE_A = `YA${RUN}`;
const CODE_B = `YB${RUN}`;
const MARKING = `YLMARK${RUN}${'X'.repeat(34)}`;

test.describe.configure({ mode: 'serial' });

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The document is the phone: 360 wide and nothing scrolls sideways (#1241's oracle). */
async function fitsThePhone(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(client).toBe(360);
  expect(scroll).toBeLessThanOrEqual(client);
}

/** What this run minted — from the database, never from a variable a dead worker held (#523). */
async function runRows() {
  const sql = database();
  try {
    const [truck] = await sql<{ id: string }[]>`SELECT id FROM batches WHERE code = ${TRUCK_CODE}`;
    const [yw] = await sql<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    const clients = await sql<{ id: string; code: string }[]>`
      SELECT id, client_code AS code FROM clients WHERE client_code IN (${CODE_A}, ${CODE_B})`;
    const [unclaimed] = await sql<{ id: string }[]>`SELECT id FROM receipts WHERE unclaimed_marking = ${MARKING}`;
    return {
      truckId: truck?.id ?? null,
      ywId: yw?.id ?? null,
      a: clients.find((c) => c.code === CODE_A)?.id ?? null,
      b: clients.find((c) => c.code === CODE_B)?.id ?? null,
      unclaimedId: unclaimed?.id ?? null,
    };
  } finally {
    await sql.end();
  }
}

async function columnOf(warehouseId: string): Promise<string | null> {
  const sql = database();
  try {
    const [row] = await sql<{ zone: string }[]>`
      SELECT tariff_zone AS zone FROM warehouse_tariff_columns WHERE warehouse_id = ${warehouseId}`;
    return row?.zone ?? null;
  } finally {
    await sql.end();
  }
}

test('mint: a departed YW truck carrying A, B and an unclaimed prixod with a 46-character marking', async () => {
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = ${OWNER}`;
      const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
      const [tas] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'TAS1'`;
      if (!owner || !yw || !tas) throw new Error('the demo lacks the owner, YW or TAS1');
      const [ywColumn] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM warehouse_tariff_columns WHERE warehouse_id = ${yw.id}`;
      expect(ywColumn!.n, 'seed-demo must leave YW without a column').toBe(0);
      const [truck] = await tx<{ id: string }[]>`
        INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
        VALUES (gen_random_uuid(), ${TRUCK_CODE}, ${yw.id}, ${tas.id}, 'in_transit', now() - interval '1 hour', ${owner.id})
        RETURNING id`;
      const lot = async (client: string | null, kg: string, m3: string, marking: string | null, n: number) => {
        const [receipt] = await tx<{ id: string }[]>`
          INSERT INTO receipts (id, warehouse_id, client_id, unclaimed_marking, status, confirmed_at, created_by)
          VALUES (gen_random_uuid(), ${yw.id}, ${client}, ${marking}, 'confirmed', now(), ${owner.id})
          RETURNING id`;
        const [l] = await tx<{ id: string }[]>`
          INSERT INTO receipt_lots (id, receipt_id, seq, letter, dims_mode, product_name_zh, box_count, total_weight_kg, total_volume_m3)
          VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 'mixed', '测试货', 1, ${kg}, ${m3})
          RETURNING id`;
        const [box] = await tx<{ id: string }[]>`
          INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_batch_id)
          VALUES (gen_random_uuid(), ${l!.id}, ${`YL${RUN}-${n}`}, 1, 'in_transit', ${truck!.id})
          RETURNING id`;
        await tx`
          INSERT INTO box_movements (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause, ref_type, ref_id, actor_id)
          VALUES (${box!.id}, ${yw.id}, ${tas.id}, 'loading', 'in_transit', 'batch_departed', 'batch', ${truck!.id}, ${owner.id})`;
      };
      const [a] = await tx<{ id: string }[]>`
        INSERT INTO clients (id, client_code, name) VALUES (gen_random_uuid(), ${CODE_A}, ${`Yo'lkira A ${RUN}`}) RETURNING id`;
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO clients (id, client_code, name) VALUES (gen_random_uuid(), ${CODE_B}, ${`Yo'lkira B ${RUN}`}) RETURNING id`;
      await lot(a!.id, '1200.000', '2.0000', null, 1);
      await lot(b!.id, '160.000', '1.0000', null, 2);
      await lot(null, '50.000', '0.5000', MARKING, 3);
    });
  } finally {
    await sql.end();
  }
});

test('the warehouse form sets YW’s column to «cn», with the select drawn at 360 px', async ({ page }) => {
  const { ywId } = await runRows();
  await login(page, OWNER);
  await page.goto(`/admin/warehouses/${ywId}`);
  await page.getByTestId('wh-tariff-zone').selectOption('cn');
  await fitsThePhone(page);
  await page.locator('main form button[type="submit"]').last().click();
  await expect(page).toHaveURL(/\/admin\/warehouses$/);
  expect(await columnOf(ywId!)).toBe('cn');
});

test('«＋» proposes the yo’lkira type AND the freight basis, and the preview splits 350 by the column', async ({ page }) => {
  const { truckId, a, b, unclaimedId } = await runRows();
  await login(page, OWNER);
  await page.goto(`/batches/${truckId}/xarajatlar`);
  await page.getByTestId('add-cost').click();
  // A YW truck's panel proposes yuan; the run's money is typed in dollars so
  // the preview and the saved fold (which prints the allocations' USD) read
  // the same figures.
  await page.locator('select[aria-label="currency"]').selectOption('USD');
  await expect(page.getByTestId('cost-basis')).toHaveValue('freight');
  const preview = page.getByTestId('freight-preview');
  await expect(preview).toContainText('YW');
  await page.getByTestId('cost-amount').fill('350');
  await expect(page.getByTestId(`freight-row-c:${a}`)).toContainText('73.62 %');
  await expect(page.getByTestId(`freight-row-c:${a}`)).toContainText('257.67');
  await expect(page.getByTestId(`freight-row-c:${b}`)).toContainText('19.63 %');
  await expect(page.getByTestId(`freight-row-c:${b}`)).toContainText('68.71');
  const unclaimed = page.getByTestId(`freight-row-r:${unclaimedId}`);
  await expect(unclaimed).toContainText('6.75 %');
  await expect(unclaimed).toContainText('23.62');
  await expect(unclaimed).toContainText(MARKING);
  await fitsThePhone(page);

  await page.getByTestId('save-cost').click();
  const how = page.getByTestId('cost-freight-how');
  await expect(how).toBeVisible();
  await how.locator('summary').click();
  await expect(how.getByTestId(`cost-freight-row-c:${a}`)).toContainText('257.67');
  await fitsThePhone(page);
});

test('the Narx tab names A’s band beside its share', async ({ page }) => {
  const { truckId } = await runRows();
  await login(page, OWNER);
  await page.goto(`/batches/${truckId}/pricing`);
  const card = page.getByTestId('pricing-client').filter({ hasText: CODE_A });
  await card.getByTestId('cost-breakdown').locator('summary').click();
  const line = card.getByTestId('cost-breakdown-freight');
  await expect(line).toContainText(TRUCK_CODE);
  await expect(line).toContainText('501–700');
  await expect(line).toContainText('$300');
  await fitsThePhone(page);
});

test('#171: an address-only save of YW keeps its column', async ({ page }) => {
  const { ywId } = await runRows();
  await login(page, OWNER);
  await page.goto(`/admin/warehouses/${ywId}`);
  await expect(page.getByTestId('wh-tariff-zone')).toHaveValue('cn');
  const address = page.locator('input[name="address"]');
  const before = await address.inputValue();
  await address.fill(`${before} `);
  await page.locator('main form button[type="submit"]').last().click();
  await expect(page).toHaveURL(/\/admin\/warehouses$/);
  expect(await columnOf(ywId!)).toBe('cn');
  // Put the address back exactly (the demo's own value).
  await page.goto(`/admin/warehouses/${ywId}`);
  await page.locator('input[name="address"]').fill(before);
  await page.locator('main form button[type="submit"]').last().click();
  await expect(page).toHaveURL(/\/admin\/warehouses$/);
});

test('cleanup: YW’s column back to «—» through the form, and the run’s truck, cargo and bills gone', async ({ page }) => {
  const { ywId, truckId } = await runRows();
  await login(page, OWNER);
  await page.goto(`/admin/warehouses/${ywId}`);
  await page.getByTestId('wh-tariff-zone').selectOption('');
  await page.locator('main form button[type="submit"]').last().click();
  await expect(page).toHaveURL(/\/admin\/warehouses$/);
  expect(await columnOf(ywId!)).toBeNull();

  const sql = database();
  try {
    await sql.begin(async (tx) => {
      if (truckId) {
        await tx`DELETE FROM cost_allocations WHERE cost_entry_id IN (SELECT id FROM cost_entries WHERE batch_id = ${truckId})`;
        await tx`DELETE FROM cost_entries WHERE batch_id = ${truckId}`;
      }
      const boxes = await tx<{ id: string }[]>`SELECT id FROM boxes WHERE short_code LIKE ${`YL${RUN}-%`}`;
      const ids = boxes.map((row) => row.id);
      if (ids.length) {
        await tx`DELETE FROM box_movements WHERE box_id IN ${tx(ids)}`;
        await tx`DELETE FROM boxes WHERE id IN ${tx(ids)}`;
      }
      const receipts = await tx<{ id: string }[]>`
        SELECT r.id FROM receipts r LEFT JOIN clients c ON c.id = r.client_id
         WHERE c.client_code IN (${CODE_A}, ${CODE_B}) OR r.unclaimed_marking = ${MARKING}`;
      const rids = receipts.map((row) => row.id);
      if (rids.length) {
        await tx`DELETE FROM receipt_lots WHERE receipt_id IN ${tx(rids)}`;
        await tx`DELETE FROM receipts WHERE id IN ${tx(rids)}`;
      }
      if (truckId) await tx`DELETE FROM batches WHERE id = ${truckId}`;
      await tx`DELETE FROM clients WHERE client_code IN (${CODE_A}, ${CODE_B})`;
    });
    const [left] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM batches WHERE code = ${TRUCK_CODE})::int
           + (SELECT count(*) FROM clients WHERE client_code IN (${CODE_A}, ${CODE_B}))::int
           + (SELECT count(*) FROM warehouse_tariff_columns)::int AS n`;
    expect(left!.n).toBe(0);
  } finally {
    await sql.end();
  }
});
