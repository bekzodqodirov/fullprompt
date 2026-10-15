import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * The yo'lkira preview on a truck with MANY clients, on the phone (docs/
 * YOLKIRA-TAQSIMOT.md §15.4, judge J9). From deploy day every yo'lkira bill
 * on every truck draws the split preview between the amount and «kim
 * to'ladi» / Saqlash; uncapped, a consolidation truck pushed Saqlash screens
 * below the amount on every bill of the accountant's loop.
 *
 *  1. a departed YW truck carries seven clients, one 1 m³ lot each, at seven
 *     densities;
 *  2. the preview draws a summary line, the five largest shares and «+2
 *     mijoz · $…»; Saqlash stays within one screen below the amount; the
 *     button opens the other two;
 *  3. cleanup, a final TEST: the fixture gone. The run configures nothing.
 */

const OWNER = '+998900000001';
const DEMO_PASSWORD = 'demo1234';
const RUN = String(Date.now()).slice(-6);
const TRUCK_CODE = `YLM${RUN}-001`;
// kg on 1 m³ each: bands 1–100 $110, 151–200 $160, 251–300 $200, 451–500 $290,
// 501–700 $300, 701–999 $320, 1000+ $0.55 × 1200 = $660.
const KG = ['90.000', '180.000', '280.000', '480.000', '600.000', '800.000', '1200.000'];
const CODES = KG.map((_, i) => `YM${RUN}${i}`);

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

async function truckId(): Promise<string | null> {
  const sql = database();
  try {
    const [truck] = await sql<{ id: string }[]>`SELECT id FROM batches WHERE code = ${TRUCK_CODE}`;
    return truck?.id ?? null;
  } finally {
    await sql.end();
  }
}

test('mint: a departed YW truck carrying seven clients, one lot each', async () => {
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = ${OWNER}`;
      const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
      const [tas] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'TAS1'`;
      if (!owner || !yw || !tas) throw new Error('the demo lacks the owner, YW or TAS1');
      const [truck] = await tx<{ id: string }[]>`
        INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
        VALUES (gen_random_uuid(), ${TRUCK_CODE}, ${yw.id}, ${tas.id}, 'in_transit', now() - interval '1 hour', ${owner.id})
        RETURNING id`;
      for (const [i, kg] of KG.entries()) {
        const [client] = await tx<{ id: string }[]>`
          INSERT INTO clients (id, client_code, name) VALUES (gen_random_uuid(), ${CODES[i]!}, ${`Ko'p mijoz ${i} ${RUN}`}) RETURNING id`;
        const [receipt] = await tx<{ id: string }[]>`
          INSERT INTO receipts (id, warehouse_id, client_id, status, confirmed_at, created_by)
          VALUES (gen_random_uuid(), ${yw.id}, ${client!.id}, 'confirmed', now(), ${owner.id})
          RETURNING id`;
        const [lot] = await tx<{ id: string }[]>`
          INSERT INTO receipt_lots (id, receipt_id, seq, letter, dims_mode, product_name_zh, box_count, total_weight_kg, total_volume_m3)
          VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 'mixed', '测试货', 1, ${kg}, '1.0000')
          RETURNING id`;
        const [box] = await tx<{ id: string }[]>`
          INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_batch_id)
          VALUES (gen_random_uuid(), ${lot!.id}, ${`YM${RUN}-${i}`}, 1, 'in_transit', ${truck!.id})
          RETURNING id`;
        await tx`
          INSERT INTO box_movements (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause, ref_type, ref_id, actor_id)
          VALUES (${box!.id}, ${yw.id}, ${tas.id}, 'loading', 'in_transit', 'batch_departed', 'batch', ${truck!.id}, ${owner.id})`;
      }
    });
  } finally {
    await sql.end();
  }
});

test('the preview draws five clients and «+2 mijoz»; Saqlash stays within one screen of the amount', async ({ page }) => {
  const id = await truckId();
  await login(page, OWNER);
  await page.goto(`/batches/${id}/xarajatlar`);
  await page.getByTestId('add-cost').click();
  await page.locator('select[aria-label="currency"]').selectOption('USD');
  await expect(page.getByTestId('cost-basis')).toHaveValue('freight');
  await page.getByTestId('cost-amount').fill('700');
  const preview = page.getByTestId('freight-preview');
  await expect(preview.getByTestId('freight-row-summary')).toContainText('7');
  const clientRows = preview.locator('[data-testid^="freight-row-c:"]');
  await expect(clientRows).toHaveCount(5);
  // Values 110 160 200 290 300 320 660 = 2040; the two smallest (110, 160) are
  // behind the button: 700 × 270 / 2040 = 92.65 by the largest remainder.
  await expect(preview.getByTestId('freight-row-more')).toContainText('+2');
  await expect(preview.getByTestId('freight-row-more')).toContainText('92.65');

  const amount = await page.getByTestId('cost-amount').boundingBox();
  const save = await page.getByTestId('save-cost').boundingBox();
  expect(amount && save).toBeTruthy();
  expect(save!.y - (amount!.y + amount!.height)).toBeLessThan(800);
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(client).toBe(360);
  expect(scroll).toBeLessThanOrEqual(client);

  await preview.getByTestId('freight-row-more').click();
  await expect(clientRows).toHaveCount(7);
});

test('cleanup: the run’s truck, cargo and clients gone', async () => {
  const id = await truckId();
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      if (id) {
        await tx`DELETE FROM cost_allocations WHERE cost_entry_id IN (SELECT id FROM cost_entries WHERE batch_id = ${id})`;
        await tx`DELETE FROM cost_entries WHERE batch_id = ${id}`;
      }
      const boxes = await tx<{ id: string }[]>`SELECT id FROM boxes WHERE short_code LIKE ${`YM${RUN}-%`}`;
      const ids = boxes.map((row) => row.id);
      if (ids.length) {
        await tx`DELETE FROM box_movements WHERE box_id IN ${tx(ids)}`;
        await tx`DELETE FROM boxes WHERE id IN ${tx(ids)}`;
      }
      const receipts = await tx<{ id: string }[]>`
        SELECT r.id FROM receipts r JOIN clients c ON c.id = r.client_id WHERE c.client_code IN ${tx(CODES)}`;
      const rids = receipts.map((row) => row.id);
      if (rids.length) {
        await tx`DELETE FROM receipt_lots WHERE receipt_id IN ${tx(rids)}`;
        await tx`DELETE FROM receipts WHERE id IN ${tx(rids)}`;
      }
      if (id) await tx`DELETE FROM batches WHERE id = ${id}`;
      await tx`DELETE FROM clients WHERE client_code IN ${tx(CODES)}`;
    });
    const [left] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM batches WHERE code = ${TRUCK_CODE})::int
           + (SELECT count(*) FROM clients WHERE client_code IN ${sql(CODES)})::int AS n`;
    expect(left!.n).toBe(0);
  } finally {
    await sql.end();
  }
});
