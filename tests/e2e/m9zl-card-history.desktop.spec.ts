import { expect, test } from '@playwright/test';

/**
 * The history a card keeps must never end up under the facts rail (owner:
 * «pcda o'ng taraf menu orqasiga o'tib qolyabti pastga tushgan sari»).
 *
 * Desktop project: there is one column on a phone and nothing to overlap.
 *
 * THE SPEC HAS TO SCROLL. A sticky item's overlap is a function of scroll
 * offset, and the broken layout measures ZERO overlap at rest — which is how
 * this was mis-diagnosed once already, from a measurement taken with the page
 * at the top. It also has to make the history TALL: the seeded card's history
 * is a few dozen pixels and can never rise high enough to reach a rail pinned
 * at the top of the viewport, so a spec that did not pad it would pass on the
 * defect for want of content rather than for want of a bug.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

test('the history is never under the sticky facts rail, at any scroll offset', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // Any client card: it carries a lenta, a facts rail and a history, and
  // needs no cleanup afterwards because it invents nothing.
  await page.goto('/admin/clients');
  await page.locator('table tbody tr a').first().click();
  await expect(page.locator('[data-cardcols="tail"]')).toBeVisible({ timeout: 10_000 });

  // Give the history the height a real one has, and only the height: nothing
  // about where the layout puts it is touched.
  await page.addStyleTag({ content: '[data-cardcols="tail"] { min-height: 1400px; }' });

  const measured = await page.evaluate(async () => {
    const rail = document.querySelector('[data-cardcols="rail"]')!;
    const tail = document.querySelector('[data-cardcols="tail"]')!;
    let overlapAt: number | null = null;
    let coveredAt: number | null = null;
    let sawTail = 0;
    const end = document.documentElement.scrollHeight;
    for (let y = 0; y <= end; y += 100) {
      window.scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(r));
      const a = rail.getBoundingClientRect();
      const b = tail.getBoundingClientRect();
      const h = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (h > 0 && v > 0 && overlapAt === null) overlapAt = y;
      // …and the top of the history must be the history, not something
      // painted over it: an element can be readable and unclickable.
      if (b.top > 64 && b.top < window.innerHeight - 20) {
        sawTail += 1;
        const hit = document.elementFromPoint(b.right - 20, b.top + 6);
        if (hit && rail.contains(hit) && coveredAt === null) coveredAt = y;
      }
    }
    window.scrollTo(0, 0);
    return { overlapAt, coveredAt, sawTail, end };
  });

  // The fixture has to actually reach the failing geometry, or the assertions
  // below prove nothing (round 92's lesson, twice over).
  expect(measured.end).toBeGreaterThan(1400);
  expect(measured.sawTail).toBeGreaterThan(0);

  expect(measured.overlapAt, 'rail and history share space at this scrollY').toBeNull();
  expect(measured.coveredAt, 'the rail is painted over the history at this scrollY').toBeNull();
});
