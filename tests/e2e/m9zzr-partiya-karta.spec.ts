import { expect, test, type Page } from '@playwright/test';

/**
 * The truck card's tabs, opened by the people who use them (docs/CARD-TABS.md).
 *
 * The oracle is the SERVER, never the strip's own list: every tab link the
 * card draws for a person must answer that person 200 — a tab that bounces is
 * worse than no tab (#1023) — and every tab it does not draw must refuse them
 * (a redirect, or the card's 404 for a truck that is not theirs). The unit
 * fence (tests/unit/truck-card.test.ts) proves the strip and the pages ask
 * the same predicates; this proves the pages really are those doors, as the
 * demo people, on a live truck.
 *
 * The truck is a quick one out of YW, so the YW people reach it and the GZ
 * operator is a stranger to it. It is cancelled in the last test — a forming
 * truck left behind is the next spec's input (#154).
 */

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const PEOPLE: { phone: string; who: string; tabs: string[] }[] = [
  { phone: OWNER, who: 'owner', tabs: ['tarkib', 'yuklash', 'xarajat', 'narx', 'bojxona', 'mashina'] },
  { phone: '+998900000003', who: 'logist', tabs: ['tarkib', 'yuklash', 'xarajat', 'bojxona', 'mashina'] },
  { phone: '+998900000004', who: 'VED', tabs: ['tarkib', 'yuklash', 'xarajat', 'narx', 'bojxona', 'mashina'] },
  { phone: '+998900000005', who: 'YW manager', tabs: ['tarkib', 'yuklash', 'mashina'] },
  { phone: '+998900000006', who: 'YW operator', tabs: ['tarkib', 'yuklash', 'mashina'] },
  { phone: '+998900000009', who: 'seller', tabs: ['tarkib', 'yuklash', 'mashina'] },
  { phone: '+998900000010', who: 'accountant', tabs: ['tarkib', 'yuklash', 'xarajat', 'narx', 'mashina'] },
  { phone: '+998900000011', who: 'viewer', tabs: ['tarkib', 'yuklash', 'xarajat', 'mashina'] },
];
const GZ_OPERATOR = '+998900000007';
const PATH: Record<string, string> = {
  tarkib: '',
  yuklash: '/yuklash',
  xarajat: '/xarajatlar',
  narx: '/pricing',
  bojxona: '/tnved',
  mashina: '/mashina',
};
const runId = Date.now().toString().slice(-6);
let batchPath = '';

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

test('a quick truck out of YW for the tabs to be opened on', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/batches');
  await page.selectOption('select[name="originId"]', { label: 'YW' });
  await page.selectOption('select[name="destId"]', { label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  batchPath = new URL(page.url()).pathname;
});

for (const person of PEOPLE) {
  test(`${person.who}: every drawn tab opens, every other one refuses`, async ({ page }) => {
    expect(batchPath).toMatch(/^\/batches\//);
    await login(page, person.phone);
    await page.goto(batchPath);
    // The strip's links — `batch-tab-body` shares the prefix.
    const links = page.getByTestId('batch-tabs').locator('a');
    await expect(links.first()).toBeVisible();
    const drawn = await links.evaluateAll((nodes) =>
      nodes.map((node) => ({
        tab: (node.getAttribute('data-testid') ?? '').replace('batch-tab-', ''),
        href: (node.getAttribute('href') ?? '').split('#')[0]!,
        current: node.getAttribute('aria-current'),
      })),
    );
    expect(drawn.map((d) => d.tab)).toEqual(person.tabs);
    // One tab lit, and it is the one this page is.
    expect(drawn.filter((d) => d.current === 'page').map((d) => d.tab)).toEqual(['tarkib']);

    for (const tab of Object.keys(PATH)) {
      const path = `${batchPath}${PATH[tab]}`;
      const status = await statusOf(page, path);
      if (person.tabs.includes(tab)) {
        expect(drawn.find((d) => d.tab === tab)!.href, `${person.who} ${tab} href`).toBe(path);
        expect(status, `${person.who} may open ${tab}`).toBe(200);
      } else {
        expect(status, `${person.who} is refused ${tab}`).not.toBe(200);
      }
    }
  });
}

test('an operator of a third warehouse is refused the whole card, tab by tab', async ({ page }) => {
  await login(page, GZ_OPERATOR);
  for (const tab of Object.keys(PATH)) {
    const status = await statusOf(page, `${batchPath}${PATH[tab]}`);
    // The card's door answers «no such truck» to a stranger; the money and
    // papers tabs refuse him earlier, by permission.
    expect([307, 404], `GZ operator ${tab}`).toContain(status);
  }
  expect(await statusOf(page, `${batchPath}/load`)).toBe(404);
});

test('at 360 px every tab fits the phone and the tab body starts on the first screen', async ({ page }) => {
  for (const phone of [OWNER, '+998900000006']) {
    await login(page, phone);
    const person = PEOPLE.find((p) => p.phone === phone)!;
    for (const tab of person.tabs) {
      await page.goto(`${batchPath}${PATH[tab]}`);
      await expect(page.getByTestId(`batch-tab-${tab}`)).toHaveAttribute('aria-current', 'page');
      const docW = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(docW, `${person.who} ${tab}`).toBeLessThanOrEqual(360);
      const body = (await page.getByTestId('batch-tab-body').boundingBox())!;
      expect(body.y, `${person.who} ${tab}: the tab's own content, not only the header`).toBeLessThan(800);
    }
  }
});

test('cleanup: the truck is cancelled', async ({ page }) => {
  await login(page, OWNER);
  await page.goto(batchPath);
  await page.getByTestId('cancel-batch').click();
  await page.locator('#cancel-reason').fill(`karta sinov ${runId}`);
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('cancel-batch-confirm').click();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });
});
