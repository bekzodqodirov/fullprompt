import { readFileSync } from 'node:fs';
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
 *  2b. «📝 Tuzatish» (0148, spec SPEC-P1-v2 §3): the owner — a super_admin, not the draft's holder — opens the
 *     box on the colleague's card, a price is refused in words with his text kept, a rule is saved (it teaches and
 *     rewrites nothing: the draft is not his to decide), and «Saboqlar» lists it «promptda», takes an edit,
 *     switches it off and deletes it; a lesson is in EVERY chat's prompt, so the cleanup deletes this run's;
 *  3. the account holder (the demo seller, configured as the agent's owner —
 *     a door that is a fact in agent_config, not a role) is offered the tab,
 *     sees the ✅, is told in words that the agent is off, opens ✏️ (it asks
 *     the server first — fix pass B, C1 — and this card never counted down,
 *     so the box opens as always) and ❌ retires the draft; on the settings
 *     tab «🤖 O‘zi yuborish» (0145) offers HIM the four kinds and says, BEFORE
 *     any press, why it cannot be switched on — the agent off, the number not
 *     «Ish raqami» — with the switch not offered (fix pass B, C9): nothing
 *     written, so nothing to put back; a wrong number in the daily-count box
 *     and in the account limits is refused in a sentence that names its own
 *     bounds (0148 fix) — refused, so nothing written either; the owner (not
 *     the holder) is shown the same panel with neither;
 *  4. stage 1a (STAGE-0-1A.md §7, the e2e row): the owner is offered the
 *     three price kinds and no ordinary one, the two holds by their names
 *     (J34: «Oddiy javob kutishi (soniya)» in Uzbek — the bundle — drawn here
 *     in Russian, the locale the demo owner reads), the night's three choices;
 *     «Kim javob beradi» takes a person for one topic through its own save
 *     (put back by the final test), «Kunlik tekshiruv» is drawn; and the home's
 *     «AI sotuvchi javob bermayapti» row is drawn while the alarm stands AND
 *     the agent runs, and not otherwise — the row is put in and taken out by
 *     this spec (the server's sweep never touches it: AGENT_LIVENESS is off);
 *     every page measured at 360 px in Russian;
 *  5. cleanup, a FINAL TEST (#183): agent_config is a singleton
 *     CONFIGURATION row every later spec and the app's sweep read — it is put
 *     back exactly, the topic's people are taken off again through the page
 *     and compared with what stood before, and the fixture rows are deleted.
 *     The same restore runs in afterAll as a net, because a serial run skips
 *     the final test once an earlier one fails.
 */

const OWNER = '+998900000001';
const SELLER = '+998900000009';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);
const body = `Sinov javobi ${runId}: yukingiz Toshkentga yetib keldi.`;
const factAnswer = `Sinov bilimi ${runId}: ofis dushanbadan shanbagacha ishlaydi.`;
// A rule with no name, code, phone or price in it — a lesson is refused each of those.
// The lesson's run tag is spelled in LETTERS: a bare figure that counts nothing is a price to the lesson rule
// (fix pass 7, check7#11) — the run id typed as digits made this ordinary lesson a refused one.
const lessonTag = runId.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!);
const lessonText = `Salomga avval salom bilan javob ber, keyin bitta savol ber (sinov ${lessonTag}).`;

// The words come from the bundles, so a missing or renamed key (which renders the key itself) cannot pass (#163).
interface Bundle {
  agentAi: {
    autoCategoriesTitle: string;
    autoTalkHoldLabel: string;
    autoPriceHoldLabel: string;
    autoNightLabel: string;
    autoNight: Record<'none' | 'table' | 'all', string>;
    section: Record<'kimga' | 'tekshiruv', string>;
    topic: Record<'supervisor' | 'big_cargo', string>;
    kimgaHint: string;
    sampleHint: string;
    livenessStanding: string;
  };
  kuzatuv: { homeAiLiveness: string };
}
const readBundle = (locale: 'ru' | 'uz') => JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Bundle;
// Russian is what the demo owner reads (his stored locale; ru is also the default).
const ru = readBundle('ru');
const uz = readBundle('uz');

