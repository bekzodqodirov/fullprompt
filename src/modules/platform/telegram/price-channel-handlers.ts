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
 *
 * …and serialised on ONE chain (Q5 a): the backlog now arrives in a burst,
 * and a person's «joined» then «left», or a demote then a re-promote, run out
 * of order would leave a live row for somebody who left or a false
 * `bot_removed` pause. The stop drains the chain inside its budget.
 */
let tail: Promise<void> = Promise.resolve();

/** One membership update after the other, in update order; a throw is logged and never stops the next. */
export function serialMembership(work: () => Promise<unknown>, what = 'membership'): void {
  tail = tail
    .then(work)
    .then(
      () => {},
      (err: unknown) => logger.error({ err }, `[price-channel] ${what} failed`),
    );
}

/** Resolves once every membership update queued so far has finished. */
export function membershipSettled(): Promise<void> {
  return tail;
}

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
    serialMembership(() => recordChatMembership(update as unknown as MyChatMemberUpdate), 'my_chat_member');
  });

  bot.on('chat_join_request', async (ctx) => {
    const request = ctx.chatJoinRequest as unknown as JoinRequestUpdate;
    serialMembership(() => answerJoinRequest(request), 'join request');
  });

  bot.on('chat_member', async (ctx, next) => {
    if (ctx.chatMember.chat.type !== 'channel') return next();
    const member = ctx.chatMember as unknown as ChatMemberUpdate;
    serialMembership(() => answerMemberUpdate(member), 'chat_member');
  });
}
