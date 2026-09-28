import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { and, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  notifications,
  sessions,
  systemErrors,
  systemSignals,
  telegramLinks,
  tgAccounts,
  users,
} from '@/modules/platform/db/schema';
import { sideSql } from '@/modules/platform/db/side';
import { EXPECTED_MIGRATIONS, ledgerState, schemaLedger } from '@/modules/platform/db/ledger';
import { hashToken } from '@/modules/platform/auth/session';
import {
  __resetTelegramPause,
  problemSince,
  sendPendingTelegram,
  telegramBotState,
  telegramProblemSql,
} from '@/modules/platform/notifications/service';
import { __setTelegramTransport, sendText, setBotStateListener } from '@/modules/platform/telegram/send';
import { BOT_SIGNAL, botRefused, recordBotState } from '@/modules/platform/diagnostics/signals';
import {
  __resetErrorBrake,
  errorKey,
  failedJobs,
  listSystemErrors,
  pruneSystemErrors,
  recordServerError,
  recordWatchdogRestart,
  WATCHDOG_MARK_FILE,
} from '@/modules/platform/diagnostics/errors';
import { getBoss } from '@/modules/platform/jobs/boss';
import { claimQuietAlarm, sweepQuietListeners } from '@/modules/wms/crm/listener-quiet';
import { QUIET_ALARM_MS } from '@/modules/wms/crm/telegram-live';

/**
 * B9 against a real database. The shared-database rules (#713, #730, #183):
 * every assertion is about this file's own rows, the drain and the quiet
 * sweep PARK what is not ours and put it back exactly as found, and every row
 * this file makes is removed by ids it actually made (#661).
 */

const STAMP = `${String(Date.now()).slice(-7)}${randomBytes(2).toString('hex')}`;
const started = new Date();
let seq = 0;
const people: string[] = [];
const notes: string[] = [];
const accounts: string[] = [];
const errorKeys: string[] = [];
const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN };
let savedBotSignal: { since: Date; detail: string | null } | null = null;

async function mintUser(name: string): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(users)
    .values({
      phone: `+99896${String(Number.parseInt(STAMP.slice(0, 7), 10) + seq * 17).padStart(7, '0').slice(-7)}`,
      fullName: `${name} ${STAMP}-${seq}`,
      passwordHash: 'x',
      active: true,
    })
    .returning({ id: users.id });
  people.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  savedBotSignal = await botRefused();
});

afterAll(async () => {
  setBotStateListener(null);
  __setTelegramTransport(null);
  if (notes.length) await db.delete(notifications).where(inArray(notifications.id, notes));
  // The quiet sweep's copies to the admins are rows this file caused.
  await db
    .delete(notifications)
    .where(
      and(
        inArray(notifications.type, ['TelegramListenerQuiet', 'TelegramListenerBack']),
        gte(notifications.createdAt, started),
      ),
    );
  if (accounts.length) await db.delete(tgAccounts).where(inArray(tgAccounts.id, accounts));
  if (errorKeys.length) await db.delete(systemErrors).where(inArray(systemErrors.key, errorKeys));
  if (people.length) {
    await db.delete(notifications).where(inArray(notifications.userId, people));
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
    await db.delete(sessions).where(inArray(sessions.userId, people));
    await db.delete(users).where(inArray(users.id, people));
  }
  // The bot signal as it was found.
  await db.delete(systemSignals).where(eq(systemSignals.key, BOT_SIGNAL));
  if (savedBotSignal) {
    await db
      .insert(systemSignals)
      .values({ key: BOT_SIGNAL, since: savedBotSignal.since, detail: savedBotSignal.detail });
  }
  if (savedEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  await sideSql().end();
  await pgClient.end();
});

async function waitFor(check: () => Promise<boolean>, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe('«yuborilmagan» counts a dead bot (the fourth clause)', () => {
  it('a pending row older than fifteen minutes is a problem; one younger is not', async () => {
    const who = await mintUser('Kuzatuv hisob');
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const make = async (label: string, values: Partial<typeof notifications.$inferInsert>) => {
      const [row] = await db
        .insert(notifications)
        .values({ userId: who, channel: 'telegram', type: 'TaskAssigned', payload: { text: label }, ...values })
        .returning({ id: notifications.id });
      notes.push(row!.id);
      return row!.id;
    };
    const stale = await make('stale', { status: 'pending', createdAt: at(16) });
    const fresh = await make('fresh', { status: 'pending', createdAt: at(14) });
    const failed = await make('failed', { status: 'failed', createdAt: at(60), error: 'x' });
    const muted = await make('muted', { status: 'muted', createdAt: at(1), error: 'muted by user' });
    const stuck = await make('stuck', { status: 'sending', createdAt: at(30), claimedAt: at(11) });
    const old = await make('old', { status: 'failed', createdAt: at(8 * 24 * 60), error: 'x' });
    const inApp = await make('in-app', { channel: 'in_app', status: 'pending', createdAt: at(60) });

    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(inArray(notifications.id, [stale, fresh, failed, muted, stuck, old, inApp]), telegramProblemSql(problemSince())));
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([stale, failed, stuck]));
  });
});

