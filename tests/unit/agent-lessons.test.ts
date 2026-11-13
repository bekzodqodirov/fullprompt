import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_OPS, buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { calibrationCells, categoryVerdicts, type CalibrationDraftRow } from '@/modules/wms/agent/calibration';
import { cardExtra, cardTeaches } from '@/modules/wms/agent/card';
import { FROM_LESSON_LINE, LESSON_REDRAFT_LINE, renderDraftCard, type DraftRow } from '@/modules/wms/agent/card-io';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { LESSONS_HEADING, LESSON_LIMITS, fitLessons, lessonLine, lessonsBlock, lessonsChars, type PromptLesson } from '@/modules/wms/agent/lesson-rules';
import {
  LESSON_PROMPT_LIVE,
  LESSON_PROMPT_SENT,
  LESSON_WORDS,
  lessonEchoRow,
  lessonEchoText,
  lessonInstruction,
  lessonPrompt,
  lessonRefusalWords,
  lessonSavedWords,
  lessonSetMark,
  lessonShapeRefusal,
  lessonTeachable,
  lessonWhyRow,
} from '@/modules/wms/agent/lessons';
import { chatBlock, runTail, stableHead } from '@/modules/wms/agent/prompt';
import { agentStats, type StatsDraftRow } from '@/modules/wms/agent/stats';
import { STOP_AUTO_WORDS } from '@/modules/wms/agent/auto-send';

/**
 * «📝 Tuzatish» — he tells the AI where it was wrong, the AI learns (spec SPEC-P1-v2 §3) — the pure rules: which
 * lessons the prompt carries and the bytes they become, where they sit (the cached head, nowhere else), what a
 * lesson's text is refused for, the card's button in every shape, the words of each answer, and the stats that
 * keep his own corrections out of the «80 %» record.
 */

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const lesson = (n: number, text = `Saboq ${n}: mijozdan avval tovar nomini so'ra.`): PromptLesson => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  text,
});

describe('which lessons the prompt carries (spec §3.3 — the cap, binding)', () => {
  it('forty lessons AND six thousand characters, whichever binds first — the numbers the spec gives', () => {
    expect(LESSON_LIMITS).toEqual({ maxChars: 500, promptCount: 40, promptChars: 6000 });
  });

  it('the forty-first lesson is left out — the OLDEST, because the list is newest first and the fit is a prefix', () => {
    const all = Array.from({ length: 41 }, (_, i) => lesson(41 - i));
    const { inPrompt, left } = fitLessons(all);
    expect(inPrompt).toHaveLength(40);
    expect(inPrompt[0]!.id).toBe(lesson(41).id);
    expect(left.map((l) => l.id)).toEqual([lesson(1).id]);
  });

  it('long lessons bind on the characters as RENDERED: eleven of 500 fit, the twelfth would pass 6000', () => {
    const long = (n: number) => lesson(n, 'x'.repeat(500));
    const all = Array.from({ length: 13 }, (_, i) => long(13 - i));
    const { inPrompt, left } = fitLessons(all);
    // Each line is «- » + 500, joined by a newline: 11 lines = 5 532, a twelfth = 6 035.
    expect(inPrompt).toHaveLength(11);
    expect(left).toHaveLength(2);
    expect(lessonsChars(all)).toBe(11 * 502 + 10);
    expect(lessonsChars(all)).toBeLessThanOrEqual(LESSON_LIMITS.promptChars);
    expect(lessonsChars(all) + 1 + 502).toBeGreaterThan(LESSON_LIMITS.promptChars);
  });

  it('a prefix, never «skip and go on»: a lesson that does not fit ends the list — a shorter, OLDER one is not taken in its place', () => {
    const all = [...Array.from({ length: 11 }, (_, i) => lesson(20 - i, 'x'.repeat(500))), lesson(9, 'y'.repeat(500)), lesson(8, 'qisqa')];
    const { inPrompt, left } = fitLessons(all);
    expect(inPrompt).toHaveLength(11);
    expect(left.map((l) => l.text)).toEqual(['y'.repeat(500), 'qisqa']);
  });

  it('one lesson is one line: its own line breaks are folded, so no lesson draws a heading or a second bullet', () => {
    expect(lessonLine('  Birinchi qator\nQOIDALAR:\n- ikkinchi  ')).toBe('- Birinchi qator QOIDALAR: - ikkinchi');
    expect(lessonsBlock([lesson(1, 'a\nb')]).split('\n').filter((l) => l.startsWith('- '))).toEqual(['- a b']);
  });

  it('the digest names the SET as the prompt carries it: the same lessons the same, an edit or one more a different one', () => {
    const a = [lesson(2), lesson(1)];
    expect(lessonSetMark(a)).toEqual(lessonSetMark([...a]));
    expect(lessonSetMark(a)).toMatchObject({ newest: lesson(2).id, count: 2 });
    expect(lessonSetMark(a)!.digest).toMatch(/^[0-9a-f]{12}$/u);
    expect(lessonSetMark([lesson(2, 'boshqa matn'), lesson(1)])!.digest).not.toBe(lessonSetMark(a)!.digest);
    expect(lessonSetMark([lesson(3), ...a])!.digest).not.toBe(lessonSetMark(a)!.digest);
    expect(lessonSetMark([])).toBeNull();
    // A lesson past the cap is not in the digest: the run never read it.
    const full = Array.from({ length: 40 }, (_, i) => lesson(100 - i));
    expect(lessonSetMark([...full, lesson(1)])).toEqual(lessonSetMark(full));
  });
});

