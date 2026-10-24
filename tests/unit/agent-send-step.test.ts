import { Api } from 'telegram';
import { FloodWaitError, RPCMessageToError } from 'telegram/errors';
import { describe, expect, it } from 'vitest';
import { AGENT_LIMITS, dailySendCeiling, HUMAN_LIMITS, typingMs } from '@/modules/wms/agent/limits';
import {
  agentSendVerdict,
  choreographyPlan,
  isTashkentNight,
  liveHeadVerdict,
  nextTashkentMorning,
  releaseAt,
  runAgentStep,
  type AgentOutboxRow,
  type AgentTelegram,
  type SendFacts,
} from '@/modules/wms/agent/send-step';
import { draftWorthy, isNudge } from '@/modules/wms/agent/worthy';
import { eligibleForRun, type EligibilityFacts } from '@/modules/wms/agent/eligibility';
import { parseFloodSleep, pumpGate, tgErrorKind } from '@/modules/wms/crm/telegram-guard';

/**
 * How an approved reply leaves his account, decided without an account
 * (review build-3): the verdict, the live head, the typing, the steps, and
 * what every Telegram answer means for the account.
 */

function tgError(name: string): Error {
  return RPCMessageToError(
    new Api.RpcError({ errorCode: 400, errorMessage: name }),
    new Api.messages.SendMessage({ peer: 'me', message: 'x' }),
  );
}

const now = new Date('2026-10-24T10:00:00Z'); // 15:00 Tashkent

const facts: SendFacts = {
  now,
  agentOn: true,
  ownerUserId: 'u1',
  sendingEnabled: true,
  accountPaused: false,
  floodUntil: null,
  caughtUp: true,
  anchorSentAt: new Date(now.getTime() - 10 * 60_000),
  anchorDeleted: false,
  anchorEditedSinceDraft: false,
  humanReplied: false,
  newerSubstantiveInbound: false,
  peerHasWritten: true,
  conversationMuted: false,
  ruleExcluded: false,
  identityChanged: false,
  offerStands: null,
  sentToChatToday: 0,
  sentLastHour: 0,
  sentToday: 0,
  dailyCeiling: 80,
  lastChatSendAt: null,
  lastAccountSendAt: null,
  accountGapMs: 15_000,
};

const row: AgentOutboxRow = {
  id: 'o1',
  draftId: 'd1',
  managerUserId: 'u1',
  peerId: 100n,
  clientId: 'c1',
  leadId: null,
  body: 'Assalomu alaykum! Yukingiz keldi.',
  randomId: 987654321n,
  replyToTgMessageId: null,
  answersTgMessageId: 50n,
  status: 'agent',
  step: 'verify',
  nextStepAt: now,
  typingCount: 0,
  readDone: false,
  queuedAt: new Date(now.getTime() - 60_000),
};

describe('the fuses (ban-11)', () => {
  it('never exceed what the human queue itself respects', () => {
    expect(AGENT_LIMITS.perDay).toBeLessThanOrEqual(HUMAN_LIMITS.perDay);
    expect(AGENT_LIMITS.perHour / 60).toBeLessThanOrEqual(HUMAN_LIMITS.perMinute);
    // One AI message per chat per 20 s is fewer than the human per-chat minute cap.
    expect(60_000 / AGENT_LIMITS.perChatGapMs).toBeLessThanOrEqual(HUMAN_LIMITS.perChatPerMinute);
    expect(AGENT_LIMITS.sendJitterMs[0]).toBeGreaterThanOrEqual(60_000 / HUMAN_LIMITS.perMinute);
  });

  it('types for 3-12 seconds by length', () => {
    expect(typingMs(0)).toBe(3_000);
    expect(typingMs(150)).toBe(7_000);
    expect(typingMs(700)).toBe(12_000);
    expect(choreographyPlan('x'.repeat(700), () => 0).typingCalls).toBe(3);
    expect(choreographyPlan('ok', () => 0).typingCalls).toBe(1);
  });

  it('ramps to his own average for 14 days, then to 80 (his Q11 ⭐)', () => {
    const started = new Date(now.getTime() - 3 * 86_400_000);
    expect(dailySendCeiling({ startedAt: started, ownAverage: 23.7, now })).toBe(23);
    expect(dailySendCeiling({ startedAt: started, ownAverage: 0, now })).toBe(1);
    expect(dailySendCeiling({ startedAt: started, ownAverage: 500, now })).toBe(80);
    expect(dailySendCeiling({ startedAt: new Date(now.getTime() - 15 * 86_400_000), ownAverage: 5, now })).toBe(80);
    expect(dailySendCeiling({ startedAt: null, ownAverage: 5, now })).toBe(0);
  });
});

