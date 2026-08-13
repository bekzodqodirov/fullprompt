import { describe, expect, it } from 'vitest';
import { isPermanentNoticeFailure, MAX_NOTICE_ATTEMPTS } from '@/modules/wms/notices/arrival';

/**
 * Which Telegram refusals are about the MESSAGE and which are about the
 * MOMENT — the split rounds 48-49 settled for the outbox, restated here for
 * the Bot API's status codes.
 *
 * The audit's find: the arrival worker settled every zero-delivery attempt as
 * `failed`, and `dueArrivalNotices` re-reads only `pending` — so one 429
 * during the burst that follows a truck landing meant that customer was never
 * told their cargo arrived, silently and for ever. A truck unloading is
 * precisely when a rate limit is most likely.
 */
describe('isPermanentNoticeFailure', () => {
  it('gives up on facts about the recipient', () => {
    // Blocked the bot, no such chat, bad token, gone.
    for (const status of [400, 401, 403, 404]) {
      expect(isPermanentNoticeFailure(status), String(status)).toBe(true);
    }
  });

  it('retries the world being busy', () => {
    // 429 is THE case this exists for; 5xx is Telegram, not us.
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isPermanentNoticeFailure(status), String(status)).toBe(false);
    }
  });

  it('keeps a bounded patience', () => {
    // A retry budget, not an eternal queue: the sweep runs every two minutes.
    expect(MAX_NOTICE_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_NOTICE_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
