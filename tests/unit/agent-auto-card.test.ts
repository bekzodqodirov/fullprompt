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
  AUTO_APPROVED_PREFIX,
  AUTO_SENT_PREFIX,
  AUTO_TAKEN_BACK_PREFIX,
  AUTO_UNSEEN_LINE,
  autoCountingDown,
  autoDisarmWords,
  autoPayload,
  autoRefusalWords,
  withAutoLine,
} from '@/modules/wms/agent/auto-card';
import { AUTO_REFUSAL_WORDS } from '@/modules/wms/agent/auto-gate';
import { FORCED_OFF_REASONS } from '@/modules/wms/agent/forced-off';
import { AUTO_CONFIG_WORDS, AUTO_FEEDBACK_WORDS, STOP_AUTO_WORDS, copyRang, countdownMayRide, type AutoCardState } from '@/modules/wms/agent/auto-send';
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

  it('pressed: «🤖 O‘zi yuborildi (AI).» before the approved line of a reply that went, and his 👎 under it', () => {
    const approved = { status: 'approved', finalBody: null };
    // DELIBERATE EDIT (fix pass B, C6): the reply's outbox status is passed — «yuborildi» needs it to be 'sent'.
    expect(withAutoLine('✅ Yuborildi 11.11 14:33.', auto({ state: 'pressed' }), approved, false, 'sent')).toBe(`${AUTO_SENT_PREFIX} ✅ Yuborildi 11.11 14:33.`);
    expect(withAutoLine('✅ Yuborildi 11.11 14:33.', auto({ state: 'pressed', feedback: 'bad' }), approved, false, 'sent')).toBe(
      `${AUTO_SENT_PREFIX} ✅ Yuborildi 11.11 14:33.\n${AUTO_BAD_LINE}`,
    );
    expect(AUTO_BAD_LINE).toBe('👎 Xato deb belgilandi — bu suhbatda AI 30 kun o‘zi yozmaydi.');
  });

  it('a reply the machine pressed that never left — taken back, expired, failed: never «O‘zi yuborildi» (fix pass A)', () => {
    const approved = { status: 'approved', finalBody: null };
    for (const sendStatus of ['cancelled', 'expired', 'failed']) {
      expect(withAutoLine('✖ Yuborilmadi — o‘zingiz qaytarib oldingiz.', auto({ state: 'pressed' }), approved, false, sendStatus), sendStatus).toBe(
        `${AUTO_TAKEN_BACK_PREFIX} ✖ Yuborilmadi — o‘zingiz qaytarib oldingiz.`,
      );
    }
    // DELIBERATE EDIT (fix pass B, C6): «O‘zi yuborildi» for the reply that went and for no other — on its way,
    // Telegram's answer lost, no outbox row: the machine APPROVED it, and the base line says where it is.
    expect(withAutoLine('✅ Yuborildi 11.11 14:33.', auto({ state: 'pressed' }), approved, false, 'sent')).toBe(`${AUTO_SENT_PREFIX} ✅ Yuborildi 11.11 14:33.`);
    for (const sendStatus of ['agent', 'sending', 'unknown', null]) {
      expect(withAutoLine('✅ Tasdiqlandi · yuborilmoqda…', auto({ state: 'pressed' }), approved, false, sendStatus), String(sendStatus)).toBe(
        `${AUTO_APPROVED_PREFIX} ✅ Tasdiqlandi · yuborilmoqda…`,
      );
    }
    expect(AUTO_APPROVED_PREFIX).not.toMatch(/yuborildi/iu);
    expect(AUTO_TAKEN_BACK_PREFIX).not.toMatch(/yuborildi/iu);
  });

  it('a card that has not reached his Telegram yet says so instead of a clock — ⏸ still on it (fix pass A, C4)', () => {
    expect(withAutoLine(null, auto({ outcome: 'unseen' }), pending, true)).toBe(AUTO_UNSEEN_LINE);
    expect(AUTO_UNSEEN_LINE).not.toMatch(/\d\d:\d\d/u);
    expect(AUTO_UNSEEN_LINE).toContain('⏸');
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
    expect(cardExtra({ id: ID, body: 'x', actions: [], blocked: false, live: true, kind: 'reply' })).toMatchObject({
      autoAt: null,
      autoSent: false,
      autoBad: false,
      autoCancel: false,
    });
  });

  it('autoSent once the machine pressed an approved reply, autoBad once he said 👎', () => {
    const approved = { status: 'approved', finalBody: null };
    expect(extra(auto({ state: 'pressed' }), approved, false)).toMatchObject({ autoAt: null, autoSent: true, autoBad: false });
    expect(extra(auto({ state: 'pressed', feedback: 'bad' }), approved, false)).toMatchObject({ autoSent: true, autoBad: true });
    // Pressed but the draft not approved (a row the reclaim has yet to settle): nothing to judge.
    expect(extra(auto({ state: 'pressed' }), pending)).toMatchObject({ autoSent: false });
  });

  it('autoCancel while the reply the machine approved can still be taken back — the web cancel’s own rule (fix pass A, C3)', () => {
    const approved = { status: 'approved', finalBody: null };
    const withOutbox = (o: { status: string; readDone: boolean } | null) =>
      cardExtra({ id: ID, body: 'x', actions: [], blocked: true, live: false, kind: 'reply', auto: autoPayload(auto({ state: 'pressed' }), approved, false, o) });
    expect(withOutbox({ status: 'agent', readDone: false })).toMatchObject({ autoSent: true, autoCancel: true });
    for (const o of [{ status: 'agent', readDone: true }, { status: 'sending', readDone: true }, { status: 'sent', readDone: true }, { status: 'cancelled', readDone: false }, null]) {
      expect(withOutbox(o), JSON.stringify(o)).toMatchObject({ autoSent: true, autoCancel: false });
    }
    // A person's own approval: no auto fields at all.
    expect(extra(null, approved, false)).toMatchObject({ autoSent: false, autoCancel: false });
  });

  it('both writers of a card’s payload hand it the auto state — createDraft and refreshAgentCard', () => {
    const io = readFileSync('src/modules/wms/agent/card-io.ts', 'utf8');
    const drafts = readFileSync('src/modules/wms/agent/drafts.ts', 'utf8');
    // The redraw hands the reply's outbox row too: ❌ «Bekor qilish» while it can still be taken back (fix pass A).
    expect(io).toMatch(/auto: autoPayload\(auto, d, sendable, o \?\? null\)/u);
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

  it('a reply the machine pressed and that can still be taken back: ❌ «Bekor qilish» and 🙋, then 👎 (fix pass A, C3)', () => {
    const closed = { ...base, live: false, autoSent: true, autoCancel: true };
    expect(labels(buttonsFor('AgentDraft', closed))).toEqual([['❌ Bekor qilish', '🙋 Suhbat meniki'], ['👎 Xato edi']]);
    expect(data(buttonsFor('AgentDraft', closed))).toEqual([`ag:r:${ID}`, `ag:h:${ID}`, `ag:f:${ID}`]);
    expect(labels(buttonsFor('AgentDraft', { ...closed, autoBad: true }))).toEqual([['❌ Bekor qilish', '🙋 Suhbat meniki']]);
    // A person's own approval never draws them, whatever the key says.
    expect(buttonsFor('AgentDraft', { ...base, live: false, autoSent: false, autoCancel: true })).toBeNull();
  });

  it('every button of every state is one the parser takes, as the op it names', () => {
    const states = [
      { ...base, autoAt: DUE.toISOString() },
      { ...base, blocked: true, autoAt: DUE.toISOString() },
      { ...base, live: false, autoSent: true },
      { ...base, live: false, autoSent: true, autoCancel: true },
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

  it('every forced «off» is said as its own reason — never «cheklandi» about a block or Telegram’s notice (fix pass B, C10)', () => {
    expect(autoDisarmWords('forced: account_paused')).toBe(AUTO_DISARM_WORDS.forced_account_paused);
    expect(autoDisarmWords('forced: flood_repeat')).toBe(AUTO_DISARM_WORDS.forced_flood_repeat);
    expect(autoDisarmWords('forced: blocks')).toBe(AUTO_DISARM_WORDS.forced_blocks);
    expect(autoDisarmWords('forced: telegram_notice')).toBe(AUTO_DISARM_WORDS.forced_telegram_notice);
    expect(autoDisarmWords('forced: blocks')).toContain('bloklagan');
    expect(autoDisarmWords('forced: telegram_notice')).toContain('777000');
    for (const r of FORCED_OFF_REASONS.filter((x) => x !== 'account_paused')) expect(autoDisarmWords(`forced: ${r}`), r).not.toMatch(/chekla/iu);
    // A tail no list knows (an old row) is said neutrally, never as a restriction.
    expect(autoDisarmWords('forced: SESSION_REVOKED')).toBe('AI sotuvchi o‘zi o‘chdi');
    // The page: one key per reason, distinct words in every bundle.
    for (const r of FORCED_OFF_REASONS) expect(autoDisarmKey(`forced: ${r}`)).toBe(`autoOff.forced_${r}`);
    expect(autoDisarmKey('forced: SESSION_REVOKED')).toBe('autoOff.forced');
    for (const [locale, bundle] of Object.entries({ ru, uz, en, zh })) {
      const off = (bundle as { agentAi: { autoOff: Record<string, string> } }).agentAi.autoOff;
      const words = [...FORCED_OFF_REASONS.map((r) => off[`forced_${r}`]), off.forced];
      expect(new Set(words).size, locale).toBe(words.length);
    }
  });

  it('the forced reasons are ONE list: every reason a caller switches the agent off with is in it, and every one is used', () => {
    const alarm = readFileSync('src/modules/wms/crm/account-alarm.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
    const used = [...alarm.matchAll(/agentOffFor\(account, '([a-z_]+)'\)/gu)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(FORCED_OFF_REASONS));
    expect(alarm).toMatch(/async function agentOffFor\(account: AlarmAccount, reason: ForcedOffReason\)/u);
    expect(readFileSync('src/modules/wms/agent/config.ts', 'utf8')).toMatch(/export async function forceAgentOff\(reason: ForcedOffReason\)/u);
  });

  it('👎 on a reply nobody can find says so — never «o‘zi yuborilmagan» about one a purge took (fix pass B, C7)', () => {
    expect(AUTO_FEEDBACK_WORDS.not_found).toBe('Bu javob topilmadi.');
    expect(AUTO_FEEDBACK_WORDS.not_found).not.toBe(AUTO_FEEDBACK_WORDS.not_sent);
    expect(uz.agentAi.errors.auto_fb_not_found).not.toBe(uz.agentAi.errors.auto_fb_not_sent);
  });

  it('arming says the numbers the press keeps', () => {
    expect(autoArmedWords({ holdSec: 120, perDay: 30 })).toContain('2 daqiqa');
    expect(autoArmedWords({ holdSec: 90, perDay: 30 })).toContain('90 soniya');
    expect(autoArmedWords({ holdSec: 120, perDay: 30 })).toContain('30 ta');
  });
});

/**
 * The second check of ea38306c: the staff drain sends an AI card SILENTLY in the quiet hour (22:00-07:59, decided at
 * SEND time), so a copy that went at 07:59 never rang — and a countdown that rides it, or a card of its own sent
 * then, holds his ⏸ window on a message his phone never announced.
 */
describe('a countdown rides only a copy that rang (auto-send `copyRang`, `countdownMayRide`)', () => {
  const plan = (written: Date) => ({ dueAt: new Date(written.getTime() + 120_000), holdSec: 120 });
  const sent = (at: string, payload: Record<string, unknown>) => ({ status: 'sent', sentAt: tk(at), payload });

  it('the drain’s own record is the fact: a send it made silently never rang, whenever the row says it was sent', () => {
    // A drain run that began at 07:59:59 sends the copy at 08:00 — silently, decided by the run's own clock.
    expect(copyRang({ sentAt: tk('2026-11-12T08:00'), payload: { rang: false } })).toBe(false);
    expect(copyRang({ sentAt: tk('2026-11-12T07:59'), payload: { rang: true } })).toBe(true);
    // Never sent: nothing rang.
    expect(copyRang({ sentAt: null, payload: { rang: true } })).toBe(false);
  });

  it('a copy sent before the drain recorded it: the drain’s night rule, asked of the moment it was sent', () => {
    expect(copyRang({ sentAt: tk('2026-11-12T07:59'), payload: {} })).toBe(false);
    expect(copyRang({ sentAt: tk('2026-11-11T22:00'), payload: {} })).toBe(false);
    expect(copyRang({ sentAt: tk('2026-11-12T08:00'), payload: {} })).toBe(true);
    expect(copyRang({ sentAt: tk('2026-11-11T21:59'), payload: null })).toBe(true);
  });

  it('a copy sent silently at 07:59 is never ridden by a countdown written at 08:00 — though it went within one hold', () => {
    expect(countdownMayRide(sent('2026-11-12T07:59', { rang: false }), plan(tk('2026-11-12T08:00')))).toBe(false);
    expect(countdownMayRide(sent('2026-11-12T07:59', {}), plan(tk('2026-11-12T08:00')))).toBe(false);
    // One that rang within the hold is ridden, as before; one that rang longer ago is not.
    expect(countdownMayRide(sent('2026-11-12T08:00', { rang: true }), plan(tk('2026-11-12T08:01')))).toBe(true);
    expect(countdownMayRide(sent('2026-11-12T08:00', {}), plan(tk('2026-11-12T08:01')))).toBe(true);
    expect(countdownMayRide(sent('2026-11-12T08:00', { rang: true }), plan(tk('2026-11-12T08:05')))).toBe(false);
    // A copy not yet sent: its send is the drain's, after a daytime scheduling (the gate refuses a night one).
    expect(countdownMayRide({ status: 'pending', sentAt: null, payload: {} }, plan(tk('2026-11-12T08:00')))).toBe(true);
  });
});
