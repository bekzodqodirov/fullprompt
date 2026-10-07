import { describe, expect, it } from 'vitest';
import {
  decideAdoption,
  decideJoin,
  decideMemberUpdate,
  decideVet,
  missingRights,
} from '@/modules/platform/telegram/price-channel-rules';
import { channelVerdict } from '@/modules/wms/calc/channel-send';

/**
 * The price channel's decisions, each a table (his F, 2026-10-07). The handlers
 * and the drain are thin shells over these, so the whole policy — who may make
 * a channel known, which channel is safe, who may be in it, and what a send's
 * answer means for the row — is read here without a network.
 */
const CHAT = '-1001234567890';

describe('decideJoin — F8 a', () => {
  it('ignores another chat, approves a colleague, declines anybody else', () => {
    expect(decideJoin({ chatId: '-100999', configuredChatId: CHAT, eligible: { userId: 'u' } })).toEqual({ act: 'ignore' });
    expect(decideJoin({ chatId: CHAT, configuredChatId: null, eligible: { userId: 'u' } })).toEqual({ act: 'ignore' });
    expect(decideJoin({ chatId: CHAT, configuredChatId: CHAT, eligible: { userId: 'u' } })).toEqual({ act: 'approve', userId: 'u' });
    expect(decideJoin({ chatId: CHAT, configuredChatId: CHAT, eligible: null })).toEqual({ act: 'decline' });
  });
});

describe('decideAdoption — only a settings admin makes a channel known', () => {
  const ask = (o: Partial<Parameters<typeof decideAdoption>[0]>) =>
    decideAdoption({
      chatType: 'channel',
      newStatus: 'administrator',
      rowExists: false,
      hasConnected: false,
      adderIsSettingsAdmin: true,
      ...o,
    });
  it('the table', () => {
    expect(ask({ chatType: 'private' })).toBe('ignore');
    expect(ask({ chatType: 'supergroup' })).toBe('ignore');
    expect(ask({})).toBe('adopt');
    expect(ask({ newStatus: 'creator' })).toBe('adopt');
    expect(ask({ hasConnected: true })).toBe('record');
    expect(ask({ adderIsSettingsAdmin: false })).toBe('ignore');
    expect(ask({ adderIsSettingsAdmin: false, rowExists: true })).toBe('update');
    expect(ask({ newStatus: 'left', rowExists: true })).toBe('update');
    expect(ask({ newStatus: 'kicked', rowExists: true })).toBe('update');
  });
});

describe('decideVet — a channel safe to post prices into', () => {
  const vet = (o: Partial<Parameters<typeof decideVet>[0]>) =>
    decideVet({ username: null, memberCount: 2, adminCount: 2, botCanPost: true, liveMembers: 0, ...o });
  it('the table', () => {
    expect(vet({ username: 'x' })).toEqual({ verdict: 'public' });
    expect(vet({ memberCount: 5, adminCount: 2, liveMembers: 0 })).toEqual({ verdict: 'has_members', count: 3 });
    expect(vet({ memberCount: 5, adminCount: 2, liveMembers: 3 })).toEqual({ verdict: 'ok' });
    expect(vet({})).toEqual({ verdict: 'ok' });
    expect(vet({ botCanPost: false })).toEqual({ verdict: 'bot_not_admin' });
  });
});

describe('decideMemberUpdate — whoever becomes a member is checked', () => {
  const ask = (o: Partial<Parameters<typeof decideMemberUpdate>[0]>) =>
    decideMemberUpdate({
      chatId: CHAT,
      configuredChatId: CHAT,
      targetIsBot: false,
      targetIsSelf: false,
      oldStatus: 'left',
      newStatus: 'member',
      eligible: { userId: 'u' },
      ...o,
    });
  it('the table', () => {
    expect(ask({ chatId: '-100999' })).toBe('ignore');
    expect(ask({ targetIsSelf: true })).toBe('ignore');
    expect(ask({ newStatus: 'administrator' })).toBe('ignore');
    expect(ask({})).toBe('admit');
    expect(ask({ eligible: null })).toBe('evict');
    expect(ask({ targetIsBot: true })).toBe('evict');
    expect(ask({ newStatus: 'restricted', isMember: true, eligible: null })).toBe('evict');
    expect(ask({ oldStatus: 'member', newStatus: 'left' })).toBe('left');
    expect(ask({ oldStatus: 'member', newStatus: 'kicked' })).toBe('left');
  });
});

describe('missingRights', () => {
  it('names every right the bot lacks', () => {
    expect(missingRights({ can_post_messages: true })).toEqual(['edit', 'invite', 'restrict']);
    expect(
      missingRights({ can_post_messages: true, can_edit_messages: true, can_invite_users: true, can_restrict_members: true }),
    ).toEqual([]);
  });
});

describe('channelVerdict — never a double post', () => {
  const r = (status: number, description = '', extra: { retryAfter?: number; botDown?: boolean; ok?: boolean } = {}) => ({
    ok: extra.ok ?? false,
    status,
    description,
    retryAfter: extra.retryAfter ?? null,
    botDown: extra.botDown ?? false,
  });
  it('the table', () => {
    expect(channelVerdict(r(200, '', { ok: true }), 1)).toEqual({ next: 'sent' });
    expect(channelVerdict(r(429, 'Too Many Requests', { retryAfter: 30 }), 1)).toEqual({
      next: 'retry',
      notBeforeSec: 30,
      refund: true,
    });
    expect(channelVerdict(r(401, 'Unauthorized', { botDown: true }), 1).next).toBe('pause');
    expect(channelVerdict(r(0, 'no_bot_token'), 1).next).toBe('pause');
    expect(channelVerdict(r(403, 'Forbidden: bot is not a member of the channel chat'), 1)).toMatchObject({
      next: 'pause',
      channelRefused: true,
    });
    expect(channelVerdict(r(400, 'Bad Request: not enough rights to send text messages'), 1).next).toBe('pause');
    expect(channelVerdict(r(400, 'Bad Request: message text is empty'), 1)).toEqual({
      next: 'failed',
      lastError: 'Bad Request: message text is empty',
    });
    expect(channelVerdict(r(500, 'Internal Server Error'), 1).next).toBe('retry');
    expect(channelVerdict(r(502, 'Bad Gateway'), 1)).toEqual({ next: 'failed', lastError: 'ambiguous_send' });
    expect(channelVerdict(r(504, 'Gateway Timeout'), 1)).toEqual({ next: 'failed', lastError: 'ambiguous_send' });
    expect(channelVerdict(r(0, 'TimeoutError: The operation was aborted due to timeout'), 1)).toEqual({
      next: 'failed',
      lastError: 'ambiguous_send',
    });
    expect(channelVerdict(r(0, 'Error: ECONNRESET'), 1)).toEqual({ next: 'failed', lastError: 'ambiguous_send' });
    expect(channelVerdict(r(0, 'TypeError: fetch failed [ECONNREFUSED]'), 1)).toEqual({
      next: 'retry',
      notBeforeSec: 60,
      refund: false,
    });
    expect(channelVerdict(r(0, 'TypeError: fetch failed [ENOTFOUND]'), 8)).toEqual({
      next: 'failed',
      lastError: 'TypeError: fetch failed [ENOTFOUND]',
    });
  });
});
