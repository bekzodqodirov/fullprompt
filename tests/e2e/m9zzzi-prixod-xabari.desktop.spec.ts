import 'dotenv/config';
import { expect, test } from '@playwright/test';
import { cleanupAll, database, mint, newRun } from './prixod-xabari-fixture';
import { hydrated, landsOnBlock, login } from './prixod-xabari-landing';

/**
 * «🔗 Bitim biriktirish» opened on a DESKTOP: the landing is not taken back.
 *
 * Somebody at a desk opens the button's address from Telegram Desktop. The
 * browser lands on `#bitim` — and, until this spec, the workspace tab strip
 * then called `scrollIntoView` on its lit tab: that scrolls every scrollable
 * ancestor, the window included, so one frame after hydration the page was
 * pulled back up to the strip. Measured at 1280×900 on the merged card:
 * scrollY 322 at the browser's landing, 63 fifty milliseconds later. It did
 * the same to every anchored address there is (`#lot-…`, `#ichki`) for
 * everybody whose strip lights a tab on that page, and no spec could see it:
 * a phone draws no strip on a card, a seller's strip lights nothing on a
 * prixod (so the first draft of this spec, signed in as the seller, was
 * green on the defect — its own premise is asserted now), and a verdict read
 * straight after `goto` is the browser's scroll, not the hydrated page's.
 *
 * Signed in as the OWNER: an admin gets «Prixod keldi» too (a client with no
 * reachable seller), and their strip lights «Prixodlar» here.
 *
 * A short window (1280×420) on purpose: there must be more page below the
 * fold than the pull-back leaves scrolled, or «the page is at its end» would
 * hold with the defect in place.
 *
 * Sorts after m9zzzi-prixod-karta.desktop. Its own client and prixod
 * (prixod-xabari-fixture.ts), deleted by a cleanup TEST (#523).
 */

test.describe.configure({ mode: 'serial' });

const OWNER = '+998900000001';

const run = newRun();
let receiptId = '';

test('mint the client and its prixod', async () => {
  const sql = database();
  try {
    await cleanupAll(sql);
    ({ receiptId } = await mint(sql, run));
  } finally {
    await sql.end();
  }
  expect(receiptId).not.toBe('');
});

test('the button’s address on a desktop: the page stays at the deal block once it has hydrated', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await login(page, OWNER);
  await page.goto(`/receipts/${receiptId}#bitim`);
  await hydrated(page);
  // The strip is on this page — or the spec would be proving nothing about it.
  await expect(page.getByTestId('ws-tabs').locator('[aria-current]').first()).toBeVisible();
  await landsOnBlock(page);
  // …and it is still there a moment later: nothing scrolls it away after the verdict.
  await page.waitForTimeout(300);
  await landsOnBlock(page);
});

test('cleanup — nothing of this spec is left for the next one', async () => {
  const sql = database();
  try {
    expect(await cleanupAll(sql)).toEqual({ clients: 0, receipts: 0, deals: 0 });
  } finally {
    await sql.end();
  }
});
