import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { clients, tasks, users } from './platform';

/**
 * Qarz nazorati (0114) — a file of its own so the package's one new table does
 * not sit in the middle of wms.ts, which every package edits.
 */

/**
 * To'lov va'dasi: a debtor said «I will pay $A by day D». Recorded on the
 * client's «Pul» tab by the people who may let his cargo go on debt
 * (`mayGrantDebt`), judged by the sweep against the ledger's own dollars —
 * never by a status a person sets. USD only.
 *
 * `status`: open → kept (paid at least the amount), settled (the debt went
 * away another way — a voided charge, a compensation), broken (the day passed
 * unpaid), cancelled (a person withdrew it). Closed rows are history.
 */
export const paymentPromises = pgTable(
  'payment_promises',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
    dueOn: date('due_on').notNull(),
    note: text('note'),
    /** The balance the promise was made against — what the person saw. */
    balanceAtUsd: numeric('balance_at_usd', { precision: 14, scale: 2 }).notNull(),
    status: text('status').notNull().default('open'),
    /** The call the promise booked (a task, never the client's follow-up slot). */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** NULL on a row the sweep closed — the machine judged it, not a person. */
    settledBy: uuid('settled_by').references(() => users.id),
  },
  (t) => [
    check('payment_promises_amount_check', sql`${t.amountUsd} > 0 AND ${t.amountUsd} <> 'NaN'::numeric`),
    check('payment_promises_balance_check', sql`${t.balanceAtUsd} <> 'NaN'::numeric`),
    check(
      'payment_promises_status_check',
      sql`${t.status} IN ('open', 'kept', 'settled', 'broken', 'cancelled')`,
    ),
    check('payment_promises_settled_check', sql`(${t.status} = 'open') = (${t.settledAt} IS NULL)`),
    check('payment_promises_note_check', sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
    uniqueIndex('payment_promises_open_unique').on(t.clientId).where(sql`${t.status} = 'open'`),
    index('payment_promises_due_idx').on(t.dueOn).where(sql`${t.status} = 'open'`),
    index('payment_promises_client_idx').on(t.clientId, t.createdAt),
  ],
);
