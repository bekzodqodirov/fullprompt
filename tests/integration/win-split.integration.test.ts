import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  leads,
  leadStages,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { finishCalcRequest, openCalcRequest, takeCalcRequest } from '@/modules/wms/calc/service';
import { recalcFromSealed, recordOffer, sealCalc, setFreightZone } from '@/modules/wms/calc/workspace';
import { answerFloorStandsSql } from '@/modules/wms/calc/version-set';
import { winLead } from '@/modules/wms/crm/service';

/**
 * «Yutildi» on a lead that collected several calculations (his Q5 a,
 * 2026-10-27 — «har so'rovga yangi bitim»; docs/UCH-BAND.md §7).
 *
 * The win groups the lead's jobs by SALE and opens a deal per live sale. The
 * money oracle is the judge's money-1: a Готово answer that a LATER seal on
 * the same lead outranked is dead on the lead, and moved onto a deal where
 * nothing outranks it, it would stand again — its floor, its offer, its lock,
 * its payout. So the answer must travel with the seal that outranked it.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `WS-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let clientCode = '';
let otherCode = '';
let otherId = '';
let openStageId = '';
const madeLeads: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

async function mintLead(name: string): Promise<string> {
  const [lead] = await db
    .insert(leads)
    .values({ name: `${name} ${SUFFIX}`, stageId: openStageId, createdBy: actorId, ownerId: actorId })
    .returning({ id: leads.id });
  madeLeads.push(lead!.id);
  return lead!.id;
}

/** A sealed yolkira job on the lead — freight only, so the tariff alone prices it. */
async function sealedOn(leadId: string) {
  const request = await openCalcRequest(
    {
      entityType: 'lead',
      entityId: leadId,
      section: 'yolkira',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: [{ name: `tovar ${tag()}`, quantity: 10 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  await setFreightZone(request.id, 'cn', ctx());
  await sealCalc(request.id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
  const version = await db.query.calcVersions.findFirst({ where: eq(calcVersions.requestId, request.id) });
  return { requestId: request.id, versionId: version!.id, floor: Number(version!.totalUsd), sealedAt: version!.sealedAt };
}

/** An open rastamojka job on the lead — nothing priced yet. */
async function openOn(leadId: string, goods = `monitor ${tag()}`): Promise<string> {
  const request = await openCalcRequest(
    {
      entityType: 'lead',
      entityId: leadId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items: [{ name: goods, quantity: 100 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  return request.id;
}

/** A job closed with a typed Готово figure. */
async function answeredOn(leadId: string, amount: number): Promise<string> {
  const id = await openOn(leadId);
  await takeCalcRequest(id, ctx());
  await finishCalcRequest(id, { amountText: String(amount), currency: 'USD', note: 'gotovo', internalNote: 'ichki' }, ctx());
  return id;
}

async function cardOf(requestId: string): Promise<{ type: string; id: string }> {
  const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, requestId) });
  return { type: row!.entityType, id: row!.entityId };
}

/** Does this answer stand as a floor where it is now — THE money fragment, nothing restated. */
async function answerStands(requestId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT coalesce(${answerFloorStandsSql()}, false) AS ok FROM calc_requests r WHERE r.id = ${requestId}::uuid`)) as unknown as {
    ok: boolean;
  }[];
  return rows[0]?.ok === true;
}

/** Somebody else's transaction, held open on its own connection (batch-rename's helper). */
async function withHolder(run: (held: postgres.ReservedSql) => Promise<void>) {
  const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
    max: 1,
    onnotice: () => {},
  });
  const held = await helper.reserve();
  try {
    await run(held);
  } finally {
    held.release();
    await helper.end();
  }
}

/** Is anybody WAITING on a lock right now? Through the POOL (#873). */
async function someoneWaits(): Promise<boolean> {
  for (let i = 0; i < 250; i += 1) {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)) as unknown as {
      n: number;
    }[];
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function dealsOfClient(): Promise<string[]> {
  const rows = await db.select({ id: deals.id }).from(deals).where(eq(deals.clientId, clientId));
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99893${String(Date.now()).slice(-7)}`, fullName: `Win split ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  clientCode = `WS${SUFFIX}`;
  const [client] = await db
    .insert(clients)
    .values({ clientCode, name: `Win split ${SUFFIX}`, salesManagerId: actorId })
    .returning();
  clientId = client!.id;
  otherCode = `WT${SUFFIX}`;
  const [other] = await db.insert(clients).values({ clientCode: otherCode, name: `Win other ${SUFFIX}` }).returning();
  otherId = other!.id;
  const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
  openStageId = stage!.id;
});

afterAll(async () => {
  // Whatever a red proof let land on these leads goes too, not only what the
  // helpers recorded — a request that should have been refused leaks otherwise.
  if (madeLeads.length > 0) {
    const stray = await db
      .select({ id: calcRequests.id })
      .from(calcRequests)
      .where(and(eq(calcRequests.entityType, 'lead'), inArray(calcRequests.entityId, madeLeads)));
    for (const row of stray) if (!madeRequests.includes(row.id)) madeRequests.push(row.id);
  }
  if (madeRequests.length > 0) {
    await db.delete(calcOffers).where(inArray(calcOffers.requestId, madeRequests));
    const vs = await db.select({ id: calcVersions.id }).from(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    if (vs.length > 0) await db.delete(calcOffers).where(inArray(calcOffers.versionId, vs.map((v) => v.id)));
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.update(calcRequests).set({ supersedesRequestId: null }).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  // Deals before their clients; leads take their FTL and «about» rows with them (CASCADE).
  await db.delete(deals).where(inArray(deals.clientId, [clientId, otherId]));
  if (madeLeads.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  await db.update(clients).set({ active: false }).where(inArray(clients.id, [clientId, otherId]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('a won lead opens a deal per SALE', () => {
  it('an answer outranked by a later seal travels WITH that seal, and stays dead (money-1)', async () => {
    const leadId = await mintLead('Uch hisob');
    // D sealed first, A answered, B sealed AFTER A (so A no longer stands on
    // the lead), then an offer on D writes the lead's number — D is the main
    // sale, and the question is where the dead answer A goes.
    const d = await sealedOn(leadId);
    const a = await answeredOn(leadId, 1000);
    const b = await sealedOn(leadId);
    const offer = await recordOffer({ versionId: d.versionId }, { clientPriceUsd: d.floor + 300, locale: 'uz' }, ctx());
    expect(await answerStands(a)).toBe(false);

    const before = await dealsOfClient();
    const won = await winLead(leadId, { attachCode: clientCode, token: randomUUID() }, ctx());
    const opened = (await dealsOfClient()).filter((id) => !before.includes(id));
    expect(opened.sort()).toEqual([won.dealId, ...won.otherDeals.map((x) => x.id)].sort());
    expect(won.otherDeals).toHaveLength(1);

    // THE oracle first: the answer is still outranked where it landed. Moved
    // alone (or with D) it would stand again and become a payable floor.
    expect(await answerStands(a)).toBe(false);

    // D on the main deal with its offer; A and B together on the other one.
    expect(await cardOf(d.requestId)).toEqual({ type: 'deal', id: won.dealId });
    const other = won.otherDeals[0]!.id;
    expect(await cardOf(b.requestId)).toEqual({ type: 'deal', id: other });
    expect(await cardOf(a)).toEqual({ type: 'deal', id: other });
    const [movedOffer] = await db.select().from(calcOffers).where(eq(calcOffers.id, offer.id));
    expect(movedOffer!.entityId).toBe(won.dealId);

    // Each deal is priced by its own sale's writer, stamped with who gave the
    // price and when — the main deal with the lead's number (D's offer), the
    // other with B's seal (judge money-4).
    const main = await db.query.deals.findFirst({ where: eq(deals.id, won.dealId) });
    expect(Number(main!.quotedAmount)).toBe(d.floor + 300);
    const second = await db.query.deals.findFirst({ where: eq(deals.id, other) });
    expect(Number(second!.quotedAmount)).toBe(b.floor);
    expect(second!.quotedBy).toBe(actorId);
    expect(second!.quotedAt?.getTime()).toBe(b.sealedAt.getTime());

    // And the lead is won, in the same commit as the deals.
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.id, lead!.stageId) });
    expect(stage!.kind).toBe('won');
    expect(lead!.clientId).toBe(clientId);
  });

  it('two open jobs on an FTL lead open two FTL deals, and a second press of the same opening converges', async () => {
    const leadId = await mintLead('Ikki ish');
    await db.execute(sql`INSERT INTO lead_ftl (lead_id, marked_by, by_office) VALUES (${leadId}::uuid, ${actorId}::uuid, true)`);
    const older = await openOn(leadId, `kafel ${tag()}`);
    const newer = await openOn(leadId);
    const token = randomUUID();

    const before = await dealsOfClient();
    const won = await winLead(leadId, { attachCode: clientCode, token }, ctx());
    expect(won.otherDeals).toHaveLength(1);
    // With no writer the NEWEST live sale is the main deal's.
    expect(await cardOf(newer)).toEqual({ type: 'deal', id: won.dealId });
    expect(await cardOf(older)).toEqual({ type: 'deal', id: won.otherDeals[0]!.id });
    const otherDeal = await db.query.deals.findFirst({ where: eq(deals.id, won.otherDeals[0]!.id) });
    expect(otherDeal!.title).toMatch(/^Rastamojka — kafel /);
    expect(otherDeal!.quotedAmount).toBeNull();
    const ftl = (await db.execute(sql`
      SELECT deal_id::text AS id FROM deal_ftl WHERE deal_id IN (${won.dealId}::uuid, ${won.otherDeals[0]!.id}::uuid)`)) as unknown as {
      id: string;
    }[];
    expect(ftl).toHaveLength(2);

    // The same opening pressed again (a double tap, a retry after a blink)
    // lands on the deals the first press wrote and opens nothing.
    const again = await winLead(leadId, { attachCode: clientCode, token }, ctx());
    expect(again.dealId).toBe(won.dealId);
    expect((await dealsOfClient()).filter((id) => !before.includes(id))).toHaveLength(2);

    // A won lead takes no new calculation (judge conc-8).
    await expect(
      openCalcRequest(
        {
          entityType: 'lead',
          entityId: leadId,
          section: 'rastamojka',
          fromCity: 'Yiwu',
          toCity: 'Toshkent',
          weightKg: 100,
          volumeM3: 1,
          items: [{ name: `kech ${tag()}`, quantity: 1 }],
          source: 'card',
        },
        ctx(),
      ),
    ).rejects.toThrow('lead_closed');

    // …and refuses it BEFORE writing the card's note: the files a form
    // already uploaded against that id would otherwise sit on a card no job
    // follows, and the next press would answer `note_taken` (review).
    const noteId = randomUUID();
    await expect(
      openCalcRequest(
        {
          entityType: 'lead',
          entityId: leadId,
          section: 'rastamojka',
          fromCity: 'Yiwu',
          toCity: 'Toshkent',
          weightKg: 100,
          volumeM3: 1,
          items: [{ name: `kech ${tag()}`, quantity: 1 }],
          note: { id: noteId, text: 'yopilgan lidga izoh' },
          source: 'card',
        },
        ctx(),
      ),
    ).rejects.toThrow('lead_closed');
    expect(await db.query.crmActivities.findFirst({ where: eq(crmActivities.id, noteId) })).toBeUndefined();
  });

  it('a «Qayta hisoblash» racing the win lands on the DEAL the win moved its parent to', async () => {
    // The review's race: the recalc reads its parent on the pool, the win
    // moves that parent onto a deal and commits, and only then does the
    // recalc get the parent's lock. Reproduced deterministically: a holder
    // takes the parent's lock first, the recalc queues behind it, the holder
    // moves the parent (what the win does) and commits.
    const leadId = await mintLead('Poyga');
    const r = await sealedOn(leadId);
    const wonStage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'won') });
    const dstage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    const [deal] = await db
      .insert(deals)
      .values({ code: `WSR-${SUFFIX}`, clientId, stageId: dstage!.id, createdBy: actorId })
      .returning({ id: deals.id });
    let correction: Promise<{ id: string }> | null = null;
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT id FROM calc_requests WHERE id = ${r.requestId}::uuid FOR UPDATE`;
      correction = recalcFromSealed(r.requestId, ctx());
      expect(await someoneWaits()).toBe(true);
      await held`UPDATE calc_requests SET entity_type = 'deal', entity_id = ${deal!.id}::uuid WHERE id = ${r.requestId}::uuid`;
      await held`UPDATE leads SET stage_id = ${wonStage!.id}::uuid WHERE id = ${leadId}::uuid`;
      await held`COMMIT`;
    });
    const made = await correction!;
    madeRequests.push(made.id);
    expect(await cardOf(made.id)).toEqual({ type: 'deal', id: deal!.id });
  });

  it('a lead about a colleague’s client is won onto THAT client only (money-8)', async () => {
    const leadId = await mintLead('Hamkasb');
    await db.execute(sql`INSERT INTO lead_about_client (lead_id, client_id) VALUES (${leadId}::uuid, ${clientId}::uuid)`);
    await expect(winLead(leadId, { name: 'Yangi', token: randomUUID() }, ctx())).rejects.toThrow('lead_about_client');
    await expect(winLead(leadId, { attachCode: otherCode, token: randomUUID() }, ctx())).rejects.toThrow(
      'lead_about_client',
    );
    const untouched = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    expect(untouched!.clientId).toBeNull();
    const won = await winLead(leadId, { attachCode: clientCode, token: randomUUID() }, ctx());
    expect(won.clientId).toBe(clientId);
    expect(won.otherDeals).toHaveLength(0);
    const row = await db.query.deals.findFirst({ where: and(eq(deals.id, won.dealId), eq(deals.clientId, clientId)) });
    expect(row).toBeTruthy();
  });
});
