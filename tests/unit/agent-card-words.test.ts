import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buttonsFor } from '@/modules/platform/telegram/staff-bot';
import { agentCardText, BLOCK_REMEDY, hitWords, lateNote, LATE_CARD_MS, POLICY_WORDS } from '@/modules/wms/agent/card';
import { renderDraftCard, renderDraftCardFull, type DraftRow } from '@/modules/wms/agent/card-io';
import { HUMAN_TAKEOVER_HOURS } from '@/modules/wms/agent/limits';
import type { PolicyHit } from '@/modules/wms/agent/policy';
import { pageDrawsSend } from '@/modules/wms/agent/web-page';

/**
 * What the owner reads on an AI draft card and presses (the 2026-10-29
 * incident: a blocked card with no ✅ and no way named, «✏️ O‘zim yozaman»
 * read as «answer the customer yourself», and his own Telegram reply retiring
 * the draft with 🙋's words). Pure: the card's text from a row, no database —
 * the doors behind it are `agent-card-flow.integration.test.ts`.
 */

/** A Tashkent wall-clock time as the instant it is (UTC+5, no daylight saving). */
const tk = (local: string) => new Date(`${local}:00+05:00`);

const row = (over: Record<string, unknown>) =>
  ({
    id: '0193f0aa-0000-7000-8000-000000000001',
    status: 'pending',
    kind: 'reply',
    blocked: false,
    finalBody: null,
    proposedBody: 'Assalomu alaykum! Qanday yordam bera olaman?',
    glossUz: null,
    needsOwner: false,
    ownerQuestion: null,
    actions: [],
    policy: { card: { customerLabel: 'Lid: Bobur', lastOut: null, customerLines: ['17:46 Assalomu alaykum'] } },
    actionStatus: null,
    actionError: null,
    decidedBy: null,
    updatedAt: tk('2026-10-29T18:10'),
    ...over,
  }) as unknown as DraftRow;

const block = (hit: PolicyHit) => ({ policy: { blocks: [hit], card: { customerLabel: 'Lid: Bobur', lastOut: null, customerLines: [] } } });

const card = {
  customerLabel: 'Lid: Bobur',
  title: '🤖 Javob qoralamasi',
  statusLine: null,
  blocks: [] as PolicyHit[],
  warnings: [] as PolicyHit[],
  notes: [] as string[],
  reply: 'Assalomu alaykum!',
  gloss: null,
  ledger: [],
  actions: [],
  ownerQuestion: null,
  lastOut: null,
  customerLines: [] as string[],
};

describe('a blocked card says what to do (C2)', () => {
  const hit: PolicyHit = { rule: 'G1', code: 'number_unsourced', detail: '4' };

  it('the header names the block, the reasons follow, and the remedy names THIS bot — ✏️, the text here, then ✅', () => {
    const text = agentCardText({ ...card, blocks: [hit] });
    const lines = text.split('\n');
    const head = lines.indexOf('⛔ Bu matn shunday yuborilmaydi (✅ yo‘q). Sabab:');
    expect(head).toBeGreaterThan(-1);
    expect(lines[head + 1]).toBe(`• ${hitWords(hit)}`);
    expect(lines[head + 2]).toBe(
      '👉 «✏️ O‘zgartirish»ni bosing va to‘g‘ri matnni shu botga yozing — men uni kartaga qo‘yaman, keyin ✅ Yuborish chiqadi. Mijozga Telegramda o‘zingiz yozsangiz, bu qoralama yopiladi.',
    );
    expect(text).not.toContain('tuzatish kerak');
  });

  it('a card with nothing blocked carries neither the header nor the remedy', () => {
    const text = agentCardText(card);
    expect(text).not.toContain('⛔');
    expect(text).not.toContain(BLOCK_REMEDY.bot);
  });

  it('the page names its own box, and a draft being edited lets its status line say where to write', () => {
    expect(renderDraftCard(row({ blocked: true, ...block(hit) }), null, [], { surface: 'web' })).toContain(BLOCK_REMEDY.web);
    expect(renderDraftCard(row({ blocked: true, ...block(hit) }), null, [], { surface: 'web' })).not.toContain('shu botga');
    const editing = renderDraftCard(row({ status: 'editing', blocked: true, ...block(hit) }), null);
    expect(editing).toContain('⛔ Bu matn shunday yuborilmaydi');
    expect(editing).not.toContain('👉');
  });

  it('the remedy fits the card: a 700-character blocked reply with every line still renders whole', () => {
    const blocks: PolicyHit[] = Array.from({ length: 6 }, (_, i) => ({ rule: 'G1', code: 'number_unsourced', detail: String(i) }));
    const text = agentCardText({ ...card, blocks, reply: 'R'.repeat(700), customerLines: ['Salom'] });
    expect(text).toContain('R'.repeat(700));
    expect(text).toContain(BLOCK_REMEDY.bot);
    expect(text.length).toBeLessThanOrEqual(3900);
  });
});

