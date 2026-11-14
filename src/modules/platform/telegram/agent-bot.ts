import type { Bot, Context } from 'grammy';
import { logger } from '../logger';
import { holdingIntake } from './calc-store';
import { activeCapture } from './note-capture';
import { answerPress } from './press';
import { peekTaskPending, staffForChat, type BotCallback } from './staff-bot';
import { isBacklog } from './lifecycle';
import { markOnce, messageKey } from './once';
import { activeDraft } from './task-draft';
import { armWait, dropWait, flushWaitWrites, nowSec, readWait, waitVerdict, type WaitKind } from './waits';

/**
 * The AI sotuvchi in the staff bot — the grammY shell only. Every decision is
 * the wms side's (`wms/agent/bot-door.ts`, reached by dynamic import:
 * platform never imports wms statically, the startBoss crossing); this file
 * answers the press, arms and drops the agent's one-text waits (`AGENT_WAITS`),
 * and sits in the text ladder's ONE agent slot (review regression-6).
 */

const AGENT_WAITS = ['agent_edit', 'agent_price', 'agent_code', 'agent_answer', 'agent_lesson'] as const satisfies readonly WaitKind[];
type AgentWait = (typeof AGENT_WAITS)[number];

/** A one-text wait lasts half an hour — long enough to think, short enough not to swallow tomorrow's text. */
export const AGENT_WAIT_TTL_MS = 30 * 60_000;

const BUSY = 'Avval boshlangan ishni tugating (hisoblatish, zametka yoki topshiriq).';
const BUSY_TASK = "Avval topshiriq bo'yicha so'ralgan javobni yozing (natija, savol yoki sana) — keyin qayta bosing.";
// The same wait holds the thread's «💬 Javob yozish», which is no task (taskId '').
const BUSY_REPLY = "Avval «💬 Javob yozish» so'ragan javobni yozing — keyin qayta bosing.";

/**
 * A live collector — or a task's one-text wait (a «Bajarildi» result, «💬
 * Javob yozish», a ⏰ date, review I2 b): a press that ARMS an agent wait
 * while another question is on the screen would leave his next text to
 * whichever reads first. Null = free; otherwise the words that name the
 * question actually waiting. A «Hisoblatish» collection refuses only while it
 * HOLDS the chat (docs/SAKKIZ-R3.md §6.2.7): it now waits 24 hours, but a
 * parked one — idle past the half hour every collection used to live for —
 * no longer takes his text, so it no longer stands in the agent's way.
 */
function busy(chatId: bigint): string | null {
  if (holdingIntake(chatId) || activeCapture(chatId) || activeDraft(chatId)) return BUSY;
  return taskWaitWords(chatId);
}

/** A task's one-text wait, in the words naming it; null when none is armed. */
function taskWaitWords(chatId: bigint): string | null {
  const task = peekTaskPending(chatId);
  if (!task) return null;
  return task.kind === 'reply' ? BUSY_REPLY : BUSY_TASK;
}

/**
 * One of the agent's waits is on the screen (✏️ his text, 💵 his price, 👤 a stranger's code, ✍️ his answer to its
 * question, 📝 his lesson).
 */
const BUSY_AGENT =
  'Avval AI sotuvchi so‘ragan javobni yozing (javob matni, narx, mijoz kodi, savolga javob yoki tuzatish) — keyin qayta bosing.';

/** What each agent wait was waiting for — said when a new one closes it (spec SPEC-P1-v2 §2.2: one at a time, in words). */
const WAIT_NAMES: Record<AgentWait, string> = {
  agent_edit: '✏️ javob matni',
  agent_price: '💵 narx',
  agent_code: '👤 mijoz kodi',
  agent_answer: '✍️ savolga javob',
  agent_lesson: '📝 tuzatish',
};

/**
 * A one-text wait this chat's next text answers — a task's (a «Bajarildi»
 * result, «💬 Javob yozish», a ⏰ date) or one of the agent's own — in the
 * words naming it; null when none. The collector asks it before a press makes
 * a PARKED collection hold the chat again (calc-intake-sweep.ts
 * `otherCollectorLive`, review REG-2 / COMP-5): a holding collection is asked
 * first by the text ladder and would file that answer as its material.
 */
