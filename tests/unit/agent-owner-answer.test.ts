import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { cardAsks, cardExtra } from '@/modules/wms/agent/card';
import { ANSWER_STATUS_LINE, ANSWER_TAKEN_LINE, answeredNow, renderDraftCard, type DraftRow } from '@/modules/wms/agent/card-io';
import { numberLedger, ownerAnswerSources, type NumberSource } from '@/modules/wms/agent/numbers';
import { ANSWER_CONTACT_WORDS, answerTextRefusal, ownerAnswerInstruction } from '@/modules/wms/agent/owner-answer';
import { answerNoDraftWhy } from '@/modules/wms/agent/owner-answer-job';
import { stableHead } from '@/modules/wms/agent/prompt';
import { withRailRule, type ComposeReply, type RunResult } from '@/modules/wms/agent/run';
import type { ChatMessage } from '@/modules/wms/agent/context';

/**
 * «Bilmayman» → he answers the FACT → the AI writes the customer's words (spec SPEC-P1-v2 §2) — the pure rules: his
 * answer as a source and nothing more, what the bot refuses to take, the instruction, the card's button and lines,
 * and every way a redraft can fail being said.
 */

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function compose(over: Partial<ComposeReply> = {}): ComposeReply {
  return {
    replyNeeded: true,
    replyText: 'Aniqlab aytaman.',
    language: 'uz',
    glossUz: '',
    category: 'other',
    confidence: 0.5,
    needsOwner: false,
    ownerQuestion: '',
    nextStep: 'wait',
    actions: [],
    usedFactIds: [],
    citedMessageRefs: [],
    ...over,
  };
}

function msg(body: string): ChatMessage {
  return {
    ref: '#1',
    id: '00000000-0000-4000-8000-000000000001',
    tgMessageId: 1n,
    direction: 'in',
    body,
    media: null,
    fileName: null,
    sentAt: new Date(),
    autoSent: false,
    editedAt: null,
  };
}

function draft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: ID,
    runId: null,
    managerUserId: '00000000-0000-4000-8000-0000000000aa',
    peerId: 1n,
    clientId: null,
    leadId: null,
    identityStrength: null,
    anchorTgMessageId: 1n,
    anchorEditedAt: null,
    kind: 'reply',
    status: 'pending',
    proposedBody: 'Aniqlab aytaman.',
    finalBody: null,
    glossUz: null,
    language: 'uz',
    category: 'other',
    confidence: '0.50',
    nextStep: 'wait',
    policy: { blocks: [], warnings: [], ledger: [], notes: [], card: { customerLabel: 'GS1 · Ali', lastOut: null, customerLines: [] } },
    blocked: false,
    needsOwner: true,
    ownerQuestion: 'Suyuqlik olamizmi?',
    actions: [],
    citedMessageIds: [],
    offerId: null,
    ...over,
  } as DraftRow;
}

describe('his answer is a source, read as a fact is — for one redraft (spec §2.2)', () => {
  const ledger = (reply: string, answer: string) => numberLedger(reply, ownerAnswerSources(answer));

  it('a money figure with its currency WRITTEN vouches for the same money, as a total — and names him', () => {
    const [line] = ledger('Narxi taxminan 1200 $.', 'VED 1200$ hisobladi, mijozga ayting');
    expect(line).toMatchObject({ kind: 'money', origin: 'owner', role: 'total', source: 'sizning javobingiz' });
  });

  it('…said per unit it is a rate, and vouches for a rate only', () => {
    const src = ownerAnswerSources('kilosiga 17 $ dan');
    expect(src.find((s) => s.kind === 'money')).toMatchObject({ value: 17, role: 'rate', currency: 'USD', origin: 'owner' });
  });

  it('a bare «narxi 1200» with no currency written vouches for no price', () => {
    const src = ownerAnswerSources('narxi 1200');
    expect(src.every((s: NumberSource) => s.kind !== 'money')).toBe(true);
    expect(ledger('Narxi 1200 $.', 'narxi 1200')[0]).toMatchObject({ source: null });
  });

  it('a day count of his vouches for the same day count (the company speaking) — the gate then sees `owner`', () => {
    const [line] = ledger('Taxminan 3 kunda tayyor bo‘ladi.', 'VED 3 kunda hisoblaydi');
    expect(line).toMatchObject({ kind: 'duration', origin: 'owner' });
  });

  it('a house number in his answer never vouches for a day count (the kb plain-figure fence, §2.2)', () => {
    expect(ledger('Taxminan 29 kunda yetib keladi.', 'Ombor 29-uyda')[0]).toMatchObject({ source: null });
  });
});

describe('what the bot refuses to take as an answer (§2.2 — an address or a phone is his ✏️ text)', () => {
  it('a phone, a link, Chinese text: refused in words', () => {
    for (const text of ['Telefoni +998 90 123 45 67', 'https://example.com/manzil', '义乌市 稠州北路 2255号']) {
      expect(answerTextRefusal(text), text).toBe('contact');
    }
    expect(ANSWER_CONTACT_WORDS).toContain('✏️');
  });

  it('a plain fact is taken', () => {
    expect(answerTextRefusal('Ha, suyuqlik olmaymiz')).toBeNull();
    expect(answerTextRefusal('VED 1200$ hisobladi')).toBeNull();
  });
});