// Stage 1a: the three kinds he still ticks, and the four ordinary ones that are boxes no more — literals, never the
// code's own constants (auto-categories `TICKED_CATEGORIES`), so the spec says what the page must draw.
const PRICE_KINDS = ['price', 'calc', 'calc_price'] as const;
const ORDINARY_KINDS = ['greeting', 'qualification', 'faq', 'status'] as const;

// «Kim javob beradi»: the topic this spec saves a person for — the big-cargo signal (the supervisor pair is the
// alarms' audience, a wider thing to touch) — and who, the first of these not already standing there.
const TOPIC = 'big_cargo';
const DESIGNEE_PHONES = ['+998900000002', '+998900000003'];
// The liveness alarm's state row (liveness.ts `LIVENESS_SIGNAL_KEY`).
const LIVENESS_KEY = 'agent:liveness';

/** A bundle sentence as a whole-text pattern: its own characters literal, each named value given as a pattern. */
function sentence(template: string, values: Record<string, string>, prefix = ''): RegExp {
  let source = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [name, pattern] of Object.entries(values)) source = source.split(`\\{${name}\\}`).join(pattern);
  return new RegExp(`^${prefix}${source}$`, 'u');
}

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
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

type ConfigRow = Record<string, unknown>;
let snapshot: ConfigRow | null = null;
let draftId = '';
let sellerId = '';

/** The topic's people as they stood before this spec (0151) — put back exactly. */
interface DesignationRow {
  topic: string;
  user_id: string;
  rank: number;
  created_by: string | null;
  created_at: Date;
}
let designationsBefore: DesignationRow[] | null = null;
let designee: { id: string; name: string } | null = null;

/** The liveness alarm's row as it stood before (on a database the suite owns: none) — put back exactly. */
interface SignalRow {
  key: string;
  since: Date;
  level: number;
  detail: string | null;
  updated_at: Date;
}
let livenessBefore: SignalRow | null | undefined;

