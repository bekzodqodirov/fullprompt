import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Chegara navbatlari» at 1280×900, in Russian and in Uzbek, with the edit
 * fold open — the screenshots the round is looked at through — and the
 * Mashina tab's pins on a truck bound for Uzbekistan.
 *
 * Two pieces of configuration are borrowed and returned EXACTLY (#183): the
 * border_queue table (a typed wait moves every Horgos date) and the logist's
 * own language (the screen's language is the person's, not a cookie). The
 * returns are the last TEST, and repeated in afterAll with no browser in
 * case an earlier test failed and skipped it.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to snapshot and restore this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

type QueueRow = {
  id: string;
  post: string;
  min_hours: number | null;
  max_hours: number | null;
  note: string | null;
  updated_by: string | null;
  updated_at: string;
};

let queue: QueueRow[] | null = null;
let locale: string | null = null;
let restored = false;

async function readQueue(sql: postgres.Sql): Promise<QueueRow[]> {
  return sql<QueueRow[]>`
    SELECT id, post, min_hours, max_hours, note, updated_by, updated_at::text AS updated_at
    FROM border_queue ORDER BY post`;
}

async function restore() {
  if (restored || queue === null) return;
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM border_queue`;
      for (const r of queue!) {
        await tx`
          INSERT INTO border_queue (id, post, min_hours, max_hours, note, updated_by, updated_at)
          VALUES (${r.id}, ${r.post}, ${r.min_hours}, ${r.max_hours}, ${r.note}, ${r.updated_by},
                  ${r.updated_at}::timestamptz)`;
      }
      if (locale !== null) await tx`UPDATE users SET locale = ${locale} WHERE phone = ${LOGIST}`;
    });
    restored = true;
  } finally {
    await sql.end();
  }
}

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function widthFits(page: Page) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(w.doc).toBeLessThanOrEqual(w.view);
}

test.afterAll(async () => {
  await restore();
});

test('borrow the queues and the logist’s language', async () => {
  const sql = database();
  try {
    queue = await readQueue(sql);
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${LOGIST}`;
    locale = row!.locale;
  } finally {
    await sql.end();
  }
});

test('the panel at 1280×900 in Russian and in Uzbek, the fold open', async ({ page }) => {
  for (const lang of ['ru', 'uz'] as const) {
    const sql = database();
    try {
      await sql`UPDATE users SET locale = ${lang} WHERE phone = ${LOGIST}`;
    } finally {
      await sql.end();
    }
    await login(page, LOGIST);
    await page.goto('/trucks');
    await expect(page.getByTestId('border-queue')).toBeVisible();
    await page.getByTestId('queue-edit-yallama').locator('summary').click();
    await expect(page.getByTestId('queue-min-yallama')).toBeVisible();
    await widthFits(page);
    await page.screenshot({ path: `test-results/chegara-navbat-1280-${lang}.png`, fullPage: true });
  }
});

test('the Mashina tab offers a truck bound for Uzbekistan the pins of its own road', async ({ page }) => {
  const sql = database();
  let batchId: string | undefined;
  try {
    // Any truck on the road to Uzbekistan the demo has (m3 departs one to
    // Tashkent) — a screenshot of the pins, not a claim about how many exist.
    const [row] = await sql<{ id: string }[]>`
      SELECT b.id FROM batches b JOIN warehouses d ON d.id = b.dest_warehouse_id
      WHERE b.status = 'in_transit' AND d.country = 'UZ' ORDER BY b.departed_at DESC NULLS LAST LIMIT 1`;
    batchId = row?.id;
  } finally {
    await sql.end();
  }
  test.skip(!batchId, 'no truck on the road to Uzbekistan in this database');
  await login(page, LOGIST);
  await page.goto(`/batches/${batchId}/mashina`);
  await expect(page.getByTestId('batch-where-panel')).toBeVisible();
  await widthFits(page);
  await page.screenshot({ path: 'test-results/chegara-mashina-pins-1280.png', fullPage: true });
});

test('the queues and the language are returned exactly', async () => {
  await restore();
  const sql = database();
  try {
    expect(await readQueue(sql)).toEqual(queue);
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${LOGIST}`;
    expect(row!.locale).toBe(locale);
  } finally {
    await sql.end();
  }
});
