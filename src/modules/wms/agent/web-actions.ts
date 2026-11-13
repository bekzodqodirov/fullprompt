'use server';

import { revalidatePath } from 'next/cache';
import { getActor, type Actor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { logger } from '@/modules/platform/logger';
import { isServerBehind } from '@/modules/platform/db/errors';
import { GuardError, clearAccountPause } from '../crm/account-guard';
import { agentPress } from './bot-door';
import {
  AgentConfigError,
  confirmSessionExclusive,
  mayRunAgent,
  readAgentConfig,
  setAgentMode,
  setAgentNumbers,
  setAgentOwner,
  setAviaRate,
} from './config';
import { decideDraft, submitOwnText, type DraftDecision, type SupersededDetail } from './decide';
import { KbError } from './kb';
import { approveStyleGuide } from './style';
import { AgentCancelError, cancelAgentReply } from './web-thread';
import { RetireError, addGeneralFact, assertFactSeen, editKbFact, retireKbFact } from './web-kb';
import { AGENT_PAGE } from './web-door';
import { AutoConfigError, STOP_AUTO_WORDS, autoFeedback, setAutoArmed, setAutoCategories, setAutoPerDay, stopAuto, stopAutoForEdit } from './auto-send';
import { deleteLesson, editLesson, lessonFromPage, lessonSavedWords, openLesson, setLessonActive, type LessonResult } from './lessons';
import { SendCapsError, setSendCaps } from './send-caps';
import { confirmTariff, TariffConfirmError } from './tariff-watch';

/**
 * The web half of the AI sotuvchi's decisions (spec §17.7 «Web: the same
 * decisions on /suhbatlar/ai, one function»). Every action here asks the
 * page's own door first — `mayRunAgent`, the configured owner or the
 * super_admin role (fit-11) — and then calls the ONE function the bot calls,
 * which asks its own narrower question (a draft is decided by its account
 * holder alone, leak-5). A refusal comes back as a CODE the page turns into
 * words; nothing here prints a sentence of its own.
 *
 * The pause clear and the cancel of a waiting reply are not behind the page's
 * door: a pause is any connected account's (his Q13 ⭐ — the account's own
 * manager or the super_admin role), and a waiting reply is cancelled from the
 * conversation, by its holder.
 */

export interface AgentActionResult {
  ok: boolean;
  error?: string;
  /** A sentence the bot's own door answered with (the «remember this» presses). */
  message?: string;
  /** The figure a knowledge refusal read as money (`KbError` money / money_context, ident fix F7). */
  detail?: string;
  /** For a ✅: when the reply will leave, ISO. */
  sendAt?: string;
}

type Gate = { actor: Actor; ctx: { actorId: string; ip: string | null; userAgent: string | null } };

async function gate(): Promise<Gate | { error: string }> {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  let config;
  try {
    config = await readAgentConfig();
  } catch (err) {
    if (isServerBehind(err)) return { error: 'not_ready' };
    throw err;
  }
  if (!mayRunAgent(actor, config)) return { error: 'forbidden' };
  const meta = await requestMeta();
  return { actor, ctx: { actorId: actor.id, ...meta } };
}

function refreshPage(): void {
  revalidatePath(AGENT_PAGE);
}

/** The figure a money refusal names — the page says WHICH number it read as a price (F7). */
function detailOf(err: unknown): { detail?: string } {
  return err instanceof KbError && (err.code === 'money' || err.code === 'money_context') && err.detail ? { detail: err.detail } : {};
}

/** Errors the services raise as a code, and the server one migration behind; anything else is a real fault. */
function codeOf(err: unknown): string | null {
  if (err instanceof AgentConfigError || err instanceof KbError || err instanceof GuardError) return err.code;
  if (err instanceof RetireError || err instanceof AgentCancelError) return err.code;
  if (isServerBehind(err)) return 'not_ready';
  return null;
}

async function run(work: (g: Gate) => Promise<AgentActionResult | void>): Promise<AgentActionResult> {
  const g = await gate();
  if ('error' in g) return { ok: false, error: g.error };
  try {
    const out = await work(g);
    refreshPage();
    return out ?? { ok: true };
  } catch (err) {
    const code = codeOf(err);
    if (code) return { ok: false, error: code, ...detailOf(err) };
    logger.error({ err }, '[agent] web action failed');
    throw err;
  }
}

/**
 * A `superseded` ✅ in the page's own labels (`/suhbatlar/ai` labels.ts), by
 * what the press found (decide `SUPERSEDED_AS`) — the bot says the same in its
 * words (bot-door `SUPERSEDED_WORDS`): «a new draft is coming» only when one
 * is, an edit said as an edit, an approved line as answered.
 */
const SUPERSEDED_ERROR: Record<SupersededDetail, string> = {
  redrafting: 'superseded',
  no_draft: 'superseded_no_draft',
  capped: 'superseded_capped',
  edited_redrafting: 'superseded_edited',
  edited_no_draft: 'superseded_edited_no_draft',
  edited_capped: 'superseded_edited_capped',
  answered: 'superseded_answered',
};

/** ✅ / ❌ / 🙋 on a draft card. The ✅ posts the digest of what the page SHOWED (leak-3). */
export async function agentDecideAction(
  draftId: string,
  decision: Exclude<DraftDecision, 'edit'>,
  digest: string | null,
): Promise<AgentActionResult> {
  if (decision !== 'send' && decision !== 'reject' && decision !== 'human') return { ok: false, error: 'bad_value' };
  return run(async ({ actor, ctx }) => {
    const r = await decideDraft(actor, draftId, decision, { digest: decision === 'send' ? digest : undefined }, ctx);
    // The chat moved: «a new draft is coming» only when one is (`SUPERSEDED_ERROR`).
    if (!r.ok) return { ok: false, error: r.code === 'superseded' ? (SUPERSEDED_ERROR[r.detail as SupersededDetail] ?? r.code) : r.code };
    revalidatePath('/suhbatlar', 'layout');
    return { ok: true, sendAt: r.sendAt?.toISOString() };
  });
}

/**
 * ✏️ pressed — BEFORE the box opens (fix pass B, C1): a reply counting down to
 * the machine's press stops here, on the server, as his ✏️ (auto-send
 * `stopAutoForEdit`), so the AI's own text cannot go while he types his
 * correction. «Kech» once the machine pressed; the box opens only on `ok`.
 */
export async function agentEditOpenAction(draftId: string): Promise<AgentActionResult> {
  return run(async ({ actor }) => {
    const r = await stopAutoForEdit(actor.id, draftId);
    if (!r.ok) return { ok: false, error: `auto_stop_${r.code}` };
    if (r.stopped) revalidatePath('/suhbatlar', 'layout');
  });
}

/** ✏️ — his own words become the body; the card comes back with ✅ (never sent on its own). */
export async function agentOwnTextAction(draftId: string, text: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    const r = await submitOwnText(actor, draftId, text, ctx);
    if (!r.ok) return { ok: false, error: r.code };
    return { ok: true };
  });
}

