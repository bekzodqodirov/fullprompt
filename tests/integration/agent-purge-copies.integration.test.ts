import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { agentConversations, agentDrafts, notifications, tgChatRules, users } from '@/modules/platform/db/schema';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { agentPress } from '@/modules/wms/agent/bot-door';
import { refreshAgentCard } from '@/modules/wms/agent/card-io';
import { purgeAgentChat, PURGED_CARD_TEXT } from '@/modules/wms/agent/purge';

/**
 * The purge's Telegram half runs OFF the request (review I5): the web tray's
 * «Qo'shma» awaits `purgeAgentChat` before it deletes the customer's
 * messages, and editing every sent card copy one by one — each with a
 * 10-second deadline — on a day Telegram is slow was a button that hung
 * while the text it was meant to remove was still stored.
 *
 * The transport is a fake that HOLDS every call until released, so «did the
 * purge wait for Telegram» is a deterministic question. Everything is this
 * file's own: one user, one peer, chat ids starting `97<stamp>`.
 */

const STAMP = String(Date.now()).slice(-7);
const PEER = BigInt(`97${STAMP}`);
const CHAT = Number(`97${STAMP}1`);
let userId = '';
let ruleId = '';
/** The rules the in-flight cases add, beside the purge's one. */
const moreRules: string[] = [];
const savedToken = process.env.TELEGRAM_BOT_TOKEN;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99897${STAMP}11`, fullName: `Tozalash ${STAMP}`, passwordHash: 'x' })
    .returning({ id: users.id });
  userId = u!.id;
  const [r] = await db
    .insert(tgChatRules)
    .values({ managerUserId: userId, peerId: PEER, peerTitle: 'Notanish', peerPhone: '+998901112233' })
    .returning({ id: tgChatRules.id });
  ruleId = r!.id;
  process.env.TELEGRAM_BOT_TOKEN = '7000003:TEST';
});

afterAll(async () => {
  __setTelegramTransport(null);
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(agentDrafts).where(eq(agentDrafts.managerUserId, userId));
  await db.delete(agentConversations).where(eq(agentConversations.managerUserId, userId));
  await db.delete(tgChatRules).where(inArray(tgChatRules.id, [ruleId, ...moreRules]));
  await db.update(users).set({ active: false }).where(eq(users.id, userId));
});

describe('the purge never waits on Telegram (review I5)', () => {
  it('returns while the copies’ edits are still in flight — and the edits, once through, carry no buttons', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const edits: Record<string, unknown>[] = [];
    __setTelegramTransport(async (url, init) => {
      if (url.endsWith('/editMessageText')) edits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      await gate;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    for (const messageId of [101, 102]) {
      await db.insert(notifications).values({
        userId,
        channel: 'telegram',
        type: 'AgentStranger',
        status: 'sent',
        sentAt: new Date(),
        payload: { text: `Mijoz: «yukim qayerda» ${STAMP}`, ruleId, tg: { chatId: CHAT, messageId } },
      });
    }

    const outcome = await Promise.race([
      purgeAgentChat(userId, PEER).then(() => 'returned' as const),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3_000)),
    ]);
    expect(outcome).toBe('returned');
    // The database half is done by then: the cards are blank.
    const rows = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'ruleId' = ${ruleId}`));
    expect(rows.map((r) => (r.payload as { text: string }).text)).toEqual([PURGED_CARD_TEXT, PURGED_CARD_TEXT]);

    release();
    await vi.waitFor(() => expect(edits).toHaveLength(2), { timeout: 5_000 });
    for (const body of edits) {
      expect(String(body.text)).toContain('Suhbat shaxsiy deb o‘chirildi');
      expect(body.reply_markup).toBeUndefined();
    }
  });
});

