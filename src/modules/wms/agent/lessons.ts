import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { agentDrafts, agentLessons, users } from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { afterPressOf, machinePressedReply, stopAutoForPerson, STOP_AUTO_WORDS, type AfterPress } from './auto-send';
import { answeredNow } from './card-io';
import { knownNamesFor } from './chat-names';
import { agentFullP1Ready, agentRunning, mayRunAgent, readAgentConfig } from './config';
import { personalBitsWithBook } from './kb';
import { currencyBesideQuantity, namesCurrency, normalizeDigits } from './digits';
import { extractNumbers, LESSON_COUNT_AFTER } from './numbers';
import { fitLessons, lessonsBlock, lessonsChars, LESSON_LIMITS, type LessonSetMark, type PromptLesson } from './lesson-rules';
import { ANSWER_RUN_STALE_MS } from './owner-answer';
import { JOB_AGENT_OWNER_ANSWER, type AgentOwnerAnswerJob } from './queues';
import { knownNamesForMask } from './style';
import type { DraftPolicyJson } from './types';

/**
 * «📝 Tuzatish» — he tells the AI where it was wrong, and the AI learns (spec SPEC-P1-v2 §3, his «hato qilgan joyini
 * men aytib ketay va u ozi organib boradgan bolsin»). ONE writer for both surfaces — the bot's press, wait and echo,
 * and the page's box and its «Saboqlar» tab.
 *
 * A lesson is an INSTRUCTION to every chat's prompt, never a source: a figure in it vouches for nothing a reply
 * says, and it reaches every customer's chat — so it is refused money (a price comes from the tools and the
 * settings) and anything personal (the reach a general fact is refused for, kb `writeKbFact`). Written in the bot it
 * is ECHOED before it counts («✅ Saqlash / ✖ Bekor», the yes carrying a one-time token): a text typed into a wait
 * he forgot must not become a rule in every prompt by itself. The page's save is itself the confirmation.
 *
 * On a card still waiting for his ✅ the confirmed lesson also REDRAFTS that reply (§3.4) — the account holder's
 * lesson only (a draft is decided by its holder alone), through the queued owner-triggered run, with no «o'zi
 * yuborish» plan: a reply he has just judged wrong comes back as an ordinary card. On a sent card it only teaches.
 */

export type LessonRefusal =
  | 'not_ready'
  | 'not_found'
  | 'forbidden'
  | 'not_teachable'
  | 'empty'
  | 'too_long'
  | 'money'
  | 'personal'
  | 'already'
  | 'confirmed';

/** Every refusal in his words (the bot's; the page maps the codes to its own bundles). */
export const LESSON_WORDS: Record<LessonRefusal, string> = {
  not_ready: 'Server hali yangilanmagan — keyinroq bosing.',
  not_found: 'Topilmadi',
  forbidden: 'Saboqni faqat AI sotuvchi akkaunti egasi yoki super admin yozadi.',
  not_teachable: 'Bu kartadagi matn AI yozgan emas — tuzatish AI yozgan javobga yoziladi.',
  empty: 'Saboq bo‘sh.',
  too_long: `Saboq juda uzun — ${LESSON_LIMITS.maxChars} belgigacha, qisqa qoida qilib yozing.`,
  money: 'Narx saboq bo‘lmaydi — narx vositalar va sozlamalardan keladi. Bu son narx bo‘lmasa — uni so‘z bilan yozing (masalan: «bir marta»).',
  personal: 'Matnda mijoz ma’lumoti bor — saboq hamma chatga boradi. Ism, kod va telefonsiz qayta yozing.',
  already: 'Allaqachon saqlangan.',
  confirmed: 'Saboq allaqachon saqlangan — o‘chirish yoki o‘zgartirish «Suhbatlar → AI sotuvchi → Saboqlar» sahifasida.',
};

/** A refusal's words with what was found — the figure read as a price, the personal bit — so «narx» is never said of a text with none. */
export function lessonRefusalWords(r: { code: LessonRefusal; detail?: string }): string {
  return (r.code === 'money' || r.code === 'personal') && r.detail ? `«${r.detail}» — ${LESSON_WORDS[r.code]}` : LESSON_WORDS[r.code];
}

/**
 * 📝's question. Starts with «📝»: the ladder's tests find it so. It says WHERE (this bot), WHAT (a short rule — never
 * the customer's reply, which is ✏️) and what a saved lesson does.
 */
const LESSON_ASK =
  '📝 AI qayerda xato qilganini SHU BOTGA yozing (shu xabarga javob qilib yoki 30 daqiqa ichida oddiy xabar bilan) — ' +
  `qisqa qoida qilib, ${LESSON_LIMITS.maxChars} belgigacha. Mijoz ismi, kodi, telefoni va narx yozilmaydi. ` +
  'Mijozga ketadigan matnni emas — uni «✏️ O‘zgartirish» bilan yozasiz.';
