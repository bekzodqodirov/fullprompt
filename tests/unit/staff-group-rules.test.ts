import { describe, expect, it } from 'vitest';
import {
  botCanPost,
  decideGroupAdoption,
  groupVerdict,
  staleAfterHours,
} from '@/modules/platform/telegram/staff-group-rules';

/** The staff group's pure decisions (0134) — each rule a row. */

const base = {
  chatType: 'supergroup',
  newStatus: 'member',
  rowExists: false,
  rowActive: false,
  hasActive: false,
  adderIsColleague: false,
  adderIsSettingsAdmin: false,
};

describe('decideGroupAdoption', () => {
  it('a channel or a private chat is never the staff group', () => {
    expect(decideGroupAdoption({ ...base, chatType: 'channel', adderIsColleague: true, adderIsSettingsAdmin: true })).toBe('ignore');
    expect(decideGroupAdoption({ ...base, chatType: 'private', adderIsColleague: true, adderIsSettingsAdmin: true })).toBe('ignore');
  });

  it('the owner adds the bot and the group starts working', () => {
    expect(decideGroupAdoption({ ...base, adderIsColleague: true, adderIsSettingsAdmin: true })).toBe('adopt');
    expect(decideGroupAdoption({ ...base, chatType: 'group', adderIsColleague: true, adderIsSettingsAdmin: true })).toBe('adopt');
  });

  it('a settings admin adding a second group while one is active only records it', () => {
    expect(
      decideGroupAdoption({ ...base, hasActive: true, adderIsColleague: true, adderIsSettingsAdmin: true }),
    ).toBe('record');
  });

  it('a colleague’s group waits on the panel; a stranger’s writes nothing', () => {
    expect(decideGroupAdoption({ ...base, adderIsColleague: true })).toBe('record');
    expect(decideGroupAdoption({ ...base })).toBe('ignore');
  });

  it('a known group hears every change, whoever made it — a kick included', () => {
    expect(decideGroupAdoption({ ...base, rowExists: true, rowActive: true, hasActive: true, newStatus: 'kicked' })).toBe('update');
    expect(decideGroupAdoption({ ...base, rowExists: true, newStatus: 'left' })).toBe('update');
  });

  it('the bot leaving a group we never knew writes nothing', () => {
    expect(decideGroupAdoption({ ...base, newStatus: 'left', adderIsColleague: true, adderIsSettingsAdmin: true })).toBe('ignore');
  });

  it('re-added by the owner to a known, inactive group with none active: adopt again', () => {
    expect(
      decideGroupAdoption({ ...base, rowExists: true, adderIsColleague: true, adderIsSettingsAdmin: true }),
    ).toBe('adopt');
  });
});

describe('botCanPost', () => {
  it('a member, an admin or the creator may post; a silenced member may not', () => {
    expect(botCanPost({ status: 'member' })).toBe(true);
    expect(botCanPost({ status: 'administrator' })).toBe(true);
    expect(botCanPost({ status: 'restricted', can_send_messages: true })).toBe(true);
    expect(botCanPost({ status: 'restricted', can_send_messages: false })).toBe(false);
    expect(botCanPost({ status: 'left' })).toBe(false);
    expect(botCanPost(null)).toBe(false);
  });
});

const answer = (over: Partial<Parameters<typeof groupVerdict>[0]>) => ({
  ok: false,
  status: 400,
  description: '',
  retryAfter: null,
  botDown: false,
  migrateToChatId: null,
  ...over,
});

describe('groupVerdict — never twice in front of everybody', () => {
  it('sent', () => {
    expect(groupVerdict(answer({ ok: true, status: 200 }), 1)).toEqual({ next: 'sent' });
  });
  it('a group that became a supergroup is followed and sent again', () => {
    expect(groupVerdict(answer({ migrateToChatId: '-100123' }), 1)).toEqual({ next: 'migrated', chatId: '-100123' });
  });
  it('429 waits as long as Telegram asked', () => {
    expect(groupVerdict(answer({ status: 429, retryAfter: 7 }), 1)).toEqual({ next: 'retry', notBeforeSec: 7 });
  });
  it('a dead token pauses and keeps the queue', () => {
    expect(groupVerdict(answer({ status: 401, botDown: true }), 1).next).toBe('pause');
    expect(groupVerdict(answer({ status: 0, description: 'no_bot_token' }), 1).next).toBe('pause');
  });
  it('the bot removed or silenced pauses as the GROUP’s refusal', () => {
    expect(groupVerdict(answer({ status: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }), 1)).toMatchObject({
      next: 'pause',
      groupRefused: true,
    });
    expect(groupVerdict(answer({ status: 400, description: 'Bad Request: not enough rights to send text messages' }), 1)).toMatchObject({
      next: 'pause',
      groupRefused: true,
    });
  });
  it('an answer that may have published is never retried by the machine', () => {
    expect(groupVerdict(answer({ status: 0, description: 'TimeoutError: The operation was aborted' }), 1)).toEqual({
      next: 'failed',
      lastError: 'ambiguous_send',
    });
    expect(groupVerdict(answer({ status: 502 }), 1)).toEqual({ next: 'failed', lastError: 'ambiguous_send' });
    expect(groupVerdict(answer({ status: 504 }), 1)).toEqual({ next: 'failed', lastError: 'ambiguous_send' });
  });
  it('a connect fault left nothing behind and is retried, up to a bound', () => {
    const refused = answer({ status: 0, description: 'TypeError: fetch failed [ECONNREFUSED]' });
    expect(groupVerdict(refused, 1)).toEqual({ next: 'retry', notBeforeSec: 60 });
    expect(groupVerdict(refused, 8).next).toBe('failed');
  });
  it('anything else about the message is a failure in words', () => {
    expect(groupVerdict(answer({ status: 400, description: 'Bad Request: message is too long' }), 1)).toEqual({
      next: 'failed',
      lastError: 'Bad Request: message is too long',
    });
  });
});

describe('staleAfterHours', () => {
  it('praise is news for a day, the rating for three', () => {
    expect(staleAfterHours('client')).toBe(24);
    expect(staleAfterHours('won')).toBe(24);
    expect(staleAfterHours('rating')).toBe(72);
    expect(staleAfterHours('champion')).toBe(72);
  });
});
