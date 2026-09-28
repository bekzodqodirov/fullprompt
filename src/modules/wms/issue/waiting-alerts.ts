import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { withoutJit } from '../../platform/db/no-jit';
import { isServerBehind } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { groupDigits } from '../../platform/telegram/format';
import { addDays, tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { unpricedGate } from '../finance/unpriced';
import {
  announceLevel,
  uncollectedCargo,
  waitRowKey,
  waitThresholds,
  waitingPriceGate,
  type UncollectedRow,
  type WaitThresholds,
} from './waiting';

/**
 * «Olib ketilmagan yuk» — the morning's announcements (0116, the owner's 3a:
 * «5 va 10 kundan keyin sotuvchi va ofisga ro'yxat, mijozga xabar yo'q»).
 *
 * The CUSTOMER is never messaged: nothing here touches `client_notices`,
 * whose drain speaks to customers. A seller hears about their own clients as
 * each crosses a level; the office hears about everybody on the 09:00
 * svodka, which runs this sweep FIRST so its section can say what crossed
 * today (the design review's #5 — as two jobs, 09:00 before 09:05, the office
 * could never have been told).
 *
 * Deliberately NOT one transaction and not one claim for the whole company
 * (the review's #4): the claim is one pooled statement PER SELLER, then that
 * seller's message, each in its own try/catch — so a send that throws, or a
 * process that dies between two sellers, costs at most the seller it was on,
 * never every seller after it with pg-boss's retry finding nothing left to
 * send. Claim-before-send can lose one message on a crash in between; the
 * other order sends it twice on every retry (#599, the stated trade).
 */

export const CARGO_WAITING = 'CargoWaiting';

/** Lines a seller's message names before it only counts. */
export const SELLER_LINES = 20;
/** Lines the svodka's section names before it only counts. */
export const OFFICE_LINES = 25;

/** Where the list lives — the last line, which the drain turns into «↗️ Ochish». */
export function waitingListLink(): string {
  return `${(process.env.APP_URL ?? '').replace(/\/$/, '')}/my-clients/olib-ketilmagan`;
}

export interface ClaimedCrossing {
  clientId: string;
  warehouseId: string;
  level: 1 | 2;
}

/**
 * Claim these rows' crossings — every level a row may be announced at
 * (`announceLevel`), ONE statement.
 *
 * automation_fires' shape (0067): an UPSERT re-won only when the waiting
 * set's clock moved past the last announcement (`sent_at < clock_from`), so
 * cargo collected and landing again, or cartons left behind at a visit, are
 * announced again, and a set that simply keeps waiting is announced once per
 * level. A moved clock is only OFFERED once it has been quiet for the warn
 * line (`announceLevel`) — the WHERE alone would re-win the morning after
 * every visit, since the age counts from the landing and is already past it.
 * `sent_at` is bound from `asOf`, never `now()`, so a test pins it.
 * On the POOL and never inside a transaction (#714).
 */
export async function claimWaitAlerts(
  rows: readonly UncollectedRow[],
  thresholds: WaitThresholds,
  asOf: Date,
): Promise<ClaimedCrossing[]> {
  const values: SQL[] = [];
  for (const row of rows) {
    const level = announceLevel(row, thresholds, asOf);
    if (level === 0 || !row.clockFrom) continue;
    for (let l = 1; l <= level; l += 1) {
      values.push(
        sql`(${row.clientId}::uuid, ${row.warehouseId}::uuid, ${l}, ${row.clockFrom.toISOString()}::timestamptz, ${asOf.toISOString()}::timestamptz)`,
      );
    }
  }
  if (values.length === 0) return [];
  const claimed = (await db.execute(sql`
    INSERT INTO cargo_wait_alerts (client_id, warehouse_id, level, clock_from, sent_at)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (client_id, warehouse_id, level) DO UPDATE
      SET clock_from = EXCLUDED.clock_from, sent_at = EXCLUDED.sent_at
      WHERE cargo_wait_alerts.sent_at < EXCLUDED.clock_from
    RETURNING client_id, warehouse_id, level
  `)) as unknown as { client_id: string; warehouse_id: string; level: number }[];
  return claimed.map((row) => ({
    clientId: row.client_id,
    warehouseId: row.warehouse_id,
    level: row.level === 2 ? 2 : 1,
  }));
}

/** Each (client, warehouse) once, at its highest level claimed. */
function highest(claimed: readonly ClaimedCrossing[]): Map<string, 1 | 2> {
  const out = new Map<string, 1 | 2>();
  for (const c of claimed) {
    const key = waitRowKey(c);
    if ((out.get(key) ?? 0) < c.level) out.set(key, c.level);
  }
  return out;
}

/**
 * One row as a line — the same words on the seller's message and the office's.
 * Kilos in the house's dot-decimal (`groupDigits`); «qoldiq» after the days;
 * then why the counter would refuse it, and a customs warehouse's own word.
 */
export function waitLine(
  row: UncollectedRow,
  opts: { unpriced?: number; seller?: boolean } = {},
): string {
  const parts = [`${row.warehouseCode}`, `${row.boxes} kor.`, `${groupDigits(row.kg)} kg`];
  if (row.days !== null) parts.push(`${row.days} kun${row.leftover ? ' (qoldiq)' : ''}`);
  if (opts.unpriced) parts.push(`narxsiz ${opts.unpriced} kor.`);
  if (row.customs) parts.push('bojxona skladi');
  if (opts.seller) parts.push(row.sellerName ?? 'sotuvchisiz');
  return `• ${row.clientCode} ${row.clientName} — ${parts.join(' · ')}`;
}

function levelBlocks(
  rows: readonly UncollectedRow[],
  levels: ReadonlyMap<string, 1 | 2>,
  t: WaitThresholds,
  cap: number,
  line: (row: UncollectedRow) => string,
): string[] {
  const alarm = rows.filter((row) => levels.get(waitRowKey(row)) === 2);
  const warn = rows.filter((row) => levels.get(waitRowKey(row)) === 1);
  const out: string[] = [];
  let shown = 0;
  for (const [title, group] of [
    [`🔴 ${t.alarm}+ kun:`, alarm],
    [`🟡 ${t.warn}+ kun:`, warn],
  ] as const) {
    if (group.length === 0 || shown >= cap) continue;
    out.push(title);
    for (const row of group) {
      if (shown >= cap) break;
      out.push(line(row));
      shown += 1;
    }
  }
  const total = alarm.length + warn.length;
  if (total > shown) out.push(`… yana ${total - shown} ta`);
  return out;
}

/**
 * A seller's morning message: only this morning's NEW crossings, each client
 * once at its highest level, then how many of their clients are waiting in
 * all, then the list. Uzbek like every staff message; capped, so a deploy
 * morning's backlog is one readable message and never a refused one.
 */
export function sellerWaitingText(input: {
  fresh: readonly UncollectedRow[];
  levels: ReadonlyMap<string, 1 | 2>;
  thresholds: WaitThresholds;
  waitingClients: number;
  unpriced: ReadonlyMap<string, number>;
  link: string;
}): string {
  const lines = ['⏳ Olib ketilmagan yuk'];
  lines.push(
    ...levelBlocks(input.fresh, input.levels, input.thresholds, SELLER_LINES, (row) =>
      waitLine(row, { unpriced: input.unpriced.get(waitRowKey(row)) }),
    ),
  );
  lines.push(`Jami kutmoqda: ${input.waitingClients} mijoz`);
  lines.push(`🔗 ${input.link}`);
  return lines.join('\n');
}

/**
 * The svodka's section: the standing picture in counts — per warehouse and
 * per seller, never a hundred rows (the owner's own rule for a supervisor,
 * 4.3c) — then what crossed TODAY by name, then the list. Sorting the whole
 * list by days and printing the top of it would print the same oldest rows
 * every morning and never the client who crossed today (the review's #5).
 * Empty when nothing is waiting past the warn line.
 */
export function officeWaitingSection(input: {
  rows: readonly UncollectedRow[];
  today: ReadonlyMap<string, 1 | 2>;
  thresholds: WaitThresholds;
  unpriced: ReadonlyMap<string, number>;
  link: string;
}): string[] {
  if (input.rows.length === 0) return [];
  const clients = new Set(input.rows.map((row) => row.clientId)).size;
  const boxes = input.rows.reduce((sum, row) => sum + row.boxes, 0);
  const lines = [`⏳ Olib ketilmagan yuk (${input.thresholds.warn}+ kun): ${clients} mijoz, ${boxes} kor.`];

  const byWarehouse = new Map<string, Set<string>>();
  const bySeller = new Map<string, Set<string>>();
  for (const row of input.rows) {
    byWarehouse.set(row.warehouseCode, (byWarehouse.get(row.warehouseCode) ?? new Set()).add(row.clientId));
    const seller = row.sellerName ?? 'sotuvchisiz';
    bySeller.set(seller, (bySeller.get(seller) ?? new Set()).add(row.clientId));
  }
  lines.push(
    `🏭 ${[...byWarehouse.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, set]) => `${code} ${set.size}`)
      .join(' · ')}`,
  );
  lines.push(
    `👥 ${[...bySeller.entries()]
      .sort(([, a], [, b]) => b.size - a.size)
      .map(([name, set]) => `${name} ${set.size}`)
      .join(' · ')}`,
  );

  const fresh = input.rows.filter((row) => input.today.has(waitRowKey(row)));
  if (fresh.length > 0) {
    lines.push(`Bugun ro'yxatga tushgan: ${fresh.length}`);
    lines.push(
      ...levelBlocks(fresh, input.today, input.thresholds, OFFICE_LINES, (row) =>
        waitLine(row, { unpriced: input.unpriced.get(waitRowKey(row)), seller: true }),
      ),
    );
  }
  lines.push(`🔗 ${input.link}`);
  return lines;
}

export interface WaitSweep {
  /** Everything waiting past the warn line — the svodka's standing picture. */
  rows: UncollectedRow[];
  thresholds: WaitThresholds;
  /** Crossings this run claimed, each row at its highest level. */
  claimed: Map<string, 1 | 2>;
  /** Seller messages queued. */
  messages: number;
  /**
   * «Narxsiz» per row, for every row above — read ONCE, JIT off, before any
   * seller is told; empty when the read failed (a courtesy, never the message).
   */
  unpriced: Map<string, number>;
}

/**
 * The morning sweep. Read once (company-wide, JIT off, settings resolved
 * first), claim and tell per seller, return what the svodka needs. A client
 * with no seller is claimed too — the office's «today» reads the claims —
 * and told to nobody but the office. A deactivated or muted seller's claim is
 * written all the same (`notifyStaffTelegram` skips or mutes the message), so
 * a reactivation does not flood.
 *
 * `clientIds` is the tests' seam (#713/#730): on CI's one shared database a
 * sweep over every client would claim and message other files' fixtures.
 * A missing table (a half-applied deploy, #472) is thrown to the caller — the
 * svodka catches it and goes out without the section.
 */
export async function sweepCargoWaiting(opts: { asOf: Date; clientIds?: string[] }): Promise<WaitSweep> {
  const thresholds = await waitThresholds();
  const gate = await unpricedGate();
  const { rows } = await withoutJit((exec) =>
    uncollectedCargo(exec, {
      asOf: opts.asOf,
      minDays: thresholds.warn,
      ownerId: undefined,
      warehouseIds: undefined,
      clientIds: opts.clientIds,
    }),
  );

  // The price tags for every row in ONE read, with JIT off like the list:
  // `uncoveredBoxesOn` is 0104's company-wide question, and asked per seller
  // on the pool it was up to ~20 separate JIT-compiled reads inside the 09:00
  // job. Before any claim, so a failure here costs the tags and nothing else.
  const unpriced = await withoutJit((exec) => waitingPriceGate(exec, rows, gate)).catch((err) => {
    if (isServerBehind(err)) throw err;
    logger.warn({ err }, 'cargo waiting: price tags unavailable');
    return new Map<string, number>();
  });

  const bySeller = new Map<string, UncollectedRow[]>();
  for (const row of rows) {
    const key = row.sellerId ?? '';
    bySeller.set(key, [...(bySeller.get(key) ?? []), row]);
  }

  const claimed = new Map<string, 1 | 2>();
  const link = waitingListLink();
  let messages = 0;
  for (const [sellerId, sellerRows] of bySeller) {
    try {
      const levels = highest(await claimWaitAlerts(sellerRows, thresholds, opts.asOf));
      for (const [key, level] of levels) claimed.set(key, level);
      if (!sellerId || levels.size === 0) continue;
      const fresh = sellerRows.filter((row) => levels.has(waitRowKey(row)));
      const text = sellerWaitingText({
        fresh,
        levels,
        thresholds,
        waitingClients: new Set(sellerRows.map((row) => row.clientId)).size,
        unpriced,
        link,
      });
      if ((await notifyStaffTelegram({ userIds: [sellerId], type: CARGO_WAITING, text })) > 0) messages += 1;
    } catch (err) {
      if (isServerBehind(err)) throw err;
      logger.error({ err, sellerId: sellerId || null }, 'cargo waiting: one seller failed');
    }
  }
  return { rows, thresholds, claimed, messages, unpriced };
}

/**
 * What was announced on this Tashkent day, each row at its highest level —
 * read off the claims rather than kept from the sweep's own answer, so a
 * retried svodka (pg-boss runs the job again after a throw) still names the
 * morning's crossings instead of «nothing new».
 */
export async function crossedOn(day: string, clientIds?: string[]): Promise<Map<string, 1 | 2>> {
  const only =
    clientIds === undefined
      ? sql``
      : clientIds.length
        ? sql`AND client_id IN (${sql.join(
            clientIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`AND false`;
  const rows = (await db.execute(sql`
    SELECT client_id, warehouse_id, max(level) AS level
      FROM cargo_wait_alerts
     WHERE sent_at >= ${tashkentDayStart(day).toISOString()}::timestamptz
       AND sent_at < ${tashkentDayStart(addDays(day, 1)).toISOString()}::timestamptz
       ${only}
     GROUP BY client_id, warehouse_id
  `)) as unknown as { client_id: string; warehouse_id: string; level: number }[];
  return highest(
    rows.map((row) => ({
      clientId: row.client_id,
      warehouseId: row.warehouse_id,
      level: Number(row.level) === 2 ? 2 : 1,
    })),
  );
}

/** The svodka's section, swept and composed — or `[]` when nothing waits. */
export async function waitingDigestSection(opts: { asOf: Date; clientIds?: string[] }): Promise<string[]> {
  const sweep = await sweepCargoWaiting(opts);
  if (sweep.rows.length === 0) return [];
  const today = await crossedOn(tashkentDay(opts.asOf), opts.clientIds);
  return officeWaitingSection({
    rows: sweep.rows,
    today,
    thresholds: sweep.thresholds,
    unpriced: sweep.unpriced,
    link: waitingListLink(),
  });
}
