import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import { AUTO_DISARM_KEYS, ERROR_KEYS, autoDisarmKey } from '@/app/(protected)/suhbatlar/ai/labels';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import {
  AUTO_BAD_LINE,
  AUTO_DISARM_WORDS,
  AUTO_DISARMED_LINE,
  AUTO_PAUSED_LINE,
  AUTO_PRESS_WORDS,
  AUTO_SENT_PREFIX,
  autoCountingDown,
  autoDisarmWords,
  autoPayload,
  autoRefusalWords,
  withAutoLine,
} from '@/modules/wms/agent/auto-card';
import { AUTO_REFUSAL_WORDS } from '@/modules/wms/agent/auto-gate';
import { AUTO_CONFIG_WORDS, AUTO_FEEDBACK_WORDS, STOP_AUTO_WORDS, type AutoCardState } from '@/modules/wms/agent/auto-send';
import { autoArmedWords } from '@/modules/wms/agent/bot-door';
import { cardExtra, POLICY_WORDS } from '@/modules/wms/agent/card';
import { renderDraftCardFull, type DraftRow } from '@/modules/wms/agent/card-io';

/**
 * «O'zi yuborish» on the card he reads and presses (docs/AI-SOTUVCHI.md
 * §18.3): the line its status carries per state, the payload the keyboard is
 * drawn from, the keyboard per state, and every button the parser takes.
 * Pure — the doors behind them are `agent-auto.integration.test.ts`.
 */

/** A Tashkent wall-clock time as the instant it is (UTC+5, no daylight saving). */
const tk = (local: string) => new Date(`${local}:00+05:00`);
const DUE = tk('2026-11-11T14:32');
const ID = '0193f0aa-0000-7000-8000-000000000001';

const auto = (over: Partial<AutoCardState>): AutoCardState => ({
  state: 'waiting',
  dueAt: DUE,
  outcome: null,
  reasons: [],
  feedback: null,
  ...over,
});

const row = (over: Record<string, unknown>) =>
  ({
    id: ID,
    status: 'pending',
    kind: 'reply',
    blocked: false,
    finalBody: null,
    proposedBody: 'Ha, Xitoydan olib kelamiz. Qanday yuk?',
    glossUz: null,
    needsOwner: false,
    ownerQuestion: null,
    actions: [],
    policy: { card: { customerLabel: 'GS777 · Ali', lastOut: null, customerLines: ['14:29 Xitoydan olib kelasizmi?'] } },
    actionStatus: null,
    actionError: null,
    decidedBy: null,
    updatedAt: tk('2026-11-11T14:30'),
    ...over,
  }) as unknown as DraftRow;

const pending = { status: 'pending', finalBody: null };
const labels = (rows: ReturnType<typeof buttonsFor>) => (rows ?? []).map((r) => r.map((b) => b.text));
const data = (rows: ReturnType<typeof buttonsFor>) => (rows ?? []).flat().map((b) => ('callback_data' in b ? b.callback_data : ''));

