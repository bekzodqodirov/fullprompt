import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Tx } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { quietHour } from '../../platform/telegram/send';
import { tashkentDay } from '../../platform/time/tashkent';
import type { FreightBand } from '../calc/pricing';
import { tariffFor } from '../calc/tariff-read';
import { agentFullP1Ready, mayRunAgent, readAgentConfig } from './config';
import { TRUCK_ZONE } from './estimate';
import { readSendCaps, SEND_CAPS_AUDIT_ID } from './send-caps';
import { SITE_TARIFF } from './site-estimate';

/**
 * The China column he vouched for (spec SPEC-P1-v2 §1.6, ⭐ Q7 a): after the website's table runs out nothing
 * independent checks an /admin/tarif row — and with no daily count (his «7») a mistyped band (16 for 160) would
 * go by itself to every customer of that density, and the re-price at the send (§1.3) would agree with the same
 * wrong row. So an estimate reply waits for his ✅ while the column has CHANGED since he last vouched for it
 * (`tariff_unconfirmed`, a gate fact): one ✅ on an estimate card priced on that column, or «✅ Tarif to'g'ri» on
 * the 14-day notice or the page, clears it. Before the expiry too: it costs one ✅ per tariff edit.
 *
 * Stored on the 0148 side table (`agent_send_caps.tariff_confirmed_at`), never a column of agent_config.
 */

/**
 * When the China column, as it stands on `day`, last CHANGED: a row written — inserted, or re-priced by the
 * dictionary's upsert, which keeps `created_at` and is read off its audit row — or a dated row coming into
 * force at the start of its day, Tashkent's. Every row in force on or before the day counts (an edit to a
 * superseded row counts too: failing closed costs one ✅). null: no China column at all — no truck figure can
 * be priced then (the tool refuses), so there is nothing to vouch for.
 */
export async function tariffChangedAt(day: string): Promise<Date | null> {
  const rows = await db.execute<{ at_ms: number | null }>(sql`
    SELECT (extract(epoch FROM max(greatest(
              t.created_at,
              coalesce(a.at, t.created_at),
              (t.effective_date::timestamp AT TIME ZONE 'Asia/Tashkent')
            ))) * 1000)::float8 AS at_ms
      FROM calc_freight_tariffs t
      LEFT JOIN LATERAL (SELECT max(l.created_at) AS at FROM audit_log l
                          WHERE l.entity_type = 'calc_tariff' AND l.entity_id = t.id) a ON true
     WHERE t.zone = ${TRUCK_ZONE} AND t.effective_date <= ${day}::date`);
  const ms = rows[0]?.at_ms;
  return ms === null || ms === undefined ? null : new Date(Number(ms));
}

/**
 * Has the China column changed since his last ✅ on it? A server one migration behind 0148 has nowhere to keep a
 * ✅ — unconfirmed (it cannot tick «Narx» either, so nothing priced goes by itself there anyway).
 */
export async function tariffUnconfirmed(now: Date): Promise<boolean> {
  const caps = await readSendCaps();
  if (!caps.ready) return true;
  const changed = await tariffChangedAt(tashkentDay(now));
  if (changed === null) return false;
  return caps.tariffConfirmedAt === null || changed.getTime() > caps.tariffConfirmedAt.getTime();
}

/**
 * His ✅ on the column as it stood at `asOf` — inside the caller's transaction (decide's approval: the ✅ that sent
 * an estimate priced on today's table, spec §1.6). Never moves the mark BACK: a ✅ on an older card vouches for
 * no write after it. Not audited here — the approval's own audit row is the record.
 */
export async function confirmTariffInTx(tx: Tx, asOf: Date, actorId: string | null): Promise<void> {
  await tx.execute(sql`
    INSERT INTO agent_send_caps (id, tariff_confirmed_at, updated_by) VALUES (1, ${asOf.toISOString()}::timestamptz, ${actorId}::uuid)
    ON CONFLICT (id) DO UPDATE
       SET tariff_confirmed_at = greatest(coalesce(agent_send_caps.tariff_confirmed_at, excluded.tariff_confirmed_at), excluded.tariff_confirmed_at),
           updated_at = now(), updated_by = excluded.updated_by`);
}

/** The China column's bands, as a short stamp of their content — what «✅ Tarif to'g'ri» vouches for. */
export function tariffFingerprint(bands: readonly FreightBand[]): string {
  const cn = bands
    .filter((b) => b.zone === TRUCK_ZONE)
    .map((b) => [b.minDensity, b.maxDensity, b.priceUsd, b.perKg])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return createHash('sha256').update(JSON.stringify(cn)).digest('hex').slice(0, 8);
}

/** The stamp of the column in force today. */
export async function currentTariffFingerprint(now: Date = new Date()): Promise<string> {
  return tariffFingerprint(await tariffFor(tashkentDay(now)));
}

export type TariffConfirmRefusal = 'not_ready' | 'forbidden' | 'tariff_changed';

export class TariffConfirmError extends Error {
  constructor(public readonly code: TariffConfirmRefusal) {
    super(code);
  }
}

/**
 * «✅ Tarif to'g'ri» — on the 14-day notice in the bot, or on the page. The holder's or a super_admin's (the
 * page's own door, `mayRunAgent` — he edits /admin/tarif himself). It vouches for the column it was SHOWN with
 * (`seen`, the stamp the button carries): a column written since is refused in words, never confirmed unseen. The
 * mark is the moment the column was read, so a write landing between the read and the stamp stays unconfirmed.
 * Audited.
 *
 * Says it ONCE (fix pass 3): a column already vouched for since its last change is `already` — no second mark, no
 * second audit row — so a press delivered again, or tapped again, answers with a toast and never a second message.
 */
