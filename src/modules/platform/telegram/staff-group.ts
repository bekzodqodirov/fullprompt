import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { staffGroupChats } from '../db/schema';
import { logger } from '../logger';
import { writeAudit, type AuditContext } from '../audit/service';
import { SETTINGS_AUDIT_ID } from '../settings/service';
import { usersWithPermission } from '../notifications/service';
import { botCall } from './send';
import { eligibleForChannel } from './price-channel';
import { botCanPost, decideGroupAdoption, GROUP_TYPES } from './staff-group-rules';

/**
 * THE STAFF GROUP (0134, the owner, 2026-10-20: «telegram botni gurux chat
 * groupga qoshsa … hammani oldida maqtaydigan»): which Telegram group the bot
 * praises people in and posts the Saturday rating to.
 *
 * The group is a ROW, not a setting — the `staff_group_chats` row with
 * `active_from` set (0134's partial UNIQUE index allows one) — for the price
 * channel's reason: /admin/settings renders every key as an editable input,
 * so a setting would be a door around the adoption rule below. This file is
 * the ONLY writer of `active_from`.
 *
 * The bot never READS the group. Whatever its members write there stops at
 * the swallow in staff-group-handlers.ts; the only updates acted on are the
 * bot's own membership and the group's move to a supergroup.
 */

export type StaffGroup = typeof staffGroupChats.$inferSelect;

/** THE group, or null. */
export async function activeStaffGroup(): Promise<StaffGroup | null> {
  const [row] = await db.select().from(staffGroupChats).where(isNotNull(staffGroupChats.activeFrom)).limit(1);
  return row ?? null;
}

/** Every group a colleague added the bot to — the panel's list. */
export async function knownStaffGroups(): Promise<StaffGroup[]> {
  return db.select().from(staffGroupChats).orderBy(desc(staffGroupChats.updatedAt)).limit(20);
}

/** The bot's own Telegram id — the token's prefix, so no getMe is needed to ask about itself. */
function botUserId(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const id = token.split(':')[0];
  return id && /^\d+$/.test(id) ? id : null;
}

export type GroupVetResult = { ok: true } | { ok: false; reason: 'telegram' | 'not_group' | 'cannot_post'; detail?: string };

/**
 * May the bot post into this group NOW? Two reads through the one sender
 * (the chat, and the bot's own member record in it), and the answer written
 * on the row either way so the panel can say it in words. A call that merely
 * failed leaves the old answer: a network blip is not a fact about the group.
 */
export async function vetStaffGroup(chatId: string): Promise<GroupVetResult> {
  const me = botUserId();
  const chat = await botCall('getChat', { chat_id: chatId }, 10_000);
  if (!chat.ok) {
    await db
      .update(staffGroupChats)
      .set({ lastError: chat.description, updatedAt: new Date() })
      .where(eq(staffGroupChats.chatId, BigInt(chatId)));
    return { ok: false, reason: 'telegram', detail: chat.description };
  }
  const info = chat.result as { type?: string; title?: string } | null;
  if (!info?.type || !GROUP_TYPES.has(info.type)) return { ok: false, reason: 'not_group' };
  const member = me ? await botCall('getChatMember', { chat_id: chatId, user_id: Number(me) }, 10_000) : null;
  const count = await botCall('getChatMemberCount', { chat_id: chatId }, 10_000);
  const record = member?.ok ? (member.result as { status: string; can_send_messages?: boolean }) : null;
  const canPost = botCanPost(record);
  await db
    .update(staffGroupChats)
    .set({
      title: info.title ?? '',
      chatType: info.type,
      ...(record ? { status: record.status } : {}),
      canPost,
      memberCount: count.ok && typeof count.result === 'number' ? count.result : null,
      vettedAt: new Date(),
      lastError: canPost ? null : 'cannot_post',
      updatedAt: new Date(),
    })
    .where(eq(staffGroupChats.chatId, BigInt(chatId)));
  return canPost ? { ok: true } : { ok: false, reason: 'cannot_post' };
}

/** The bot's status in a chat changed (`my_chat_member`) — the shape this file reads. */
export interface GroupMemberUpdate {
  chat: { id: number; type: string; title?: string };
  from: { id: number };
  new_chat_member: { status: string };
}

/**
 * Adoption: Telegram tells us when somebody adds the bot to a group. Only a
 * linked, active COLLEAGUE makes a group known, and only a SETTINGS ADMIN
 * makes it the staff group by doing so (`decideGroupAdoption`) — the owner
 * adds the bot and the group starts working; a colleague's group waits on the
 * panel for his press. A group we already know hears every later change
 * whoever made it: a kick must not be missed.
 */
