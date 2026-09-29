import { expect, test, type Page } from '@playwright/test';
import { database } from './chegara-fixture';
import { openFold } from './fold';

/**
 * A person who never signs in (0120, the owner's 2b: «Tizimga kirmaydigan
 * hodimlarga (masalan, Xitoydagilarga) ham oylik qatori kerakmi?» — «b»),
 * walked by the people it is for: the accountant mints one on /hodimlar,
 * lands on the card, sets the salary like anybody's and lets him go; the
 * owner sees the admin side and finds him in no colleague picker.
 *
 * ORDER, stated correctly (judge M7): this file sorts after `m9zzt-*` in the
 * MOBILE project, the desktop project runs after ALL mobile specs on the same
 * database, and CI retries once — so the cleanup never relies on being last:
 * the final test sweeps by the NAME PREFIX in a `finally`, which also takes a
 * failed or retried attempt's leftovers. In serial mode a failure in T1–T4
 * skips T5; in CI the retry's T5 sweeps both attempts, and locally the next
 * run's T5 does. The person rows stay (the audit log points at them), inactive,
 * owning no template, in no list.
 *
 * Never «Wang…»: m9g-access hunts that name in the task picker.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const ACCOUNTANT = '+998900000010';

const runId = String(Date.now()).slice(-8);
const PREFIX = 'Xitoy ishchi ';
// A name is up to 200 characters with no rule about spaces, so the name
// carries one long unbroken word: every `fitsViewport` below then measures
// the name cells too (a 200-«y» name from the integration suite took
// /admin/users to 2,056 px at 360 before they wrapped).
const NAME = PREFIX + runId + ' ' + 'Uzunismliishchi'.repeat(4);
const PHONE = '+86139' + runId;
// The demo people read Russian (the seed sets no locale).
const NO_LOGIN_WORDS = 'не входит в систему';
const INACTIVE_WORDS = 'неактивен';
const NOT_DUE_WORDS = 'в этом месяце ещё не к выплате';

let personId = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/**
 * The page must fit its viewport — a wider document makes a phone zoom the
 * whole page out (#400). Measured against the CONFIGURED width: under mobile
 * emulation `window.innerWidth` grows with that very zoom-out, so comparing
 * the document to it passed while a name was 1,600 px wide.
 */
async function fitsViewport(page: Page) {
  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(doc).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function openPanel(page: Page, testId: string) {
  const summary = page.getByTestId(testId);
  await expect(summary).toBeVisible();
  const open = await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement | null)?.open ?? false);
  if (!open) await summary.click();
}

const card = (page: Page) => page.getByTestId('staff-card').filter({ hasText: NAME });

test('T1 — the accountant mints him, lands on his card, and a same name NAMES who holds it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, ACCOUNTANT);
  await page.goto('/hodimlar');
  const fold = page.getByTestId('hodimlar-person-new');
  await expect(fold).toBeVisible();
  await openFold(fold);
  await page.getByTestId('hodimlar-person-name').fill(NAME);
  await page.getByTestId('hodimlar-person-phone').fill(PHONE);
  await page.getByTestId('hodimlar-person-save').click();

  // A FULL page load now (#1241: the soft navigation was dropped about half
  // the time on a warm server), and the card is a heavy page.
  await expect(page).toHaveURL(/\/hodimlar\?hodim=[0-9a-f-]{36}$/, { timeout: 20_000 });
  personId = new URL(page.url()).searchParams.get('hodim')!;
  expect(personId).toMatch(/^[0-9a-f-]{36}$/);

  await expect(page.getByTestId('staff-card')).toHaveCount(1);
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByTestId('staff-no-login')).toBeVisible();
  // Landed with «Oylik kiritish» open — adding him is the first half of paying him.
  await expect(card(page).getByTestId('staff-salary-new')).toHaveAttribute('open', '');
  await expect(card(page).getByTestId('staff-person-leave')).toBeVisible();
  // The accountant does not hold admin.users.manage: the way to a login is not hers.
  await expect(card(page).getByTestId('staff-enable-login')).toHaveCount(0);
  await fitsViewport(page);
  await openFold(card(page).getByTestId('staff-person-edit'));
  await expect(card(page).getByTestId('staff-person-name')).toHaveValue(NAME);
  await fitsViewport(page);

  // The same name again: the fold names who holds it and mints nothing yet.
  await page.goto('/hodimlar');
  await openFold(page.getByTestId('hodimlar-person-new'));
  await page.getByTestId('hodimlar-person-name').fill(NAME);
  await page.getByTestId('hodimlar-person-save').click();
  const same = page.getByTestId('hodimlar-person-same-name');
  await expect(same).toBeVisible();
  await expect(same.locator(`a[href="/hodimlar?hodim=${personId}"]`)).toBeVisible();
  await expect(same).toContainText(NO_LOGIN_WORDS);
  // Do NOT press again — a second press mints a second person.
});

