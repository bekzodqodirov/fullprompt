import 'dotenv/config';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  notifications,
  receiptLots,
  receipts,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { recalcFromSealed, sealCalc, setFreightZone } from '@/modules/wms/calc/workspace';
import { answerLinkAsk, confirmCalcLink } from '@/modules/wms/calc/link';
import { linkSuggestionCount, linkSuggestions } from '@/modules/wms/calc/actuals';
import { claimLinkAsks, linkAskEligible } from '@/modules/wms/calc/link-ask';
import { decideLinkFromBot } from '@/modules/wms/calc/link-bot';
import { buildHomeFlow } from '@/modules/wms/home/role-flows';
import { linkReceipt } from '@/modules/wms/deals/service';

/**
 * 0119 — the VED is ASKED about a calc↔prixod guess (owner's 20a).
 *
 * Four things this rests on, each pinned here through the real doors:
 *   1. the SEAL stamps cargo that arrived while the calculation was worked on,
 *      inside the quote's window and never outside it;
 *   2. a ❌ stays a ❌ — a correction's seal cannot hang the same prixod back
 *      on the job (its window starts after the prixod arrived);
 *   3. a press answers about the request it NAMED, conditionally: a stale ❌
 *      after a person's ✅ is «already», a re-filed prixod is «changed», a
 *      colleague's calculation is «not mine»;
 *   4. the home's «Tasdiqlash kerak: N» is the control screen's list, counted.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `LASK-${SUFFIX}-${(seq += 1)}`;

let sealerId = '';
let colleagueId = '';
let bystanderId = '';
let clientId = '';
let warehouseId = '';
let stageId = '';
const sealerChat = BigInt(Date.now()) * 100n + 41n;
const colleagueChat = BigInt(Date.now()) * 100n + 42n;
const bystanderChat = BigInt(Date.now()) * 100n + 43n;
const madeRequests: string[] = [];
const madeReceipts: string[] = [];
const madeDeals: string[] = [];
const ctx = () => ({ actorId: sealerId });
const SEAL = { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null };

async function user(name: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      phone: `+99894${String(Date.now()).slice(-6)}${seq++ % 10}`,
      fullName: `${name} ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  return row!.id;
}

async function grantRole(userId: string, code: string): Promise<void> {
  const role = await db.query.roles.findFirst({ where: eq(roles.code, code) });
  await db.insert(userRoles).values({ userId, roleId: role!.id }).onConflictDoNothing();
}

beforeAll(async () => {
  sealerId = await user('Link ask sealer');
  colleagueId = await user('Link ask colleague');
  bystanderId = await user('Link ask bystander');
  // Grants are editable data (#170): the VED role, whatever the matrix says it
  // holds today — `calcControlScopeFor` then answers 'own' for both.
  await grantRole(sealerId, 'ved_manager');
  await grantRole(colleagueId, 'ved_manager');
  await db.insert(telegramLinks).values([
    { userId: sealerId, telegramChatId: sealerChat, status: 'linked', linkedAt: new Date() },
    { userId: colleagueId, telegramChatId: colleagueChat, status: 'linked', linkedAt: new Date() },
    { userId: bystanderId, telegramChatId: bystanderChat, status: 'linked', linkedAt: new Date() },
  ]);
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `LA${SUFFIX}`, name: `Link ask fixture ${SUFFIX}` })
    .returning();
  clientId = c!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  stageId = stage!.id;
  const wh = await db.query.warehouses.findFirst();
  warehouseId = wh!.id;
});

afterAll(async () => {
  if (madeReceipts.length > 0) {
    await db.delete(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
  if (madeRequests.length > 0) {
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.update(calcRequests).set({ supersedesRequestId: null }).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeDeals.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
    await db.delete(deals).where(inArray(deals.id, madeDeals));
  }
  const people = [sealerId, colleagueId, bystanderId];
  await db.delete(notifications).where(inArray(notifications.userId, people));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
  await db.delete(userRoles).where(inArray(userRoles.userId, people));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  // Audited people are deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(inArray(users.id, people));
  await pgClient.end();
});

async function newDeal(): Promise<string> {
  const [d] = await db
    .insert(deals)
    .values({ code: `LA-${tag()}`, clientId, stageId, title: 'Link ask fixture', createdBy: sealerId })
    .returning();
  madeDeals.push(d!.id);
  return d!.id;
}

/** An open yolkira job on the deal — the tariff alone reaches a price. */
async function openJob(dealId: string): Promise<string> {
  const request = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
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
  // The window opens an hour ago, so a prixod confirmed «a few seconds ago»
  // is inside it by the clock and not by a millisecond race between the
  // database's now() and this process's.
  await db
    .update(calcRequests)
    .set({ requestedAt: sql`now() - interval '1 hour'` })
    .where(eq(calcRequests.id, request.id));
  return request.id;
}