describe('agentSendVerdict', () => {
  it('lets a fresh approved reply go', () => {
    expect(agentSendVerdict(row, facts)).toEqual({ ok: true });
  });

  it.each([
    [{ agentOn: false }, 'agent_off'],
    [{ ownerUserId: 'u2' }, 'owner_changed'],
    [{ accountPaused: true }, 'account_paused'],
    [{ anchorDeleted: true }, 'anchor_gone'],
    [{ anchorEditedSinceDraft: true }, 'anchor_edited'],
    [{ humanReplied: true }, 'human_replied'],
    [{ newerSubstantiveInbound: true }, 'anchor_superseded'],
    [{ anchorSentAt: new Date(now.getTime() - 25 * 3_600_000) }, 'anchor_too_old'],
    [{ peerHasWritten: false }, 'never_wrote'],
    [{ conversationMuted: true }, 'muted'],
    [{ ruleExcluded: true }, 'excluded'],
    [{ identityChanged: true }, 'identity_changed'],
    [{ offerStands: false }, 'offer_gone'],
  ] as const)('refuses for good: %o → %s', (patch, reason) => {
    expect(agentSendVerdict(row, { ...facts, ...patch })).toEqual({ ok: false, final: true, reason });
  });

  it('refuses an approval older than six hours', () => {
    expect(agentSendVerdict({ ...row, queuedAt: new Date(now.getTime() - 7 * 3_600_000) }, facts)).toMatchObject({
      final: true,
      reason: 'approval_too_old',
    });
  });

  it('waits — never cancels — for a flood, the catch-up, the gaps and the caps', () => {
    const flood = new Date(now.getTime() + 30_000);
    expect(agentSendVerdict(row, { ...facts, floodUntil: flood })).toEqual({
      ok: false,
      final: false,
      reason: 'flood_wait',
      until: flood,
    });
    expect(agentSendVerdict(row, { ...facts, caughtUp: false })).toMatchObject({ final: false, reason: 'not_caught_up' });
    expect(agentSendVerdict(row, { ...facts, lastChatSendAt: new Date(now.getTime() - 5_000) })).toMatchObject({
      final: false,
      reason: 'chat_gap',
    });
    expect(agentSendVerdict(row, { ...facts, lastAccountSendAt: new Date(now.getTime() - 5_000) })).toMatchObject({
      final: false,
      reason: 'account_gap',
    });
    expect(agentSendVerdict(row, { ...facts, sentLastHour: 20 })).toMatchObject({ final: false, reason: 'hour_cap' });
    expect(agentSendVerdict(row, { ...facts, sentToday: 23, dailyCeiling: 23 })).toMatchObject({
      final: false,
      reason: 'day_cap',
    });
    expect(agentSendVerdict(row, { ...facts, sentToChatToday: 12 })).toMatchObject({ final: false, reason: 'chat_day_cap' });
  });
});

describe('the live head (ban-3)', () => {
  const head = (msgs: [bigint, boolean, string][]) => msgs.map(([id, out, text]) => ({ id, out, text }));

  it('passes when nothing newer than the anchor, or only a nudge', () => {
    expect(liveHeadVerdict(head([[50n, false, 'yukim?']]), 50n, isNudge)).toEqual({ ok: true });
    expect(liveHeadVerdict(head([[51n, false, '??'], [50n, false, 'yukim?']]), 50n, isNudge)).toEqual({ ok: true });
  });

  it('stops when he answered himself, or the customer asked something new', () => {
    expect(liveHeadVerdict(head([[51n, true, 'keldi']]), 50n, isNudge)).toEqual({ ok: false, reason: 'human_replied' });
    expect(liveHeadVerdict(head([[51n, false, 'narxi qancha?']]), 50n, isNudge)).toEqual({
      ok: false,
      reason: 'anchor_superseded',
    });
  });
});

