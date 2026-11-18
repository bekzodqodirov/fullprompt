import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { refileRefusal } from '@/modules/wms/deals/service';

/**
 * `refileRefusal` reads the facts the deal door judges — who manages the
 * client, whom the prixod was stamped with, which OWN deal it stands on and
 * who owns it, and the deal it would go to — from the DATABASE, never from
 * the form (the two actions that move a prixod ask it before anything is
 * written; the wire is pinned in `tests/unit/refile-door-wire.test.ts`, the
 * actions themselves in `refile-door-actions.integration.test.ts`).
 * 2026-11-18: a seller sees every client's prixod, and moves his own.
 *
 * Every case is built so that ONE fact decides it — a fixture where the
 * manager, the stamp and the deal's owner are the same person proves nothing
 * about which of them the reader read (the as-built review, FENCE-2).
 */

const SUFFIX = String(Date.now()).slice(-5);
let seller = '';
let colleague = '';
let warehouse = '';
let stage = '';
const made = { clients: [] as string[], receipts: [] as string[], deals: [] as string[] };

const sellerActor = () => ({ id: seller, permissions: new Set<string>(ROLE_MATRIX.sales_manager) });

async function clientOf(code: string, manager: string | null): Promise<string> {
  const [client] = (await db.execute(sql`
    INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
    VALUES (gen_random_uuid(), ${code}, ${`Refile ${code}`}, '[]'::jsonb, ${manager}::uuid) RETURNING id`)) as unknown as { id: string }[];
  made.clients.push(client!.id);
  return client!.id;
}

async function dealOf(code: string, client: string, owner: string | null): Promise<string> {
  const [deal] = (await db.execute(sql`
    INSERT INTO deals (id, code, client_id, stage_id, owner_id, title, created_by)
    VALUES (gen_random_uuid(), ${code}, ${client}::uuid, ${stage}::uuid, ${owner}::uuid, 'Refile', ${colleague}::uuid)
    RETURNING id`)) as unknown as { id: string }[];
  made.deals.push(deal!.id);
  return deal!.id;
}

/**
 * A confirmed prixod of a fresh client. `dealOwner` mints a deal of THAT
 * client it stands on (undefined = loose; null = an ownerless deal);
 * `foreignDealOwner` instead leaves it on ANOTHER client's deal — what a client
 * correction leaves behind (`assignReceiptClient` restamps and keeps `deal_id`).
 */
