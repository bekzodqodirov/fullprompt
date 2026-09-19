// Browser walk for «Mening kunim» (owner's item 4, one-off dev probe in the
// dev-walk-* family): stages the supervisor's own calls, two sellers' calls
// and one a month old on gsr_ci, opens /bugun and /crm/today as the admin,
// screenshots the default view, the «Hammasi» view and the opened backlog
// fold at 360×800, measures the document width, and removes its rows.
import { chromium } from '@playwright/test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_ci';
const APP = 'http://127.0.0.1:3000';
const OUT = process.env.OUT_DIR ?? '/tmp/walk-day';
const sql = postgres(DB, { max: 2 });
const stamp = String(Date.now()).slice(-6);
const made = [];

const dayShift = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function stage() {
  const [boss] = await sql`select id from users where phone = '+998900000002'`;
  const [seller] = await sql`select id, full_name from users where phone = '+998900000009'`;
  const [logist] = await sql`select id, full_name from users where phone = '+998900000003'`;
  const [stage1] = await sql`select id from lead_stages where kind = 'open' order by sort_order limit 1`;

  const lead = async (name, owner, due) => {
    const id = randomUUID();
    await sql`insert into leads (id, name, stage_id, owner_id, next_action_at, next_action_note, created_by)
      values (${id}, ${name}, ${stage1.id}, ${owner}, ${due}, ${'kelishuvni aniqlash'}, ${boss.id})`;
    made.push(id);
    return id;
  };
  await lead(`Mening mijozim ${stamp}`, boss.id, dayShift(0));
  await lead(`Egasiz so‘rov ${stamp}`, null, dayShift(0));
  await lead(`Eski qarz ${stamp}`, boss.id, dayShift(-30));
  await lead(`Eski qarz 2 ${stamp}`, boss.id, dayShift(-12));
  for (let i = 0; i < 4; i += 1) await lead(`Sotuvchi A${i} ${stamp}`, seller.id, dayShift(0));
  for (let i = 0; i < 5; i += 1) await lead(`Logist B${i} ${stamp}`, logist.id, dayShift(0));
  return { seller, logist };
}

async function login(page) {
  await page.goto(`${APP}/login`);
  await page.fill('input[name="identifier"]', '+998900000002');
  await page.fill('input[name="password"]', 'demo1234');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'));
}

const width = (page) => page.evaluate(() => document.documentElement.scrollWidth);

const s = await stage();
console.log('staged: seller', s.seller.full_name, '· logist', s.logist.full_name);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await ctx.newPage();
  await login(page);

  for (const path of ['/bugun', '/crm/today']) {
    await page.goto(`${APP}${path}`);
    await page.waitForSelector('[data-testid="day-followups"]');
    const name = path.replace(/\//g, '') || 'home';
    await page.screenshot({ path: `${OUT}/${name}-mine.png`, fullPage: true });
    // VISIBLE rows. A closed <details> keeps its children in the DOM, so a
    // plain count says «6 → 6» and proves nothing about the fold.
    const rows = await page.locator('[data-testid="follow-up-row"]:visible').count();
    const door = await page.getByTestId('day-all-toggle').innerText().catch(() => '—');
    const stale = await page.getByTestId('day-stale').count();
    console.log(`${path}: rows=${rows} door="${door}" staleFold=${stale} document=${await width(page)}`);

    // The backlog fold — one line until somebody opens it.
    if (stale) {
      const visible = () => page.locator('[data-testid="follow-up-row"]:visible').count();
      const before = await visible();
      console.log('  stale summary:', await page.locator('[data-testid="day-stale"] > summary').innerText());
      await page.locator('[data-testid="day-stale"] > summary').click();
      await page.waitForTimeout(200);
      console.log(`  stale fold: ${before} visible rows → ${await visible()}`);
    }

    // «Hammasi» → per-seller folds.
    await page.getByTestId('day-all-toggle').click();
    await page.waitForSelector('[data-testid="day-others"]');
    await page.screenshot({ path: `${OUT}/${name}-all.png`, fullPage: true });
    const sellers = await page.getByTestId('day-seller').count();
    const closed = await page
      .locator('[data-testid="day-seller"]:not([open])')
      .count();
    console.log(`  hammasi: sellers=${sellers} closedFolds=${closed} document=${await width(page)}`);
    const first = page.getByTestId('day-seller').first();
    console.log('  first fold reads:', (await first.innerText()).replace(/\n/g, ' · ').slice(0, 80));
  }
  await ctx.close();
} finally {
  await browser.close();
  for (const id of made) await sql`delete from leads where id = ${id}`;
  await sql.end();
  console.log('cleaned');
}
