import type { Bot, Context } from 'grammy';
import { logger } from '../logger';
import { activeIntake } from './calc-intake';
import { activeCapture } from './note-capture';
import { answerPress } from './press';
import { staffForChat, type BotCallback } from './staff-bot';
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

function busy(chatId: bigint): boolean {
  return Boolean(activeIntake(chatId) || activeCapture(chatId) || activeDraft(chatId));
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
  if ((parsed.op === 'e' || parsed.op === 'p' || parsed.op === 'k') && busy(chatId)) {
    await answerPress(ctx, BUSY);
    await ctx.reply(BUSY);
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
      armWait(chatId, out.arm.kind, out.arm.payload, AGENT_WAIT_TTL_MS, nowSec());
    }
    if (out.drop) dropWait(chatId, out.drop);
    await answerPress(ctx, out.toast);
    if (out.reply) await ctx.reply(out.reply);
  } catch (err) {
    logger.error({ err, op: parsed.op }, '[agent] press failed');
    await answerPress(ctx, 'Xatolik — qayta urinib ko‘ring');
  }
}

/**
 * The agent's slot in the text ladder: BELOW every live collector, ABOVE the
 * reply door and `takeTaskPending` (which deletes on read). A reply to an
 * agent card names its own target; otherwise the one live agent wait does.
 * True = handled.
 */
export async function agentTextSlot(
  ctx: Context,
  chatId: bigint,
  text: string,
  messageDateSec: number,
  replyToMessageId: number | null,
): Promise<boolean> {
  // Memory first: a chat with no agent wait and no reply costs no query.
  let waited: { kind: AgentWait; payload: Record<string, string> } | null = null;
  for (const kind of AGENT_WAITS) {
    const entry = readWait<Record<string, string>>(chatId, kind);
    if (entry && waitVerdict(entry, messageDateSec, isBacklog(messageDateSec)) === 'answers') {
      waited = { kind, payload: entry.payload };
      break;
    }
  }
  if (!waited && replyToMessageId === null) return false;
  const staff = await staffForChat(chatId);
  if (!staff) return false;
  const { agentCardFor, agentText } = await import('../../wms/agent/bot-door');
  const target = (replyToMessageId !== null ? await agentCardFor(staff.id, chatId, replyToMessageId) : null) ?? waited;
  if (!target) return false;
  // The wait is consumed before the effect (the redelivery rule): a kill after
  // the delete leaves nothing to answer twice.
  dropWait(chatId, target.kind);
  await flushWaitWrites();
  try {
    const reply = await agentText(staff.id, target, text);
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
 * `registerStaffBot`, so no collector or wait can eat it.
 */
export function registerAgentCommand(bot: Bot): void {
  bot.command('agent', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const staff = await staffForChat(BigInt(ctx.chat.id));
    if (!staff) return;
    try {
      const { agentCommand } = await import('../../wms/agent/bot-door');
      await ctx.reply(await agentCommand(staff.id, String(ctx.match ?? '')));
    } catch (err) {
      logger.error({ err }, '[agent] command failed');
      await ctx.reply('Xatolik — qayta urinib ko‘ring.');
    }
  });
}