export function waitingAnswerWords(chatId: bigint): string | null {
  const task = taskWaitWords(chatId);
  if (task) return task;
  const now = nowSec();
  for (const kind of AGENT_WAITS) {
    const entry = readWait<unknown>(chatId, kind);
    if (entry && waitVerdict(entry, now, false) === 'answers') return BUSY_AGENT;
  }
  return null;
}

/** How many of one target's prompts a swipe-reply may still name (✏️ tapped again re-asks the same thing). */
const PROMPTS_KEPT = 5;

/**
 * Was a task's question put on the screen AFTER this agent wait? The task
 * wait's own `armedAt` cannot say: a re-press of the same task MERGES and
 * keeps the earliest prompt's time (waits.ts, judge Q5H-1), so a «✅
 * Bajarildi» pressed again after ✏️ read as older than ✏️. The agent wait
 * records the task wait's expiry as it stood when the agent asked
 * (`taskSeen`); any arm or re-arm since moves that expiry later — the merge
 * keeps the LATEST expiry. An agent wait from before the record compares the
 * old way.
 */
function taskArmedSince(task: { armedAt: number; expiresAt: number }, agent: { payload: Record<string, string>; armedAt: number }): boolean {
  const seen = agent.payload.taskSeen;
  if (seen === undefined || !/^\d+$/.test(seen)) return task.armedAt >= agent.armedAt;
  return task.expiresAt > Number(seen);
}

/** The presses that ARM a one-text wait — each refused while another question holds the chat (`busy`). */
const ARMING_OPS: ReadonlySet<string> = new Set(['e', 'p', 'k', 'j', 'l']);

