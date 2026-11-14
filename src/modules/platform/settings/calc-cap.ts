import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { seatAndHolder } from './agent-seat';

/**
 * How many open calculation requests one requester may have waiting at once (SPEC-P2-v2 §1.3) — ONE function, read
 * by every place that uses or prints the number: the queue's own refusal (`calcOpenRefusal`, wms/calc/service.ts),
 * the AI card's words (wms/agent/card-io.ts), the staff bot's words (platform/telegram/calc-dialog.ts
 * `queueRefusal`) and the AI page's «Ochiq hisoblar N/cap» (wms/agent/web-page.ts `openCalcsFor`). Platform, because
 * the bot's words live in platform and platform never imports wms.
 *
 * Not a security fence — a runaway guard: the bot mints a fresh lead for every stranger with no phone, so a stuck
 * loop would otherwise open a request (and a lead, and an AI-VED call) per press with nothing to stop it. For the
 * AI seat it is the ONLY bound on a machine with no daily count of its own (his «chegara qoyma»): VED jobs and
 * AI-VED calls.
 */

/** Every person's cap — the constant the queue has always had (`MAX_OPEN_PER_REQUESTER` re-exports it). */
export const OPEN_CALC_CAP_PEOPLE = 20;

/** The seat's cap when nothing is typed (his §7 Q11 ⭐ a) — `SETTING_DEFAULTS.agent_calc_open_limit` IS this. */
export const OPEN_CALC_CAP_SEAT_DEFAULT = 100;

/** The setting's key — read raw here, so the settings service can import this file's reader without a cycle. */
export const OPEN_CALC_LIMIT_KEY = 'agent_calc_open_limit';

/**
 * What the seat's setting may hold: a whole number 1..200. 0 is refused, never «no cap» — raising it is a widening,
 * which is why only a super_admin writes it (wms/agent/config.ts `setCalcOpenLimit`).
 */
export const OPEN_CALC_LIMIT_BOUNDS = { min: 1, max: 200 } as const;

/** A stored or typed seat cap, or null when it is no whole number inside the bounds. */
export function readOpenCalcLimit(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,3}$/u.test(text)) return null;
  const n = Number(text);
  return n >= OPEN_CALC_LIMIT_BOUNDS.min && n <= OPEN_CALC_LIMIT_BOUNDS.max ? n : null;
}

/**
 * The decision, pure: the seat's own number only for the seat, and only while the seat IS the account the AI
 * speaks from (K4 — re-pointed, every seat-only act stops); everybody else, a seat that does not hold, and an
 * installation with no seat named keep the people's 20. A stored seat value that is unreadable fails closed — the
 * people's 20, never the larger default.
 */
export function openCalcCapOf(input: {
  userId: string;
  seat: string | null;
  holder: string | null;
  /** The stored `agent_calc_open_limit` (its jsonb value), or `OPEN_CALC_CAP_SEAT_DEFAULT` when no row. */
  limit: unknown;
}): number {
  const me = input.userId.toLowerCase();
  if (input.seat === null || input.seat !== input.holder || me !== input.seat) return OPEN_CALC_CAP_PEOPLE;
  return readOpenCalcLimit(input.limit) ?? OPEN_CALC_CAP_PEOPLE;
}

/** The cap for this requester, read now — on the pool, so never from inside a transaction (#714). */
export async function openCalcCapFor(userId: string | null): Promise<number> {
  if (!userId) return OPEN_CALC_CAP_PEOPLE;
  const { seat, holder } = await seatAndHolder();
  // The stored number is read only for the seat itself; whether it applies is `openCalcCapOf`'s one decision.
  let limit: unknown = null;
  if (seat !== null && seat === userId.toLowerCase()) {
    const rows = (await db.execute(sql`SELECT value FROM settings WHERE key = ${OPEN_CALC_LIMIT_KEY}`)) as unknown as {
      value: unknown;
    }[];
    const stored = [...rows][0];
    limit = stored ? stored.value : OPEN_CALC_CAP_SEAT_DEFAULT;
  }
  return openCalcCapOf({ userId, seat, holder, limit });
}
