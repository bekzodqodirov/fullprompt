// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NIGHT_SILENT_TYPES, sendsSilently } from '@/modules/platform/notifications/night';
import { UNMUTABLE_TYPES } from '@/modules/platform/notifications/mutes';
import { AgentWaitingBubble } from '@/components/agent-waiting-bubble';
import { renderDraftCard, type DraftRow } from '@/modules/wms/agent/card-io';
import { ownerQuestionReminderText } from '@/modules/wms/agent/jobs';

/**
 * The final review's identity/owner package (K28 …), as pure checks: what
 * the owner was promised and what a table or a function says, with no
 * database. The behaviour behind a database lives in
 * `tests/integration/agent-ident.integration.test.ts`.
 */

/** A Tashkent wall-clock time as the instant it is (UTC+5, no daylight saving). */
const tk = (local: string) => new Date(`${local}:00+05:00`);

describe('the agent’s cards at night (K28, his first-set 6 ⭐a)', () => {
  const night = tk('2026-10-25T02:00');
  const lateEvening = tk('2026-10-24T22:00');
  const morning = tk('2026-10-25T08:00');

  it('a draft, a stranger, a calc answer and a notice arrive WITHOUT a sound 22:00-08:00 — and ring by day', () => {
    for (const type of ['AgentDraft', 'AgentStranger', 'AgentCalcAnswered', 'AgentNotice']) {
      expect(sendsSilently(type, {}, night), type).toBe(true);
      expect(sendsSilently(type, {}, lateEvening), `${type} at 22:00`).toBe(true);
      expect(sendsSilently(type, {}, morning), `${type} at 08:00`).toBe(false);
    }
  });

  it('the three alarms stay LOUD at any hour — their silence costs the account', () => {
    for (const type of ['AgentForcedOff', 'TgAccountPaused', 'AgentCapReached']) {
      expect(sendsSilently(type, {}, night), type).toBe(false);
      expect(NIGHT_SILENT_TYPES.has(type), type).toBe(false);
    }
  });

  it('every night-silent agent type is one of the agent’s own cards — nothing else learned a quiet night', () => {
    const agentTypes = new Set<string>(UNMUTABLE_TYPES);
    for (const type of NIGHT_SILENT_TYPES) {
      if (type === 'InboundLeadArrived') continue;
      expect(agentTypes.has(type), type).toBe(true);
    }
  });
});

describe('a card says why in words, never a code (K34, K26, K2)', () => {
  const row = (over: Record<string, unknown>) =>
    ({
      id: 'd',
      status: 'approved',
      kind: 'reply',
      finalBody: null,
      proposedBody: 'Yukingiz yo‘lda.',
      glossUz: null,
      needsOwner: false,
      ownerQuestion: null,
      actions: [],
      policy: {},
      actionStatus: null,
      actionError: null,
      ...over,
    }) as unknown as DraftRow;
  const outbox = (over: Record<string, unknown>) =>
    ({ status: 'failed', lastError: null, nextStepAt: new Date(), sentAt: null, ...over }) as never;

  it('a Telegram refusal of the send is a sentence — the code stays on the row for the log', () => {
    const text = renderDraftCard(row({}), outbox({ lastError: 'USER_IS_BLOCKED 400: USER_IS_BLOCKED (caused by messages.SendMessage)' }));
    expect(text).toContain('mijoz akkauntni bloklagan');
    expect(text).not.toContain('USER_IS_BLOCKED');
    const unknown = renderDraftCard(row({}), outbox({ lastError: 'Some gramjs stack trace 0x1f' }));
    expect(unknown).not.toContain('0x1f');
    expect(unknown).toContain('Telegram rad etdi');
  });

  it('a cancellation for a reason with no word of its own says «bekor qilindi», never the raw reason', () => {
    const text = renderDraftCard(row({}), outbox({ status: 'cancelled', lastError: 'weird_reason: details' }));
    expect(text).toContain('bekor qilindi');
    expect(text).not.toContain('weird_reason');
  });

  it('🙋 on another card cancels a waiting reply — and that card says so (K2)', () => {
    const text = renderDraftCard(row({}), outbox({ status: 'cancelled', lastError: 'taken_over: 🙋 he took the chat over for 24 hours' }));
    expect(text).toContain("suhbatni o'zingizga oldingiz");
  });

  it('a calculation the queue refused: the waiting draft and an approved one say the reason in words (K26)', () => {
    const waiting = renderDraftCard(row({ status: 'pending', actionStatus: 'failed', actionError: 'too_many_open' }), null);
    expect(waiting).toContain('20 ta ochiq so‘rov');
    expect(waiting).not.toContain('too_many_open');
    expect(waiting).not.toMatch(/Kartadan qo.lda yuboring/u);
    const approved = renderDraftCard(row({ actionStatus: 'failed', actionError: 'too_many_open' }), null);
    expect(approved).toContain('20 ta ochiq so‘rov');
    expect(approved).not.toContain('too_many_open');
    const thrown = renderDraftCard(row({ actionStatus: 'failed', actionError: 'relation "x" does not exist' }), null);
    expect(thrown).not.toContain('relation');
  });
});

describe('the waiting bubble keeps its label readable at 360 px (K34)', () => {
  it('the header wraps, and the cancel’s refusal takes a line of its own', () => {
    const html = renderToStaticMarkup(h(AgentWaitingBubble, { body: 'Javob', text: '🤖 08:30 da ketadi', action: h('span', { 'data-x': 1 }) }));
    const header = /<div class="([^"]*)"><span class="min-w-0 flex-1">/u.exec(html)?.[1] ?? '';
    expect(header, 're-anchor: the bubble header').not.toBe('');
    expect(header.split(/\s+/u)).toContain('flex-wrap');
    const button = readFileSync('src/components/agent-cancel-button.tsx', 'utf8');
    // The refusal is an item of the ROW (`contents`) on a whole line (`basis-full`), never beside the button.
    expect(button).toMatch(/<span className="contents">/u);
    expect(button).toMatch(/className="order-last basis-full[^"]*" data-testid="agent-cancel-error"/u);
  });

  it('the page’s cap hint says what it counts — every run, and what 0 does', () => {
    const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { agentAi: Record<string, string> };
    expect(uz.agentAi.numDraftsHint).toBe('AI kuniga necha marta ishga tushadi (0 — umuman ishlamaydi).');
  });
});

describe('his unanswered question’s reminder (K30, his 14)', () => {
  it('is a count — no customer, no code, no line of the chat', () => {
    const text = ownerQuestionReminderText(3);
    expect(text).toContain('30 daqiqa');
    expect(text).toContain('3 ta');
    expect(text).not.toMatch(/GS\d|«[^»]*»\s*:/u);
  });
});