/**
 * A writer that closes or re-renders a card READS the row, then writes it —
 * and the drain may merge the sent copy's `tg` in between (after its own
 * after-send re-read found the card still as it sent it). An edit built from
 * the READ payload carries no `tg` and skips the copy; the drain does not look
 * again; nobody corrects it (cards review). The write's own RETURNING carries
 * the merged `tg`. The interleaving is made deterministic by holding the
 * drain's merge open on a connection of its own until the writer's UPDATE is
 * seen waiting on it (`pg_stat_activity` through the pool, #1171's observer).
 */
describe('a card closed while its copy is in flight is edited by the writer once the drain’s `tg` lands under it (cards review)', () => {
  /** The drain's merge of the sent copy's `tg`, held open; `land()` commits it once the writer waits on it. */
  async function heldMerge(notificationId: string, tg: { chatId: number; messageId: number }) {
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', { max: 1, onnotice: () => {} });
    const held = await helper.reserve();
    await held`BEGIN`;
    // `::text` first: a bare jsonb parameter would be the STRING of this JSON, and `||` would make an array.
    await held`UPDATE notifications SET status = 'sent', payload = payload || ${JSON.stringify({ tg })}::text::jsonb WHERE id = ${notificationId}`;
    return {
      async land() {
        let waiting = false;
        for (let i = 0; i < 250 && !waiting; i += 1) {
          const rows = await db.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query ILIKE '%update "notifications"%' AND pid <> pg_backend_pid()`);
          waiting = Number(rows[0]?.n ?? 0) > 0;
          if (!waiting) await new Promise((r) => setTimeout(r, 20));
        }
        await held`COMMIT`;
        held.release();
        await helper.end();
        return waiting;
      },
    };
  }

  function recordEdits(): Record<string, unknown>[] {
    const edits: Record<string, unknown>[] = [];
    __setTelegramTransport(async (url, init) => {
      if (url.endsWith('/editMessageText')) edits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    return edits;
  }

  it('a draft card re-rendered: its copy is edited to the new words', async () => {
    const edits = recordEdits();
    const [d] = await db
      .insert(agentDrafts)
      .values({ managerUserId: userId, peerId: BigInt(`${PEER}2`), anchorTgMessageId: 1n, proposedBody: `Yuk yo‘lda ${STAMP}`, status: 'rejected' })
      .returning({ id: agentDrafts.id });
    const [n] = await db
      .insert(notifications)
      .values({ userId, channel: 'telegram', type: 'AgentDraft', status: 'sending', payload: { draftId: d!.id, text: `eski karta ${STAMP}` } })
      .returning({ id: notifications.id });
    const merge = await heldMerge(n!.id, { chatId: CHAT, messageId: 201 });
    const refreshing = refreshAgentCard(d!.id);
    expect(await merge.land(), 'the writer never reached the row').toBe(true);
    await refreshing;
    expect(edits.map((e) => e.message_id)).toEqual([201]);
    expect(String(edits[0]!.text)).toContain('Rad etildi');
  });

  it('a stranger card closed by «🚫 Shaxsiy»: its copy is edited, with no buttons left', async () => {
    const edits = recordEdits();
    const [r] = await db
      .insert(tgChatRules)
      .values({ managerUserId: userId, peerId: BigInt(`${PEER}3`), peerTitle: 'Notanish', peerPhone: '+998901112244' })
      .returning({ id: tgChatRules.id });
    moreRules.push(r!.id);
    const [n] = await db
      .insert(notifications)
      .values({ userId, channel: 'telegram', type: 'AgentStranger', status: 'sending', payload: { ruleId: r!.id, text: `Notanish yozdi ${STAMP}` } })
      .returning({ id: notifications.id });
    const merge = await heldMerge(n!.id, { chatId: CHAT, messageId: 202 });
    const pressing = agentPress(userId, 'x', r!.id, undefined);
    expect(await merge.land(), 'the close never reached the row').toBe(true);
    expect((await pressing).toast).toContain('Shaxsiy');
    expect(edits.map((e) => e.message_id)).toEqual([202]);
    expect(String(edits[0]!.text)).toContain('Shaxsiy deb belgilandi');
    expect(edits[0]!.reply_markup).toBeUndefined();
  });
});
