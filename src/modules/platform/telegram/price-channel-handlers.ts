import type { Bot } from 'grammy';
import { logger } from '../logger';
import {
  answerJoinRequest,
  answerMemberUpdate,
  recordChatMembership,
  type ChatMemberUpdate,
  type JoinRequestUpdate,
  type MyChatMemberUpdate,
} from './price-channel';

/**
 * The bot's side of the price channel (the owner's F, 2026-10-07). Registered
 * FIRST, right after `new Bot`, by bot.ts — see the swallow below.
 *
 * The three membership handlers are dispatched off grammy's sequential poller
 * (#706): each makes several Bot API calls, and one slow Telegram answer must
 * not hold every customer's cabinet tap behind it.
 */
export function registerPriceChannel(bot: Bot): void {
  // A deliberate SWALLOW — no next(). `bot.command` matches commands in
  // CHANNEL POSTS too, so once the bot is a channel admin a «/start» typed in
  // the price channel would reach /start or /hodim, whose replies would post
  // the entry keyboard into the channel every colleague reads.
  bot.on(['channel_post', 'edited_channel_post'], async () => {});

  bot.on('my_chat_member', async (ctx, next) => {
    const update = ctx.myChatMember;
    // Anything but a channel (a customer blocking the bot, a group) is not ours.
    if (update.chat.type !== 'channel') return next();
    void recordChatMembership(update as unknown as MyChatMemberUpdate).catch((err: unknown) =>
      logger.error({ err }, '[price-channel] my_chat_member failed'),
    );
  });

  bot.on('chat_join_request', async (ctx) => {
    void answerJoinRequest(ctx.chatJoinRequest as unknown as JoinRequestUpdate).catch((err: unknown) =>
      logger.error({ err }, '[price-channel] join request failed'),
    );
  });

  bot.on('chat_member', async (ctx, next) => {
    if (ctx.chatMember.chat.type !== 'channel') return next();
    void answerMemberUpdate(ctx.chatMember as unknown as ChatMemberUpdate).catch((err: unknown) =>
      logger.error({ err }, '[price-channel] chat_member failed'),
    );
  });
}
