import { expect, test, type Page } from '@playwright/test';
import { cleanup, database, mint, newRun, type Minted } from './yoldagi-yuk-fixture';

/**
 * «Yo'ldagi yuklar ham» (the owner, 2026-10-27: «horgos planda yoldagi
 * yuklarni ham qoshish degan check bolsin shuni bosganda yoldagi yuklar ham
 * tanlash imkoniyati bolsin»; docs/YOLDAGI-YUK.md):
 *
 *  1. with the box off, a lot still on the road is nowhere on Kashgar's list —
 *     exactly the editor as it was;
 *  2. ticked, the lot appears with the truck it is on, its 🚚 takes the road
 *     part, the Σ bar says how much of the plan is on the road, and the plan
 *     goes to the agent with its road part printed on the plan's page;
 *  3. the plan's ✏️ reopens with the box ticked and the road part picked (a
 *     sent-back plan never loses its road part silently, objection editor#0).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

test.describe.configure({ mode: 'serial' });

const run = newRun();
let minted: Minted;

async function login(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function openEditorAtKashgar(page: Page, query = '') {
  await page.goto(`/plans/new${query}`);
  const origin = page.getByTestId('plan-origin');
  const ka = await origin.locator('option', { hasText: /^KA$/ }).getAttribute('value');
  await origin.selectOption(ka!);
}

test.beforeAll(async () => {
  const sql = database();
  try {
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('the box off: cargo on the road is not on the list', async ({ page }) => {
  await login(page);
  await openEditorAtKashgar(page);
  await expect(page.getByTestId('plan-road')).toBeVisible();
  await expect(page.getByTestId('plan-road')).not.toBeChecked();
  await expect(page.locator('#plan-stock-table')).not.toContainText(run.lotName);
});

test('ticked: the road lot, its truck, its 🚚 — and the plan carries the road part', async ({ page }) => {
  await login(page);
  await openEditorAtKashgar(page);
  await page.getByTestId('plan-road').check();
  const row = page.locator('#plan-stock-table tr', { hasText: run.lotName });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('lot-road')).toContainText(minted.inboundCode);
  await expect(row.getByTestId('lot-road-free')).toContainText('+6');
  // ✓ is the shelf's, and this lot has none here: only the road button takes it.
  await expect(row.getByRole('button', { name: 'all-A' })).toHaveCount(0);
  await row.getByTestId('take-road-A').click();
  await expect(row.getByTestId('take-A')).toHaveValue('6');
  await expect(page.getByTestId('plan-total-road')).toContainText('6');

  // A destination other than the origin; the default is the first one.
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('plan-road-part')).toContainText('6');
});

test('the plan carries the road part and reserves nothing yet', async () => {
  const sql = database();
  try {
    const [plan] = await sql<{ id: string; status: string }[]>`
      SELECT p.id, p.status FROM load_plans p
        JOIN load_plan_versions pv ON pv.plan_id = p.id
        JOIN load_plan_lines pl ON pl.version_id = pv.id
       WHERE pl.lot_id = ${minted.lotId}`;
    expect(plan!.status).toBe('pending_agent');
    const [road] = await sql<{ part: number; owed: number }[]>`
      SELECT plr.road_box_count AS part, plr.road_owed AS owed FROM plan_line_road plr
        JOIN load_plan_lines pl ON pl.id = plr.line_id WHERE pl.lot_id = ${minted.lotId}`;
    expect(road).toEqual({ part: 6, owed: 0 });
    const [boxes] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM boxes WHERE lot_id = ${minted.lotId} AND status = 'in_transit'`;
    expect(boxes!.n).toBe(6);
  } finally {
    await sql.end();
  }
});

let planId = '';

test('sent back, the plan’s ✏️ reopens with the box ticked and the road part picked', async ({ page }) => {
  const sql = database();
  try {
    const [plan] = await sql<{ id: string }[]>`
      SELECT DISTINCT pv.plan_id AS id FROM load_plan_lines pl
        JOIN load_plan_versions pv ON pv.id = pl.version_id WHERE pl.lot_id = ${minted.lotId}`;
    planId = plan!.id;
    // The agent's «o'zgartiring», recorded as the verdict form records it.
    await sql`UPDATE load_plan_versions SET agent_verdict = 'changes_requested', verdict_recorded_at = now()
               WHERE plan_id = ${planId}`;
    await sql`UPDATE load_plans SET status = 'changes_requested' WHERE id = ${planId}`;
  } finally {
    await sql.end();
  }
  await login(page);
  await page.goto(`/plans/${planId}`);
  await page.getByRole('link', { name: /✏️/ }).click();
  await expect(page).toHaveURL(new RegExp(`/plans/new\\?planId=${planId}`));
  await expect(page.getByTestId('plan-road')).toBeChecked();
  const row = page.locator('#plan-stock-table tr', { hasText: run.lotName });
  await expect(row.getByTestId('take-A')).toHaveValue('6');
});

test('the road half failing on a re-read names the pick it can no longer show, and the submit waits (review editor#7)', async ({
  page,
}) => {
  await login(page);
  await page.goto(`/plans/new?planId=${planId}`);
  const row = page.locator('#plan-stock-table tr', { hasText: run.lotName });
  await expect(row.getByTestId('take-A')).toHaveValue('6');
  // From now on the road half fails: the shelf's answer, said as failed.
  await page.route(/\/api\/plans\/stock\?.*road=1/, async (route) => {
    const res = await route.fetch({ url: route.request().url().replace('&road=1', '') });
    await route.fulfill({ json: { ...(await res.json()), roadOn: true, roadFailed: true } });
  });
  // The tab comes back into view: the quiet re-read.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('plan-road-failed')).toBeVisible();
  // The six road cartons are in no row and no Σ — said, and not sent unseen.
  await expect(page.getByTestId('plan-unseen')).toBeVisible();
  await expect(page.getByTestId('submit-plan')).toBeDisabled();
  await page.getByTestId('plan-unseen-drop').click();
  await expect(page.getByTestId('plan-unseen')).toHaveCount(0);
});

test('unticked while the road list is still loading, a shelf pick stays (review editor#6)', async ({ page }) => {
  await login(page);
  await openEditorAtKashgar(page);
  const shelfRow = page.locator('#plan-stock-table tr', { hasText: run.shelfName });
  await shelfRow.getByTestId('take-B').fill('2');
  // Hold the road answer, so the untick lands while it is in flight.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/plans\/stock\?.*road=1/, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByTestId('plan-road').check();
  await page.getByTestId('plan-road').uncheck();
  release();
  await expect(shelfRow.getByTestId('take-B')).toHaveValue('2');
  await expect(page.getByTestId('plan-road-dropped')).toHaveCount(0);
});

test('cleanup leaves nothing that carries the run', async () => {
  const sql = database();
  try {
    expect(await cleanup(sql, run)).toBe(0);
  } finally {
    await sql.end();
  }
});