describe('the night (his Q14 ⭐)', () => {
  it('knows Tashkent night', () => {
    expect(isTashkentNight(new Date('2026-10-24T17:30:00Z'))).toBe(true); // 22:30
    expect(isTashkentNight(new Date('2026-10-24T03:30:00Z'))).toBe(false); // 08:30
  });

  it('sends at once by day, at night only when the customer wrote within two hours', () => {
    const night = new Date('2026-10-24T18:00:00Z'); // 23:00 Tashkent
    expect(releaseAt(now, null)).toEqual(now);
    expect(releaseAt(night, new Date(night.getTime() - 30 * 60_000))).toEqual(night);
    expect(releaseAt(night, new Date(night.getTime() - 3 * 3_600_000))).toEqual(new Date('2026-10-25T03:30:00Z'));
    expect(nextTashkentMorning(new Date('2026-10-25T01:00:00Z'))).toEqual(new Date('2026-10-25T03:30:00Z'));
  });
});

describe('runAgentStep', () => {
  function fakeTg(over: Partial<AgentTelegram> = {}): AgentTelegram & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      history: async () => {
        calls.push('history');
        return [{ id: 50n, out: false, text: 'yukim?' }];
      },
      readHistory: async () => void calls.push('read'),
      setTyping: async () => void calls.push('typing'),
      markUnread: async () => void calls.push('unread'),
      send: async () => {
        calls.push('send');
        return { tgMessageId: 77n };
      },
      ...over,
    };
  }
  const store = (claim = true) => ({ facts: async () => facts, claimSend: async () => claim });
  const deps = (tg: AgentTelegram, claim = true) => ({
    tg,
    store: store(claim),
    classify: tgErrorKind,
    isNudge,
    now: () => now,
    random: () => 0,
  });

  it('walks verify → read → typing → send', async () => {
    const tg = fakeTg();
    expect(await runAgentStep(row, deps(tg))).toMatchObject({ kind: 'advance', step: 'read' });
    expect(await runAgentStep({ ...row, step: 'read' }, deps(tg))).toMatchObject({
      kind: 'advance',
      step: 'typing',
      readDone: true,
    });
    expect(await runAgentStep({ ...row, step: 'typing', readDone: true }, deps(tg))).toMatchObject({
      kind: 'advance',
      step: 'send',
      typingCount: 1,
    });
    expect(await runAgentStep({ ...row, step: 'send', readDone: true }, deps(tg))).toEqual({
      kind: 'sent',
      tgMessageId: 77n,
    });
    expect(tg.calls).toEqual(['history', 'read', 'typing', 'history', 'send']);
  });

  it('cancels before the send when he answered on his phone, and asks to mark the chat unread', async () => {
    const tg = fakeTg({ history: async () => [{ id: 51n, out: true, text: 'keldi' }] });
    expect(await runAgentStep({ ...row, step: 'send', readDone: true }, deps(tg))).toEqual({
      kind: 'cancel',
      reason: 'human_replied',
      markUnread: true,
    });
  });

  it('never sends when the claim was lost (the agent went off between ticks)', async () => {
    const tg = fakeTg();
    expect(await runAgentStep({ ...row, step: 'send' }, deps(tg, false))).toMatchObject({ kind: 'cancel' });
    expect(tg.calls).not.toContain('send');
  });

  it('classifies every Telegram answer to the send', async () => {
    const send = (err: Error) => runAgentStep({ ...row, step: 'send' }, deps(fakeTg({ send: async () => Promise.reject(err) })));
    expect(await send(tgError('RANDOM_ID_DUPLICATE'))).toEqual({ kind: 'sent', tgMessageId: null });
    expect(await send(tgError('PEER_FLOOD'))).toMatchObject({ kind: 'failed', error: { kind: 'restricted', pause: 'peer_flood' } });
    expect(await send(tgError('USER_IS_BLOCKED'))).toMatchObject({ kind: 'failed', error: { kind: 'recipient_final' } });
    const flood = new FloodWaitError({ request: new Api.messages.SendMessage({ peer: 'me', message: 'x' }), capture: 30 });
    expect(await send(flood)).toMatchObject({ kind: 'flooded', seconds: 30 });
    expect(await send(new Error('Request timed out'))).toMatchObject({ kind: 'unknown' });
  });
});