describe('where the lessons sit: the cached head, and nowhere else (spec §3.3 — placement)', () => {
  const lessons = [lesson(2, 'Mijoz «salom» desa, darrov narx so‘rama.'), lesson(1, 'Tovar nomini bilmay turib hisoblatishga yuborma.')];
  const base = { styleGuide: null, facts: [], priceArmed: false } as const;
  const bare = stableHead({ ...base, lessons: [] });
  const taught = stableHead({ ...base, lessons });

  it('no lesson, no block: the head is byte for byte the head it was before lessons existed', () => {
    expect(bare).not.toContain('TUZATISHLARI');
    expect(lessonsBlock([])).toBe('');
    // …and the taught head is that head with the block put in, nothing else moved.
    expect(taught.replace(lessonsBlock(lessons), '')).toBe(bare);
  });

  it('the block sits right under the rules — after rule 16, before his style and the company facts — under the heading that keeps the rules above it', () => {
    const at = taught.indexOf(LESSONS_HEADING);
    expect(at).toBeGreaterThan(taught.indexOf('16. Har run compose_reply bilan tugaydi.'));
    expect(at).toBeLessThan(taught.indexOf('BEKZODNING USLUBI'));
    expect(at).toBeLessThan(taught.indexOf('KOMPANIYA BILIMLARI'));
    // The spec's own wording: a rule wins a conflict, and the three always-his questions stay his.
    expect(LESSONS_HEADING).toBe(
      'BEKZODNING TUZATISHLARI (QOIDALARdan keyin turadi: zid kelsa — qoida ustun; 10, 12, 13-qoidalarda doim needs_owner=true):',
    );
    expect(taught).toContain(`${LESSONS_HEADING}\n- Mijoz «salom» desa, darrov narx so‘rama.\n- Tovar nomini bilmay turib hisoblatishga yuborma.\n\nBEKZODNING USLUBI`);
  });

  it('the same lesson set gives a byte-identical head — the cache is written once', () => {
    expect(stableHead({ ...base, lessons: [...lessons] })).toBe(taught);
    expect(stableHead({ ...base, lessons: lessons.map((l) => ({ ...l })) })).toBe(taught);
    // A different order is a different head: the READER fixes the order, the head does not sort.
    expect(stableHead({ ...base, lessons: [...lessons].reverse() })).not.toBe(taught);
  });

  it('the cap holds in the head itself, whatever a caller hands over', () => {
    const sixty = Array.from({ length: 60 }, (_, i) => lesson(60 - i));
    const head = stableHead({ ...base, lessons: sixty });
    expect(head.split('\n').filter((l) => l.startsWith('- Saboq '))).toHaveLength(40);
    expect(head).toContain(lesson(60).text);
    expect(head).not.toContain(lesson(20).text);
  });

  it('no lesson text in the per-run tail or in the chat block — neither takes lessons at all', () => {
    const m: ChatMessage = {
      ref: '#1',
      id: '00000000-0000-4000-8000-000000000001',
      tgMessageId: 1n,
      direction: 'in',
      body: 'Salom',
      media: null,
      fileName: null,
      sentAt: new Date('2026-11-12T08:00:00Z'),
      autoSent: false,
      editedAt: null,
    };
    const ctx: AgentContext = {
      managerUserId: 'u',
      peerId: 1n,
      messages: [m],
      history: [m],
      anchor: m,
      burst: [m],
      lastOut: null,
      lastQuote: null,
      identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: 'Aziz', managerName: null, cargoAllowed: false },
      storedLocale: null,
      customerScript: 'latin',
      measures: [],
      openCalcs: [],
      ruleDecision: null,
    };
    expect(runTail({ day: '2026-11-12', canary: 'gsr-x' })).not.toContain('TUZATISH');
    expect(chatBlock(ctx)).not.toContain('TUZATISH');
    // Source-shape: the two functions have no way to receive them — the per-chat turn is what rule 7 calls data.
    const prompt = strip(readFileSync('src/modules/wms/agent/prompt.ts', 'utf8'));
    const tail = prompt.slice(prompt.indexOf('export function runTail'), prompt.indexOf('function when('));
    const chat = prompt.slice(prompt.indexOf('export function chatBlock'));
    expect(tail.length, 're-anchor: runTail').toBeGreaterThan(50);
    expect(chat.length, 're-anchor: chatBlock').toBeGreaterThan(200);
    expect(tail).not.toMatch(/lesson/iu);
    expect(chat).not.toMatch(/lesson/iu);
    expect(prompt.match(/lessonsBlock\(/gu)).toHaveLength(1);
  });

  it('a run reads the lessons ONCE, beside the general facts, and hands the same list to every round’s head', () => {
    const run = strip(readFileSync('src/modules/wms/agent/run.ts', 'utf8'));
    // Both run paths read them, each after its facts and before its loop.
    const reads = [...run.matchAll(/const taught = await promptLessons\(\);/gu)].map((m) => m.index!);
    expect(reads).toHaveLength(2);
    for (const at of reads) {
      expect(run.lastIndexOf('const facts = await generalFacts();', at), 'the facts are read first').toBeGreaterThan(at - 400);
      const loop = run.indexOf('runLoop({', at);
      expect(loop).toBeGreaterThan(at);
      expect(run.slice(loop, run.indexOf('});', loop))).toMatch(/lessons: taught\.lessons/u);
    }
    // The loop builds the head from its INPUT in every round — never a second read inside the loop.
    const loopBody = run.slice(run.indexOf('export async function runLoop'), run.indexOf('async function eligibilityFacts'));
    expect(loopBody.length, 're-anchor: runLoop').toBeGreaterThan(500);
    expect(loopBody.length).toBeLessThan(6000);
    expect(loopBody).toMatch(/systemCached: stableHead\(\{[^}]*lessons: input\.lessons,/su);
    expect(loopBody).not.toMatch(/promptLessons\(/u);
    expect(loopBody).toMatch(/system: runTail\(\{ day: input\.day, canary: input\.canary \}\)/u);
  });

  it('the reader asks the 0148 probe first: one migration behind there is no table and no block', () => {
    const src = strip(readFileSync('src/modules/wms/agent/lessons.ts', 'utf8'));
    const body = src.slice(src.indexOf('export async function promptLessons'), src.indexOf('export interface WebLesson'));
    expect(body.indexOf('agentFullP1Ready()')).toBeGreaterThan(0);
    expect(body.indexOf('agentFullP1Ready()')).toBeLessThan(body.indexOf('promptRows()'));
  });
});

describe('what a lesson’s text is refused for before any name is read (spec §3.2)', () => {
  it('empty, longer than the CHECK’s 500, or money — «narx saboq bo‘lmaydi»', () => {
    expect(lessonShapeRefusal('   ')).toEqual({ code: 'empty' });
    expect(lessonShapeRefusal('x'.repeat(501))).toEqual({ code: 'too_long' });
    expect(lessonShapeRefusal('x'.repeat(500))).toBeNull();
    expect(lessonShapeRefusal('Avia narxini 17 $ deb ayt')).toEqual({ code: 'money', detail: '17' });
    expect(lessonShapeRefusal('Mijozga 120 000 so‘m deb aytma')).toMatchObject({ code: 'money' });
    expect(LESSON_WORDS.money).toBe('Narx saboq bo‘lmaydi — narx vositalar va sozlamalardan keladi.');
    expect(LESSON_WORDS.personal).toContain('Matnda mijoz ma’lumoti bor — saboq hamma chatga boradi.');
  });

  it('an ordinary rule passes — a count or a day in it is no price', () => {
    expect(lessonShapeRefusal('Mijoz salom bersa, avval salomlash, keyin bitta savol ber.')).toBeNull();
    expect(lessonShapeRefusal('Javobni 3 jumladan oshirma.')).toBeNull();
  });

  it('a refusal names what was read — the figure, the personal bit — never «narx» about a text with none', () => {
    expect(lessonRefusalWords({ code: 'money', detail: '17' })).toBe(`«17» — ${LESSON_WORDS.money}`);
    expect(lessonRefusalWords({ code: 'personal', detail: 'GS555' })).toBe(`«GS555» — ${LESSON_WORDS.personal}`);
    expect(lessonRefusalWords({ code: 'too_long' })).toBe(LESSON_WORDS.too_long);
  });

  it('a lesson is given on the MACHINE’s words — or on its question to him; never on a 💵 price or his own ✏️ text', () => {
    expect(lessonTeachable({ kind: 'reply', finalBody: null, needsOwner: false })).toBe(true);
    expect(lessonTeachable({ kind: 'hand_back', finalBody: null, needsOwner: false })).toBe(true);
    expect(lessonTeachable({ kind: 'reply', finalBody: 'O‘zim yozdim', needsOwner: true })).toBe(true);
    expect(lessonTeachable({ kind: 'reply', finalBody: 'O‘zim yozdim', needsOwner: false })).toBe(false);
    expect(lessonTeachable({ kind: 'price', finalBody: null, needsOwner: false })).toBe(false);
  });
});

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
    proposedBody: 'Narxini aniqlab aytaman.',
    finalBody: null,
    glossUz: null,
    language: 'uz',
    category: 'faq',
    confidence: '0.90',
    nextStep: 'wait',
    policy: { blocks: [], warnings: [], ledger: [], notes: [], card: { customerLabel: 'GS1 · Ali', lastOut: null, customerLines: [] } },
    blocked: false,
    needsOwner: false,
    ownerQuestion: null,
    actions: [],
    citedMessageIds: [],
    offerId: null,
    actionStatus: null,
    actionError: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date('2026-11-12T08:00:00Z'),
    updatedAt: new Date('2026-11-12T08:00:00Z'),
    ...over,
  } as DraftRow;
}

