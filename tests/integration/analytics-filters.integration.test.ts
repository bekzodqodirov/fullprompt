import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  dealStages,
  deals,
  leadSources,
  leadStages,
  leads,
  users,
} from '@/modules/platform/db/schema';
import { salesAnalytics } from '@/modules/wms/crm/analytics';

/**
 * Round 98's filter follow-up («filterlarni maximalna qoyish mumkun bolgan
 * narsalarga qoyib ber») — the semantics the adversarial review pinned:
 *
 *  - the owner filter is STRICT attribution (`eq` / `isNull`), deliberately
 *    NOT the board's «mine OR unclaimed» — or every seller's filtered
 *    scoreboard is inflated by the same unowned pile and disagrees with
 *    their own row in the table beneath it;
 *  - the deals block's WHERE is one OR expression, and the new filters AND
 *    onto it — without the OR's own parentheses the open count silently
 *    ignores every filter (`(f AND a) OR b`), which only an exact open-cell
 *    assertion can see.
 *
 * Fixtures park in April 2020 — a window nothing else in any database can
 * reach (the lost-reasons file owns March) — under a user and a source
 * minted by this file, so every filtered count is this file's alone.
 */

let seq = 0;
const MARK = `R98AF-${String(Date.now()).slice(-7)}-${++seq}`;

const FROM = new Date('2020-04-01T00:00:00Z');
const TO = new Date('2020-04-11T00:00:00Z');
const PERIOD = { from: FROM, to: TO };

let ownerA = '';
let sourceS = '';
let openStage = '';
let wonStage = '';
let lostStage = '';
let openDealStage = '';
let wonDealStage = '';
let clientId = '';
const made: string[] = [];
const madeDeals: string[] = [];

beforeAll(async () => {
  const stages = await db.select().from(leadStages);
  openStage = stages.find((s) => s.kind === 'open')!.id;
  wonStage = stages.find((s) => s.kind === 'won')!.id;
  lostStage = stages.find((s) => s.kind === 'lost')!.id;
  const dStages = await db.select().from(dealStages);
  openDealStage = dStages.find((s) => s.kind === 'open')!.id;
  wonDealStage = dStages.find((s) => s.kind === 'won')!.id;
  const [client] = await db.select({ id: clients.id }).from(clients).limit(1);
  clientId = client!.id;

  const [user] = await db
    .insert(users)
    .values({
      phone: `+9989${String(Date.now()).slice(-8)}`,
      fullName: `${MARK} sotuvchi`,
      passwordHash: 'x',
      active: true,
    })
    .returning({ id: users.id });
  ownerA = user!.id;

  const [src] = await db
    .insert(leadSources)
    .values({ name: `${MARK} manba`, sortOrder: 900 })
    .returning({ id: leadSources.id });
  sourceS = src!.id;

  const mint = async (row: {
    stageId: string;
    ownerId: string | null;
    sourceId: string | null;
    createdAt: Date;
    closedAt?: Date | null;
    quotedAmount?: string;
    quotedVolumeM3?: string;
    lostReason?: string;
  }) => {
    const [lead] = await db
      .insert(leads)
      .values({ name: `${MARK}-${++seq}`, ...row })
      .returning({ id: leads.id });
    made.push(lead!.id);
  };

  // L1: owner A, source S, 20 m³, arrived + WON in the window, $300.
  await mint({
    stageId: wonStage,
    ownerId: ownerA,
    sourceId: sourceS,
    createdAt: new Date('2020-04-02T08:00:00Z'),
    closedAt: new Date('2020-04-05T08:00:00Z'),
    quotedAmount: '300.00',
    quotedVolumeM3: '20.000',
  });
  // L2: unowned, sourceless, 5 m³, arrived in the window, still open.
  await mint({
    stageId: openStage,
    ownerId: null,
    sourceId: null,
    createdAt: new Date('2020-04-03T08:00:00Z'),
    quotedVolumeM3: '5.000',
  });
  // L3: owner A, sourceless, no quote at all, arrived + LOST in the window.
  await mint({
    stageId: lostStage,
    ownerId: ownerA,
    sourceId: null,
    createdAt: new Date('2020-04-04T08:00:00Z'),
    closedAt: new Date('2020-04-06T08:00:00Z'),
    lostReason: 'R98AF sabab',
  });

  // Two OPEN deals and two WON-in-window deals — one of each A's, one of
  // each nobody's — so a broken owner filter on EITHER arm of the deals
  // query's OR has something to leak.
  for (const owner of [ownerA, null]) {
    for (const closedStage of [null, wonDealStage]) {
      const [deal] = await db
        .insert(deals)
        .values({
          code: `${MARK}-${++seq}`,
          clientId,
          stageId: closedStage ?? openDealStage,
          ownerId: owner,
          createdBy: ownerA,
          ...(closedStage
            ? {
                closedAt: new Date('2020-04-07T08:00:00Z'),
                quotedAmount: '100.00',
                quotedCurrency: 'USD',
              }
            : {}),
        })
        .returning({ id: deals.id });
      madeDeals.push(deal!.id);
    }
  }
});

