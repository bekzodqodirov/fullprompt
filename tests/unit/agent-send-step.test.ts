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
  slotHold,
  verdictOutcome,
  type AgentOutboxRow,
  type AgentTelegram,
  type SendFacts,
  type SendTurn,
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
  humanUntil: null,
  humanPressedAt: null,
  newerSubstantiveInbound: false,
  peerHasWritten: true,
  lastInboundAt: new Date(now.getTime() - 10 * 60_000),
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
  releaseAt: null,
  lastStepAt: null,
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
    [{ humanUntil: new Date(now.getTime() + 23 * 3_600_000) }, 'human_replied'],
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

  it('his 🙋 refuses a reply already approved — for good, before any wait, and only while the chat is his (K2)', () => {
    const his = { ...facts, humanUntil: new Date(now.getTime() + 60_000) };
    const final = { ok: false, final: true, reason: 'human_replied' };
    // Night-held to the morning, flooded, or capped: the chat he took is still his, so the reply never goes.
    expect(agentSendVerdict(row, { ...his, floodUntil: new Date(now.getTime() + 3_600_000) })).toEqual(final);
    expect(agentSendVerdict(row, { ...his, sentToday: 80 })).toEqual(final);
    const night = new Date('2026-10-24T20:00:00Z'); // 01:00 Tashkent
    const atNight = { ...facts, now: night, anchorSentAt: new Date(night.getTime() - 3 * 3_600_000), lastInboundAt: null };
    const pressed = { ...row, queuedAt: new Date(night.getTime() - 60_000) };
    expect(agentSendVerdict(pressed, atNight), 'without 🙋 the night only holds it').toMatchObject({ final: false, reason: 'night' });
    expect(agentSendVerdict(pressed, { ...atNight, humanUntil: new Date(night.getTime() + 60_000) })).toEqual(final);
    // A day later the chat is the agent's again.
    expect(agentSendVerdict(row, { ...facts, humanUntil: new Date(now.getTime() - 1) })).toEqual({ ok: true });
  });

  it('his 🙋 withdraws what he approved at or before the press — never a ✅ he gives after it (K2’s follow-up)', () => {
    // 🙋 at 11:00, the chat his until 11:00 tomorrow; the row was approved at queuedAt.
    const pressedAt = new Date(now.getTime() - 4 * 3_600_000);
    const his = { ...facts, humanUntil: new Date(pressedAt.getTime() + 24 * 3_600_000), humanPressedAt: pressedAt };
    const final = { ok: false, final: true, reason: 'human_replied' };
    // His own price typed through «💵 Narx yozaman» at 14:59 and ✅'d: the man who took the chat chose to send it.
    expect(agentSendVerdict({ ...row, queuedAt: new Date(now.getTime() - 60_000) }, his)).toEqual({ ok: true });
    // A reply approved the evening before and night-held to 08:30 — that is the one the press withdrew.
    const evening = { ...row, queuedAt: new Date(pressedAt.getTime() - 12 * 3_600_000), releaseAt: new Date(pressedAt.getTime() - 2 * 3_600_000) };
    expect(agentSendVerdict(evening, { ...his, now: new Date(pressedAt.getTime() + 60_000) })).toEqual(final);
    // At the very instant of the press: withdrawn — a tie is the press's.
    expect(agentSendVerdict({ ...row, queuedAt: pressedAt }, his)).toEqual(final);
    // A takeover with no press on record withdraws everything, as before.
    expect(agentSendVerdict(row, { ...his, humanPressedAt: null })).toEqual(final);
  });

  it('refuses an approval older than six hours', () => {
    expect(agentSendVerdict({ ...row, queuedAt: new Date(now.getTime() - 7 * 3_600_000) }, facts)).toMatchObject({
      final: true,
      reason: 'approval_too_old',
    });
  });

  it('a night-held approval counts its six hours from the morning it was promised for (S2)', () => {
    // Approved at 23:00 Tashkent, held to 08:30, stepped at 09:00: 10 h after the press, 30 min after the release.
    const morning = new Date('2026-10-25T04:00:00Z'); // 09:00 Tashkent
    const held = {
      ...row,
      queuedAt: new Date('2026-10-24T18:00:00Z'), // 23:00
      releaseAt: new Date('2026-10-25T03:30:00Z'), // 08:30
    };
    const f = { ...facts, now: morning, anchorSentAt: new Date('2026-10-24T13:00:00Z'), lastInboundAt: null };
    expect(agentSendVerdict(held, f)).toEqual({ ok: true });
    // The same press with no hold recorded is the bug: cancelled at the 08:30 it was promised for.
    expect(agentSendVerdict({ ...held, releaseAt: null }, f)).toMatchObject({ final: true, reason: 'approval_too_old' });
    // Six hours past the morning is too old again.
    expect(agentSendVerdict(held, { ...f, now: new Date('2026-10-25T09:31:00Z') })).toMatchObject({
      final: true,
      reason: 'approval_too_old',
    });
  });

  it('the night rule holds a row a wait carried past 22:00 — unless the customer wrote within two hours (S3)', () => {
    const night = new Date('2026-10-24T18:00:00Z'); // 23:00 Tashkent
    const late = { ...row, queuedAt: new Date(night.getTime() - 60 * 60_000) }; // approved 22:00 by a flood's delay
    const f = { ...facts, now: night, anchorSentAt: new Date(night.getTime() - 3 * 3_600_000) };
    // He wrote three hours ago: a reply at 23:00 would wake him — 08:30 instead.
    expect(agentSendVerdict(late, { ...f, lastInboundAt: new Date(night.getTime() - 3 * 3_600_000) })).toEqual({
      ok: false,
      final: false,
      reason: 'night',
      until: new Date('2026-10-25T03:30:00Z'),
    });
    expect(agentSendVerdict(late, { ...f, lastInboundAt: null })).toMatchObject({ final: false, reason: 'night' });
    // Thirty minutes ago: he is awake and waiting.
    expect(agentSendVerdict(late, { ...f, lastInboundAt: new Date(night.getTime() - 30 * 60_000) })).toEqual({ ok: true });
    // Read and typing on his phone SECONDS ago: finishing is the less strange of the two.
    const asleep = { ...f, lastInboundAt: new Date(night.getTime() - 3 * 3_600_000) };
    expect(agentSendVerdict({ ...late, readDone: true, lastStepAt: new Date(night.getTime() - 20_000) }, asleep)).toEqual({
      ok: true,
    });
    // By day the rule says nothing.
    expect(agentSendVerdict(row, { ...facts, lastInboundAt: new Date(now.getTime() - 5 * 3_600_000) })).toEqual({ ok: true });
  });

  it('a reply whose read was before a wait of hours is a new message at night — held like any other', () => {
    // Read and typed by 21:55 Tashkent, then a SendMessage FLOOD_WAIT of two and a half hours: back at 00:25.
    const back = new Date('2026-10-24T19:25:00Z'); // 00:25 Tashkent
    const flooded = {
      ...row,
      step: 'send' as const,
      readDone: true,
      queuedAt: new Date('2026-10-24T16:50:00Z'), // approved 21:50
      lastStepAt: new Date('2026-10-24T16:55:20Z'), // the claim before the flooded send, 21:55
    };
    const f = {
      ...facts,
      now: back,
      anchorSentAt: new Date('2026-10-24T12:30:00Z'),
      lastInboundAt: new Date('2026-10-24T12:30:00Z'), // he wrote at 17:30, eleven hours ago
    };
    expect(agentSendVerdict(flooded, f)).toEqual({
      ok: false,
      final: false,
      reason: 'night',
      until: new Date('2026-10-25T03:30:00Z'),
    });
    // A restart's catch-up that kept a typing row waiting past 22:00: the same.
    const typing: AgentOutboxRow = { ...flooded, step: 'typing', lastStepAt: new Date('2026-10-24T16:58:00Z') };
    expect(
      agentSendVerdict(typing, { ...f, now: new Date('2026-10-24T17:05:00Z') }), // 22:05, seven minutes after its last step
    ).toMatchObject({ final: false, reason: 'night' });
    // Two minutes is the choreography's own length: inside it, the reply finishes.
    expect(
      agentSendVerdict({ ...flooded, lastStepAt: new Date(back.getTime() - AGENT_LIMITS.nightFinishMs) }, f),
    ).toEqual({ ok: true });
  });

  it('a verdict becomes the outcome the store writes', () => {
    expect(verdictOutcome(row, { ok: true })).toBeNull();
    expect(verdictOutcome({ readDone: true }, { ok: false, final: true, reason: 'account_paused' })).toEqual({
      kind: 'cancel',
      reason: 'account_paused',
      markUnread: true,
    });
    const until = new Date(now.getTime() + 60_000);
    expect(verdictOutcome(row, { ok: false, final: false, reason: 'night', until })).toEqual({
      kind: 'wait',
      nextStepAt: until,
      reason: 'night',
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
  const head = (msgs: [bigint, boolean, string, boolean?][]) =>
    msgs.map(([id, out, text, media]) => ({ id, out, text, media: media ?? false }));

  it('passes when nothing newer than the anchor, or only a nudge', () => {
    expect(liveHeadVerdict(head([[50n, false, 'yukim?']]), 50n, isNudge)).toEqual({ ok: true });
    expect(liveHeadVerdict(head([[51n, false, '??'], [50n, false, 'yukim?']]), 50n, isNudge)).toEqual({ ok: true });
  });

  it('stops when he answered himself, or the customer asked something new', () => {
    expect(liveHeadVerdict(head([[51n, true, 'keldi'], [50n, false, 'yukim?']]), 50n, isNudge)).toEqual({
      ok: false,
      reason: 'human_replied',
    });
    expect(liveHeadVerdict(head([[51n, false, 'narxi qancha?'], [50n, false, 'yukim?']]), 50n, isNudge)).toEqual({
      ok: false,
      reason: 'anchor_superseded',
    });
  });

  it('a photo, a voice note or a file after the question asks anew — its text is empty, not a nudge (S4)', () => {
    expect(liveHeadVerdict(head([[51n, false, '', true], [50n, false, 'yukim?']]), 50n, isNudge)).toEqual({
      ok: false,
      reason: 'anchor_superseded',
    });
    // «??» with a photo is still a photo.
    expect(liveHeadVerdict(head([[51n, false, '??', true], [50n, false, 'yukim?']]), 50n, isNudge)).toMatchObject({
      reason: 'anchor_superseded',
    });
    // A sticker reaches the head as no media (the adapter's rule): the «👍» it stands for.
    expect(liveHeadVerdict(head([[51n, false, ''], [50n, false, 'yukim?']]), 50n, isNudge)).toEqual({ ok: true });
  });

  it('a deleted anchor is noticed when the head reaches back to its place (S6)', () => {
    // Only older lines, or nothing at all: the question is gone.
    expect(liveHeadVerdict(head([[49n, true, 'salom']]), 50n, isNudge)).toEqual({ ok: false, reason: 'anchor_gone' });
    expect(liveHeadVerdict([], 50n, isNudge)).toEqual({ ok: false, reason: 'anchor_gone' });
    // Gone behind a nudge: «??» newer, the older line present, the anchor between them missing.
    expect(liveHeadVerdict(head([[52n, false, '??'], [49n, true, 'salom']]), 50n, isNudge)).toEqual({
      ok: false,
      reason: 'anchor_gone',
    });
    // A short head that holds it is fine.
    expect(liveHeadVerdict(head([[51n, false, '??'], [50n, false, 'yukim?']]), 50n, isNudge)).toEqual({ ok: true });
    // A FULL head of newer nudges cannot see that far back — the newer lines decide.
    expect(liveHeadVerdict(head([[53n, false, '??'], [52n, false, '!!'], [51n, false, '??']]), 50n, isNudge, 3)).toEqual({
      ok: true,
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
        return [{ id: 50n, out: false, text: 'yukim?', media: false }];
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
    const tg = fakeTg({ history: async () => [{ id: 51n, out: true, text: 'keldi', media: false }] });
    expect(await runAgentStep({ ...row, step: 'send', readDone: true }, deps(tg))).toEqual({
      kind: 'cancel',
      reason: 'human_replied',
      markUnread: true,
    });
  });

  it('cancels when the live head no longer holds the question (S6)', async () => {
    const tg = fakeTg({ history: async () => [{ id: 49n, out: true, text: 'salom', media: false }] });
    expect(await runAgentStep(row, deps(tg))).toEqual({ kind: 'cancel', reason: 'anchor_gone', markUnread: false });
    expect(tg.calls).not.toContain('send');
  });

  it('never sends when the claim was lost (the agent went off between ticks)', async () => {
    const tg = fakeTg();
    expect(await runAgentStep({ ...row, step: 'send' }, deps(tg, false))).toMatchObject({ kind: 'cancel' });
    expect(tg.calls).not.toContain('send');
  });

  it('the claim and the send are ONE turn of the account’s send slot, taken after the live head (S12)', async () => {
    const tg = fakeTg();
    const order: string[] = [];
    const turns: { peerId: bigint; headAt: Date }[] = [];
    let clock = now.getTime();
    const turn: SendTurn = async (t, send) => {
      turns.push(t);
      order.push(`turn after ${tg.calls.join(',')}`);
      const out = await send();
      order.push(`turn done after ${tg.calls.join(',')}`);
      return out;
    };
    const d = {
      ...deps(tg),
      store: { facts: async () => facts, claimSend: async () => (order.push('claim'), true) },
      sendTurn: turn,
      now: () => new Date((clock += 1000)),
    };
    expect(await runAgentStep({ ...row, step: 'send', readDone: true }, d)).toEqual({ kind: 'sent', tgMessageId: 77n });
    // The head outside the slot; the claim and the send inside it, in that order.
    expect(order).toEqual(['turn after history', 'claim', 'turn done after history,send']);
    // The head's instant is taken BEFORE the call: a send that left while it was on its way counts against it.
    expect(turns).toEqual([{ peerId: row.peerId, headAt: new Date(now.getTime() + 2000) }]);
  });

  it('a turn the slot refuses makes no claim and no send — the row waits and reads its head again', async () => {
    const tg = fakeTg();
    let claimed = false;
    const until = new Date(now.getTime() + 5_000);
    const held: SendTurn = async () => ({ kind: 'wait', nextStepAt: until, reason: 'slot_held' });
    const d = {
      ...deps(tg),
      store: { facts: async () => facts, claimSend: async () => (claimed = true) },
      sendTurn: held,
    };
    expect(await runAgentStep({ ...row, step: 'send', readDone: true }, d)).toEqual({
      kind: 'wait',
      nextStepAt: until,
      reason: 'slot_held',
    });
    expect(claimed).toBe(false);
    expect(tg.calls).toEqual(['history']);
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

describe('the send slot asks again when a send’s turn comes (S12’s follow-up)', () => {
  const clear = { now, floodUntil: null, restrictedAt: null, peerSentAt: null };
  const headAt = new Date(now.getTime() - 1_500);

  it('lets a turn go when nothing ahead of it changed what it knows', () => {
    expect(slotHold(clear, headAt)).toBeNull();
    expect(slotHold(clear, null)).toBeNull();
    // A send to this chat BEFORE the head was read is in the head.
    expect(slotHold({ ...clear, peerSentAt: new Date(headAt.getTime() - 1) }, headAt)).toBeNull();
  });

  it('a wait the send ahead met holds every turn, a person’s and the agent’s, until it ends', () => {
    const until = new Date(now.getTime() + 300_000);
    expect(slotHold({ ...clear, floodUntil: until }, headAt)).toEqual({ reason: 'flood_wait', until });
    expect(slotHold({ ...clear, floodUntil: until }, null)).toEqual({ reason: 'flood_wait', until });
    expect(slotHold({ ...clear, floodUntil: new Date(now.getTime() - 1) }, null)).toBeNull();
  });

  it('a restriction the send ahead met holds every turn until the guard row has it — and not for ever', () => {
    const restrictedAt = new Date(now.getTime() - 1_000);
    expect(slotHold({ ...clear, restrictedAt }, null)).toMatchObject({ reason: 'slot_held' });
    expect(slotHold({ ...clear, restrictedAt }, headAt)).toMatchObject({ reason: 'slot_held' });
    const stale = new Date(now.getTime() - AGENT_LIMITS.slotRestrictedHoldMs - 1);
    expect(slotHold({ ...clear, restrictedAt: stale }, null)).toBeNull();
  });

  it('a person’s reply to the same chat that left after the agent read its head holds the agent’s turn', () => {
    const peerSentAt = new Date(headAt.getTime() + 1_200);
    expect(slotHold({ ...clear, peerSentAt }, headAt)).toEqual({
      reason: 'slot_held',
      until: new Date(now.getTime() + AGENT_LIMITS.slotRetryMs),
    });
    // A person's own reply is never held for the chat's other sends.
    expect(slotHold({ ...clear, peerSentAt }, null)).toBeNull();
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