describe('the bot state is recorded where every sender passes', () => {
  it('a second refusal moves the detail and never the moment it began', async () => {
    await recordBotState({ down: true, detail: 'Unauthorized' });
    const first = await botRefused();
    expect(first?.detail).toBe('Unauthorized');
    await new Promise((r) => setTimeout(r, 30));
    await recordBotState({ down: true, detail: 'Not Found' });
    const second = await botRefused();
    expect(second?.detail).toBe('Not Found');
    expect(second!.since.getTime()).toBe(first!.since.getTime());
    await recordBotState({ down: false, detail: '' });
    expect(await botRefused()).toBeNull();
  });

  it('the drain\'s 401 raises it and the next success anywhere clears it', async () => {
    const who = await mintUser('Kuzatuv bot');
    await db
      .insert(telegramLinks)
      .values({ userId: who, telegramChatId: BigInt(710_000_000 + seq), status: 'linked', linkedAt: new Date() });
    const [mine] = await db
      .insert(notifications)
      .values({ userId: who, channel: 'telegram', type: 'TaskAssigned', payload: { text: 'salom' }, status: 'pending' })
      .returning({ id: notifications.id });
    notes.push(mine!.id);

    // Only this file's row is claimable while the drain runs (#713).
    const parked = await db
      .update(notifications)
      .set({ status: 'sending', claimedAt: new Date() })
      .where(
        and(
          eq(notifications.channel, 'telegram'),
          eq(notifications.status, 'pending'),
          notInArray(notifications.id, [mine!.id]),
        ),
      )
      .returning({ id: notifications.id });
    try {
      process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
      __resetTelegramPause();
      setBotStateListener(recordBotState);
      let answer = { status: 401, json: { ok: false, description: 'Unauthorized' } as unknown };
      __setTelegramTransport(async () => new Response(JSON.stringify(answer.json), { status: answer.status }));

      await sendPendingTelegram().catch(() => {});
      expect(await waitFor(async () => (await botRefused()) !== null)).toBe(true);
      expect((await botRefused())?.detail).toBe('Unauthorized');
      // The row went back untouched: the token's fault, not the message's.
      const [row] = await db.select().from(notifications).where(eq(notifications.id, mine!.id));
      expect(row!.status).toBe('pending');

      // A success on ANY sender — here a plain message — takes it back.
      answer = { status: 200, json: { ok: true, result: { message_id: 1 } } };
      await sendText({ chatId: 1, text: 'x' });
      expect(await waitFor(async () => (await botRefused()) === null)).toBe(true);
    } finally {
      setBotStateListener(null);
      __setTelegramTransport(null);
      __resetTelegramPause();
      if (parked.length) {
        await db
          .update(notifications)
          .set({ status: 'pending', claimedAt: null })
          .where(and(inArray(notifications.id, parked.map((p) => p.id)), eq(notifications.status, 'sending')));
      }
    }
  });

  it('telegramBotState says refused, tokenless, and a backlog — each on its own', async () => {
    await recordBotState({ down: true, detail: 'Unauthorized' });
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    const refused = await telegramBotState();
    expect(refused.refused?.detail).toBe('Unauthorized');
    expect(refused.noToken).toBe(false);
    expect(refused.down).toBe(true);
    await recordBotState({ down: false, detail: '' });

    delete process.env.TELEGRAM_BOT_TOKEN;
    const tokenless = await telegramBotState();
    expect(tokenless).toMatchObject({ refused: null, noToken: true, down: true });
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';

    const who = await mintUser('Kuzatuv navbat');
    const before = await telegramBotState();
    const pendingAt = async (createdAt: Date) => {
      const [row] = await db
        .insert(notifications)
        .values({
          userId: who,
          channel: 'telegram',
          type: 'TaskAssigned',
          payload: { text: 'eski' },
          status: 'pending',
          createdAt,
        })
        .returning({ id: notifications.id });
      notes.push(row!.id);
    };
    await pendingAt(new Date(Date.now() - 40 * 60_000));
    const backlog = await telegramBotState();
    expect(backlog.oldestPendingAt!.getTime()).toBeLessThanOrEqual(Date.now() - 40 * 60_000 + 1_000);
    expect(backlog.waiting).toBe(before.waiting + 1);
    expect(backlog.down).toBe(true);

    // «N ta xabar kutmoqda» links to /admin/notifications' problems view, so it
    // counts what that view lists (the review, finding 3): a row queued a
    // minute ago is the drain's ordinary next tick, and a row older than the
    // week is outside the page's window — neither is a row the reader finds.
    await pendingAt(new Date(Date.now() - 60_000));
    await pendingAt(new Date(Date.now() - 8 * 86_400_000));
    const after = await telegramBotState();
    expect(after.waiting).toBe(before.waiting + 1);
    const [page] = await db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(telegramProblemSql(problemSince()), eq(notifications.status, 'pending')));
    expect(after.waiting).toBe(Number(page!.n));
  });
});

