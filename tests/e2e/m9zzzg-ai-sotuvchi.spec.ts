import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Suhbatlar → AI sotuvchi» (docs/AI-SOTUVCHI.md §17.12, review build-13) —
 * what only a browser can show:
 *
 *  1. the owner (the super_admin ROLE) is offered the tab, opens the page,
 *     reads a pending draft's card — and is given NO ✅, because the draft is
 *     on a colleague's account (leak-5): the page says whose decision it is;
 *     the settings and the knowledge fit a 360 px phone;
 *  2. the knowledge: a price is refused in words, a clean fact is added and
 *     retired through the page's own buttons;
 *  3. the account holder (the demo seller, configured as the agent's owner —
 *     a door that is a fact in agent_config, not a role) is offered the tab,
 *     sees the ✅, is told in words that the agent is off, and ❌ retires
 *     the draft;
 *  4. cleanup, a FINAL TEST (#183): agent_config is a singleton
 *     CONFIGURATION row every later spec and the app's sweep read — it is put
 *     back exactly, and the fixture rows are deleted. The same restore runs
 *     in afterAll as a net, because a serial run skips the final test once an
 *     earlier one fails.
 */

const OWNER = '+998900000001';
const SELLER = '+998900000009';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);
const body = `Sinov javobi ${runId}: yukingiz Toshkentga yetib keldi.`;
const factAnswer = `Sinov bilimi ${runId}: ofis dushanbadan shanbagacha ishlaydi.`;