test('T2 — the salary is saved like anybody’s', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, ACCOUNTANT);
  await page.goto(`/hodimlar?hodim=${personId}`);
  const fold = card(page).getByTestId('staff-salary-new');
  await expect(fold).toHaveAttribute('open', '');
  const form = fold.locator('form');
  // The category stays at its default (the salary setting, or the first
  // kind — both cash). The currency and a kassa of THAT currency are picked
  // explicitly: a cash kind with no kassa is refused
  // `account_or_payer_required`, one in another currency
  // `account_currency_mismatch`.
  await form.locator('select[name="currency"]').selectOption('USD');
  const usdTill = form.locator('select[name="accountId"] option').filter({ hasText: '(USD)' }).first();
  const tillValue = await usdTill.getAttribute('value');
  expect(tillValue).toBeTruthy();
  await form.locator('select[name="accountId"]').selectOption(tillValue!);
  // NEXT month, said explicitly: with «this month» the 1st of every Tashkent
  // month makes the occurrence due today, and T5's stop would then be refused
  // `recurring_has_arrears` — the #1063 clock trap.
  await form.getByTestId('recurring-first-month').selectOption('next');
  await form.getByTestId('recurring-amount').fill('100');
  await form.getByTestId('save-recurring').click();
  // The action revalidates /hodimlar, so the fold may be replaced by the
  // salary row before its ✅ is ever painted — either one is the save.
  await expect(form.getByText('✅').or(card(page).getByTestId('staff-salary-state')).first()).toBeVisible();

  await page.reload();
  const state = card(page).getByTestId('staff-salary-state');
  await expect(state).toBeVisible();
  await expect(state).toContainText(NOT_DUE_WORDS);
  await fitsViewport(page);
});

test('T3 — the owner sees the admin side: the one door to a login, never submitted', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, OWNER);
  await page.goto(`/hodimlar?hodim=${personId}`);
  const give = card(page).getByTestId('staff-enable-login');
  await expect(give).toBeVisible();
  await give.click();
  await expect(page).toHaveURL(`/admin/users/${personId}`);

  await expect(page.getByTestId('user-no-login')).toBeVisible();
  await expect(page.getByTestId('enable-login')).toBeVisible();
  await expect(page.getByTestId('enable-login-form')).toBeVisible();
  await expect(page.getByTestId('enable-login-payroll-phone')).toContainText(PHONE);
  // The phone is typed AFRESH — never the payroll one prefilled.
  await expect(page.getByTestId('enable-login-phone')).toHaveValue('');
  await expect(page.getByTestId('enable-login-phone')).toHaveAttribute('required', '');
  await expect(page.getByTestId('enable-login-password')).toHaveAttribute('required', '');
  // No submit: a login is configuration plus sessions (#183).
  await fitsViewport(page);

  await page.goto('/admin/users');
  const row = page.getByTestId('user-card').filter({ hasText: NAME });
  await expect(row.getByTestId('user-no-login')).toBeVisible();
  await expect(row).not.toContainText('—');
  await fitsViewport(page);

  await page.goto('/admin/users/new');
  await expect(page.getByTestId('users-new-hodimlar-line')).toBeVisible();
  const list = page.getByTestId('users-new-no-login');
  await openFold(list);
  await expect(list).toContainText(NAME);
  await fitsViewport(page);
});