test.beforeAll(async () => {
  const sql = database();
  try {
    const [config] = await sql<ConfigRow[]>`SELECT * FROM agent_config WHERE id = 1`;
    if (!config) throw new Error('agent_config is missing — is 0138 applied?');
    snapshot = config;
    designationsBefore = await sql<DesignationRow[]>`
      SELECT topic, user_id, rank, created_by, created_at FROM agent_designations WHERE topic = ${TOPIC} ORDER BY rank, user_id`;
    const [signal] = await sql<SignalRow[]>`
      SELECT key, since, level, detail, updated_at FROM system_signals WHERE key = ${LIVENESS_KEY}`;
    livenessBefore = signal ?? null;
    const people = await sql<{ id: string; name: string; phone: string }[]>`
      SELECT id, full_name AS name, phone FROM users WHERE phone IN ${sql(DESIGNEE_PHONES)}`;
    const standing = new Set(designationsBefore.map((r) => r.user_id));
    designee =
      DESIGNEE_PHONES.map((phone) => people.find((p) => p.phone === phone))
        .filter((p): p is { id: string; name: string; phone: string } => p !== undefined)
        .map(({ id, name }) => ({ id, name }))
        .find((p) => !standing.has(p.id)) ?? null;
    if (!designee) throw new Error(`no demo colleague is free to designate for ${TOPIC}`);
    const [seller] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${SELLER}`;
    sellerId = seller!.id;
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
  // «O‘zi yuborish» (0145): never armed by him on a colleague's account (no AI seat named here).
  // DELIBERATE EDIT (2026-11-15, his «Sahifada narxni belgilab bolmayabti»): the kinds, the daily count and the
  // confidence floor are a super_admin's too — the boxes are live for him; arming stays the holder's.
  const auto = page.getByTestId('agent-auto');
  await expect(auto).toBeVisible();
  await expect(auto.getByTestId('agent-auto-today')).toBeVisible();
  await expect(auto.getByTestId('agent-auto-holder-only')).toBeVisible();
  await expect(auto.getByTestId('agent-auto-arm')).toHaveCount(0);
  // DELIBERATE EDIT (stage 1a §4.2): the four ordinary kinds are boxes no more — ordinary talk goes unticked; the three
  // he ticks stay (a table price, a calculation, a VED price), live for him and saved by nothing until one moves.
  const kinds = auto.getByTestId('agent-auto-categories');
  await expect(kinds).toContainText(ru.agentAi.autoCategoriesTitle);
  for (const kind of ORDINARY_KINDS) await expect(auto.getByTestId(`agent-auto-category-${kind}`)).toHaveCount(0);
  for (const kind of PRICE_KINDS) await expect(auto.getByTestId(`agent-auto-category-${kind}`)).toBeEnabled();
  await expect(kinds.locator('input[type="checkbox"]')).toHaveCount(PRICE_KINDS.length);
  await expect(auto.getByTestId('agent-auto-categories-save')).toBeDisabled();
  // DELIBERATE EDIT (stage 1a kernel, J26): the confidence floor's box left the page — the gate stops reading it.
  await expect(auto.getByTestId('agent-auto-confidence')).toHaveCount(0);
  // Stage 1a (J34): his box for ordinary talk, by the name he was promised — «Oddiy javob kutishi (soniya)» is the
  // UZBEK bundle's word (pinned here, so a renamed box is red), and the page draws the bundle of the locale this
  // owner reads, Russian; 0 by default (talk goes at once), 0-600, his to change.
  expect(uz.agentAi.autoTalkHoldLabel).toBe('Oddiy javob kutishi (soniya)');
  const talkHold = auto.getByTestId('agent-auto-talk-hold');
  await expect(talkHold.locator('label')).toHaveText(ru.agentAi.autoTalkHoldLabel);
  await expect(talkHold.getByTestId('agent-auto-talk-hold-input')).toHaveValue('0');
  await expect(talkHold.getByTestId('agent-auto-talk-hold-input')).toBeEnabled();
  await expect(talkHold.getByTestId('agent-auto-talk-hold-save')).toBeDisabled();
  // …and the price hold — the layer's own two minutes a table or VED price waits with ⏸.
  const priceHold = auto.getByTestId('agent-auto-price-hold');
  await expect(priceHold.locator('label')).toHaveText(ru.agentAi.autoPriceHoldLabel);
  await expect(priceHold.getByTestId('agent-auto-price-hold-input')).toHaveValue('120');
  await expect(priceHold.getByTestId('agent-auto-price-hold-input')).toBeEnabled();
  // Which prices the night lets go (his 4 a): one choice of three in his words, the table price by default.
  const night = auto.getByTestId('agent-auto-night');
  await expect(night.locator('label')).toHaveText(ru.agentAi.autoNightLabel);
  await expect(night.getByTestId('agent-auto-night-select')).toHaveValue('table');
  await expect(night.locator('option')).toHaveText([ru.agentAi.autoNight.none, ru.agentAi.autoNight.table, ru.agentAi.autoNight.all]);
  await expect(night.getByTestId('agent-auto-night-save')).toBeDisabled();
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

test('«📝 Tuzatish»: the owner teaches on a colleague’s card — a price refused in words, a rule saved; «Saboqlar» lists, edits, switches off and deletes it', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar/ai');
  const card = page.locator(`[data-testid="agent-draft"][data-draft-id="${draftId}"]`);
  await card.getByTestId('agent-lesson-open').click();
  await expect(card.getByTestId('agent-lesson-box')).toBeVisible();
  await fitsThePhone(page);
  // A price is no lesson: refused in words, and the refused box keeps what he typed.
  await card.getByTestId('agent-lesson-text').fill('Avia narxini 17 $ deb ayt');
  await card.getByTestId('agent-lesson-save').click();
  await expect(card.getByTestId('agent-error')).toBeVisible();
  await expect(card.getByTestId('agent-lesson-text')).toHaveValue('Avia narxini 17 $ deb ayt');
  await fitsThePhone(page);
  await card.getByTestId('agent-lesson-text').fill(lessonText);
  await card.getByTestId('agent-lesson-save').click();
  await expect(card.getByTestId('agent-lesson-box')).toHaveCount(0);
  // Saved — and said so; the colleague's draft is untouched (a draft is decided by its holder alone).
  await expect(card.getByTestId('agent-note')).toContainText('Saboq saqlandi');
  const sql = database();
  try {
    const [lesson] = await sql<{ confirmed: boolean; active: boolean; draft_id: string | null }[]>`
      SELECT confirmed_at IS NOT NULL AS confirmed, active, draft_id FROM agent_lessons WHERE text = ${lessonText}`;
    expect(lesson).toEqual({ confirmed: true, active: true, draft_id: draftId });
    const [draft] = await sql<{ status: string; marked: boolean }[]>`
      SELECT status, coalesce(policy, '{}'::jsonb) ? 'lessonRedraft' AS marked FROM agent_drafts WHERE id = ${draftId}`;
    expect(draft).toEqual({ status: 'pending', marked: false });
  } finally {
    await sql.end();
  }

  await page.getByTestId('agent-tab-saboqlar').click();
  await expect(page).toHaveURL('/suhbatlar/ai?bolim=saboqlar');
  await expect(page.getByTestId('agent-lessons-cap')).toBeVisible();
  const row = page.getByTestId('agent-lesson').filter({ hasText: lessonText });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('agent-lesson-state')).toHaveAttribute('data-state', 'in');
  await fitsThePhone(page);

  // His words corrected: the same refusals as a new one, the refused box keeping what he typed.
  await row.getByTestId('agent-lesson-edit').click();
  await row.getByTestId('agent-lesson-edit-text').fill('Narxni 20 dollar deb ayt');
  await row.getByTestId('agent-lesson-edit-save').click();
  await expect(row.getByTestId('agent-error')).toBeVisible();
  await expect(row.getByTestId('agent-lesson-edit-text')).toHaveValue('Narxni 20 dollar deb ayt');
  await row.getByTestId('agent-lesson-edit-text').fill(`${lessonText} Qisqa yoz.`);
  await row.getByTestId('agent-lesson-edit-save').click();
  const edited = page.getByTestId('agent-lesson').filter({ hasText: `${lessonText} Qisqa yoz.` });
  await expect(edited).toHaveCount(1);
  await expect(edited.getByTestId('agent-lesson-edit-box')).toHaveCount(0);
  await fitsThePhone(page);

  // Switched off it stays on the page and leaves the prompt; then it is deleted.
  await edited.getByTestId('agent-lesson-toggle').click();
  await expect(edited.getByTestId('agent-lesson-state')).toHaveAttribute('data-state', 'off');
  page.once('dialog', (dialog) => void dialog.accept());
  await edited.getByTestId('agent-lesson-delete').click();
  await expect(page.getByTestId('agent-lesson').filter({ hasText: lessonText })).toHaveCount(0);
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

  // ✏️ asks the server before its box opens (fix pass B, C1): this card never counted down, so it opens as always,
  // and a second press closes it.
  await card.getByTestId('agent-edit').click();
  await expect(card.getByTestId('agent-edit-box')).toBeVisible();
  await expect(card.getByTestId('agent-own-text')).toHaveValue(body);
  await fitsThePhone(page);
  await card.getByTestId('agent-edit').click();
  await expect(card.getByTestId('agent-edit-box')).toHaveCount(0);

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

test('the holder is offered «O‘zi yuborish», and is told BEFORE any press why it cannot be switched on — nothing written', async ({ page }) => {
  await login(page, SELLER);
  await page.goto('/suhbatlar/ai?bolim=sozlamalar');
  const auto = page.getByTestId('agent-auto');
  await expect(auto).toBeVisible();
  // DELIBERATE EDIT (fix pass B, C9): the agent is off and the seller's number is no «Ish raqami» — both said
  // above the switch, which is not offered (no confirm about a switch that cannot move).
  await expect(auto.getByTestId('agent-auto-needs-running')).toBeVisible();
  await expect(auto.getByTestId('agent-auto-needs-work')).toBeVisible();
  await expect(auto.getByTestId('agent-auto-arm')).toBeDisabled();
  // DELIBERATE EDIT (stage 1a §4.2): the kinds he ticks are the three — the ordinary four are stored, never boxes.
  await expect(auto.getByTestId('agent-auto-category-price')).toBeEnabled();
  await fitsThePhone(page);
  // A wrong NUMBER is said as a number (review of 0148 as built): the daily count and the account limits each
  // name their own bounds — the kinds form's «…отметьте хотя бы один вид» told a person who had typed a number
  // to tick a box. Refused before anything is written, and the refused box keeps what he typed.
  const perDay = auto.getByTestId('agent-auto-per-day');
  await perDay.getByTestId('agent-auto-per-day-input').fill('0');
  await perDay.getByTestId('agent-auto-per-day-save').click();
  await expect(perDay.getByTestId('agent-error')).toContainText('1000');
  await expect(perDay.getByTestId('agent-auto-per-day-input')).toHaveValue('0');
  // DELIBERATE EDIT (stage 1a kernel, J26): the confidence floor's box (2026-11-15) left the page — nothing to type.
  const caps = page.getByTestId('agent-caps-form');
  await caps.getByTestId('agent-caps-dayCap').fill('500');
  await caps.getByTestId('agent-caps-save').click();
  await expect(caps.getByTestId('agent-error')).toContainText('200');
  await expect(caps.getByTestId('agent-error')).toContainText('100');
  await fitsThePhone(page);
  const sql = database();
  try {
    const [row] = await sql<{ armed_at: Date | null; per_day: number | null }[]>`SELECT armed_at, per_day FROM agent_auto_config WHERE id = 1`;
    expect(row!.armed_at).toBeNull();
    expect(row!.per_day).toBeNull();
    const [stored] = await sql<{ day_cap: number | null; hour_cap: number | null }[]>`SELECT day_cap, hour_cap FROM agent_send_caps WHERE id = 1`;
    expect(stored?.day_cap ?? null).toBeNull();
    expect(stored?.hour_cap ?? null).toBeNull();
  } finally {
    await sql.end();
  }
});

test('«Kim javob beradi»: the owner saves a colleague for one topic through its own save — the page and the table say so', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar/ai');
  const tab = page.getByTestId('agent-tab-kimga');
  await expect(tab).toContainText(ru.agentAi.section.kimga);
  await tab.click();
  await expect(page).toHaveURL('/suhbatlar/ai?bolim=kimga');
  await expect(page.getByTestId('agent-kimga')).toContainText(ru.agentAi.kimgaHint);
  await expect(page.getByTestId('agent-kimga-not-ready')).toHaveCount(0);
  // Both of stage 1a's topics, each in his words; nobody is named in code — the page is where he chooses.
  await expect(page.getByTestId('agent-kimga-supervisor')).toContainText(ru.agentAi.topic.supervisor);
  const block = page.getByTestId(`agent-kimga-${TOPIC}`);
  await expect(block).toContainText(ru.agentAi.topic.big_cargo);
  await fitsThePhone(page);

  // «Saqlash» is offered only once the list differs from what is stored.
  const editor = block.getByTestId(`agent-kimga-editor-${TOPIC}`);
  await expect(editor.getByTestId(`agent-kimga-save-${TOPIC}`)).toHaveCount(0);
  await editor.getByTestId(`agent-kimga-pick-${TOPIC}`).selectOption({ label: designee!.name });
  await editor.getByTestId(`agent-kimga-add-${TOPIC}`).click();
  await expect(editor.getByTestId('agent-kimga-draft-row').last()).toContainText(designee!.name);
  await editor.getByTestId(`agent-kimga-save-${TOPIC}`).click();
  // Saved: the page draws the stored list with her last (the next rank), the save leaves, nothing was refused.
  await expect(block.getByTestId('agent-kimga-stored').getByTestId('agent-kimga-person').last()).toContainText(designee!.name);
  await expect(editor.getByTestId(`agent-kimga-save-${TOPIC}`)).toHaveCount(0);
  await expect(editor.getByTestId('agent-error')).toHaveCount(0);
  await expect(block.getByTestId('agent-kimga-unset')).toHaveCount(0);
  await fitsThePhone(page);

  const sql = database();
  try {
    const rows = await sql<{ user_id: string; rank: number }[]>`
      SELECT user_id, rank FROM agent_designations WHERE topic = ${TOPIC} ORDER BY rank`;
    expect(rows.map((r) => r.user_id)).toEqual([...designationsBefore!.map((r) => r.user_id), designee!.id]);
    expect(rows.at(-1)!.rank).toBe(rows.length);
  } finally {
    await sql.end();
  }
});

test('«Kunlik tekshiruv» is drawn for the owner, inside the phone', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar/ai');
  const tab = page.getByTestId('agent-tab-tekshiruv');
  await expect(tab).toContainText(ru.agentAi.section.tekshiruv);
  await tab.click();
  await expect(page).toHaveURL('/suhbatlar/ai?bolim=tekshiruv');
  const sample = page.getByTestId('agent-sample');
  await expect(sample).toContainText(ru.agentAi.sampleHint);
  // Never the «not ready» sentence of a server one migration behind 0151; the day's rows, or the sentence that there
  // are none — which of the two depends on what the machine sent today, never on this spec.
  await expect(page.getByTestId('agent-sample-not-ready')).toHaveCount(0);
  await expect(sample.getByTestId('agent-sample-row').or(sample.getByTestId('agent-sample-empty')).first()).toBeVisible();
  await fitsThePhone(page);
});

test('the home draws «AI sotuvchi javob bermayapti» while the alarm stands and the agent runs — and not otherwise', async ({ page }) => {
  // The agent «runs»: the seller holds it (beforeAll) and his session is confirmed. Nothing is drafted by it on this
  // server — no model key, so the sweep's drafting half never starts — and the alarm's row is ours to put in and take
  // out: the server's own sweep never touches it (AGENT_LIVENESS=off, playwright.config).
  const sql = database();
  try {
    await sql`UPDATE agent_config SET mode = 'shadow', session_exclusive_at = now(), session_exclusive_by = ${sellerId} WHERE id = 1`;
    await sql`DELETE FROM system_signals WHERE key = ${LIVENESS_KEY}`;
  } finally {
    await sql.end();
  }
  await login(page, OWNER);
  const signals = page.getByTestId('adm-signal');
  await expect(signals).toBeVisible();
  // Running, and no alarm standing: no row.
  await expect(signals.getByTestId('ai-liveness')).toHaveCount(0);

  // Two customers have waited 25 minutes: the alarm stands.
  const put = database();
  try {
    const detail = JSON.stringify({ n: 2, oldest: new Date(Date.now() - 25 * 60_000).toISOString() });
    await put`INSERT INTO system_signals (key, detail) VALUES (${LIVENESS_KEY}, ${detail})`;
  } finally {
    await put.end();
  }
  await page.goto('/');
  const row = signals.getByTestId('ai-liveness');
  await expect(row).toBeVisible();
  await expect(row).toHaveText(sentence(ru.kuzatuv.homeAiLiveness, { n: '2', minutes: '(\\d+)' }, '🔴 '));
  const minutes = Number(/(\d+)\D*$/u.exec(await row.innerText())![1]);
  expect(minutes).toBeGreaterThanOrEqual(25);
  await expect(row).toHaveAttribute('href', '/suhbatlar/ai');
  await fitsThePhone(page);
  // The row is a door to the page, which says the same above its tabs.
  await row.click();
  await expect(page).toHaveURL('/suhbatlar/ai');
  await expect(page.getByTestId('agent-liveness-banner')).toHaveText(
    sentence(ru.agentAi.livenessStanding, { n: '2', minutes: '\\d+' }),
  );
  await fitsThePhone(page);

  // The agent switched off, the row standing: nothing on the home — the alarm is said only while the AI runs.
  const off = database();
  try {
    await off`
      UPDATE agent_config SET mode = 'off',
        session_exclusive_at = ${(snapshot!.session_exclusive_at as Date | null) ?? null},
        session_exclusive_by = ${(snapshot!.session_exclusive_by as string | null) ?? null}
      WHERE id = 1`;
  } finally {
    await off.end();
  }
  await page.goto('/');
  await expect(signals).toBeVisible();
  await expect(signals.getByTestId('ai-liveness')).toHaveCount(0);

  // …and the row comes out again (the final test checks it is as it was before this spec).
  const out = database();
  try {
    await out`DELETE FROM system_signals WHERE key = ${LIVENESS_KEY}`;
  } finally {
    await out.end();
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
    // A lesson is in every chat's prompt — the loudest configuration this spec can leave behind (#183).
    await sql`DELETE FROM agent_lessons WHERE text LIKE ${`%${runId}%`} OR text LIKE ${`%${lessonTag}%`}`;
    // The topic's people exactly as they stood (who a big cargo is told to — configuration, #183). The final test
    // first takes this spec's colleague off through the page's own save; this makes the rows the snapshot's to the
    // byte (ranks, authors, dates), and is the whole of it when an earlier failure skipped that test.
    const before = designationsBefore;
    if (before) {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM agent_designations WHERE topic = ${TOPIC}`;
        for (const r of before) {
          await tx`
            INSERT INTO agent_designations (topic, user_id, rank, created_by, created_at)
            VALUES (${r.topic}, ${r.user_id}, ${r.rank}, ${r.created_by}, ${r.created_at})`;
        }
      });
    }
    // The liveness alarm's row: absent before, absent after — standing, it is a red row on the home of every later
    // spec that opens it while an agent runs.
    if (livenessBefore === null) {
      await sql`DELETE FROM system_signals WHERE key = ${LIVENESS_KEY}`;
    } else if (livenessBefore) {
      const r = livenessBefore;
      await sql`
        INSERT INTO system_signals (key, since, level, detail, updated_at)
        VALUES (${r.key}, ${r.since}, ${r.level}, ${r.detail}, ${r.updated_at})
        ON CONFLICT (key) DO UPDATE SET since = EXCLUDED.since, level = EXCLUDED.level, detail = EXCLUDED.detail,
                                        updated_at = EXCLUDED.updated_at`;
    }
    restored = true;
  } finally {
    await sql.end();
  }
}

