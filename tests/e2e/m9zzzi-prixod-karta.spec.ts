import { expect, test, type Locator, type Page } from '@playwright/test';
import { KARTA_GOODS, KARTA_TOTAL, cleanKarta, kartaMarking, mintKarta, type KartaRun } from './prixod-karta-fixture';

/**
 * The prixod card on a PHONE (docs/PRIXOD-KARTA.md §7) — the parts only a
 * browser can show. The owner's sentence: «prixodning interfeysi … hamma
 * narsa har xil joyda bo'lib ketgan».
 *
 *  1. the card says how much it holds, and reads summary → cargo → ties →
 *     the rest (the ties above the cargo left a seller's first screen with
 *     no cargo on it);
 *  2. nothing in a lot's row of actions moves when one of them opens;
 *  3. «Boshqa amallar» is closed and names what is inside;
 *  4. an ownerless prixod leads with «whose is this», and a fifty-character
 *     marking with no space in it does not widen the page;
 *  5. cleanup, a final TEST.
 *
 * WIDTH is asked of `documentElement.clientWidth` against `scrollWidth`,
 * never of `innerWidth`: under mobile emulation that one GROWS with Chrome's
 * zoom-out and reads «fits» about a page that does not (#1241).
 */

const OWNER = '+998900000001';
const DEMO_PASSWORD = 'demo1234';
const RUN: KartaRun = { prefix: `PK${String(Date.now()).slice(-6)}` };
let ids: { claimedId: string; ownerlessId: string; lotAId: string } | null = null;

test.describe.configure({ mode: 'serial' });

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function box(target: Locator) {
  await expect(target).toBeVisible();
  const rect = await target.boundingBox();
  expect(rect, 'the element has a box').not.toBeNull();
  return rect!;
}