/**
 * «Bilimga yozaymi?» after he answered the agent's question himself — the
 * bot's own press (`agentPress` 'g' | 'u' | 'z'), so the two-press general
 * fact, the money refusal and the «faqat shu mijoz» scope are one code path.
 *
 * The general fact's yes carries the arm's token the page DREW
 * (`WebDraft.kbArmToken`), exactly as the bot's «📌 Ha, hammaga» carries it in
 * its callback: without it every page press only asked again, so 📌 could
 * never save from the page (found while writing his guide, 2026-11-10).
 */
export async function agentRememberAction(
  draftId: string,
  op: 'g' | 'u' | 'z',
  armToken?: string,
): Promise<AgentActionResult> {
  if (op !== 'g' && op !== 'u' && op !== 'z') return { ok: false, error: 'bad_value' };
  if (armToken !== undefined && (op !== 'g' || !/^[0-9a-f]{8}$/.test(armToken))) return { ok: false, error: 'bad_value' };
  return run(async ({ actor }) => {
    const answer = await agentPress(actor.id, op, draftId, armToken);
    // The arming answer names the BOT's button; the page draws its own yes.
    if (answer.buttons) return { ok: true, message: PAGE_ARM_SENTENCE };
    return { ok: true, message: answer.reply ?? answer.toast };
  });
}

