import { expect, test } from '@playwright/test';

/**
 * The navigation indicator (round 45).
 *
 * What only a browser can say: that pressing a link puts something on the
 * screen BEFORE the new page arrives. The owner's complaint was never that a
 * page took 200 ms to render — it was that a tap produced nothing at all for
 * half a second, on a link between two countries.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

test('a slow tap shows a progress line, and it clears when the page lands', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // Hold the next document back so the wait is long enough to be worth
  // showing — which is the only case the bar is meant for. Locally every
  // navigation is instant, so without this the test would prove nothing.
  // Two things had to be arranged before this could be observed at all.
  // A REGEX, not a glob: App Router asks for the next screen as
  // `/bugun?_rsc=…`, and `**/bugun` matches no URL with a query string.
  // And the PREFETCH has to be refused: the tab-bar link sits in the viewport,
  // so Next fetches it before anybody presses it, the tap is then served from
  // memory, and an instant navigation is exactly the case that draws nothing.
  //
  // It used to press the header's SEARCH icon. Round 58 gave that icon a
  // command palette which opens over the page instead of navigating, so the
  // link it needs is now the tab bar's — the subject here was always the
  // progress bar, never which door it was measured through.
  await page.route(/\/bugun(\?|$)/, async (route) => {
    if (route.request().headers()['next-router-prefetch']) return route.abort();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  const bar = page.getByTestId('nav-progress');
  await expect(bar).toHaveCount(0);

  // `:visible` because the sidebar renders the same link and comes first in
  // the DOM — on a phone it is `hidden md:block`, so an unqualified `.first()`
  // waits sixty seconds for something that will never be clickable.
  await page.locator('a[href="/bugun"]:visible').first().click();
  // Visible while the server is still thinking — the whole point.
  await expect(bar).toBeVisible({ timeout: 3000 });

  await page.unroute(/\/bugun(\?|$)/);
  await expect(page).toHaveURL(/\/bugun/, { timeout: 15_000 });
  // And gone once the screen is there, or it becomes furniture nobody reads.
  await expect(bar).toHaveCount(0, { timeout: 5000 });
});

test('an instant navigation draws nothing at all', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // No route delay: locally this lands well inside the 140 ms grace, so a
  // bar here would be a flash on every single tap.
  // `:visible` because the sidebar renders the same link and comes first in
  // the DOM — on a phone it is `hidden md:block`, so an unqualified `.first()`
  // waits sixty seconds for something that will never be clickable.
  await page.locator('a[href="/bugun"]:visible').first().click();
  await expect(page).toHaveURL(/\/bugun/, { timeout: 15_000 });
  await expect(page.getByTestId('nav-progress')).toHaveCount(0);
});
