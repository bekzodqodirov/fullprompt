import type PgBoss from 'pg-boss';
import { and, count as countRows, eq, isNotNull, isNull, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { priceChannelChats, priceChannelMembers } from '../db/schema';
import { logger } from '../logger';
import { writeAudit, type AuditContext } from '../audit/service';
import { SETTINGS_AUDIT_ID } from '../settings/service';
import { usersWithPermission } from '../notifications/service';
import { canLogInSql } from '../users/login';
import { enqueue } from '../jobs/boss';
import { botCall, sendText } from './send';
import {
  decideAdoption,
  decideJoin,
  decideMemberUpdate,
  decideVet,
  type PauseReason,
  type RemoveReason,
  type VetVerdict,
} from './price-channel-rules';

/**
 * The staff's PRICE CHANNEL (the owner's F, 2026-10-07) — which channel it
 * is, who may be in it, and the bot's side of both.
 *
 * The channel is a ROW, not a setting: the `price_channel_chats` row with
 * `connected_at` set (0128's partial UNIQUE index allows one). /admin/settings
 * renders every key as an editable input behind only its validator, so a
 * setting would be a third door that skips every check below (#531); this file
 * is the ONLY writer of `connected_at` (pinned by price-channel-wire.test.ts).
 *
 * Membership is one rule asked twice (#513): `channelEligibleSql` is the
 * fragment both the admission (`eligibleForChannel`) and the eviction sweep
 * read, so the day «who is a colleague» narrows, the door and the broom move
 * together.
 */

export type ConnectedChannel = typeof priceChannelChats.$inferSelect;

/** THE channel, or null. */
export async function connectedChannel(): Promise<ConnectedChannel | null> {
  const [row] = await db.select().from(priceChannelChats).where(isNotNull(priceChannelChats.connectedAt)).limit(1);
  return row ?? null;
}

/** THE channel's chat id as a string (a -100… id does not fit a JS number safely), or null. */
export async function channelChatId(): Promise<string | null> {
  const row = await connectedChannel();
  return row ? row.chatId.toString() : null;
}

/**
 * WHO MAY BE IN THE CHANNEL — the one fragment (F8 a: «faqat tizimda faol va
 * botga ulangan xodim»). A colleague who can sign in now (`canLogInSql`, never
 * `.active`), whose staff link is live, and whose linked chat IS this Telegram
 * user (in a private chat the chat id is the user id). Neither door restates
 * the clauses and neither calls `staffForChat`.
 */
export function channelEligibleSql(userAlias: string, linkAlias: string, tgUserId: SQL): SQL {
  const l = sql.identifier(linkAlias);
  return sql`(${canLogInSql(userAlias)} AND ${l}.status = 'linked' AND ${l}.telegram_chat_id = ${tgUserId})`;
}

/** The colleague behind a Telegram user, when the rule admits them. */
export async function eligibleForChannel(tgUserId: bigint): Promise<{ userId: string; fullName: string } | null> {
  const rows = await db.execute<{ id: string; full_name: string }>(sql`
    SELECT u.id::text AS id, u.full_name
      FROM telegram_links l
      JOIN users u ON u.id = l.user_id
     WHERE ${channelEligibleSql('u', 'l', sql`${tgUserId.toString()}::bigint`)}
     LIMIT 1`);
  const row = rows[0];
  return row ? { userId: row.id, fullName: row.full_name } : null;
}

/** The bot's own Telegram id — the token's prefix, so no getMe is needed to recognise itself. */
function botUserId(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const id = token.split(':')[0];
  return id && /^\d+$/.test(id) ? id : null;
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
}

interface TgChatMember {
  status: string;
  user: TgUser;
  is_member?: boolean;
  [flag: string]: unknown;
}

function fullName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || String(u.id);
}

const RIGHT_KEYS = ['can_post_messages', 'can_edit_messages', 'can_invite_users', 'can_restrict_members'];

export type VetResult = { ok: true } | { ok: false; verdict: VetVerdict; detail?: string };