const PAGE_ARM_SENTENCE =
  "📌 Bu javob BARCHA mijozlarga qo'llanadi. Rozi bo'lsangiz, «📌 Ha, barcha mijozlar uchun» tugmasini bosing.";

/** A general fact typed on the page — through `writeKbFact` (money and personal refusals). */
export async function agentAddFactAction(question: string, answer: string): Promise<AgentActionResult> {
  return run(async ({ ctx }) => {
    await addGeneralFact({ question: question.trim() || null, answer }, ctx);
  });
}

/** A fact's words corrected — the old row retired, a new approved one written (web-kb `editKbFact`). */
export async function agentEditFactAction(factId: string, question: string, answer: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    // The fact must be one the page lists to him (K10) — a posted id is no wider than the list.
    await assertFactSeen(actor, factId);
    await editKbFact(factId, { question: question.trim() || null, answer }, ctx);
  });
}

/**
 * His avia rate, $/kg. An empty box means «avia is not quoted» (the tool then
 * refuses and the model asks him); anything else must read as dollars with at
 * most cents — refused, never rounded.
 */
export async function agentAviaRateAction(raw: string): Promise<AgentActionResult> {
  const text = raw.trim();
  const value = text === '' ? null : /^\d{1,3}(?:[.,]\d{1,2})?$/u.test(text) ? Number(text.replace(',', '.')) : Number.NaN;
  return run(async ({ actor, ctx }) => {
    await setAviaRate(actor, value, ctx);
  });
}

export async function agentRetireFactAction(factId: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    await assertFactSeen(actor, factId);
    await retireKbFact(factId, ctx);
  });
}

/** On (shadow) or off. «Off» expires every live draft and cancels every waiting reply — their cards say so. */
export async function agentModeAction(mode: 'off' | 'shadow'): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    const change = await setAgentMode(actor, mode, ctx);
    if (change.expiredDraftIds.length > 0 || change.cancelledOutboxIds.length > 0) {
      const { refreshAgentCard } = await import('./card-io');
      const { refreshCardForOutbox } = await import('./drafts');
      for (const id of change.expiredDraftIds) await refreshAgentCard(id).catch(() => {});
      for (const id of change.cancelledOutboxIds) await refreshCardForOutbox(id).catch(() => {});
    }
    revalidatePath('/suhbatlar', 'layout');
  });
}

/** The account the agent speaks from — a super_admin's choice (the service refuses anybody else). */
export async function agentOwnerAction(userId: string | null): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    await setAgentOwner(actor, userId && /^[0-9a-f-]{36}$/iu.test(userId) ? userId : null, ctx);
    revalidatePath('/', 'layout');
  });
}

/** «Eski serverda Telegram sessiyasi yo'q qilindi» (ban-9). */
export async function agentSessionAction(): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    await confirmSessionExclusive(actor, ctx);
  });
}

/** The three numbers — bounded by the 0138 CHECKs; a non-integer is refused, never rounded. */
export async function agentNumbersAction(values: {
  humanPauseMin: string;
  dailyDraftCap: string;
  dailyTokenCap: string;
}): Promise<AgentActionResult> {
  const num = (raw: string) => (/^\d{1,9}$/u.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);
  return run(async ({ actor, ctx }) => {
    await setAgentNumbers(
      actor,
      {
        humanPauseMin: num(values.humanPauseMin),
        dailyDraftCap: num(values.dailyDraftCap),
        dailyTokenCap: num(values.dailyTokenCap),
      },
      ctx,
    );
  });
}

/** «Uslubni tasdiqlash» — the proposal becomes the guide every draft reads. */
export async function agentApproveStyleAction(): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    await approveStyleGuide(actor, ctx);
  });
}

/**
 * «Tekshirdim, qayta yoqish» on a paused account (regression-11) — on the
 * bridge panel and on the agent's page. `clearAccountPause` asks the door:
 * the account's own manager or the super_admin role.
 */
export async function clearPauseAction(accountId: string): Promise<AgentActionResult> {
  const actor = await getActor();
  if (!actor) return { ok: false, error: 'forbidden' };
  const meta = await requestMeta();
  try {
    await clearAccountPause(actor, accountId, { actorId: actor.id, ...meta });
  } catch (err) {
    const code = codeOf(err);
    if (code) return { ok: false, error: code };
    throw err;
  }
  revalidatePath('/suhbatlar', 'layout');
  return { ok: true };
}

