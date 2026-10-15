import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Yo'lkira tarifi bo'yicha» in a real browser on the phone (docs/
 * YOLKIRA-TAQSIMOT.md §11, §15 — his 1a 2b of 2026-10-15 over 3a 4a 5a 6):
 *
 *  1. a truck from YW carries A — ONE prixod with two lots, yostiq 1 m³ at
 *     100 kg/m³ and kafel 1 m³ at 1100 kg/m³ — B (1 m³ at 160) and an
 *     unclaimed prixod whose marking is 46 characters with no break in it (a
 *     fixture that cannot reach the failing width is evidence about the
 *     fixture, #576). Nothing is configured anywhere (his 1a: one table for
 *     every truck), and «＋» proposes the yo'lkira type and the freight basis
 *     by itself;
 *  2. the preview splits 350 by EACH LOT's own row of the cn column (his 2b):
 *     yostiq $110, kafel 1100 × $0.55 = $605, B $160, the prixod $110 × 0.5 =
 *     55 — of 930: A 76.88 % (41.40 + 227.69 = 269.09), B 17.2 % / 60.21,
 *     the prixod 5.91 % / 20.70. The client grain read A at 600 kg/m³ → $600,
 *     which is what this spec exists to tell apart;
 *  3. the saved row's «Qanday bo'lindi?» fold opens A's lots, and the Narx
 *     tab's breakdown names BOTH of A's bands;
 *  4. cleanup, a final TEST: the fixture gone. The run configures nothing.
 *
 * Serial: every step reads the one before.
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
    const aLots = await sql<{ id: string; goods: string }[]>`
      SELECT rl.id, rl.product_name_ru AS goods FROM receipt_lots rl
        JOIN receipts r ON r.id = rl.receipt_id JOIN clients c ON c.id = r.client_id
       WHERE c.client_code = ${CODE_A}`;
    return {
      truckId: truck?.id ?? null,
      ywId: yw?.id ?? null,
      a: clients.find((c) => c.code === CODE_A)?.id ?? null,
      b: clients.find((c) => c.code === CODE_B)?.id ?? null,
      unclaimedId: unclaimed?.id ?? null,
      yostiq: aLots.find((l) => l.goods === 'Yostiq')?.id ?? null,
      kafel: aLots.find((l) => l.goods === 'Kafel')?.id ?? null,
    };
  } finally {
    await sql.end();
  }
}

