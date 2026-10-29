import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { agentDrafts, agentOutbox, clients, users } from '@/modules/platform/db/schema';
import { lastQuoteFor } from '@/modules/wms/agent/context';

/**
 * What we last QUOTED a chat (review R1) is read back from the drafts he
 * approved: the flight's address stays his for as long as the flight is the
 * chat's road. Only an APPROVED draft quoted anybody, only this week's, and
 * only one whose memory names a road. The chat is this run's own peer, and
 * every row goes in `afterAll`.
 */

const PEER = 9_700_000_000n + BigInt(Date.now() % 1_000_000);
const DAY = 86_400_000;

afterAll(async () => {
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await pgClient.end();
});

describe('lastQuoteFor — the newest approved quote of the week', () => {
  it('reads the newest approved draft that names a road, and nothing a pending, rejected, old or road-less draft says', async () => {
    const [who] = await db.select({ id: users.id }).from(users).limit(1);
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
    const draft = (status: string, daysAgo: number, memory: object) => ({
      managerUserId: who!.id,
      peerId: PEER,
      anchorTgMessageId: BigInt(Math.round(daysAgo * 100)),
      status,
      policy: { memory },
      createdAt: at(daysAgo),
      ...(status === 'pending' ? {} : { decidedBy: who!.id, decidedAt: at(daysAgo) }),
    });

    expect(await lastQuoteFor(who!.id, PEER)).toBeNull();
    // Older than the week: nobody's quote any more, even with nothing newer.
    await db.insert(agentDrafts).values(draft('approved', 8, { quotedRoad: 'air', quotedAir: { kg: 99, origin: 'Old' } }));
    expect(await lastQuoteFor(who!.id, PEER)).toBeNull();
    await db.insert(agentDrafts).values([
      // An older approved truck quote, then the newer approved flight — the flight speaks.
      draft('approved', 3, { quotedRoad: 'road', quotedAir: null }),
      { ...draft('approved', 1, { quotedRoad: 'air', quotedAir: { kg: 30, origin: 'Shenzhen' } }), proposedBody: 'Avia 30 kg — 510 $.', finalBody: 'Avia: 30 kg — taxminan 510 $.' },
      // Newer, but quoted nobody: rejected, or still waiting on him, or approved with no road in its memory.
      draft('rejected', 0.5, { quotedRoad: 'road', quotedAir: null }),
      draft('pending', 0.4, { quotedRoad: 'road', quotedAir: null }),
      draft('approved', 0.3, { aviaOnly: false }),
    ]);

    let q = await lastQuoteFor(who!.id, PEER);
    // Its text is what he approved (review #1538) — the chat's copy of it is that quote's echo; he
    // rewrote it, so its words are his (#1539); nothing went out yet, so it has no Telegram id.
    expect(q).toMatchObject({ road: 'air', air: { kg: 30, origin: 'Shenzhen' }, text: 'Avia: 30 kg — taxminan 510 $.', edited: true, tgMessageId: null });
    // …and once queued, what the outbox row carries is what went to the customer.
    const [quoted] = await db.select({ id: agentDrafts.id }).from(agentDrafts).where(sql`${agentDrafts.peerId} = ${PEER.toString()}::bigint AND ${agentDrafts.finalBody} IS NOT NULL`);
    const [someone] = await db.select({ id: clients.id }).from(clients).limit(1);
    await db.insert(agentOutbox).values({
      draftId: quoted!.id,
      clientId: someone!.id,
      managerUserId: who!.id,
      peerId: PEER,
      body: 'Avia: 30 kg — taxminan 510 $. ',
      randomId: PEER * 1000n + 7n,
      answersTgMessageId: 100n,
      queuedBy: who!.id,
      tgMessageId: PEER * 1000n + 9n,
    });
    q = await lastQuoteFor(who!.id, PEER);
    expect(q?.text).toBe('Avia: 30 kg — taxminan 510 $. ');
    // …and the message it went out as, by identity.
    expect(q?.tgMessageId).toBe(PEER * 1000n + 9n);
    expect(Math.abs(q!.at.getTime() - at(1).getTime())).toBeLessThan(1000);
    // Another manager's account holds another conversation with the same peer.
    // Approved as the model wrote it: not his words.
    await db.insert(agentDrafts).values({ ...draft('approved', 0.2, { quotedRoad: 'road', quotedAir: null }), proposedBody: 'Mashina 3 kub — 640 $.', finalBody: 'Mashina 3 kub — 640 $.' });
    expect(await lastQuoteFor(who!.id, PEER)).toMatchObject({ road: 'road', edited: false, tgMessageId: null });
    const [other] = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).offset(1).limit(1);
    if (other && other.id !== who!.id) expect(await lastQuoteFor(other.id, PEER)).toBeNull();
  });
});