export const LESSON_PROMPT_LIVE = `${LESSON_ASK}\n\nSaqlasangiz AI uni keyingi hamma javoblarda hisobga oladi va shu javobni qayta yozadi.`;
export const LESSON_PROMPT_SENT = `${LESSON_ASK}\n\nBu javob qayta yozilmaydi — saboq keyingi javoblar uchun.`;

/** The prompt after a 📝 press: «kech» first when the machine's own ✅ beat the press and the reply has not left yet. */
export function lessonPrompt(open: { live: boolean; after: AfterPress | null }): string {
  if (open.live) return LESSON_PROMPT_LIVE;
  return open.after === 'pressed' || open.after === 'sending' ? `${STOP_AUTO_WORDS[open.after]}\n\n${LESSON_PROMPT_SENT}` : LESSON_PROMPT_SENT;
}

/** The echo under his typed lesson: nothing counts until «✅ Saqlash». Starts with «📝 Saboq:». */
export function lessonEchoText(text: string): string {
  return `📝 Saboq: «${text}»\n\nSaqlaymi? Saqlansa, AI uni HAMMA mijozlarga yozadigan javoblarida hisobga oladi.`;
}

/** The echo's two buttons — the yes carries the lesson's one-time token (the 📌 pattern). Exported for the callback fence (#939). */
export function lessonEchoRow(lessonId: string, token: string): { text: string; callback_data: string }[][] {
  return [
    [
      { text: '✅ Saqlash', callback_data: `ag:y:${lessonId}:${token}` },
      { text: '✖ Bekor', callback_data: `ag:v:${lessonId}` },
    ],
  ];
}

/** 👎's follow-up (§3.5): it arms NOTHING — the wait is armed only when this button is pressed. */
export function lessonWhyRow(draftId: string): { text: string; callback_data: string }[][] {
  return [[{ text: '📝 Sababini yozish', callback_data: `ag:l:${draftId}` }]];
}

type DraftRow = typeof agentDrafts.$inferSelect;
type LessonRow = typeof agentLessons.$inferSelect;

export interface LessonActor {
  id: string;
  roles: readonly string[];
}

/**
 * May a lesson be given on this draft at all: the words are the MACHINE's (never a 💵 price — his figure rendered by
 * code), or it is a question the machine put to him (the card that offers to remember his answer). Whatever the
 * draft's status: a lesson on a card that has since closed still teaches.
 */
export function lessonTeachable(d: Pick<DraftRow, 'kind' | 'finalBody' | 'needsOwner'>): boolean {
  return d.kind !== 'price' && (d.finalBody === null || d.needsOwner);
}

/** Is THIS draft one a confirmed lesson may rewrite — a reply of the machine's still waiting for his ✅? */
function redraftable(d: Pick<DraftRow, 'status' | 'kind' | 'finalBody'>): boolean {
  return d.status === 'pending' && d.kind === 'reply' && d.finalBody === null;
}

/** What a text is refused for before any name is read — pure. */
export function lessonShapeRefusal(text: string): { code: 'empty' | 'too_long' | 'money'; detail?: string } | null {
  const body = text.trim();
  if (!body) return { code: 'empty' };
  if ([...body].length > LESSON_LIMITS.maxChars) return { code: 'too_long' };
  // A fact's reader (`moneyIn`): in a text that names money a bare figure is money — «Narx: avia 17, avto 160», «Цену
  // называй 17» — less a COUNT (numbers `lesson`): «Narx haqida 1 marta ayt» was refused as the price «1» (review of
  // 0148 as built), and demanding the price word RIGHT before the figure instead let every usual way of stating a
  // price through (fix pass 3). Lessons about HOW to speak of the price are the likeliest ones.
  const money = extractNumbers(body, [], { lesson: true }).find((f) => f.kind === 'money');
  if (money) return { code: 'money', detail: money.raw };
  const unnamed = priceNamingNoMoney(body);
  if (unnamed) return { code: 'money', detail: unnamed };
  return null;
}

/**
 * A price stated with NO money word (fix pass 6, the hunt #7) — the fact's reader asks for one in the text, and a
 * lesson says the price as people do: by its unit («Avia kilosini 17 deb ayt», «Kubi 160 qilib ayt», «Kilosi 17, kubi
 * 160», «1 kub = 160», «160/kub», «Har kilo 17», «Каждый куб 160», «Every cbm 160», «Air is 17 a kilo»), after the
 * price QUESTION («Mijoz qancha deb so'rasa 160 de», «If asked how much, say 160»), spelled out beside a currency
 * («o'n yetti dollar», «семнадцать долларов»), or counted with «ta» before its currency («17 ta dollar») or after its
 * price word with nothing counted («Narx 17 tadan»). Read FAIL-CLOSED: in a lesson that names a measure unit or asks
 * the price, every bare figure that is no count is a price — a lesson is an instruction, never a source, and a price
 * saved in one is said to every customer.
 */