describe('«📝 Tuzatish» on the card (spec §3.1): wherever the words are the machine’s', () => {
  const keys = (payload: Record<string, unknown>) => (buttonsFor('AgentDraft', { draftId: ID, kind: 'reply', text: 'x', ...payload }) ?? []).map((r) => r.map((b) => b.text));
  const live = { live: true, blocked: false, digest: 'a1b2c3d4' };

  it('a card waiting for his ✅: its own row, above ❌ and 🙋 — and without the key, yesterday’s keyboard exactly', () => {
    expect(keys({ ...live, teach: true })).toEqual([['✅ Yuborish', '✏️ O‘zgartirish'], ['📝 Tuzatish'], ['❌ Kerak emas', '🙋 Suhbat meniki']]);
    expect(keys({ ...live, teach: false })).toEqual([['✅ Yuborish', '✏️ O‘zgartirish'], ['❌ Kerak emas', '🙋 Suhbat meniki']]);
    expect(keys(live)).toEqual([['✅ Yuborish', '✏️ O‘zgartirish'], ['❌ Kerak emas', '🙋 Suhbat meniki']]);
    // A blocked card has no ✅ — and still says where to teach.
    expect(keys({ ...live, blocked: true, teach: true })).toEqual([['✏️ O‘zgartirish'], ['📝 Tuzatish'], ['❌ Kerak emas', '🙋 Suhbat meniki']]);
  });

  it('counting down, and a question: the same row', () => {
    expect(keys({ ...live, teach: true, autoAt: '2026-11-13T10:00:00.000Z' })).toEqual([
      ['⏸ To‘xtat', '✅ Hozir yubor'],
      ['✏️ O‘zgartirish'],
      ['📝 Tuzatish'],
      ['❌ Kerak emas', '🙋 Suhbat meniki'],
    ]);
    expect(keys({ ...live, teach: true, ask: true })).toEqual([
      ['✍️ Savolga javob'],
      ['✅ Yuborish', '✏️ O‘zgartirish'],
      ['📝 Tuzatish'],
      ['❌ Kerak emas', '🙋 Suhbat meniki'],
    ]);
  });

  it('a card that is no longer live: a reply he approved as the machine wrote it, one the machine sent, the «remember» card', () => {
    // Today an approved card drew nothing at all — the spec's own correction of v1.
    expect(buttonsFor('AgentDraft', { draftId: ID, kind: 'reply', text: 'x', live: false })).toBeNull();
    expect(keys({ live: false, teach: true })).toEqual([['📝 Tuzatish']]);
    expect(keys({ live: false, autoSent: true, autoCancel: true, teach: true })).toEqual([['❌ Bekor qilish', '🙋 Suhbat meniki'], ['👎 Xato edi'], ['📝 Tuzatish']]);
    expect(keys({ live: false, autoSent: true, autoBad: true, teach: true })).toEqual([['📝 Tuzatish']]);
    expect(keys({ live: false, kbAsk: true, teach: true })).toEqual([['📌 Umumiy qoida', '👤 Faqat shu mijoz'], ['✖ Saqlamaslik'], ['📝 Tuzatish']]);
    // The kbAsk branch returns early — without the key it is the three it always was.
    expect(keys({ live: false, kbAsk: true })).toEqual([['📌 Umumiy qoida', '👤 Faqat shu mijoz'], ['✖ Saqlamaslik']]);
  });

  it('the button is `ag:l:<draft>` — a letter the parser knows; the echo’s yes carries the lesson’s token, its no the lesson alone', () => {
    const rows = buttonsFor('AgentDraft', { draftId: ID, kind: 'reply', text: 'x', ...live, teach: true })!;
    const data = rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(data).toContain(`ag:l:${ID}`);
    expect(parseCallback(`ag:l:${ID}`)).toEqual({ kind: 'agent', op: 'l', id: ID });
    expect(AGENT_OPS).toEqual(expect.arrayContaining(['l', 'y', 'v']));
    const [yes, no] = lessonEchoRow(ID, 'a1b2c3d4')[0]!;
    expect(yes).toEqual({ text: '✅ Saqlash', callback_data: `ag:y:${ID}:a1b2c3d4` });
    expect(no).toEqual({ text: '✖ Bekor', callback_data: `ag:v:${ID}` });
    expect(parseCallback(yes!.callback_data)).toEqual({ kind: 'agent', op: 'y', id: ID, digest: 'a1b2c3d4' });
    expect(parseCallback(no!.callback_data)).toEqual({ kind: 'agent', op: 'v', id: ID });
    expect(Buffer.byteLength(yes!.callback_data)).toBeLessThanOrEqual(64);
    // 👎's follow-up is the SAME press as the card's 📝 (spec §3.5).
    expect(lessonWhyRow(ID)).toEqual([[{ text: '📝 Sababini yozish', callback_data: `ag:l:${ID}` }]]);
  });

  it('`teach` is written every time — a card re-pointed at a newer draft, or purged, must say no', () => {
    const base = { id: ID, body: 'x', actions: [], blocked: false, live: true, kind: 'reply' };
    expect(cardExtra(base).teach).toBe(false);
    expect(cardExtra({ ...base, teach: true }).teach).toBe(true);
    // Not read off `live`: a card that is no longer live still teaches.
    expect(cardExtra({ ...base, live: false, teach: true }).teach).toBe(true);
    const purge = strip(readFileSync('src/modules/wms/agent/purge.ts', 'utf8'));
    expect(purge).toMatch(/ask: false,\s*teach: false,/u);
  });

  it('which drafts carry it (`cardTeaches`): the machine’s words waiting or gone, the «remember» card — never a price, his ✏️ words, or a reply already being rewritten', () => {
    expect(cardTeaches(draft())).toBe(true);
    expect(cardTeaches(draft({ status: 'editing' }))).toBe(true);
    expect(cardTeaches(draft({ status: 'approved' }))).toBe(true);
    expect(cardTeaches(draft({ status: 'approved', finalBody: 'Ha, olamiz', needsOwner: true }))).toBe(true);
    expect(cardTeaches(draft({ status: 'approved', finalBody: 'Ha, olamiz' }))).toBe(false);
    expect(cardTeaches(draft({ finalBody: 'O‘zim yozdim' }))).toBe(false);
    expect(cardTeaches(draft({ kind: 'price' }))).toBe(false);
    expect(cardTeaches(draft({ kind: 'price', status: 'approved' }))).toBe(false);
    for (const status of ['rejected', 'superseded', 'expired', 'taken_over']) expect(cardTeaches(draft({ status })), status).toBe(false);
    const rewriting = { ...(draft().policy as object), lessonRedraft: { lessonId: ID, at: '2026-11-12T08:00:00.000Z' } };
    expect(cardTeaches(draft({ policy: rewriting as DraftRow['policy'] }))).toBe(false);
  });

  it('the card says when a lesson is rewriting it, and the rewrite says where it came from — until his own words replace either', () => {
    const rewriting = { ...(draft().policy as object), lessonRedraft: { lessonId: ID, at: '2026-11-12T08:00:00.000Z' } } as DraftRow['policy'];
    expect(renderDraftCard(draft({ policy: rewriting }), null)).toContain(LESSON_REDRAFT_LINE);
    expect(renderDraftCard(draft({ policy: rewriting, finalBody: 'O‘zim yozdim' }), null)).not.toContain(LESSON_REDRAFT_LINE);
    const from = { ...(draft().policy as object), fromLesson: { lessonId: ID, draftId: ID } } as DraftRow['policy'];
    expect(renderDraftCard(draft({ policy: from }), null)).toContain(FROM_LESSON_LINE);
    expect(renderDraftCard(draft({ policy: from, finalBody: 'O‘zim yozdim' }), null)).not.toContain(FROM_LESSON_LINE);
    // The reply a lesson replaced: never «↪️ Mijoz yana yozdi», which is false here.
    const replaced = { ...(draft().policy as object), stale: 'owner_lesson' } as DraftRow['policy'];
    const card = renderDraftCard(draft({ status: 'superseded', policy: replaced }), null);
    expect(card).toContain('📝 Saboq bo‘yicha AI qayta yozdi (yangi kartada).');
    expect(card).not.toContain('Mijoz yana yozdi');
  });
});