/**
 * Is this channel safe to post prices into? Three reads through the one
 * sender, a pure verdict (`decideVet`), and the result written on the chat's
 * row either way so the panel can say it in words. A definitive refusal also
 * clears `vetted_at` (the panel's «last check refused»); a call that merely
 * failed leaves it, because a network blip is not a fact about the channel.
 *
 * Every definitive answer — whoever asked (the connect, the bot's update, the
 * panel's «Qayta tekshirish», the drain) — is also the drain's memo, so a
 * refusal heard anywhere stops the drain at once instead of waiting out a
 * ten-minute-old «ok».
 */
export async function vetChannel(chatId: string, now = Date.now()): Promise<VetResult> {
  const chat = await botCall('getChat', { chat_id: chatId }, 10_000);
  const admins = chat.ok ? await botCall('getChatAdministrators', { chat_id: chatId }, 10_000) : null;
  const count = admins?.ok ? await botCall('getChatMemberCount', { chat_id: chatId }, 10_000) : null;
  const failed = [chat, admins, count].find((a) => a && !a.ok);
  if (!chat.ok || !admins?.ok || !count?.ok) {
    const detail = failed?.description ?? 'unknown';
    await db
      .update(priceChannelChats)
      .set({ lastError: `vet_failed:${detail}`, updatedAt: new Date() })
      .where(eq(priceChannelChats.chatId, BigInt(chatId)));
    return { ok: false, verdict: 'vet_failed', detail };
  }
  const info = chat.result as { title?: string; username?: string; linked_chat_id?: number } | null;
  const list = (Array.isArray(admins.result) ? admins.result : []) as TgChatMember[];
  const me = botUserId();
  const bot = list.find((a) => String(a.user.id) === me) ?? null;
  const rights: Record<string, boolean> = {};
  for (const key of RIGHT_KEYS) rights[key] = bot?.status === 'creator' || bot?.[key] === true;
  const humanAdmins = list.filter((a) => !a.user.is_bot).map((a) => fullName(a.user));
  const memberCount = typeof count.result === 'number' ? count.result : 0;
  // The subscribers the bot let in — minus anybody now on the ADMIN list: an
  // admitted colleague later promoted is counted in `adminCount` already, and
  // counting him twice would let one unchecked subscriber pass unseen.
  const adminIds = list.map((a) => BigInt(a.user.id));
  const [live] = await db
    .select({ n: countRows() })
    .from(priceChannelMembers)
    .where(
      and(
        eq(priceChannelMembers.chatId, BigInt(chatId)),
        isNull(priceChannelMembers.removedAt),
        adminIds.length > 0 ? notInArray(priceChannelMembers.tgUserId, adminIds) : undefined,
      ),
    );
  const decision = decideVet({
    username: info?.username ?? null,
    linkedChatId: typeof info?.linked_chat_id === 'number' ? info.linked_chat_id : null,
    memberCount,
    adminCount: list.length,
    botCanPost: rights.can_post_messages === true,
    liveMembers: Number(live?.n ?? 0),
  });
  const ok = decision.verdict === 'ok';
  await db
    .update(priceChannelChats)
    .set({
      title: info?.title ?? undefined,
      username: info?.username ?? null,
      rights,
      admins: humanAdmins,
      memberCount,
      vettedAt: ok ? new Date() : null,
      lastError: ok ? null : decision.verdict === 'has_members' ? `has_members:${decision.count}` : decision.verdict,
      updatedAt: new Date(),
    })
    .where(eq(priceChannelChats.chatId, BigInt(chatId)));
  const result: VetResult = ok
    ? { ok: true }
    : {
        ok: false,
        verdict: decision.verdict,
        ...(decision.verdict === 'has_members' ? { detail: String(decision.count) } : {}),
      };
  vetMemo = { chatId, checkedAt: now, result };
  return result;
}