const LESSON_UNIT = '(?:kub|kilo|kg|tonn|cbm|cubes?|m3|куб|кило|кг|тонн|м3)\\p{L}*';
const LESSON_UNIT_ANY = new RegExp(`(?<![\\p{L}])${LESSON_UNIT}`, 'iu');
const UNIT_BEFORE_FIGURE = new RegExp(`(?<![\\p{L}])${LESSON_UNIT}(?:\\s+(?:uchun|учун|ga|га|за))?\\s*[:=—–-]?\\s*$`, 'iu');
const UNIT_PER_AFTER = new RegExp(`^\\s*(?:/|(?:a|an|per|each|за|в)\\s+)\\s*${LESSON_UNIT}`, 'iu');
const PRICE_ASKED = /(?<![\p{L}])(?:qancha\p{L}*|necha\s+pul|nechpul|қанча\p{L}*|неча\s+пул|сколько|почём|почем|how\s+much|what\s+price)/iu;
const PRICE_WORD_BEFORE = /(?<![\p{L}])(?:narx\p{L}*|нарх\p{L}*|цен\p{L}*|price\p{L}*|tarif\p{L}*|тариф\p{L}*)\s*[:—–-]?\s*$/iu;
const CLASSIFIER_THEN = /^\s*(?:ta|та)(?:dan|дан)?(?:\s+(\S+)|\s*(?:[,.;!?]|$))/iu;
function priceNamingNoMoney(body: string): string | null {
  const t = normalizeDigits(body);
  if (currencyBesideQuantity(t)) return t.trim();
  const unitNamed = LESSON_UNIT_ANY.test(t);
  const asked = PRICE_ASKED.test(t);
  for (const f of extractNumbers(t, [], { lesson: true })) {
    if (f.kind === 'date' || f.fixed) continue;
    const before = t.slice(0, f.index);
    const after = t.slice(f.index + f.raw.length);
    if (UNIT_BEFORE_FIGURE.test(before) || UNIT_PER_AFTER.test(after)) return f.raw;
    // «17 ta dollar» — the classifier before its currency; «Narx 17 tadan (deb ayt)» — after its price word, counting
    // nothing a lesson counts (never «Narx so‘rasa, 1 tadan ortiq emoji»: no price word right before it).
    const counted = CLASSIFIER_THEN.exec(after);
    const next = counted?.[1];
    if (counted && ((next !== undefined && namesCurrency(next)) || (PRICE_WORD_BEFORE.test(before) && (next === undefined || !LESSON_COUNT_AFTER.test(next))))) {
      return f.raw;
    }
    if (f.kind === 'plain' && !LESSON_COUNT_AFTER.test(after) && (unitNamed || asked)) return f.raw;
  }
  return null;
}

/**
 * Everything a lesson's text is refused for: its shape, money, and — exactly as a general fact (kb `writeKbFact`,
 * bot-door `kbPress`) — another customer's code, a phone, a name: the chat's own names by any word of them
 * (`knownNamesFor`), and every whole name the client book and the staff hold that the text carries.
 */
export async function lessonTextRefusal(
  text: string,
  draft: Pick<DraftRow, 'managerUserId' | 'peerId' | 'clientId' | 'leadId'> | null,
): Promise<{ code: LessonRefusal; detail?: string } | null> {
  const shape = lessonShapeRefusal(text);
  if (shape) return shape;
  const lowered = text.toLowerCase();
  const chat = draft ? await knownNamesFor(draft) : [];
  const book = (await knownNamesForMask(false)).filter((n) => lowered.includes(n.toLowerCase()));
  const bits = await personalBitsWithBook(text, [...chat, ...book]);
  return bits.length > 0 ? { code: 'personal', detail: bits[0] } : null;
}

// ── the press ───────────────────────────────────────────────────────────────

export type LessonOpen = { ok: true; live: boolean; after: AfterPress | null; holder: boolean } | { ok: false; code: LessonRefusal };

/**
 * 📝 pressed — the bot's `ag:l` and the page's box, BEFORE either takes a word (§3.1).
 *
 * The bot: the holder alone — the draft's account AND the agent's (callback data can be forged; anybody else hears
 * «Topilmadi»). The page: whoever its door admits; a super_admin who is not the holder may write a lesson and
 * decides nothing about the draft, so his press stops no countdown.
 *
 * The holder's press on a card still waiting stops its countdown FIRST (`owner_lesson`): a reply he is about to
 * call wrong must not go by itself while he types why. A stop that found nothing may have lost to the machine's own
 * ✅ a moment ago — then `after` says where that reply is («kech», ⏸'s own words), and the lesson only teaches. An
 * ✏️ or a ✍️ he had opened on this very draft is over: his next text is a lesson, never the customer's words.
 */
