import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithRoles } from '../../platform/notifications/service';
import type { UnmutableType } from '../../platform/notifications/mutes';
import { agentRunning, forceAgentOff, readAgentConfig } from '../agent/config';
import { AGENT_LIMITS } from '../agent/limits';
import { onAgentDraftsRetired, onAgentOutboxSettled } from '../agent/settle-hooks';
import { pauseAccount, recordFlood, sendFloodsSince } from './account-guard';
import type { PauseKind } from './telegram-guard';

/**
 * What the listener does when Telegram says the ACCOUNT is in trouble —
 * the one home for the human pump and the agent pump (review ban-1, ban-2,
 * ban-10), so the two cannot disagree about what a PEER_FLOOD means.
 *
 * The alarms ride the BOT, never the account (round 49's rule: an alarm
 * about a component must not depend on it), and they go to the account's
 * manager AND every other super_admin (ban-10): the bot's chat with the
 * owner lives on the same personal account, and a banned account is exactly
 * the one whose own person may never read the message.
 */

export interface AlarmAccount {
  id: string;
  managerUserId: string;
  managerName: string;
}

/** The words a person reads for each pause (his Q13 ⭐ — every manager's account). */
const PAUSE_WORDS: Record<PauseKind, string> = {
  peer_flood: 'spam cheklovi',
  restricted: 'akkaunt cheklangan',
  frozen: 'akkaunt muzlatilgan',
  flood_repeat: '24 soat ichida ikki marta «kuting» buyrug‘i',
  blocks: 'mijozlar bloklagan',
};

/** Pure: the restriction alarm, naming whose account and what to press. */
export function pausedAlarmText(input: {
  managerName: string;
  pause: PauseKind;
  code: string;
  agentOff: boolean;
}): string {
  return (
    `⚠️ Telegram ${input.managerName} akkauntini chekladi: ${PAUSE_WORDS[input.pause]} (${input.code}).\n` +
    `Bu akkauntdan xabar yuborish to‘xtatildi — CRM javoblari ham` +
    (input.agentOff ? ', AI sotuvchi ham o‘chirildi.\n' : '.\n') +
    `Telegram ilovasida akkaunt holatini tekshiring, so‘ng saytda «Suhbatlar» bo‘limida ` +
    `«Tekshirdim» tugmasini bosing.`
  );
}

export type AgentOffReason = 'flood_repeat' | 'blocks';

const AGENT_OFF_WORDS: Record<AgentOffReason, string> = {
  flood_repeat: '24 soat ichida Telegram ikki marta yuborishni kutishga buyurdi (FLOOD_WAIT)',
  blocks: '7 kun ichida AI javob yubormoqchi bo‘lgan ikki mijoz akkauntni bloklagan bo‘lib chiqdi',
};

/** Pure: the machine switched itself off to keep the account — said once, with the reason. */
export function agentOffAlarmText(input: { managerName: string; reason: AgentOffReason }): string {
  return (
    `⚠️ AI sotuvchi o‘chirildi — ${input.managerName} akkauntini asrash uchun.\n` +
    `Sabab: ${AGENT_OFF_WORDS[input.reason]}.\n` +
    `Odamlar yozgan javoblar odatdagidek ketadi. AI'ni qayta yoqish — saytda «Suhbatlar → AI» sahifasida.`
  );
}

/** Pure: the session-dead alarm as a COLLEAGUE reads it — the manager keeps his own sentence. */
export function sessionDeadOthersText(input: { managerName: string; reason: string }): string {
  return (
    `⚠️ ${input.managerName} ning Telegram seansi tugatilgan (${input.reason}).\n` +
    `Uning mijozlariga javob yuborib bo‘lmaydi — u saytda «Suhbatlar → Ulash» orqali qayta ulanishi kerak.`
  );
}

/** The manager plus every live super_admin; `notifyStaffTelegram` drops the duplicates. */
// Typed by the unmutable list: an alarm about the account is never a /profile tick away from silence.
async function alarm(
  account: AlarmAccount,
  type: Extract<UnmutableType, 'TgAccountPaused' | 'AgentForcedOff'>,
  text: string,
): Promise<void> {
  const supers = await usersWithRoles(['super_admin']);
  await notifyStaffTelegram({ userIds: [account.managerUserId, ...supers], type, text });
}

