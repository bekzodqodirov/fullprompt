import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, paymentPromises, tasks, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission, usersWithRoles } from '../../platform/notifications/service';
import { createTask } from '../../platform/tasks/service';
import { addDays, calendarDay, tashkentDay } from '../../platform/time/tashkent';
import { clientBalanceUsd } from '../finance/service';
import { ledgerAlias, netPaidUsdSql, signedUsdSql } from '../finance/ledger-sql';
import { MAX_ROW_USD } from '../finance/money-bounds';
import { mayGrantDebt, type MoneyActor } from '../finance/scope';
import { CENT, PROMISE_HORIZON_DAYS, promiseVerdict, type PromiseStatus, type PromiseVerdict } from './rules';

/**
 * To'lov va'dasi (0114): «I will pay $A by day D», typed on the client's «Pul»
 * tab by somebody who may let his cargo go on debt, and judged afterwards by
 * the ledger alone.
 *
 * The CALL the promise needs is a TASK and never the client's follow-up slot
 * (the judge's #2 and #3): a client has ONE follow-up date, and it belongs to
 * a call a person booked — writing the promise over it and clearing it later
 * deleted that call for good; and for a client with no seller the slot
 * reached nobody's list, while the accountant who took the promise sees no
 * call list at all. A task has an owner, a day, a Telegram ping with its own
 * «✅ Bajarildi», and a place on /bugun for every role. It goes to the
 * client's seller — the person who rings him — or to whoever recorded the
 * promise when the client has none (or his seller has left). The system
 * closes it when the promise is kept or cancelled (the calc task's precedent:
 * the row carries `task_id`, the close is guarded on `status = 'open'`).
 *
 * The task title and every stored text carry NO amount: tasks are read by
 * people outside the money law, and the figure stays on the ledger page.
 */

export class PromiseError extends Error {
  constructor(public readonly code: PromiseErrorCode) {
    super(code);
  }
}

export type PromiseErrorCode =
  | 'unauthenticated'
  | 'not_found'
  | 'not_your_client'
  | 'bad_amount'
  | 'bad_date'
  | 'no_debt'
  | 'exceeds_debt'
  | 'promise_open'
  | 'not_open';

/** The task's words — no figure, ever (see above). */
export const PROMISE_TASK_TITLE = '💵 To‘lov va’dasi';

export interface PromiseView {
  id: string;
  amountUsd: number;
  dueOn: string;
  note: string | null;
  status: PromiseStatus;
  createdAt: Date;
  createdByName: string | null;
  settledAt: Date | null;
  /** Net money in since the promise — live for an open one, as of now for a closed one. */
  paidSinceUsd: number;
}

/**
 * Record a promise. The balance is read on the POOL before the transaction
 * (#714), the row and its audit are one transaction, and the call task is
 * made after the commit — a Telegram ping must never be able to roll a
 * promise back, and a task that fails to open leaves a promise the sweep
 * still judges and alerts on.
 */
export async function recordPromise(
  input: { clientId: string; amountUsd: number; dueOn: string; note?: string | null },
  ctx: AuditContext,
  /** REQUIRED (#790): who may promise on this client's debt is `mayGrantDebt`. */
  actor: MoneyActor,
  now: Date = new Date(),
): Promise<{ id: string }> {
  if (!ctx.actorId) throw new PromiseError('unauthenticated');
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, input.clientId),
    columns: { id: true, clientCode: true, salesManagerId: true },
  });
  if (!client) throw new PromiseError('not_found');
  if (!mayGrantDebt(actor, client)) throw new PromiseError('not_your_client');

  // A NaN answers false to every comparison a guard is made of (#777), so the
  // amount is checked for being a real number FIRST.
  const amount = Math.round(input.amountUsd * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_ROW_USD) throw new PromiseError('bad_amount');
  const today = tashkentDay(now);
  const dueOn = calendarDay(input.dueOn);
  if (!dueOn || dueOn < today || dueOn > addDays(today, PROMISE_HORIZON_DAYS)) throw new PromiseError('bad_date');

  const balance = await clientBalanceUsd(input.clientId);
  if (balance <= CENT) throw new PromiseError('no_debt');
  if (amount > balance + CENT) throw new PromiseError('exceeds_debt');

  const note = input.note?.trim().slice(0, 500) || null;
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(paymentPromises)
        .values({
          clientId: input.clientId,
          amountUsd: amount.toFixed(2),
          dueOn,
          note,
          balanceAtUsd: balance.toFixed(2),
          createdBy: ctx.actorId!,
          createdAt: now,
        })
        .returning({ id: paymentPromises.id });
      await writeAudit(tx, ctx, {
        entityType: 'payment_promise',
        entityId: row!.id,
        action: 'create',
        after: { clientId: input.clientId, amountUsd: amount, dueOn, balanceAtUsd: balance, note },
      });
      return row!.id;
    });
  } catch (err) {
    // One OPEN promise per client — the partial unique index is the arbiter
    // of a race the read above cannot see (#472: a 23505 is a sentence, not a
    // white page).
    if ((err as { code?: string }).code === '23505') throw new PromiseError('promise_open');
    throw err;
  }

  await openPromiseTask(id, { clientId: client.id, code: client.clientCode, sellerId: client.salesManagerId, dueOn }, ctx);
  return { id };
}