describe('the words of each answer (spec §3.1, §3.2, §3.4)', () => {
  it('the prompt says WHERE to write and WHAT — a rule, never the customer’s reply — and what a saved lesson does to this card', () => {
    expect(LESSON_PROMPT_LIVE.startsWith('📝')).toBe(true);
    expect(LESSON_PROMPT_LIVE).toContain('SHU BOTGA');
    expect(LESSON_PROMPT_LIVE).toContain('«✏️ O‘zgartirish»');
    expect(LESSON_PROMPT_LIVE).toContain('shu javobni qayta yozadi');
    expect(LESSON_PROMPT_SENT).toContain('Bu javob qayta yozilmaydi');
    expect(lessonPrompt({ live: true, after: null })).toBe(LESSON_PROMPT_LIVE);
    expect(lessonPrompt({ live: false, after: null })).toBe(LESSON_PROMPT_SENT);
    expect(lessonPrompt({ live: false, after: 'sent' })).toBe(LESSON_PROMPT_SENT);
  });

  it('«kech», in ⏸’s own words, when the machine’s ✅ beat the press and the reply has not left yet', () => {
    expect(lessonPrompt({ live: false, after: 'pressed' })).toBe(`${STOP_AUTO_WORDS.pressed}\n\n${LESSON_PROMPT_SENT}`);
    expect(lessonPrompt({ live: false, after: 'sending' })).toBe(`${STOP_AUTO_WORDS.sending}\n\n${LESSON_PROMPT_SENT}`);
    expect(lessonPrompt({ live: false, after: 'pressed' })).toContain('«❌ Bekor qilish»');
  });

  it('the echo quotes his words and says nothing counts yet', () => {
    expect(lessonEchoText('Salomga salom bilan javob ber')).toMatch(/^📝 Saboq: «Salomga salom bilan javob ber»/u);
    expect(lessonEchoText('x')).toContain('Saqlaymi?');
  });

  it('a saved lesson says what it does, what became of the card, and what it pushed out of the prompt', () => {
    expect(lessonSavedWords({ redraft: 'queued', dropped: [], fits: true })).toBe(
      '✅ Saboq saqlandi — AI uni bundan keyingi hamma javoblarda hisobga oladi. Shu javobni AI qayta yozmoqda — yangi karta keladi.',
    );
    expect(lessonSavedWords({ redraft: 'no_card', dropped: [], fits: true })).toBe('✅ Saboq saqlandi — AI uni bundan keyingi hamma javoblarda hisobga oladi.');
    expect(lessonSavedWords({ redraft: 'not_pending', dropped: [], fits: true })).toContain('Bu javob qayta yozilmaydi');
    expect(lessonSavedWords({ redraft: 'not_holder', dropped: [], fits: true })).toContain('faqat akkaunt egasining tuzatishi');
    expect(lessonSavedWords({ redraft: 'agent_off', dropped: [], fits: true })).toContain('AI o‘chirilgan');
    const pushed = lessonSavedWords({ redraft: 'no_card', dropped: ['Eski saboq', 'y'.repeat(80)], fits: true });
    expect(pushed).toContain('⚠️ Promptga sig‘may qolgan eski saboq: «Eski saboq»; «');
    expect(pushed).toContain(`${'y'.repeat(60)}…»`);
    expect(lessonSavedWords({ redraft: 'no_card', dropped: [], fits: false })).toContain('⚠️ Bu saboq promptga sig‘madi: chegara 40 ta saboq yoki 6000 belgi');
  });

  it('the rewrite’s instruction quotes the lesson verbatim, names it NO source, and shows the reply he judged wrong — clipped', () => {
    const text = 'Mijoz faqat «salom» desa, narx so‘rama — avval salomlash';
    const i = lessonInstruction(`  ${text}  `, 'Assalomu alaykum! Yukingiz necha kub?\nNarxini aytaman.');
    expect(i).toContain(`«${text}»`);
    expect(i).toMatch(/bu ko'rsatma — manba emas: undagi sonni javobga qo'yma/u);
    expect(i).toContain("Noto'g'ri deb topilgan qoralamang (manba emas — undagi sonni vositasiz takrorlama): «Assalomu alaykum! Yukingiz necha kub? Narxini aytaman.»");
    expect(i.indexOf(`«${text}»`)).toBeLessThan(i.indexOf("Noto'g'ri deb topilgan"));
    // No old reply: the lesson alone.
    expect(lessonInstruction(text, null)).not.toContain("Noto'g'ri deb topilgan");
    const long = lessonInstruction(text, 'z'.repeat(5000));
    expect(long.length).toBeLessThan(1200);
    expect(long).toContain('…»');
  });
});