test('mint: a departed YW truck carrying A (two lots in one prixod), B and an unclaimed prixod with a 46-character marking', async () => {
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
      const prixod = async (client: string | null, marking: string | null) => {
        const [receipt] = await tx<{ id: string }[]>`
          INSERT INTO receipts (id, warehouse_id, client_id, unclaimed_marking, status, confirmed_at, created_by)
          VALUES (gen_random_uuid(), ${yw.id}, ${client}, ${marking}, 'confirmed', now(), ${owner.id})
          RETURNING id`;
        return receipt!.id;
      };
      const lot = async (receiptId: string, kg: string, m3: string, n: number, seq = 1, goods: string | null = null) => {
        const letter = String.fromCharCode(64 + seq);
        const [l] = await tx<{ id: string }[]>`
          INSERT INTO receipt_lots (id, receipt_id, seq, letter, dims_mode, product_name_zh, product_name_ru, box_count, total_weight_kg, total_volume_m3)
          VALUES (gen_random_uuid(), ${receiptId}, ${seq}, ${letter}, 'mixed', '测试货', ${goods}, 1, ${kg}, ${m3})
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
      const aPrixod = await prixod(a!.id, null);
      await lot(aPrixod, '100.000', '1.0000', 1, 1, 'Yostiq');
      await lot(aPrixod, '1100.000', '1.0000', 4, 2, 'Kafel');
      await lot(await prixod(b!.id, null), '160.000', '1.0000', 2);
      await lot(await prixod(null, MARKING), '50.000', '0.5000', 3);
    });
  } finally {
    await sql.end();
  }
});

test('«＋» proposes the yo’lkira type AND the freight basis on a truck nobody configured, and splits 350 by each lot', async ({ page }) => {
  const { truckId, a, b, unclaimedId, yostiq, kafel } = await runRows();
  await login(page, OWNER);
  await page.goto(`/batches/${truckId}/xarajatlar`);
  await page.getByTestId('add-cost').click();
  // A YW truck's panel proposes yuan; the run's money is typed in dollars so
  // the preview and the saved fold (which prints the allocations' USD) read
  // the same figures.
  await page.locator('select[aria-label="currency"]').selectOption('USD');
  await expect(page.getByTestId('cost-basis')).toHaveValue('freight');
  const preview = page.getByTestId('freight-preview');
  await expect(preview).toContainText('2026-01-01');
  await expect(page.getByTestId('freight-table-hint')).toBeVisible();
  await page.getByTestId('cost-amount').fill('350');
  const rowA = page.getByTestId(`freight-row-c:${a}`);
  await expect(rowA).toContainText('76.88 %');
  await expect(rowA).toContainText('269.09');
  // A closed client draws no lot rows at all; opened, each lot names its goods and its own share.
  await expect(page.getByTestId(`freight-row-l:${kafel}`)).toHaveCount(0);
  await page.getByTestId(`freight-row-open-c:${a}`).click();
  await expect(page.getByTestId(`freight-row-l:${yostiq}`)).toContainText('Yostiq');
  await expect(page.getByTestId(`freight-row-l:${yostiq}`)).toContainText('11.83 %');
  await expect(page.getByTestId(`freight-row-l:${yostiq}`)).toContainText('41.40');
  await expect(page.getByTestId(`freight-row-l:${kafel}`)).toContainText('Kafel');
  await expect(page.getByTestId(`freight-row-l:${kafel}`)).toContainText('65.05 %');
  await expect(page.getByTestId(`freight-row-l:${kafel}`)).toContainText('227.69');
  await expect(page.getByTestId(`freight-row-c:${b}`)).toContainText('17.2 %');
  await expect(page.getByTestId(`freight-row-c:${b}`)).toContainText('60.21');
  const unclaimed = page.getByTestId(`freight-row-r:${unclaimedId}`);
  await expect(unclaimed).toContainText('5.91 %');
  await expect(unclaimed).toContainText('20.70');
  await expect(unclaimed).toContainText(MARKING);
  await fitsThePhone(page);

  await page.getByTestId('save-cost').click();
  const how = page.getByTestId('cost-freight-how');
  await expect(how).toBeVisible();
  await how.locator('summary').click();
  await expect(how.getByTestId(`cost-freight-row-c:${a}`)).toContainText('269.09');
  await how.getByTestId(`cost-freight-row-open-c:${a}`).click();
  await expect(how.getByTestId(`cost-freight-row-l:${kafel}`)).toContainText('227.69');
  await expect(how.getByTestId(`cost-freight-row-l:${yostiq}`)).toContainText('41.40');
  await fitsThePhone(page);
});

test('the Narx tab names BOTH of A’s bands (each lot on its own row)', async ({ page }) => {
  const { truckId } = await runRows();
  await login(page, OWNER);
  await page.goto(`/batches/${truckId}/pricing`);
  const card = page.getByTestId('pricing-client').filter({ hasText: CODE_A });
  await card.getByTestId('cost-breakdown').locator('summary').click();
  const line = card.getByTestId('cost-breakdown-freight');
  await expect(line).toContainText(TRUCK_CODE);
  await expect(line).toContainText('1000+');
  await expect(line).toContainText('$0.55');
  await expect(line).toContainText('1–100');
  await expect(line).toContainText('$110');
  // «; » between two bands — « · » is already inside one (judge J15).
  await expect(line).toContainText('; ');
  // Each lot row says its own share of the bill — his «aynan shu tovar qancha foizdaligi» (judge J36).
  const shares = card.getByTestId('lot-freight-share');
  await expect(shares.filter({ hasText: '65.05 %' })).toContainText('1000+');
  await expect(shares.filter({ hasText: '11.83 %' })).toContainText('1–100');
  await fitsThePhone(page);
});

test('cleanup: the run’s truck, cargo and bills gone', async () => {
  const { truckId } = await runRows();

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
           + (SELECT count(*) FROM clients WHERE client_code IN (${CODE_A}, ${CODE_B}))::int AS n`;
    expect(left!.n).toBe(0);
  } finally {
    await sql.end();
  }
});
