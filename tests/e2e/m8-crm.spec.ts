import { expect, test } from '@playwright/test';

/**
 * Phase 2.3 CRM end to end: the owner configures the funnel and adds a field
 * of his own, a lead walks the funnel, gets a call logged and becomes a real
 * client card — and a sales manager cannot reach the settings that reshape
 * the funnel for everyone.
 */

const OWNER = '+998900000001';
const SALES = '+998900000009';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a lead walks the funnel and becomes a client', async ({ page }) => {
  await login(page, OWNER);

  // The owner shapes the CRM first: a stage of his own and a custom field.
  // The add forms live in collapsed panels — the settings page is long and
  // most visits are to look, not to add.
  await page.goto('/crm/settings');
  const addStage = page.locator('details').filter({ has: page.getByTestId('save-stage') });
  await addStage.locator('summary').click();
  await addStage.locator('input[name="name"]').fill(`Sinov bosqichi ${runId}`);
  await page.getByTestId('save-stage').click();
  // Scoped to THIS panel: a ✅ left over from another form would let the test
  // race ahead while the save was still in flight.
  await expect(addStage.getByText('✅')).toBeVisible();

  // Fields are no longer a CRM setting — they are defined for every object at
  // /admin/fields (Phase 2).
  await page.goto('/admin/fields');
  await page.getByTestId('new-field-panel').click();
  const addField = page.getByTestId('field-new');
  await addField.getByTestId('field-label').fill(`Shahar ${runId}`);
  await addField.getByTestId('field-entity').selectOption('lead');
  await addField.getByTestId('field-type').selectOption('select');
  await addField.getByTestId('field-options').fill('Toshkent, Andijon');
  await addField.getByTestId('save-field').click();
  await expect(addField.getByText('✅')).toBeVisible();

  // A new lead, answering the field that did not exist a minute ago.
  await page.goto('/crm/leads/new');
  await page.getByTestId('lead-name').fill(`Sinov mijoz ${runId}`);
  await page.locator('input[name="phone"]').fill(`+99890${runId}`);
  // A value with NO BREAK OPPORTUNITY in it, on purpose. Measured, because
  // the first attempt at this fixture was wrong: a hyphenated e-mail wraps
  // by itself (360 px either way) and proved nothing. A token with no hyphen
  // and no space measures 462 without `[overflow-wrap:anywhere]` and 360 with
  // it — and when a row is wider than the screen, mobile Chrome zooms the
  // WHOLE page out and every tap target moves with it (#400).
  await page.locator('input[name="company"]')
    .fill(`osiyotekstilsavdoinvestkompaniyasitoshkentfiliali${runId}`);
  await page.getByLabel(`Shahar ${runId}`).selectOption('Andijon');
  await page.getByTestId('save-lead').click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);

  // Round 76 (owner: «varonka kartasini ichidagi etaplar colapse bolsin» +
  // «umumiy inoflari mobileda … ihcham»). The stage strip was one button per
  // stage — four rows and 170 px at eight stages — and the facts were nine
  // rows including five «—», so the lenta, which is what a card is opened
  // for, began at y=1131 on a screen whose tab bar starts at 741.
  //
  // Closed-on-load is asserted BEFORE anything opens it: that is the whole
  // difference between a fold and buttons that quietly stopped rendering.
  await expect(page.getByTestId('stage-won')).toBeHidden();
  await expect(page.getByTestId('stage-current')).toBeVisible();
  const geo = await page.evaluate(() => {
    const fold = document.querySelector('[data-testid="stage-fold"]')!.closest('details')!;
    return {
      width: document.documentElement.scrollWidth,
      fold: Math.round(fold.getBoundingClientRect().height),
      feed: Math.round(
        document.querySelector('[data-testid="lead-facts"]')!.getBoundingClientRect().top,
      ),
    };
  });
  // The literal 360, never window.innerWidth: when mobile Chrome rescales the
  // page BOTH numbers grow together and the assertion passes anyway (#400).
  expect(geo.width, 'the lead card grew sideways').toBeLessThanOrEqual(360);
  expect(geo.fold, 'the closed fold is one row and still a 44 px tap target')
    .toBeGreaterThanOrEqual(44);
  expect(geo.fold, 'the closed fold is one row').toBeLessThanOrEqual(80);
  expect(geo.feed, 'the facts start on the first screen').toBeLessThan(300);

  // What was said goes on the LENTA, and the next call is booked in the ✏️
  // form. The «Записать контакт» panel that used to do both is gone (owner,
  // 2026-08-08: «crm kartada shu zapis yozish kerak emas, lenta bor»), and
  // this is the claim that removal rests on — both halves still work, from
  // the two places that remain.
  await expect(page.getByTestId('activity-panel')).toHaveCount(0);
  await page.getByTestId('feed-note-body').fill('narx aytdim');
  await page.getByTestId('feed-note-save').click();
  await expect(page.getByText('narx aytdim')).toBeVisible();

  const today = new Date().toISOString().slice(0, 10);
  await page.getByTestId('lead-edit-panel').click();
  const edit = page.locator('form').filter({ has: page.getByTestId('save-lead') });
  await edit.locator('input[name="nextActionAt"]').fill(today);
  await page.getByTestId('save-lead').click();
  await expect(edit.getByText('✅')).toBeVisible();

  // Booked for today, so it is on the call list.
  await page.goto('/crm/today');
  await expect(page.getByText(`Sinov mijoz ${runId}`)).toBeVisible();

  // /crm IS the board now (owner: the CRM opens on the funnel, not a table).
  // On a phone that board is ONE stage at a time, and the funnel lives in the
  // strip of stage tabs across the top.
  await page.goto('/crm?scope=all');
  const board = page.getByTestId('funnel-mobile');
  await expect(board).toBeVisible();
  await expect(page.getByTestId('funnel-desktop')).toBeHidden();
  const card = board.getByTestId('lead-card').filter({ hasText: `Sinov mijoz ${runId}` });
  await expect(card).toBeVisible();

  // The board is a swipe carousel now: a programmatic scroll stands in for
  // the thumb (fresh load, so no chip-tap guard is in flight). The active
  // chip must follow the column under the viewport, both ways.
  const track = board.getByTestId('stage-track');
  await track.evaluate((el) => el.scrollTo({ left: el.scrollWidth - el.clientWidth }));
  await expect(page.getByTestId('stage-tab').last()).toHaveAttribute('data-active', 'true');
  await page.getByTestId('stage-tab').first().click();
  await expect(page.getByTestId('stage-tab').first()).toHaveAttribute('data-active', 'true');

  // One tap moves it a stage forward — the move that happens ten times a day
  // should not be a drag across columns that are off the screen. Since the
  // board became a swipe carousel every column is in the DOM, so "it moved"
  // is asked of the COLUMNS: gone from the first, present in the second.
  await card.getByTestId('move-next').click();
  const mobileColumns = board.locator('[data-stage-id]');
  await expect(
    mobileColumns.first().getByText(`Sinov mijoz ${runId}`),
  ).toHaveCount(0);
  await expect(
    mobileColumns.nth(1).getByText(`Sinov mijoz ${runId}`),
  ).toBeVisible();

  // It really is in the next stage, and it survives a reload.
  await page.getByTestId('stage-tab').nth(1).click();
  await expect(board.getByText(`Sinov mijoz ${runId}`)).toBeVisible();
  await page.reload();
  await page.getByTestId('stage-tab').nth(1).click();
  await expect(board.getByText(`Sinov mijoz ${runId}`)).toBeVisible();

  // Any other stage goes through the sheet: here, back to the start.
  await board
    .getByTestId('lead-card')
    .filter({ hasText: `Sinov mijoz ${runId}` })
    .getByTestId('move-other')
    .click();
  await page.getByTestId('move-to-open').first().click();
  await page.getByTestId('stage-tab').first().click();
  await expect(board.getByText(`Sinov mijoz ${runId}`)).toBeVisible();

  // ...and it really landed, not just on screen. The board moves a card the
  // moment it is tapped and reconciles afterwards, so the assertion above is
  // satisfied by optimistic placement alone — a reload is what asks the
  // SERVER. Skipping it let the next navigation race the write: green here,
  // red on a slower runner (#154 family, but timing rather than leftovers).
  await page.reload();
  await page.getByTestId('stage-tab').first().click();
  await expect(board.getByText(`Sinov mijoz ${runId}`)).toBeVisible();

  // Won → convert. The convert panel opens by itself on a won stage, so the
  // last step of a deal is never a tap away from being forgotten.
  // Both funnel shapes are in the DOM (CSS decides which one is on screen),
  // so a click has to say which one it means.
  await page.goto('/crm?scope=all');
  // Say which stage, rather than trusting the one the funnel opens on: that
  // default is "the first stage that has anything in it", which depends on
  // what every other lead in the database is doing — and under `scope=all`
  // that includes leads this test never created.
  await page.getByTestId('stage-tab').first().click();
  await page.getByTestId('funnel-mobile').getByText(`Sinov mijoz ${runId}`).click();
  await expect(page.getByLabel(`Shahar ${runId}`)).toHaveValue('Andijon');
  // «Sotuv» is not the next stage, so it lives behind the fold — open it the
  // way a finger would.
  await page.getByTestId('stage-fold').click();
  await page.getByTestId('stage-won').click();
  await expect(page.getByTestId('convert-lead')).toBeVisible();
  await page.getByTestId('convert-lead').click();
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]+$/);
  // The new client card carries the CRM half too.
  await expect(page.getByTestId('activity-note')).toBeVisible();
});

test('a sales manager works leads but cannot reshape the funnel', async ({ page }) => {
  await login(page, SALES);
  await page.goto('/crm');
  await expect(page).toHaveURL('/crm');

  await page.goto('/crm/settings');
  await expect(page).toHaveURL('/crm');
  await page.goto('/crm/people');
  await expect(page).toHaveURL('/crm');
});