/** One agent press: decided on the server, answered in words. */
export async function handleAgentPress(
  ctx: Context,
  chatId: bigint,
  parsed: Extract<BotCallback, { kind: 'agent' }>,
): Promise<void> {
  const staff = await staffForChat(chatId);
  if (!staff) {
    await answerPress(ctx, 'Ulanmagan');
    return;
  }
  // A press that ARMS a text wait must not compete with a live collector:
  // his next text would be filed by whichever reads first.
  // 📝 (`l`) too — on a card and under 👎's answer alike (spec SPEC-P1-v2 §3.1, §3.5): its next text is a RULE for
  // every chat's prompt, the last thing a collector's material or a task's result may be filed as.
  const occupied = ARMING_OPS.has(parsed.op) ? busy(chatId) : null;
  if (occupied) {
    await answerPress(ctx, occupied);
    await ctx.reply(occupied);
    return;
  }
  try {
    const { agentPress, recordCardCopies, releaseAnswer, releaseEdit } = await import('../../wms/agent/bot-door');
    const out = await agentPress(staff.id, parsed.op, parsed.id, parsed.digest);
    // The same target asked again keeps its earlier prompts answerable (a
    // swipe-reply to the FIRST ✏️ prompt is still this draft's text).
    let earlierPrompts: string[] = [];
    // The other agent waits this arm closes (spec SPEC-P1-v2 §2.2) — said when a ✍️ is one of them.
    const replaced: AgentWait[] = [];
    if (out.arm) {
      // One live agent wait at a time; a second ✏️ releases the first draft
      // in words rather than silently re-targeting it (leak-6).
      const prev = readWait<{ draftId?: string }>(chatId, 'agent_edit');
      if (prev?.payload.draftId && prev.payload.draftId !== out.arm.payload.draftId) {
        await releaseEdit(staff.id, prev.payload.draftId);
      }
      // …and a ✍️ armed for another draft hands that question back (its card says so; the lines that stood down
      // for it are asked again). On the same draft the press itself decided it (✏️ took the mark, ✍️ re-asks).
      const prevAnswer = readWait<{ draftId?: string }>(chatId, 'agent_answer');
      if (prevAnswer?.payload.draftId && prevAnswer.payload.draftId !== out.arm.payload.draftId) {
        await releaseAnswer(staff.id, prevAnswer.payload.draftId);
      }
      const same = readWait<Record<string, string>>(chatId, out.arm.kind);
      const arm = out.arm;
      if (same && Object.entries(arm.payload).every(([k, v]) => same.payload[k] === v)) {
        earlierPrompts = (same.payload.promptMessageIds ?? same.payload.promptMessageId ?? '').split(',').filter(Boolean);
      }
      const at = nowSec();
      for (const kind of AGENT_WAITS) {
        if (kind === out.arm.kind) continue;
        const live = readWait<unknown>(chatId, kind);
        if (live && waitVerdict(live, at, false) === 'answers') replaced.push(kind);
        dropWait(chatId, kind);
      }
    }
    if (out.drop) dropWait(chatId, out.drop);
    let closed: string | null = null;
    // The ✏️ or ✍️ armed for THIS draft is over (C7, §2.2): a ✅, ❌ or 🙋 decided it.
    for (const kind of ['agent_edit', 'agent_answer'] as const) {
      if (out.dropEditOf && readWait<{ draftId?: string }>(chatId, kind)?.payload.draftId === out.dropEditOf) {
        dropWait(chatId, kind);
        if (kind === 'agent_edit') closed = out.editClosed ?? null;
      }
    }
    await answerPress(ctx, out.toast);
    // The message pressed has nothing left to press (a lesson's echo, saved or dropped): its buttons go. Best
    // effort — a second press is refused by the lesson's own compare-and-set all the same.
    if (out.closeButtons) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch((err: unknown) => logger.warn({ err }, '[agent] buttons not closed'));
    }
    const prompt = out.reply
      ? await ctx.reply(out.reply, out.buttons ? { reply_markup: { inline_keyboard: out.buttons } } : undefined)
      : null;
    // The ✏️ he armed for this draft is over, and his next text goes elsewhere — said where it stays.
    if (closed && !prompt) await ctx.reply(closed);
    // One agent wait at a time, closed in WORDS where a ✍️ or a 📝 is concerned (§2.2, §3.1): his next text answers
    // the new one — and a text meant for the customer must never land as a lesson, nor a lesson as the reply.
    if (out.arm && replaced.length > 0 && [out.arm.kind, ...replaced].some((k) => k === 'agent_answer' || k === 'agent_lesson')) {
      await ctx.reply(`↩️ Oldingi kutish yopildi (${replaced.map((k) => WAIT_NAMES[k]).join(', ')}) — endi yozganingiz shu yangi so‘rovga boradi.`);
    }
    // The draft's text on its own (✏️, C4), after the prompt: copied, changed and sent back —
    // as a reply to it too, so it is one of the prompts the wait names.
    const copy = out.followUp ? await ctx.reply(out.followUp) : null;
    if (out.quotes) {
      const quoted = [
        ...(out.quotes.parts.includes('reply') && prompt ? [prompt] : []),
        ...(out.quotes.parts.includes('followUp') && copy ? [copy] : []),
      ];
      // Where the chat's purge finds them (leak-9); a failure here must not undo the press.
      await recordCardCopies(staff.id, out.quotes.draftId, quoted.map((m) => ({ chatId: Number(chatId), messageId: m.message_id }))).catch(
        (err: unknown) => logger.warn({ err }, '[agent] card copy not recorded'),
      );
    }
    if (out.arm) {
      // Armed AFTER its prompt, at the prompt's own date, naming the prompt
      // (the task waits' rule, Q5 a): a swipe-reply to THIS question — or to
      // an earlier one for the same target — answers it, and the task wait as
      // it stands now is recorded, so a question asked after this one is
      // known to be newer (I2).
      const asked = [prompt, copy].filter((m): m is NonNullable<typeof m> => m !== null).map((m) => String(m.message_id));
      const prompts = [...earlierPrompts, ...asked].slice(-PROMPTS_KEPT);
      armWait(
        chatId,
        out.arm.kind,
        {
          ...out.arm.payload,
          ...(prompts.length > 0 ? { promptMessageIds: prompts.join(',') } : {}),
          taskSeen: String(readWait<unknown>(chatId, 'task')?.expiresAt ?? 0),
        },
        AGENT_WAIT_TTL_MS,
        prompt?.date ?? nowSec(),
      );
    }
  } catch (err) {
    logger.error({ err, op: parsed.op }, '[agent] press failed');
    await answerPress(ctx, 'Xatolik — qayta urinib ko‘ring');
  }
}