async function prixod(
  code: string,
  o: { manager: string | null; stamped: string | null; dealOwner?: string | null; foreignDealOwner?: string },
): Promise<{ receiptId: string; clientId: string; dealId: string | null }> {
  const clientId = await clientOf(code, o.manager);
  let dealId: string | null = null;
  if (o.dealOwner !== undefined) dealId = await dealOf(`${code}-D`, clientId, o.dealOwner);
  if (o.foreignDealOwner !== undefined) {
    const other = await clientOf(`${code}Y`, o.foreignDealOwner);
    dealId = await dealOf(`${code}-Y`, other, o.foreignDealOwner);
  }
  const [receipt] = (await db.execute(sql`
    INSERT INTO receipts (id, number, warehouse_id, client_id, deal_id, sales_manager_id, status, confirmed_at, confirmed_by, created_by)
    VALUES (gen_random_uuid(), ${`${code}-R`}, ${warehouse}::uuid, ${clientId}::uuid, ${dealId}::uuid, ${o.stamped}::uuid,
            'confirmed', now(), ${colleague}::uuid, ${colleague}::uuid)
    RETURNING id`)) as unknown as { id: string }[];
  made.receipts.push(receipt!.id);
  return { receiptId: receipt!.id, clientId, dealId };
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
    const theirs = await prixod(`RFA${SUFFIX}`, { manager: colleague, stamped: colleague, dealOwner: colleague });
    const mineToo = await dealOf(`RFA${SUFFIX}-MY`, theirs.clientId, seller);
    expect(await refileRefusal(sellerActor(), theirs.receiptId)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), theirs.receiptId, null)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), theirs.receiptId, mineToo)).toBe('not_your_cargo');
  });

  it('lets him move his own client’s prixod off a deal he owns, anywhere', async () => {
    const mine = await prixod(`RFB${SUFFIX}`, { manager: seller, stamped: seller, dealOwner: seller });
    expect(await refileRefusal(sellerActor(), mine.receiptId)).toBeNull();
    expect(await refileRefusal(sellerActor(), mine.receiptId, null)).toBeNull();
  });

  it('reads the client’s manager and the stamp as two facts — either one makes a LOOSE prixod his', async () => {
    // The client moved to him after the cargo came (stamped with the colleague)…
    const movedToHim = await prixod(`RFE${SUFFIX}`, { manager: seller, stamped: colleague });
    expect(await refileRefusal(sellerActor(), movedToHim.receiptId)).toBeNull();
    expect(await refileRefusal(sellerActor(), movedToHim.receiptId, null)).toBeNull();
    // …and the cargo he brought in for a client who has since gone to the colleague.
    const broughtByHim = await prixod(`RFF${SUFFIX}`, { manager: colleague, stamped: seller });
    expect(await refileRefusal(sellerActor(), broughtByHim.receiptId)).toBeNull();
    expect(await refileRefusal(sellerActor(), broughtByHim.receiptId, null)).toBeNull();
  });

  it('reads the owner of the deal it stands on — his deal makes the prixod his whoever the client’s seller is (FENCE-2)', async () => {
    // A colleague's client, stamped with the colleague, on a deal HE owns (Uch band Q3 b).
    const onHisDeal = await prixod(`RFG${SUFFIX}`, { manager: colleague, stamped: colleague, dealOwner: seller });
    const another = await dealOf(`RFG${SUFFIX}-2`, onHisDeal.clientId, seller);
    expect(await refileRefusal(sellerActor(), onHisDeal.receiptId, null)).toBeNull();
    expect(await refileRefusal(sellerActor(), onHisDeal.receiptId, another)).toBeNull();
    expect(await refileRefusal(sellerActor(), onHisDeal.receiptId)).toBeNull();
    // A client with no seller and a prixod with no stamp: only the deal speaks.
    const nobodys = await prixod(`RFH${SUFFIX}`, { manager: null, stamped: null, dealOwner: seller });
    expect(await refileRefusal(sellerActor(), nobodys.receiptId, null)).toBeNull();
    expect(await refileRefusal(sellerActor(), nobodys.receiptId)).toBeNull();
  });

  it('a prixod on a job a colleague OWNS is the colleague’s — even to the client’s own seller (SEL-3)', async () => {
    // His client, stamped with him — on the colleague's deal (a won lead about his client).
    const onTheirs = await prixod(`RFI${SUFFIX}`, { manager: seller, stamped: seller, dealOwner: colleague });
    const his = await dealOf(`RFI${SUFFIX}-MY`, onTheirs.clientId, seller);
    expect(await refileRefusal(sellerActor(), onTheirs.receiptId)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), onTheirs.receiptId, null)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), onTheirs.receiptId, his)).toBe('not_your_cargo');
    // On an OWNERLESS deal his client's prixod is his again.
    const onNobodys = await prixod(`RFJ${SUFFIX}`, { manager: seller, stamped: null, dealOwner: null });
    expect(await refileRefusal(sellerActor(), onNobodys.receiptId, null)).toBeNull();
  });

  it('another client’s deal it was left on is no deal of the prixod’s — its owner is nobody here (SEL-1)', async () => {
    // A colleague's client's prixod, left by a client correction on a deal of
    // ANOTHER client that the seller owns: he may not move it, take it off, or
    // open a deal born with it…
    const left = await prixod(`RFK${SUFFIX}`, { manager: colleague, stamped: colleague, foreignDealOwner: seller });
    const theirs = await dealOf(`RFK${SUFFIX}-TH`, left.clientId, colleague);
    expect(await refileRefusal(sellerActor(), left.receiptId)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), left.receiptId, null)).toBe('not_your_cargo');
    expect(await refileRefusal(sellerActor(), left.receiptId, theirs)).toBe('not_your_cargo');
    // …but it reads as LOOSE, so a deal of ITS client that he owns may take it.
    const his = await dealOf(`RFK${SUFFIX}-MY`, left.clientId, seller);
    expect(await refileRefusal(sellerActor(), left.receiptId, his)).toBeNull();
  });

  it("lets him attach a colleague's client's LOOSE prixod onto a deal he owns, and not onto the colleague's", async () => {
    const loose = await prixod(`RFC${SUFFIX}`, { manager: colleague, stamped: colleague });
    const his = await dealOf(`RFC${SUFFIX}-MY`, loose.clientId, seller);
    const theirs = await dealOf(`RFC${SUFFIX}-TH`, loose.clientId, colleague);
    expect(await refileRefusal(sellerActor(), loose.receiptId, his)).toBeNull();
    expect(await refileRefusal(sellerActor(), loose.receiptId, theirs)).toBe('not_your_cargo');
    // A new deal born with it is not «his deal».
    expect(await refileRefusal(sellerActor(), loose.receiptId)).toBe('not_your_cargo');
  });

  it('the office moves anybody’s, and a posted id that is no uuid is left to the link to refuse', async () => {
    const theirs = await prixod(`RFD${SUFFIX}`, { manager: colleague, stamped: colleague, dealOwner: colleague });
    const ved = { id: seller, permissions: new Set<string>(ROLE_MATRIX.ved_manager) };
    expect(await refileRefusal(ved, theirs.receiptId, null)).toBeNull();
    expect(await refileRefusal(sellerActor(), 'not-a-uuid')).toBeNull();
    expect(await refileRefusal(sellerActor(), theirs.receiptId, 'not-a-uuid')).toBe('not_your_cargo');
  });
});
