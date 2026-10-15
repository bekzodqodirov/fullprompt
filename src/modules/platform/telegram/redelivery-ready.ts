import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { logger } from '../logger';

/**
 * Do both 0130 tables exist? (Q5 a.)
 *
 * Its own module — the `wms/receipts/lot-check-ready.ts` idiom — so ONE
 * `vi.mock` turns `once.ts` AND `waits.ts` into «a server one migration
 * behind» at once. On deploy morning the code is up before the migration
 * lands (#472): every key and every wait write asks this first, and a «no»
 * is today's un-keyed behaviour, never a 42P01 on the poller.
 *
 * Caches TRUE only; «no» is asked again, so the bot comes back the moment
 * 0130 lands.
 */
let ready = false;

export async function redeliveryReady(): Promise<boolean> {
  if (ready) return true;
  try {
    const rows = await db.execute<{ ok: boolean }>(sql`
      SELECT to_regclass('public.telegram_once') IS NOT NULL
         AND to_regclass('public.telegram_chat_waits') IS NOT NULL AS ok`);
    ready = rows[0]?.ok === true;
  } catch (err) {
    logger.warn({ err }, '[bot] redelivery tables not checked');
    return false;
  }
  return ready;
}