/**
 * The drain's re-vet — at most once per ten minutes per process, and it is the
 * ONLY thing that decides whether a channel is clean now: a channel switched
 * to public, a discussion group linked, a stranger subscribed — none of them
 * sends an update — are caught here, and so is the day the owner FIXES one of
 * them (the drain does not pause for ever on the row's last verdict). A refusal
 * is remembered for the same ten minutes, which is the rate limit on asking
 * Telegram. An «ok» is trusted only while the row agrees (`rowSaysClean`): a
 * refusal written by a vet in another process ends it at once. A call that
 * merely failed is not remembered, so the next run asks again.
 */
let vetMemo: { chatId: string; checkedAt: number; result: VetResult } | null = null;

export const VET_MEMO_MS = 10 * 60_000;

export async function vetForDrain(chatId: string, now = Date.now(), rowSaysClean = true): Promise<VetResult> {
  const fresh = vetMemo && vetMemo.chatId === chatId && now - vetMemo.checkedAt < VET_MEMO_MS;
  if (fresh && vetMemo && (!vetMemo.result.ok || rowSaysClean)) return vetMemo.result;
  const result = await vetChannel(chatId, now);
  if (!result.ok && result.verdict === 'vet_failed') vetMemo = null;
  return result;
}

/** Tests only: forget the drain's vet. */
export function __resetVetMemo(): void {
  vetMemo = null;
}

/**
 * What stops the drain before it asks Telegram anything: no token, a bot that
 * is no longer the channel's admin (an update tells us), and who connected the
 * channel no longer being a settings admin — every door passes through the
 * drain, so the drain re-checks the authority rather than trusting whoever
 * wrote the row. Pure over the row.
 *
 * Deliberately NOT here: the row's last vet (`username`, `vetted_at`). A pause
 * read from the row would be a pause nothing could lift — the drain would stop
 * before its re-vet, and the re-vet is what notices the owner fixed it.
 */
export function staticPause(o: {
  hasToken: boolean;
  row: Pick<ConnectedChannel, 'status' | 'connectedByUserId'>;
  settingsAdminIds: string[];
}): PauseReason | null {
  if (!o.hasToken) return 'no_bot';
  if (o.row.status !== 'administrator' && o.row.status !== 'creator') return 'bot_removed';
  if (!o.row.connectedByUserId || !o.settingsAdminIds.includes(o.row.connectedByUserId)) return 'connector_gone';
  return null;
}

/**
 * The panel's pause — the drain's static rule, then the LAST vet's verdict as
 * the row recorded it (the panel does no live vet; its sentence says the bot
 * re-checks by itself).
 */
export function panelPause(o: Parameters<typeof staticPause>[0] & {
  row: Pick<ConnectedChannel, 'username' | 'vettedAt'>;
}): PauseReason | null {
  const pause = staticPause(o);
  if (pause) return pause;
  if (o.row.username) return 'public';
  if (!o.row.vettedAt) return 'not_vetted';
  return null;
}

/** Whether the row's last vet was clean — the condition under which the drain trusts its «ok» memo. */
export function rowSaysClean(row: Pick<ConnectedChannel, 'username' | 'vettedAt'>): boolean {
  return !row.username && row.vettedAt !== null;
}

/** A vet refusal, as the drain's pause. */
export function pauseForVet(v: VetVerdict): PauseReason {
  return v === 'public' ? 'public' : 'not_vetted';
}

/** The new invite link: a JOIN-REQUEST link (F8 a), so the bot decides every entry. */
export async function createJoinLink(chatId: string): Promise<{ ok: true } | { ok: false; error: 'no_invite_right' | 'telegram'; detail: string }> {
  const answer = await botCall(
    'createChatInviteLink',
    { chat_id: chatId, name: 'GSR xodimlari', creates_join_request: true },
    10_000,
  );
  const link = (answer.result as { invite_link?: string } | null)?.invite_link;
  if (!answer.ok || !link) {
    const error = /right|admin|permission/i.test(answer.description) ? 'no_invite_right' : 'telegram';
    return { ok: false, error, detail: answer.description };
  }
  await db
    .update(priceChannelChats)
    .set({ inviteLink: link, updatedAt: new Date() })
    .where(eq(priceChannelChats.chatId, BigInt(chatId)));
  return { ok: true };
}

