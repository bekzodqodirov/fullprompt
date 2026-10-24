import type { Bot, Context } from 'grammy';
import { logger } from '../logger';
import { activeIntake } from './calc-intake';
import { activeCapture } from './note-capture';
import { answerPress } from './press';
import { peekTaskPending, staffForChat, type BotCallback } from './staff-bot';
import { isBacklog } from './lifecycle';
import { activeDraft } from './task-draft';
import { armWait, dropWait, flushWaitWrites, nowSec, readWait, waitVerdict, type WaitKind } from './waits';

/**
 * The AI sotuvchi in the staff bot — the grammY shell only. Every decision is
 * the wms side's (`wms/agent/bot-door.ts`, reached by dynamic import:
 * platform never imports wms statically, the startBoss crossing); this file
 * answers the press, arms and drops the three one-text waits, and sits in the
 * text ladder's ONE agent slot (review regression-6).
 */

const AGENT_WAITS = ['agent_edit', 'agent_price', 'agent_code'] as const satisfies readonly WaitKind[];
type AgentWait = (typeof AGENT_WAITS)[number];

/** A one-text wait lasts half an hour — long enough to think, short enough not to swallow tomorrow's text. */
export const AGENT_WAIT_TTL_MS = 30 * 60_000;

const BUSY = 'Avval boshlangan ishni tugating (hisoblatish, zametka yoki topshiriq).';
const BUSY_TASK = "Avval topshiriq bo'yicha so'ralgan javobni yozing (natija, savol yoki sana) — keyin qayta bosing.";

/**
 * A live collector — or a task's one-text wait (a «Bajarildi» result, «💬
 * Javob yozish», a ⏰ date, review I2 b): a press that ARMS an agent wait
 * while another question is on the screen would leave his next text to
 * whichever reads first. Null = free; otherwise the words that say which.
 */
function busy(chatId: bigint): string | null {
  if (activeIntake(chatId) || activeCapture(chatId) || activeDraft(chatId)) return BUSY;
  return peekTaskPending(chatId) ? BUSY_TASK : null;
}

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
  const occupied = parsed.op === 'e' || parsed.op === 'p' || parsed.op === 'k' ? busy(chatId) : null;
  if (occupied) {
    await answerPress(ctx, occupied);
    await ctx.reply(occupied);
    return;
  }
  try {
    const { agentPress, releaseEdit } = await import('../../wms/agent/bot-door');
    const out = await agentPress(staff.id, parsed.op, parsed.id, parsed.digest);
    if (out.arm) {
      // One live agent wait at a time; a second ✏️ releases the first draft
      // in words rather than silently re-targeting it (leak-6).
      const prev = readWait<{ draftId?: string }>(chatId, 'agent_edit');
      if (prev?.payload.draftId && prev.payload.draftId !== out.arm.payload.draftId) {
        await releaseEdit(staff.id, prev.payload.draftId);
      }
      for (const kind of AGENT_WAITS) if (kind !== out.arm.kind) dropWait(chatId, kind);
    }
    if (out.drop) dropWait(chatId, out.drop);
    await answerPress(ctx, out.toast);
    const prompt = out.reply
      ? await ctx.reply(out.reply, out.buttons ? { reply_markup: { inline_keyboard: out.buttons } } : undefined)
      : null;
    if (out.arm) {
      // Armed AFTER its prompt, at the prompt's own date, naming the prompt
      // (the task waits' rule, Q5 a): a swipe-reply to THIS question answers
      // it, and a newer question's armedAt is comparable with it (I2).
      armWait(
        chatId,
        out.arm.kind,
        prompt ? { ...out.arm.payload, promptMessageId: String(prompt.message_id) } : out.arm.payload,
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
  if (waited) {
    const task = readWait<unknown>(chatId, 'task');
    if (task && waitVerdict(task, msg.dateSec, isBacklog(msg.dateSec)) === 'answers' && task.armedAt >= waited.armedAt) {
      waited = null;
    }
  }
  if (!waited && msg.replyToMessageId === null) return false;
  const staff = await staffForChat(chatId);
  if (!staff) return false;
  const { agentCardFor, agentText } = await import('../../wms/agent/bot-door');
  let target: { kind: AgentWait; payload: Record<string, string> } | null = null;
  if (msg.replyToMessageId !== null) {
    target = await agentCardFor(staff.id, chatId, msg.replyToMessageId);
    if (!target && waited && waited.payload.promptMessageId === String(msg.replyToMessageId)) target = waited;
  } else {
    target = waited;
  }
  if (!target) return false;
  // The wait is consumed before the effect (the redelivery rule): a kill after
  // the delete leaves nothing to answer twice.
  dropWait(chatId, target.kind);
  await flushWaitWrites();
  try {
    const reply = await agentText(staff.id, target, msg.text);
    if (reply) await ctx.reply(reply);
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