describe('the status line per state (auto-card `withAutoLine`)', () => {
  it('counting down: the timer in Tashkent time, above whatever the pending line says', () => {
    expect(withAutoLine(null, auto({}), pending, true)).toBe('⏱ 14:32 da o‘zi ketadi — to‘xtatish uchun ⏸ bosing.');
    expect(withAutoLine('⚠️ boshqa qator', auto({}), pending, true)).toBe('⏱ 14:32 da o‘zi ketadi — to‘xtatish uchun ⏸ bosing.\n⚠️ boshqa qator');
  });

  it('no timer on a card with no ✅, on a draft he opened ✏️ on, or one carrying his own words', () => {
    expect(withAutoLine(null, auto({}), pending, false)).toBeNull();
    expect(withAutoLine(null, auto({}), { status: 'editing', finalBody: null }, true)).toBeNull();
    expect(withAutoLine(null, auto({}), { status: 'pending', finalBody: 'Mening matnim' }, true)).toBeNull();
    expect(autoCountingDown(auto({ dueAt: null }), pending, true)).toBe(false);
  });

  it('refused at the press: the gate’s reasons, each in its words — the card is his again', () => {
    const line = withAutoLine(null, auto({ state: 'refused', reasons: ['not_work_account', 'night'], outcome: 'not_work_account,night' }), pending, true);
    expect(line).toBe(`⏱ O‘zi ketmadi: ${AUTO_REFUSAL_WORDS.not_work_account}; ${AUTO_REFUSAL_WORDS.night} — o‘zingiz qaror qiling.`);
  });

  it('…and `decideDraft`’s refusal, a warning named by the policy’s own words, never a code', () => {
    expect(autoRefusalWords({ outcome: 'auto_warning:fingerprint', reasons: [] })).toBe(`${AUTO_PRESS_WORDS.auto_warning}: ${POLICY_WORDS.fingerprint}`);
    expect(autoRefusalWords({ outcome: 'stale_card', reasons: [] })).toBe(AUTO_PRESS_WORDS.stale_card);
    expect(autoRefusalWords({ outcome: 'policy_block:url,mention', reasons: [] })).toBe(AUTO_PRESS_WORDS.policy_block);
    // A gate refusal stored as codes alone (an older row) still reads as words.
    expect(autoRefusalWords({ outcome: 'too_long', reasons: [] })).toBe(AUTO_REFUSAL_WORDS.too_long);
    expect(autoRefusalWords({ outcome: 'no_such_code', reasons: [] })).toBe('sababi noma’lum');
    expect(autoRefusalWords({ outcome: null, reasons: [] })).toBe('sababi noma’lum');
    for (const code of ['auto_warning', 'stale_card', 'no_such_code']) expect(autoRefusalWords({ outcome: code, reasons: [] })).not.toContain(code);
  });

  it('⏸ and the layer’s «off» each say so on a live card; his own decision says nothing (its status speaks)', () => {
    expect(withAutoLine(null, auto({ state: 'stopped', outcome: 'pause' }), pending, true)).toBe(AUTO_PAUSED_LINE);
    expect(withAutoLine(null, auto({ state: 'stopped', outcome: 'disarmed' }), pending, true)).toBe(AUTO_DISARMED_LINE);
    expect(AUTO_PAUSED_LINE).toBe('⏸ To‘xtatildi — o‘zingiz qaror qilasiz.');
    for (const outcome of ['owner_send', 'owner_edit', 'owner_reject', 'owner_human']) {
      expect(withAutoLine('❌ Rad etildi.', auto({ state: 'stopped', outcome }), { status: 'rejected', finalBody: null }, false)).toBe('❌ Rad etildi.');
    }
    // A refused or paused row under a draft that is no longer live says nothing either.
    expect(withAutoLine('⌛ Muddati o‘tdi.', auto({ state: 'refused', outcome: 'night', reasons: ['night'] }), { status: 'expired', finalBody: null }, false)).toBe(
      '⌛ Muddati o‘tdi.',
    );
  });

  it('pressed: «🤖 O‘zi yuborildi (AI).» before the approved line, and his 👎 under it', () => {
    const approved = { status: 'approved', finalBody: null };
    expect(withAutoLine('✅ Yuborildi 11.11 14:33.', auto({ state: 'pressed' }), approved, false)).toBe(`${AUTO_SENT_PREFIX} ✅ Yuborildi 11.11 14:33.`);
    expect(withAutoLine('✅ Yuborildi 11.11 14:33.', auto({ state: 'pressed', feedback: 'bad' }), approved, false)).toBe(
      `${AUTO_SENT_PREFIX} ✅ Yuborildi 11.11 14:33.\n${AUTO_BAD_LINE}`,
    );
    expect(AUTO_BAD_LINE).toBe('👎 Xato deb belgilandi — bu suhbatda AI 30 kun o‘zi yozmaydi.');
  });

  it('no state (no row, an ineligible one, one migration behind): the line is the draft’s own', () => {
    expect(withAutoLine('x', null, pending, true)).toBe('x');
    expect(withAutoLine(null, undefined, pending, true)).toBeNull();
  });
});

describe('the card as rendered', () => {
  it('the first card carries the timer; the same row without a state is today’s card', () => {
    const text = renderDraftCardFull(row({}), null, [], { auto: auto({}) }).text;
    expect(text.split('\n')[1]).toBe('⏱ 14:32 da o‘zi ketadi — to‘xtatish uchun ⏸ bosing.');
    expect(renderDraftCardFull(row({}), null).text).not.toContain('o‘zi ketadi');
  });

  it('a card too long to show its reply never promises to send it', () => {
    const full = renderDraftCardFull(row({ proposedBody: 'Ш'.repeat(3800) }), null, [], { auto: auto({}) });
    expect(full.tooLong).toBe(true);
    expect(full.text).not.toContain('o‘zi ketadi');
  });
});