/**
 * Take back an approved AI reply that has not left yet — its account holder
 * only, from the conversation it would have gone to. Every surface that
 * draws that conversation is revalidated (reply-actions' rule: a lead card's
 * path is the screen the person is on).
 */
export async function cancelAgentReplyAction(outboxId: string, path: string | null): Promise<AgentActionResult> {
  const actor = await getActor();
  if (!actor) return { ok: false, error: 'forbidden' };
  const meta = await requestMeta();
  let done;
  try {
    done = await cancelAgentReply(actor, outboxId, { actorId: actor.id, ...meta });
  } catch (err) {
    const code = codeOf(err);
    if (code) return { ok: false, error: code };
    throw err;
  }
  revalidatePath('/suhbatlar', 'layout');
  if (done.clientId) revalidatePath(`/admin/clients/${done.clientId}`);
  if (path && path.startsWith('/') && !path.startsWith('//')) revalidatePath(path);
  return { ok: true };
}

/**
 * «🤖 O‘zi yuborish» on the page (§18.3) — the same functions the bot's
 * «/agent auto», ⏸ and 👎 call, which ask their own narrower question (arm:
 * the account holder; disarm: he or a super_admin; ⏸ and 👎: the draft's
 * holder). Each refusal comes back as its OWN page code (`auto_…`): the
 * services share words like `not_found` and `not_account_holder` with the
 * draft decisions, and the page must not say «qoralama topilmadi» about a
 * switch.
 */
export async function agentAutoArmAction(armed: boolean): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    try {
      await setAutoArmed(actor, armed === true, ctx);
    } catch (err) {
      if (err instanceof AutoConfigError) return { ok: false, error: `auto_${err.code}` };
      throw err;
    }
    revalidatePath('/suhbatlar', 'layout');
  });
}

/** Which kinds of reply may go by themselves — the four boxes, replace-all (none disabled, #171). */
export async function agentAutoCategoriesAction(categories: string[]): Promise<AgentActionResult> {
  if (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string')) return { ok: false, error: 'auto_bad_value' };
  return run(async ({ actor, ctx }) => {
    try {
      await setAutoCategories(actor, categories, ctx);
    } catch (err) {
      if (err instanceof AutoConfigError) return { ok: false, error: `auto_${err.code}` };
      throw err;
    }
  });
}

/** A box's whole number, null for an empty one, NaN for anything else — the service refuses NaN as `bad_value`. */
function capOf(raw: unknown): number | null {
  if (typeof raw !== 'string') return Number.NaN;
  const s = raw.trim();
  if (s === '') return null;
  return /^\d{1,9}$/u.test(s) ? Number(s) : Number.NaN;
}

/** The layer's daily count (0148): an empty box is «no cap». The holder's — the service asks. */
export async function agentAutoPerDayAction(raw: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    try {
      await setAutoPerDay(actor, capOf(raw), ctx);
    } catch (err) {
      if (err instanceof AutoConfigError) return { ok: false, error: `auto_${err.code}` };
      throw err;
    }
  });
}

/**
 * The account-protection limits (0148): empty boxes are today's defaults. The holder's or a super_admin's — the
 * service asks; its refusals are the arming doors' own words (`auto_…`).
 */
export async function agentSendCapsAction(values: { dayCap: string; hourCap: string }): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    try {
      await setSendCaps(actor, { dayCap: capOf(values?.dayCap), hourCap: capOf(values?.hourCap) }, ctx);
    } catch (err) {
      if (err instanceof SendCapsError) return { ok: false, error: `auto_${err.code}` };
      throw err;
    }
  });
}

/**
 * «✅ Tarif to'g'ri» on the page (0148, spec SPEC-P1-v2 §1.6): vouches for the China column the page SHOWED (`seen`,
 * its stamp) — a column written since is refused in words, never confirmed unseen. The holder's or a super_admin's.
 */
export async function agentConfirmTariffAction(seen: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    if (typeof seen !== 'string' || !/^[0-9a-f]{8}$/u.test(seen)) return { ok: false, error: 'tariff_changed' };
    try {
      await confirmTariff(actor, seen, ctx);
    } catch (err) {
      if (err instanceof TariffConfirmError) return { ok: false, error: err.code };
      throw err;
    }
  });
}