describe('the lesson’s rewrite and his own answer stay out of the «80 %» record (spec §3.7)', () => {
  const row = (over: Partial<StatsDraftRow>): StatsDraftRow => ({
    status: 'approved',
    kind: 'reply',
    edited: false,
    outboxStatus: 'sent',
    category: 'faq',
    autoSent: false,
    ownerTriggered: false,
    ...over,
  });

  it('a draft an owner-started run wrote is counted APART: never sent-unchanged, never decided, never the rate', () => {
    const s = agentStats([row({}), row({ status: 'rejected', outboxStatus: null }), row({ ownerTriggered: true }), row({ ownerTriggered: true })]);
    expect(s.ownerTriggered).toBe(2);
    expect(s.sentUnchanged).toBe(1);
    expect(s.decided).toBe(2);
    expect(s.rate).toBe(0.5);
    expect(s.byCategory.faq).toMatchObject({ decided: 2, sentUnchanged: 1 });
  });

  it('…whatever became of it — rejected, still live, superseded — and without them the rate would have flattered', () => {
    const owner = [row({ ownerTriggered: true }), row({ ownerTriggered: true, status: 'rejected', outboxStatus: null }), row({ ownerTriggered: true, status: 'pending', outboxStatus: null })];
    const s = agentStats([row({ edited: true }), ...owner]);
    expect(s).toMatchObject({ ownerTriggered: 3, decided: 1, rate: 0, live: 0, rejected: 0 });
    // The same rows read as inbound ones: 1 of 3 unchanged — the inflation the split removes.
    expect(agentStats([row({ edited: true }), ...owner.map((r) => ({ ...r, ownerTriggered: false }))]).rate).toBeCloseTo(1 / 3);
  });

  it('a reply the machine pressed is counted as that first — one row, one bucket', () => {
    const s = agentStats([row({ autoSent: true, ownerTriggered: true })]);
    expect(s).toMatchObject({ autoSent: 1, ownerTriggered: 0 });
  });

  it('…and the calibration’s «proof» never counts them: sixty replies to his own lessons prove no category', () => {
    const clean = (over: Partial<CalibrationDraftRow>): CalibrationDraftRow => ({
      ...row({ category: 'greeting' }),
      confidence: 0.9,
      blocked: false,
      needsOwner: false,
      warnings: 0,
      notes: 0,
      money: false,
      actions: [],
      ...over,
    });
    const his = Array.from({ length: 60 }, () => clean({ ownerTriggered: true }));
    const greeting = (rows: CalibrationDraftRow[]) => categoryVerdicts(rows).find((v) => v.category === 'greeting')!;
    expect(greeting(his)).toMatchObject({ decided: 0, proven: false });
    expect(calibrationCells(his)).toEqual([]);
    // The same sixty written to a customer's line WOULD prove it — the inflation the split removes.
    expect(greeting(his.map((r) => ({ ...r, ownerTriggered: false })))).toMatchObject({ decided: 60, proven: true });
  });

  it('both readers say so: the page’s stats and the calibration script read the run’s trigger', () => {
    const page = strip(readFileSync('src/modules/wms/agent/web-page.ts', 'utf8'));
    expect(page).toMatch(/ownerTriggered: sql<boolean>`coalesce\(\$\{agentRuns\.trigger\}, 'inbound'\) <> 'inbound'`/u);
    expect(page).toMatch(/\.leftJoin\(agentRuns, eq\(agentRuns\.id, agentDrafts\.runId\)\)/u);
    const script = readFileSync('scripts/agent-calibration.ts', 'utf8');
    expect(script).toMatch(/coalesce\(r\.trigger, 'inbound'\) <> 'inbound' AS owner_triggered/u);
    expect(script).toMatch(/LEFT JOIN agent_runs r ON r\.id = d\.run_id/u);
  });
});

