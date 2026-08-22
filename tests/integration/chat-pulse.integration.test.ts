import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  leads,
  leadStages,
  tgMessages,
  tgOutbox,
  users,
} from '@/modules/platform/db/schema';
import { chatPulseForClient, chatPulseForLead } from '@/modules/wms/crm/pulse';
import { applyEdit } from '@/modules/wms/crm/telegram-accounts';
import { chatBadges } from '@/modules/wms/crm/conversations';
import { activeClientsByPhone } from '@/modules/wms/client-cabinet/service';

/**
 * The chat pulse (round 108): the token must move exactly when a thread
 * surface would draw something different. Each test here is one of the
 * design review's proven blind spots — the naive `max(sent_at)` token was
 * REFUTED on every one of them before this file existed.
 */

const SUFFIX = `${String(Date.now()).slice(-6)}${process.env.VITEST_POOL_ID ?? ''}`;
const PEER = BigInt(910000000 + (Date.now() % 1000000));

let managerA: string;
let managerB: string;
let clientX: string; // the card's client — no thread of its own
let clientY: string; // phone sibling of X — holds the thread
let leadId: string;
const madeMessages: string[] = [];
const madeAttachments: string[] = [];
let tgSeq = 1;

const sellerA = () => ({
  id: managerA,
  roles: ['sales_manager'] as const,
  permissions: new Set(['crm.leads']) as ReadonlySet<string>,
});
const sellerB = () => ({
  id: managerB,
  roles: ['sales_manager'] as const,
  permissions: new Set(['crm.leads']) as ReadonlySet<string>,
});
const vedOnly = () => ({
  id: managerB,
  roles: [] as const,
  permissions: new Set(['ved.docs']) as ReadonlySet<string>,
});

async function say(
  manager: string,
  target: { clientId?: string; leadId?: string },
  over: Partial<typeof tgMessages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(tgMessages)
    .values({
      managerUserId: manager,
      clientId: target.clientId ?? null,
      leadId: target.leadId ?? null,
      peerId: PEER,
      tgMessageId: BigInt(tgSeq++),
      direction: 'in',
      body: `pulse ${SUFFIX}`,
      sentAt: new Date(),
      ...over,
    } as typeof tgMessages.$inferInsert)
    .returning({ id: tgMessages.id, tgMessageId: tgMessages.tgMessageId });
  madeMessages.push(row!.id);
  return row!;
}

