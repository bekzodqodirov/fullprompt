import { expect, test } from '@playwright/test';

/**
 * The owner's money round: a truck-wide cost is entered once, the pricing
 * screen shows what it cost us per client next to what we charge and the
 * margin between, and the client's own card says where their cargo is and
 * which trip the debt came from.
 *
 * Since his Q19 (2026-09-25, «ved hodimi kassa foyda zararni umuman
 * ko'rmasin, tannarxni ham»): the VED still PRICES the truck, on a page that
 * carries no cost, no margin and no tannarx; the cost assertions moved to
 * the accountant. The VED still records the client's payment, with no kassa
 * picker — the accountant places it into the drawer.
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

  // The prixod cost grid names the GOODS now (owner, 2026-09-24: «tovar
  // nomi, karobka soni va rasmi … klient kod, tovar nomi bo'yicha
  // filterlash»), and filters in the browser without dropping typed cells.
  await page.goto(`${batchUrl}/xarajatlar`);
  const gridRows = page.getByTestId('grid-row');
  await expect(gridRows.filter({ hasText: clientCode }).first()).toBeVisible();
  await expect(gridRows.first()).toContainText('📦');
  await page.getByTestId('grid-search').fill(`nomatch-${runId}`);
  await expect(gridRows).toHaveCount(0);
  await page.getByTestId('grid-search').fill(clientCode.toLowerCase());
  await expect(gridRows.filter({ hasText: clientCode }).first()).toBeVisible();
  // A number the reader cannot read is RED and stops the save — it used to
  // be dropped silently and then wiped by the success.
  const firstCell = gridRows.first().locator('input').first();
  await firstCell.fill('12abc');
  await expect(page.getByTestId('grid-bad')).toBeVisible();
  await expect(page.getByTestId('save-cost-grid')).toBeDisabled();
  await firstCell.fill('');
  await expect(page.getByTestId('grid-bad')).toHaveCount(0);

  // --- The VED: the truck's costs are the logist's, so he reads their TYPE
  // and never their amount (Q19 D1) ---
  await login(page, VED);
  await page.goto(batchUrl);
  await expect(page.getByText('≈ $90')).toHaveCount(0);
  await expect(page.getByTestId('cost-others')).toBeVisible();
  await expect(page.getByTestId('cost-others')).toContainText('🔒');
  await expect(page.getByTestId('batch-pricing-link')).toBeVisible();

  // --- …and prices it on a page with no cost, no margin, no tannarx ---
  await page.goto(`${batchUrl}/pricing`);
  const card = page.getByTestId('pricing-client').filter({ hasText: clientCode });
  await expect(card).toBeVisible();
  await expect(page.getByTestId('pricing-total-cost')).toHaveCount(0);
  await expect(card.getByTestId('client-cost')).toHaveCount(0);
  await expect(card.getByTestId('lot-cost')).toHaveCount(0);
  await expect(card.getByTestId('cost-breakdown')).toHaveCount(0);
  // The client still opens into the goods that rode, with a door into its
  // prixod (the owner's answer 1c: the price stays one per client).
  const goods = card.getByTestId('pricing-lot').first();
  await expect(goods).toBeVisible();
  await expect(goods.locator('a[href^="/receipts/"]')).toBeVisible();
  await card.locator('input[name="amount"]').fill('150');
  await card.locator('select[name="currency"]').selectOption('USD');
  await card.getByRole('button', { name: /🧾|✅|…/ }).click();
  await expect(card.getByText('✅')).toBeVisible({ timeout: 15_000 });

  await page.goto(`${batchUrl}/pricing`);
  const priced = page.getByTestId('pricing-client').filter({ hasText: clientCode });
  await expect(priced.getByText('$150.00').first()).toBeVisible();

  // --- The accountant reads the tannarx the VED no longer does ---
  await login(page, ACCOUNTANT);
  await page.goto(`${batchUrl}/pricing`);
  const costed = page.getByTestId('pricing-client').filter({ hasText: clientCode });
  // The truck's customs reached this client as their own share…
  await expect(costed.getByTestId('client-cost')).not.toHaveText('$0.00');
  // …and each lot carries its own exact tannarx.
  await expect(costed.getByTestId('pricing-lot').first().getByTestId('lot-cost')).not.toHaveText('$0.00');

  // --- …and mints the cash box the payment will land in ---
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
  // The register is every payment WITH its cash box — no door to it (Q19).
  await expect(page.locator('a[href="/finance/reestr"]')).toHaveCount(0);
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
  // The VED is not shown the drawers (Q19): the form says who names them.
  await expect(ledgerForm.locator('select[name="accountId"]')).toHaveCount(0);
  await expect(ledgerForm.getByTestId('tx-no-till')).toBeVisible();
  await ledgerForm.locator('input[name="amount"]').fill('150');
  await ledgerForm.locator('select[name="currency"]').selectOption('USD');
  await ledgerForm.locator('button[type="submit"]').click();
  await expect(ledgerForm.getByText('✅')).toBeVisible({ timeout: 15_000 });
  await page.reload();
  // The trip still shows what it was priced at — what changed is that none
  // of it is outstanding, so the balance is zero.
  await expect(page.getByText('$0.00').first()).toBeVisible();
  // His own payment, not yet placed, is still his to take back.
  const paymentRow = page.locator('div.border-b').filter({ hasText: '➕' }).filter({ hasText: '150 USD' }).first();
  await expect(paymentRow.getByRole('button', { name: /✖/ })).toBeVisible();
  // The register and the tannarx file are not his.
  await page.goto('/finance/reestr');
  await expect(page).toHaveURL('/');
  expect((await page.request.get('/api/reports/landed-cost')).status()).toBe(403);

  // --- The accountant places it into the drawer it landed in ---
  await login(page, ACCOUNTANT);
  await page.goto('/finance/reestr?joylanmagan=1');
  const unplacedRow = page
    .locator('tr')
    .filter({ hasText: clientCode })
    .filter({ has: page.getByTestId('place-payment') })
    .first();
  await unplacedRow.locator('select[name="accountId"]').selectOption({ label: `M9 kassa ${runId}` });
  await unplacedRow.getByTestId('place-payment').locator('button[type="submit"]').click();
  await expect(page.locator('tr').filter({ hasText: clientCode }).getByTestId('place-payment')).toHaveCount(0, {
    timeout: 15_000,
  });

  // …and the money now sits in the named cash box.
  await page.goto('/accounting/cashflow');
  // The period's kassa table (U13): the box closes the period holding it.
  const boxRow = page.getByTestId('recon-kassa').filter({ hasText: `M9 kassa ${runId}` });
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
