import { expect, type Page } from '@playwright/test';

/**
 * What the two «m9zzzi-prixod-xabari» spec files (the phone's and the
 * desktop's) both do in a browser: sign in, and say whether the card opened
 * AT its deal block. One home, so the two files cannot disagree about what
 * «landed» means.
 */

const DEMO_PASSWORD = 'demo1234';

export async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/**
 * The page has hydrated far enough to be judged, and its scroll has settled.
 *
 * The browser lands on a fragment BEFORE the page hydrates, so a verdict read
 * straight after `goto` is the browser's own scroll and says nothing about
 * what an effect does to it a few frames later — which is exactly how the
 * tab strip's `scrollIntoView` pulled every anchored page back to the top on
 * a desktop and no spec saw it (measured at 1280: scrollY 322, then 63).
 *
 * What this waits for, said exactly (the merged card's review, T1 / XF-7):
 * the deal cell carrying React's fiber means the hydration RENDER reached it —
 * not that the commit, or the effects after it, have run (Next hydrates in a
 * transition: the render is sliced, the effects come after a paint). So it
 * then waits for the scroll to hold still for ten animation frames, which is
 * what a verdict is about. A spec that can wait for an effect ITSELF does so
 * as well: the desktop owner waits for the strip's own visit request, sent
 * from the effect that runs after the lit tab's in the same commit.
 */
export async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="receipt-deal-pick"]');
    return el !== null && Object.keys(el).some((key) => key.startsWith('__reactFiber$'));
  });
  const settled = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        let last = window.scrollY;
        let still = 0;
        let frames = 0;
        const tick = () => {
          frames += 1;
          if (window.scrollY === last) still += 1;
          else [last, still] = [window.scrollY, 0];
          if (still >= 10) resolve(true);
          else if (frames >= 600) resolve(false);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(settled, 'the page kept scrolling for ten seconds').toBe(true);
}

/**
 * The card opened AT the deal block: the page SCROLLED to it. Two honest
 * outcomes, and only these two:
 *
 *  - «under the bar» — the block's top sits just under the sticky bar
 *    (`scroll-mt-20` = 80 px): where the scroll margin puts it whenever a
 *    screen of card is left below the block;
 *  - «page end» — the document ended first: the page is scrolled as far as it
 *    goes and the block is WHOLE on the screen, between the app bar and the
 *    tab bar. Since the card's phone order (docs/PRIXOD-KARTA.md §7.1) the
 *    ties sit AFTER the cargo, so on a short prixod the block is low on the
 *    page: this fixture's card is 1,088 px with the block at 580, and an
 *    800 px screen can only bring it to 292. The first version of this
 *    helper demanded «under the bar» everywhere and went red on the merge
 *    for a landing that was right.
 *
 * Not «the block is somewhere on the screen»: `scrollY > 0` is what the
 * anchor and the scroll effect are FOR, and it is asserted first — a block
 * that happens to be in view on an unscrolled page held this helper green
 * with the anchor AND the effect deleted (the as-built review, CARD-2).
 */
export async function landsOnBlock(page: Page, where: 'either' | 'under the bar' | 'page end' = 'either') {
  const block = page.getByTestId('receipt-deal-block');
  await expect(block).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // ONE poll for the whole verdict: a position read between two scroll steps
  // (the route's own scroll, then the block's) must not decide it either way.
  await expect
    .poll(async () => {
      // ONE read for the block and the scroll (docs/PRIXOD-KARTA.md §8,
      // «positions read in ONE frame»): two round trips can straddle a scroll
      // step and compare a position with a page that has moved since.
      const at = await block.evaluate((el) => {
        const box = el.getBoundingClientRect();
        // The tab bar is in the DOM at every width and hidden by CSS from
        // `md`: a hidden bar has no box, and its «top» of 0 would make
        // «whole above the bar» false for every desktop landing.
        const bar = document.querySelector('[data-testid="tab-bar"]');
        return {
          top: box.top,
          bottom: box.bottom,
          y: window.scrollY,
          max: document.documentElement.scrollHeight - window.innerHeight,
          floor: bar && bar.getClientRects().length > 0 ? bar.getBoundingClientRect().top : window.innerHeight,
        };
      });
      if (at.top >= 56 && at.top <= 110) return 'under the bar';
      if (at.y >= at.max - 1 && at.top > 110 && at.bottom <= at.floor) return 'page end';
      return `block at ${Math.round(at.top)}, scrolled ${Math.round(at.y)} of ${Math.round(at.max)}`;
    })
    .toMatch(where === 'either' ? /^(under the bar|page end)$/ : new RegExp(`^${where}$`));
}