/**
 * Revoke the channel's PRIMARY link — every private channel has one that
 * admits WITHOUT a request. `exportChatInviteLink` mints a new primary and
 * revokes the old; the new one is discarded, and the panel says only the
 * bot's link is to be shared.
 */
export async function revokePrimaryLink(chatId: string): Promise<boolean> {
  const answer = await botCall('exportChatInviteLink', { chat_id: chatId }, 10_000);
  if (!answer.ok) logger.warn({ chatId, description: answer.description }, '[price-channel] primary link not revoked');
  return answer.ok;
}

export type ConnectError =
  | 'not_found'
  | 'bot_not_admin'
  | 'no_invite_right'
  | 'telegram'
  | 'public'
  | 'has_discussion'
  | 'has_members'
  | 'vet_failed'
  | 'already_connected';

/**
 * Connect a recorded channel — the ONE writer of `connected_at`, used by the
 * bot's adoption and by «Shu kanalni ulash». The row must exist with the bot
 * as administrator and the vet must say ok; then one transaction moves the
 * connection, audited on the settings record like any configuration change.
 * The invite link and the primary-link revocation follow the commit: a refused
 * link does not undo the connection, it is reported (the panel says it).
 */
export async function connectChannel(
  chatId: string,
  ctx: AuditContext,
): Promise<{ ok: true } | { ok: false; error: ConnectError; detail?: string }> {
  if (!ctx.actorId) return { ok: false, error: 'not_found' };
  const [row] = await db.select().from(priceChannelChats).where(eq(priceChannelChats.chatId, BigInt(chatId))).limit(1);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.connectedAt) return { ok: false, error: 'already_connected' };
  if (row.status !== 'administrator' && row.status !== 'creator') return { ok: false, error: 'bot_not_admin' };
  const vet = await vetChannel(chatId);
  if (!vet.ok) return { ok: false, error: vet.verdict, detail: vet.detail };
  const before = await channelChatId();
  const actorId = ctx.actorId;
  await db.transaction(async (tx) => {
    await tx
      .update(priceChannelChats)
      .set({ connectedAt: null, connectedByUserId: null, updatedAt: new Date() })
      .where(and(isNotNull(priceChannelChats.connectedAt), ne(priceChannelChats.chatId, BigInt(chatId))));
    await tx
      .update(priceChannelChats)
      .set({ connectedAt: new Date(), connectedByUserId: actorId, updatedAt: new Date() })
      .where(eq(priceChannelChats.chatId, BigInt(chatId)));
    await writeAudit(tx, ctx, {
      entityType: 'settings',
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      before: { priceChannel: before },
      after: { priceChannel: chatId },
    });
  });
  __resetVetMemo();
  const link = await createJoinLink(chatId);
  await revokePrimaryLink(chatId);
  if (!link.ok) return { ok: false, error: link.error, detail: link.detail };
  return { ok: true };
}

/**
 * «Qayta tekshirish» — the connected channel vetted now, on a person's press,
 * instead of at the drain's next ten-minute re-vet. The answer is the vet's
 * own, and it is the drain's memo from here on (`vetChannel`).
 */
export async function recheckChannel(): Promise<VetResult | null> {
  const chatId = await channelChatId();
  if (!chatId) return null;
  return vetChannel(chatId);
}

/** «Uzish» — no channel; new prices are skipped `no_channel` until one is connected again. */
export async function disconnectChannel(ctx: AuditContext): Promise<void> {
  const before = await channelChatId();
  if (!before) return;
  await db.transaction(async (tx) => {
    await tx
      .update(priceChannelChats)
      .set({ connectedAt: null, connectedByUserId: null, updatedAt: new Date() })
      .where(isNotNull(priceChannelChats.connectedAt));
    await writeAudit(tx, ctx, {
      entityType: 'settings',
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      before: { priceChannel: before },
      after: { priceChannel: null },
    });
  });
  __resetVetMemo();
}