describe('the payload the keyboard is drawn from (card `cardExtra`, auto-card `autoPayload`)', () => {
  const extra = (a: AutoCardState | null, d = pending, sendable = true) =>
    cardExtra({ id: ID, body: 'x', actions: [], blocked: !sendable, live: d.status === 'pending' || d.status === 'editing', kind: 'reply', auto: autoPayload(a, d, sendable) });

  it('autoAt is the due time while it counts down — and null, written, otherwise (a refresh MERGES the payload)', () => {
    expect(extra(auto({})).autoAt).toBe(DUE.toISOString());
    for (const a of [null, auto({ state: 'stopped', outcome: 'pause' }), auto({ state: 'refused', outcome: 'night', reasons: ['night'] })]) {
      const e = extra(a);
      expect(e).toHaveProperty('autoAt', null);
      expect(e).toMatchObject({ autoSent: false, autoBad: false });
    }
    expect(extra(auto({}), pending, false).autoAt).toBeNull();
    // A writer that passes no state at all still writes the keys.
    expect(cardExtra({ id: ID, body: 'x', actions: [], blocked: false, live: true, kind: 'reply' })).toMatchObject({ autoAt: null, autoSent: false, autoBad: false });
  });

  it('autoSent once the machine pressed an approved reply, autoBad once he said 👎', () => {
    const approved = { status: 'approved', finalBody: null };
    expect(extra(auto({ state: 'pressed' }), approved, false)).toMatchObject({ autoAt: null, autoSent: true, autoBad: false });
    expect(extra(auto({ state: 'pressed', feedback: 'bad' }), approved, false)).toMatchObject({ autoSent: true, autoBad: true });
    // Pressed but the draft not approved (a row the reclaim has yet to settle): nothing to judge.
    expect(extra(auto({ state: 'pressed' }), pending)).toMatchObject({ autoSent: false });
  });

  it('both writers of a card’s payload hand it the auto state — createDraft and refreshAgentCard', () => {
    const io = readFileSync('src/modules/wms/agent/card-io.ts', 'utf8');
    const drafts = readFileSync('src/modules/wms/agent/drafts.ts', 'utf8');
    expect(io).toMatch(/auto: autoPayload\(auto, d, sendable\)/u);
    expect(io).toMatch(/renderDraftCardFull\(d, o \?\? null, extraNotes, \{[^}]*\bauto \}\)/u);
    expect(drafts).toMatch(/auto: autoPayload\(auto, row, sendable\)/u);
    expect(drafts).toMatch(/renderDraftCardFull\(row, null, \[\], \{ auto \}\)/u);
    const page = readFileSync('src/modules/wms/agent/web-page.ts', 'utf8');
    expect(page).toMatch(/renderDraftCardFull\(d, o, \[\], \{ surface: 'web', auto \}\)/u);
  });
});