export async function confirmTariff(
  actor: { id: string; roles: readonly string[] },
  seen: string,
  ctx: AuditContext,
): Promise<'confirmed' | 'already'> {
  if (!(await agentFullP1Ready())) throw new TariffConfirmError('not_ready');
  if (!mayRunAgent(actor, await readAgentConfig())) throw new TariffConfirmError('forbidden');
  const readAt = new Date();
  if ((await currentTariffFingerprint(readAt)) !== seen) throw new TariffConfirmError('tariff_changed');
  // On the pool, before the transaction (#714): when the column as it stands today last changed.
  const changed = await tariffChangedAt(tashkentDay(readAt));
  return db.transaction(async (tx) => {
    const before = await tx.execute<{ at_ms: number | null }>(
      sql`SELECT (extract(epoch FROM tariff_confirmed_at) * 1000)::float8 AS at_ms FROM agent_send_caps WHERE id = 1 FOR UPDATE`,
    );
    const was = before[0]?.at_ms;
    if (was !== null && was !== undefined && (changed === null || Number(was) >= changed.getTime())) return 'already';
    await confirmTariffInTx(tx, readAt, actor.id);
    await writeAudit(tx, ctx, {
      entityType: 'agent_send_caps',
      entityId: SEND_CAPS_AUDIT_ID,
      action: 'update',
      before: { tariffConfirmedAt: was === null || was === undefined ? null : new Date(Number(was)).toISOString() },
      after: { tariffConfirmedAt: readAt.toISOString(), via: 'tarif_togri', fingerprint: seen },
    });
    return 'confirmed';
  });
}

/** How many days before the website's `validThrough` the notice goes (spec §1.6). */
export const TARIFF_NOTICE_DAYS = 14;

/** The first Tashkent day the notice may go for this `validThrough`. */
export function tariffNoticeFrom(validThrough: string): string {
  const d = new Date(`${validThrough}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - TARIFF_NOTICE_DAYS);
  return d.toISOString().slice(0, 10);
}

/** The notice's words — the column and the date, no customer anywhere. */
export function tariffNoticeText(validThrough: string, day: string): string {
  const [y, m, dd] = validThrough.split('-');
  const when = `${dd}.${m}.${y}`;
  const head =
    day > validThrough
      ? `📅 Saytdagi narx jadvali ${when} da tugadi.`
      : `📅 Saytdagi narx jadvali ${when} da tugaydi.`;
  return [
    head,
    "Shundan keyin AI mashina yo'lkirasini «/admin/tarif»dagi Xitoy ustunidan aytadi (muddat 15-25 kun).",
    "Ustunni tekshiring: to'g'ri bo'lsa «✅ Tarif to'g'ri» ni bosing. Ustun o'zgarsa, keyingi birinchi narxli javob sizning ✅ingizni kutadi.",
  ].join('\n');
}

/**
 * The suites' switch (`AGENT_TARIFF_NOTICE=off`, set by vitest.config and the Playwright server's env — the
 * `GEO_NETWORK` / `NAV_AUTO` precedent). The notice is ONE claim per table on the one database every test file and
 * the browser suite's own server share, and any sweep on or after `validThrough − 14 days` takes it: from 2026-12-17
 * every file that runs `agentSweep` — seven of them, and the e2e server's own minute sweep — would have left the
 * claim spent on a deactivated fixture holder with a card queued to him. Configuration left behind (#183), and a
 * suite whose behaviour changes by the calendar (review of 0148 as built). The notice's own tests switch it on.
 */
export function tariffNoticeOn(): boolean {
  return process.env.AGENT_TARIFF_NOTICE !== 'off';
}

/**
 * The 14-day notice (spec §1.6): ONCE per `validThrough` — the claim is `agent_send_caps.tariff_notice_for`, taken
 * by a compare-and-set so two sweeps send one — to the agent's holder, by day only (a claim taken at 03:00 would
 * be its one chance, delivered at night). A deploy after the date sends it too, worded as past. Returns whether it
 * was sent.
 */
export async function tariffExpiryNotice(now: Date): Promise<boolean> {
  if (!tariffNoticeOn()) return false;
  const valid = SITE_TARIFF.validThrough;
  const day = tashkentDay(now);
  if (day < tariffNoticeFrom(valid) || quietHour(now)) return false;
  if (!(await agentFullP1Ready())) return false;
  // Said already for this table: the sweep runs every minute, and the column's read below is not free.
  const [said] = await db.execute<{ said: boolean }>(
    sql`SELECT coalesce(tariff_notice_for = ${valid}::date, false) AS said FROM agent_send_caps WHERE id = 1`,
  );
  if (said?.said === true) return false;
  const holder = (await readAgentConfig())?.ownerUserId ?? null;
  if (!holder) return false;
  const fingerprint = await currentTariffFingerprint(now);
  // The claim and the card in ONE transaction: a claim whose card was never written would be the notice lost.
  const sent = await db.transaction(async (tx) => {
    const claimed = await tx.execute<{ id: number }>(sql`
      UPDATE agent_send_caps SET tariff_notice_for = ${valid}::date, updated_at = now()
       WHERE id = 1 AND tariff_notice_for IS DISTINCT FROM ${valid}::date
      RETURNING id`);
    if (claimed.length === 0) return false;
    await queueStaffTelegram(tx, {
      userIds: [holder],
      type: 'AgentTariffNotice',
      text: tariffNoticeText(valid, day),
      // The button vouches for THIS column (`ag:t:<holder>:<stamp>`, `confirmTariff`).
      extra: { holderId: holder, fingerprint },
    });
    return true;
  });
  if (!sent) return false;
  await kickTelegramDrain();
  logger.info({ validThrough: valid }, '[agent] tariff notice sent');
  return true;
}
