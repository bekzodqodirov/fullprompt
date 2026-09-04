import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  deals,
  dealStages,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { finishCalcRequest, openCalcRequest, takeCalcRequest } from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  recordOffer,
  releaseOffer,
  saveTable,
  sealCalc,
} from '@/modules/wms/calc/workspace';
import { payableOffersSql } from '@/modules/wms/calc/upsale';

/**
 * Phase 4, item 5 — the offer's ANSWER anchor, end to end.
 *
 * Production's only price while the dictionaries are empty is a typed Готово
 * figure, and the judge confirmed three ways the naive design pays wrong
 * money: a forged requestId of an OPEN request reads a NULL floor as $0 and
 * bypasses the below-floor law; the release claim's version-shaped standing
 * clause bricks every answer-anchored approval; and a Готово price plus a
 * later proper seal are two requests but ONE sale. Each is an oracle here.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDA-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let stageId = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

async function mintDeal(): Promise<string> {
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VA-${SUFFIX}-${(seq += 1)}`,
      clientId,
      stageId,
      title: 'VED answer-offer fixture',
      createdBy: actorId,
    })
    .returning();
  madeDeals.push(deal!.id);
  return deal!.id;
}

/** An OPEN request on the deal — nothing answered yet. */
async function openRequest(dealId: string): Promise<string> {
  const opened = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items: [{ name: `monitor ${tag()}`, quantity: 100 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(opened.id);
  return opened.id;
}

/** A request CLOSED with a typed Готово figure — the anchor under test. */
async function answeredRequest(
  dealId: string,
  amount: number,
  currency = 'USD',
): Promise<string> {
  const id = await openRequest(dealId);
  await takeCalcRequest(id, ctx());
  await finishCalcRequest(id, { amount, currency, note: 'gotovo' }, ctx());
  return id;
}

/** Payable rows for one deal, through THE predicate itself. */
async function payableFor(dealId: string) {
  return db.execute<{
    id: string;
    version_id: string | null;
    request_id: string;
    total_usd: string;
    upsale_usd: string;
  }>(sql`SELECT * FROM (${payableOffersSql()}) p WHERE p.entity_id = ${dealId}::uuid`);
}

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99894${String(Date.now()).slice(-7)}`,
      fullName: `VED answer fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VA${SUFFIX}`, name: `VED answer fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  stageId = stage!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcOffers).where(inArray(calcOffers.requestId, madeRequests));
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeDeals.length > 0) await db.delete(deals).where(inArray(deals.id, madeDeals));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('the Готово answer as an offer floor', () => {
  it('an above-floor offer on a USD answer is recorded, priced and PAYABLE off the answer', async () => {
    const dealId = await mintDeal();
    const requestId = await answeredRequest(dealId, 1000);

    const res = await recordOffer(
      { requestId },
      { clientPriceUsd: 1200, locale: 'uz', expect: { entityType: 'deal', entityId: dealId } },
      ctx(),
    );
    expect(res.pending).toBe(false);
    expect(res.text).toContain('1 200.00');
    // The text never prints the floor — law 4 on the answer anchor too.
    expect(res.text).not.toContain('1 000.00');

    const [offer] = await db.select().from(calcOffers).where(eq(calcOffers.id, res.id));
    expect(offer!.versionId).toBeNull();
    expect(offer!.requestId).toBe(requestId);

    const payable = await payableFor(dealId);
    expect(payable).toHaveLength(1);
    expect(Number(payable[0]!.total_usd)).toBe(1000);
    expect(Number(payable[0]!.upsale_usd)).toBe(200);

    // The card carries the CLIENT price, exactly as a version offer writes it.
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(Number(deal!.quotedAmount)).toBe(1200);
  });

  it('a hand-posted OPEN request is refused — a NULL answer must never read as a $0 floor', async () => {
    const dealId = await mintDeal();
    const requestId = await openRequest(dealId);
    await expect(
      recordOffer({ requestId }, { clientPriceUsd: 500, locale: 'uz' }, ctx()),
    ).rejects.toMatchObject({ code: 'answer_missing' });
    // Nothing written, nothing on the card.
    expect(await db.select().from(calcOffers).where(eq(calcOffers.requestId, requestId))).toHaveLength(0);
  });

  it('a non-USD answer refuses with its own word, never a coerced floor', async () => {
    const dealId = await mintDeal();
    const requestId = await answeredRequest(dealId, 9_000_000, 'UZS');
    await expect(
      recordOffer({ requestId }, { clientPriceUsd: 800, locale: 'uz' }, ctx()),
    ).rejects.toMatchObject({ code: 'answer_not_usd' });
  });

  it('the seal clock gates this door too: an old answer is answer_expired', async () => {
    const dealId = await mintDeal();
    const requestId = await answeredRequest(dealId, 700);
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(calcRequests.id, requestId));
    await expect(
      recordOffer({ requestId }, { clientPriceUsd: 900, locale: 'uz' }, ctx()),
    ).rejects.toMatchObject({ code: 'answer_expired' });
  });

  it('a below-floor answer offer waits, and releaseOffer RELEASES it (the claim knows the anchor)', async () => {
    const dealId = await mintDeal();
    const requestId = await answeredRequest(dealId, 1500);

    const res = await recordOffer(
      { requestId },
      { clientPriceUsd: 1400, locale: 'uz', belowFloorReason: 'doimiy mijoz', mayApprove: false },
      ctx(),
    );
    expect(res.pending).toBe(true);
    expect(res.text).toBeNull();
    // Pending: not payable, not on the card.
    expect(await payableFor(dealId)).toHaveLength(0);

    // The judge's blocker: a version-shaped standing clause in the claim
    // matches NOTHING here and every answer-anchored approval dies as
    // «superseded». The release must succeed — and write the card.
    const released = await releaseOffer(res.id, ctx());
    expect(released.pending).toBe(false);
    expect(released.text).toContain('1 400.00');
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(Number(deal!.quotedAmount)).toBe(1400);
    // Below the floor: released, on the card, still NOT a commission.
    expect(await payableFor(dealId)).toHaveLength(0);
  });

  it('a NEWER USD answer on the same card outranks the old one — for the door and for money', async () => {
    const dealId = await mintDeal();
    const oldRequest = await answeredRequest(dealId, 1000);
    const offered = await recordOffer(
      { requestId: oldRequest },
      { clientPriceUsd: 1300, locale: 'uz' },
      ctx(),
    );
    expect(offered.pending).toBe(false);
    expect(await payableFor(dealId)).toHaveLength(1);

    // The VED answers again (a new job on the same card, newer figure).
    const newRequest = await answeredRequest(dealId, 1100);
    // The old anchor stops standing: no new offer on it…
    await expect(
      recordOffer({ requestId: oldRequest }, { clientPriceUsd: 1300, locale: 'uz' }, ctx()),
    ).rejects.toMatchObject({ code: 'superseded' });
    // …and the RECORDED old offer stops being payable — the card's newest
    // word on price is the only floor money is measured against.
    expect(await payableFor(dealId)).toHaveLength(0);

    // The new anchor works.
    const res = await recordOffer(
      { requestId: newRequest },
      { clientPriceUsd: 1350, locale: 'uz' },
      ctx(),
    );
    expect(res.pending).toBe(false);
    const payable = await payableFor(dealId);
    expect(payable).toHaveLength(1);
    expect(Number(payable[0]!.total_usd)).toBe(1100);
  });

  it('a version SEALED after the answer kills the answer payable — one sale never pays twice', async () => {
    const dealId = await mintDeal();
    const answered = await answeredRequest(dealId, 1000);
    await recordOffer({ requestId: answered }, { clientPriceUsd: 1250, locale: 'uz' }, ctx());
    expect(await payableFor(dealId)).toHaveLength(1);

    // The VED then does the job PROPERLY on a second request and seals.
    const sealableId = await openRequest(dealId);
    const items = await db
      .select()
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, sealableId));
    await saveTable(
      sealableId,
      {
        items: [
          {
            id: items[0]!.id,
            seq: items[0]!.seq,
            tnvedCode: '8528520000',
            bazaUsd: 20,
            bazaBasis: 'unit',
          },
        ],
        adds: [],
      },
      ctx(),
    );
    await confirmAllGroups(sealableId, ctx());
    await sealCalc(
      sealableId,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );

    // The Готово commission is gone; the sealed request carries its own
    // offers from here (none yet — so zero payable, not two).
    expect(await payableFor(dealId)).toHaveLength(0);
  });
});