describe('the keyboard per state (staff-bot `agentButtons`)', () => {
  const base = { draftId: ID, digest: 'a1b2c3d4', live: true, blocked: false, kind: 'reply' };

  it('counting down: ⏸ first, then the same ✅ with its digest as «Hozir yubor», ✏️, ❌ 🙋', () => {
    const rows = buttonsFor('AgentDraft', { ...base, autoAt: DUE.toISOString() });
    expect(labels(rows)).toEqual([['⏸ To‘xtat', '✅ Hozir yubor'], ['✏️ O‘zgartirish'], ['❌ Kerak emas', '🙋 Suhbat meniki']]);
    expect(data(rows)).toEqual([`ag:a:${ID}`, `ag:s:${ID}:a1b2c3d4`, `ag:e:${ID}`, `ag:r:${ID}`, `ag:h:${ID}`]);
  });

  it('…a blocked one keeps ⏸ and no ✅', () => {
    expect(labels(buttonsFor('AgentDraft', { ...base, blocked: true, autoAt: DUE.toISOString() }))[0]).toEqual(['⏸ To‘xtat']);
  });

  it('not counting down (null, absent — an older payload): today’s keyboard', () => {
    const today = [['✅ Yuborish', '✏️ O‘zgartirish'], ['❌ Kerak emas', '🙋 Suhbat meniki']];
    expect(labels(buttonsFor('AgentDraft', { ...base, autoAt: null }))).toEqual(today);
    expect(labels(buttonsFor('AgentDraft', base))).toEqual(today);
  });

  it('a closed card the machine sent: «👎 Xato edi», once — then nothing', () => {
    const closed = { ...base, live: false };
    expect(labels(buttonsFor('AgentDraft', { ...closed, autoSent: true, autoBad: false }))).toEqual([['👎 Xato edi']]);
    expect(data(buttonsFor('AgentDraft', { ...closed, autoSent: true }))).toEqual([`ag:f:${ID}`]);
    expect(buttonsFor('AgentDraft', { ...closed, autoSent: true, autoBad: true })).toBeNull();
    expect(buttonsFor('AgentDraft', { ...closed, autoSent: false })).toBeNull();
    expect(buttonsFor('AgentDraft', closed)).toBeNull();
  });

  it('every button of every state is one the parser takes, as the op it names', () => {
    const states = [
      { ...base, autoAt: DUE.toISOString() },
      { ...base, blocked: true, autoAt: DUE.toISOString() },
      { ...base, live: false, autoSent: true },
    ];
    for (const payload of states) {
      for (const cb of data(buttonsFor('AgentDraft', payload))) expect(parseCallback(cb), cb).toMatchObject({ kind: 'agent', id: ID });
    }
    expect(parseCallback(`ag:a:${ID}`)).toEqual({ kind: 'agent', op: 'a', id: ID });
    expect(parseCallback(`ag:f:${ID}`)).toEqual({ kind: 'agent', op: 'f', id: ID });
  });
});

describe('words — every code said, never printed', () => {
  it('the disarm reasons: one map for the bot, the page’s keys in all four bundles for every kind', () => {
    expect(Object.keys(AUTO_DISARM_KEYS).sort()).toEqual(Object.keys(AUTO_DISARM_WORDS).sort());
    expect(autoDisarmWords('forced: SESSION_REVOKED')).toBe(AUTO_DISARM_WORDS.forced);
    expect(autoDisarmWords('feedback')).toBe(AUTO_DISARM_WORDS.feedback);
    expect(autoDisarmWords('weird')).toBe('sababi noma’lum');
    expect(autoDisarmKey('forced: SESSION_REVOKED')).toBe(AUTO_DISARM_KEYS.forced);
    expect(autoDisarmKey('weird')).toBe('autoOff.unknown');
    expect(autoDisarmKey(null)).toBeNull();
    type Tree = { [k: string]: string | Tree };
    const get = (tree: Tree, path: string) => path.split('.').reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);
    for (const [locale, bundle] of Object.entries({ ru, uz, en, zh } as Record<string, Tree>)) {
      for (const key of [...Object.values(AUTO_DISARM_KEYS), 'autoOff.unknown']) {
        expect(typeof get(bundle, `agentAi.${key}`), `${locale} agentAi.${key}`).toBe('string');
      }
    }
  });

  it('every refusal of the three auto doors has its OWN page code in ERROR_KEYS (web-actions `agentAuto…`)', () => {
    const keys = ERROR_KEYS as Record<string, string>;
    for (const code of Object.keys(AUTO_CONFIG_WORDS)) expect(keys[`auto_${code}`], `auto_${code}`).toBe(`errors.auto_${code}`);
    for (const code of Object.keys(STOP_AUTO_WORDS).filter((c) => c !== 'not_ready')) expect(keys[`auto_stop_${code}`], code).toBe(`errors.auto_stop_${code}`);
    for (const code of Object.keys(AUTO_FEEDBACK_WORDS).filter((c) => c !== 'not_ready')) expect(keys[`auto_fb_${code}`], code).toBe(`errors.auto_fb_${code}`);
    const actions = readFileSync('src/modules/wms/agent/web-actions.ts', 'utf8');
    expect(actions).toMatch(/`auto_stop_\$\{r\.code\}`/u);
    expect(actions).toMatch(/`auto_fb_\$\{r\.code\}`/u);
    expect(actions).toMatch(/`auto_\$\{err\.code\}`/u);
  });

  it('arming says the numbers the press keeps', () => {
    expect(autoArmedWords({ holdSec: 120, perDay: 30 })).toContain('2 daqiqa');
    expect(autoArmedWords({ holdSec: 90, perDay: 30 })).toContain('90 soniya');
    expect(autoArmedWords({ holdSec: 120, perDay: 30 })).toContain('30 ta');
  });
});