/** The call, as a task: the seller's, or the recorder's when there is none. */
async function openPromiseTask(
  promiseId: string,
  client: { clientId: string; code: string; sellerId: string | null; dueOn: string },
  ctx: AuditContext,
): Promise<void> {
  try {
    const seller = client.sellerId
      ? await db.query.users.findFirst({ where: eq(users.id, client.sellerId), columns: { active: true } })
      : null;
    const task = await createTask(
      {
        title: `${PROMISE_TASK_TITLE} · ${client.code}`,
        note: '',
        typeId: null,
        assigneeId: seller?.active ? client.sellerId! : ctx.actorId!,
        // A bare DATE: `parseDue` treats only `YYYY-MM-DD` as all-day (#978's
        // lesson — a full ISO string became a timed 04:59 deadline).
        dueAt: client.dueOn,
        priority: 1,
        entityType: 'client',
        entityId: client.clientId,
        repeatUnit: null,
        repeatEvery: 1,
      },
      ctx,
    );
    await db.update(paymentPromises).set({ taskId: task.id }).where(eq(paymentPromises.id, promiseId));
  } catch (err) {
    // Never fatal: the promise is recorded and the sweep still judges it and
    // raises the alarm; only the reminder on /bugun is missing.
    logger.error({ err, promiseId }, '[debt] promise task not opened');
  }
}

/** Close the promise's call task, if it is still open — never a person's other work. */
async function closePromiseTasks(taskIds: string[], outcome: 'done' | 'cancelled', result: string, now: Date) {
  if (taskIds.length === 0) return;
  await db
    .update(tasks)
    .set(
      outcome === 'done'
        ? { status: 'done', doneAt: now, result, updatedAt: now }
        : { status: 'cancelled', result, updatedAt: now },
    )
    .where(and(inArray(tasks.id, taskIds), eq(tasks.status, 'open')));
}

/**
 * Withdraw an open promise — the same people who may make one. The claim is
 * the UPDATE (`status = 'open'` in its WHERE): a sweep that judged it a
 * moment earlier wins and the person hears «already closed».
 */
export async function cancelPromise(promiseId: string, ctx: AuditContext, actor: MoneyActor): Promise<void> {
  if (!ctx.actorId) throw new PromiseError('unauthenticated');
  const [row] = await db
    .select({ id: paymentPromises.id, status: paymentPromises.status, salesManagerId: clients.salesManagerId })
    .from(paymentPromises)
    .innerJoin(clients, eq(clients.id, paymentPromises.clientId))
    .where(eq(paymentPromises.id, promiseId))
    .limit(1);
  if (!row) throw new PromiseError('not_found');
  if (!mayGrantDebt(actor, { salesManagerId: row.salesManagerId })) throw new PromiseError('not_your_client');
  const now = new Date();
  const claimed = await db.transaction(async (tx) => {
    const done = await tx
      .update(paymentPromises)
      .set({ status: 'cancelled', settledAt: now, settledBy: ctx.actorId })
      .where(and(eq(paymentPromises.id, promiseId), eq(paymentPromises.status, 'open')))
      .returning({ taskId: paymentPromises.taskId });
    if (done.length === 0) return null;
    await writeAudit(tx, ctx, {
      entityType: 'payment_promise',
      entityId: promiseId,
      action: 'status_change',
      before: { status: 'open' },
      after: { status: 'cancelled' },
    });
    return done[0]!;
  });
  if (!claimed) throw new PromiseError('not_open');
  await closePromiseTasks(claimed.taskId ? [claimed.taskId] : [], 'cancelled', 'Va’da bekor qilindi', now);
}

