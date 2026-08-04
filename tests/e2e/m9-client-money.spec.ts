import { expect, test } from '@playwright/test';

/**
 * The owner's money round: a truck-wide cost is entered once, the pricing
 * screen shows what it cost us per client next to what we charge and the
 * margin between, and the client's own card says where their cargo is and
 * which trip the debt came from.
 */

const LOGIST = '+998900000003';
const VED = '+998900000004';
const SALES = '+998900000009';
const ACCOUNTANT = '+998900000010';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  // This test changes hands three times in one context — /login redirects a
  // logged-in visitor straight back to /, so the previous session has to go
  // before the form exists.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('cost → price → margin, and the client card knows which trip', async ({ page }) => {
  // --- The logist ships one box and books the truck's customs cost ---
  await login(page, LOGIST);
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  await page.getByTestId('plan-dest').selectOption({ label: 'AND' });
  const firstRow = page
    .locator('#plan-stock-table tbody tr')
    .filter({ hasText: /GS\d+/ })
    .first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  const rowCode = await firstRow.locator('td').nth(1).innerText(); // GS777-A
  const clientCode = rowCode.split('-')[0]!;
  // The stock figures the owner asked for are on the row itself now, so a
  // plan is built by weight without opening another screen.
  await expect(firstRow.locator('td')).toHaveCount(10);
  await firstRow.locator('input').fill('1');
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByTestId('verdict-approve').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+$/, { timeout: 15_000 });
  const batchUrl = new URL(page.url()).pathname;

  // Every batch is born with a driver code, printed on the header.
  await expect(page.getByTestId('batch-pair-code')).toHaveText(/^[A-Z2-9]{6}$/);

  await page.getByTestId('open-loading').click();
  await expect(page.getByTestId('load-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('load-counter')).toHaveText(/1\/1/);
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });
  await page.goto(batchUrl);
  await page.getByTestId('finish-loading').click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('depart-batch').click();
  await expect(page.getByText(/🚀/).first()).toBeVisible({ timeout: 15_000 });

  // Customs for the whole truck, in USD so no FX rate is needed.
  await page.goto(batchUrl);
  await page.getByTestId('add-cost').click();
  await page.getByTestId('cost-amount').fill('90');
  await page.locator('select[aria-label="currency"]').selectOption('USD');
  await page.getByTestId('save-cost').click();
  await expect(page.getByText('≈ $90')).toBeVisible({ timeout: 15_000 });

  // --- The VED manager prices it and sees cost, price and margin ---
  await login(page, VED);
  await page.goto(`${batchUrl}/pricing`);
  const card = page.locator('.card').filter({ hasText: clientCode });
  // The truck's customs reached this client as their own share.
  await expect(card.getByTestId('client-cost')).not.toHaveText('$0.00');
  await card.locator('input[name="amount"]').fill('150');
  await card.locator('select[name="currency"]').selectOption('USD');
  await card.getByRole('button', { name: /🧾|✅|…/ }).click();
  await expect(card.getByText('✅')).toBeVisible({ timeout: 15_000 });

  await page.goto(`${batchUrl}/pricing`);
  const priced = page.locator('.card').filter({ hasText: clientCode });
  await expect(priced.getByText('$150.00').first()).toBeVisible();

  // --- The accountant mints the cash box the payment will land in ---
  await login(page, ACCOUNTANT);
  await page.goto('/accounting/accounts');
  const accountForm = page.locator('form').filter({ has: page.getByTestId('save-account') });
  await page.getByTestId('account-name').first().fill(`M9 kassa ${runId}`);
  // The form's currency select has no default for a new account — pin USD so
  // the ledger option label below is deterministic.
  await accountForm.locator('select[name="currency"]').selectOption('USD');
  await accountForm.locator('input[name="openingBalance"]').fill('0');
  await page.getByTestId('save-account').click();
  await expect(page.getByText(`M9 kassa ${runId}`).first()).toBeVisible();

  // --- The ledger says which trip the debt is from ---
  await login(page, VED);
  await page.goto('/finance');
  await page.getByRole('link', { name: new RegExp(clientCode) }).first().click();
  await expect(page).toHaveURL(/\/finance\/[0-9a-f-]+$/);
  // The new block: one row per trip, carrying its cargo and what is still
  // owed on it — a balance alone never settles an argument on the phone.
  const trip = page.locator('a[href^="/batches/"]').first();
  await expect(trip).toContainText(/YW-\d{3}/);
  await expect(trip).toContainText('$150.00');

  // Settle it before leaving. A test that walks away from a debt arms the
  // handover debt gate against every later run of the suite — which is
  // exactly how m5-issue started failing on a second pass.
  const ledgerForm = page.locator('form').filter({ has: page.locator('input[name="txDate"]') });
  await ledgerForm.locator('input[name="amount"]').fill('150');
  await ledgerForm.locator('select[name="currency"]').selectOption('USD');
  // The audit defect: a payment could not say WHICH cash box it landed in —
  // the ledger form simply had no way to pick one.
  await ledgerForm
    .locator('select[name="accountId"]')
    .selectOption({ label: `M9 kassa ${runId} (USD)` });
  await ledgerForm.locator('button[type="submit"]').click();
  await expect(ledgerForm.getByText('✅')).toBeVisible({ timeout: 15_000 });
  await page.reload();
  // The trip still shows what it was priced at — what changed is that none
  // of it is outstanding, so the balance is zero.
  await expect(page.getByText('$0.00').first()).toBeVisible();

  // …and the money now sits in the named cash box, visible to the accountant.
  await login(page, ACCOUNTANT);
  await page.goto('/accounting/cashflow');
  const boxRow = page.locator('div.items-baseline').filter({ hasText: `M9 kassa ${runId}` });
  await expect(boxRow).toContainText('150 USD');
});

test('a sales manager opens their own client book', async ({ page }) => {
  await login(page, SALES);
  await page.goto('/my-clients');
  await expect(page).toHaveURL('/my-clients');
  // Own book by default — the toggle to everyone is not offered here.
  await expect(page.getByRole('link', { name: /⇄/ })).toHaveCount(0);

  // The seeded clients belong to this manager, and each row leads to the
  // card that now answers "where is the cargo and what is owed".
  const rows = page.getByTestId('my-client-row');
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  await rows.filter({ hasText: 'GS777' }).first().click();
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]+$/);
  await expect(page.getByText(/YW-\d{3}/).first()).toBeVisible();
});
