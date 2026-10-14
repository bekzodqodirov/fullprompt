import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Pul qayerga ketdi» and «Partiyaga xarajat» in a real browser on the phone
 * (docs/SARFLAR.md §1-§3, his answers 1a, 5a and 6):
 *
 *  1. the accountant opens the map: the hero, the two «Qayerga» groups and
 *     the register render, and the document is exactly the phone;
 *  2. on the entry page, a truck bill whose money is ALREADY an expense on the
 *     same kassa is answered «⚠ Bu pul allaqachon yozilgan» BEFORE anything is
 *     written — every typed value survives the warning — and «Baribir
 *     saqlash» saves it; the form stays open with the type and the payer kept
 *     and only the amount cleared (5a);
 *  3. the expense form asks the same question the other way round, and the
 *     typed amount survives the warning (the form posts from onSubmit, B5);
 *  4. a filter link on the map (a soft navigation) leaves the register's
 *     form showing the filter it applied — an uncontrolled select kept the
 *     old one and «Qo'llash» posted it back (the second review's screen-1);
 *  5. cleanup, a final TEST (round 57's `afterAll` lie).
 *
 * The spec mints its OWN truck and its own expense on an existing demo kassa
 * (a kassa of its own would sit in every later picker — configuration, #183)
 * and resolves both from the database by the run's amount, never from a
 * variable a dead worker held (#523). Serial: step 3 reads the bill step 2
 * saved.
 */

const ACCOUNTANT = '+998900000010';
const DEMO_PASSWORD = 'demo1234';
const RUN = String(Date.now()).slice(-6);
const AMOUNT = (1000 + (Number(RUN) % 900) + 0.37).toFixed(2);
const TRUCK_CODE = `SFE${RUN}-001`;

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

async function fitsThePhone(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(client).toBe(360);
  expect(scroll).toBeLessThanOrEqual(client);
}

/** The truck, the kassa and the expense this run minted — from the database. */
async function runRows() {
  const sql = database();
  try {
    const [truck] = await sql<{ id: string }[]>`SELECT id FROM batches WHERE code = ${TRUCK_CODE}`;
    const [till] = await sql<{ id: string }[]>`
      SELECT id FROM money_accounts WHERE active AND currency = 'USD' ORDER BY created_at LIMIT 1`;
    return { truckId: truck?.id ?? null, tillId: till?.id ?? null };
  } finally {
    await sql.end();
  }
}

test('mint: a forming truck and an expense of this run’s amount on a USD kassa', async () => {
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
      const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
      const [tas] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'TAS1'`;
      const [till] = await tx<{ id: string }[]>`
        SELECT id FROM money_accounts WHERE active AND currency = 'USD' ORDER BY created_at LIMIT 1`;
      const [category] = await tx<{ id: string }[]>`
        SELECT id FROM expense_categories WHERE active AND cash ORDER BY sort_order LIMIT 1`;
      if (!owner || !yw || !tas || !till || !category) throw new Error('the demo lacks the owner, YW, TAS1, a USD kassa or a cash category');
      await tx`
        INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, created_by)
        VALUES (gen_random_uuid(), ${TRUCK_CODE}, ${yw.id}, ${tas.id}, 'forming', ${owner.id})`;
      await tx`
        INSERT INTO expenses (id, category_id, amount, currency, rate_to_usd, amount_usd, expense_date, account_id, created_by, note)
        VALUES (gen_random_uuid(), ${category.id}, ${AMOUNT}, 'USD', 1, ${AMOUNT},
                (now() AT TIME ZONE 'Asia/Tashkent')::date, ${till.id}, ${owner.id}, ${`sarflar e2e ${RUN}`})`;
    });
  } finally {
    await sql.end();
  }
});

test('the map renders its blocks and fits the phone', async ({ page }) => {
  await login(page, ACCOUNTANT);
  await page.goto('/accounting/sarflar');
  await expect(page.getByTestId('sarf-hero-total')).toBeVisible();
  await expect(page.getByTestId('sarf-kinds')).toBeVisible();
  await expect(page.getByTestId('sarf-categories')).toBeVisible();
  await expect(page.getByTestId('sarf-register')).toBeVisible();
  await fitsThePhone(page);
});

test('a truck bill already written as an expense: warned first, every value kept, «Baribir saqlash» saves', async ({ page }) => {
  const { truckId, tillId } = await runRows();
  expect(truckId && tillId).toBeTruthy();
  await login(page, ACCOUNTANT);
  await page.goto(`/accounting/sarflar/kiritish?p=${truckId}`);
  await expect(page.getByTestId('entry-head')).toContainText(TRUCK_CODE);
  await page.getByTestId('cost-partner').selectOption(`till:${tillId}`);
  await page.locator('select[aria-label="currency"]').selectOption('USD');
  const typeBefore = await page.locator('section select').first().inputValue();
  await page.getByTestId('cost-amount').fill(AMOUNT);
  await page.getByTestId('save-cost').click();

  const warning = page.getByTestId('twin-warning');
  await expect(warning).toBeVisible();
  await expect(warning.getByTestId('twin-line').first()).toContainText(AMOUNT);
  // Nothing was written, and nothing typed was lost.
  await expect(page.getByTestId('cost-amount')).toHaveValue(AMOUNT);
  await expect(page.getByTestId('cost-partner')).toHaveValue(`till:${tillId}`);
  await fitsThePhone(page);

  await page.getByTestId('twin-save-anyway').click();
  await expect(page.getByTestId('cost-saved')).toBeVisible();
  // The form stays open for the next bill: the amount cleared, the payer and type kept.
  await expect(page.getByTestId('cost-amount')).toHaveValue('');
  await expect(page.getByTestId('cost-partner')).toHaveValue(`till:${tillId}`);
  await expect(page.locator('section select').first()).toHaveValue(typeBefore);
  await expect(page.getByTestId('entry-today')).toContainText(TRUCK_CODE);
});

test('the expense form asks the same question, and the typed amount survives it', async ({ page }) => {
  const { tillId } = await runRows();
  await login(page, ACCOUNTANT);
  await page.goto('/accounting/expenses');
  await page.locator('select[name="accountId"]').first().selectOption(tillId!);
  await page.locator('select[name="currency"]').first().selectOption('USD');
  await page.getByTestId('expense-amount').fill(AMOUNT);
  await page.getByTestId('save-expense').click();
  await expect(page.getByTestId('twin-warning')).toBeVisible();
  await expect(page.getByTestId('expense-amount')).toHaveValue(AMOUNT);
  await page.getByTestId('twin-back').click();
  await expect(page.getByTestId('twin-warning')).toBeHidden();
  await expect(page.getByTestId('expense-amount')).toHaveValue(AMOUNT);
});

test('a filter link on the map keeps the register’s form in step — no stale select to post back', async ({ page }) => {
  await login(page, ACCOUNTANT);
  await page.goto('/accounting/sarflar');
  // A soft navigation to the same page: the bar's link only changes the query.
  await page.getByTestId('spend-bar-batch').getByRole('link').click();
  await expect(page).toHaveURL(/joy=batch/);
  await expect(page.getByTestId('sarf-register').locator('select[name="joy"]')).toHaveValue('batch');
  await fitsThePhone(page);
});

test('cleanup: this run’s bills, its expense and its truck are gone', async () => {
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      const trucks = await tx<{ id: string }[]>`SELECT id FROM batches WHERE code = ${TRUCK_CODE}`;
      for (const truck of trucks) {
        await tx`DELETE FROM cost_allocations WHERE cost_entry_id IN (SELECT id FROM cost_entries WHERE batch_id = ${truck.id})`;
        await tx`DELETE FROM cost_entries WHERE batch_id = ${truck.id}`;
        await tx`DELETE FROM batches WHERE id = ${truck.id}`;
      }
      await tx`DELETE FROM expenses WHERE note = ${`sarflar e2e ${RUN}`}`;
    });
    const [left] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM batches WHERE code = ${TRUCK_CODE})::int
           + (SELECT count(*) FROM expenses WHERE note = ${`sarflar e2e ${RUN}`})::int AS n`;
    expect(left!.n).toBe(0);
  } finally {
    await sql.end();
  }
});
