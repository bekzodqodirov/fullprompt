import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The deal actions read a session; this file stands in for it (and for Next's
// cache and the job queue) and for nothing else — deal-ved's shape. The rule
// itself is proven in refile-door.integration.test.ts; THIS file presses the
// two actions a seller's buttons call, because a fence that finds the call
// cannot see whether its answer is obeyed: an inverted `if`, or a bare
// `await refileRefusal(...)` with the throw gone, is lint-clean and leaves the
// call in place (the as-built review, FENCE-1).
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'refile-door-actions.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async () => {},
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { createDealAction, linkReceiptAction } from '@/app/(protected)/bitimlar/actions';

/** The demo seller (`scripts/seed-demo.ts`) — a real `sales_manager` and nothing else. */
const SELLER_PHONE = '+998900000009';
const SUFFIX = String(Date.now()).slice(-5);
let seller = '';
let colleague = '';
let warehouse = '';
let stage = '';
const made = { clients: [] as string[], receipts: [] as string[], deals: [] as string[] };

async function clientOf(code: string, manager: string): Promise<string> {
  const [row] = (await db.execute(sql`
    INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
    VALUES (gen_random_uuid(), ${code}, ${`Refile action ${code}`}, '[]'::jsonb, ${manager}::uuid) RETURNING id`)) as unknown as { id: string }[];
  made.clients.push(row!.id);
  return row!.id;
}

async function dealOf(code: string, client: string, owner: string): Promise<string> {
  const [row] = (await db.execute(sql`
    INSERT INTO deals (id, code, client_id, stage_id, owner_id, title, created_by)
    VALUES (gen_random_uuid(), ${code}, ${client}::uuid, ${stage}::uuid, ${owner}::uuid, 'Refile action', ${colleague}::uuid)
    RETURNING id`)) as unknown as { id: string }[];
  made.deals.push(row!.id);
  return row!.id;
}

async function prixodOf(code: string, client: string, stamped: string, dealId: string | null): Promise<string> {
  const [row] = (await db.execute(sql`
    INSERT INTO receipts (id, number, warehouse_id, client_id, deal_id, sales_manager_id, status, confirmed_at, confirmed_by, created_by)
    VALUES (gen_random_uuid(), ${code}, ${warehouse}::uuid, ${client}::uuid, ${dealId}::uuid, ${stamped}::uuid,
            'confirmed', now(), ${colleague}::uuid, ${colleague}::uuid)
    RETURNING id`)) as unknown as { id: string }[];
  made.receipts.push(row!.id);
  return row!.id;
}

async function dealOfReceipt(receiptId: string): Promise<string | null> {
  const [row] = (await db.execute(sql`SELECT deal_id FROM receipts WHERE id = ${receiptId}::uuid`)) as unknown as {
    deal_id: string | null;
  }[];
  return row!.deal_id;
}

async function signInSeller() {
  const [row] = (await db.execute(sql`
    SELECT id, phone, username, full_name, locale FROM users WHERE phone = ${SELLER_PHONE}`)) as unknown as {
    id: string;
    phone: string;
    username: string | null;
    full_name: string;
    locale: string;
  }[];
  session.user = {
    id: row!.id,
    phone: row!.phone,
    username: row!.username,
    fullName: row!.full_name,
    locale: row!.locale,
    active: true,
    sessionId: '00000000-0000-4000-8000-0000000f1e01',
  };
}

beforeAll(async () => {
  const [me] = (await db.execute(sql`SELECT id FROM users WHERE phone = ${SELLER_PHONE}`)) as unknown as { id: string }[];
  seller = me!.id;
  const [boss] = (await db.execute(sql`
    SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'super_admin' AND u.id <> ${seller}::uuid ORDER BY u.created_at LIMIT 1`)) as unknown as { id: string }[];
  colleague = boss!.id;
  const [wh] = (await db.execute(sql`SELECT id FROM warehouses WHERE active ORDER BY code LIMIT 1`)) as unknown as { id: string }[];
  warehouse = wh!.id;
  const [st] = (await db.execute(sql`
    SELECT id FROM deal_stages WHERE active AND kind = 'open' ORDER BY sort_order LIMIT 1`)) as unknown as { id: string }[];
  stage = st!.id;
  await signInSeller();
});

afterAll(async () => {
  session.user = null;
  // Deals the actions may have minted are this file's clients' too.
  const minted = made.clients.length
    ? ((await db.execute(sql`SELECT id FROM deals WHERE client_id IN (${sql.join(made.clients.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as {
        id: string;
      }[])
    : [];
  const dealIds = [...new Set([...made.deals, ...minted.map((d) => d.id)])];
  if (made.receipts.length) {
    await db.execute(sql`UPDATE receipts SET deal_id = NULL WHERE id IN (${sql.join(made.receipts.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  const touched = [...made.receipts, ...dealIds];
  if (touched.length) await db.execute(sql`DELETE FROM events WHERE entity_id IN (${sql.join(touched.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const id of made.receipts) await db.execute(sql`DELETE FROM receipts WHERE id = ${id}::uuid`);
  for (const id of dealIds) await db.execute(sql`DELETE FROM deals WHERE id = ${id}::uuid`);
  for (const id of made.clients) await db.execute(sql`DELETE FROM clients WHERE id = ${id}::uuid`);
  await pgClient.end();
});

describe('the two actions that move a prixod refuse a seller a colleague’s — and still take his own', () => {
  it('linkReceiptAction: a colleague’s prixod on the colleague’s deal stays where it is', async () => {
    const client = await clientOf(`RAA${SUFFIX}`, colleague);
    const theirs = await dealOf(`RAA${SUFFIX}-TH`, client, colleague);
    const his = await dealOf(`RAA${SUFFIX}-MY`, client, seller);
    const prixod = await prixodOf(`RAA${SUFFIX}-R`, client, colleague, theirs);
    expect(await linkReceiptAction(prixod, null)).toEqual({ error: 'not_your_cargo' });
    expect(await linkReceiptAction(prixod, his)).toEqual({ error: 'not_your_cargo' });
    expect(await dealOfReceipt(prixod)).toBe(theirs);
  });

  it('createDealAction: no deal born with a colleague’s loose prixod, and none minted at all', async () => {
    const client = await clientOf(`RAB${SUFFIX}`, colleague);
    const prixod = await prixodOf(`RAB${SUFFIX}-R`, client, colleague, null);
    const form = new FormData();
    form.set('clientId', client);
    form.set('title', 'Refile action born-with');
    form.set('receiptId', prixod);
    expect(await createDealAction({}, form)).toEqual({ error: 'not_your_cargo' });
    const [count] = (await db.execute(sql`SELECT count(*)::int AS n FROM deals WHERE client_id = ${client}::uuid`)) as unknown as {
      n: number;
    }[];
    expect(count!.n).toBe(0);
    expect(await dealOfReceipt(prixod)).toBeNull();
  });

  it('linkReceiptAction: his own client’s loose prixod goes onto his deal — the refusal is not a refusal of everything', async () => {
    const client = await clientOf(`RAC${SUFFIX}`, seller);
    const his = await dealOf(`RAC${SUFFIX}-MY`, client, seller);
    const prixod = await prixodOf(`RAC${SUFFIX}-R`, client, seller, null);
    expect(await linkReceiptAction(prixod, his)).toEqual({ ok: true });
    expect(await dealOfReceipt(prixod)).toBe(his);
  });

  it('linkReceiptAction: a colleague’s client’s loose prixod onto a deal HE owns — the deal card’s attach (Uch band Q3 b)', async () => {
    const client = await clientOf(`RAD${SUFFIX}`, colleague);
    const his = await dealOf(`RAD${SUFFIX}-MY`, client, seller);
    const theirs = await dealOf(`RAD${SUFFIX}-TH`, client, colleague);
    const prixod = await prixodOf(`RAD${SUFFIX}-R`, client, colleague, null);
    expect(await linkReceiptAction(prixod, theirs)).toEqual({ error: 'not_your_cargo' });
    expect(await dealOfReceipt(prixod)).toBeNull();
    expect(await linkReceiptAction(prixod, his)).toEqual({ ok: true });
    expect(await dealOfReceipt(prixod)).toBe(his);
  });
});
