import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { refileRefusal } from '@/modules/wms/deals/service';

/**
 * `refileRefusal` reads the facts the deal door judges — who manages the
 * client, whom the prixod was stamped with, who owns the deal it stands on and
 * the deal it would go to — from the DATABASE, never from the form (the two
 * actions that move a prixod ask it before anything is written; the wire is
 * pinned in `tests/unit/refile-door-wire.test.ts`). 2026-11-18: a seller sees
 * every client's prixod, and moves his own.
 */

const SUFFIX = String(Date.now()).slice(-5);
let seller = '';
let colleague = '';
let warehouse = '';
let stage = '';
const made = { clients: [] as string[], receipts: [] as string[], deals: [] as string[] };

const sellerActor = () => ({ id: seller, permissions: new Set<string>(ROLE_MATRIX.sales_manager) });

async function prixod(
  code: string,
  manager: string,
  dealOwner: string | null,
  stamped: string = manager,
): Promise<{ receiptId: string; dealId: string | null }> {
  const [client] = (await db.execute(sql`
    INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
    VALUES (gen_random_uuid(), ${code}, ${`Refile ${code}`}, '[]'::jsonb, ${manager}::uuid) RETURNING id`)) as unknown as { id: string }[];
  made.clients.push(client!.id);
  let dealId: string | null = null;
  if (dealOwner) {
    const [deal] = (await db.execute(sql`
      INSERT INTO deals (id, code, client_id, stage_id, owner_id, title, created_by)
      VALUES (gen_random_uuid(), ${`${code}-D`}, ${client!.id}::uuid, ${stage}::uuid, ${dealOwner}::uuid, 'Refile', ${colleague}::uuid)
      RETURNING id`)) as unknown as { id: string }[];
    dealId = deal!.id;
    made.deals.push(dealId);
  }
  const [receipt] = (await db.execute(sql`
    INSERT INTO receipts (id, number, warehouse_id, client_id, deal_id, sales_manager_id, status, confirmed_at, confirmed_by, created_by)
    VALUES (gen_random_uuid(), ${`${code}-R`}, ${warehouse}::uuid, ${client!.id}::uuid, ${dealId}::uuid, ${stamped}::uuid,
            'confirmed', now(), ${colleague}::uuid, ${colleague}::uuid)
    RETURNING id`)) as unknown as { id: string }[];
  made.receipts.push(receipt!.id);
  return { receiptId: receipt!.id, dealId };
}

async function dealOf(code: string, client: string, owner: string): Promise<string> {
  const [deal] = (await db.execute(sql`
    INSERT INTO deals (id, code, client_id, stage_id, owner_id, title, created_by)
    VALUES (gen_random_uuid(), ${code}, ${client}::uuid, ${stage}::uuid, ${owner}::uuid, 'Refile', ${colleague}::uuid)
    RETURNING id`)) as unknown as { id: string }[];
  made.deals.push(deal!.id);
  return deal!.id;
}

beforeAll(async () => {
  const people = (await db.execute(sql`
    SELECT u.id, r.code FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE r.code IN ('sales_manager', 'super_admin') ORDER BY u.created_at`)) as unknown as { id: string; code: string }[];
  seller = people.find((p) => p.code === 'sales_manager')!.id;
  colleague = people.find((p) => p.code === 'super_admin' && p.id !== seller)!.id;
  const [wh] = (await db.execute(sql`SELECT id FROM warehouses WHERE active ORDER BY code LIMIT 1`)) as unknown as { id: string }[];
  warehouse = wh!.id;
  const [st] = (await db.execute(sql`
    SELECT id FROM deal_stages WHERE active AND kind = 'open' ORDER BY sort_order LIMIT 1`)) as unknown as { id: string }[];
  stage = st!.id;
});

afterAll(async () => {
  if (made.receipts.length) await db.execute(sql`UPDATE receipts SET deal_id = NULL WHERE id IN (${sql.join(made.receipts.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const id of made.receipts) await db.execute(sql`DELETE FROM receipts WHERE id = ${id}::uuid`);
  for (const id of made.deals) await db.execute(sql`DELETE FROM deals WHERE id = ${id}::uuid`);
  for (const id of made.clients) await db.execute(sql`DELETE FROM clients WHERE id = ${id}::uuid`);
  await pgClient.end();
});

describe('refileRefusal reads the door’s facts from the database', () => {
  it("refuses a seller a colleague's prixod — to move, to take off, or onto his own deal", async () => {
    const theirs = await prixod(`RFA${SUFFIX}`, colleague, colleague);
    const [client] = (await db.execute(sql`SELECT client_id FROM receipts WHERE id = ${theirs.receiptId}::uuid`)) as unknown as {
      client_id: string;
    }[];
    const mineToo = await dealOf(`RFA${SUFFIX}-MY`, client!.client_id, seller);
    expect(await refileRefusal(sellerActor(), theirs.receiptId)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), theirs.receiptId, null)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), theirs.receiptId, mineToo)).toBe('not_your_cargo');
  });

  it('lets him move his own client’s prixod anywhere', async () => {
    const mine = await prixod(`RFB${SUFFIX}`, seller, seller);
    expect(await refileRefusal(sellerActor(), mine.receiptId)).toBeNull();
    expect(await refileRefusal(sellerActor(), mine.receiptId, null)).toBeNull();
  });

  it('reads the client’s manager and the stamp as two facts — either one makes the prixod his', async () => {
    // The client moved to him after the cargo came (stamped with the colleague, on the colleague's deal)…
    const movedToHim = await prixod(`RFE${SUFFIX}`, seller, colleague, colleague);
    expect(await refileRefusal(sellerActor(), movedToHim.receiptId, null)).toBeNull();
    // …and the cargo he brought in for a client who has since gone to the colleague.
    const broughtByHim = await prixod(`RFF${SUFFIX}`, colleague, colleague, seller);
    expect(await refileRefusal(sellerActor(), broughtByHim.receiptId, null)).toBeNull();
  });

  it("lets him attach a colleague's client's LOOSE prixod onto a deal he owns, and not onto the colleague's", async () => {
    const loose = await prixod(`RFC${SUFFIX}`, colleague, null);
    const [client] = (await db.execute(sql`SELECT client_id FROM receipts WHERE id = ${loose.receiptId}::uuid`)) as unknown as {
      client_id: string;
    }[];
    const his = await dealOf(`RFC${SUFFIX}-MY`, client!.client_id, seller);
    const theirs = await dealOf(`RFC${SUFFIX}-TH`, client!.client_id, colleague);
    expect(await refileRefusal(sellerActor(), loose.receiptId, his)).toBeNull();
    expect(await refileRefusal(sellerActor(), loose.receiptId, theirs)).toBe('not_your_cargo');
    // A new deal born with it is not «his deal».
    expect(await refileRefusal(sellerActor(), loose.receiptId)).toBe('not_your_cargo');
  });

  it('the office moves anybody’s, and a posted id that is no uuid is left to the link to refuse', async () => {
    const theirs = await prixod(`RFD${SUFFIX}`, colleague, colleague);
    const ved = { id: seller, permissions: new Set<string>(ROLE_MATRIX.ved_manager) };
    expect(await refileRefusal(ved, theirs.receiptId, null)).toBeNull();
    expect(await refileRefusal(sellerActor(), 'not-a-uuid')).toBeNull();
    expect(await refileRefusal(sellerActor(), theirs.receiptId, 'not-a-uuid')).toBe('not_your_cargo');
  });
});