export async function openLesson(actor: LessonActor, draftId: string, surface: 'bot' | 'web'): Promise<LessonOpen> {
  if (!(await agentFullP1Ready())) return { ok: false, code: 'not_ready' };
  const config = await readAgentConfig();
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d || !config) return { ok: false, code: 'not_found' };
  const holder = d.managerUserId === actor.id && config.ownerUserId === actor.id;
  if (surface === 'bot' && !holder) return { ok: false, code: 'not_found' };
  if (surface === 'web' && !mayRunAgent(actor, config)) return { ok: false, code: 'forbidden' };
  if (!lessonTeachable(d)) return { ok: false, code: 'not_teachable' };
  if (!holder) return { ok: true, live: false, after: null, holder };
  let status = d.status;
  if (status === 'pending' || status === 'editing') {
    if (!(await stopAutoForPerson(draftId, actor.id, 'owner_lesson'))) {
      const [fresh] = await db.select({ status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.id, draftId));
      status = fresh?.status ?? status;
    }
  }
  if (status === 'approved') {
    // A reply the MACHINE approved says where it is; one he approved himself has nothing to add.
    return { ok: true, live: false, after: afterPressOf((await machinePressedReply(draftId))?.outbox ?? null), holder };
  }
  if (status === 'editing' && !answeredNow(d)) await releaseOpened(d);
  return { ok: true, live: redraftable({ ...d, status: status === 'editing' ? 'pending' : status }), after: null, holder };
}

/** The ✏️ or ✍️ he had opened on the draft he is now teaching on: closed, in words on its card. */
async function releaseOpened(d: DraftRow): Promise<void> {
  if (((d.policy ?? {}) as Partial<DraftPolicyJson>).answering) {
    const { releaseAnswering } = await import('./decide');
    await releaseAnswering(d.id, { note: '✍️ Javob kutish bekor — tuzatish yozyapsiz.', redraft: true });
    return;
  }
  const rows = await db
    .update(agentDrafts)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(agentDrafts.id, d.id), eq(agentDrafts.status, 'editing'), sql`NOT (coalesce(${agentDrafts.policy}, '{}'::jsonb) ? 'answering')`))
    .returning({ id: agentDrafts.id });
  if (rows.length > 0) await refreshCard(d.id, ['✏️ Tahrir bekor — tuzatish yozyapsiz.']);
}

// ── the writer ──────────────────────────────────────────────────────────────

async function insertLesson(
  input: { text: string; draftId: string | null; createdBy: string; confirmed: boolean },
  ctx: AuditContext,
): Promise<LessonRow> {
  const [row] = await db
    .insert(agentLessons)
    .values({
      text: input.text,
      draftId: input.draftId,
      createdBy: input.createdBy,
      confirmedAt: input.confirmed ? new Date() : null,
      confirmToken: input.confirmed ? null : randomBytes(4).toString('hex'),
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'agent_lesson',
    entityId: row!.id,
    action: 'create',
    after: { text: row!.text, confirmed: input.confirmed, draftId: input.draftId },
  });
  return row!;
}

/** The lessons the prompt carries right now, newest first — the set a write is compared against (`droppedBy`). */
async function promptRows(): Promise<{ id: string; text: string }[]> {
  const rows = await db
    .select({ id: agentLessons.id, text: agentLessons.text })
    .from(agentLessons)
    .where(and(eq(agentLessons.active, true), isNotNull(agentLessons.confirmedAt)))
    .orderBy(desc(agentLessons.createdAt), desc(agentLessons.id))
    .limit(LESSON_LIMITS.promptCount + 1);
  return fitLessons(rows).inPrompt;
}

/**
 * What a write did to the prompt (§3.3): the lessons that were in it before and fell out (never the one the write
 * itself took out), and whether the written lesson is in it now.
 */
async function promptChange(before: readonly { id: string; text: string }[], self: string, removed: boolean): Promise<{ dropped: string[]; fits: boolean }> {
  const after = await promptRows();
  const now = new Set(after.map((l) => l.id));
  return {
    dropped: before.filter((l) => l.id !== self && !now.has(l.id)).map((l) => l.text),
    fits: removed || now.has(self),
  };
}

export type LessonRedraft = 'queued' | 'no_card' | 'not_pending' | 'agent_off' | 'not_holder';

export interface LessonSaved {
  ok: true;
  id: string;
  text: string;
  /** What became of the card it was given on (§3.4). */
  redraft: LessonRedraft;
  /** Lessons this write pushed out of the prompt — their words. */
  dropped: string[];
  /** The lesson itself is in the prompt now. */
  fits: boolean;
}

export type LessonResult = LessonSaved | { ok: false; code: LessonRefusal; detail?: string };