async function receiptOn(dealId: string, confirmedAt: Date, opts: { voided?: boolean } = {}): Promise<string> {
  const [row] = await db
    .insert(receipts)
    .values({
      number: `LA${tag()}`,
      warehouseId,
      clientId,
      status: opts.voided ? 'voided' : 'confirmed',
      createdBy: sealerId,
      confirmedAt,
      confirmedBy: sealerId,
      dealId,
      ...(opts.voided ? { voidedAt: new Date(), voidedBy: sealerId, voidReason: 'fixture' } : {}),
    })
    .returning();
  madeReceipts.push(row!.id);
  await db.insert(receiptLots).values({
    receiptId: row!.id,
    seq: 1,
    productNameZh: `tovar ${tag()}`,
    boxCount: 1,
    dimsMode: 'mixed',
    totalWeightKg: '1400',
    totalVolumeM3: '28',
  });
  return row!.id;
}

/** Inside the window and in the PAST — a correction is requested after it, as in life. */
const later = () => new Date(Date.now() - 5000);
const read = (id: string) => db.query.receipts.findFirst({ where: eq(receipts.id, id) });
const prefix = (requestId: string) => requestId.slice(0, 8);

describe('the seal stamps the cargo that arrived while it was being worked on', () => {
  it('in the window: suggested and owed a question; before the request: left alone', async () => {
    const dealId = await newDeal();
    const requestId = await openJob(dealId);
    const before = await receiptOn(dealId, new Date(Date.now() - 2 * 86_400_000));
    const during = await receiptOn(dealId, later());
    // Neither has a link yet: nothing was sealed when they were confirmed.
    expect((await read(during))!.calcRequestId).toBeNull();

    await sealCalc(requestId, SEAL, ctx());

    const stamped = await read(during);
    expect(stamped!.calcRequestId).toBe(requestId);
    expect(stamped!.calcLinkSource).toBe('auto');
    expect(stamped!.calcLinkConfirmedAt).toBeNull();
    expect(stamped!.calcLinkNotifiedAt).toBeNull();
    // Confirmed before the price was even asked for: next season's cargo.
    expect((await read(before))!.calcRequestId).toBeNull();
  });
});

describe('a ❌ stays a ❌, and a correction asks its own sealer', () => {
  it('the correction does not re-stamp the refused prixod, re-asks the unconfirmed one, keeps the confirmed one’s record', async () => {
    const dealId = await newDeal();
    const first = await openJob(dealId);
    const refused = await receiptOn(dealId, later());
    const unasked = await receiptOn(dealId, later());
    const answered = await receiptOn(dealId, later());
    await sealCalc(first, SEAL, ctx());
    for (const id of [refused, unasked, answered]) expect((await read(id))!.calcRequestId).toBe(first);

    expect(await answerLinkAsk(refused, prefix(first), 'drop', 'all', ctx())).toBe('dropped');
    expect(await answerLinkAsk(answered, prefix(first), 'confirm', 'all', ctx())).toBe('confirmed');
    // Both were asked in Telegram once.
    const askedAt = new Date(Date.now() - 60_000);
    await db
      .update(receipts)
      .set({ calcLinkNotifiedAt: askedAt })
      .where(inArray(receipts.id, [unasked, answered]));

    const second = await recalcFromSealed(first, ctx());
    madeRequests.push(second);
    await setFreightZone(second, 'cn', ctx());
    await sealCalc(second, SEAL, ctx());

    // The refused prixod was confirmed before the correction was requested,
    // so the correction's window cannot reach it.
    const r = await read(refused);
    expect(r!.calcRequestId).toBeNull();
    expect(r!.calcLinkSource).toBeNull();
    // The unconfirmed guess moved with the cargo and is owed a new question —
    // the new version's sealer may be somebody else.
    const u = await read(unasked);
    expect(u!.calcRequestId).toBe(second);
    expect(u!.calcLinkNotifiedAt).toBeNull();
    // A person's answer moved with it too, and nobody is asked about it again.
    const a = await read(answered);
    expect(a!.calcRequestId).toBe(second);
    expect(a!.calcLinkConfirmedAt).not.toBeNull();
    expect(a!.calcLinkNotifiedAt).not.toBeNull();
  });
});

