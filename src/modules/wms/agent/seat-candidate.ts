import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { aiConfigured } from '../../platform/ai/model';
import { logger } from '../../platform/logger';
import { AGENT_SEAT_KEY } from '../../platform/settings/agent-seat';
import { SETTING_DEFAULTS } from '../../platform/settings/service';
import { canLogInSql } from '../../platform/users/login';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { listenerIsCurrent, type GuardState } from '../crm/account-guard';
import { reachableAt } from '../crm/site-assign-rules';
import { AGENT_LIMITS, dailySendCeiling } from './limits';
import { agentSendsSinceSql, OWN_SENDS_DAYS, ownSendsBeforeStartSql } from './today';

/**
 * «Can the AI seat take a website visitor right now?» (stage 1a «Hajm», his 6 c) — asked by the website's question
 * (`crm/site-assign.ts` `assignForTag`, inside its transaction, under the `lead_assign` lock and its 400 ms
 * statement budget) and by the roster page's line of truth, so the page never explains a choice the door did not
 * make (#513).
 *
 * Yes only when a visitor sent to the AI's @handle is answered BY ITSELF: the seat holds the account the AI speaks
 * from, the agent drafts (shadow, session confirmed), «o'zi yuborish» is armed on a «Ish raqami», the CRM may send,
 * the account is connected and live with a handle Telegram itself confirmed within the hour (round 113's rule,
 * `reachableAt` — never a typed handle: a released name can be taken by a stranger), it is not paused or under a
 * flood wait, the listener is current, the day still has room for a conversation (`SEAT_HEADROOM` sends under the
 * ceiling the ✅ uses), and the model has a key. Anything else is a named «no» and the website's roster answers —
 * the site is never told «nobody» because of the AI.
 *
 * Its imports are light on purpose: `site-assign.ts` is a direct import of the listener script, so this file joins
 * the listener's closure — never the run, the press or the auto layer (`run.ts`, `decide.ts`, `auto-send.ts`).
 */

/**
 * Why the seat cannot take one, in the order the verdict asks — the line of truth names the FIRST that holds. A
 * closed list with its words beside it (J32): a reason the page cannot say never reaches it as a code.
 */
export const SEAT_REFUSALS = [
  'no_ai_key',
  'no_seat',
  'seat_not_holder',
  'agent_off',
  'not_armed',
  'not_work_account',
  'sending_disabled',
  'not_connected',
  'no_handle',
  'paused',
  'flood',
  'listener_behind',
  'day_cap',
  'unreadable',
] as const;

export type SeatRefusal = (typeof SEAT_REFUSALS)[number];

/**
 * Each reason in his words (the roster page's «AI hozir qabul qila olmaydi (<sabab>)»). Uzbek, in code: every bundle
 * word of the stage was landed by the kernel (J26), and the line these complete is his.
 */
export const SEAT_REFUSAL_WORDS: Record<SeatRefusal, string> = {
  no_ai_key: 'serverda AI kaliti sozlanmagan',
  no_seat: 'AI sotuvchi o‘rni belgilanmagan yoki u hodim tizimga kira olmaydi',
  seat_not_holder: 'AI sotuvchi o‘rni AI gapiradigan akkaunt emas',
  agent_off: 'AI sotuvchi o‘chirilgan yoki seans tasdiqlanmagan',
  not_armed: '«O‘zi yuborish» yoqilmagan',
  not_work_account: 'AI raqami «Ish raqami» deb belgilanmagan',
  sending_disabled: 'CRM’dan Telegramga yuborish o‘chirilgan',
  not_connected: 'AI akkauntining Telegrami ulanmagan',
  no_handle: 'AI akkauntining @username’i so‘nggi bir soatda tasdiqlanmagan',
  paused: 'AI akkaunti to‘xtatilgan (Telegram cheklovi)',
  flood: 'Telegram yuborishni vaqtincha to‘xtatgan',
  listener_behind: 'Telegram ko‘prigi (tinglovchi) yangilanmagan',
  day_cap: 'bugungi AI yuborish chegarasiga oz qoldi',
  unreadable: 'AI holatini o‘qib bo‘lmadi',
};

/**
 * Sends the day must still hold before a visitor is sent to the AI (§4.7: «at least 10 under the effective day
 * cap»): a visitor is a conversation, not one message, and the day's ceiling stopping it half way would leave a
 * customer the AI started with nobody.
 */
export const SEAT_HEADROOM = 10;