/** A saved lesson in his words — what it does from now on, what became of the card, and what it pushed out. */
export function lessonSavedWords(s: Pick<LessonSaved, 'redraft' | 'dropped' | 'fits'>): string {
  const card: Record<LessonRedraft, string> = {
    queued: ' Shu javobni AI qayta yozmoqda — yangi karta keladi.',
    no_card: '',
    not_pending: ' Bu javob qayta yozilmaydi (karta kutilayotgan emas) — saboq keyingi javoblar uchun.',
    agent_off: ' AI o‘chirilgan — bu javob qayta yozilmadi.',
    not_holder: ' Javobni faqat akkaunt egasining tuzatishi qayta yozdiradi — saboq keyingi javoblar uchun.',
  };
  const clip = (t: string) => ([...t].length > 60 ? `${[...t].slice(0, 60).join('')}…` : t);
  const lines = [`✅ Saboq saqlandi — AI uni bundan keyingi hamma javoblarda hisobga oladi.${card[s.redraft]}`];
  if (!s.fits) lines.push(`⚠️ Bu saboq promptga sig‘madi: chegara ${LESSON_LIMITS.promptCount} ta saboq yoki ${LESSON_LIMITS.promptChars} belgi — eng yangilari o‘qiladi.`);
  if (s.dropped.length > 0) lines.push(`⚠️ Promptga sig‘may qolgan eski saboq: ${s.dropped.map((t) => `«${clip(t)}»`).join('; ')}.`);
  return lines.join('\n');
}

/**
 * His typed lesson in the BOT (the `agent_lesson` wait): stored UNCONFIRMED — not in any prompt — with the token its
 * «✅ Saqlash» carries. The holder alone, as the press; the draft is read for its names only and may be gone.
 */
export async function lessonFromBot(
  actor: LessonActor,
  draftId: string,
  text: string,
  ctx: AuditContext,
): Promise<{ ok: true; id: string; token: string; text: string } | { ok: false; code: LessonRefusal; detail?: string }> {
  if (!(await agentFullP1Ready())) return { ok: false, code: 'not_ready' };
  const config = await readAgentConfig();
  if (!config || config.ownerUserId !== actor.id) return { ok: false, code: 'not_found' };
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (d && d.managerUserId !== actor.id) return { ok: false, code: 'not_found' };
  const refused = await lessonTextRefusal(text, d ?? null);
  if (refused) return { ok: false, ...refused };
  const row = await insertLesson({ text: text.trim(), draftId: d?.id ?? null, createdBy: actor.id, confirmed: false }, ctx);
  return { ok: true, id: row.id, token: row.confirmToken!, text: row.text };
}

/**
 * «✅ Saqlash» under the echo: the lesson counts from here — one compare-and-set on its token, so a press delivered
 * twice confirms once («Allaqachon saqlangan», and no second redraft). Then the card it was given on (§3.4).
 */
export async function confirmLesson(actor: LessonActor, lessonId: string, token: string | undefined, ctx: AuditContext): Promise<LessonResult> {
  if (!(await agentFullP1Ready())) return { ok: false, code: 'not_ready' };
  const config = await readAgentConfig();
  if (!config || config.ownerUserId !== actor.id || !token) return { ok: false, code: 'not_found' };
  const before = await promptRows();
  const now = new Date();
  const [row] = await db
    .update(agentLessons)
    .set({ confirmedAt: now, confirmToken: null, updatedAt: now })
    .where(and(eq(agentLessons.id, lessonId), eq(agentLessons.createdBy, actor.id), eq(agentLessons.confirmToken, token), isNull(agentLessons.confirmedAt)))
    .returning();
  if (!row) {
    const [l] = await db.select({ createdBy: agentLessons.createdBy, confirmedAt: agentLessons.confirmedAt }).from(agentLessons).where(eq(agentLessons.id, lessonId));
    return { ok: false, code: l && l.createdBy === actor.id && l.confirmedAt ? 'already' : 'not_found' };
  }
  await writeAudit(db, ctx, { entityType: 'agent_lesson', entityId: row.id, action: 'update', before: { confirmed: false }, after: { confirmed: true, text: row.text } });
  const change = await promptChange(before, row.id, false);
  return { ok: true, id: row.id, text: row.text, redraft: await queueLessonRedraft(actor, row), ...change };
}

/** «✖ Bekor» under the echo: the unconfirmed lesson is gone. A confirmed one is the page's to change. */
export async function cancelLesson(actor: LessonActor, lessonId: string, ctx: AuditContext): Promise<{ ok: true } | { ok: false; code: LessonRefusal }> {
  if (!(await agentFullP1Ready())) return { ok: false, code: 'not_ready' };
  const [gone] = await db
    .delete(agentLessons)
    .where(and(eq(agentLessons.id, lessonId), eq(agentLessons.createdBy, actor.id), isNull(agentLessons.confirmedAt)))
    .returning({ id: agentLessons.id, text: agentLessons.text });
  if (!gone) {
    const [l] = await db.select({ createdBy: agentLessons.createdBy }).from(agentLessons).where(eq(agentLessons.id, lessonId));
    return { ok: false, code: l && l.createdBy === actor.id ? 'confirmed' : 'not_found' };
  }
  await writeAudit(db, ctx, { entityType: 'agent_lesson', entityId: gone.id, action: 'delete', before: { text: gone.text, confirmed: false } });
  return { ok: true };
}

/**
 * The page's 📝 box (§3.1, §3.6): its save is itself the confirmation. Whoever the page admits may teach; only the
 * holder's lesson rewrites the card (§3.4).
 */