/** ⏸ on a card counting down — the bot's op `a`. */
export async function agentAutoStopAction(draftId: string): Promise<AgentActionResult> {
  return run(async ({ actor }) => {
    const r = await stopAuto(actor.id, draftId);
    if (!r.ok) return { ok: false, error: r.code === 'not_ready' ? 'auto_not_ready' : `auto_stop_${r.code}` };
    revalidatePath('/suhbatlar', 'layout');
  });
}

/** 👎 «Xato edi» on a reply the machine sent — the bot's op `f`. */
export async function agentAutoFeedbackAction(draftId: string): Promise<AgentActionResult> {
  return run(async ({ actor }) => {
    const r = await autoFeedback(actor.id, draftId);
    // Said by the page itself: the row reads «👎», and a step-down shows as the panel's «o‘chiq» with its reason.
    if (!r.ok) return { ok: false, error: r.code === 'not_ready' ? 'auto_not_ready' : `auto_fb_${r.code}` };
  });
}

/**
 * «📝 Tuzatish» on the page (spec SPEC-P1-v2 §3) — the bot's own writer (`lessons.ts`), behind the page's door:
 * whoever it admits may teach, and only the account holder's lesson rewrites a card (the service asks). Each
 * refusal comes back as its OWN page code (`lesson_…`); a saved lesson answers with the bot's own sentence.
 */

/** A lesson's refusal as the page's code — with the figure a money refusal read as a price. */
function lessonRefused(r: Exclude<LessonResult, { ok: true }>): AgentActionResult {
  return { ok: false, error: `lesson_${r.code}`, ...(r.code === 'money' && r.detail ? { detail: r.detail } : {}) };
}

/**
 * 📝 pressed — BEFORE the box opens (§3.1, the `agentEditOpenAction` precedent): the holder's press on a reply
 * counting down stops it on the server, so the AI's own text cannot go while he types why it is wrong. «Kech» once
 * the machine pressed — said, and the box opens all the same: the lesson still teaches.
 */
export async function agentLessonOpenAction(draftId: string): Promise<AgentActionResult> {
  return run(async ({ actor }) => {
    const r = await openLesson(actor, draftId, 'web');
    if (!r.ok) return { ok: false, error: `lesson_${r.code}` };
    if (r.holder) revalidatePath('/suhbatlar', 'layout');
    if (r.after === 'pressed' || r.after === 'sending') return { ok: true, message: STOP_AUTO_WORDS[r.after] };
  });
}

/** The box's save — itself the confirmation (§3.2). The holder's lesson on a card still waiting rewrites it (§3.4). */
export async function agentLessonSaveAction(draftId: string, text: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    const r = await lessonFromPage(actor, { draftId, text: typeof text === 'string' ? text : '' }, ctx);
    if (!r.ok) return lessonRefused(r);
    if (r.redraft === 'queued') revalidatePath('/suhbatlar', 'layout');
    return { ok: true, message: lessonSavedWords(r) };
  });
}

/** «Saboqlar»: a lesson's words corrected — the same refusals as a new one; saving an unconfirmed one confirms it. */
export async function agentLessonEditAction(lessonId: string, text: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    const r = await editLesson(actor, lessonId, typeof text === 'string' ? text : '', ctx);
    if (!r.ok) return lessonRefused(r);
    return { ok: true, message: lessonSavedWords(r) };
  });
}

/** «Saboqlar»: a lesson switched off (it leaves the prompt and stays on the page) or back on. */
export async function agentLessonActiveAction(lessonId: string, active: boolean): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    const r = await setLessonActive(actor, lessonId, active === true, ctx);
    if (!r.ok) return lessonRefused(r);
    // Switched on, it is said whether the prompt has room for it — and what it pushed out.
    if (active === true && (!r.fits || r.dropped.length > 0)) return { ok: true, message: lessonSavedWords(r) };
  });
}

export async function agentLessonDeleteAction(lessonId: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    const r = await deleteLesson(actor, lessonId, ctx);
    if (!r.ok) return { ok: false, error: `lesson_${r.code}` };
  });
}
