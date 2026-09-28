import { expect, test, type Page } from '@playwright/test';

/**
 * The client card's «Yuklar» tab (docs/CARD-TABS.md), opened by the people
 * who use it, on demo GS777.
 *
 * The oracle is the SERVER: every client tab the strip draws for a person
 * answers that person 200, every truck and prixod link the tab draws answers
 * 200, and the people the card's door refuses — the accountant and the VED —
 * are refused the tab and are not shown it on the ledger they do open.
 *
 * It only READS: nothing is created, so nothing is left behind for the next
 * spec (#183). GS777's cargo is whatever earlier specs made of it, so the
 * assertions are the tab's own arithmetic — the Σ is the rows' sum, the
 * chips add up to the Σ — and never a literal count.
 */

const PASSWORD = 'demo1234';
const CARD_READERS = [
  { phone: '+998900000001', who: 'owner' },
  { phone: '+998900000003', who: 'logist' },
  // Dilnoza — GS777 is her own client in the demo seed.
  { phone: '+998900000009', who: 'seller' },
];
const REFUSED = [
  { phone: '+998900000010', who: 'accountant' },
  { phone: '+998900000004', who: 'VED' },
];
let clientId = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The status a GET of `path` answers this session, redirects NOT followed. */
async function statusOf(page: Page, path: string): Promise<number> {
  const res = await page.request.get(path, { maxRedirects: 0 });
  return res.status();
}

/** «1 234 📦 · …» → 1234 (thousands are grouped with a no-break space). */
function boxesIn(text: string): number {
  const match = text.replace(/[\s ]/g, '').match(/^(\d+)📦/);
  return match ? Number(match[1]) : NaN;
}

test('GS777 is found from the client book', async ({ page }) => {
  await login(page, CARD_READERS[0]!.phone);
  await page.goto('/admin/clients?q=GS777');
  const href = await page.locator('a[href^="/admin/clients/"]:not([href$="/new"])').first().getAttribute('href');
  clientId = href!.split('/')[3]!.split('?')[0]!;
  expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
});

for (const person of CARD_READERS) {
  test(`${person.who}: the tab opens, every tab and link it draws opens`, async ({ page }) => {
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
    await login(page, person.phone);
    const path = `/admin/clients/${clientId}/yuklar`;
    expect(await statusOf(page, path)).toBe(200);
    await page.goto(path);
    await expect(page.getByTestId('client-tab-yuklar')).toHaveAttribute('aria-current', 'page');

    // The strip: every drawn tab answers 200.
    const tabs = await page
      .getByTestId('client-tabs')
      .locator('a')
      .evaluateAll((nodes) => nodes.map((n) => (n.getAttribute('href') ?? '').split('#')[0]!));
    expect(tabs).toContain(path);
    for (const href of tabs) expect(await statusOf(page, href), `${person.who} ${href}`).toBe(200);

    // Every truck and prixod link the tab draws answers 200 (a link that
    // bounces is worse than no link).
    const links = await page
      .locator('[data-testid="yuklar-truck-link"], [data-testid="yuklar-receipt-link"]')
      .evaluateAll((nodes) => [...new Set(nodes.map((n) => n.getAttribute('href') ?? ''))]);
    for (const href of links) expect(await statusOf(page, href), `${person.who} ${href}`).toBe(200);

    // The Σ is the rows' sum, and the chips add up to it.
    const total = boxesIn((await page.getByTestId('yuklar-total').innerText()).trim());
    const more = await page.getByTestId('yuklar-show-all').count();
    if (more === 0) {
      const rows = await page
        .getByTestId('yuklar-row')
        .evaluateAll((nodes) => nodes.reduce((acc, n) => acc + Number(n.getAttribute('data-boxes') ?? 0), 0));
      expect(rows).toBe(total);
    }
    const chips = await page
      .locator('[data-testid^="yuklar-chip-"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => (n.textContent ?? '').split('·').pop()!.replace(/[\s ]/g, '')).map(Number),
      );
    expect(chips.reduce((a, b) => a + b, 0)).toBe(total);

    // No money on this tab — its body, not the shell's «Pul» badge.
    for (const id of ['yuklar-now', 'yuklar-history']) {
      expect(await page.getByTestId(id).innerText(), `${person.who} ${id}`).not.toContain('$');
    }
  });
}

for (const person of REFUSED) {
  test(`${person.who}: refused the tab, and not shown it on the ledger`, async ({ page }) => {
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
    await login(page, person.phone);
    expect(await statusOf(page, `/admin/clients/${clientId}/yuklar`)).not.toBe(200);
    await page.goto(`/finance/${clientId}`);
    await expect(page.locator('h1')).toContainText('GS777');
    await expect(page.getByTestId('client-tab-yuklar')).toHaveCount(0);
    // …nor linked to it from the ledger's cargo block.
    await expect(page.getByTestId('cargo-now-link')).toHaveCount(0);
  });
}

test('at 360 px the tab fits the phone and starts on the first screen', async ({ page }) => {
  expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
  for (const person of CARD_READERS) {
    await login(page, person.phone);
    await page.goto(`/admin/clients/${clientId}/yuklar`);
    await expect(page.getByTestId('yuklar-now')).toBeVisible();
    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docW, person.who).toBeLessThanOrEqual(360);
    const body = (await page.getByTestId('yuklar-now').boundingBox())!;
    expect(body.y, `${person.who}: the tab's own content, not only the header`).toBeLessThan(800);
  }
});
