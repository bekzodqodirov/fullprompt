import { describe, expect, it } from 'vitest';
import {
  isDbUnreachable,
  isPermanentSendError,
  isSessionDead,
  outboxLabel,
  STUCK_SENDING_MS,
} from '@/modules/wms/crm/telegram-send';

/**
 * The owner's item 14, from his own server's logs (round 48).
 *
 * What actually happened: the listener sent his reply, Telegram accepted it,
 * and then `markSent` could not reach the database — Docker's embedded DNS had
 * stopped resolving `postgres` for that container («getaddrinfo EAI_AGAIN
 * postgres», repeating). The row stayed `sending`, and the thread went on
 * calling it «navbatda» for days while the client had already answered.
 *
 * Two rules come out of that, and both are here because both are cheap to get
 * wrong again: a row in flight is not the same as a row waiting, and a row
 * that has been in flight for hours is not the same as either.
 */

const AT = new Date('2026-08-03T12:00:00Z');
const ago = (ms: number) => new Date(AT.getTime() - ms);

describe('what the thread calls a reply that is not marked sent', () => {
  it('a queued row is queued, whatever its age', () => {
    expect(outboxLabel('queued', ago(0), AT)).toBe('queued');
    expect(outboxLabel('queued', ago(9 * 3600_000), AT)).toBe('queued');
  });

  it('a failed row says so, and age never softens it', () => {
    expect(outboxLabel('failed', ago(1000), AT)).toBe('failed');
    expect(outboxLabel('failed', ago(9 * 3600_000), AT)).toBe('failed');
  });

  it('a row in flight reads as in flight — for as long as that is plausible', () => {
    expect(outboxLabel('sending', ago(1000), AT)).toBe('sending');
    expect(outboxLabel('sending', ago(STUCK_SENDING_MS - 1000), AT)).toBe('sending');
  });

  it('and stops reading as anything but "check it" once it is not', () => {
    expect(outboxLabel('sending', ago(STUCK_SENDING_MS + 1000), AT)).toBe('stuck');
    // His actual case: hours.
    expect(outboxLabel('sending', ago(30 * 3600_000), AT)).toBe('stuck');
  });

  it('falls back to in-flight when there is no time to judge by', () => {
    expect(outboxLabel('sending', null, AT)).toBe('sending');
  });
});

describe('telling a dead database apart from a refused message', () => {
  it('recognises the failure his server actually had', () => {
    expect(isDbUnreachable('getaddrinfo EAI_AGAIN postgres')).toBe(true);
  });

  it('and the other shapes of the same thing', () => {
    for (const message of [
      'connect ECONNREFUSED 172.18.0.2:5432',
      'getaddrinfo ENOTFOUND postgres',
      'Connection terminated unexpectedly',
      'read ECONNRESET',
    ]) {
      expect(isDbUnreachable(message), message).toBe(true);
    }
  });

  it('never swallows a refusal the other person made', () => {
    // These must reach `markAttemptFailed` as permanent, not be mistaken for
    // a database blip and quietly re-queued at a customer who blocked us.
    for (const message of ['USER_IS_BLOCKED', 'CHAT_WRITE_FORBIDDEN', 'MESSAGE_TOO_LONG']) {
      expect(isDbUnreachable(message), message).toBe(false);
      expect(isPermanentSendError(message), message).toBe(true);
    }
  });
});

/**
 * Round 49, straight off his server's logs:
 *
 *   yuborilmadi (qayta urinaman): 401: SESSION_REVOKED (caused by messages.SendMessage)
 *   …eight times…
 *
 * Telegram had ended the session. Nothing recognised that, so the listener
 * treated a dead account as a flaky network and knocked every three seconds
 * until each reply burned its three attempts — while the heartbeat kept being
 * written, the screen said the bridge was LIVE, and the compose box went on
 * accepting messages that could never leave.
 */
describe('telling a dead SESSION apart from a dead message', () => {
  it('recognises what Telegram actually said on his server', () => {
    expect(isSessionDead('401: SESSION_REVOKED (caused by messages.SendMessage)')).toBe(true);
  });

  it('and the other ways an account stops being ours', () => {
    for (const message of [
      'AUTH_KEY_UNREGISTERED',
      'AUTH_KEY_DUPLICATED',
      '401: SESSION_EXPIRED',
      'USER_DEACTIVATED_BAN',
    ]) {
      expect(isSessionDead(message), message).toBe(true);
    }
  });

  it('does not mistake one refused message for a dead account', () => {
    // These kill the MESSAGE. Marking the account signed out for one of them
    // would take the whole company's chat offline because one customer
    // blocked one manager.
    for (const message of [
      'USER_IS_BLOCKED',
      'CHAT_WRITE_FORBIDDEN',
      'MESSAGE_TOO_LONG',
      'PEER_FLOOD',
      'getaddrinfo EAI_AGAIN postgres',
    ]) {
      expect(isSessionDead(message), message).toBe(false);
    }
  });

  it('a revoked session is never merely "try again later"', () => {
    // The bug in one line: the old code asked only this question, got `false`,
    // and printed «qayta urinaman».
    const revoked = '401: SESSION_REVOKED (caused by messages.SendMessage)';
    expect(isPermanentSendError(revoked)).toBe(false);
    expect(isDbUnreachable(revoked)).toBe(false);
    expect(isSessionDead(revoked)).toBe(true);
  });
});
