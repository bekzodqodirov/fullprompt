import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { events, notifications, users } from '@/modules/platform/db/schema';
import { emitEvent, type DomainEventType } from '@/modules/platform/events/service';
import { processPendingEvents } from '@/modules/platform/notifications/service';

/**
 * Two drains, one queue.
 *
 * `processPendingEvents` used to read `WHERE processed_at IS NULL` and mark the
 * row processed only AFTER handling it, so two overlapping runs read the same
 * rows and fanned them out twice. The drains overlap routinely — a pg-boss
 * sweep every minute, plus the kick every CRM action fires — and the visible
 * consequence was a phase-7 rule firing twice: one stage move, two identical
 * tasks or two copies of the same Telegram message.
 *
 * The claim is now the UPDATE itself, so this asserts the thing that actually
 * matters: run two drains AT THE SAME TIME and every event must be handled
 * exactly once between them.
 */

const STAMP = String(Date.now()).slice(-7);
const EVENTS = 12;
let actorId: string;
const madeIds: bigint[] = [];

beforeAll(async () => {
  const [staff] = await db.select().from(users).limit(1);
  actorId = staff!.id;
  // Drain whatever the rest of the suite left pending, so the count below is
  // about THIS file's events and nothing else (#183's rule, one table over).
  await processPendingEvents();
});

afterAll(async () => {
  if (madeIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.eventId, madeIds));
    await db.delete(events).where(inArray(events.id, madeIds));
  }
  await pgClient.end();
});

describe('the event drain is a queue, not a snapshot', () => {
  it('two drains running together handle every event exactly once', async () => {
    // `PlanApproved` because `buildRecipients` answers it from a ROLE list
    // and therefore always finds somebody. The first version of this test used
    // a type with no recipients, so no notification rows existed to count and
    // it passed with the bug still in place — a test that passes because the
    // thing under test never appeared proves nothing (#494's lesson, and the
    // reason the assertion below demands rows before it demands correctness).
    for (let i = 0; i < EVENTS; i++) {
      await emitEvent(db, {
        type: 'PlanApproved' as DomainEventType,
        payload: { note: `drain ${STAMP} #${i}` },
        entityType: 'plan',
        actorId,
      });
    }
    const mine = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${events.payload}->>'note' LIKE ${`drain ${STAMP} %`}`);
    madeIds.push(...mine.map((row) => row.id));
    expect(mine).toHaveLength(EVENTS);

    // The whole point: concurrently.
    await Promise.all([processPendingEvents(), processPendingEvents()]);

    // Every one claimed…
    // `inArray`, never a JS array inside a raw fragment — it does not become a
    // postgres array and the statement is refused (this codebase's own rule).
    const left = await db
      .select({ id: events.id })
      .from(events)
      .where(and(inArray(events.id, madeIds), isNull(events.processedAt)));
    expect(left, 'no event left unprocessed').toHaveLength(0);

    // …and none of them fanned out twice. Before the claim, both drains read
    // the same rows and this came back at double.
    const perEvent = await db
      .select({ eventId: notifications.eventId, n: sql<number>`count(*)` })
      .from(notifications)
      .where(inArray(notifications.eventId, madeIds))
      .groupBy(notifications.eventId);
    // FIRST: it did something at all. Without this the count assertion below
    // is satisfied by an empty table.
    expect(perEvent.length, 'the drain created no notifications to judge').toBe(EVENTS);

    // A duplicate is a SECOND row for the same (event, person, channel). Counted
    // that way rather than against a per-event expectation, because the first
    // version compared every event to the FIRST event's count — and when both
    // drains handle everything, all of them double together and nothing stands
    // out. The measure has to be one no uniform doubling can satisfy.
    const [totals] = await db
      .select({
        rows: sql<number>`count(*)`,
        distinct: sql<number>`count(DISTINCT (${notifications.eventId}, ${notifications.userId}, ${notifications.channel}))`,
      })
      .from(notifications)
      .where(inArray(notifications.eventId, madeIds));
    expect(
      Number(totals!.rows),
      'the same event was fanned out to the same person twice',
    ).toBe(Number(totals!.distinct));
  });

  it('a claimed event is not offered to the next drain', async () => {
    await emitEvent(db, {
      type: 'PlanApproved' as DomainEventType,
      payload: { note: `drain ${STAMP} solo` },
      entityType: 'plan',
      actorId,
    });
    const [solo] = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${events.payload}->>'note' = ${`drain ${STAMP} solo`}`);
    madeIds.push(solo!.id);

    await processPendingEvents();
    const before = await db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(eq(notifications.eventId, solo!.id));

    // A second drain must find nothing to do with it.
    await processPendingEvents();
    const after = await db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(eq(notifications.eventId, solo!.id));
    expect(Number(after[0]!.n), 'a processed event was handled again').toBe(
      Number(before[0]!.n),
    );
  });
});