describe('a press answers about the request it named', () => {
  it('a second ✅ is «already»', async () => {
    const dealId = await newDeal();
    const requestId = await openJob(dealId);
    const id = await receiptOn(dealId, later());
    await sealCalc(requestId, SEAL, ctx());
    expect(await answerLinkAsk(id, prefix(requestId), 'confirm', 'own', ctx())).toBe('confirmed');
    expect(await answerLinkAsk(id, prefix(requestId), 'confirm', 'own', ctx())).toBe('already');
  });

  it('the accountant’s ✅ on the screen, then a stale ❌ in Telegram: «already», and the ✅ stands', async () => {
    const dealId = await newDeal();
    const requestId = await openJob(dealId);
    const id = await receiptOn(dealId, later());
    await sealCalc(requestId, SEAL, ctx());
    await confirmCalcLink(id, 'all', { actorId: bystanderId });
    expect(await answerLinkAsk(id, prefix(requestId), 'drop', 'own', ctx())).toBe('already');
    const row = await read(id);
    expect(row!.calcRequestId).toBe(requestId);
    expect(row!.calcLinkConfirmedBy).toBe(bystanderId);
  });

  it('a re-filed prixod is «changed» — the button does not follow it to another job', async () => {
    const dealId = await newDeal();
    const requestId = await openJob(dealId);
    const id = await receiptOn(dealId, later());
    await sealCalc(requestId, SEAL, ctx());
    const other = await newDeal();
    await linkReceipt(id, other, ctx());
    expect(await answerLinkAsk(id, prefix(requestId), 'confirm', 'all', ctx())).toBe('changed');
  });

  it('through the bot: the sealer confirms; a colleague VED is «not mine»; a chat with no door learns nothing', async () => {
    const dealId = await newDeal();
    const requestId = await openJob(dealId);
    const id = await receiptOn(dealId, later());
    await sealCalc(requestId, SEAL, ctx());

    expect(await decideLinkFromBot(colleagueChat, id, prefix(requestId), 'drop')).toBe('not_mine');
    expect((await read(id))!.calcRequestId).toBe(requestId);
    expect(await decideLinkFromBot(bystanderChat, id, prefix(requestId), 'drop')).toBe('forbidden');
    expect(await decideLinkFromBot(bystanderChat + 1000n, id, prefix(requestId), 'drop')).toBe('not_linked');
    expect(await decideLinkFromBot(sealerChat, id, prefix(requestId), 'confirm')).toBe('confirmed');
    const row = await read(id);
    expect(row!.calcLinkConfirmedBy).toBe(sealerId);
  });
});