async function fitsTheScreen(page: Page) {
  const { client, scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(scroll, `document ${scroll}px in a ${client}px screen`).toBeLessThanOrEqual(client);
}

test('mint: a claimed prixod of two lots and an ownerless one with a fifty-character marking', async () => {
  ids = await mintKarta(RUN);
  expect(ids.claimedId).not.toBe('');
});

test('the card says how much it holds, and a phone reads summary → cargo → ties → the rest', async ({ page }) => {
  expect(ids).not.toBeNull();
  await login(page, OWNER);
  await page.goto(`/receipts/${ids!.claimedId}`);

  // «Jami»: the literals of the fixture — 3 + 2 cartons, 12.5 + 0.3 kg,
  // 0.75 + 0.0005 m³ — never the helper's own output.
  const total = page.getByTestId('receipt-total');
  await expect(total).toHaveAttribute('data-boxes', String(KARTA_TOTAL.boxes));
  await expect(total).toHaveAttribute('data-kg', KARTA_TOTAL.kg);
  await expect(total).toHaveAttribute('data-m3', KARTA_TOTAL.m3);
  await expect(total).toContainText(`${KARTA_TOTAL.boxes} 📦 · ${KARTA_TOTAL.kg} kg · ${KARTA_TOTAL.m3} m³`);

  // …and it agrees with the lots printed under it, counted a second way:
  // off the DOM of the lot cards.
  const figures = page.getByTestId('lot-figures');
  await expect(figures).toHaveCount(2);
  const counts = await figures.evaluateAll((nodes) => nodes.map((node) => Number.parseInt(node.textContent ?? '', 10)));
  expect(counts.reduce((sum, n) => sum + n, 0)).toBe(KARTA_TOTAL.boxes);
  // A measure is trimmed, never rounded: «12.5 kg», and no «12.500».
  await expect(figures.first()).toContainText('3 📦 · 12.5 kg · 0.75 m³');
  await expect(figures.first()).not.toContainText('12.500');
  await expect(figures.nth(1)).toContainText('2 📦 · 0.3 kg · 0.0005 m³');

  // The order a phone reads. The ties come BEFORE the lots in the DOM (the
  // desktop's order) and after them on the screen.
  const summary = await box(page.getByTestId('receipt-summary'));
  const lots = await box(page.getByTestId('receipt-lots'));
  const links = await box(page.getByTestId('receipt-links'));
  const files = await box(page.getByTestId('receipt-files'));
  const more = await box(page.getByTestId('receipt-more'));
  expect(summary.y + summary.height).toBeLessThanOrEqual(lots.y);
  expect(lots.y + lots.height).toBeLessThanOrEqual(links.y);
  expect(links.y + links.height).toBeLessThanOrEqual(files.y);
  expect(files.y).toBeLessThan(more.y);
  const history = await box(page.getByTestId('receipt-history'));
  expect(more.y + more.height).toBeLessThanOrEqual(history.y);

  // The first lot starts on the first screen, above the tab bar — the
  // reason for the order: with the owner's three ties above it (≈330 px) it
  // began below the fold.
  const viewport = page.viewportSize()!;
  const firstLot = await box(page.locator(`#lot-${ids!.lotAId}`));
  expect(firstLot.y).toBeLessThan(viewport.height - 60);
  expect(firstLot.y + links.height, 'the ties above the lots would push the first lot off the screen').toBeGreaterThan(
    viewport.height - 60,
  );

  // A sixty-character goods name wraps inside the card.
  await expect(page.getByTestId('lot-name').first()).toContainText(KARTA_GOODS);
  await fitsTheScreen(page);
});

/**
 * Where the row's members stand, relative to the ROW and read in ONE frame.
 * Two `boundingBox()` calls in a row are two frames, and the form scrolls
 * itself into view smoothly as it opens: read apart, the same two buttons
 * came back 52 px out of line with each other.
 */
function rowLayout(row: Locator) {
  return row.evaluate((node) => {
    const origin = node.getBoundingClientRect();
    const place = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - origin.left), y: Math.round(r.top - origin.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const buttons = [...node.querySelectorAll(':scope > button, :scope > a')].map((el) => place(el)!);
    return {
      width: Math.round(origin.width),
      buttons,
      form: place(node.querySelector(':scope > form')),
      panel: place(node.querySelector(':scope > [data-testid="mark-lost-panel"]')),
    };
  });
}

test('nothing in a lot’s row moves when ✏️ opens, and the form is on the screen', async ({ page }) => {
  expect(ids).not.toBeNull();
  await login(page, OWNER);
  await page.goto(`/receipts/${ids!.claimedId}`);
  const lot = page.locator(`#lot-${ids!.lotAId}`);
  const row = lot.getByTestId('lot-actions');
  const edit = row.getByRole('button', { name: /✏️/ });
  const writeOff = row.getByTestId('mark-lost-open');
  await expect(edit).toBeVisible();
  await expect(writeOff).toBeVisible();
  const before = await rowLayout(row);
  expect(before.buttons.length).toBeGreaterThanOrEqual(2);
  expect(before.form).toBeNull();

  // The receipt card hydrates late in a full run: press until the form opens.
  const form = row.locator('form');
  await expect(async () => {
    if (!(await form.isVisible())) await edit.click();
    await expect(form).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(edit).toHaveAttribute('aria-expanded', 'true');

  // EVERY button is where it was — the opener too. Before this round the ✏️
  // was replaced by its form, and whatever stood after it slid under the
  // thumb that had just pressed (on a phone: the link to the pallet builder).
  const opened = await rowLayout(row);
  expect(opened.buttons).toEqual(before.buttons);
  // The form took a line of its own, the row's whole width, under them all.
  expect(opened.form).not.toBeNull();
  const lowest = Math.max(...opened.buttons.map((b) => b.y + b.h));
  expect(opened.form!.y).toBeGreaterThanOrEqual(lowest);
  expect(opened.form!.w).toBe(opened.width);
  // …and it is ON the screen: a form that opens below the fold reads as
  // «pressed, nothing happened».
  const viewport = page.viewportSize()!;
  await expect(async () => {
    const seen = await form.boundingBox();
    expect(seen).not.toBeNull();
    expect(seen!.y).toBeLessThan(viewport.height - 60);
    expect(seen!.y + seen!.height).toBeGreaterThan(0);
  }).toPass({ timeout: 5_000 });

  // The same press closes it, and the row is as it began.
  await edit.click();
  await expect(form).toHaveCount(0);
  expect((await rowLayout(row)).buttons).toEqual(before.buttons);

  // The write-off opens the same way: a button of the row's one shape, and
  // a panel under the row with the select the manager needs.
  await writeOff.click();
  await expect(row.getByTestId('mark-lost-panel')).toBeVisible();
  await expect(row.getByTestId('mark-lost-box')).toBeVisible();
  await expect(writeOff).toHaveAttribute('aria-expanded', 'true');
  const lost = await rowLayout(row);
  expect(lost.buttons).toEqual(before.buttons);
  expect(lost.panel!.y).toBeGreaterThanOrEqual(lowest);
  await fitsTheScreen(page);
});

test('«Boshqa amallar» is closed, names what it holds, and opens on one press', async ({ page }) => {
  expect(ids).not.toBeNull();
  await login(page, OWNER);
  await page.goto(`/receipts/${ids!.claimedId}`);
  const more = page.getByTestId('receipt-more');
  // The owner's role voids through the cascade: its opener is inside, and
  // nothing of it is on the card until the fold is opened.
  await expect(page.getByTestId('annul-open')).toBeHidden();
  await expect(page.getByTestId('receipt-assign')).toBeHidden();
  // The closed line says what is in there — in whatever language the demo
  // owner reads, so it is asked of the fold's own contents.
  await more.click();
  const opener = page.getByTestId('annul-open');
  await expect(opener).toBeVisible();
  await expect(more).toContainText((await opener.textContent())!.trim());
  await expect(page.getByTestId('receipt-assign')).toBeVisible();
  await fitsTheScreen(page);
});

test('an ownerless prixod leads with «whose is this», and its marking does not widen the page', async ({ page }) => {
  expect(ids).not.toBeNull();
  await login(page, OWNER);
  await page.goto(`/receipts/${ids!.ownerlessId}`);
  const summary = page.getByTestId('receipt-summary');
  await expect(summary).toContainText(kartaMarking(RUN));
  const owner = await box(page.getByTestId('receipt-owner'));
  const lots = await box(page.getByTestId('receipt-lots'));
  expect(owner.y + owner.height).toBeLessThanOrEqual(lots.y);
  // The assign form is open at the top — on a claimed card it is in the fold.
  await expect(page.getByTestId('receipt-owner').getByTestId('receipt-assign')).toBeVisible();
  // Fifty characters with no space: 424 px at 360 before this round.
  await fitsTheScreen(page);
});

test('cleanup: the two prixods and their client are gone', async () => {
  expect(await cleanKarta(RUN)).toBe(0);
});
