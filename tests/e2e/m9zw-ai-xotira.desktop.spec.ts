import { expect, test } from '@playwright/test';

/**
 * The AI-VED's memory, in a browser (0096).
 *
 * The owner's own sentence: «shu muhrlangan datani AI xotirasiga qo'yish
 * kerak». This is the whole round's headline and the ONE thing no unit test
 * can show — that a price a person sealed on Monday fills the same product's
 * row by itself on Tuesday, wearing a chip that says where it came from.
 *
 * Two leads, its own product name, its own cleanup as a test (#183/#508).
 * Nothing in the dictionaries is touched: the FIRST job's baza is typed, and
 * the second job's is the memory's answer — so the number on the second
 * screen can only have come from the first seal.
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';
/**
 * A random token FIRST, and it is the fixture's whole safety.
 *
 * The memory matches on the product NAME, so a name that differs only in a
 * numeric tail is the SAME product as far as this feature is concerned —
 * MEASURED, «xotira sinov mahsuloti <ts>» against the previous run's scores
 * 0.838, well over the 0.6 threshold, and the second run inherits the first
 * run's price with the save button disabled on a value already there. That is
 * the feature working; the fixture is what has to be distinct.
 */
const stamp = Math.random().toString(36).slice(2, 8);
const PRODUCT = `${stamp} sinovmol`;

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** A lead carrying ONE rastamojka job about `PRODUCT`, at its workspace. */
async function openJob(page: import('@playwright/test').Page, label: string) {
  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  const name = `${label} ${stamp}`;
  await page.getByTestId('quick-name').fill(name);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  const href = await made.getByRole('link').first().getAttribute('href');
  await page.goto(href!);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill(`${PRODUCT}, 100`);
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  const url = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;
  await page.goto(url);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });
  return { name, url };
}

let firstLead = '';
let secondLead = '';

test.describe.configure({ mode: 'serial' });

test('a sealed price becomes the memory', async ({ page }) => {
  await login(page);
  const job = await openJob(page, 'AI xotira 1');
  firstLead = job.name;

  // 8528520000 — monitors, advalor 10 % / VAT 12 in the seeded book. The
  // baza is TYPED: $20 per dona, a number in no dictionary, so anything that
  // reproduces it later can only have read this seal.
  await page.locator('[data-cell="tnvedCode"][data-row="0"]').fill('8528520000');
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-row').first()).toContainText('8528520000', {
    timeout: 15_000,
  });
  await page.getByTestId('calc-baza').last().fill('20');
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-baza')).toContainText('20', { timeout: 15_000 });

  await page.getByTestId('calc-confirm-all').click();
  await expect(page.getByTestId('calc-group-ok')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('calc-do-seal').click();
  await expect(page.getByTestId('calc-sealed')).toBeVisible({ timeout: 15_000 });
});

test('the NEXT job about the same product fills itself, and says where from', async ({ page }) => {
  expect(firstLead).not.toBe('');
  await login(page);
  const job = await openJob(page, 'AI xotira 2');
  secondLead = job.name;

  // The code arrives from the exact-key book the seal just taught, so the
  // row is already coded — the SWEEP places it and the memory answers its
  // baza, both inside one ordinary save.
  await page.getByTestId('calc-save-table').click();
  // The save bar's announcement FIRST, because it is the one transient fact
  // here: `lastSave` is client state and a later revalidation remounts the
  // table and takes it with it. Asserted after the two waits below, this line
  // failed on a full run and passed alone — the fact was true and the test was
  // late (#166's shape: the assertion, not the code).
  await expect(page.getByTestId('calc-save-note')).toContainText('🧠', { timeout: 15_000 });
  await expect(page.getByTestId('calc-group-row').first()).toContainText('8528520000', {
    timeout: 15_000,
  });

  // $20 that nobody typed on this screen — and the chip that says so.
  await expect(page.getByTestId('calc-group-baza')).toContainText('20', { timeout: 15_000 });
  await expect(page.getByTestId('calc-baza-memory')).toBeVisible();
});

test('both leads are closed (cleanup as a test)', async ({ page }) => {
  await login(page);
  for (const name of [firstLead, secondLead].filter(Boolean)) {
    await page.goto('/crm?scope=all');
    const card = page
      .getByTestId('funnel-desktop')
      .getByTestId('lead-card')
      .filter({ hasText: name })
      .first();
    if ((await card.count()) === 0) continue;
    await card.getByTestId('card-select').click();
    const bar = page.getByTestId('bulk-bar');
    const lost = await bar
      .getByTestId('bulk-stage')
      .locator('option[data-kind="lost"]')
      .first()
      .getAttribute('value');
    await bar.getByTestId('bulk-stage').selectOption(lost!);
    await bar.getByTestId('bulk-reason').fill('e2e tozalash');
    await bar.getByTestId('bulk-move').click();
    await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
  }
});
