import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arriveOnDeal, removeArrived } from '../fixtures/deal-cargo';
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
import { recordOffer } from '@/modules/wms/calc/workspace';
import { payableOffersSql } from '@/modules/wms/calc/upsale';

/**
 * The upsale's denominator, fed by the seller's own LINES (docs/SAKKIZ-R2.md
 * §8.2.3, judges law-money-3 / regression-2).
 *
 * MR-9 keeps a request m³ so the seller's share scales on the QUOTED cube
 * (his 4b, 2026-09-26: «kelgan yuk / va'da qilingan kub»). The checklist now
 * stops asking a total the lines already give, so the landing STORES their Σ
 * at the INSERT — and an answer-anchored offer's `quoted_m3`
 * (`COALESCE(v.volume_m3, r.volume_m3)`) finds it. Without it a rastamojka
 * quote with kilos and no typed cube scales on the kilos ratio — or, with
 * neither, pays the whole share on the first carton that arrives.
 *
 * The expected factor is a literal worked by hand: 2.1 m³ arrived over the
 * lines' 1.2 + 1.6 = 2.8 m³ is 0.75 — and by the kilos it would be 1.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;

let actorId = '';
let clientId = '';
let stageId = '';
const madeDeals: string[] = [];
const madeReceipts: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `R2 lines-volume fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `LV${SUFFIX}`, name: `R2 lines-volume fixture ${SUFFIX}` })
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
  await removeArrived(madeReceipts);
  if (madeDeals.length > 0) await db.delete(deals).where(inArray(deals.id, madeDeals));
  // An audited fixture is deactivated, never deleted (audit_log FK).
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('the upsale scales on the cube the lines state', () => {
  it('a rastamojka job landed with 1.2 + 1.6 m³ lines and no typed total pays 2.1 ÷ 2.8 = 0.75 of its share', async () => {
    const [deal] = await db
      .insert(deals)
      .values({ code: `LV-${SUFFIX}-${(seq += 1)}`, clientId, stageId, title: 'R2 lines-volume fixture', createdBy: actorId })
      .returning();
    madeDeals.push(deal!.id);

    // The seller's card form: two lines with their own cube, 400 kg brutto,
    // the m³ box left empty — through the REAL door.
    const opened = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: deal!.id,
        section: 'rastamojka',
        weightKg: 400,
        items: [
          { name: `Kurtka ${SUFFIX}`, quantity: 300, volumeM3: 1.2 },
          { name: `Shim ${SUFFIX}`, quantity: 200, volumeM3: 1.6 },
        ],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(opened.id);
    const [stored] = await db.select({ m3: calcRequests.volumeM3 }).from(calcRequests).where(eq(calcRequests.id, opened.id));
    // Soft: the money below is the subject, and must be measured whatever this says.
    expect.soft(Number(stored!.m3)).toBe(2.8);

    // «Готово» with a typed floor, and an offer above it.
    await takeCalcRequest(opened.id, ctx());
    await finishCalcRequest(
      opened.id,
      { amountText: '1000', currency: 'USD', note: 'gotovo', internalNote: 'ichki: gotovo' },
      ctx(),
    );
    const offer = await recordOffer(
      { requestId: opened.id },
      { clientPriceUsd: 1200, locale: 'uz', expect: { entityType: 'deal', entityId: deal!.id } },
      ctx(),
    );
    expect(offer.pending).toBe(false);

    // 2.1 m³ arrives, at the quoted 400 kg — so a kilos ratio would read 1.
    madeReceipts.push(await arriveOnDeal({ dealId: deal!.id, clientId, actorId, m3: 2.1, kg: 400 }));
    const rows = await db.execute<{ cargo_factor: string; upsale_usd: string }>(
      sql`SELECT * FROM (${payableOffersSql()}) p WHERE p.entity_id = ${deal!.id}::uuid`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.cargo_factor)).toBe(0.75);
    expect(Number(rows[0]!.upsale_usd)).toBe(150);
  });
});