/**
 * The session-dead alarm, to the OTHER super_admins (ban-10). The manager's
 * own message is the listener's existing one, unchanged; this is the copy
 * for the people who can still reach him when his Telegram cannot.
 */
export async function announceSessionDeadToOthers(account: AlarmAccount, reason: string): Promise<void> {
  const others = (await usersWithRoles(['super_admin'])).filter((id) => id !== account.managerUserId);
  if (others.length === 0) return;
  await notifyStaffTelegram({
    userIds: others,
    type: 'TelegramSessionEnded',
    text: sessionDeadOthersText({ managerName: account.managerName, reason }),
  });
}

/**
 * Switch the agent off — only when THIS account is the one it speaks from.
 * `forceAgentOff` is idempotent (null when already off), so a second error
 * on the same account switches nothing and returns false. The approved
 * replies it cancelled have cards that must say so.
 */
async function agentOffFor(account: AlarmAccount, reason: string): Promise<boolean> {
  const config = await readAgentConfig();
  if (!agentRunning(config) || config.ownerUserId !== account.managerUserId) return false;
  const change = await forceAgentOff(reason);
  if (!change) return false;
  for (const id of change.cancelledOutboxIds) {
    await onAgentOutboxSettled(id).catch(() => undefined);
  }
  await onAgentDraftsRetired(change.expiredDraftIds).catch(() => undefined);
  return true;
}

/**
 * PEER_FLOOD / USER_RESTRICTED / FROZEN_*: the account is already limited,
 * so every further send — a person's or the machine's — is evidence against
 * it. The pause is written FIRST (the pump reads it before its next claim),
 * then the agent goes off when it speaks from here, then ONE alarm: only the
 * call whose pause was fresh raises it, so a second refused row is silent.
 */
export async function accountRestricted(
  account: AlarmAccount,
  kind: { pause: Extract<PauseKind, 'peer_flood' | 'restricted' | 'frozen'>; code: string },
): Promise<{ fresh: boolean; agentOff: boolean }> {
  const fresh = await pauseAccount(account.id, kind.pause, kind.code);
  const agentOff = await agentOffFor(account, 'account_paused');
  if (fresh) {
    await alarm(
      account,
      'TgAccountPaused',
      pausedAlarmText({ managerName: account.managerName, pause: kind.pause, code: kind.code, agentOff }),
    );
  }
  return { fresh, agentOff };
}

/**
 * A flood wait on this account — slept through by gramjs ('sleep') or raised
 * to the pump ('raise'). Always a ledger row; a raised one on a SEND method
 * moves the guard's `flood_until`, uncapped (`recordFlood`) — a wait on a
 * read or a cosmetic call holds the agent's own calls and never a person's
 * reply (review S9). Then «two send-path floods in 24 h» (`sendFloodsSince`
 * counts the send methods only) switches the agent off — the person's own
 * replies keep going, obeying every wait.
 *
 * `now` is the wait's own instant and the ledger's key: a caller replaying a
 * held outcome passes the instant it first saw, and the replay records
 * nothing twice (S7).
 */
export async function accountFlooded(
  account: AlarmAccount,
  flood: { method: string; seconds: number; source: 'sleep' | 'raise' },
  now: Date = new Date(),
): Promise<{ agentOff: boolean }> {
  await recordFlood({ accountId: account.id, method: flood.method, seconds: flood.seconds, source: flood.source, now });
  const since = new Date(now.getTime() - AGENT_LIMITS.floodRepeatWindowMs);
  if ((await sendFloodsSince(account.id, since)) < 2) return { agentOff: false };
  const agentOff = await agentOffFor(account, 'flood_repeat');
  if (agentOff) {
    await alarm(account, 'AgentForcedOff', agentOffAlarmText({ managerName: account.managerName, reason: 'flood_repeat' }));
  }
  return { agentOff };
}

/** Two customers turned out to have blocked the account inside the window (map P13): the agent goes off. */
export async function agentBlocked(account: AlarmAccount): Promise<{ agentOff: boolean }> {
  const agentOff = await agentOffFor(account, 'blocks');
  if (agentOff) {
    await alarm(account, 'AgentForcedOff', agentOffAlarmText({ managerName: account.managerName, reason: 'blocks' }));
  }
  return { agentOff };
}
