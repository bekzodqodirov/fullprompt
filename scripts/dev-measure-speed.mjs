// Round-45 method against the local standalone on gsr_dev: log in, then for
// each hot screen measure TTFB (3 passes) and count the pg statements one
// render issues (execute lines in the postgres log, per round 68's rule).
// Usage: node scripts/dev-measure-speed.mjs
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3000';
const PGLOG = '/var/local/pg/log';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(BASE + '/login');
await page.locator('input[name="identifier"]').fill('+998999999901');
await page.locator('input[name="password"]').fill('demo1234');
await page.locator('main form button[type="submit"]').first().click();
await page.waitForURL(BASE + '/');
const cookies = await ctx.cookies();
const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
await browser.close();

const logSize = () => Number(execSync(`stat -c %s ${PGLOG}`).toString().trim());
const countExec = (from) =>
  Number(
    execSync(
      `tail -c +${from + 1} ${PGLOG} | grep -c "execute" || true`,
    ).toString().trim(),
  );

const PAGES = ['/', '/crm', '/bitimlar', '/suhbatlar', '/stock', '/admin/clients', '/accounting', '/bugun'];
for (const path of PAGES) {
  const times = [];
  let stmts = 0;
  for (let i = 0; i < 3; i++) {
    const before = logSize();
    const t0 = performance.now();
    const res = await fetch(BASE + path, { headers: { cookie }, redirect: 'manual' });
    await res.arrayBuffer();
    const ms = Math.round(performance.now() - t0);
    times.push(res.status === 200 ? ms : `${res.status}!`);
    await new Promise((r) => setTimeout(r, 300));
    if (i === 2) stmts = countExec(before);
  }
  console.log(path.padEnd(16), 'ms:', times.join(' / '), '  stmts(last):', stmts);
}
