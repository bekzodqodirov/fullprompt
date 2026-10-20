import type { Bot } from 'grammy';
import { serialMembership } from './price-channel-handlers';
import { migrateStaffGroup, recordGroupMembership, type GroupMemberUpdate } from './staff-group';
import { GROUP_TYPES } from './staff-group-rules';

/**
 * The bot's side of the staff group (0134). Registered right after the price
 * channel's handlers by bot.ts, and before every command — see the swallow.
 *
 * The membership update is dispatched off grammy's sequential poller (#706)
 * on the price channel's ONE chain, so a «removed» and a «re-added» from the
 * backlog cannot land out of order.
 */
export function registerStaffGroup(bot: Bot): void {
  bot.on('my_chat_member', async (ctx, next) => {
    const update = ctx.myChatMember;
    if (!GROUP_TYPES.has(update.chat.type)) return next();
    serialMembership(() => recordGroupMembership(update as unknown as GroupMemberUpdate), 'staff group my_chat_member');
  });

  // The old group's last word when it becomes a supergroup: the new id.
  bot.on('message:migrate_to_chat_id', async (ctx) => {
    const from = String(ctx.chat.id);
    const to = String(ctx.message.migrate_to_chat_id);
    serialMembership(() => migrateStaffGroup(from, to), 'staff group migration');
  });

  // A deliberate SWALLOW of everything else a group says — no next(). The bot
  // never READS the staff group: a «/start» typed there would otherwise reach
  // the two-door menu and post the entry keyboard into a room everybody reads
  // (and `/start <code>` would link the GROUP as somebody's staff chat), the
  // staff ladder would answer colleagues' chatter, and a customer's cabinet
  // keyboard could appear for the whole office. Whether Telegram delivers the
  // group's messages at all depends on the bot's privacy mode, which this
  // repository cannot see — so the rule holds either way.
  bot.use(async (ctx, next) => {
    const type = ctx.chat?.type;
    if (type === 'group' || type === 'supergroup') return;
    await next();
  });
}
