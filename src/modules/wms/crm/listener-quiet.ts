import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { tgAccounts, users } from '../../platform/db/schema';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithRoles } from '../../platform/notifications/service';
import { bridgeState, QUIET_ALARM_MS, secondsBehind } from './telegram-live';

/**
 * A manager's Telegram bridge went quiet, noticed by the APP (B9).
 *
 * The listener container can die in ways it cannot report: stopped by hand
 * and never started, a crash loop, a lock held by a copy of itself, a key
 * that no longer opens the session. Its two alarms (round 48's Saved Messages,
 * round 49's session-ended) both live INSIDE the listener, so the day the
 * listener is gone, both are gone with it — and every customer message sent
 * meanwhile lands nowhere in the CRM. Round 49's rule, a third time: an alarm
 * about a component must never depend on that component. The app watches
 * the heartbeat the listener writes and says so when it stops.
 *
 * «Quiet» is decided in JS by the screen's own words — `bridgeState` and
 * `secondsBehind` — never a second freshness rule in SQL (#513):
 *  - not `live`, and quiet past `QUIET_ALARM_MS` (measured from the last beat,
 *    or from the connect for an account that has never beaten);
 *  - `signed_out` is NOT quiet — Telegram ended the session and
 *    `TelegramSessionEnded` already said so; a second alarm would ask somebody
 *    to restart a process that will refuse to start;
 *  - an account with no session (disconnected, round 50) is nobody's to wait for.
 *
 * Told ONCE per silence and taken back once: `quiet_open` is claimed by a
 * single `UPDATE … RETURNING` before anything is sent (#599), and «qaytdi» only
 * when the bridge is LIVE at sweep time. A listener that starts, beats once
 * and dies (the supervisor's five-minute back-off, a lock held elsewhere)
 * would otherwise ring «jim»/«qaytdi» every quarter hour for ever, so a new
 * «jim» also waits `QUIET_REALARM_MS` after the last one — `quiet_notified_at`
 * is kept after the bridge returns for exactly that.
 *
 * Who is told: the manager whose account it is, in one sentence with no
 * command in it; the admins in ONE message per sweep listing every quiet
 * account — a dead container silences them all at once, and five copies of
 * one fault to each admin is noise. A manager who is also an admin reads the
 * list.
 */

/** A second «jim» about the same account waits at least this long. */
export const QUIET_REALARM_MS = 60 * 60 * 1000;

export interface QuietAccount {
  id: string;
  managerUserId: string;
  managerName: string;
  status: string;
  lastSeenAt: Date | null;
  updatedAt: Date;
  hasSession: boolean;
  quietOpen: boolean;
  quietNotifiedAt: Date | null;
}

export type QuietAction = 'alarm' | 'back' | null;

/** What this sweep should do about one account — pure, so it can be pinned. */
export function quietAction(account: QuietAccount, now: Date): QuietAction {
  if (!account.hasSession) return null;
  const state = bridgeState({ status: account.status, lastSeenAt: account.lastSeenAt }, now);
  if (state === 'signed_out') return null;
  if (state === 'live') return account.quietOpen ? 'back' : null;
  if (account.quietOpen) return null;
  const behind = secondsBehind(account.lastSeenAt ?? account.updatedAt, now);
  if (behind === null || behind * 1000 < QUIET_ALARM_MS) return null;
  if (account.quietNotifiedAt && now.getTime() - account.quietNotifiedAt.getTime() < QUIET_REALARM_MS) {
    return null;
  }
  return 'alarm';
}

/** How long it has been quiet, in whole minutes, for the sentence. */
export function quietMinutes(account: Pick<QuietAccount, 'lastSeenAt' | 'updatedAt'>, now: Date): number {
  return Math.floor((secondsBehind(account.lastSeenAt ?? account.updatedAt, now) ?? 0) / 60);
}

export function managerQuietText(minutes: number): string {
  return (
    `📴 Telegram ko'prigingiz ${minutes} daqiqadan beri jim — mijozlarning xabarlari CRMga tushmayapti.\n` +
    `Admin xabardor qilindi.`
  );
}

export function adminQuietText(list: { name: string; minutes: number }[]): string {
  return [
    `📴 Telegram ko'prigi jim — mijozlarning xabarlari CRMga tushmayapti:`,
    ...list.map((a) => `• ${a.name}: ${a.minutes} daqiqa`),
    `Tekshirish: docker compose --profile telegram logs --tail 50 tg-listen`,
    `Qayta ishga tushirish: docker compose --profile telegram up -d tg-listen`,
  ].join('\n');
}

