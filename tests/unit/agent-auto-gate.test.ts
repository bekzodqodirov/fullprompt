import { describe, expect, it } from 'vitest';
import {
  AUTO_REFUSALS,
  AUTO_REFUSAL_WORDS,
  AUTO_SEND_CATEGORIES,
  MONEY_TOOLS,
  autoVerdict,
  type AutoGateInput,
  type AutoRefusal,
} from '@/modules/wms/agent/auto-gate';
import { AUTO_CATEGORIES, calibrationCells, categoryVerdicts, type CalibrationDraftRow } from '@/modules/wms/agent/calibration';
import { agentStats, type StatsDraftRow } from '@/modules/wms/agent/stats';
import { TOOL_SPECS } from '@/modules/wms/agent/tools';

/**
 * «O'zi yuborish»'s gate (docs/AI-SOTUVCHI.md §18.3, his answer of
 * 2026-11-11). Pure: every refusal is driven from ONE eligible input by one
 * change, the verdict lists EVERY reason in a stable order, and each code has
 * words. Then the counting: a reply the machine pressed is nobody's decision,
 * so it never enters the rate the page prints or the calibration table.
 */

/** 12:00 Tashkent — a working day's noon. */
const NOON = new Date('2026-11-11T07:00:00Z');
/** 23:00 Tashkent — the pump's night (send-step `isTashkentNight`). */
const NIGHT = new Date('2026-11-11T18:00:00Z');

function eligible(): AutoGateInput {
  return {
    config: { armed: true, categories: [...AUTO_SEND_CATEGORIES], maxChars: 400, minConfidence: 0.8, perDay: 30 },
    agentOn: true,
    draft: {
      kind: 'reply',
      status: 'pending',
      ownText: false,
      blocked: false,
      needsOwner: false,
      warnings: 0,
      notes: 0,
      actionTypes: [],
      category: 'greeting',
      language: 'uz',
      body: 'Assalomu alaykum! Qanday yordam bera olaman?',
      confidence: 0.9,
      moneyLedger: false,
      hasEstimate: false,
    },
    tools: [],
    burstMedia: false,
    chat: { hasOwner: true, prospect: false, offUntil: null, humanUntil: null, muted: false },
    workAccount: true,
    at: NOON,
    now: NOON,
    streak: 0,
    pressedToday: 0,
    budgetLeft: 10,
    sendingEnabled: true,
    listenerCurrent: true,
  };
}

/** One change per refusal — the eligible input with exactly that one fact turned. */
const ONE_CHANGE: Record<AutoRefusal, (i: AutoGateInput) => void> = {
  not_armed: (i) => (i.config.armed = false),
  agent_off: (i) => (i.agentOn = false),
  not_reply: (i) => (i.draft.kind = 'price'),
  not_pending: (i) => (i.draft.status = 'editing'),
  blocked: (i) => (i.draft.blocked = true),
  needs_owner: (i) => (i.draft.needsOwner = true),
  warnings: (i) => (i.draft.warnings = 1),
  notes: (i) => (i.draft.notes = 1),
  actions: (i) => (i.draft.actionTypes = ['calc_submit']),
  money: (i) => (i.tools = [{ name: 'own_balance', ok: true }]),
  category: (i) => (i.draft.category = 'price'),
  status_unbacked: (i) => (i.draft.category = 'status'),
  language: (i) => (i.draft.language = 'en'),
  media: (i) => (i.burstMedia = true),
  too_long: (i) => (i.draft.body = 'x'.repeat(401)),
  low_confidence: (i) => (i.draft.confidence = 0.79),
  stranger: (i) => (i.chat.hasOwner = false),
  prospect: (i) => (i.chat.prospect = true),
  chat_off: (i) => (i.chat.offUntil = new Date(NOON.getTime() + 60_000)),
  // His 🙋 «Suhbat meniki» and a chat the AI was muted in (final check): the chat is not the machine's to answer.
  human_active: (i) => (i.chat.humanUntil = new Date(NOON.getTime() + 60_000)),
  chat_muted: (i) => (i.chat.muted = true),
  not_work_account: (i) => (i.workAccount = false),
  night: (i) => (i.at = NIGHT),
  streak: (i) => (i.streak = 2),
  daily_cap: (i) => (i.pressedToday = 30),
  // The ✅'s own refusals that are already facts at the scheduling (fix pass A, C8).
  budget_spent: (i) => (i.budgetLeft = 0),
  sending_disabled: (i) => (i.sendingEnabled = false),
  listener_behind: (i) => (i.listenerCurrent = false),
};