export type SeatVerdict =
  | { ok: true; userId: string; username: string; name: string }
  | { ok: false; reason: SeatRefusal };

/** What the verdict is decided from — one row, read by ONE statement (`readSeatFacts`). */
export interface SeatFacts {
  /** The seat setting as stored, lower-cased; null when unnamed. */
  seatId: string | null;
  /** The seat is a colleague now (`canLogIn`) — a tag reused later is answered only for one (`assignForTag`). */
  seatLive: boolean;
  seatName: string | null;
  holderId: string | null;
  mode: string | null;
  sessionConfirmed: boolean;
  startedAt: Date | null;
  armed: boolean;
  workAccount: boolean;
  sendingEnabled: boolean;
  account: { status: string; lastSeenAt: Date | null; username: string | null; checkedAt: Date | null } | null;
  guard: Pick<GuardState, 'pausedAt' | 'floodUntil' | 'agentPumpAt' | 'caughtUpAt'>;
  sendsToday: number;
  /** `agent_send_caps.day_cap` as stored; null = today's constant. */
  dayCap: number | null;
  /** His own sends before the start — read only while the ramp runs, else null. */
  ownSends: number | null;
}

const refused = (reason: SeatRefusal): SeatVerdict => ({ ok: false, reason });

/**
 * The verdict, pure — every clause testable as a function (`agent-seat-candidate.test.ts` drops each in turn).
 * `aiKey` is `aiConfigured()` at the caller: no key, no model, so no reply at all.
 */
export function seatVerdictOf(f: SeatFacts, now: Date, aiKey: boolean): SeatVerdict {
  if (!aiKey) return refused('no_ai_key');
  if (!f.seatId || !f.seatLive) return refused('no_seat');
  if (f.holderId !== f.seatId) return refused('seat_not_holder');
  if (f.mode !== 'shadow' || !f.sessionConfirmed) return refused('agent_off');
  if (!f.armed) return refused('not_armed');
  if (!f.workAccount) return refused('not_work_account');
  if (!f.sendingEnabled) return refused('sending_disabled');
  if (!f.account) return refused('not_connected');
  // The verified handle alone (no typed fallback): the visitor is told to write THERE.
  const reach = reachableAt({ typedUsername: null, account: f.account }, now);
  if (reach.bridge !== 'live') return refused('not_connected');
  if (!reach.ok) return refused('no_handle');
  if (f.guard.pausedAt) return refused('paused');
  if (f.guard.floodUntil && f.guard.floodUntil.getTime() > now.getTime()) return refused('flood');
  if (!listenerIsCurrent(f.guard, now)) return refused('listener_behind');
  const ceiling = dailySendCeiling({
    startedAt: f.startedAt,
    ownAverage: (f.ownSends ?? 0) / OWN_SENDS_DAYS,
    now,
    dayCap: f.dayCap ?? AGENT_LIMITS.perDay,
  });
  if (ceiling - f.sendsToday < SEAT_HEADROOM) return refused('day_cap');
  return { ok: true, userId: f.seatId, username: reach.username, name: f.seatName ?? '' };
}

/** Raw `execute` hands timestamps over as TEXT (#923). */
const at = (value: string | Date | null): Date | null => (value === null ? null : new Date(value));

/**
 * Every fact of the verdict in ONE statement on the handle it is given — inside the website's transaction that is
 * one round trip under the lock, never a pooled read (#714). The holder's account, guard and day are read for the
 * HOLDER: the verdict compares the seat with him, and a seat that is not the holder is refused before they matter.
 * His own sends before the start are counted only while the ramp can still run (`dailySendCeiling`).
 */