/** The bot's status in a chat changed (`my_chat_member`) — the shape this file reads. */
export interface MyChatMemberUpdate {
  chat: { id: number; type: string; title?: string; username?: string };
  from: { id: number };
  new_chat_member: { status: string };
}

/**
 * Adoption: Telegram tells us when he makes the bot an administrator of a
 * channel. Only a SETTINGS ADMIN who is a linked, active colleague may make a
 * channel known (`decideAdoption`); anything else writes nothing — anybody in
 * the world can add a bot to their own channel, and the panel must never offer
 * a stranger's. A channel we already know hears every later change whoever
 * made it (a demotion must not be missed).
 */
export async function recordChatMembership(update: MyChatMemberUpdate): Promise<'adopted' | 'recorded' | 'updated' | 'ignored'> {
  const chatId = String(update.chat.id);
  const [row] = await db.select().from(priceChannelChats).where(eq(priceChannelChats.chatId, BigInt(chatId))).limit(1);
  const connected = await connectedChannel();
  const adder = await eligibleForChannel(BigInt(update.from.id));
  const settingsAdmins = adder ? await usersWithPermission('admin.settings.manage') : [];
  const verdict = decideAdoption({
    chatType: update.chat.type,
    newStatus: update.new_chat_member.status,
    rowExists: !!row,
    hasConnected: connected !== null,
    adderIsSettingsAdmin: adder !== null && settingsAdmins.includes(adder.userId),
  });
  if (verdict === 'ignore') {
    if (update.chat.type === 'channel') logger.info({ chatId }, '[price-channel] ignored a channel from a non-admin');
    return 'ignored';
  }
  const status = update.new_chat_member.status;
  if (verdict === 'update') {
    await db
      .update(priceChannelChats)
      .set({
        status,
        title: update.chat.title ?? row!.title,
        username: update.chat.username ?? null,
        updatedAt: new Date(),
      })
      .where(eq(priceChannelChats.chatId, BigInt(chatId)));
    if (row!.status !== status) {
      // The bot left and came back (or was demoted and re-promoted) — by
      // anybody, a seller included. Whatever the old vet said is about a
      // channel the bot could not see in between: forget it, and when the bot
      // can post again, vet NOW (a refusal is the drain's memo at once).
      __resetVetMemo();
      if (status === 'administrator' || status === 'creator') await vetChannel(chatId);
    }
    return 'updated';
  }
  await db
    .insert(priceChannelChats)
    .values({
      chatId: BigInt(chatId),
      title: update.chat.title ?? '',
      username: update.chat.username ?? null,
      status,
      addedByUserId: adder!.userId,
    })
    .onConflictDoUpdate({
      target: priceChannelChats.chatId,
      set: { status, title: update.chat.title ?? '', username: update.chat.username ?? null, updatedAt: new Date() },
    });
  if (verdict === 'record') {
    await vetChannel(chatId);
    return 'recorded';
  }
  const done = await connectChannel(chatId, { actorId: adder!.userId });
  if (!done.ok) logger.warn({ chatId, error: done.error }, '[price-channel] adopted channel not connected');
  return done.ok || done.error === 'no_invite_right' || done.error === 'telegram' ? 'adopted' : 'recorded';
}

/** The join-request shape this file reads. */
export interface JoinRequestUpdate {
  chat: { id: number };
  from: TgUser;
  user_chat_id: number;
}

const WELCOME = '✅ Narx kanaliga qabul qilindingiz.';
const DECLINED =
  '❌ Bu kanal faqat GSR LOGISTICS xodimlari uchun. Xodim bo‘lsangiz, avval botga /hodim orqali ulaning, keyin havolani qayta bosing.';