describe('the gate', () => {
  it('an ordinary greeting on a work number, by day, armed, goes by itself', () => {
    expect(autoVerdict(eligible())).toEqual({ eligible: true, reasons: [] });
  });

  it.each(AUTO_REFUSALS.map((r) => [r] as const))('%s — refused by its own fact, and by nothing else', (code) => {
    const input = eligible();
    ONE_CHANGE[code](input);
    expect(autoVerdict(input)).toEqual({ eligible: false, reasons: [code] });
  });

  it('collects EVERY reason, in the one stable order — never the first alone', () => {
    const input = eligible();
    for (const code of [...AUTO_REFUSALS].reverse()) {
      // status_unbacked and category both turn the category: the last one written wins, so set it last by hand.
      if (code === 'category' || code === 'status_unbacked') continue;
      ONE_CHANGE[code](input);
    }
    input.draft.category = 'status';
    const out = autoVerdict(input);
    expect(out.eligible).toBe(false);
    expect(out.reasons).toEqual(AUTO_REFUSALS.filter((r) => r !== 'category'));
    // …and a category outside the chosen set is the category's own refusal beside it.
    input.config.categories = ['greeting'];
    expect(autoVerdict(input).reasons).toEqual([...AUTO_REFUSALS]);
  });

  it('at the press the three facts the ✅ asks itself are not the gate’s (null): the scheduling alone judges them', () => {
    const input = eligible();
    input.budgetLeft = null;
    input.sendingEnabled = null;
    input.listenerCurrent = null;
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
  });

  it('every refusal has words, and no word is a code', () => {
    expect(Object.keys(AUTO_REFUSAL_WORDS).sort()).toEqual([...AUTO_REFUSALS].sort());
    for (const code of AUTO_REFUSALS) {
      expect(AUTO_REFUSAL_WORDS[code].length).toBeGreaterThan(5);
      expect(AUTO_REFUSAL_WORDS[code]).not.toMatch(/^[a-z_]+$/u);
    }
  });

  it('a 🙋 that has run out is no refusal — the chat is the layer’s again; one still running refuses at any press', () => {
    const input = eligible();
    input.chat.humanUntil = new Date(NOON.getTime() - 60_000);
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
    input.chat.humanUntil = new Date(NOON.getTime() + 23 * 3_600_000);
    expect(autoVerdict(input).reasons).toEqual(['human_active']);
  });

  it('his own words on the card are never the machine’s to send — a pending draft he wrote for is not pending for auto', () => {
    const input = eligible();
    input.draft.ownText = true;
    expect(autoVerdict(input).reasons).toEqual(['not_pending']);
  });

  it('money makes it price whatever the model labelled it: each money tool, the ledger, an estimate', () => {
    for (const name of MONEY_TOOLS) {
      const input = eligible();
      // Called is enough — a refused estimate was still asked for a price.
      input.tools = [{ name, ok: false }];
      expect(autoVerdict(input).reasons, name).toEqual(['money']);
    }
    const ledger = eligible();
    ledger.draft.moneyLedger = true;
    expect(autoVerdict(ledger).reasons).toEqual(['money']);
    const estimate = eligible();
    estimate.draft.hasEstimate = true;
    expect(autoVerdict(estimate).reasons).toEqual(['money']);
  });

  it('the money tools are tools the agent really has, and the ones that are not money stay out', () => {
    const names = TOOL_SPECS.map((t) => t.name);
    for (const t of MONEY_TOOLS) expect(names).toContain(t);
    for (const name of ['cargo_status', 'kb_search', 'cargo_volume', 'calc_checklist']) {
      const input = eligible();
      input.tools = [{ name, ok: true }];
      expect(autoVerdict(input).eligible, name).toBe(true);
    }
  });

  it('«status» goes only when the cargo was READ — and read ok', () => {
    const input = eligible();
    input.draft.category = 'status';
    input.tools = [{ name: 'cargo_status', ok: false }];
    expect(autoVerdict(input).reasons).toEqual(['status_unbacked']);
    input.tools = [{ name: 'cargo_status', ok: true }];
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
  });

  it('only the four kinds ever, and only the ones he chose', () => {
    for (const category of ['price', 'complaint', 'other', null]) {
      const input = eligible();
      input.draft.category = category;
      input.config.categories = ['greeting', 'qualification', 'faq', 'status', 'price', 'complaint', 'other'];
      expect(autoVerdict(input).reasons, String(category)).toEqual(['category']);
    }
    const unchosen = eligible();
    unchosen.config.categories = ['faq'];
    expect(autoVerdict(unchosen).reasons).toEqual(['category']);
  });

  it('a follow-up date is the one action that may ride along', () => {
    const input = eligible();
    input.draft.actionTypes = ['set_followup'];
    expect(autoVerdict(input).eligible).toBe(true);
    input.draft.actionTypes = ['set_followup', 'mute'];
    expect(autoVerdict(input).reasons).toEqual(['actions']);
  });

  it('the boundaries: 400 characters go, 0.80 goes, a missing confidence does not, a chat off until now is on again', () => {
    const at = eligible();
    at.draft.body = 'x'.repeat(400);
    at.draft.confidence = 0.8;
    expect(autoVerdict(at).eligible).toBe(true);
    const none = eligible();
    none.draft.confidence = null;
    expect(autoVerdict(none).reasons).toEqual(['low_confidence']);
    const off = eligible();
    off.chat.offUntil = NOON;
    expect(autoVerdict(off).eligible).toBe(true);
    const day = eligible();
    day.pressedToday = 29;
    day.streak = 1;
    expect(autoVerdict(day).eligible).toBe(true);
  });

  it('the night is the pump’s own: 22:00-08:00 Tashkent, judged at the moment the reply would go', () => {
    const at = (iso: string) => {
      const input = eligible();
      input.at = new Date(iso);
      return autoVerdict(input).reasons;
    };
    expect(at('2026-11-11T16:59:00Z')).toEqual([]); // 21:59
    expect(at('2026-11-11T17:00:00Z')).toEqual(['night']); // 22:00
    expect(at('2026-11-12T02:59:00Z')).toEqual(['night']); // 07:59
    expect(at('2026-11-12T03:00:00Z')).toEqual([]); // 08:00
  });

  it('…and at the moment its card is queued: a reply written in the night’s last hold would go at 08:00, but its card arrives silently — refused «night» (the second check)', () => {
    const queued = (now: string, at: string) => {
      const input = eligible();
      input.now = new Date(now);
      input.at = new Date(at);
      return autoVerdict(input).reasons;
    };
    expect(queued('2026-11-12T02:58:40Z', '2026-11-12T03:00:40Z')).toEqual(['night']); // 07:58:40 → 08:00:40
    expect(queued('2026-11-12T02:51:00Z', '2026-11-12T03:01:00Z')).toEqual(['night']); // a ten-minute hold
    expect(queued('2026-11-12T03:00:00Z', '2026-11-12T03:02:00Z')).toEqual([]); // 08:00 — the card rings
  });

  it('uz, uz_cyrl and ru go; the other languages the agent writes do not', () => {
    for (const language of ['uz', 'uz_cyrl', 'ru']) {
      const input = eligible();
      input.draft.language = language;
      expect(autoVerdict(input).eligible, language).toBe(true);
    }
    for (const language of ['en', 'fa', 'zh', null]) {
      const input = eligible();
      input.draft.language = language;
      expect(autoVerdict(input).reasons, String(language)).toEqual(['language']);
    }
  });
});