describe('what a Telegram error means for the account (ban-1)', () => {
  it('reads the errors gramjs builds', () => {
    expect(tgErrorKind(tgError('PEER_FLOOD'))).toMatchObject({ kind: 'restricted', pause: 'peer_flood' });
    expect(tgErrorKind(tgError('USER_RESTRICTED'))).toMatchObject({ kind: 'restricted', pause: 'restricted' });
    expect(tgErrorKind(tgError('FROZEN_METHOD_INVALID'))).toMatchObject({ kind: 'restricted', pause: 'frozen' });
    expect(tgErrorKind(tgError('AUTH_KEY_DUPLICATED'))).toMatchObject({ kind: 'session' });
    expect(tgErrorKind(tgError('USER_PRIVACY_RESTRICTED'))).toMatchObject({ kind: 'recipient_final' });
    expect(tgErrorKind(tgError('MESSAGE_TOO_LONG'))).toMatchObject({ kind: 'message_final' });
    expect(tgErrorKind(new Error('getaddrinfo EAI_AGAIN postgres'))).toMatchObject({ kind: 'db' });
  });

  it('gates every claim on the switch, the pause and the wait', () => {
    expect(pumpGate({ sendingEnabled: true, pausedAt: null, floodUntil: null, now })).toEqual({ ok: true });
    expect(pumpGate({ sendingEnabled: false, pausedAt: null, floodUntil: null, now })).toMatchObject({ reason: 'sending_disabled' });
    expect(pumpGate({ sendingEnabled: true, pausedAt: now, floodUntil: null, now })).toMatchObject({ reason: 'account_paused' });
    expect(
      pumpGate({ sendingEnabled: true, pausedAt: null, floodUntil: new Date(now.getTime() + 1000), now }),
    ).toMatchObject({ reason: 'flood_wait' });
  });

  it('reads gramjs’s own sleep line', () => {
    expect(parseFloodSleep('Sleeping for 12s on flood wait (Caused by messages.SendMessage)')).toEqual({
      seconds: 12,
      method: 'messages.SendMessage',
    });
    expect(parseFloodSleep('Connecting to 149.154.167.51')).toBeNull();
  });
});

describe('draftWorthy (fit-1)', () => {
  const m = (text: string | null, media: string | null = null) => ({ text, media });
  it('no run for stickers, photos without a caption, a closing after our statement', () => {
    expect(draftWorthy([m(null, 'sticker')], false)).toEqual({ worthy: false, reason: 'media_only' });
    expect(draftWorthy([m('rahmat'), m('👍')], false)).toEqual({ worthy: false, reason: 'closing' });
    expect(draftWorthy([m('ok')], true)).toEqual({ worthy: true, greetingOnly: false });
  });
  it('a notice, not a draft, for voice, Pashto and «are you a bot»', () => {
    expect(draftWorthy([m(null, 'voice')], false)).toMatchObject({ reason: 'voice_only', notice: true });
    expect(draftWorthy([m('ستاسو بار څه وخت راځي')], false)).toMatchObject({ reason: 'pashto', notice: true });
    expect(draftWorthy([m('Siz botmisiz?')], false)).toMatchObject({ reason: 'bot_question', notice: true });
  });
  it('a greeting-only burst is marked so the worker waits for the question', () => {
    expect(draftWorthy([m('Assalomu alaykum')], false)).toEqual({ worthy: true, greetingOnly: true });
    expect(draftWorthy([m('Assalomu alaykum'), m('5 kub yuk bor, qancha bo‘ladi?')], false)).toEqual({
      worthy: true,
      greetingOnly: false,
    });
  });
});

describe('eligibleForRun (§17.4)', () => {
  const f: EligibilityFacts = {
    now,
    agentOn: true,
    sessionConfirmed: true,
    listenerCurrent: true,
    accountPaused: false,
    privateUser: true,
    hasOwner: true,
    ruleExcluded: false,
    peerIsStaff: false,
    muted: false,
    humanActive: false,
    anchorIsNewest: true,
    anchorSentAt: new Date(now.getTime() - 60_000),
    anchorAutoSent: false,
    lastOutAt: null,
    anchorRepeats: false,
  };
  it('passes a fresh customer question', () => expect(eligibleForRun(f)).toEqual({ ok: true }));
  it.each([
    [{ agentOn: false }, 'agent_off'],
    [{ sessionConfirmed: false }, 'session_not_confirmed'],
    [{ listenerCurrent: false }, 'listener_behind'],
    [{ peerIsStaff: true }, 'staff_peer'],
    [{ humanActive: true }, 'human_active'],
    [{ anchorAutoSent: true }, 'auto_sent'],
    [{ lastOutAt: new Date(now.getTime() - 62_000) }, 'echo'],
    [{ anchorRepeats: true }, 'repeat'],
    [{ anchorSentAt: new Date(now.getTime() - 25 * 3_600_000) }, 'too_old'],
  ] as const)('refuses %o → %s', (patch, reason) => {
    expect(eligibleForRun({ ...f, ...patch })).toEqual({ ok: false, reason });
  });
});