async function admitMember(chatId: string, tgUserId: string, userId: string): Promise<void> {
  await db
    .insert(priceChannelMembers)
    .values({ chatId: BigInt(chatId), tgUserId: BigInt(tgUserId), userId })
    .onConflictDoUpdate({
      target: [priceChannelMembers.chatId, priceChannelMembers.tgUserId],
      set: { userId, approvedAt: new Date(), removedAt: null, removeReason: null, lastError: null },
    });
}

/**
 * A join request through the bot's link — approved for a colleague, declined
 * for anybody else, and told either way: a silent decline is the «bot looks
 * alive and does nothing» silence of rounds 89/97.
 */
export async function answerJoinRequest(req: JoinRequestUpdate): Promise<'approved' | 'declined' | 'ignored'> {
  const chatId = String(req.chat.id);
  const configured = await channelChatId();
  const eligible = await eligibleForChannel(BigInt(req.from.id));
  const verdict = decideJoin({ chatId, configuredChatId: configured, eligible });
  if (verdict.act === 'ignore') return 'ignored';
  if (verdict.act === 'approve') {
    const answer = await botCall('approveChatJoinRequest', { chat_id: chatId, user_id: req.from.id }, 10_000);
    if (!answer.ok && !/USER_ALREADY_PARTICIPANT/i.test(answer.description)) {
      logger.warn({ chatId, description: answer.description }, '[price-channel] join approval refused');
      return 'ignored';
    }
    await admitMember(chatId, String(req.from.id), verdict.userId);
    await sendText({ chatId: req.user_chat_id, text: WELCOME }).catch(() => {});
    return 'approved';
  }
  const answer = await botCall('declineChatJoinRequest', { chat_id: chatId, user_id: req.from.id }, 10_000);
  if (!answer.ok) logger.warn({ chatId, description: answer.description }, '[price-channel] join decline refused');
  await sendText({ chatId: req.user_chat_id, text: DECLINED }).catch(() => {});
  return 'declined';
}

/** Ban, then unban only-if-banned — REMOVED but able to request again through the same gate. */
async function removeFromChannel(chatId: string, tgUserId: string): Promise<{ ok: boolean; status: number; description: string }> {
  const ban = await botCall('banChatMember', { chat_id: chatId, user_id: Number(tgUserId), revoke_messages: false }, 10_000);
  if (!ban.ok) return { ok: false, status: ban.status, description: ban.description };
  const unban = await botCall('unbanChatMember', { chat_id: chatId, user_id: Number(tgUserId), only_if_banned: true }, 10_000);
  if (!unban.ok) logger.warn({ chatId, description: unban.description }, '[price-channel] unban after removal refused');
  return { ok: true, status: ban.status, description: '' };
}

/** A `chat_member` update — the shape this file reads. */
export interface ChatMemberUpdate {
  chat: { id: number };
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
}

/** Everybody who becomes a member is checked — whichever door they came through. */
export async function answerMemberUpdate(update: ChatMemberUpdate): Promise<'admitted' | 'evicted' | 'left' | 'ignored'> {
  const chatId = String(update.chat.id);
  const target = update.new_chat_member.user;
  const configured = await channelChatId();
  const targetIsSelf = String(target.id) === botUserId();
  const eligible = target.is_bot ? null : await eligibleForChannel(BigInt(target.id));
  const verdict = decideMemberUpdate({
    chatId,
    configuredChatId: configured,
    targetIsBot: target.is_bot === true,
    targetIsSelf,
    oldStatus: update.old_chat_member.status,
    newStatus: update.new_chat_member.status,
    isMember: typeof update.new_chat_member.is_member === 'boolean' ? update.new_chat_member.is_member : undefined,
    eligible,
  });
  if (verdict === 'ignore') return 'ignored';
  if (verdict === 'admit') {
    await admitMember(chatId, String(target.id), eligible!.userId);
    return 'admitted';
  }
  if (verdict === 'evict') {
    const done = await removeFromChannel(chatId, String(target.id));
    // Logged, not stored: there is no `users` row to point a member row at.
    logger.warn({ chatId, tgUserId: target.id, ok: done.ok }, '[price-channel] removed a non-staff member');
    return 'evicted';
  }
  await db
    .update(priceChannelMembers)
    .set({ removedAt: new Date(), removeReason: 'left' })
    .where(
      and(
        eq(priceChannelMembers.chatId, BigInt(chatId)),
        eq(priceChannelMembers.tgUserId, BigInt(target.id)),
        isNull(priceChannelMembers.removedAt),
      ),
    );
  return 'left';
}

