import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { usersWithPermission } from '../../platform/notifications/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import type { Exec } from '../finance/unpriced';
import { chainVersionsFor } from './chain';
import { linkAskTag, pendingLinkSql, PENDING_LINK_FROM } from './link';

/**
 * «Bu prixodlar hisobingizga tegishlimi?» — the VED is ASKED about a guess
 * (owner, 2026-09-29, answer 20a: «VED tasdiqlaydi … Telegram ✅/❌»).
 *
 * The guess itself is `calc/link.ts`'s and it never scores anybody; what was
 * missing is the person being asked. A sweep every five minutes, office hours
 * only (the cron in `jobs.ts`), finds the guesses nobody has been asked about
 * and sends ONE message per (sealer, calculation) with a ✅/❌ row per prixod.
 *
 * WHO IS ASKED: the sealer of the request's CURRENT version — the person the
 * comparison will measure — and only while they still hold `ved.docs` or
 * `finance.reports` and are active (`usersWithPermission` reads `active`). A
 * VED who left or lost the role is asked nothing and their guesses wait on
 * «Hisob nazorati», where the accountant sees them (the owner's open point 1,
 * built as its default).
 *
 * THE CLAIM is the drain's shape (0082): one UPDATE stamps
 * `calc_link_notified_at` BEFORE anything leaves, over rows locked `FOR NO
 * KEY UPDATE SKIP LOCKED` and re-checked unstamped under the lock, so two
 * sweeps overlapping split the work instead of both asking. A whole request's
 * rows are claimed together, so one message names them all. Trade, stated: a
 * crash between the claim and the send loses that push — never the home
 * count, which reads the guesses themselves.
 */

/** How many calculations one sweep asks about. The rest wait five minutes. */
export const LINK_ASK_REQUESTS_PER_SWEEP = 20;

/** How many prixods one message names; the rest are counted and sent to the screen. */
export const LINK_ASK_SHOWN = 5;

export interface ClaimedAsk {
  receiptId: string;
  requestId: string;
}

/**
 * Take the unasked guesses of up to twenty calculations whose sealer is in
 * `eligibleSealers`. `exec` is the pool by default; a test holds a claim open
 * in its own transaction to prove the second claimer neither waits nor
 * overlaps.
 */