export interface AgentSlotMessage {
  text: string;
  dateSec: number;
  /** The bot's own message this one swipe-replies to, or null. */
  replyToMessageId: number | null;
  /** A forward is Door B's, never anybody's typed answer (I2 c). */
  forwarded: boolean;
}

/**
 * The agent's slot in the text ladder: BELOW every live collector, ABOVE the
 * reply door and `takeTaskPending` (which deletes on read). True = handled.
 *
 * Whose text is it (review I2)?
 *  - a FORWARD is nobody's answer — Door B offers it as a task;
 *  - a REPLY names its own target: an agent card, or the very prompt the agent
 *    wait was armed from — a swipe-reply to any other bot message (a task
 *    copy, a thread ping) is that message's door's, wait or no wait;
 *  - otherwise the one live agent wait — unless a task's wait was armed AFTER
 *    it: the newest question on the screen is the one this text answers, and
 *    the agent wait stays for the text after.
 */
export async function agentTextSlot(ctx: Context, chatId: bigint, msg: AgentSlotMessage): Promise<boolean> {
  if (msg.forwarded) return false;
  // Memory first: a chat with no agent wait and no reply costs no query.
  let waited: { kind: AgentWait; payload: Record<string, string>; armedAt: number } | null = null;
  for (const kind of AGENT_WAITS) {
    const entry = readWait<Record<string, string>>(chatId, kind);
    if (entry && waitVerdict(entry, msg.dateSec, isBacklog(msg.dateSec)) === 'answers') {
      waited = { kind, payload: entry.payload, armedAt: entry.armedAt };
      break;
    }
  }
  // The text a plain (non-reply) message answers: the agent wait, unless a
  // task's question went on the screen after it.
  let plain = waited;
  if (waited) {
    const task = readWait<unknown>(chatId, 'task');
    if (task && waitVerdict(task, msg.dateSec, isBacklog(msg.dateSec)) === 'answers' && taskArmedSince(task, waited)) {
      plain = null;
    }
  }
  if (!plain && msg.replyToMessageId === null) return false;
  const staff = await staffForChat(chatId);
  if (!staff) return false;
  const { agentCardFor, agentText, answerStillLive, editStillLive } = await import('../../wms/agent/bot-door');
  let target: { kind: AgentWait; payload: Record<string, string> } | null = null;
  if (msg.replyToMessageId !== null) {
    // A reply's target is the message it names — the agent prompt's too, newer task wait or not. A swipe-reply to
    // a draft's CARD is his verbatim ✏️ text, unless ✍️ — or 📝 — is armed for that very draft (spec SPEC-P1-v2
    // §2.2, §3.1): then it is the answer, or the lesson, the press asked for. A lesson filed as the customer's
    // reply would sit on the card one ✅ away from the customer.
    const armedFor =
      (waited?.kind === 'agent_answer' || waited?.kind === 'agent_lesson') && waited.payload.draftId
        ? { kind: waited.kind, draftId: waited.payload.draftId }
        : null;
    target = await agentCardFor(staff.id, chatId, msg.replyToMessageId, armedFor);
    // A reply to a stranger or echo card is a CODE only while that rule's
    // code wait is armed (he pressed «👤 Mijoz — kod»): a reply alone opens no echo.
    if (target?.kind === 'agent_code' && !(waited?.kind === 'agent_code' && waited.payload.ruleId === target.payload.ruleId)) {
      target = null;
    }
    const prompts = (waited?.payload.promptMessageIds ?? waited?.payload.promptMessageId ?? '').split(',');
    if (!target && waited && prompts.includes(String(msg.replyToMessageId))) target = waited;
  } else {
    target = plain;
  }
  if (!target) return false;
  // A ✏️ wait whose draft is gone — his own message in the customer's chat
  // retired it, the 24 h expiry, a ❌ on the page — is nobody's question any
  // more (2026-10-29): it would eat his next text here (a code lookup, a
  // question) with «faol emas». Dropped, and a PLAIN text goes on down the
  // ladder; a swipe-reply still names the draft and is told it is closed.
  if (target.kind === 'agent_edit' && msg.replyToMessageId === null && !(await editStillLive(staff.id, target.payload.draftId))) {
    dropWait(chatId, 'agent_edit');
    return false;
  }
  // A ✍️ wait whose question is no longer waiting (spec §2.2, the same rule): a plain text goes on down the ladder;
  // a swipe-reply still names the question and is told its answer was not taken.
  if (target.kind === 'agent_answer') {
    const live = await answerStillLive(staff.id, target.payload.draftId);
    if (!live && msg.replyToMessageId === null) {
      dropWait(chatId, 'agent_answer');
      return false;
    }
    // An address, a phone, Chinese text: refused in words and the wait KEPT — his next text is still the answer.
    // The words name WHAT was read as one — a figure with no unit beside it is told how to say itself.
    const { answerTextRefusal, answerContactWords } = await import('../../wms/agent/owner-answer');
    const contact = live ? answerTextRefusal(msg.text) : null;
    if (contact !== null) {
      await markOnce(await messageKey(ctx, 'wait'));
      await ctx.reply(answerContactWords(contact));
      return true;
    }
  }
  // A lesson the writer would refuse — money, a customer's name, code or phone, too long (§3.2) — is refused in words
  // BEFORE the wait is consumed, like an answer's phone: his next text is still the lesson. No «still live» check:
  // a lesson teaches whatever became of the card it was given on.
  if (target.kind === 'agent_lesson') {
    const { lessonRefusalFor } = await import('../../wms/agent/bot-door');
    const refused = await lessonRefusalFor(staff.id, target.payload.draftId, msg.text);
    if (refused !== null) {
      await markOnce(await messageKey(ctx, 'wait'));
      await ctx.reply(refused);
      return true;
    }
  }
  // The wait is consumed before the effect (the redelivery rule): a kill after
  // the delete leaves nothing to answer twice.
  dropWait(chatId, target.kind);
  await flushWaitWrites();
  try {
    const answer = await agentText(staff.id, target, msg.text, ctx.message?.message_id);
    // What this text did, so a crash redelivery of it hears «answered» and
    // never «send it again» (final review K23 — the task wait's own rule,
    // judge Q5H-2 a): with the wait already consumed, the redelivered text
    // reaches the staff tail, which asks `handledAlready` first. Recorded
    // before the reply, whose own failure must not leave the text unmarked.
    await markOnce(await messageKey(ctx, 'wait'));
    if (answer) await ctx.reply(answer.text, answer.buttons ? { reply_markup: { inline_keyboard: answer.buttons } } : undefined);
  } catch (err) {
    logger.error({ err, kind: target.kind }, '[agent] text failed');
    await ctx.reply('Xatolik — qayta urinib ko‘ring.');
  }
  return true;
}

/**
 * «/agent» — the bot's kill switch (spec §1): «/agent off» stops every send
 * within a minute, queued ones included. Registered beside /hodim, before
 * `registerStaffBot`, so no collector or wait can eat it. A chat that is not
 * staff is passed on (I4): the command is the staff bot's, and a customer's
 * text belongs to the handlers after it — this one must not be where a
 * stranger's message ends.
 */
export function registerAgentCommand(bot: Bot): void {
  bot.command('agent', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return;
    const staff = await staffForChat(BigInt(ctx.chat.id));
    if (!staff) return next();
    try {
      const { agentCommand } = await import('../../wms/agent/bot-door');
      await ctx.reply(await agentCommand(staff.id, String(ctx.match ?? '')));
    } catch (err) {
      logger.error({ err }, '[agent] command failed');
      await ctx.reply('Xatolik — qayta urinib ko‘ring.');
    }
  });
}