describe('the redraft’s instruction (§2.2, judge learn)', () => {
  it('quotes his words verbatim and names them a source', () => {
    const text = 'Ha, suyuqlik olmaymiz — faqat quruq yuk';
    const i = ownerAnswerInstruction(`  ${text}  `);
    expect(i).toContain(`«${text}»`);
    expect(i).toMatch(/^Bekzodning javobi \(manba/u);
  });

  it('prompt rule 1 says the task’s answer is a source too — in the cached head, once', () => {
    const head = stableHead({ styleGuide: null, facts: [], priceArmed: false });
    expect(head.match(/VAZIFAdagi Bekzodning javobi ham manba/gu)?.length).toBe(1);
  });
});

describe('«✍️ Savolga javob» on the card (§2.2)', () => {
  it('a question the MODEL raised offers it, first, and its callback parses', () => {
    const rows = buttonsFor('AgentDraft', { draftId: ID, digest: 'a1b2c3d4', live: true, blocked: false, kind: 'reply', ask: true });
    expect(rows![0]).toEqual([{ text: '✍️ Savolga javob', callback_data: `ag:j:${ID}` }]);
    expect(parseCallback(`ag:j:${ID}`)).toEqual({ kind: 'agent', op: 'j', id: ID });
    expect(parseCallback(`ag:q:${ID}`)).toBeNull();
  });

  it('…no question, a dead card, or a forced one: none', () => {
    const plain = buttonsFor('AgentDraft', { draftId: ID, digest: 'a1b2c3d4', live: true, blocked: false, kind: 'reply', ask: false });
    expect(JSON.stringify(plain)).not.toContain('ag:j:');
    expect(cardExtra({ id: ID, body: 'x', actions: [], blocked: false, live: false, kind: 'reply', ask: true }).ask).toBe(false);
    expect(cardAsks(draft())).toBe(true);
    expect(cardAsks(draft({ needsOwner: false }))).toBe(false);
    expect(cardAsks(draft({ status: 'approved' }))).toBe(false);
    expect(cardAsks(draft({ policy: { ...(draft().policy as object), forcedQuestion: 'rail' } }))).toBe(false);
    expect(cardAsks(draft({ policy: { ...(draft().policy as object), forcedQuestion: 'avia' } }))).toBe(false);
  });

  it('the rail rule records that it FORCED the question; the model’s own question carries no mark', () => {
    const forced = withRailRule(compose(), { burst: [msg("Temir yo'l bilan qancha bo'ladi?")] });
    expect(forced).toMatchObject({ needsOwner: true, forcedQuestion: 'rail' });
    const own = withRailRule(compose({ needsOwner: true, ownerQuestion: 'Suyuqlik olamizmi?' }), { burst: [msg('Atir olib kelasizmi?')] });
    expect(own.forcedQuestion).toBeUndefined();
  });

  it('while he answers, the card says where the answer goes — and once it is in, that the AI is writing', () => {
    const since = '2026-11-12T10:00:00.000Z';
    const answering = { since, until: '2026-11-12T10:30:00.000Z' };
    const waiting = draft({ status: 'editing', policy: { ...(draft().policy as object), answering } });
    expect(renderDraftCard(waiting, null)).toContain(ANSWER_STATUS_LINE);
    expect(answeredNow(waiting)).toBe(false);
    const taken = draft({ status: 'editing', policy: { ...(draft().policy as object), answering, ownerAnswer: { text: 'Ha', at: '2026-11-12T10:05:00.000Z', messageId: 7 } } });
    expect(renderDraftCard(taken, null)).toContain(ANSWER_TAKEN_LINE);
    expect(answeredNow(taken)).toBe(true);
    // An answer from an EARLIER press is no answer to this one.
    const old = draft({ status: 'editing', policy: { ...(draft().policy as object), answering, ownerAnswer: { text: 'Ha', at: '2026-11-12T09:00:00.000Z', messageId: 7 } } });
    expect(answeredNow(old)).toBe(false);
  });

  it('the question his answer superseded says so — never «↪️ Mijoz yana yozdi»', () => {
    const closed = draft({ status: 'superseded', policy: { ...(draft().policy as object), stale: 'owner_answered' } as never });
    const text = renderDraftCard(closed, null);
    expect(text).toContain('✍️ Javobingiz olindi — AI qayta yozdi');
    expect(text).not.toContain('Mijoz yana yozdi');
  });
});

describe('every way his answer makes no reply is said (§2.2)', () => {
  it('all but a draft have words', () => {
    const outcomes: RunResult[] = [
      { outcome: 'skipped', reason: 'no_fresh_inbound' },
      { outcome: 'skipped', reason: 'agent_off' },
      { outcome: 'skipped', reason: 'ai_not_configured' },
      { outcome: 'stood_down', reason: 'duplicate' },
      { outcome: 'stood_down', reason: 'question_gone' },
      { outcome: 'rescheduled', reason: 'peer_typing' },
      { outcome: 'refused', reason: 'human_active' },
      { outcome: 'capped', reason: 'daily_token_cap' },
      { outcome: 'notice', reason: 'x' },
      { outcome: 'no_reply' },
      { outcome: 'error', reason: 'wall_clock' },
    ];
    for (const out of outcomes) expect(answerNoDraftWhy(out), JSON.stringify(out)).toMatch(/\S/u);
    expect(answerNoDraftWhy({ outcome: 'draft', draftId: ID, blocked: false })).toBeNull();
  });
});

describe('the source key is his answer’s own (§2.2: one shared with another run would answer «duplicate» in silence)', () => {
  it('answer:<question>:<his message>', () => {
    const src = readFileSync('src/modules/wms/agent/owner-answer-job.ts', 'utf8');
    expect(src).toMatch(/sourceKey: `answer:\$\{q\.id\}:\$\{job\.messageId\}`/u);
  });
});