beforeAll(async () => {
  const mint = async (n: number) =>
    (
      await db
        .insert(users)
        .values({
          phone: `+99893${SUFFIX}${n}`,
          fullName: `Pulse ${n} ${SUFFIX}`,
          passwordHash: 'x',
          active: true,
        })
        .returning({ id: users.id })
    )[0]!.id;
  managerA = await mint(1);
  managerB = await mint(2);
  const mintClient = async (code: string, phones: string[]) =>
    (
      await db
        .insert(clients)
        .values({ clientCode: code, name: `Pulse mijoz ${code}`, phones })
        .returning({ id: clients.id })
    )[0]!.id;
  // One person, two codes, one number — round 32's reality. The formatted
  // spelling on Y is deliberate: the SQL prefilter must strip it.
  clientX = await mintClient(`PX${SUFFIX}`, [`+9989${SUFFIX}11`]);
  clientY = await mintClient(`PY${SUFFIX}`, [`+998 9${SUFFIX.slice(0, 2)} ${SUFFIX.slice(2)}-11`]);
  const stage = (await db.select({ id: leadStages.id }).from(leadStages).limit(1))[0]!.id;
  leadId = (
    await db
      .insert(leads)
      .values({ name: `Pulse lid ${SUFFIX}`, stageId: stage, ownerId: managerA, createdBy: managerA })
      .returning({ id: leads.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(attachments).where(inArray(attachments.id, madeAttachments));
  await db.delete(tgOutbox).where(inArray(tgOutbox.clientId, [clientX, clientY]));
  await db.delete(tgMessages).where(inArray(tgMessages.id, madeMessages));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(clients).where(inArray(clients.id, [clientX, clientY]));
  await db.delete(users).where(inArray(users.id, [managerA, managerB]));
  await pgClient.end();
});

describe('chatPulseForClient', () => {
  it('moves on a new message — and NOT on a colleague’s under the viewer fence', async () => {
    const before = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    await say(managerA, { clientId: clientY });
    const after = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(after!.t).not.toBe(before!.t);

    // Manager B writes into their OWN thread with the same client: seller A's
    // token must not move — the page A reads shows none of B's rows (#383).
    const frozen = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    await say(managerB, { clientId: clientY });
    const still = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(still!.t).toBe(frozen!.t);
  });

  it('moves on an out-of-order backfill insert (older sent_at than the max)', async () => {
    const before = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    await say(managerA, { clientId: clientY }, { sentAt: new Date(Date.now() - 86_400_000) });
    const after = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    // max(sent_at) alone would read this as «nothing new» — the reconnect
    // backfill inserts exactly this shape (round 93).
    expect(after!.t).not.toBe(before!.t);
  });

  it('moves on an EDIT — an UPDATE that changes no count and no sent_at', async () => {
    const row = await say(managerA, { clientId: clientY });
    const before = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    const touched = await applyEdit({
      managerUserId: managerA,
      peerId: PEER,
      tgMessageId: row.tgMessageId,
      body: 'corrected 1500 kg',
    });
    expect(touched).toBe(true);
    const after = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(after!.t).not.toBe(before!.t);
  });

  it('moves when a photo’s bytes land AFTER the message row', async () => {
    const row = await say(managerA, { clientId: clientY });
    const before = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    const attId = randomUUID();
    await db.insert(attachments).values({
      id: attId,
      entityType: 'tg_message',
      entityId: row.id,
      kind: 'photo',
      storageKey: `pulse-test/${SUFFIX}/${attId}`,
      fileName: 'p.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
      uploadedBy: managerA,
    });
    madeAttachments.push(attId);
    const after = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(after!.t).not.toBe(before!.t);
  });

  it('sees every outbox transition: queued→failed, dismiss+re-queue, the stuck clock', async () => {
    const queue = async (over: Partial<typeof tgOutbox.$inferInsert> = {}) =>
      (
        await db
          .insert(tgOutbox)
          .values({
            clientId: clientY,
            managerUserId: managerA,
            peerId: PEER,
            body: `out ${SUFFIX}`,
            queuedBy: managerA,
            ...over,
          } as typeof tgOutbox.$inferInsert)
          .returning({ id: tgOutbox.id })
      )[0]!.id;

    const empty = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    const first = await queue();
    const queued = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(queued!.t).not.toBe(empty!.t);
    expect(queued!.fast).toBe(true);

    // queued → failed: the TOTAL of watched rows is unchanged — one combined
    // count reads it as «nothing happened» while the red ✕ appears.
    await db.update(tgOutbox).set({ status: 'failed' }).where(eq(tgOutbox.id, first));
    const failed = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(failed!.t).not.toBe(queued!.t);
    // A failed row must NOT hold the fast beat — that pin was the round's
    // headline defect.
    expect(failed!.fast).toBe(false);

    // Dismiss + a new message queued inside one poll window: counts can net
    // out; max(queued_at) must carry it.
    await db.delete(tgOutbox).where(eq(tgOutbox.id, first));
    await queue({ status: 'failed' });
    const swapped = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(swapped!.t).not.toBe(failed!.t);

    // The wall clock: a claimed row crossing the five-minute line writes
    // nothing, and the round-48 alarm still has to draw. The row is born
    // BELOW the threshold and OLDER than the failed row above, so pushing
    // it across the line leaves max(queued_at) — the failed row's — where
    // it was: the stuck bucket is the only term that can differ. (This
    // proof's first fixture updated a fresh row, and the moving max masked
    // the strip — #166: a red proof that will not go red is evidence about
    // the fixture.)
    const slow = await queue({
      status: 'sending',
      queuedAt: sql`now() - interval '4 minutes'` as unknown as Date,
    });
    const young = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    await db
      .update(tgOutbox)
      .set({ queuedAt: sql`now() - interval '6 minutes'` })
      .where(eq(tgOutbox.id, slow));
    const stuck = await chatPulseForClient(sellerA(), clientY, { sibling: false });
    expect(stuck!.t).not.toBe(young!.t);
  });

  it('the card resolves the phone SIBLING per tick (round 32 in the poller)', async () => {
    // Card X holds no thread; the person's other code Y does. The sibling
    // walk must find it — and a message on Y must move X's card token.
    const viaCard = await chatPulseForClient(sellerA(), clientX, { sibling: true });
    expect(viaCard!.t.startsWith(`${clientY}||`)).toBe(true);
    await say(managerA, { clientId: clientY });
    const after = await chatPulseForClient(sellerA(), clientX, { sibling: true });
    expect(after!.t).not.toBe(viaCard!.t);
  });
});

describe('chatPulseForLead', () => {
  it('answers the owner and refuses everyone the lead card refuses', async () => {
    await say(managerA, { leadId });
    const own = await chatPulseForLead(sellerA(), leadId);
    expect(own).not.toBeNull();
    // A colleague without view_all cannot open this lead card — the pulse
    // must not narrate its conversation either (#514).
    expect(await chatPulseForLead(sellerB(), leadId)).toBeNull();
    // A bare ved.docs grant passes canReadTg and opens NO lead card.
    expect(await chatPulseForLead(vedOnly(), leadId)).toBeNull();
  });
});

describe('round 108’s two other fences', () => {
  it('chatBadges bounded to the board’s clients answers ONLY about them', async () => {
    // Own fixture, not the other tests' leftovers — under vitest's -t filter
    // this file's siblings never ran, and a test that borrows their rows
    // goes red for fixture reasons, which is how this round's first red
    // proof lied (#166).
    await say(managerA, { clientId: clientY });
    const viewer = { id: managerA, all: true };
    const bounded = await chatBadges(viewer, [clientX]);
    // clientY holds rows; the board that asked only about X must not get Y.
    expect(bounded.has(clientY)).toBe(false);
    const asked = await chatBadges(viewer, [clientY]);
    expect(asked.has(clientY)).toBe(true);
    expect(await chatBadges(viewer, [])).toEqual(new Map());
  });

  it('activeClientsByPhone still matches a FORMATTED stored phone', async () => {
    // Y's stored spelling carries spaces and a dash; the SQL prefilter strips
    // to digits, or this person vanishes from every sibling walk.
    const found = await activeClientsByPhone(`+9989${SUFFIX}11`);
    const ids = found.map((c) => c.id);
    expect(ids).toContain(clientX);
    expect(ids).toContain(clientY);
  });
});
