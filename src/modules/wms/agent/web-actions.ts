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
import { decideDraft, submitOwnText, type DraftDecision } from './decide';
import { KbError } from './kb';
import { approveStyleGuide } from './style';
import { AgentCancelError, cancelAgentReply } from './web-thread';
import { RetireError, addGeneralFact, assertFactSeen, editKbFact, retireKbFact } from './web-kb';
import { AGENT_PAGE } from './web-door';

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

/** ✅ / ❌ / 🙋 on a draft card. The ✅ posts the digest of what the page SHOWED (leak-3). */
export async function agentDecideAction(
  draftId: string,
  decision: Exclude<DraftDecision, 'edit'>,
  digest: string | null,
): Promise<AgentActionResult> {
  if (decision !== 'send' && decision !== 'reject' && decision !== 'human') return { ok: false, error: 'bad_value' };
  return run(async ({ actor, ctx }) => {
    const r = await decideDraft(actor, draftId, decision, { digest: decision === 'send' ? digest : undefined }, ctx);
    // The customer wrote again and nothing will draft it: «a new draft is coming» would be false here too.
    if (!r.ok) return { ok: false, error: r.code === 'superseded' && r.detail === 'no_draft' ? 'superseded_no_draft' : r.code };
    revalidatePath('/suhbatlar', 'layout');
    return { ok: true, sendAt: r.sendAt?.toISOString() };
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
 */
export async function agentRememberAction(draftId: string, op: 'g' | 'u' | 'z'): Promise<AgentActionResult> {
  if (op !== 'g' && op !== 'u' && op !== 'z') return { ok: false, error: 'bad_value' };
  return run(async ({ actor }) => {
    const answer = await agentPress(actor.id, op, draftId, undefined);
    return { ok: true, message: answer.reply ?? answer.toast };
  });
}

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