describe('the quiet-bridge sweep', () => {
  const quietCount = async (userId: string, type: string) =>
    (
      await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.type, type), gte(notifications.createdAt, started)))
    ).length;

  let accountSeq = 0;
  async function mintAccount(managerUserId: string, over: Partial<typeof tgAccounts.$inferInsert>) {
    accountSeq += 1;
    const [row] = await db
      .insert(tgAccounts)
      .values({
        managerUserId,
        tgPhone: `+99897${STAMP.slice(0, 5)}${String(accountSeq).padStart(2, '0')}`,
        sessionEnc: 'v1.x.y.z',
        status: 'active',
        ...over,
      })
      .returning({ id: tgAccounts.id });
    accounts.push(row!.id);
    return row!.id;
  }

  it('says «jim» once, «qaytdi» when live, then waits an hour — and leaves signed-out alone', async () => {
    const manager = await mintUser('Kuzatuv menejer');
    const signedOutManager = await mintUser('Kuzatuv chiqqan');
    const twentyAgo = new Date(Date.now() - 20 * 60_000);
    const quiet = await mintAccount(manager, { lastSeenAt: twentyAgo, updatedAt: twentyAgo });
    await mintAccount(signedOutManager, { status: 'signed_out', lastSeenAt: twentyAgo, updatedAt: twentyAgo });

    // Park every foreign account (#730): inside the re-alarm gap and not
    // open, so the sweep neither alarms nor recovers them; restored below.
    const foreign = await db
      .select({ id: tgAccounts.id, quietOpen: tgAccounts.quietOpen, quietNotifiedAt: tgAccounts.quietNotifiedAt })
      .from(tgAccounts)
      .where(notInArray(tgAccounts.id, accounts));
    if (foreign.length) {
      await db
        .update(tgAccounts)
        .set({ quietOpen: false, quietNotifiedAt: new Date() })
        .where(inArray(tgAccounts.id, foreign.map((f) => f.id)));
    }
    try {
      expect(await sweepQuietListeners()).toEqual({ quiet: 1, back: 0 });
      expect(await quietCount(manager, 'TelegramListenerQuiet')).toBe(1);
      const [text] = await db
        .select({ payload: notifications.payload })
        .from(notifications)
        .where(and(eq(notifications.userId, manager), eq(notifications.type, 'TelegramListenerQuiet')));
      expect((text!.payload as { text: string }).text).toMatch(/20 daqiqadan beri jim/);
      expect(await quietCount(signedOutManager, 'TelegramListenerQuiet')).toBe(0);

      // A second sweep says nothing new.
      expect(await sweepQuietListeners()).toEqual({ quiet: 0, back: 0 });
      expect(await quietCount(manager, 'TelegramListenerQuiet')).toBe(1);

      // The bridge beats: «qaytdi», once, and the stamp stays as the clock.
      await db.update(tgAccounts).set({ lastSeenAt: new Date() }).where(eq(tgAccounts.id, quiet));
      expect(await sweepQuietListeners()).toEqual({ quiet: 0, back: 1 });
      expect(await quietCount(manager, 'TelegramListenerBack')).toBe(1);
      const [after] = await db.select().from(tgAccounts).where(eq(tgAccounts.id, quiet));
      expect(after!.quietOpen).toBe(false);
      expect(after!.quietNotifiedAt).not.toBeNull();

      // …and dies again at once: inside the hour, no second «jim».
      const quietAgain = new Date(Date.now() - QUIET_ALARM_MS - 60_000);
      await db.update(tgAccounts).set({ lastSeenAt: quietAgain }).where(eq(tgAccounts.id, quiet));
      expect(await sweepQuietListeners()).toEqual({ quiet: 0, back: 0 });
      expect(await quietCount(manager, 'TelegramListenerQuiet')).toBe(1);
    } finally {
      for (const f of foreign) {
        await db
          .update(tgAccounts)
          .set({ quietOpen: f.quietOpen, quietNotifiedAt: f.quietNotifiedAt })
          .where(eq(tgAccounts.id, f.id));
      }
    }
  });

  it('one claim wins — the second is refused whoever asks', async () => {
    const manager = await mintUser('Kuzatuv da\'vo');
    const id = await mintAccount(manager, {});
    const now = new Date();
    expect(await claimQuietAlarm(id, now)).toBe(true);
    expect(await claimQuietAlarm(id, now)).toBe(false);
  });
});