describe('the wiring (spec §3.1, §3.2, §3.5, §6)', () => {
  function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(name) ? [p] : [];
    });
  }
  const bot = strip(readFileSync('src/modules/platform/telegram/agent-bot.ts', 'utf8'));
  const door = strip(readFileSync('src/modules/wms/agent/bot-door.ts', 'utf8'));

  it('📝 is refused by `busy` like ✏️, 💵, 👤 and ✍️ — and the lesson wait is one of the agent’s own', () => {
    expect(bot).toMatch(/const ARMING_OPS: ReadonlySet<string> = new Set\(\['e', 'p', 'k', 'j', 'l'\]\);/u);
    expect(bot).toMatch(/const occupied = ARMING_OPS\.has\(parsed\.op\) \? busy\(chatId\) : null;/u);
    expect(bot).toMatch(/const AGENT_WAITS = \['agent_edit', 'agent_price', 'agent_code', 'agent_answer', 'agent_lesson'\] as const/u);
    expect(bot).toMatch(/agent_lesson: '📝 tuzatish'/u);
  });

  it('👎 arms NOTHING: its branch returns no wait — only the «📝 Sababini yozish» button, whose own press arms', () => {
    const f = door.slice(door.indexOf("case 'f': {"), door.indexOf("case 't':"));
    expect(f.length, "re-anchor: case 'f'").toBeGreaterThan(100);
    expect(f).not.toMatch(/\barm:/u);
    expect(f).toMatch(/buttons: lessonWhyRow\(id\)/u);
    // …and the lesson's own press is the one place the wait is armed.
    expect([...door.matchAll(/arm: \{ kind: 'agent_lesson'/gu)]).toHaveLength(1);
    const l = door.slice(door.indexOf("case 'l': {"), door.indexOf("case 'y': {"));
    expect(l).toMatch(/arm: \{ kind: 'agent_lesson', payload: \{ draftId: id \} \}/u);
  });

  it('a refused lesson keeps the wait: the slot asks the writer’s refusal BEFORE it consumes it', () => {
    const slot = bot.slice(bot.indexOf('export async function agentTextSlot'));
    const refusal = slot.indexOf('lessonRefusalFor(staff.id, target.payload.draftId, msg.text)');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(slot.indexOf('dropWait(chatId, target.kind);'));
  });

  it('a swipe-reply to the card of the draft a 📝 is armed for is the LESSON — never his verbatim ✏️ text, one ✅ from the customer', () => {
    expect(bot).toMatch(/\(waited\?\.kind === 'agent_answer' \|\| waited\?\.kind === 'agent_lesson'\) && waited\.payload\.draftId/u);
    expect(door).toMatch(/return armedFor && p\.draftId === armedFor\.draftId\s*\?\s*\{ kind: armedFor\.kind, payload: \{ draftId: p\.draftId \} \}\s*:\s*\{ kind: 'agent_edit', payload: \{ draftId: p\.draftId \} \};/u);
  });

  it('`agent_lessons` has ONE writer: every insert, update and delete of the table is the lessons service’s', () => {
    const writers = filesUnder('src').filter((file) => /\.(?:insert|update|delete)\(\s*agentLessons\s*\)/u.test(strip(readFileSync(file, 'utf8'))));
    expect(writers).toEqual(['src/modules/wms/agent/lessons.ts']);
  });

  it('every write of a lesson is audited — create, confirm, edit, switch, delete (entity `agent_lesson`)', () => {
    const src = strip(readFileSync('src/modules/wms/agent/lessons.ts', 'utf8'));
    const writes = [...src.matchAll(/\.(insert|update|delete)\(\s*agentLessons\s*\)/gu)].length;
    const audits = [...src.matchAll(/entityType: 'agent_lesson'/gu)].length;
    expect(writes).toBeGreaterThanOrEqual(6);
    expect(audits).toBe(writes);
  });

  it('a lesson’s rewrite rides the answer’s queue under its OWN key and carries no «o‘zi yuborish» plan', () => {
    const job = strip(readFileSync('src/modules/wms/agent/lesson-job.ts', 'utf8'));
    expect(job).toMatch(/sourceKey: `lesson:\$\{lesson\.id\}`/u);
    expect(job).toMatch(/trigger: 'owner_edit'/u);
    const run = strip(readFileSync('src/modules/wms/agent/run.ts', 'utf8'));
    // The plan is the ANSWER's alone: a lesson's rewrite and a hand-back's question get null.
    expect(run).toMatch(/const autoPlan = answer \? await autoPlanFor\(/u);
    const jobs = strip(readFileSync('src/modules/wms/agent/jobs.ts', 'utf8'));
    expect(jobs).toMatch(/job\.data\.lessonId \? await handleLessonRedraft\(job\.data\) : await handleOwnerAnswer\(job\.data\)/u);
  });
});