export function managerBackText(): string {
  return `✅ Telegram ko'prigingiz qaytdi — mijozlarning xabarlari yana CRMga tushyapti.`;
}

export function adminBackText(names: string[]): string {
  return [`✅ Telegram ko'prigi qaytdi:`, ...names.map((n) => `• ${n}`)].join('\n');
}

async function quietCandidates(): Promise<QuietAccount[]> {
  const rows = await db
    .select({
      id: tgAccounts.id,
      managerUserId: tgAccounts.managerUserId,
      managerName: users.fullName,
      status: tgAccounts.status,
      lastSeenAt: tgAccounts.lastSeenAt,
      updatedAt: tgAccounts.updatedAt,
      sessionEnc: tgAccounts.sessionEnc,
      quietOpen: tgAccounts.quietOpen,
      quietNotifiedAt: tgAccounts.quietNotifiedAt,
    })
    .from(tgAccounts)
    .innerJoin(users, eq(users.id, tgAccounts.managerUserId));
  return rows.map(({ sessionEnc, ...row }) => ({ ...row, hasSession: sessionEnc !== null }));
}

/** Claim the right to say «jim» — one sweep wins, and only past the re-alarm gap. */
export async function claimQuietAlarm(id: string, now: Date): Promise<boolean> {
  const gap = new Date(now.getTime() - QUIET_REALARM_MS);
  const won = await db
    .update(tgAccounts)
    .set({ quietOpen: true, quietNotifiedAt: now })
    .where(
      and(
        eq(tgAccounts.id, id),
        eq(tgAccounts.quietOpen, false),
        or(isNull(tgAccounts.quietNotifiedAt), lt(tgAccounts.quietNotifiedAt, gap)),
      ),
    )
    .returning({ id: tgAccounts.id });
  return won.length > 0;
}

/** Claim the right to say «qaytdi» — only while a «jim» stands. */
async function claimBack(id: string): Promise<boolean> {
  const won = await db
    .update(tgAccounts)
    .set({ quietOpen: false })
    .where(and(eq(tgAccounts.id, id), eq(tgAccounts.quietOpen, true), isNotNull(tgAccounts.quietNotifiedAt)))
    .returning({ id: tgAccounts.id });
  return won.length > 0;
}

/**
 * One sweep: every account judged, every change claimed, then the messages.
 * Answers how many accounts went quiet and how many came back.
 */
export async function sweepQuietListeners(now = new Date()): Promise<{ quiet: number; back: number }> {
  const accounts = await quietCandidates();
  const quiet: QuietAccount[] = [];
  const back: QuietAccount[] = [];
  for (const account of accounts) {
    const action = quietAction(account, now);
    if (action === 'alarm' && (await claimQuietAlarm(account.id, now))) quiet.push(account);
    if (action === 'back' && (await claimBack(account.id))) back.push(account);
  }
  if (quiet.length === 0 && back.length === 0) return { quiet: 0, back: 0 };

  const admins = await usersWithRoles(['admin', 'super_admin']);
  const adminSet = new Set(admins);
  if (quiet.length > 0) {
    for (const account of quiet) {
      if (adminSet.has(account.managerUserId)) continue;
      await notifyStaffTelegram({
        userIds: [account.managerUserId],
        type: 'TelegramListenerQuiet',
        text: managerQuietText(quietMinutes(account, now)),
      });
    }
    await notifyStaffTelegram({
      userIds: admins,
      type: 'TelegramListenerQuiet',
      text: adminQuietText(quiet.map((a) => ({ name: a.managerName, minutes: quietMinutes(a, now) }))),
    });
  }
  if (back.length > 0) {
    for (const account of back) {
      if (adminSet.has(account.managerUserId)) continue;
      await notifyStaffTelegram({
        userIds: [account.managerUserId],
        type: 'TelegramListenerBack',
        text: managerBackText(),
      });
    }
    await notifyStaffTelegram({
      userIds: admins,
      type: 'TelegramListenerBack',
      text: adminBackText(back.map((a) => a.managerName)),
    });
  }
  return { quiet: quiet.length, back: back.length };
}
