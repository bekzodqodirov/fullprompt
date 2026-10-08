import type { Transformer } from 'grammy';

/**
 * The burst after a deploy (Q5 a): the backlog is handled one update at a
 * time, and the answers to it meet Telegram's per-chat send rate. A 429 that
 * asks for a moment is waited out here, at most twice, on the poller — the
 * poller is busy with exactly this chat's backlog anyway. Anything longer is
 * the caller's: the handler throws after its writes and `bot.catch` names the
 * update.
 *
 * Never for `getUpdates` (grammy's loop has its own 429 handling),
 * `answerCallbackQuery` (a late toast is pointless to retry), the webhook and
 * `getMe` (startup's own retries) or a typing action (cosmetic).
 */
export const BRIEF_RETRY_MAX_S = 5;

const NEVER_RETRIED = new Set(['getUpdates', 'deleteWebhook', 'getMe', 'answerCallbackQuery', 'sendChatAction']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seconds to wait before one more try, or null when this answer is the caller's. */
function briefWait(method: string, res: { ok: boolean; error_code?: number; parameters?: { retry_after?: number } }): number | null {
  if (NEVER_RETRIED.has(method) || res.ok || res.error_code !== 429) return null;
  const after = res.parameters?.retry_after ?? 99;
  return after <= BRIEF_RETRY_MAX_S ? after : null;
}

export const briefRetry: Transformer = async (prev, method, payload, signal) => {
  let res = await prev(method, payload, signal);
  for (let i = 0; i < 2; i += 1) {
    const wait = briefWait(method, res as Parameters<typeof briefWait>[1]);
    if (wait === null) break;
    await sleep(wait * 1000);
    res = await prev(method, payload, signal);
  }
  return res;
};
