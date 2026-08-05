import { expect, test } from '@playwright/test';

/**
 * The canned replies, managed in the browser.
 *
 * What the rules do is proven in the unit and integration suites. What only a
 * browser can show is that the door exists, that the screen stores the
 * template as WRITTEN — `{ism}` and `{kod}` intact, because filling them is
 * the composer's job at the moment it knows the client — and that a manager
 * can take one back off.
 *
 * The template it creates is PERSONAL and it is deleted at the end: a shared
 * one would change what every colleague's composer offers for the rest of the
 * run, and a template is configuration (#183).
 *
 * NOT covered here, and stated: the ⚡ picker inside a composer. A composer is
 * only rendered where the actor's own Telegram account holds the chat, and CI
 * has no Telegram configuration at all (the same reason m9x can only prove the
 * honest refusal).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const TITLE = `Yuk keldi ${Date.now().toString().slice(-6)}`;
const BODY = 'Hurmatli {ism}, {kod} yukingiz omborga yetib keldi.';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const row = (page: import('@playwright/test').Page, title: string) =>
  page.locator('.card').filter({ hasText: title });

test('the conversations screen has a door to the templates', async ({ page }) => {
  await login(page);
  await page.goto('/suhbatlar');
  await page.getByTestId('templates-link').click();
  await expect(page).toHaveURL('/suhbatlar/shablonlar');
  // The hint is the whole instruction manual: two words in braces. Scoped —
  // the templates themselves contain the same braces.
  await expect(page.getByTestId('template-hint')).toContainText('{ism}');
  await expect(page.getByTestId('template-hint')).toContainText('{kod}');
});

test('a template is stored exactly as written', async ({ page }) => {
  await login(page);
  await page.goto('/suhbatlar/shablonlar');
  await page.getByTestId('add-template').click();
  await page.locator('input[name="title"]').fill(TITLE);
  await page.locator('textarea[name="body"]').fill(BODY);
  await page.getByTestId('save-template').click();

  // The placeholders survive the round trip — the screen is not the place
  // they get filled, the composer is.
  await expect(row(page, TITLE)).toContainText('{ism}');
  await expect(row(page, TITLE)).toContainText('{kod}');
});

test('publishing to the company is offered to whoever may', async ({ page }) => {
  await login(page);
  await page.goto('/suhbatlar/shablonlar');
  await page.getByTestId('add-template').click();
  // The owner holds admin.settings.manage, so the box is there — and it is
  // UNTICKED, so a hurried save keeps the template to himself.
  await expect(page.getByTestId('template-shared')).toBeVisible();
  await expect(page.getByTestId('template-shared')).not.toBeChecked();
});

test('an edit reaches the stored text', async ({ page }) => {
  await login(page);
  await page.goto('/suhbatlar/shablonlar');
  await row(page, TITLE).getByTestId('edit-template').click();
  await row(page, TITLE).locator('textarea[name="body"]').fill('Yukingiz keldi, {kod}.');
  await row(page, TITLE).getByTestId('save-template').click();
  await expect(row(page, TITLE)).toContainText('Yukingiz keldi, {kod}.');
});

test('the template is taken back off', async ({ page }) => {
  await login(page);
  await page.goto('/suhbatlar/shablonlar');
  page.on('dialog', (dialog) => void dialog.accept());
  await row(page, TITLE).getByTestId('delete-template').click();
  await expect(row(page, TITLE)).toHaveCount(0);
});