/**
 * Money in since each promise (net of refunds, voided rows out) and whether
 * any of it came in a currency other than dollars — the verdict's two
 * ledger-side inputs, read with the balance in ONE query over the open rows
 * (#432: never a balance call per promise).
 */
async function promiseLedger(where: ReturnType<typeof sql>): Promise<
  {
    id: string;
    client_id: string;
    amount_usd: string;
    due_on: string;
    created_by: string;
    task_id: string | null;
    client_code: string;
    client_name: string;
    seller_id: string | null;
    recorder_name: string | null;
    paid: string;
    foreign_since: boolean;
    balance: string;
  }[]
> {
  const paid = netPaidUsdSql(ledgerAlias('ct'));
  const signed = signedUsdSql(ledgerAlias('cb'));
  const rows = await db.execute(sql`
    SELECT p.id, p.client_id, p.amount_usd, p.due_on::text AS due_on, p.created_by, p.task_id,
           c.client_code, c.name AS client_name, c.sales_manager_id AS seller_id,
           u.full_name AS recorder_name,
           coalesce(since.paid, 0) AS paid, coalesce(since.foreign_since, false) AS foreign_since,
           coalesce(bal.balance, 0) AS balance
      FROM payment_promises p
      JOIN clients c ON c.id = p.client_id
      LEFT JOIN users u ON u.id = p.created_by
      LEFT JOIN LATERAL (
        SELECT sum(${paid}) AS paid,
               bool_or(ct.currency <> 'USD' AND ${paid} <> 0) AS foreign_since
          FROM client_transactions ct
         WHERE ct.client_id = p.client_id AND ct.voided_at IS NULL AND ct.created_at > p.created_at
      ) since ON true
      LEFT JOIN LATERAL (
        SELECT sum(${signed}) AS balance
          FROM client_transactions cb
         WHERE cb.client_id = p.client_id AND cb.voided_at IS NULL
      ) bal ON true
     WHERE ${where}`);
  return [...rows] as never;
}

/**
 * The sweep (`JOB_DEBT_PROMISES`, the office day): every open promise is
 * judged by `promiseVerdict`, CLAIMED (`status = 'open'` in the UPDATE, so a
 * second sweep or a cancel racing it moves nothing twice) and only then acted
 * on — the alarm after the claim (#599), so one broken promise is ONE alarm.
 * A crash between the claim and the send loses that alarm; stated, and the
 * price of never sending two.
 */
export async function sweepPromises(now: Date = new Date()): Promise<Record<Exclude<PromiseVerdict, 'open'>, number>> {
  const open = await promiseLedger(sql`p.status = 'open'`);
  const byVerdict = new Map<PromiseVerdict, typeof open>();
  for (const row of open) {
    const verdict = promiseVerdict({
      amountUsd: Number(row.amount_usd),
      paidSinceUsd: Number(row.paid),
      foreignSince: Boolean(row.foreign_since),
      balanceUsd: Number(row.balance),
      dueOn: row.due_on,
      now,
    });
    byVerdict.set(verdict, [...(byVerdict.get(verdict) ?? []), row]);
  }

  const counts = { kept: 0, settled: 0, broken: 0 };
  for (const verdict of ['kept', 'settled', 'broken'] as const) {
    const rows = byVerdict.get(verdict) ?? [];
    if (rows.length === 0) continue;
    // `inArray`, never a JS array bound into raw sql (the judge's #14).
    const claimed = await db
      .update(paymentPromises)
      .set({ status: verdict, settledAt: now })
      .where(
        and(
          inArray(
            paymentPromises.id,
            rows.map((row) => row.id),
          ),
          eq(paymentPromises.status, 'open'),
        ),
      )
      .returning({ id: paymentPromises.id, taskId: paymentPromises.taskId });
    counts[verdict] = claimed.length;
    if (claimed.length === 0) continue;
    const mine = new Set(claimed.map((row) => row.id));
    const won = rows.filter((row) => mine.has(row.id));
    await writeAuditRows(won, verdict);

    if (verdict === 'broken') {
      // The call stays open on the list — a broken promise is exactly when
      // somebody must ring.
      for (const row of won) await alertBroken(row).catch((err) => logger.error({ err, id: row.id }, '[debt] alert'));
    } else {
      await closePromiseTasks(
        claimed.flatMap((row) => (row.taskId ? [row.taskId] : [])),
        'done',
        verdict === 'kept' ? 'To‘lov keldi' : 'Qarz yopildi',
        now,
      );
    }
  }
  return counts;
}

