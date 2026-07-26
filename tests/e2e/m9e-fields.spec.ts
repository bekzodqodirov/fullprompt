import { expect, test } from '@playwright/test';

/**
 * Custom fields on an object that is not a lead or a client.
 *
 * The engine has been exercised at the unit level; what this proves is the
 * part only a browser can: a field the owner invents at /admin/fields appears
 * on a card the CRM never touched, is filled in there, and comes back as a
 * column and a filter on the list — with a second field appearing only once
 * the first is answered.
 *
 * Every field it creates is deleted at the end, because this suite runs one
 * worker over one database in file order and a required field left behind
 * would break a create form four specs earlier on the next run.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** Delete a field by its label — the panel it lives in has to be open first. */
async function removeField(
  page: import('@playwright/test').Page,
  entity: string,
  label: string,
) {
  await page.goto('/admin/fields');
  await page.getByTestId(`entity-${entity}`).click();
  const row = page
    .locator('form')
    .filter({ has: page.locator(`input[data-testid="field-label"][value="${label}"]`) });
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: '🗑' }).click();
  await expect(page.locator(`input[value="${label}"]`)).toHaveCount(0);
}

async function addField(
  page: import('@playwright/test').Page,
  spec: { label: string; entity: string; type: string; options?: string; onList?: boolean },
) {
  await page.goto('/admin/fields');
  await page.getByTestId('new-field-panel').click();
  const form = page.getByTestId('field-new');
  await form.getByTestId('field-label').fill(spec.label);
  await form.getByTestId('field-entity').selectOption(spec.entity);
  await form.getByTestId('field-type').selectOption(spec.type);
  if (spec.options) await form.getByTestId('field-options').fill(spec.options);
  if (spec.onList) await form.getByTestId('field-on-list').check();
  await form.getByTestId('save-field').click();
  await expect(form.getByText('✅')).toBeVisible();
}

test('a field invented for clients reaches the card, the list and the export', async ({ page }) => {
  await login(page, OWNER);
  const city = `Shahar ${runId}`;
  await addField(page, {
    label: city,
    entity: 'client',
    type: 'select',
    options: 'Toshkent, Andijon',
    onList: true,
  });

  // The card asks for it, and it is not the CRM panel — a client manager with
  // no CRM rights sees this one.
  await page.goto('/admin/clients');
  // tbody: the header cells are sort LINKS, and `table a` finds those first.
  await page.locator('table tbody a').first().click();
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]+$/);
  const panel = page.getByTestId('custom-fields');
  await expect(panel).toBeVisible();
  await panel.click();
  await page.getByLabel(city).selectOption('Andijon');
  await page.getByTestId('save-custom-fields').click();
  await expect(page.getByTestId('save-custom-fields')).toHaveText('✅');

  // …and it comes back as a column, a filter and a spreadsheet.
  await page.goto('/admin/clients');
  await expect(page.getByRole('columnheader', { name: city })).toBeVisible();
  await expect(page.getByTestId('custom-filters')).toBeVisible();

  const before = await page.locator('table tbody tr').count();
  await page.getByLabel(city).selectOption('Toshkent');
  await page.getByTestId('custom-filters').getByRole('button').click();
  await expect(page).toHaveURL(/cf_/);
  // Nobody is in Tashkent, so the filter really filtered.
  expect(await page.locator('table tbody tr').count()).toBeLessThan(before);

  const download = await page.request.get('/api/clients/xlsx');
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toContain('spreadsheetml');

  await removeField(page, 'client', city);
});

test('a field on a receipt, shown only when another one says so', async ({ page }) => {
  await login(page, OWNER);
  const kind = `Hujjat turi ${runId}`;
  const number = `Hujjat raqami ${runId}`;

  await addField(page, {
    label: kind,
    entity: 'receipt',
    type: 'select',
    options: 'Shartnoma, Invoys',
  });

  // The second field appears only when the first answers "Shartnoma".
  await page.goto('/admin/fields');
  await page.getByTestId('new-field-panel').click();
  const form = page.getByTestId('field-new');
  await form.getByTestId('field-label').fill(number);
  await form.getByTestId('field-entity').selectOption('receipt');
  await form.getByTestId('field-type').selectOption('text');
  await form.getByRole('button', { name: /Yana|Ещё|More|更多/ }).click();
  await form.locator('select[name="showIfField"]').selectOption({ label: kind });
  await form.locator('input[name="showIfValues"]').fill('Shartnoma');
  await form.getByTestId('save-field').click();
  await expect(form.getByText('✅')).toBeVisible();

  await page.goto('/receipts');
  await page.locator('a[href^="/receipts/"]').first().click();
  await expect(page).toHaveURL(/\/receipts\/[0-9a-f-]+$/);
  const panel = page.getByTestId('custom-fields');
  await expect(panel).toBeVisible();
  await panel.click();

  // Hidden while the parent is unanswered…
  await expect(page.getByLabel(number)).toHaveCount(0);
  await page.getByLabel(kind).selectOption('Shartnoma');
  // …and there the moment it says so, with no round trip.
  await expect(page.getByLabel(number)).toBeVisible();
  await page.getByLabel(number).fill('D-42');
  await page.getByTestId('save-custom-fields').click();
  await expect(page.getByTestId('save-custom-fields')).toHaveText('✅');

  await page.reload();
  await page.getByTestId('custom-fields').click();
  await expect(page.getByLabel(number)).toHaveValue('D-42');

  // Tidy up: the child first, because the parent refuses to go while
  // something depends on it.
  await removeField(page, 'receipt', number);
  await removeField(page, 'receipt', kind);
});

test('the field editor is not reachable without the dictionaries permission', async ({ page }) => {
  await login(page, '+998900000005');
  await page.goto('/admin/fields');
  await expect(page).toHaveURL('/');
});
