import { expect, test } from '@playwright/test';

/**
 * Round 96: the order the owner puts the cards in stays put.
 *
 * He: «cartni boshqa etapga otkazganda ularni tartibi ozgarib qolyabti qaysi
 * ketma ketlikda qoysa usha saqlanib qoladgan qilsa boladimi?»
 *
 * The service half is proven in `tests/integration/board-order.*` and the
 * arithmetic in the unit file. What only a browser can prove is the GESTURE:
 * a mouse drag that lands a card between two others (desktop), and the ↑ ↓ in
 * the ⋯ sheet that does the same thing on a phone, which is the only door
 * there — the touch drag was refused twice (#510) and stays refused.
 *
 * Everything is scoped by a run tag and read through the board's own search,
 * so the local database's hundreds of leftover leads (#573) cannot make the
 * assertions about position mean something else.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const RUN = `R96-${String(Date.now()).slice(-6)}`;
const NAMES = [`${RUN} bir`, `${RUN} ikki`, `${RUN} uch`];

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
});

/** The run's own cards, in the order the board draws them. */
async function order(page: import('@playwright/test').Page, shape: string) {
  return page
    .getByTestId(shape)
    .getByTestId('lead-card')
    .evaluateAll((cards) =>
      cards.map((card) => (card.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)),
    );
}

test('three leads are born newest-first, as they always have been', async ({ page }) => {
  for (const name of NAMES) {
    await page.goto('/crm/leads/new');
    await page.getByTestId('lead-name').fill(name);
    await page.getByTestId('save-lead').click();
    await expect(page.getByText(/✅/).first()).toBeVisible({ timeout: 15_000 });
  }
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
  const shown = await order(page, 'funnel-mobile');
  expect(shown).toHaveLength(3);
  // The board's oldest habit, deliberately kept: a new card arrives on top.
  expect(shown[0]).toContain('uch');
  expect(shown[2]).toContain('bir');
});

test('the phone sends a card DOWN from the ⋯ sheet, and it stays there', async ({ page }) => {
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
  const board = page.getByTestId('funnel-mobile');
  await board.getByTestId('lead-card').first().getByTestId('move-other').click();
  await page.getByTestId('card-down').click();

  // The board redraws optimistically and the server confirms behind it; a
  // RELOAD is the assertion that matters, because the owner's complaint was
  // about what he saw when he came back.
  await expect(async () => {
    await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
    const shown = await order(page, 'funnel-mobile');
    expect(shown[0]).toContain('ikki');
    expect(shown[1]).toContain('uch');
  }).toPass({ timeout: 15_000 });
});

test('↑ is disabled at the top, so the sheet cannot lie about what it does', async ({ page }) => {
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
  await page
    .getByTestId('funnel-mobile')
    .getByTestId('lead-card')
    .first()
    .getByTestId('move-other')
    .click();
  await expect(page.getByTestId('card-up')).toBeDisabled();
  await expect(page.getByTestId('card-down')).toBeEnabled();
});

test('moving to another stage still lands on TOP of it, as the button always did', async ({
  page,
}) => {
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
  const board = page.getByTestId('funnel-mobile');
  // The one-tap button says nothing about position. Sending the card at the
  // BOTTOM of the column onward must put it at the top of where it arrives —
  // the behaviour every board in this app has had, and the reason `place` is
  // the drag's alone.
  const last = board.getByTestId('lead-card').last();
  const name = ((await last.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
  await last.getByTestId('move-next').click();

  await expect(async () => {
    await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
    // The stage tabs carry a count each; the moved card is now first in the
    // second column, so it is the LAST of this run's cards in DOM order.
    const shown = await order(page, 'funnel-mobile');
    expect(shown.at(-1)).toContain(name.split(' ').at(-1)!);
  }).toPass({ timeout: 15_000 });
});
