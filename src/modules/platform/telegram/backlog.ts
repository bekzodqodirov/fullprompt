import type { Context, MiddlewareFn } from 'grammy';
import { bootedAtSec, isBacklog } from './lifecycle';
import { escapesIntake } from './staff-bot';

/**
 * The backlog — what a person typed while the bot was down (Q5 a).
 *
 * Telegram now hands it over after a deploy, in order. Most of it answers
 * itself (a code is looked up, a reply lands on its card, a label is served),
 * but two things cannot be answered honestly:
 *  - text meant for a collector that died with the old process (a calc
 *    intake, a zametka, a task draft): this process cannot know what it was
 *    for, and filing it into whatever collector a late press opened would
 *    make it material for the wrong thing;
 *  - text the free lookups cannot answer: today that reaches the paid AI,
 *    which was never asked — the person's words were a lost collector's.
 * Both get ONE sentence per chat per boot, and the same keyboard label or
 * command sent five times into the outage is answered once.
 */

export const BACKLOG_SENTENCE =
  '⏸ Bu xabar bot yangilanayotgan paytda yozilgan — u nimaga javob ekanini bot bilmaydi. ' +
  'Hisoblatish, zametka yoki topshiriq yozayotgan bo‘lsangiz, qaytadan boshlang; savol bo‘lsa, qaytadan yuboring.';

/** A crash redelivery of a message that already did its work (handledAlready). */
export const HANDLED_SENTENCE = 'Bu xabarga javob berilgan — yuqoriga qarang.';

/** `${boot}:${chat}` — the boot is part of the key, so «once per chat per boot» is exactly that. */
const told = new Set<string>();

/** Once per chat per boot — one sentence speaks for everything the person typed into the outage. */
export async function tellBacklogOnce(
  ctx: { reply: (text: string) => Promise<unknown> },
  chatId: bigint | number,
): Promise<void> {
  const key = `${bootedAtSec()}:${String(chatId)}`;
  if (told.has(key)) return;
  if (told.size > 10_000) told.clear();
  told.add(key);
  await ctx.reply(BACKLOG_SENTENCE);
}

const seenLabels = new Set<string>();

/**
 * A keyboard label (`escapesIntake` — every staff and cabinet label and its
 * command form) or a /command sent again while the bot was down: answered
 * once per chat per boot. A label or command sent after boot is never
 * backlog and is always served; five `/start` from a customer are one
 * greeting pair.
 */
export function coalesceBacklogLabels(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const message = ctx.message;
    const text = message?.text;
    if (!message || typeof text !== 'string' || !isBacklog(message.date)) return next();
    const t = text.trim();
    if (!(escapesIntake(t) || t.startsWith('/'))) return next();
    const key = `${bootedAtSec()}:${ctx.chat?.id ?? ''}:${t}`;
    if (seenLabels.has(key)) return;
    if (seenLabels.size > 10_000) seenLabels.clear();
    seenLabels.add(key);
    return next();
  };
}

/** Tests: a fresh boot's memory. */
export function __resetBacklog(): void {
  told.clear();
  seenLabels.clear();
}