afterAll(async () => {
  if (madeDeals.length > 0) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (made.length > 0) await db.delete(leads).where(inArray(leads.id, made));
  await db.delete(leadSources).where(eq(leadSources.id, sourceS));
  await db.delete(users).where(eq(users.id, ownerA));
  await pgClient.end();
});

describe('the owner filter is attribution, not the board’s shared inbox', () => {
  it('hodim=A counts A’s leads alone — the unclaimed one stays out', async () => {
    const data = await salesAnalytics(PERIOD, { owner: ownerA });
    expect(data.totals.fresh).toBe(2); // L1 + L3, never L2
    expect(data.totals.won).toBe(1);
    expect(data.totals.lost).toBe(1);
    // The scoreboard and A's own row in the table must agree.
    const rowA = data.sellers.find((row) => row.id === ownerA);
    expect(rowA?.fresh).toBe(2);
    // And no «—» row: a named-seller filter that renders an unowned row is
    // the or(isNull) leak.
    expect(data.sellers.some((row) => row.id === null)).toBe(false);
  });

  it('hodim=none is the unclaimed pile alone', async () => {
    const data = await salesAnalytics(PERIOD, { owner: 'none' });
    expect(data.totals.fresh).toBe(1); // L2
    expect(data.totals.won).toBe(0);
  });
});

describe('source and range filters', () => {
  it('manba narrows every table, and the deals block honestly disappears', async () => {
    const data = await salesAnalytics(PERIOD, { source: sourceS });
    expect(data.totals.fresh).toBe(1);
    expect(data.totals.won).toBe(1);
    expect(data.totals.wonUsd).toBe(300);
    // A deal has no source: numbers here would be read as filtered.
    expect(data.deals).toBeNull();

    const none = await salesAnalytics(PERIOD, { source: 'none' });
    expect(none.totals.fresh).toBe(2); // L2 + L3
    // «No source» is still a source filter — a deal cannot answer it either.
    expect(none.deals).toBeNull();
  });

  it('a kub range keeps measured cargo only — an unquoted lead cannot match', async () => {
    const data = await salesAnalytics(PERIOD, { volMin: 10 });
    expect(data.totals.fresh).toBe(1); // L1 (20 m³); L2 is 5, L3 unmeasured
    const under = await salesAnalytics(PERIOD, { volMax: 10 });
    expect(under.totals.fresh).toBe(1); // L2 alone
  });
});

describe('the deals query’s OR wears its own parentheses', () => {
  it('BOTH arms obey the owner filter — the open cell and the won cell', async () => {
    // Measured, not assumed: without the OR's own parentheses drizzle
    // renders `(filter and open) OR closed-in-period` — the OPEN arm takes
    // the filter and the CLOSED arm escapes it, so the won cell counts the
    // whole company while the open cell looks right.
    const data = await salesAnalytics(PERIOD, { owner: ownerA });
    expect(data.deals?.open).toBe(1);
    expect(data.deals?.won).toBe(1);
    expect(data.deals?.wonUsd).toBe(100);
    const none = await salesAnalytics(PERIOD, { owner: 'none' });
    expect(none.deals?.won).toBe(1); // nobody's won deal, never A's
  });
});
