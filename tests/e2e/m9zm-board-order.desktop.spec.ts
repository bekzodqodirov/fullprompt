import { expect, test } from '@playwright/test';

/**
 * Round 96, the gesture itself: a mouse drags a card to a PLACE in a column,
 * not just to a column.
 *
 * Only a browser can prove this half. `dropUnder` reads the slot off the DOM
 * with `elementFromPoint` and the card's own midpoint, `slotBetween` guesses
 * the number so the card does not snap back for the third of a second
 * Uzbekistan takes to answer (round 45), and the service writes it. Three
 * pieces, one gesture, and a unit test of any of them would prove none of it.
 *
 * The reload is the assertion that matters: the owner's complaint was about
 * what he saw when he came back to the board.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const RUN = `R96D-${String(Date.now()).slice(-6)}`;
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

const cards = (page: import('@playwright/test').Page) =>
  page.getByTestId('funnel-desktop').getByTestId('lead-card');

async function order(page: import('@playwright/test').Page) {
  return cards(page).evaluateAll((list) =>
    list.map((card) => (card.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 22)),
  );
}

test('a card dragged past two others lands between them and stays', async ({ page }) => {
  for (const name of NAMES) {
    await page.goto('/crm/leads/new');
    await page.getByTestId('lead-name').fill(name);
    await page.getByTestId('save-lead').click();
    await expect(page.getByText(/✅/).first()).toBeVisible({ timeout: 15_000 });
  }

  await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
  await expect(cards(page)).toHaveCount(3);
  const before = await order(page);
  expect(before[0]).toContain('uch');

  // Pick the top card up and drop it on the LOWER half of the last one, which
  // is «behind this card» — the rule every reorderable list has used since
  // before there were browsers.
  const from = (await cards(page).nth(0).boundingBox())!;
  const to = (await cards(page).nth(2).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Past MOVE_THRESHOLD first, then to the target: a drag that jumps straight
  // there never crosses the eight pixels that arm it.
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 6, { steps: 8 });
  // The line that says where it will land — drawn from the same slot the
  // server is about to be told about.
  await expect(page.getByTestId('drop-marker')).toHaveCount(1);
  await page.mouse.up();

  await expect(async () => {
    await page.reload();
    const after = await order(page);
    expect(after[2]).toContain('uch');
    expect(after[0]).toContain('ikki');
  }).toPass({ timeout: 20_000 });
});

test('the column scrolls without showing a bar, and the board fits the window', async ({ page }) => {
  await page.goto('/crm?scope=all');
  await expect(page.getByTestId('funnel-desktop').getByTestId('lead-card').first()).toBeVisible();
  const geometry = await page.evaluate(() => {
    const desktop = document.querySelector('[data-testid="funnel-desktop"]')!;
    const board = desktop.querySelector('.overflow-x-auto')!;
    const scroller = desktop.querySelector('[data-stage-id] .overflow-y-auto')!;
    return {
      // The owner: «scroll chiqib qolyabti yonidan shu korinishi kerak emas».
      bar: getComputedStyle(scroller).scrollbarWidth,
      bottom: Math.round(board.getBoundingClientRect().bottom),
      view: window.innerHeight,
      // …and the page must still not grow one of its own under a board built
      // not to have one (#354).
      doc: document.documentElement.scrollHeight,
    };
  });
  expect(geometry.bar).toBe('none');
  // «etaplarning boyi balandroq bolsin pcda»: the board reaches within a
  // couple of rem of the bottom instead of stopping 67 px short of it.
  expect(geometry.view - geometry.bottom).toBeLessThan(40);
  expect(geometry.doc).toBeLessThanOrEqual(geometry.view + 2);
});