test.afterAll(async () => {
  await restore();
});

test('cleanup: «Kim javob beradi» is put back through its own save, agent_config is back as it was, and the fixture rows are gone', async ({ page }) => {
  expect(snapshot).not.toBeNull();
  // The colleague this spec added comes off the topic the way he would take her off: ✕, then «Saqlash».
  await login(page, OWNER);
  await page.goto('/suhbatlar/ai?bolim=kimga');
  const block = page.getByTestId(`agent-kimga-${TOPIC}`);
  const editor = block.getByTestId(`agent-kimga-editor-${TOPIC}`);
  await editor
    .getByTestId('agent-kimga-draft-row')
    .filter({ hasText: designee!.name })
    .getByTestId('agent-kimga-remove')
    .click();
  await editor.getByTestId(`agent-kimga-save-${TOPIC}`).click();
  await expect(editor.getByTestId(`agent-kimga-save-${TOPIC}`)).toHaveCount(0);
  await expect(editor.getByTestId('agent-error')).toHaveCount(0);
  await expect(block.getByTestId('agent-kimga-person').filter({ hasText: designee!.name })).toHaveCount(0);
  // An emptied topic is said to fall back to somebody, never to nobody (designations.ts `designated`).
  if (designationsBefore!.length === 0) await expect(block.getByTestId('agent-kimga-unset')).toBeVisible();
  await fitsThePhone(page);

  await restore();
  const sql = database();
  try {
    const s = snapshot!;
    const rows = await sql<{ user_id: string; rank: number }[]>`
      SELECT user_id, rank FROM agent_designations WHERE topic = ${TOPIC} ORDER BY rank, user_id`;
    expect(rows.map((r) => [r.user_id, r.rank])).toEqual(designationsBefore!.map((r) => [r.user_id, r.rank]));
    const signal = await sql<{ detail: string | null }[]>`SELECT detail FROM system_signals WHERE key = ${LIVENESS_KEY}`;
    expect(signal.map((r) => r.detail)).toEqual(livenessBefore ? [livenessBefore.detail] : []);
    const [config] = await sql<ConfigRow[]>`SELECT * FROM agent_config WHERE id = 1`;
    for (const key of ['mode', 'owner_user_id', 'session_exclusive_at', 'style_guide', 'daily_draft_cap']) {
      expect(String(config![key]), key).toBe(String(s[key]));
    }
    const [left] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM agent_drafts WHERE id = ${draftId || '00000000-0000-0000-0000-000000000000'})::int
           + (SELECT count(*) FROM kb_facts WHERE answer LIKE ${`%${runId}%`})::int
           + (SELECT count(*) FROM agent_lessons WHERE text LIKE ${`%${runId}%`} OR text LIKE ${`%${lessonTag}%`})::int AS n`;
    expect(left!.n).toBe(0);
  } finally {
    await sql.end();
  }
});