describe('a reason is words, never a code (C3)', () => {
  it('an unreadable numeral says HOW it is written — the three kinds `unverifiableNumeral` answers', () => {
    expect(hitWords({ rule: 'G1', code: 'number_unverifiable', detail: 'word_numeral' })).toBe('o‘qib bo‘lmaydigan raqam bor: son so‘z bilan yozilgan');
    expect(hitWords({ rule: 'G1', code: 'number_unverifiable', detail: 'han_numeral' })).toBe('o‘qib bo‘lmaydigan raqam bor: son xitoycha ieroglif bilan yozilgan');
    expect(hitWords({ rule: 'G1', code: 'number_unverifiable', detail: 'other_script_digit' })).toBe(
      'o‘qib bo‘lmaydigan raqam bor: raqam boshqa yozuvdagi belgi bilan yozilgan',
    );
  });

  it('every member of the union has its words — read out of digits.ts, so a fourth kind cannot print raw', () => {
    const src = readFileSync('src/modules/wms/agent/digits.ts', 'utf8');
    const union = /export type UnverifiableNumeral =([^;]+);/u.exec(src)?.[1] ?? '';
    const kinds = [...union.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
    expect(kinds.length, 're-anchor: the union moved').toBeGreaterThanOrEqual(3);
    for (const kind of kinds) {
      const words = hitWords({ rule: 'G1', code: 'number_unverifiable', detail: kind });
      expect(words, kind).not.toContain(kind);
    }
  });

  it('a script pair reads lotin / kirill / arab / xitoy, a language code its name', () => {
    expect(hitWords({ rule: 'G5', code: 'wrong_script', detail: 'latin→cyrillic' })).toBe(`${POLICY_WORDS.wrong_script}: lotin → kirill`);
    expect(hitWords({ rule: 'G5', code: 'wrong_script', detail: 'uz_cyrl→latin' })).toBe(`${POLICY_WORDS.wrong_script}: o‘zbekcha (kirill) → lotin`);
    expect(hitWords({ rule: 'G5', code: 'wrong_script', detail: 'arabic→han' })).toBe(`${POLICY_WORDS.wrong_script}: arab → xitoy`);
    expect(hitWords({ rule: 'G5', code: 'wrong_script', detail: 'ru→latin' })).toBe(`${POLICY_WORDS.wrong_script}: ruscha → lotin`);
  });

  it('a detail the tables do not know prints as it came — the card never throws over a reason', () => {
    expect(hitWords({ rule: 'G1', code: 'number_unverifiable', detail: 'roman_numeral' })).toBe(`${POLICY_WORDS.number_unverifiable}: roman_numeral`);
    expect(hitWords({ rule: 'G5', code: 'wrong_script', detail: 'klingon→latin' })).toBe(`${POLICY_WORDS.wrong_script}: klingon → lotin`);
    expect(hitWords({ rule: 'G5', code: 'wrong_script', detail: 'nonsense' })).toBe(`${POLICY_WORDS.wrong_script}: nonsense`);
    expect(hitWords({ rule: 'G1', code: 'number_unsourced', detail: '1 $' })).toBe(`${POLICY_WORDS.number_unsourced}: 1 $`);
  });

  it('an OLD stored draft with the raw codes reads the words on its next render', () => {
    const text = renderDraftCard(row({ blocked: true, ...block({ rule: 'G1', code: 'number_unverifiable', detail: 'word_numeral' }) }), null);
    expect(text).toContain('• o‘qib bo‘lmaydigan raqam bor: son so‘z bilan yozilgan');
    expect(text).not.toContain('word_numeral');
  });
});

describe('the editing status line says WHERE (C5)', () => {
  it('a blocked draft he is editing: into this bot, not the customer’s chat, and the ✅ after', () => {
    expect(renderDraftCard(row({ status: 'editing', blocked: true }), null)).toContain(
      '✏️ Matnni shu botga yozing (mijozning chatiga emas) — keyin ✅ chiqadi.',
    );
  });

  it('a sendable one says its ✅ still sends the AI’s words (C7)', () => {
    expect(renderDraftCard(row({ status: 'editing' }), null)).toContain(
      '✏️ Matnni shu botga yozing (mijozning chatiga emas) — yoki AI matnini ✅ bilan yuboring.',
    );
  });

  it('the old «O‘z matningizni yozing … oddiy xabar bilan» is gone', () => {
    expect(renderDraftCard(row({ status: 'editing' }), null)).not.toContain("O'z matningizni yozing");
  });
});

describe('his own Telegram reply is not 🙋 (C6)', () => {
  it('no decider: he wrote to the customer himself — when, that the AI reply was cancelled, and the pause', () => {
    const text = renderDraftCard(row({ status: 'taken_over', updatedAt: tk('2026-10-29T18:10') }), null, [], { humanPauseMin: 120 });
    expect(text).toContain('✋ Siz mijozga Telegramda o‘zingiz yozdingiz (18:10) — AI javobi bekor qilindi. Xabaringizdan keyin AI bu chatga 120 daqiqa yozmaydi.');
  });

  it('…and without the config the pause is not guessed', () => {
    const text = renderDraftCard(row({ status: 'taken_over', updatedAt: tk('2026-10-29T09:05') }), null);
    expect(text).toContain('✋ Siz mijozga Telegramda o‘zingiz yozdingiz (09:05) — AI javobi bekor qilindi.');
    expect(text).not.toContain('daqiqa yozmaydi');
  });

  it('a 🙋 press (a decider) says he took the chat, for the hours the press writes', () => {
    const text = renderDraftCard(row({ status: 'taken_over', decidedBy: '0193f0aa-0000-7000-8000-0000000000ff' }), null, [], { humanPauseMin: 120 });
    expect(text).toContain(`🙋 Suhbatni o‘zingizga oldingiz — AI bu chatga ${HUMAN_TAKEOVER_HOURS} soat yozmaydi.`);
    expect(text).not.toContain('Telegramda o‘zingiz yozdingiz');
  });

  it('the 🙋 press writes the hours the card promises — one constant (decide.ts)', () => {
    const src = readFileSync('src/modules/wms/agent/decide.ts', 'utf8');
    expect(src).toContain('new Date(Date.now() + HUMAN_TAKEOVER_HOURS * 3_600_000)');
  });
});

describe('a card too long to show is blocked in its buttons too (C10 a)', () => {
  it('the cut card says «✅ yo‘q» and renderDraftCardFull says tooLong — the keyboard reads it', () => {
    const long = row({ finalBody: 'Ш'.repeat(3800) });
    const full = renderDraftCardFull(long, null);
    expect(full.tooLong).toBe(true);
    expect(full.text).toContain('✅ yo‘q');
    expect(renderDraftCardFull(row({}), null).tooLong).toBe(false);
  });

  it('the bot draws no ✅ over a payload the writers mark from it', () => {
    const payload = { draftId: '0193f0aa-0000-7000-8000-000000000001', digest: '0123abcd', live: true, blocked: true };
    const rows = buttonsFor('AgentDraft', payload) ?? [];
    expect(rows.flat().some((b) => 'callback_data' in b && b.callback_data.startsWith('ag:s:'))).toBe(false);
  });

  it('both writers of a card’s payload carry the cut as a block — refreshAgentCard and createDraft', () => {
    const io = readFileSync('src/modules/wms/agent/card-io.ts', 'utf8');
    const drafts = readFileSync('src/modules/wms/agent/drafts.ts', 'utf8');
    expect(io).toContain('blocked: d.blocked || tooLong');
    expect(drafts).toContain('blocked: row.blocked || tooLong');
  });
});

describe('the ✏️ button is «O‘zgartirish» (C1)', () => {
  it('his own word, the callback unchanged', () => {
    const payload = { draftId: '0193f0aa-0000-7000-8000-000000000001', digest: '0123abcd', live: true, blocked: false };
    const flat = (buttonsFor('AgentDraft', payload) ?? []).flat();
    expect(flat.map((b) => b.text)).toEqual(['✅ Yuborish', '✏️ O‘zgartirish', '❌ Kerak emas', '🙋 Suhbat meniki']);
    expect(flat.find((b) => b.text === '✏️ O‘zgartirish')).toMatchObject({ callback_data: `ag:e:${payload.draftId}` });
  });

  it('the page’s two buttons stop being synonyms — in all four bundles', () => {
    const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { agentAi: Record<string, string> };
    expect(uz.agentAi.edit).toBe('O‘zgartirish');
    expect(uz.agentAi.human).toBe('Suhbat meniki');
    for (const locale of ['ru', 'zh-CN', 'en']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { agentAi: Record<string, string> };
      expect(bundle.agentAi.edit, locale).not.toBe(bundle.agentAi.human);
      expect(bundle.agentAi.edit, locale).not.toMatch(/сам|myself|自己/u);
    }
  });
});

describe('a late card says so (C11)', () => {
  const anchor = tk('2026-10-29T17:47');

  it('three minutes or less after the anchor: nothing — a card on time is not news', () => {
    expect(lateNote({ anchorSentAt: anchor, waitingSince: null, writtenAt: new Date(anchor.getTime() + LATE_CARD_MS), origin: 'pull' })).toBeNull();
  });

  it('the incident: 23 minutes, after he answered the stranger card', () => {
    expect(lateNote({ anchorSentAt: anchor, waitingSince: null, writtenAt: tk('2026-10-29T18:10'), origin: 'pull' })).toBe(
      '⏱ Mijoz 23 daqiqadan beri javob kutyapti («🆕 Yangi lid» yoki «👤 Mijoz — kod» bosilgandan keyin yozildi)',
    );
  });

  it('the wait counts from the customer’s FIRST unanswered line, the cause from the job', () => {
    expect(lateNote({ anchorSentAt: anchor, waitingSince: tk('2026-10-29T17:40'), writtenAt: tk('2026-10-29T17:55'), origin: 'sweep' })).toBe(
      '⏱ Mijoz 15 daqiqadan beri javob kutyapti (AI qayta tekshirganda yozildi)',
    );
    expect(lateNote({ anchorSentAt: anchor, waitingSince: null, writtenAt: tk('2026-10-29T17:52'), origin: 'edit' })).toBe(
      '⏱ Mijoz 5 daqiqadan beri javob kutyapti (mijoz xabarini tahrirlagandan keyin)',
    );
  });

  it('a live or typing-wait run that is late names no cause it cannot know', () => {
    for (const origin of ['live', 'typing_wait', null] as const) {
      expect(lateNote({ anchorSentAt: anchor, waitingSince: null, writtenAt: tk('2026-10-29T17:57'), origin })).toBe('⏱ Mijoz 10 daqiqadan beri javob kutyapti');
    }
  });

  it('hours read as hours', () => {
    expect(lateNote({ anchorSentAt: anchor, waitingSince: null, writtenAt: tk('2026-10-29T21:00'), origin: 'live' })).toBe('⏱ Mijoz 3 soatdan beri javob kutyapti');
  });

  it('the inbound run passes the JOB’s origin — not a constant — into the note it writes first', () => {
    const run = readFileSync('src/modules/wms/agent/run.ts', 'utf8');
    const handle = run.slice(run.indexOf('export async function handleInbound('), run.indexOf('export async function __runsFor('));
    expect(handle).toContain('origin: job.origin');
    expect(handle.indexOf('notes.unshift(late)')).toBeLessThan(handle.indexOf('await writeDraft({'));
  });
});

describe('the C10 b code has its words (the exhaustive Record)', () => {
  it('memory_missing is a sentence, not a code', () => {
    expect(hitWords({ rule: 'G1', code: 'memory_missing' })).toBe(POLICY_WORDS.memory_missing);
    expect(POLICY_WORDS.memory_missing).not.toMatch(/^[a-z_]+$/u);
  });
});

describe('the page draws ✅ by the bot’s rule (C7, C10 a)', () => {
  it('an editing draft with no words of his has ✅; with his words, blocked, or cut, it has none', () => {
    expect(pageDrawsSend({ blocked: false, status: 'pending', ownText: false })).toBe(true);
    expect(pageDrawsSend({ blocked: false, status: 'editing', ownText: false })).toBe(true);
    expect(pageDrawsSend({ blocked: false, status: 'editing', ownText: true })).toBe(false);
    expect(pageDrawsSend({ blocked: true, status: 'editing', ownText: false })).toBe(false);
    expect(pageDrawsSend({ blocked: true, status: 'pending', ownText: true })).toBe(false);
    expect(pageDrawsSend({ blocked: false, status: 'approved', ownText: false })).toBe(false);
  });

  it('the page asks it', () => {
    expect(readFileSync('src/app/(protected)/suhbatlar/ai/page.tsx', 'utf8')).toContain('canSend={pageDrawsSend(d)}');
  });
});