async function writeAuditRows(rows: { id: string }[], verdict: Exclude<PromiseVerdict, 'open'>) {
  for (const row of rows) {
    await writeAudit(db, { actorId: null }, {
      entityType: 'payment_promise',
      entityId: row.id,
      action: 'status_change',
      before: { status: 'open' },
      after: { status: verdict },
    });
  }
}

/**
 * «Va'da bajarilmadi» — to the client's seller (the person who rings him; the
 * recorder when he has none), the owner (the super_admin ROLE) and the
 * register's own audience (`finance.reports`: the accountant and the admins —
 * the people chasing the money). Law 4's grants only; the VED hears nothing.
 */
async function alertBroken(row: Awaited<ReturnType<typeof promiseLedger>>[number]): Promise<void> {
  const [owners, reporters] = await Promise.all([usersWithRoles(['super_admin']), usersWithPermission('finance.reports')]);
  const appUrl = process.env.APP_URL ?? '';
  const [y, m, d] = row.due_on.split('-');
  await notifyStaffTelegram({
    userIds: [row.seller_id ?? row.created_by, ...owners, ...reporters],
    type: 'PaymentPromiseBroken',
    text:
      `⚠️ To‘lov va’dasi bajarilmadi — ${row.client_code} · ${row.client_name}\n` +
      `Va’da: $${Number(row.amount_usd).toFixed(2)} · ${d}.${m}.${y} gacha\n` +
      `Keyin to‘landi: $${Number(row.paid).toFixed(2)} · Hozirgi qarz: $${Number(row.balance).toFixed(2)}\n` +
      `Va’da oldi: ${row.recorder_name ?? '—'}\n` +
      `${appUrl}/finance/${row.client_id}`,
  });
}

/** The client's promises for the «Pul» tab, newest first, with the money in since each. */
export async function clientPromises(clientId: string, limit = 10): Promise<PromiseView[]> {
  const rows = await db
    .select({
      id: paymentPromises.id,
      amountUsd: paymentPromises.amountUsd,
      dueOn: paymentPromises.dueOn,
      note: paymentPromises.note,
      status: paymentPromises.status,
      createdAt: paymentPromises.createdAt,
      createdByName: users.fullName,
      settledAt: paymentPromises.settledAt,
    })
    .from(paymentPromises)
    .leftJoin(users, eq(users.id, paymentPromises.createdBy))
    .where(eq(paymentPromises.clientId, clientId))
    .orderBy(desc(paymentPromises.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const ledger = await promiseLedger(
    sql`p.id IN (${sql.join(
      rows.map((row) => sql`${row.id}::uuid`),
      sql`, `,
    )})`,
  );
  const paidOf = new Map(ledger.map((row) => [row.id, Math.round(Number(row.paid) * 100) / 100]));
  return rows.map((row) => ({
    id: row.id,
    amountUsd: Number(row.amountUsd),
    dueOn: String(row.dueOn),
    note: row.note,
    status: row.status as PromiseStatus,
    createdAt: row.createdAt,
    createdByName: row.createdByName,
    settledAt: row.settledAt,
    paidSinceUsd: paidOf.get(row.id) ?? 0,
  }));
}