export async function readSeatFacts(handle: Db | Tx, now: Date): Promise<SeatFacts> {
  const dayStart = tashkentDayStart(tashkentDay(now)).toISOString();
  const nowIso = now.toISOString();
  const rows = (await handle.execute(sql`
    WITH seat AS (
      SELECT lower(value #>> '{}') AS id FROM settings WHERE key = ${AGENT_SEAT_KEY}
    ), cfg AS (
      SELECT owner_user_id, mode, session_exclusive_at, started_at FROM agent_config WHERE id = 1
    )
    SELECT (SELECT id FROM seat) AS seat_id,
           su.full_name AS seat_name,
           coalesce(${canLogInSql('su')}, false) AS seat_live,
           cfg.owner_user_id::text AS holder_id,
           cfg.mode,
           cfg.session_exclusive_at IS NOT NULL AS session_confirmed,
           cfg.started_at,
           ac.armed_at IS NOT NULL AS armed,
           (SELECT value = 'true'::jsonb FROM settings WHERE key = 'tg_sending_enabled') AS sending,
           (SELECT day_cap FROM agent_send_caps WHERE id = 1) AS day_cap,
           t.status AS tg_status, t.last_seen_at, t.tg_username, t.tg_username_checked_at,
           coalesce(t.work_account, false) AS work_account,
           g.paused_at, g.flood_until, g.agent_pump_at, g.caught_up_at,
           CASE WHEN cfg.owner_user_id IS NULL THEN 0
                ELSE ${agentSendsSinceSql(sql`cfg.owner_user_id`, dayStart)} END AS sends_today,
           CASE WHEN cfg.started_at IS NOT NULL
                 AND cfg.started_at > ${nowIso}::timestamptz - make_interval(days => ${AGENT_LIMITS.rampDays})
                THEN ${ownSendsBeforeStartSql(sql`cfg.owner_user_id`, sql`cfg.started_at`)} END AS own_sends
      FROM (SELECT 1) one
      LEFT JOIN cfg ON true
      LEFT JOIN users su ON su.id::text = (SELECT id FROM seat)
      LEFT JOIN agent_auto_config ac ON ac.id = 1
      LEFT JOIN tg_accounts t ON t.manager_user_id = cfg.owner_user_id
      LEFT JOIN tg_account_guard g ON g.account_id = t.id
  `)) as unknown as {
    seat_id: string | null;
    seat_name: string | null;
    seat_live: boolean;
    holder_id: string | null;
    mode: string | null;
    session_confirmed: boolean | null;
    started_at: string | Date | null;
    armed: boolean | null;
    sending: boolean | null;
    day_cap: number | null;
    tg_status: string | null;
    last_seen_at: string | Date | null;
    tg_username: string | null;
    tg_username_checked_at: string | Date | null;
    work_account: boolean;
    paused_at: string | Date | null;
    flood_until: string | Date | null;
    agent_pump_at: string | Date | null;
    caught_up_at: string | Date | null;
    sends_today: number | string | null;
    own_sends: number | string | null;
  }[];
  const r = [...rows][0];
  if (!r) throw new Error('seat facts: no row');
  return {
    seatId: r.seat_id || null,
    seatLive: r.seat_live === true,
    seatName: r.seat_name,
    holderId: r.holder_id?.toLowerCase() ?? null,
    mode: r.mode,
    sessionConfirmed: r.session_confirmed === true,
    startedAt: at(r.started_at),
    armed: r.armed === true,
    workAccount: r.work_account === true,
    // No row is the setting's default (off): deploying never makes an account send by itself.
    sendingEnabled: r.sending === null ? SETTING_DEFAULTS.tg_sending_enabled === true : r.sending === true,
    account: r.tg_status
      ? {
          status: r.tg_status,
          lastSeenAt: at(r.last_seen_at),
          username: r.tg_username,
          checkedAt: at(r.tg_username_checked_at),
        }
      : null,
    guard: {
      pausedAt: at(r.paused_at),
      floodUntil: at(r.flood_until),
      agentPumpAt: at(r.agent_pump_at),
      caughtUpAt: at(r.caught_up_at),
    },
    sendsToday: Number(r.sends_today ?? 0),
    dayCap: r.day_cap === null ? null : Number(r.day_cap),
    ownSends: r.own_sends === null ? null : Number(r.own_sends),
  };
}

/**
 * The seat's answer (J23). The facts are read in a SAVEPOINT of the handle's transaction (`handle.transaction` on a
 * transaction is a nested one), so a statement that fails or hits the 400 ms budget aborts the savepoint alone and
 * the caller's transaction goes on to the roster — on the pool the same call is an ordinary short transaction. Any
 * error is «no» (`unreadable`), never a throw: one migration behind (a table this reads does not exist yet), a
 * timeout, a fault — the website still gets a person.
 */
export async function seatCandidate(handle: Db | Tx = db, now: Date = new Date()): Promise<SeatVerdict> {
  // Before any statement: with no key the model answers nobody, and nothing here needs reading to know it.
  const aiKey = aiConfigured();
  if (!aiKey) return refused('no_ai_key');
  let facts: SeatFacts;
  try {
    facts = await handle.transaction(async (sp) => readSeatFacts(sp, now));
  } catch (err) {
    logger.warn({ err }, '[seat-candidate] the seat could not be read — the roster answers');
    return refused('unreadable');
  }
  return seatVerdictOf(facts, now, aiKey);
}