export async function lessonFromPage(actor: LessonActor, input: { draftId: string; text: string }, ctx: AuditContext): Promise<LessonResult> {
  if (!(await agentFullP1Ready())) return { ok: false, code: 'not_ready' };
  const config = await readAgentConfig();
  if (!mayRunAgent(actor, config)) return { ok: false, code: 'forbidden' };
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, input.draftId));
  if (!d) return { ok: false, code: 'not_found' };
  if (!lessonTeachable(d)) return { ok: false, code: 'not_teachable' };
  const refused = await lessonTextRefusal(input.text, d);
  if (refused) return { ok: false, ...refused };
  const before = await promptRows();
  const row = await insertLesson({ text: input.text.trim(), draftId: d.id, createdBy: actor.id, confirmed: true }, ctx);
  const change = await promptChange(before, row.id, false);
  return { ok: true, id: row.id, text: row.text, redraft: await queueLessonRedraft(actor, row), ...change };
}

async function pageLesson(actor: LessonActor, lessonId: string): Promise<LessonRow | LessonRefusal> {
  if (!(await agentFullP1Ready())) return 'not_ready';
  if (!mayRunAgent(actor, await readAgentConfig())) return 'forbidden';
  const [row] = await db.select().from(agentLessons).where(eq(agentLessons.id, lessonId));
  return row ?? 'not_found';
}

/** A lesson's words corrected on the page — the same refusals as a new one. Saving an unconfirmed one confirms it. */
export async function editLesson(actor: LessonActor, lessonId: string, text: string, ctx: AuditContext): Promise<LessonResult> {
  const was = await pageLesson(actor, lessonId);
  if (typeof was === 'string') return { ok: false, code: was };
  const [d] = was.draftId ? await db.select().from(agentDrafts).where(eq(agentDrafts.id, was.draftId)) : [];
  const refused = await lessonTextRefusal(text, d ?? null);
  if (refused) return { ok: false, ...refused };
  const before = await promptRows();
  const now = new Date();
  const [row] = await db
    .update(agentLessons)
    .set({ text: text.trim(), confirmedAt: was.confirmedAt ?? now, confirmToken: null, updatedAt: now })
    .where(eq(agentLessons.id, lessonId))
    .returning();
  if (!row) return { ok: false, code: 'not_found' };
  await writeAudit(db, ctx, {
    entityType: 'agent_lesson',
    entityId: row.id,
    action: 'update',
    before: { text: was.text, confirmed: was.confirmedAt !== null },
    after: { text: row.text, confirmed: true },
  });
  const change = await promptChange(before, row.id, !row.active);
  // An edit teaches and rewrites nothing: the card it was given on has long had its own decision.
  return { ok: true, id: row.id, text: row.text, redraft: 'no_card', ...change };
}

/** A lesson switched on or off — off, it stays on the page and leaves the prompt. */
export async function setLessonActive(actor: LessonActor, lessonId: string, active: boolean, ctx: AuditContext): Promise<LessonResult> {
  const was = await pageLesson(actor, lessonId);
  if (typeof was === 'string') return { ok: false, code: was };
  if (was.active === active) return { ok: true, id: was.id, text: was.text, redraft: 'no_card', dropped: [], fits: true };
  const before = await promptRows();
  const [row] = await db.update(agentLessons).set({ active, updatedAt: new Date() }).where(eq(agentLessons.id, lessonId)).returning();
  if (!row) return { ok: false, code: 'not_found' };
  await writeAudit(db, ctx, { entityType: 'agent_lesson', entityId: row.id, action: 'update', before: { active: was.active, text: was.text }, after: { active, text: row.text } });
  const change = await promptChange(before, row.id, !active || row.confirmedAt === null);
  return { ok: true, id: row.id, text: row.text, redraft: 'no_card', ...change };
}

export async function deleteLesson(actor: LessonActor, lessonId: string, ctx: AuditContext): Promise<{ ok: true } | { ok: false; code: LessonRefusal }> {
  const was = await pageLesson(actor, lessonId);
  if (typeof was === 'string') return { ok: false, code: was };
  const [gone] = await db.delete(agentLessons).where(eq(agentLessons.id, lessonId)).returning({ id: agentLessons.id });
  if (!gone) return { ok: false, code: 'not_found' };
  await writeAudit(db, ctx, {
    entityType: 'agent_lesson',
    entityId: gone.id,
    action: 'delete',
    before: { text: was.text, active: was.active, confirmed: was.confirmedAt !== null },
  });
  return { ok: true };
}

// ── the redraft (§3.4) ──────────────────────────────────────────────────────

/**
 * The card a confirmed lesson was given on is rewritten when it is still the machine's reply waiting for his ✅ —
 * and only for the account holder (a draft is decided by its holder alone). The countdown stands down first (the
 * page's save has no press before it), the draft takes the mark its rewrite must find (`policy.lessonRedraft`, by a
 * compare-and-set on «still pending, still the machine's words»), and the run is QUEUED — never a model call on the
 * bot's poller or in a page action (#706). Nothing is retired here: the rewrite supersedes the draft inside its own
 * transaction (drafts `createDraft`), so a run that fails leaves the card as it was.
 */