describe('a reply the machine pressed is nobody’s decision — the gate never grades itself', () => {
  const stats = (over: Partial<StatsDraftRow>): StatsDraftRow => ({
    status: 'approved',
    kind: 'reply',
    edited: false,
    outboxStatus: 'sent',
    category: 'greeting',
    autoSent: false,
    ...over,
  });

  it('agentStats counts auto sends APART: never sentUnchanged, never decided, never the rate', () => {
    const s = agentStats([stats({}), stats({ status: 'rejected', outboxStatus: null }), stats({ autoSent: true }), stats({ autoSent: true })]);
    expect(s.autoSent).toBe(2);
    expect(s.sentUnchanged).toBe(1);
    expect(s.decided).toBe(2);
    expect(s.rate).toBe(0.5);
    expect(s.byCategory.greeting!.decided).toBe(2);
    expect(s.onTheWay + s.approvedNotSent).toBe(0);
  });

  it('…whatever the auto send became — on its way, failed — it is still the machine’s', () => {
    const s = agentStats([stats({ autoSent: true, outboxStatus: 'agent' }), stats({ autoSent: true, outboxStatus: 'failed' })]);
    expect(s.autoSent).toBe(2);
    expect(s.onTheWay).toBe(0);
    expect(s.approvedNotSent).toBe(0);
  });

  it('the calibration table and its verdicts leave the machine’s own presses out', () => {
    const row = (over: Partial<CalibrationDraftRow>): CalibrationDraftRow => ({
      ...stats({}),
      confidence: 0.9,
      blocked: false,
      needsOwner: false,
      warnings: 0,
      notes: 0,
      money: false,
      actions: [],
      ...over,
    });
    const rows = [row({}), ...Array.from({ length: 60 }, () => row({ autoSent: true }))];
    const cells = calibrationCells(rows);
    expect(cells.reduce((n, c) => n + c.decided, 0)).toBe(1);
    const greeting = categoryVerdicts(rows).find((v) => v.category === 'greeting')!;
    expect(greeting.decided).toBe(1);
    expect(greeting.proven).toBe(false);
    expect(AUTO_CATEGORIES).toEqual(expect.arrayContaining([...AUTO_SEND_CATEGORIES]));
  });
});