export async function claimLinkAsks(eligibleSealers: string[], exec: Exec = db): Promise<ClaimedAsk[]> {
  const sealers = [...new Set(eligibleSealers)].filter(Boolean);
  if (sealers.length === 0) return [];
  const list = sql.join(
    sealers.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await exec.execute<{ id: string; calc_request_id: string }>(sql`
    WITH pending AS (
      SELECT rc.id, rc.calc_request_id, rc.confirmed_at
        FROM ${PENDING_LINK_FROM}
       WHERE ${pendingLinkSql({ scope: 'all', actorId: '' })}
         AND rc.calc_request_id IS NOT NULL
         AND rc.calc_link_notified_at IS NULL
         AND v.sealed_by IN (${list})
    ),
    reqs AS (
      SELECT calc_request_id FROM pending
       GROUP BY calc_request_id
       ORDER BY min(confirmed_at)
       LIMIT ${LINK_ASK_REQUESTS_PER_SWEEP}
    ),
    picked AS (
      SELECT pr.id FROM receipts pr
       WHERE pr.id IN (SELECT id FROM pending WHERE calc_request_id IN (SELECT calc_request_id FROM reqs))
         AND pr.calc_link_notified_at IS NULL
       FOR NO KEY UPDATE SKIP LOCKED
    )
    UPDATE receipts u SET calc_link_notified_at = now()
     WHERE u.id IN (SELECT id FROM picked)
       AND u.calc_link_notified_at IS NULL
    RETURNING u.id::text AS id, u.calc_request_id::text AS calc_request_id
  `);
  return rows.map((row) => ({ receiptId: row.id, requestId: row.calc_request_id }));
}

/** One prixod as the message prints it — quantities only, never money. */
export interface LinkAskRow {
  receiptId: string;
  number: string | null;
  m3: number;
  kg: number;
}

export interface LinkAskGroup {
  requestId: string;
  sealedBy: string;
  clientCode: string | null;
  quoteNo: number | null;
  sealedAt: Date;
  quotedM3: number | null;
  quotedKg: number | null;
  rows: LinkAskRow[];
}

const kgText = (kg: number) => Math.round(kg).toLocaleString('ru-RU');
const m3Text = (m3: number) => String(Math.round(m3 * 100) / 100);
const ddmm = (at: Date) =>
  at.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit' });

/**
 * The message, pure. Uzbek like every staff-bot text; quantities against the
 * calculation's quantities, because that is the whole question — «is this the
 * cargo that quote was about?» — and a person answers it from two pairs of
 * numbers. The link to the control screen goes LAST, where the drain turns an
 * own-origin line into «↗️ Ochish».
 */
export function linkAskText(group: LinkAskGroup, appUrl: string): string {
  const quoted =
    group.quotedM3 !== null || group.quotedKg !== null
      ? ` · hisob ${group.quotedM3 !== null ? `${m3Text(group.quotedM3)} m³` : '—'} / ${
          group.quotedKg !== null ? `${kgText(group.quotedKg)} kg` : '—'
        }`
      : '';
  const head = `${group.clientCode ?? '—'} · V${group.quoteNo ?? '?'} · ${ddmm(group.sealedAt)}${quoted}`;
  const shown = group.rows.slice(0, LINK_ASK_SHOWN);
  const lines = shown.map((row) => `• ${row.number ?? '—'} — ${m3Text(row.m3)} m³ / ${kgText(row.kg)} kg`);
  const rest = group.rows.length - shown.length;
  if (rest > 0) lines.push(`+${rest} — Hisob nazorati`);
  const url = appUrl.replace(/\/$/, '');
  return [
    '🧮 Bu prixodlar hisobingizga tegishlimi?',
    head,
    ...lines,
    ...(url ? [`${url}/hisoblash/nazorat`] : []),
  ].join('\n');
}

/** Everything the messages print, for the claimed rows, in one query. */
async function linkAskGroups(claimed: ClaimedAsk[]): Promise<LinkAskGroup[]> {
  if (claimed.length === 0) return [];
  const ids = sql.join(
    claimed.map((c) => sql`${c.receiptId}::uuid`),
    sql`, `,
  );
  const rows = await db.execute<{
    receipt_id: string;
    number: string | null;
    request_id: string;
    sealed_by: string;
    sealed_at: string;
    quoted_m3: string | null;
    quoted_kg: string | null;
    client_code: string | null;
    m3: string;
    kg: string;
  }>(sql`
    SELECT rc.id::text AS receipt_id, rc.number, rc.calc_request_id::text AS request_id,
           v.sealed_by::text AS sealed_by, v.sealed_at, v.volume_m3 AS quoted_m3, v.weight_kg AS quoted_kg,
           c.client_code,
           coalesce(m.m3, 0) AS m3, coalesce(m.kg, 0) AS kg
      FROM ${PENDING_LINK_FROM}
      LEFT JOIN clients c ON c.id = rc.client_id
      LEFT JOIN LATERAL (
        SELECT sum(rl.total_volume_m3) AS m3, sum(rl.total_weight_kg) AS kg
          FROM receipt_lots rl WHERE rl.receipt_id = rc.id
      ) m ON true
     WHERE rc.id IN (${ids})
       AND ${pendingLinkSql({ scope: 'all', actorId: '' })}
     ORDER BY rc.confirmed_at, rc.number
  `);
  const chains = await chainVersionsFor([...new Set(rows.map((r) => r.request_id))]);
  const groups = new Map<string, LinkAskGroup>();
  for (const r of rows) {
    let group = groups.get(r.request_id);
    if (!group) {
      // The request's own newest seal in its chain — what «V2» prints on
      // every other screen (chain.ts), never `version_no`.
      const own = (chains.get(r.request_id) ?? []).filter((v) => v.requestId === r.request_id);
      group = {
        requestId: r.request_id,
        sealedBy: r.sealed_by,
        clientCode: r.client_code,
        quoteNo: own.length > 0 ? own[own.length - 1]!.quoteNo : null,
        // Raw `db.execute` timestamps are TEXT (#923).
        sealedAt: new Date(r.sealed_at),
        quotedM3: r.quoted_m3 === null ? null : Number(r.quoted_m3),
        quotedKg: r.quoted_kg === null ? null : Number(r.quoted_kg),
        rows: [],
      };
      groups.set(r.request_id, group);
    }
    group.rows.push({ receiptId: r.receipt_id, number: r.number, m3: Number(r.m3), kg: Number(r.kg) });
  }
  return [...groups.values()];
}

/**
 * Who may be asked: an ACTIVE holder of either door to the control screen
 * (`calcControlScopeFor`'s two grants) — the grants are editable data, so
 * this is read, never listed (#170). A sealer outside it is simply not
 * claimed for, and their guesses stay unasked and visible on the screen.
 */
export async function linkAskEligible(): Promise<string[]> {
  const [ved, reports] = await Promise.all([
    usersWithPermission('ved.docs'),
    usersWithPermission('finance.reports'),
  ]);
  return [...new Set([...ved, ...reports])];
}

/**
 * The sweep. Eligibility is read on the POOL before the claim; the messages
 * go after the claim has committed (`notifyStaffTelegram` is pool-only and
 * kicks the drain). Returns how many messages were queued.
 */
export async function sendLinkAsks(): Promise<number> {
  const eligible = await linkAskEligible();
  if (eligible.length === 0) return 0;
  const claimed = await claimLinkAsks(eligible);
  if (claimed.length === 0) return 0;
  const groups = await linkAskGroups(claimed);
  const appUrl = process.env.APP_URL ?? '';
  let sent = 0;
  for (const group of groups) {
    sent += await notifyStaffTelegram({
      userIds: [group.sealedBy],
      type: 'CalcLinkAsk',
      text: linkAskText(group, appUrl),
      extra: {
        asks: group.rows.slice(0, LINK_ASK_SHOWN).map((row) => ({
          receiptId: row.receiptId,
          req8: linkAskTag(group.requestId),
          number: row.number,
        })),
      },
    });
  }
  return sent;
}