test.describe.configure({ mode: 'serial' });

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for this spec’s fixture and cleanup');
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function fitsThePhone(page: Page) {
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

type ConfigRow = Record<string, unknown>;
let snapshot: ConfigRow | null = null;
let draftId = '';

test.beforeAll(async () => {
  const sql = database();
  try {
    const [config] = await sql<ConfigRow[]>`SELECT * FROM agent_config WHERE id = 1`;
    if (!config) throw new Error('agent_config is missing — is 0138 applied?');
    snapshot = config;
    const [seller] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${SELLER}`;
    const [client] = await sql<{ id: string }[]>`SELECT id FROM clients WHERE client_code = 'GS777'`;
    // The seller's account is the agent's: mode stays 'off', so no CHECK asks
    // for a session confirmation and nothing can ever be sent.
    await sql`UPDATE agent_config SET owner_user_id = ${seller!.id}, mode = 'off' WHERE id = 1`;
    const policy = {
      blocks: [],
      warnings: [],
      ledger: [],
      notes: [],
      card: { customerLabel: 'GS777 · Sinov', lastOut: null, customerLines: ['10:00 Yukim qayerda?'] },
    };
    const [draft] = await sql<{ id: string }[]>`
      INSERT INTO agent_drafts (manager_user_id, peer_id, client_id, anchor_tg_message_id, kind,
                                proposed_body, language, category, policy, status)
      VALUES (${seller!.id}, ${`77${runId}`}::bigint, ${client!.id}, ${`9${runId}`}::bigint, 'reply',
              ${body}, 'uz', 'status', ${sql.json(policy)}, 'pending')
      RETURNING id`;
    draftId = draft!.id;
  } finally {
    await sql.end();
  }
});

test('the owner is offered the page, reads the card and is given no ✅ on a colleague’s draft', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar');
  const tab = page.locator('[data-testid="ws-tab"][href="/suhbatlar/ai"]');
  await expect(tab).toHaveCount(1);
  await tab.click();
  await expect(page).toHaveURL('/suhbatlar/ai');

  const card = page.locator(`[data-testid="agent-draft"][data-draft-id="${draftId}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('agent-card-text')).toContainText(body);
  await expect(card.getByTestId('agent-card-text')).toContainText('GS777 · Sinov');
  // A message leaves a personal account only by its holder.
  await expect(card.getByTestId('agent-send')).toHaveCount(0);
  await expect(card.getByTestId('agent-reject')).toHaveCount(0);
  await expect(card.getByTestId('agent-not-holder')).toContainText('Dilnoza');
  await fitsThePhone(page);

  await page.getByTestId('agent-tab-sozlamalar').click();
  await expect(page).toHaveURL('/suhbatlar/ai?bolim=sozlamalar');
  await expect(page.getByTestId('agent-state')).toContainText('Dilnoza');
  await expect(page.getByTestId('agent-owner-picker')).toBeVisible();
  await expect(page.getByTestId('agent-session')).toBeVisible();
  await expect(page.getByTestId('agent-numbers')).toBeVisible();
  await expect(page.getByTestId('agent-stats-rate')).toBeVisible();
  await expect(page.getByTestId('agent-open-calcs')).toContainText('/ 20');
  // Not his account: he may switch it off, never on.
  await expect(page.getByTestId('agent-on-holder-only')).toBeVisible();
  await expect(page.getByTestId('agent-mode-on')).toHaveCount(0);
  await fitsThePhone(page);
});

test('the knowledge: a price is refused in words, a clean fact is added and retired', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar/ai?bolim=bilimlar');
  const form = page.getByTestId('agent-fact-form');
  await form.getByTestId('agent-fact-answer').fill('Yo‘lkira 1 kub 110 $');
  await form.getByTestId('agent-fact-save').click();
  await expect(form.getByTestId('agent-error')).toBeVisible();
  // A refused form keeps what was typed.
  await expect(form.getByTestId('agent-fact-answer')).toHaveValue('Yo‘lkira 1 kub 110 $');

  await form.getByTestId('agent-fact-answer').fill(factAnswer);
  await form.getByTestId('agent-fact-save').click();
  const fact = page.getByTestId('agent-fact').filter({ hasText: factAnswer });
  await expect(fact).toHaveCount(1);
  await expect(form.getByTestId('agent-fact-answer')).toHaveValue('');
  await fitsThePhone(page);

  page.once('dialog', (dialog) => void dialog.accept());
  await fact.getByTestId('agent-fact-retire').click();
  await expect(page.getByTestId('agent-fact').filter({ hasText: factAnswer })).toHaveCount(0);
});

test('the account holder is offered the page by its door, gets the ✅, and is told the agent is off', async ({ page }) => {
  await login(page, SELLER);
  await page.goto('/suhbatlar');
  await expect(page.locator('[data-testid="ws-tab"][href="/suhbatlar/ai"]')).toHaveCount(1);
  await page.goto('/suhbatlar/ai');
  const card = page.locator(`[data-testid="agent-draft"][data-draft-id="${draftId}"]`);
  await expect(card.getByTestId('agent-send')).toBeVisible();
  await card.getByTestId('agent-send').click();
  await expect(card.getByTestId('agent-error')).toBeVisible();
  await fitsThePhone(page);

  await card.getByTestId('agent-reject').click();
  await expect(page.locator(`[data-testid="agent-draft"][data-draft-id="${draftId}"]`)).toHaveCount(0);
  const sql = database();
  try {
    const [row] = await sql<{ status: string; decided_by: string | null }[]>`
      SELECT status, decided_by FROM agent_drafts WHERE id = ${draftId}`;
    expect(row!.status).toBe('rejected');
    expect(row!.decided_by).not.toBeNull();
  } finally {
    await sql.end();
  }
});

/**
 * Put agent_config back and delete the fixture — ONE function for the final
 * test and the afterAll net. The net is not optional here: a serial
 * describe SKIPS every later test once one fails, so a red run that relied on
 * the final test alone left the seller configured as the agent's owner — and
 * the next run's snapshot took that leftover for the original (found while
 * red-proving this spec). Idempotent; the final test is the one that asserts.
 */
let restored = false;
async function restore(): Promise<void> {
  if (restored || !snapshot) return;
  const sql = database();
  try {
    const s = snapshot;
    await sql`
      UPDATE agent_config SET
        mode = ${s.mode as string},
        owner_user_id = ${(s.owner_user_id as string | null) ?? null},
        session_exclusive_at = ${(s.session_exclusive_at as Date | null) ?? null},
        session_exclusive_by = ${(s.session_exclusive_by as string | null) ?? null},
        human_pause_min = ${s.human_pause_min as number},
        daily_draft_cap = ${s.daily_draft_cap as number},
        daily_token_cap = ${s.daily_token_cap as number},
        started_at = ${(s.started_at as Date | null) ?? null},
        style_guide = ${(s.style_guide as string | null) ?? null},
        style_guide_proposed = ${(s.style_guide_proposed as string | null) ?? null},
        style_approved_at = ${(s.style_approved_at as Date | null) ?? null},
        style_approved_by = ${(s.style_approved_by as string | null) ?? null},
        updated_by = ${(s.updated_by as string | null) ?? null}
      WHERE id = 1`;
    if (draftId) await sql`DELETE FROM agent_drafts WHERE id = ${draftId}`;
    await sql`DELETE FROM kb_facts WHERE answer LIKE ${`%${runId}%`}`;
    restored = true;
  } finally {
    await sql.end();
  }
}

test.afterAll(async () => {
  await restore();
});

test('cleanup: agent_config is back as it was, and the fixture rows are gone', async () => {
  expect(snapshot).not.toBeNull();
  await restore();
  const sql = database();
  try {
    const s = snapshot!;
    const [config] = await sql<ConfigRow[]>`SELECT * FROM agent_config WHERE id = 1`;
    for (const key of ['mode', 'owner_user_id', 'session_exclusive_at', 'style_guide', 'daily_draft_cap']) {
      expect(String(config![key]), key).toBe(String(s[key]));
    }
    const [left] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM agent_drafts WHERE id = ${draftId || '00000000-0000-0000-0000-000000000000'})::int
           + (SELECT count(*) FROM kb_facts WHERE answer LIKE ${`%${runId}%`})::int AS n`;
    expect(left!.n).toBe(0);
  } finally {
    await sql.end();
  }
});
