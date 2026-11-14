import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../db/client';
import { logger } from '../logger';

/**
 * The AI seat (SPEC-P2-v2 K4): which user is «the AI seller, a staff member of its own» — a SETTINGS row, never a
 * column. `agent_config` is read by a select() of every declared column behind a probe that is TRUE one migration
 * behind (0148's binding header), so a seat column there would be a 42703 in every reader on deploy morning; the
 * settings table always exists, so this needs no probe at all.
 *
 * The key is deliberately NOT in `SETTING_DEFAULTS`: `/admin/settings` renders every default key for every
 * `admin.settings.manage` holder, and the seat is the super_admin's to name (`setAgentSeat`, wms/agent/config.ts).
 * Read raw on the pool — `value #>> '{}'`, the `fx_residue_since` precedent (finance/fx-residue.ts) — because its
 * only writer stores a JSON string and clearing deletes the row.
 *
 * Platform reads it and never wms: the open-calc cap (`calc-cap.ts`) and the bot's refusal words live here.
 */
export const AGENT_SEAT_KEY = 'agent_seat_user_id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The designated seat's user id, or null — none named, or a stored value that is no user id (fails closed). */
export async function agentSeatUserId(handle: Db | Tx = db): Promise<string | null> {
  const rows = (await handle.execute(sql`
    SELECT value #>> '{}' AS v FROM settings WHERE key = ${AGENT_SEAT_KEY}
  `)) as unknown as { v: string | null }[];
  const v = [...rows][0]?.v ?? null;
  return v && UUID.test(v) ? v.toLowerCase() : null;
}

/** The seat and the agent's current holder, read together — what «does the seat hold» compares. */
export async function seatAndHolder(handle: Db | Tx = db): Promise<{ seat: string | null; holder: string | null }> {
  const seat = await agentSeatUserId(handle);
  let holder: string | null = null;
  try {
    const rows = (await handle.execute(sql`SELECT owner_user_id::text AS h FROM agent_config WHERE id = 1`)) as unknown as {
      h: string | null;
    }[];
    holder = [...rows][0]?.h ?? null;
  } catch (err) {
    // A server one migration behind 0138 has no agent at all, so no seat holds.
    logger.warn({ err }, '[agent-seat] holder not read');
  }
  return { seat, holder: holder?.toLowerCase() ?? null };
}

/**
 * Does the designated seat hold the account the AI speaks from (K4)? False with no seat named, and false once the
 * holder was re-pointed (`setAgentOwner`) to somebody else — every seat-only act stops then, fail closed: the
 * 100-request cap (§1.3) and the machine's offers on a card (§2.4).
 */
export async function holderIsSeat(handle: Db | Tx = db): Promise<boolean> {
  const { seat, holder } = await seatAndHolder(handle);
  return seat !== null && seat === holder;
}