describe('«Tizim xatolari» — the recorder', () => {
  const prefix = `kz${STAMP}`;

  it('counts one error once per occurrence, names the person, clips, strips the query', async () => {
    __resetErrorBrake();
    const who = await mintUser('Kuzatuv xato');
    const token = randomBytes(24).toString('base64url');
    await db.insert(sessions).values({
      userId: who,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const key = `${prefix}01`;
    errorKeys.push(key);
    const input = {
      digest: key,
      kind: 'render' as const,
      path: '/admin/clients?q=+998901234567',
      routePath: '/admin/clients',
      message: 'x'.repeat(400),
      stack: 'Error: x\n  at here',
      sessionToken: token,
    };
    const t0 = Date.now();
    expect(await recordServerError(input, t0)).toBe(true);
    // The same occurrence reaching the hook from the second render: no +1.
    expect(await recordServerError(input, t0 + 1_000)).toBe(false);
    expect(await recordServerError(input, t0 + 6_000)).toBe(true);

    const [row] = await db.select().from(systemErrors).where(eq(systemErrors.key, key));
    expect(row!.count).toBe(2);
    expect(row!.userId).toBe(who);
    expect(row!.path).toBe('/admin/clients');
    expect(Array.from(row!.message)).toHaveLength(300);
    expect(row!.message.endsWith('…')).toBe(true);

    const found = await listSystemErrors({ q: `#${key}@E394` });
    expect(found.map((r) => r.key)).toEqual([key]);
    expect(found[0]!.userName).toContain('Kuzatuv xato');

    // A person removed later does not take the record with them (23503).
    await db.delete(sessions).where(eq(sessions.userId, who));
    await db.delete(users).where(eq(users.id, who));
    people.splice(people.indexOf(who), 1);
    const [orphan] = await db.select().from(systemErrors).where(eq(systemErrors.key, key));
    expect(orphan!.userId).toBeNull();
  });

  it('the 24-hour list is what the home counts; the month is pruned', async () => {
    const recent = `${prefix}recent`;
    const dayOld = `${prefix}25h`;
    const monthOld = `${prefix}old`;
    errorKeys.push(recent, dayOld, monthOld);
    await db.insert(systemErrors).values([
      { key: recent, kind: 'route', message: 'r' },
      { key: dayOld, kind: 'route', message: 'd', lastSeenAt: new Date(Date.now() - 25 * 3_600_000) },
      { key: monthOld, kind: 'route', message: 'm', lastSeenAt: new Date(Date.now() - 31 * 86_400_000) },
    ]);
    const listed = (await listSystemErrors({ recent: true, limit: 5_000 })).map((r) => r.key);
    expect(listed).toContain(recent);
    expect(listed).not.toContain(dayOld);
    await pruneSystemErrors();
    const left = await db
      .select({ key: systemErrors.key })
      .from(systemErrors)
      .where(inArray(systemErrors.key, [recent, dayOld, monthOld]));
    expect(left.map((r) => r.key).sort()).toEqual([dayOld, recent].sort());
  });

  it('the watchdog\'s note becomes one row and is removed', async () => {
    __resetErrorBrake();
    const message = 'ilova qayta ishga tushirildi: pool stuck ×3';
    const key = errorKey({ digest: null, routePath: 'watchdog', message });
    errorKeys.push(key);
    const before = (await db.select().from(systemErrors).where(eq(systemErrors.key, key)))[0]?.count ?? 0;
    await writeFile(WATCHDOG_MARK_FILE, JSON.stringify({ at: new Date().toISOString(), reason: 'pool stuck', failures: 3 }));
    try {
      await recordWatchdogRestart();
      const [row] = await db.select().from(systemErrors).where(eq(systemErrors.key, key));
      expect(row!.message).toBe(message);
      expect(row!.count).toBe(before + 1);
      await expect(unlink(WATCHDOG_MARK_FILE)).rejects.toThrow();
    } finally {
      await unlink(WATCHDOG_MARK_FILE).catch(() => {});
    }
  });
});

describe('failed background jobs', () => {
  it('lists a job that gave up this week and forgets one from last week', async () => {
    const boss = getBoss();
    await boss.start();
    const name = `kuzatuv-test-${STAMP}`;
    const insert = (completedAgo: string, message: string) => sql`
      INSERT INTO pgboss.archive
        (id, name, priority, data, state, retry_limit, retry_count, retry_delay, retry_backoff,
         start_after, expire_in, created_on, completed_on, keep_until, output)
      VALUES (gen_random_uuid(), ${name}, 0, '{}'::jsonb, 'failed', 0, 0, 0, false,
              now(), interval '15 minutes', now() - interval '9 days', now() - ${completedAgo}::interval,
              now() + interval '1 day', jsonb_build_object('message', ${message}::text))`;
    try {
      await db.execute(insert('1 hour', 'kaboom'));
      await db.execute(insert('8 days', 'eskisi'));
      const jobs = await failedJobs(7);
      const mine = jobs.find((j) => j.name === name);
      expect(mine).toMatchObject({ count: 1, lastMessage: 'kaboom' });
      expect(mine!.lastAt).toBeInstanceOf(Date);
    } finally {
      await db.execute(sql`DELETE FROM pgboss.archive WHERE name = ${name}`);
      await boss.stop({ graceful: false, wait: true }).catch(() => {});
    }
  });
});

describe('the schema ledger', () => {
  it('counts the applied migrations and knows the expected from the code', async () => {
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    const ledger = await schemaLedger(Date.now() + 10 * 60_000);
    expect(ledger.applied).toBe(Number(row!.n));
    expect(ledger.expected).toBe(EXPECTED_MIGRATIONS);
    expect(ledger.state).toBe(ledgerState(ledger.applied, ledger.expected));
  });
});
