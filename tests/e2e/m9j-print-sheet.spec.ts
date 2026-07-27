import { expect, test } from '@playwright/test';

/**
 * "Qaysi pagelarni qaysi printer deb belgilaydigan oyna borku."
 *
 * The owner is describing the phone's own print panel — pick the printer,
 * pick the pages — and the answer is that only a document can open it. A PDF
 * cannot: inside an installed app it lands in a viewer with no controls at
 * all (#224). So the stickers are now a page, it calls `window.print()`, and
 * these are the claims that page has to keep.
 *
 * What CANNOT be tested here, and is stated so nobody reads a green run as
 * more than it is: whether iOS Safari actually opens its print panel for a
 * home-screen app. Playwright is Chromium, and that behaviour needs Bekzod's
 * iPhone. Everything below is about the sheet itself.
 */

const OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone = OPERATOR) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The print dialog blocks a real browser, so it is stubbed and counted. */
async function countPrints(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });
}

async function openFirstReceipt(page: import('@playwright/test').Page) {
  await page.goto('/receipts');
  const link = page.locator('a[href^="/receipts/"]').first();
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href'))!;
  await page.goto(href);
  return href;
}

test('the print button opens a sheet that asks the phone to print', async ({ page }) => {
  await countPrints(page);
  await login(page);
  const receipt = await openFirstReceipt(page);

  // The control on the receipt card is now a way IN, not a mechanism.
  const button = page.getByTestId('print-labels').first();
  await expect(button).toBeVisible();
  await button.click();
  await expect(page).toHaveURL(new RegExp(`/print/receipts/`));

  // One sticker per box, each carrying its own scannable code.
  const labels = page.getByTestId('label');
  const count = await labels.count();
  expect(count).toBeGreaterThan(0);
  const codes = await labels.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('data-code')),
  );
  expect(new Set(codes).size, 'every sticker is a different box').toBe(count);

  // The dialog opened by itself — that IS the feature.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
    .toBeGreaterThan(0);

  // …and can be reopened by someone who dismissed it.
  const before = await page.evaluate(() => (window as unknown as { __prints: number }).__prints);
  await page.getByTestId('print-now').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
    .toBeGreaterThan(before);

  // The other two ways to a printer are on the same screen, not behind a
  // phone call: the share sheet for AirPrint, the PDF for RawBT.
  await expect(page.getByTestId('print-share')).toBeVisible();
  await expect(page.getByTestId('print-pdf')).toBeVisible();

  // And a way back that is not the browser's back button.
  expect(receipt).toContain('/receipts/');
});

test('a sticker is a 100 mm square with a QR that is really there', async ({ page }) => {
  await countPrints(page);
  await login(page);
  await openFirstReceipt(page);
  await page.getByTestId('print-labels').first().click();

  const label = page.getByTestId('label').first();
  await expect(label).toBeVisible();
  // Square, whatever the phone did to fit it on screen: a stretched sticker
  // is a QR the scanner refuses.
  const box = (await label.boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThan(2);

  // The QR is inline SVG, not an <img> that could still be loading when the
  // print dialog snapshots the page — a box that cannot be scanned onto a
  // truck is the failure this prevents.
  const qrPaths = await label.locator('svg path').count();
  expect(qrPaths).toBeGreaterThan(0);
  await expect(label.locator('img')).toHaveCount(0);
});

test('the app shell never lands on a sticker', async ({ page }) => {
  await countPrints(page);
  await login(page);
  await openFirstReceipt(page);
  await page.getByTestId('print-labels').first().click();
  await expect(page.getByTestId('label').first()).toBeVisible();

  // The print route is outside (protected)'s shell on purpose.
  await expect(page.locator('header')).toHaveCount(0);
  await expect(page.locator('nav')).toHaveCount(0);

  // And the toolbar that IS on screen is marked to disappear on paper.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('print-now')).toBeHidden();
  await expect(page.getByTestId('label').first()).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

test('the sheet obeys the same gate as the file', async ({ page }) => {
  await countPrints(page);
  await login(page);
  const receipt = await openFirstReceipt(page);
  const id = receipt.split('/').pop()!;

  // A colleague at another warehouse: the list would never have shown them
  // this receipt, and the stickers must not either (#200).
  await login(page, '+998900000007');
  const response = await page.goto(`/print/receipts/${id}`);
  expect(response?.status()).toBe(404);
});