/**
 * The eviction sweep (F8 a: «hodim ishdan ketsa bot chiqaradi») — every live
 * member row, of ANY channel (a person admitted to an old channel A is removed
 * from A too), whose person the ONE rule no longer admits. The CASE only
 * labels a row the fragment already decided.
 */
export async function sweepPriceChannelMembers(): Promise<{ removed: number; failed: number }> {
  const rows = await db.execute<{ chat_id: string; tg_user_id: string; user_id: string; reason: RemoveReason }>(sql`
    SELECT m.chat_id::text AS chat_id, m.tg_user_id::text AS tg_user_id, m.user_id::text AS user_id,
           CASE WHEN NOT ${canLogInSql('u')} THEN 'inactive'
                WHEN l.user_id IS NULL OR l.status <> 'linked' THEN 'unlinked'
                ELSE 'relinked' END AS reason
      FROM price_channel_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN telegram_links l ON l.user_id = m.user_id
      LEFT JOIN price_channel_chats c ON c.chat_id = m.chat_id
     WHERE m.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM telegram_links l2 JOIN users u2 ON u2.id = l2.user_id
                        WHERE u2.id = m.user_id AND ${channelEligibleSql('u2', 'l2', sql`m.tg_user_id`)})
     -- The connected channel first, rows that never failed before rows that
     -- did: removals that fail for ever (an old channel the bot was kicked
     -- from) must never fill the batch ahead of a leaver in the live one.
     ORDER BY (c.connected_at IS NOT NULL) DESC, (m.last_error IS NOT NULL), m.approved_at
     LIMIT 50`);
  let removed = 0;
  let failed = 0;
  for (const r of rows) {
    const done = await removeFromChannel(r.chat_id, r.tg_user_id);
    const where = and(
      eq(priceChannelMembers.chatId, BigInt(r.chat_id)),
      eq(priceChannelMembers.tgUserId, BigInt(r.tg_user_id)),
    );
    if (done.ok) {
      await db
        .update(priceChannelMembers)
        .set({ removedAt: new Date(), removeReason: r.reason, lastError: null })
        .where(where);
      removed += 1;
      continue;
    }
    failed += 1;
    await db.update(priceChannelMembers).set({ lastError: done.description }).where(where);
    if (done.status === 429 || done.status === 401 || done.status === 404 || done.description === 'no_bot_token') break;
  }
  if (removed + failed > 0) logger.info({ removed, failed }, '[price-channel] member sweep');
  return { removed, failed };
}

export const JOB_PRICE_CHANNEL_MEMBERS = 'price-channel.members';

/**
 * Run the sweep soon — after a deactivation. Synchronous return, never awaited
 * by a door; a server with no token (dev, CI, the Playwright server's fake
 * one is set, which only enqueues) never starts pg-boss for this.
 */
export function kickPriceChannelMembers(): void {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  void enqueue(JOB_PRICE_CHANNEL_MEMBERS, {}).catch((err: unknown) =>
    logger.warn({ err }, '[price-channel] member sweep not queued'),
  );
}

export async function registerPriceChannelMembersWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_PRICE_CHANNEL_MEMBERS);
  await boss.schedule(JOB_PRICE_CHANNEL_MEMBERS, '*/15 * * * *');
  await boss.work(JOB_PRICE_CHANNEL_MEMBERS, async () => {
    // Not rethrown: the member rows ARE the retry (their last_error and the
    // next quarter-hour), and a pg-boss retry would only repeat the same bans.
    await sweepPriceChannelMembers().catch((err: unknown) =>
      logger.error({ err }, '[price-channel] member sweep failed'),
    );
  });
}