async function queueLessonRedraft(actor: LessonActor, lesson: Pick<LessonRow, 'id' | 'draftId'>): Promise<LessonRedraft> {
  if (!lesson.draftId) return 'no_card';
  const config = await readAgentConfig();
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, lesson.draftId));
  if (!d) return 'no_card';
  if (d.managerUserId !== actor.id || config?.ownerUserId !== actor.id) return 'not_holder';
  if (!redraftable(d)) return 'not_pending';
  if (!agentRunning(config)) return 'agent_off';
  await stopAutoForPerson(d.id, actor.id, 'owner_lesson');
  const mark = { lessonId: lesson.id, at: new Date().toISOString() };
  const [row] = await db
    .update(agentDrafts)
    .set({ updatedAt: new Date(), policy: sql`coalesce(${agentDrafts.policy}, '{}'::jsonb) || ${JSON.stringify({ lessonRedraft: mark })}::jsonb` })
    .where(and(eq(agentDrafts.id, d.id), eq(agentDrafts.status, 'pending'), eq(agentDrafts.kind, 'reply'), isNull(agentDrafts.finalBody)))
    .returning({ peerId: agentDrafts.peerId });
  if (!row) return 'not_pending';
  await refreshCard(d.id);
  const job: AgentOwnerAnswerJob = { managerUserId: actor.id, peerId: String(row.peerId), draftId: d.id, messageId: 0, lessonId: lesson.id };
  // retryLimit 0: a re-delivered model call is a second bill; the run's source key keeps one lesson one draft. A job
  // that never queued is the sweep's to hand back, in words (`releaseStaleLessonRedrafts`).
  await enqueue(JOB_AGENT_OWNER_ANSWER, job, { retryLimit: 0 }).catch((err: unknown) => logger.error({ err, draftId: d.id }, '[agent] lesson redraft not queued'));
  return 'queued';
}

/** How much of the reply he judged wrong the rewrite is shown — it is context, never a source. */
const OLD_REPLY_SHOWN = 700;

/**
 * The rewrite's instruction (§3.4): his lesson, named as an instruction and NOT a source — a figure in it may not
 * reach the reply (the policy holds every figure to the tools and the customer's own lines) — and the reply he
 * judged wrong, so the model knows what the lesson is about.
 */
export function lessonInstruction(lesson: string, oldReply: string | null): string {
  const old = (oldReply ?? '').replace(/\s+/gu, ' ').trim();
  const shown = [...old].length > OLD_REPLY_SHOWN ? `${[...old].slice(0, OLD_REPLY_SHOWN).join('')}…` : old;
  const was = shown ? ` Noto'g'ri deb topilgan qoralamang (manba emas — undagi sonni vositasiz takrorlama): «${shown}».` : '';
  return `Bekzod shu chatdagi qoralamangni noto'g'ri deb topdi va tuzatish berdi (bu ko'rsatma — manba emas: undagi sonni javobga qo'yma): «${lesson.trim()}».${was} Shu tuzatishga amal qilib, mijozning so'nggi xabariga javobni qaytadan yoz — mijoz tilida va alifbosida.`;
}

/**
 * The mark comes off the card a lesson was rewriting — the rewrite did not come (`note` says why) — only while it
 * still names THIS lesson: a newer lesson's mark is that lesson's. False: nothing to clear.
 */
export async function clearLessonRedraft(draftId: string, lessonId: string, note: string | null): Promise<boolean> {
  const rows = await db
    .update(agentDrafts)
    .set({ updatedAt: new Date(), policy: sql`${agentDrafts.policy} - 'lessonRedraft'` })
    .where(and(eq(agentDrafts.id, draftId), sql`${agentDrafts.policy}->'lessonRedraft'->>'lessonId' = ${lessonId}`))
    .returning({ id: agentDrafts.id });
  if (rows.length === 0) return false;
  await refreshCard(draftId, note ? [note] : []);
  return true;
}

/** The notice beside his card: the reply was not rewritten, why, and that the lesson is kept all the same. */
export async function tellNoLessonDraft(d: Pick<DraftRow, 'managerUserId' | 'peerId' | 'policy'>, lesson: string, why: string): Promise<void> {
  const label = ((d.policy ?? {}) as Partial<DraftPolicyJson>).card?.customerLabel ?? '—';
  await notifyStaffTelegram({
    userIds: [d.managerUserId],
    type: 'AgentNotice',
    text: `📝 AI javobni qayta yozmadi — ${label}\nSabab: ${why}.\nSaboq saqlangan: «${lesson}» — keyingi javoblarda qo‘llanadi. Bu mijozga kartadagi «✏️ O‘zgartirish» bilan o‘zingiz yozing.`,
    // The chat the purge finds a notice by — this one names the customer.
    extra: { peerId: String(d.peerId) },
  });
}