describe('the sweep’s claim', () => {
  it('a second claimer neither waits on nor overlaps a claim held open, and claims run to exhaustion', async () => {
    // A sealer of its own: the claim takes every unasked guess of the sealers
    // it is given, and the other tests here leave some on the file's sealer.
    const claimSealer = await user('Link ask claim sealer');
    const dealA = await newDeal();
    const dealB = await newDeal();
    const reqA = await openJob(dealA);
    const reqB = await openJob(dealB);
    const mine = [
      await receiptOn(dealA, later()),
      await receiptOn(dealA, later()),
      await receiptOn(dealB, later()),
    ];
    await sealCalc(reqA, SEAL, { actorId: claimSealer });
    await sealCalc(reqB, SEAL, { actorId: claimSealer });

    let held: string[] = [];
    let second: string[] | 'waited' = [];
    await db.transaction(async (tx) => {
      held = (await claimLinkAsks([claimSealer], tx)).map((c) => c.receiptId);
      // The pool claimer runs WHILE the first claim's locks are held. SKIP
      // LOCKED is what lets it pass them by instead of queueing behind them.
      second = await Promise.race([
        claimLinkAsks([claimSealer]).then((rows) => rows.map((c) => c.receiptId)),
        new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3000)),
      ]);
    });
    expect(second).not.toBe('waited');
    expect(held.sort()).toEqual([...mine].sort());
    expect((second as string[]).filter((id) => held.includes(id))).toEqual([]);

    // Exhaustion: two claimers side by side until both come back empty.
    const seen: string[] = [...held, ...(second as string[])];
    for (let round = 0; round < 5; round++) {
      const [x, y] = await Promise.all([claimLinkAsks([claimSealer]), claimLinkAsks([claimSealer])]);
      seen.push(...x.map((c) => c.receiptId), ...y.map((c) => c.receiptId));
      if (x.length === 0 && y.length === 0) break;
    }
    const mineSeen = seen.filter((id) => mine.includes(id));
    expect(mineSeen.sort()).toEqual([...mine].sort());
    expect(new Set(seen).size).toBe(seen.length);
    const stamped = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(inArray(receipts.id, mine), isNotNull(receipts.calcLinkNotifiedAt)));
    expect(stamped).toHaveLength(mine.length);
    await db.update(users).set({ active: false }).where(eq(users.id, claimSealer));
  });

  it('a sealer who lost the VED door is never claimed for', async () => {
    const lost = await user('Link ask departed');
    const dealId = await newDeal();
    const requestId = await openJob(dealId);
    const id = await receiptOn(dealId, later());
    await sealCalc(requestId, SEAL, { actorId: lost });
    expect((await read(id))!.calcRequestId).toBe(requestId);

    // Every OTHER unasked guess in the database is parked for the length of
    // this test and put back after (#730): the claim is a shared queue, and a
    // claim that took strangers' rows would be asserting about strangers.
    const foreign = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          sql`${receipts.calcRequestId} IS NOT NULL`,
          isNull(receipts.calcLinkConfirmedAt),
          isNull(receipts.calcLinkNotifiedAt),
          sql`${receipts.id} <> ${id}`,
        ),
      );
    const parked = foreign.map((r) => r.id);
    if (parked.length > 0) {
      await db.update(receipts).set({ calcLinkNotifiedAt: new Date() }).where(inArray(receipts.id, parked));
    }
    try {
      const eligible = await linkAskEligible();
      expect(eligible).not.toContain(lost);
      expect(eligible).toContain(sealerId);
      const claimed = await claimLinkAsks(eligible);
      expect(claimed.map((c) => c.receiptId)).not.toContain(id);
      expect((await read(id))!.calcLinkNotifiedAt).toBeNull();
    } finally {
      if (parked.length > 0) {
        await db.update(receipts).set({ calcLinkNotifiedAt: null }).where(inArray(receipts.id, parked));
      }
      await db.update(users).set({ active: false }).where(eq(users.id, lost));
    }
  });
});

describe('«Tasdiqlash kerak: N» is the control screen’s list, counted', () => {
  it('home = count = uncapped list, for own and for all — a voided and a confirmed prixod on the same job excluded', async () => {
    const dealId = await newDeal();
    const requestId = await openJob(dealId);
    const pending = await receiptOn(dealId, later());
    const voided = await receiptOn(dealId, later());
    const confirmed = await receiptOn(dealId, later());
    await sealCalc(requestId, SEAL, ctx());
    await answerLinkAsk(confirmed, prefix(requestId), 'confirm', 'all', ctx());
    // Voided AFTER the stamp: the guess stays on the row, and it is not cargo.
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: sealerId, voidReason: 'fixture' })
      .where(eq(receipts.id, voided));

    const own = { scope: 'own' as const, actorId: sealerId };
    const ownList = await linkSuggestions(own, 100_000);
    expect(ownList.map((r) => r.receiptId)).toContain(pending);
    expect(ownList.map((r) => r.receiptId)).not.toContain(voided);
    expect(ownList.map((r) => r.receiptId)).not.toContain(confirmed);
    const ownCount = await linkSuggestionCount(own);
    expect(ownCount).toBe(ownList.length);

    const flow = await buildHomeFlow(
      {
        id: sealerId,
        roles: ['ved_manager'],
        permissions: new Set(['ved.docs']),
        warehouseScoped: false,
        warehouseIds: [],
      },
      new Date().toISOString().slice(0, 10),
    );
    expect(flow?.kind).toBe('ved');
    if (flow?.kind !== 'ved') throw new Error('not the VED flow');
    expect(flow.counts.calcLinksPending).toBe(ownCount);

    const all = { scope: 'all' as const, actorId: sealerId };
    expect(await linkSuggestionCount(all)).toBe((await linkSuggestions(all, 1_000_000)).length);
    expect(await linkSuggestionCount({ scope: 'none', actorId: sealerId })).toBe(0);
  });
});
