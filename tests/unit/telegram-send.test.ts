import { describe, expect, it } from 'vitest';
import {
  bodyTooLong,
  canQueue,
  canSendNow,
  DEFAULT_LIMITS,
  floodWaitUntil,
  isPermanentSendError,
  MAX_BODY_CHARS,
  MAX_FLOOD_WAIT_S,
  type SendContext,
} from '@/modules/wms/crm/telegram-send';

/**
 * The rules that stand between a software fault and twelve people losing
 * their personal Telegram accounts.
 *
 * Phases 1-3 could argue safety from an absence — there was no code that
 * sent. There is now, so these are the argument, and a test that only proves
 * the happy path proves nothing worth having here. Almost every case below is
 * a REFUSAL.
 */

const ok = (over: Partial<SendContext> = {}): SendContext => ({
  sentLastMinute: 0,
  sentLastDay: 0,
  sentToChatLastMinute: 0,
  clientHasWrittenFirst: true,
  sendingEnabled: true,
  floodWaitUntil: null,
  bridgeLive: true,
  ...over,
});

describe('queueing a reply', () => {
  it('lets a normal answer through', () => {
    expect(canQueue('Yuk ertaga jo‘naydi', ok())).toEqual({ ok: true });
  });

  it('refuses while the company switch is off', () => {
    // Default OFF. Deploying this code must not, by itself, make anybody's
    // account start sending.
    expect(canQueue('salom', ok({ sendingEnabled: false }))).toEqual({
      ok: false,
      reason: 'sending_disabled',
    });
  });

  it('refuses to message somebody who never wrote to us', () => {
    // The rule that matters most. Unsolicited outbound is what "report spam"
    // exists for, and a handful of reports is enough.
    expect(canQueue('salom', ok({ clientHasWrittenFirst: false }))).toEqual({
      ok: false,
      reason: 'never_wrote_first',
    });
  });

  it('refuses when the bridge is down, rather than accepting silently', () => {
    // The row would be valid and would go out eventually. But "eventually"
    // may be tomorrow, and a manager who saw their answer accepted believes
    // the client has it. A client waiting on an answer nobody sent is the
    // worst outcome this feature can produce.
    expect(canQueue('salom', ok({ bridgeLive: false }))).toEqual({
      ok: false,
      reason: 'bridge_down',
    });
  });

  it('refuses an empty message before anything else', () => {
    expect(canQueue('   ', ok())).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses at the per-minute, per-day and per-chat ceilings', () => {
    expect(canQueue('x', ok({ sentLastMinute: DEFAULT_LIMITS.perMinute }))).toEqual({
      ok: false,
      reason: 'rate_minute',
    });
    expect(canQueue('x', ok({ sentLastDay: DEFAULT_LIMITS.perDay }))).toEqual({
      ok: false,
      reason: 'rate_day',
    });
    expect(canQueue('x', ok({ sentToChatLastMinute: DEFAULT_LIMITS.perChatPerMinute }))).toEqual({
      ok: false,
      reason: 'rate_chat',
    });
  });

  it('reports the per-chat ceiling ahead of the account ones', () => {
    // Both are breached; the per-chat one is the more useful thing to say,
    // because it names the actual problem: a loop pointed at one person.
    const ctx = ok({
      sentToChatLastMinute: DEFAULT_LIMITS.perChatPerMinute,
      sentLastMinute: DEFAULT_LIMITS.perMinute,
    });
    expect(canQueue('x', ctx)).toEqual({ ok: false, reason: 'rate_chat' });
  });

  it('is still allowed one below each ceiling', () => {
    expect(
      canQueue(
        'x',
        ok({
          sentLastMinute: DEFAULT_LIMITS.perMinute - 1,
          sentLastDay: DEFAULT_LIMITS.perDay - 1,
          sentToChatLastMinute: DEFAULT_LIMITS.perChatPerMinute - 1,
        }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('sending, checked again at the moment it happens', () => {
  const NOW = new Date('2026-07-28T10:00:00Z');

  it('re-checks the limits, because time passed since queueing', () => {
    // A row queued when the account was idle can reach the front of the queue
    // after a burst. The limits are about the moment of sending.
    expect(canSendNow(ok({ sentLastMinute: DEFAULT_LIMITS.perMinute }), DEFAULT_LIMITS, NOW)).toEqual(
      { ok: false, reason: 'rate_minute' },
    );
  });

  it('obeys a FLOOD_WAIT that is still in force', () => {
    const until = new Date(NOW.getTime() + 30_000);
    expect(canSendNow(ok({ floodWaitUntil: until }), DEFAULT_LIMITS, NOW)).toEqual({
      ok: false,
      reason: 'flood_wait',
    });
  });

  it('resumes the moment the wait has passed', () => {
    const until = new Date(NOW.getTime() - 1);
    expect(canSendNow(ok({ floodWaitUntil: until }), DEFAULT_LIMITS, NOW)).toEqual({ ok: true });
  });

  it('does not refuse for a down bridge — it IS the bridge', () => {
    // `canSendNow` runs inside the listener, which is by definition connected.
    // Carrying the queue-time check here would refuse everything.
    expect(canSendNow(ok({ bridgeLive: false }), DEFAULT_LIMITS, NOW)).toEqual({ ok: true });
  });

  it('still refuses somebody who never wrote first', () => {
    // Belt and braces: the rule must not be escapable by getting a row into
    // the table some other way.
    expect(canSendNow(ok({ clientHasWrittenFirst: false }), DEFAULT_LIMITS, NOW)).toEqual({
      ok: false,
      reason: 'never_wrote_first',
    });
  });
});

describe('what Telegram tells us to do', () => {
  const NOW = new Date('2026-07-28T10:00:00Z');

  it('waits its number plus a second of slack', () => {
    expect(floodWaitUntil(30, NOW).getTime() - NOW.getTime()).toBe(31_000);
  });

  it('waits at least a second even if it says zero', () => {
    expect(floodWaitUntil(0, NOW).getTime() - NOW.getTime()).toBe(1_000);
  });

  it('caps the wait at an hour', () => {
    // Beyond an hour, waiting is not the fix — and a process asleep for six
    // hours is indistinguishable from one that has died.
    expect(floodWaitUntil(86_400, NOW).getTime() - NOW.getTime()).toBe(MAX_FLOOD_WAIT_S * 1000);
  });
});

describe('which failures are worth retrying', () => {
  it('never retries a decision the other person made', () => {
    // Retrying these IS the abuse pattern, not a workaround for it.
    for (const code of [
      'USER_IS_BLOCKED',
      'PEER_FLOOD',
      'USER_PRIVACY_RESTRICTED',
      'USER_DEACTIVATED',
      'CHAT_WRITE_FORBIDDEN',
    ]) {
      expect(isPermanentSendError(`RPCError 400: ${code} (caused by SendMessage)`)).toBe(true);
    }
  });

  it('retries something that was nobody’s decision', () => {
    expect(isPermanentSendError('socket hang up')).toBe(false);
    expect(isPermanentSendError('TIMEOUT')).toBe(false);
    expect(isPermanentSendError('Not connected')).toBe(false);
  });
});

describe('the size of a message', () => {
  it('accepts one at exactly Telegram’s ceiling', () => {
    expect(bodyTooLong('a'.repeat(MAX_BODY_CHARS))).toBe(false);
    expect(bodyTooLong('a'.repeat(MAX_BODY_CHARS + 1))).toBe(true);
  });

  it('counts characters, not UTF-16 units', () => {
    // Telegram counts characters. Counting `.length` would refuse a message of
    // emoji at half the real limit — and a packing note full of them is a
    // perfectly ordinary thing for a client to send back.
    const emoji = '📦'.repeat(MAX_BODY_CHARS);
    expect(emoji.length).toBe(MAX_BODY_CHARS * 2);
    expect(bodyTooLong(emoji)).toBe(false);
  });
});