/**
 * The sweep's step for a rewrite that died with its worker (a deploy, a kill, a job that never queued): the mark
 * comes off, the card says so, and he is told — or the card would say «AI qayta yozmoqda» for ever.
 */
export async function releaseStaleLessonRedrafts(now: Date): Promise<number> {
  if (!(await agentFullP1Ready())) return 0;
  const before = new Date(now.getTime() - ANSWER_RUN_STALE_MS).toISOString();
  const stale = await db
    .select()
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.status, 'pending'),
        sql`${agentDrafts.policy} ? 'lessonRedraft'`,
        lt(sql`(${agentDrafts.policy}->'lessonRedraft'->>'at')::timestamptz`, sql`${before}::timestamptz`),
      ),
    );
  let released = 0;
  for (const d of stale) {
    const lessonId = ((d.policy ?? {}) as Partial<DraftPolicyJson>).lessonRedraft?.lessonId;
    if (!lessonId) continue;
    if (!(await clearLessonRedraft(d.id, lessonId, '📝 AI javobni qayta yozmadi (ishchi javob bermadi) — saboq saqlangan.'))) continue;
    released += 1;
    const [lesson] = await db.select({ text: agentLessons.text }).from(agentLessons).where(eq(agentLessons.id, lessonId));
    // A lesson he has since deleted has nothing «kept» to tell him about: the card's own line is the news.
    if (!lesson) continue;
    await tellNoLessonDraft(d, lesson.text, 'AI ishchisi javob bermadi').catch((err: unknown) => logger.warn({ err, draftId: d.id }, '[agent] stale lesson redraft not told'));
  }
  return released;
}

// ── the readers ─────────────────────────────────────────────────────────────

export interface LessonSet {
  lessons: PromptLesson[];
  /** What the draft's policy keeps of them (§3.7) — null when the run read none. */
  mark: LessonSetMark | null;
}

const NO_LESSONS: LessonSet = { lessons: [], mark: null };

/** The digest of a lesson set as the prompt carries it — the block's own bytes. */
export function lessonSetMark(lessons: readonly PromptLesson[]): LessonSetMark | null {
  const { inPrompt } = fitLessons(lessons);
  if (inPrompt.length === 0) return null;
  return {
    digest: createHash('sha256').update(lessonsBlock(inPrompt)).digest('hex').slice(0, 12),
    newest: inPrompt[0]!.id,
    count: inPrompt.length,
  };
}

/**
 * The lessons a run reads (§3.3) — ONCE per run, beside the general facts, so an edit mid-run cannot move the cached
 * head between rounds: active, confirmed, newest first by (created_at, id) so the bytes are stable, cut to the caps.
 * One migration behind 0148 there is no table and no block.
 */
export async function promptLessons(): Promise<LessonSet> {
  if (!(await agentFullP1Ready())) return NO_LESSONS;
  const lessons = await promptRows();
  return { lessons, mark: lessonSetMark(lessons) };
}

export interface WebLesson {
  id: string;
  text: string;
  active: boolean;
  /** Confirmed — «✅ Saqlash» in the bot, or saved on the page. An unconfirmed one is in no prompt. */
  confirmed: boolean;
  /** The prompt carries it today («promptda»); an active, confirmed one it does not is «sig'madi». */
  inPrompt: boolean;
  createdByName: string;
  createdAt: Date;
}

const WEB_LESSONS_CAP = 200;

/** The «Saboqlar» tab: every lesson, newest first, each marked by whether the prompt carries it (§3.6). */
export async function webLessons(): Promise<{ lessons: WebLesson[]; inPrompt: number; chars: number } | null> {
  if (!(await agentFullP1Ready())) return null;
  const rows = await db
    .select({
      id: agentLessons.id,
      text: agentLessons.text,
      active: agentLessons.active,
      confirmedAt: agentLessons.confirmedAt,
      createdAt: agentLessons.createdAt,
      createdByName: users.fullName,
    })
    .from(agentLessons)
    .innerJoin(users, eq(users.id, agentLessons.createdBy))
    .orderBy(desc(agentLessons.createdAt), desc(agentLessons.id))
    .limit(WEB_LESSONS_CAP);
  const fitted = fitLessons(rows.filter((r) => r.active && r.confirmedAt !== null)).inPrompt;
  const carried = new Set(fitted.map((r) => r.id));
  return {
    lessons: rows.map((r) => ({
      id: r.id,
      text: r.text,
      active: r.active,
      confirmed: r.confirmedAt !== null,
      inPrompt: carried.has(r.id),
      createdByName: r.createdByName,
      createdAt: r.createdAt,
    })),
    inPrompt: fitted.length,
    chars: lessonsChars(fitted),
  };
}

async function refreshCard(draftId: string, notes: string[] = []): Promise<void> {
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(draftId, notes);
  } catch (err) {
    logger.warn({ err, draftId }, '[agent] card not refreshed');
  }
}
