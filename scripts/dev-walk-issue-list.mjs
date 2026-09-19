// Browser walk for the handover list (owner's item 3, one-off dev probe in the
// dev-walk-* family): stages a grouped person, a lone code and an unclaimed
// marking at an issuing warehouse on gsr_ci, opens /issue as an actor who may
// hand cargo over, screenshots at 360×800 and 1280×900, measures the document
// width at both, follows a code chip into the box list, and removes its rows.
import { chromium } from '@playwright/test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_ci';
const APP = 'http://127.0.0.1:3000';
const OUT = process.env.OUT_DIR ?? '/tmp/walk-issue';
const sql = postgres(DB, { max: 2 });
const stamp = String(Date.now()).slice(-6);
const made = { receipts: [], clients: [], people: [] };

async function stage() {
  const [actor] = await sql`select id from users where phone = '+998900000002'`;
  const [wh] = await sql`select id, code from warehouses
    where issues_to_clients = true and active = true and country = 'UZ' order by code limit 1`;

  const personId = randomUUID();
  await sql`insert into crm_people (id, name, phones, created_by)
    values (${personId}, ${'Yolchi ' + stamp}, ${sql.json(['+998 90 111-22-33'])}, ${actor.id})`;
  made.people.push(personId);

  const mkClient = async (code, name, extra) => {
    const id = randomUUID();
    await sql`insert into clients (id, client_code, name, phones, person_id)
      values (${id}, ${code}, ${name}, ${sql.json(extra.phones ?? [])}, ${extra.personId ?? null})`;
    made.clients.push(id);
    return id;
  };
  const a = await mkClient(`WA${stamp}`, `Yolchi A ${stamp}`, { personId, phones: ['+998 90 111-22-33'] });
  const b = await mkClient(`WB${stamp}`, `Yolchi B ${stamp}`, { personId, phones: ['+998 91 777-00-00'] });
  const c = await mkClient(`WC${stamp}`, `Bekzod Qodirov ${stamp}`, { phones: ['+998 93 555-44-33'] });

  const mkReceipt = async (clientId, marking, count) => {
    const id = randomUUID();
    await sql`insert into receipts (id, number, warehouse_id, client_id, unclaimed_marking, status, confirmed_at, created_by)
      values (${id}, ${'ISS-' + stamp + '-' + count}, ${wh.id}, ${clientId}, ${marking}, 'confirmed', now(), ${actor.id})`;
    made.receipts.push(id);
    const [lot] = await sql`insert into receipt_lots
      (id, receipt_id, seq, letter, dims_mode, product_name_zh, product_name_ru, box_count, total_weight_kg, total_volume_m3)
      values (gen_random_uuid(), ${id}, 1, 'A', 'mixed', ${'玩具 ' + stamp}, ${'Игрушки ' + stamp}, ${count}, ${count * 10}, ${count})
      returning id`;
    for (let i = 0; i < count; i += 1) {
      await sql`insert into boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
        values (gen_random_uuid(), ${lot.id}, ${'W' + stamp + '-' + made.receipts.length + '-' + i}, ${i + 1},
                'ready_for_pickup', ${wh.id})`;
    }
    return id;
  };
  await mkReceipt(a, null, 7);
  await mkReceipt(b, null, 4);
  await mkReceipt(c, null, 2);
  await mkReceipt(null, `GS${stamp}MANIKEN-AL`, 3);
  return { wh, codeA: `WA${stamp}` };
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
console.log('staged at', s.wh.code);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  for (const view of [
    { name: 'phone', width: 360, height: 800 },
    { name: 'desk', width: 1280, height: 900 },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height } });
    const page = await ctx.newPage();
    await login(page);
    await page.goto(`${APP}/issue`);
    await page.selectOption('[data-testid="issue-wh"]', { label: s.wh.code });
    await page.waitForSelector('[data-testid="issue-party"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/issue-${view.name}.png`, fullPage: true });
    const parties = await page.getByTestId('issue-party').count();
    const unclaimed = await page.getByTestId('issue-unclaimed').count();
    const w = await width(page);
    console.log(
      `${view.name}: parties=${parties} unclaimed=${unclaimed} document=${w} viewport=${view.width}`,
      w > view.width ? '⚠ RESCALE RISK' : 'OK',
    );
    if (view.name === 'phone') {
      // The first party row: what the operator actually reads.
      const row = page.getByTestId('issue-party').first();
      console.log('row 1 text:', (await row.innerText()).replace(/\n/g, ' · '));
      const box = await row.boundingBox();
      console.log('row 1 height', Math.round(box.height));
      // Follow a code chip into the box list — the list must be a door.
      await page.getByTestId('issue-party-code').first().click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/issue-picked.png`, fullPage: true });
      // The list is only useful if it is a DOOR: the box screen for that code
      // must actually appear. Counted by the controls the confirm depends on —
      // the per-box buttons carry no testid, so the lot block and the confirm
      // bar are the oracle (#494: count something that exists).
      console.log(
        'after tap: list hidden =', (await page.getByTestId('issue-parties').count()) === 0,
        '· picked =', await page.locator('.text-good').first().innerText().catch(() => '?'),
        '· lot blocks =', await page.locator('div.rounded-lg.border.border-line > button').count(),
        '· confirm bar =', await page.getByTestId('confirm-issue').count(),
        '· receiver name box =', await page.getByTestId('receiver-name').count(),
      );
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const id of made.receipts) {
    await sql`delete from boxes where lot_id in (select id from receipt_lots where receipt_id = ${id})`;
    await sql`delete from receipt_lots where receipt_id = ${id}`;
    await sql`delete from handovers where receipt_id = ${id}`.catch(() => {});
    await sql`delete from receipts where id = ${id}`;
  }
  for (const id of made.clients) await sql`delete from clients where id = ${id}`;
  for (const id of made.people) await sql`delete from crm_people where id = ${id}`;
  await sql.end();
  console.log('cleaned');
}