test('T4 — he is nobody’s colleague: no task, no rule, no rota, no website', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/bugun');
  await openPanel(page, 'new-task-panel');
  const taskOptions = await page.getByTestId('task-assignee').locator('option').allTextContents();
  expect(taskOptions.some((text) => text.includes(NAME))).toBe(false);

  await page.goto('/admin/rules');
  await openPanel(page, 'new-rule-panel');
  await page.getByTestId('rule-action-type').first().selectOption('create_task');
  const ruleOptions = await page.getByTestId('rule-assignee').first().locator('option').allTextContents();
  expect(ruleOptions.some((text) => text.includes(NAME))).toBe(false);

  await page.goto('/admin/taqsimot');
  await expect(page.getByTestId('rota-form')).not.toContainText(NAME);
  await expect(page.getByTestId('site-panel')).not.toContainText(NAME);
});

test('T5 — he leaves: still listed while a template names him, gone once it stops (and the sweep)', async ({ page }) => {
  const sql = database();
  try {
    await login(page, ACCOUNTANT);
    await page.goto(`/hodimlar?hodim=${personId}`);
    page.once('dialog', (dialog) => void dialog.accept());
    await card(page).getByTestId('staff-person-leave').click();
    await expect(card(page).getByTestId('staff-person-return')).toBeVisible();

    // Still listed on the whole page: his template is active, so the due list
    // still names him — the visible fix, seen in a browser.
    await page.goto('/hodimlar');
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText(INACTIVE_WORDS);
    await expect(card(page).getByTestId('staff-no-login')).toBeVisible();

    const edit = card(page).getByTestId('recurring-edit');
    await openFold(edit);
    await edit.getByTestId('recurring-edit-active').uncheck();
    await edit.getByTestId('recurring-edit-save').click();
    // The stop revalidates /hodimlar and nothing owes him any more, so the
    // card leaves the page with its own ✅ — the leaving IS the answer.
    await expect(card(page)).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('hodimlar-list')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // …and is named in «Ketganlar» instead, the one door back to his card.
    const leavers = page.getByTestId('hodimlar-leavers');
    await openFold(leavers);
    await expect(leavers.getByTestId('hodimlar-leaver').filter({ hasText: NAME })).toHaveAttribute(
      'href',
      `/hodimlar?hodim=${personId}`,
    );
    await fitsViewport(page);

    // `?hodim=` always shows that one person — «Qayta faollashtirish» lives there.
    await page.goto(`/hodimlar?hodim=${personId}`);
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByTestId('staff-person-return')).toBeVisible();

    const [person] = await sql<{ active: boolean; login_enabled: boolean; password_hash: string | null }[]>`
      SELECT active, login_enabled, password_hash FROM users WHERE id = ${personId}`;
    expect(person).toMatchObject({ active: false, login_enabled: false, password_hash: null });
    const [held] = await sql<{ roles: number; whs: number }[]>`
      SELECT (SELECT count(*)::int FROM user_roles WHERE user_id = ${personId}) AS roles,
             (SELECT count(*)::int FROM user_warehouses WHERE user_id = ${personId}) AS whs`;
    expect(held).toEqual({ roles: 0, whs: 0 });
    const live = await sql`SELECT 1 FROM recurring_expenses WHERE employee_id = ${personId} AND active`;
    expect(live).toHaveLength(0);
    const paid = await sql`SELECT 1 FROM expenses WHERE employee_id = ${personId}`;
    expect(paid).toHaveLength(0);
  } finally {
    // By PREFIX, so a failed or retried attempt's leftovers go too. A template
    // with a posting is money history and stays; none of this file's has one.
    await sql`
      DELETE FROM recurring_expenses r
       WHERE r.employee_id IN (SELECT id FROM users WHERE full_name LIKE ${PREFIX + '%'} AND NOT login_enabled)
         AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.recurring_id = r.id)`;
    await sql`UPDATE users SET active = false WHERE full_name LIKE ${PREFIX + '%'} AND NOT login_enabled`;
    await sql.end();
  }
});