export async function recordGroupMembership(
  update: GroupMemberUpdate,
): Promise<'adopted' | 'recorded' | 'updated' | 'ignored'> {
  const chatId = String(update.chat.id);
  const [row] = await db.select().from(staffGroupChats).where(eq(staffGroupChats.chatId, BigInt(chatId))).limit(1);
  const active = await activeStaffGroup();
  const adder = await eligibleForChannel(BigInt(update.from.id));
  const settingsAdmins = adder ? await usersWithPermission('admin.settings.manage') : [];
  const status = update.new_chat_member.status;
  const verdict = decideGroupAdoption({
    chatType: update.chat.type,
    newStatus: status,
    rowExists: !!row,
    rowActive: !!row?.activeFrom,
    hasActive: active !== null,
    adderIsColleague: adder !== null,
    adderIsSettingsAdmin: adder !== null && settingsAdmins.includes(adder.userId),
  });
  if (verdict === 'ignore') {
    if (GROUP_TYPES.has(update.chat.type)) logger.info({ chatId }, '[staff-group] ignored a group from a non-colleague');
    return 'ignored';
  }
  const gone = status === 'left' || status === 'kicked';
  if (verdict === 'update') {
    await db
      .update(staffGroupChats)
      .set({
        status,
        title: update.chat.title ?? row!.title,
        chatType: update.chat.type,
        ...(gone ? { activeFrom: null, activeByUserId: null, canPost: false } : {}),
        updatedAt: new Date(),
      })
      .where(eq(staffGroupChats.chatId, BigInt(chatId)));
    if (gone && row!.activeFrom) logger.warn({ chatId }, '[staff-group] the bot left the staff group');
    if (!gone) await vetStaffGroup(chatId);
    return 'updated';
  }
  await db
    .insert(staffGroupChats)
    .values({
      chatId: BigInt(chatId),
      chatType: update.chat.type,
      title: update.chat.title ?? '',
      status,
      addedByUserId: adder!.userId,
    })
    .onConflictDoUpdate({
      target: staffGroupChats.chatId,
      set: { status, title: update.chat.title ?? '', chatType: update.chat.type, updatedAt: new Date() },
    });
  if (verdict === 'record') {
    await vetStaffGroup(chatId);
    return 'recorded';
  }
  const done = await connectStaffGroup(chatId, { actorId: adder!.userId });
  if (!done.ok) logger.warn({ chatId, error: done.error }, '[staff-group] adopted group not connected');
  return done.ok ? 'adopted' : 'recorded';
}

/**
 * A group became a supergroup: Telegram gives it a NEW chat id and the old one
 * stops answering. The row follows (told by the migration message in the old
 * chat, or by a send refused with the new id) unless the new id is already a
 * row of its own.
 */
export async function migrateStaffGroup(fromChatId: string, toChatId: string): Promise<boolean> {
  const moved = await db.execute(sql`
    UPDATE staff_group_chats
       SET chat_id = ${toChatId}::bigint, chat_type = 'supergroup', updated_at = now()
     WHERE chat_id = ${fromChatId}::bigint
       AND NOT EXISTS (SELECT 1 FROM staff_group_chats WHERE chat_id = ${toChatId}::bigint)
     RETURNING chat_id`);
  const ok = Array.from(moved).length > 0;
  if (ok) logger.info({ fromChatId, toChatId }, '[staff-group] the group became a supergroup — followed');
  return ok;
}

export type GroupConnectError = 'not_found' | 'not_present' | 'telegram' | 'not_group' | 'cannot_post';

/**
 * Make a recorded group THE staff group — the ONE writer of `active_from`,
 * used by the adoption and by «Shu guruhni ulash». The bot must be in it and
 * able to post; then one transaction moves the activation, audited on the
 * settings record like any configuration change.
 */
export async function connectStaffGroup(
  chatId: string,
  ctx: AuditContext,
): Promise<{ ok: true } | { ok: false; error: GroupConnectError; detail?: string }> {
  if (!ctx.actorId) return { ok: false, error: 'not_found' };
  const [row] = await db.select().from(staffGroupChats).where(eq(staffGroupChats.chatId, BigInt(chatId))).limit(1);
  if (!row || !row.addedByUserId) return { ok: false, error: 'not_found' };
  if (row.status === 'left' || row.status === 'kicked') return { ok: false, error: 'not_present' };
  const vet = await vetStaffGroup(chatId);
  if (!vet.ok) return { ok: false, error: vet.reason, detail: vet.detail };
  const before = (await activeStaffGroup())?.chatId.toString() ?? null;
  const actorId = ctx.actorId;
  await db.transaction(async (tx) => {
    await tx
      .update(staffGroupChats)
      .set({ activeFrom: null, activeByUserId: null, updatedAt: new Date() })
      .where(and(isNotNull(staffGroupChats.activeFrom), ne(staffGroupChats.chatId, BigInt(chatId))));
    await tx
      .update(staffGroupChats)
      .set({ activeFrom: new Date(), activeByUserId: actorId, updatedAt: new Date() })
      .where(eq(staffGroupChats.chatId, BigInt(chatId)));
    await writeAudit(tx, ctx, {
      entityType: 'settings',
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      before: { staffGroup: before },
      after: { staffGroup: chatId },
    });
  });
  return { ok: true };
}

/** «Uzish» — no group; new celebrations are recorded `skipped/no_group` until one is connected again. */
export async function disconnectStaffGroup(ctx: AuditContext): Promise<void> {
  const before = await activeStaffGroup();
  if (!before) return;
  await db.transaction(async (tx) => {
    await tx
      .update(staffGroupChats)
      .set({ activeFrom: null, activeByUserId: null, updatedAt: new Date() })
      .where(isNotNull(staffGroupChats.activeFrom));
    await writeAudit(tx, ctx, {
      entityType: 'settings',
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      before: { staffGroup: before.chatId.toString() },
      after: { staffGroup: null },
    });
  });
}
