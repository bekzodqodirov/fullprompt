import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { db, type Db, type Tx } from '../db/client';
import { taskTypes, tasks, users } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { entitySpec } from '../fields/registry';
import { recordNames, resolveEntity } from '../entities/service';
import { calcLink, taskLink } from '../notifications/links';
import { notifyStaffTelegram, reachOf, userName, type Reach } from '../notifications/staff';
import { retireTaskCopiesSoon } from '../notifications/retire-tasks';
import { logger } from '../logger';
import { canLogIn } from '../users/login';

/**
 * Work one person gives another (owner: "tasklar calendarlar").
 *
 * A task is NOT the CRM follow-up. A follow-up is a reminder a sales manager
 * sets for themselves on a lead; a task is assigned, has an owner who is not
 * necessarily its author, and is closed with a result. Both appear on `/bugun`;
 * neither was rewritten into the other, because the follow-up works and is used
 * every day.
 *
 * A task can point at any object the entity registry knows — a client, a
 * receipt, a batch — or at nothing at all.
 */

/**
 * Who is doing this, alongside the audit trail.
 *
 * The mutations need the actor's PERMISSIONS, not just their id, to answer
 * "is this yours" — so the context carries both rather than every function
 * growing a fourth argument.
 */
export type TaskContext = AuditContext & {
  actor: { id: string; permissions: Set<string> };
};

/**
 * Every refusal a task door can give, by name — a CLOSED list.
 *
 * It was `code: string`, and two readers paid for it: the staff bot's answer
 * map named three codes and rethrew every other one into `bot.catch`, so a
 * person who typed a result heard silence (review telegram-mechanics-1); and
 * the web form printed `tasks.errors.<code>` with two codes in no bundle at
 * all (tests-completeness-7). Now a code nobody listed is a compile error at
 * the `throw`, the bot's map is a `Record` over this union, and the i18n
 * fence reads this array.
 */
export const TASK_ERROR_CODES = [
  'unauthenticated',
  'validation',
  'bad_bound',
  'unknown_entity',
  'half_pointer',
  'no_assignee',
  'assignee_no_login',
  'assignee_inactive',
  'repeat_needs_due',
  'not_created',
  'bad_due_date',
  'not_found',
  'not_yours',
  'already_closed',
  // The task carries an OPEN calc job's clock (VED-TARIX §8): every task
  // door refuses, and the hisoblash screen is where the job ends.
  'calc_use_screen',
  // …and the question «is it bound?» could not be answered: refused rather
  // than guessed (the pre-check fails CLOSED).
  'bound_check_failed',
  // A payment promise's call while the promise stands: its date IS the
  // client's promise, which the sweep judges.
  'bound_clock',
  // ⏰ on one occurrence would move the whole series (telegram-mechanics-15).
  'repeat_series',
  'not_assignee',
  'already_accepted',
  'not_author',
  'remind_too_soon',
  'not_remindable',
  'not_askable',
  'empty_text',
] as const;
export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

export class TaskError extends Error {
  constructor(public readonly code: TaskErrorCode) {
    super(code);
  }
}

export const REPEAT_UNITS = ['day', 'week', 'month'] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];

export const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(4000).optional().or(z.literal('')),
  typeId: z.string().uuid().nullable().default(null),
  assigneeId: z.string().uuid(),
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`; empty = no deadline. */
  dueAt: z.string().trim().max(40).optional().or(z.literal('')),
  /**
   * The typist's `Date.getTimezoneOffset()`, carried by a hidden input.
   * A timed deadline is typed as a WALL CLOCK — 14:00 means 14:00 where the
   * typist sits, Tashkent or Yiwu — and without knowing whose wall it was,
   * the server (UTC) would store it five hours late (round 28).
   */
  tzOffsetMin: z.number().int().min(-840).max(840).nullable().optional(),
  priority: z.number().int().min(1).max(3).default(2),
  entityType: z.string().trim().max(40).nullable().default(null),
  entityId: z.string().uuid().nullable().default(null),
  repeatUnit: z.enum(REPEAT_UNITS).nullable().default(null),
  repeatEvery: z.number().int().min(1).max(365).default(1),
});
export type TaskInput = z.infer<typeof taskSchema>;

/**
 * Where a task came from (0124). NOT part of `taskSchema`: the form posts
 * what a person typed, and an origin is a fact about which door made the row —
 * a forged `calc` would strip a hand-given task of its buttons, a forged
 * `hand` would put a calc job in somebody's «📤 Men bergan». So it is an
 * argument every caller must name: a required option turns each one into a
 * compile error that names itself (#790's trick), and NULL is left for the
 * rows made before 0124.
 */
export const TASK_ORIGINS = ['hand', 'calc', 'calc_return', 'promise', 'automation'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export interface TaskMaking {
  origin: TaskOrigin;
  /** The record whose clock the task carries — the calc request ('calc') or
   * the payment promise ('promise'); refused on any other origin. */
  boundId?: string | null;
  /**
   * The author's own Telegram messages the task was given with — the staff
   * bot's draft (docs/TELEGRAM-TOPSHIRIQ.md §3). Forwarded to the assignee
   * before the task's text, and kept on the row so a reassign BY THE AUTHOR
   * can forward them again (access-money-12).
   */
  sourceMessages?: SourceMessage[] | null;
  /** Which door wrote it, recorded in the audit row — the bot says 'telegram'. */
  via?: 'telegram';
}

/** One of the author's messages, by the chat it sits in. */
export interface SourceMessage {
  chatId: number;
  messageId: number;
}

/** At most this many messages travel with one task (the draft's own cap). */
export const MAX_TASK_SOURCES = 10;

/**
 * Whose clock a task carries, as the wms gate answers it (calc/task-gate.ts).
 * `open` is that record's own state; a bound task whose record has closed is
 * an ordinary task again — that is the stale-task path.
 */
export interface TaskBinding {
  kind: 'calc' | 'promise';
  recordId: string;
  open: boolean;
}

export interface TaskBindingInput {
  id: string;
  origin: string | null;
  boundId: string | null;
}

/**
 * The bindings of a list of tasks — ONE call, its queries in wms (platform
 * never imports wms statically; the `completeCalcForTask` crossing). A list
 * of hand tasks costs nothing: only a NULL origin (a pointer may name it) or
 * a calc/promise row with a `bound_id` is asked about.
 */
export async function bindingsOf(rows: TaskBindingInput[]): Promise<Map<string, TaskBinding>> {
  const relevant = rows.filter(
    (row) => row.origin === null || ((row.origin === 'calc' || row.origin === 'promise') && row.boundId),
  );
  if (relevant.length === 0) return new Map();
  const { taskBindings } = await import('../../wms/calc/task-gate');
  return taskBindings(relevant);
}

/**
 * The bound pre-check every task door asks BEFORE its UPDATE — and it fails
 * CLOSED (docs/VED-TARIX.md §13): a gate that threw is not a gate that said
 * «not bound», so the door refuses in words instead of closing a calc job
 * with no price because the database blinked.
 */
async function bindingOrRefuse(task: TaskBindingInput): Promise<TaskBinding | null> {
  try {
    return (await bindingsOf([task])).get(task.id) ?? null;
  } catch (err) {
    logger.error({ err, taskId: task.id }, '[tasks] bound pre-check failed — refusing');
    throw new TaskError('bound_check_failed');
  }
}

/** Refused: an OPEN calc job ends on its own screen, never through a task door. */
async function refuseOpenCalc(task: TaskBindingInput): Promise<TaskBinding | null> {
  const binding = await bindingOrRefuse(task);
  if (binding?.kind === 'calc' && binding.open) throw new TaskError('calc_use_screen');
  return binding;
}

/**
 * Refused: the DATE belongs to another record while that record stands — a
 * calc job's SLA (`calc_requests.due_at` is what the overdue sweep reads:
 * «the two clocks cannot drift», round 28) or a client's payment promise
 * (its date IS what he promised; the sweep judges the promise by it).
 */
async function refuseBoundClock(task: TaskBindingInput): Promise<TaskBinding | null> {
  const binding = await refuseOpenCalc(task);
  if (binding?.kind === 'promise' && binding.open) throw new TaskError('bound_clock');
  return binding;
}

/**
 * The task-button payload contract (review telegram-mechanics-21).
 *
 * `buttonsFor` is pure and sees only (type, payload), so everything it
 * decides by travels in the payload: which buttons the ORIGIN draws (spec
 * §2), whether the task carries an open job's clock (`bound` — a calc task
 * then gets only its link), whether 👀 was already pressed, and whether ⏰
 * would move a whole series (`repeats`, the one field beyond the review's
 * four: `buttonsFor` cannot read `repeat_unit` either). A payload with no
 * origin (queued before this round) reads as a hand task, and every press
 * re-checks on the server anyway.
 */
export interface TaskButtonPayload {
  taskId: string;
  origin: TaskOrigin | null;
  bound: boolean;
  accepted: boolean;
  repeats: boolean;
}

export function taskButtonPayload(
  task: {
    id: string;
    origin: string | null;
    boundId: string | null;
    acceptedAt: Date | null;
    repeatUnit: string | null;
  },
  binding: TaskBinding | null = null,
): TaskButtonPayload {
  // A pointed pre-0124 row reads as its pointer's kind (data-migration-3).
  const origin = ((task.origin as TaskOrigin | null) ?? binding?.kind ?? null) as TaskOrigin | null;
  return {
    taskId: task.id,
    origin,
    // What the writer KNOWS: a fresh calc task's request is open; a calc
    // task that reaches a reassign is unbound or its request closed (an open
    // one is refused there), and that one keeps the ordinary ✅.
    bound: binding ? binding.kind === 'calc' && binding.open : origin === 'calc' && Boolean(task.boundId),
    accepted: task.acceptedAt !== null,
    repeats: task.repeatUnit !== null,
  };
}

/**
 * Where a task's message links. A calc job's task links to its OWN screen
 * (`/hisoblash/<request>`): the lead card the old link named sends a VED
 * without `crm.leads` home (VED-TARIX §8), and the drain lifts this line into
 * the message's one URL button (telegram-mechanics-8).
 */
export function taskLinkFor(task: {
  origin: string | null;
  boundId: string | null;
  entityType: string | null;
  entityId: string | null;
}): string {
  if (task.origin === 'calc' && task.boundId) return calcLink(task.boundId);
  return taskLink(task.entityType, task.entityId);
}

/**
 * The note under a fresh assignment — the words the person was given the
 * task WITH (his 3a), for a hand task only: a hand-back's reason is already
 * the message `CalcReturned` printed, and the machine's tasks have none worth
 * repeating. Capped, because four buttons under a 4 000-character wall read
 * badly and `closeTaskMessage` rebuilds the whole text on every close.
 */
export const ASSIGNED_NOTE_CAP = 600;
export const NOTE_MORE = '… saytda';

export function assignedNoteLine(note: string | null | undefined, origin: string | null): string {
  if (origin !== null && origin !== 'hand') return '';
  const text = (note ?? '').trim();
  if (!text) return '';
  return `\n📝 ${cutOnWord(text, ASSIGNED_NOTE_CAP, NOTE_MORE)}`;
}

/**
 * Cut on a word, never through one nor through half an emoji (code points,
 * not UTF-16 units), and say so. The staff bot's title rule (≤ 120) asks it
 * with no mark.
 */
export function cutOnWord(text: string, max: number, mark = ''): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  let cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  // A word longer than half the room is cut where it stands.
  if (space > cut.length / 2) cut = cut.slice(0, space);
  return mark ? `${cut.trimEnd()} ${mark}` : cut.trimEnd();
}

/**
 * Does the AUTHOR hear the assignee's presses? Not when the author is a
 * rule's (review telegram-mechanics-20): `created_by` on an automation task
 * is whoever WROTE the rule, maybe months ago, who never gave this task and
 * knows nothing about it — every 👀 and ⏰ would be noise in an admin's chat.
 */
export function authorHearsPresses(origin: string | null): boolean {
  return origin !== 'automation';
}

/**
 * Turn what a form typed into a moment, and say whether it named a time.
 *
 * A date alone means the whole day, which matters twice: the calendar must not
 * print "09:00" for a deadline nobody set, and "is it due today" has to compare
 * days rather than instants or every all-day task looks overdue from midnight.
 */
export function parseDue(
  raw: string | undefined | null,
  tzOffsetMin?: number | null,
): { dueAt: Date | null; allDay: boolean } {
  const value = (raw ?? '').trim();
  if (!value) return { dueAt: null, allDay: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // End of that day: a task due "Friday" is not late at 00:01 on Friday.
    return { dueAt: new Date(`${value}T23:59:59.999Z`), allDay: true };
  }
  // The browser's naive wall clock plus whose wall it was: 14:00 typed in
  // Tashkent (offset −300) is 09:00 UTC. Without the offset the string is
  // parsed in the SERVER's zone, which made every timed deadline five hours
  // late the moment the server and the typist stopped sharing a clock.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && tzOffsetMin != null) {
    const naive = Date.parse(`${value}:00.000Z`);
    if (Number.isNaN(naive)) throw new TaskError('bad_due_date');
    return { dueAt: new Date(naive + tzOffsetMin * 60_000), allDay: false };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TaskError('bad_due_date');
  return { dueAt: parsed, allDay: false };
}

/**
 * A deadline as a Telegram line: the date alone for an all-day task, and the
 * company's home clock (Asia/Tashkent) when an hour was named — a message has
 * no way to ask its reader where they sit, and the staff who live on these
 * messages do sit there.
 */
export function formatDue(dueAt: Date, allDay: boolean): string {
  if (allDay) return dueAt.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(dueAt);
}

/**
 * A deadline as a TELEGRAM line (round C) — «25.09» for a day, «25.09 14:00»
 * for a moment — the dock keeps `formatDue` above, unchanged.
 *
 * Two clocks on purpose, the same two the task itself has:
 *  - an all-day task is stored as that day's 23:59:59.999 UTC (`parseDue`),
 *    so its date is the UTC date part, read and never shifted — shifted to
 *    Tashkent it would print TOMORROW for every all-day task;
 *  - a timed task is a moment somebody typed on a Tashkent wall clock, so it
 *    prints on that clock — its UTC date is the PREVIOUS day for anything due
 *    before 05:00, which is the defect this replaced («25.09 02:00» shown as
 *    the 24th).
 * The year is added only when it is not this one: «01.01» about a deadline
 * fifteen months out is a different date.
 */
export function telegramDue(dueAt: Date, allDay: boolean, now: Date = new Date()): string {
  const TASHKENT_MS = 5 * 3_600_000; // UTC+5, no daylight saving
  const at = allDay ? dueAt : new Date(dueAt.getTime() + TASHKENT_MS);
  const today = new Date(now.getTime() + TASHKENT_MS);
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${two(at.getUTCDate())}.${two(at.getUTCMonth() + 1)}`;
  const year = at.getUTCFullYear() !== today.getUTCFullYear() ? `.${at.getUTCFullYear()}` : '';
  const time = allDay ? '' : ` ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
  return `${day}${year}${time}`;
}

/**
 * When the next occurrence of a repeating task falls.
 *
 * Counted from the DUE date, never from "now": a Monday task finished on
 * Saturday must land on the following Monday, not the Saturday after. If the
 * task was finished LATE the due date is already behind us, so the step is
 * repeated until it lands in the future — otherwise closing a month of missed
 * Mondays would create another missed Monday.
 *
 * Month steps clamp: the 31st plus one month is the last day of a 30-day
 * month, not the 1st of the month after. JavaScript's own overflow would turn
 * "the 31st of every month" into a task that skips February entirely.
 */
export function nextOccurrence(
  dueAt: Date,
  unit: RepeatUnit,
  every: number,
  now: Date,
): Date {
  let next = new Date(dueAt);
  let guard = 0;
  do {
    if (unit === 'day') next = addDays(next, every);
    else if (unit === 'week') next = addDays(next, every * 7);
    else next = addMonths(next, every);
    guard += 1;
  } while (next <= now && guard < 1000);
  return next;
}

function addDays(from: Date, days: number): Date {
  const value = new Date(from);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function addMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const value = new Date(from);
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
  ).getUTCDate();
  value.setUTCDate(Math.min(day, lastDay));
  return value;
}

export interface TaskRow {
  id: string;
  title: string;
  note: string | null;
  typeId: string | null;
  typeName: string | null;
  typeIcon: string | null;
  assigneeId: string;
  assigneeName: string | null;
  createdBy: string;
  authorName: string | null;
  dueAt: Date | null;
  allDay: boolean;
  status: string;
  doneAt: Date | null;
  result: string | null;
  entityType: string | null;
  entityId: string | null;
  priority: number;
  repeatUnit: string | null;
  repeatEvery: number;
  seriesId: string | null;
  /** 0124 — see `TaskOrigin`; NULL = made before it. */
  origin: string | null;
  boundId: string | null;
  acceptedAt: Date | null;
  remindedAt: Date | null;
  createdAt: Date;
}

const assignee = users;

function selection() {
  return {
    id: tasks.id,
    title: tasks.title,
    note: tasks.note,
    typeId: tasks.typeId,
    typeName: taskTypes.name,
    typeIcon: taskTypes.icon,
    assigneeId: tasks.assigneeId,
    assigneeName: assignee.fullName,
    createdBy: tasks.createdBy,
    authorName: sql<string | null>`(SELECT full_name FROM users WHERE id = ${tasks.createdBy})`,
    dueAt: tasks.dueAt,
    allDay: tasks.allDay,
    status: tasks.status,
    doneAt: tasks.doneAt,
    result: tasks.result,
    entityType: tasks.entityType,
    entityId: tasks.entityId,
    priority: tasks.priority,
    repeatUnit: tasks.repeatUnit,
    repeatEvery: tasks.repeatEvery,
    seriesId: tasks.seriesId,
    origin: tasks.origin,
    boundId: tasks.boundId,
    acceptedAt: tasks.acceptedAt,
    remindedAt: tasks.remindedAt,
    createdAt: tasks.createdAt,
  };
}

function base() {
  return db
    .select(selection())
    .from(tasks)
    .leftJoin(taskTypes, eq(tasks.typeId, taskTypes.id))
    .leftJoin(assignee, eq(tasks.assigneeId, assignee.id));
}

export async function createTask(
  input: TaskInput,
  ctx: AuditContext,
  making: TaskMaking,
): Promise<TaskRow> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  // The database says so too (tasks_bound_check); a caller deserves a code.
  if (making.boundId && making.origin !== 'calc' && making.origin !== 'promise') {
    throw new TaskError('bad_bound');
  }
  // Registry object or an owner-invented one — one resolver (#186).
  if (input.entityType && !(await resolveEntity(input.entityType))) {
    throw new TaskError('unknown_entity');
  }
  // A pointer is whole or absent; the database says so too, but a caller
  // deserves a coded error rather than a constraint violation.
  if (Boolean(input.entityType) !== Boolean(input.entityId)) throw new TaskError('half_pointer');

  const person = await db.query.users.findFirst({ where: eq(users.id, input.assigneeId) });
  if (!person) throw new TaskError('no_assignee');
  // Giving work to someone who has left is how a task disappears: nobody sees
  // it on a screen they no longer open — and a person who never signs in
  // (0120) has no screen to open at all.
  if (!canLogIn(person)) throw new TaskError(person.active ? 'assignee_no_login' : 'assignee_inactive');

  const { dueAt, allDay } = parseDue(input.dueAt, input.tzOffsetMin);
  // "Every week" starting when? A rule needs something to repeat from.
  if (input.repeatUnit && !dueAt) throw new TaskError('repeat_needs_due');
  const sources = (making.sourceMessages ?? []).slice(0, MAX_TASK_SOURCES);

  const [row] = await db
    .insert(tasks)
    .values({
      title: input.title,
      note: input.note || null,
      typeId: input.typeId,
      assigneeId: input.assigneeId,
      createdBy: ctx.actorId,
      dueAt,
      allDay,
      priority: input.priority,
      entityType: input.entityType,
      entityId: input.entityId,
      repeatUnit: input.repeatUnit,
      repeatEvery: input.repeatEvery,
      seriesId: input.repeatUnit ? uuidv7() : null,
      origin: making.origin,
      boundId: making.boundId ?? null,
      sourceMessages: sources.length > 0 ? sources : null,
    })
    .returning();
  if (!row) throw new TaskError('not_created');

  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: row.id,
    action: 'create',
    after: {
      title: input.title,
      assigneeId: input.assigneeId,
      dueAt: dueAt?.toISOString() ?? null,
      about: input.entityType ? `${input.entityType}:${input.entityId}` : null,
      origin: making.origin,
      ...(making.via ? { via: making.via } : {}),
    },
  });

  // Straight to the assignee's Telegram, with the link (owner: "tasklarni
  // telegramdan jo'natadigan qil, task linklari bilan"). The morning digest
  // still runs; this is the difference between "you will find out tomorrow at
  // eight" and "you know now" — which for a warehouse task is the difference
  // between today's truck and the next one. Never to yourself: a task you
  // just typed is not news.
  if (input.assigneeId !== ctx.actorId) {
    const created = (await byId(row.id))!;
    await notifyAssigned(created, ctx.actorId, {
      headline: '🆕 Yangi vazifa',
      forwards: sources,
    });
    return created;
  }
  return (await byId(row.id))!;
}

/**
 * The assignee's «you have work» message — ONE builder for a fresh task and
 * a handed-on one, so the two cannot disagree about the buttons, the note or
 * the link (round C found the handed-on one shipped with no button at all).
 *
 * `forwards` are the author's own messages, forwarded BEFORE this text by the
 * drain (`payload.forwards`, one `forwardMessages` call). Never awaited into a
 * failure: the task is written, and the morning digest still carries it.
 */
async function notifyAssigned(
  task: TaskRow,
  fromUserId: string,
  opts: { headline: string; forwards?: SourceMessage[]; binding?: TaskBinding | null },
): Promise<void> {
  const label = task.entityType
    ? ((await aboutLabels([task])).get(`${task.entityType}:${task.entityId}`) ?? null)
    : null;
  await notifyStaffTelegram({
    userIds: [task.assigneeId],
    type: 'TaskAssigned',
    text:
      `${opts.headline}: ${task.title}` +
      (task.dueAt ? `\n📅 ${telegramDue(task.dueAt, task.allDay)}` : '') +
      (label ? `\n📌 ${label}` : '') +
      assignedNoteLine(task.note, task.origin) +
      `\n👤 ${await userName(fromUserId)}` +
      `\n🔗 ${taskLinkFor(task)}`,
    // The contract the send worker draws the buttons from (staff bot).
    extra: {
      ...taskButtonPayload(task, opts.binding ?? null),
      ...(opts.forwards && opts.forwards.length > 0 ? { forwards: opts.forwards } : {}),
    },
  }).catch(() => {});
}

export async function byId(id: string): Promise<TaskRow | null> {
  const [row] = await base().where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}

/**
 * Where a door was pressed from, when it was the bot: the message the press
 * edits itself, which the after-commit retire must leave alone or the two
 * edits race over one message.
 */
export interface DoorOpts {
  pressed?: { chatId: number; messageId: number } | null;
}

/** Close a task with what actually happened. */
export async function completeTask(
  id: string,
  result: string,
  ctx: TaskContext,
  opts: DoorOpts = {},
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (!canActOnTask(before, ctx.actor)) throw new TaskError('not_yours');
  if (before.status !== 'open') throw new TaskError('already_closed');
  // BEFORE the UPDATE (VED-TARIX §8): every task door used to close an open
  // calc job with no price — the web ✅, the dock, the card's panel and the
  // Telegram ✅ — and after a takeover the PREVIOUS holder's old button closed
  // the colleague's job in the previous holder's name.
  await refuseOpenCalc(before);

  const now = new Date();
  // A compare-and-set, not check-then-write: «✅ Natijasiz» is ONE tap, which
  // removed the natural debounce the typed result was, and two presses (or a
  // press and the web ✅) must close the task once and tell the author once.
  const closed = await db
    .update(tasks)
    .set({
      status: 'done',
      doneAt: now,
      doneBy: ctx.actorId,
      result: result.trim() || null,
      updatedAt: now,
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'open')))
    .returning({ id: tasks.id });
  if (closed.length === 0) throw new TaskError('already_closed');
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'status_change',
    before: { status: before.status },
    after: { status: 'done', result: result.trim() || null },
  });
  retireTaskCopiesSoon({
    taskIds: [id],
    outcome: 'done',
    since: before.createdAt,
    exceptMessages: opts.pressed ? [opts.pressed] : [],
  });

  // A hisoblash task closed by hand is the other end of the calc clock: the
  // lead has no lines to save, so this is the only end it has. Dynamic import
  // across platform → wms, fenced — a calc module that throws must not stop a
  // person closing their own task.
  try {
    const { completeCalcForTask } = await import('../../wms/calc/service');
    await completeCalcForTask(id, ctx.actorId);
  } catch (err) {
    logger.error({ err, taskId: id }, '[calc] clock stop on task close failed');
  }

  // The person who ASKED finds out it is done — with what was done, because
  // "bajarildi" with no result is a message that starts a phone call.
  if (before.createdBy && before.createdBy !== ctx.actorId) {
    await notifyStaffTelegram({
      userIds: [before.createdBy],
      type: 'TaskDone',
      text:
        `✅ Bajarildi: ${before.title}` +
        (result.trim() ? `\n${result.trim().slice(0, 300)}` : '') +
        `\n👤 ${await userName(ctx.actorId)}` +
        `\n🔗 ${taskLinkFor(before)}`,
    }).catch(() => {});
  }

  // Finishing one occurrence is what schedules the next. Nothing materialises
  // a queue ahead of time, so a series can never pile up unfinished copies.
  if (before.repeatUnit && before.dueAt) {
    const next = nextOccurrence(
      before.dueAt,
      before.repeatUnit as RepeatUnit,
      before.repeatEvery,
      now,
    );
    const [spawned] = await db
      .insert(tasks)
      .values({
        title: before.title,
        note: before.note,
        typeId: before.typeId,
        assigneeId: before.assigneeId,
        createdBy: before.createdBy,
        dueAt: next,
        allDay: before.allDay,
        priority: before.priority,
        entityType: before.entityType,
        entityId: before.entityId,
        repeatUnit: before.repeatUnit,
        repeatEvery: before.repeatEvery,
        seriesId: before.seriesId ?? id,
        // The next occurrence is the same kind of work as the last one.
        origin: before.origin,
        boundId: before.boundId,
      })
      .returning();
    if (spawned) {
      await writeAudit(db, ctx, {
        entityType: 'task',
        entityId: spawned.id,
        action: 'create',
        after: { repeatOf: id, dueAt: next.toISOString() },
      });
    }
  }
}

/**
 * Cancel rather than delete.
 *
 * A task somebody was given and then told to drop is a fact about how the work
 * went; deleting it removes the evidence that it was ever asked for.
 *
 * Cancelling is also how a REPEATING task is stopped: completing carries the
 * series on, cancelling ends it. That needs no extra button and the meaning
 * matches the words — "I am not doing this one" versus "we are done with this".
 */
export async function cancelTask(
  id: string,
  reason: string,
  ctx: TaskContext,
  opts: DoorOpts = {},
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (!canActOnTask(before, ctx.actor)) throw new TaskError('not_yours');
  if (before.status !== 'open') throw new TaskError('already_closed');
  const cancelled = await db
    .update(tasks)
    .set({ status: 'cancelled', result: reason.trim() || null, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'open')))
    .returning({ id: tasks.id });
  if (cancelled.length === 0) throw new TaskError('already_closed');
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'status_change',
    before: { status: 'open' },
    after: { status: 'cancelled', reason: reason.trim() || null },
  });
  retireTaskCopiesSoon({
    taskIds: [id],
    outcome: 'cancelled',
    since: before.createdAt,
    exceptMessages: opts.pressed ? [opts.pressed] : [],
  });

  // Cancelling the task does not cancel the WORK: the calculation goes back
  // to the queue rather than sitting assigned to somebody with no task, where
  // no other VED person would ever pick it up.
  try {
    const { releaseCalcForTask } = await import('../../wms/calc/service');
    await releaseCalcForTask(id, ctx.actorId);
  } catch (err) {
    logger.error({ err, taskId: id }, '[calc] release on task cancel failed');
  }

  // The assignee is told the work went away (spec §4) — the most common case
  // is the author's own «🗑 Bekor qilish» on a typo seconds after creating it,
  // and the copy those seconds delivered must not stay a live job.
  if (before.assigneeId !== ctx.actorId) {
    await notifyStaffTelegram({
      userIds: [before.assigneeId],
      type: 'TaskCancelled',
      text:
        `🗑 Vazifa bekor qilindi: ${before.title}` +
        (reason.trim() ? `\n${reason.trim().slice(0, 300)}` : '') +
        `\n👤 ${await userName(ctx.actorId)}` +
        `\n🔗 ${taskLinkFor(before)}`,
    }).catch(() => {});
  }
}

/** Hand a task to somebody else — the everyday move in a small company. */
export async function reassignTask(
  id: string,
  assigneeId: string,
  ctx: TaskContext,
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (!canActOnTask(before, ctx.actor)) throw new TaskError('not_yours');
  if (before.status !== 'open') throw new TaskError('already_closed');
  // An open calc job is HELD through the queue («Olaman» / «Bo'shatish»):
  // this door moved `tasks.assignee_id` and nothing else, so the queue went
  // on naming the old VED while the new one's day showed the job (#531's
  // shape, review telegram-mechanics-12).
  const binding = await refuseOpenCalc(before);
  const person = await db.query.users.findFirst({ where: eq(users.id, assigneeId) });
  if (!person) throw new TaskError('assignee_inactive');
  if (!canLogIn(person)) throw new TaskError(person.active ? 'assignee_no_login' : 'assignee_inactive');

  const at = new Date();
  // `accepted_at` and `reminded_at` describe the CURRENT assignee: the new
  // one has not pressed 👀, and the old one's half-hour must not shut the
  // author's first «🔔» to the new one (data-migration-8).
  const moved = await db
    .update(tasks)
    .set({ assigneeId, acceptedAt: null, remindedAt: null, updatedAt: at })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'open')))
    .returning({ id: tasks.id });
  if (moved.length === 0) throw new TaskError('already_closed');
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'update',
    before: { assigneeId: before.assigneeId },
    after: { assigneeId },
  });
  // The previous holder's copies say where the task went — but not the NEW
  // holder's, and not anything queued from here on (A→B→A must not stamp A's
  // fresh copy «given to someone else»).
  retireTaskCopiesSoon({
    taskIds: [id],
    outcome: 'reassigned',
    since: before.createdAt,
    until: at,
    exceptUserIds: [assigneeId],
  });

  const sources = sourcesOf(before.sourceMessages);
  const byAuthor = ctx.actorId === before.createdBy;
  // Handed to somebody new: they find out the same way a fresh assignment
  // lands, not tomorrow morning — with the author's own messages ONLY when
  // the AUTHOR handed it on (access-money-12): `canActOnTask` admits every
  // viewer, accountant, VED and logist, and none of them may make the bot
  // push the author's voice notes and forwarded customer chats to anybody.
  if (assigneeId !== ctx.actorId) {
    const after = (await byId(id))!;
    await notifyAssigned(after, ctx.actorId, {
      headline: '🆕 Sizga vazifa o‘tkazildi',
      forwards: byAuthor ? sources : [],
      binding,
    });
  }
  // …and the author learns who has it now (spec §4) — offered the sources
  // as one button when somebody else moved it, so forwarding them stays the
  // author's own act.
  if (!byAuthor && authorHearsPresses(before.origin) && before.createdBy !== assigneeId) {
    const offer = sources.length > 0;
    await notifyStaffTelegram({
      userIds: [before.createdBy],
      type: 'TaskReassigned',
      text:
        `👤 Siz bergan vazifa boshqaga o‘tdi: ${before.title}` +
        `\n${await userName(before.assigneeId)} → ${person.fullName}` +
        `\n👤 ${await userName(ctx.actorId)}` +
        (offer ? '\n📎 Xabarlaringiz yangi odamga yuborilmadi.' : '') +
        `\n🔗 ${taskLinkFor(before)}`,
      extra: { taskId: id, offerSources: offer },
    }).catch(() => {});
  }
}

/** The stored source pointers, read defensively — jsonb has no type. */
export function sourcesOf(value: unknown): SourceMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (s): s is SourceMessage =>
        typeof s === 'object' &&
        s !== null &&
        Number.isFinite(Number((s as SourceMessage).chatId)) &&
        Number.isInteger(Number((s as SourceMessage).messageId)),
    )
    .map((s) => ({ chatId: Number(s.chatId), messageId: Number(s.messageId) }))
    .slice(0, MAX_TASK_SOURCES);
}

/**
 * «📤 Manbani yangi odamga yuborish» — the author's own press under a
 * `TaskReassigned` (access-money-12): their messages go to whoever holds the
 * task NOW, and only because they asked.
 */
export async function forwardSourcesAgain(id: string, ctx: TaskContext): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const task = await byId(id);
  if (!task) throw new TaskError('not_found');
  if (task.createdBy !== ctx.actorId) throw new TaskError('not_author');
  if (task.status !== 'open') throw new TaskError('already_closed');
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, id), columns: { sourceMessages: true } });
  const sources = sourcesOf(row?.sourceMessages);
  if (sources.length === 0 || task.assigneeId === ctx.actorId) return;
  await notifyAssigned(task, ctx.actorId, { headline: '📎 Topshiriq manbalari', forwards: sources });
}

export async function updateTask(
  id: string,
  input: Pick<TaskInput, 'title' | 'note' | 'typeId' | 'dueAt' | 'priority' | 'tzOffsetMin'>,
  ctx: TaskContext,
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (!canActOnTask(before, ctx.actor)) throw new TaskError('not_yours');
  if (before.status !== 'open') throw new TaskError('already_closed');
  const { dueAt, allDay } = parseDue(input.dueAt, input.tzOffsetMin);
  // The ✏️ form is the OTHER writer of `due_at` (data-migration-9): a title
  // fix on a bound task is fine, its date is another record's clock.
  const dueMoved = (dueAt?.getTime() ?? null) !== (before.dueAt?.getTime() ?? null) || allDay !== before.allDay;
  if (dueMoved) await refuseBoundClock(before);
  const changed = await db
    .update(tasks)
    .set({
      title: input.title,
      note: input.note || null,
      typeId: input.typeId,
      dueAt,
      allDay,
      priority: input.priority,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'open')))
    .returning({ id: tasks.id });
  if (changed.length === 0) throw new TaskError('already_closed');
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'update',
    before: { title: before.title, dueAt: before.dueAt?.toISOString() ?? null },
    after: { title: input.title, dueAt: dueAt?.toISOString() ?? null },
  });
}

/**
 * «👀 Qabul qildim» — the assignee says they have seen it (his 4a).
 *
 * A compare-and-set that names the PRESSER: a previous assignee's copy that
 * was never retired (an edit Telegram refused, a copy still in the queue)
 * must not accept on the new owner's behalf and tell the author the wrong
 * name (telegram-mechanics-16).
 */
export async function acceptTask(id: string, ctx: TaskContext): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (before.status !== 'open') throw new TaskError('already_closed');
  if (before.assigneeId !== ctx.actorId) throw new TaskError('not_assignee');
  // 👀 duplicates «Olaman» on a calc job; an old button is refused in words.
  await refuseOpenCalc(before);
  const at = new Date();
  const won = await db
    .update(tasks)
    .set({ acceptedAt: at, updatedAt: at })
    .where(
      and(
        eq(tasks.id, id),
        isNull(tasks.acceptedAt),
        eq(tasks.status, 'open'),
        eq(tasks.assigneeId, ctx.actorId),
      ),
    )
    .returning({ id: tasks.id });
  if (won.length === 0) {
    const now = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!now || now.status !== 'open') throw new TaskError('already_closed');
    if (now.assigneeId !== ctx.actorId) throw new TaskError('not_assignee');
    throw new TaskError('already_accepted');
  }
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'update',
    after: { acceptedAt: at.toISOString() },
  });
  if (before.createdBy !== ctx.actorId && authorHearsPresses(before.origin)) {
    await notifyStaffTelegram({
      userIds: [before.createdBy],
      type: 'TaskAccepted',
      text: `👀 Qabul qilindi: ${before.title}\n👤 ${await userName(ctx.actorId)}\n🔗 ${taskLinkFor(before)}`,
      extra: { taskId: id },
    }).catch(() => {});
  }
}

/**
 * «⏰ Muddatni surish» — a NARROW writer: the date and nothing else, never
 * `updateTask`'s full replace (a press must not rewrite the title the author
 * typed). Refused on a repeating task — the next occurrence is computed from
 * the CURRENT due, so «Ertaga» on a weekly Monday report would make every
 * later one a Tuesday; the web ✏️ form moves a series, stated
 * (telegram-mechanics-15) — and on a task whose date is another record's.
 */
export async function rescheduleTask(
  id: string,
  due: { dueAt: Date; allDay: boolean },
  ctx: TaskContext,
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (!canActOnTask(before, ctx.actor)) throw new TaskError('not_yours');
  if (before.status !== 'open') throw new TaskError('already_closed');
  if (before.repeatUnit) throw new TaskError('repeat_series');
  await refuseBoundClock(before);
  const moved = await db
    .update(tasks)
    .set({ dueAt: due.dueAt, allDay: due.allDay, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'open')))
    .returning({ id: tasks.id });
  if (moved.length === 0) throw new TaskError('already_closed');
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'update',
    before: { dueAt: before.dueAt?.toISOString() ?? null },
    after: { dueAt: due.dueAt.toISOString(), via: 'telegram' },
  });
  if (before.createdBy !== ctx.actorId && authorHearsPresses(before.origin)) {
    await notifyStaffTelegram({
      userIds: [before.createdBy],
      type: 'TaskRescheduled',
      text:
        `⏰ Muddat surildi: ${before.title}` +
        `\n📅 ${before.dueAt ? telegramDue(before.dueAt, before.allDay) : '—'} → ${telegramDue(due.dueAt, due.allDay)}` +
        `\n👤 ${await userName(ctx.actorId)}` +
        `\n🔗 ${taskLinkFor(before)}`,
      extra: { taskId: id },
    }).catch(() => {});
  }
}

/** At most one «🔔» per task per this long (his 5a's own sentence). */
export const REMIND_GAP_MS = 30 * 60_000;

/**
 * The tasks a person GAVE by hand and still waits on — «📤 Men bergan».
 *
 * The listing and the 🔔 door ask ONE predicate, so a reminder can be sent
 * exactly about what the list shows: open, given to SOMEBODY ELSE, and made
 * by a person — `hand`, or a NULL origin that no calc request and no payment
 * promise points at (a pointed pre-0124 row is its pointer's kind,
 * data-migration-3). Pre-0124 RULE tasks also read NULL and are listed until
 * they close — stated to him, not guessed away (data-migration-4).
 */
function givenByHandSql(authorId: string): SQL {
  return sql`t.status = 'open' AND t.created_by = ${authorId} AND t.assignee_id <> ${authorId}
    AND (t.origin = 'hand' OR (t.origin IS NULL
      AND NOT EXISTS (SELECT 1 FROM calc_requests r WHERE r.task_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM payment_promises p WHERE p.task_id = t.id)))`;
}

export interface GivenTask {
  id: string;
  title: string;
  assigneeName: string | null;
  dueAt: Date | null;
  allDay: boolean;
  accepted: boolean;
}

export const GIVEN_SHOWN = 20;

export async function givenTasks(authorId: string): Promise<{ rows: GivenTask[]; total: number }> {
  const rows = (await db.execute(sql`
    SELECT t.id, t.title, u.full_name AS assignee_name, t.due_at, t.all_day,
           t.accepted_at IS NOT NULL AS accepted, count(*) OVER () AS total
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assignee_id
     WHERE ${givenByHandSql(authorId)}
     ORDER BY t.created_at DESC
     LIMIT ${GIVEN_SHOWN}`)) as unknown as {
    id: string;
    title: string;
    assignee_name: string | null;
    due_at: Date | string | null;
    all_day: boolean;
    accepted: boolean;
    total: string | number;
  }[];
  return {
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map((row) => ({
      id: row.id,
      title: row.title,
      assigneeName: row.assignee_name,
      // Raw `db.execute` timestamps arrive as TEXT (#923's lesson).
      dueAt: row.due_at === null ? null : new Date(row.due_at),
      allDay: row.all_day,
      accepted: row.accepted,
    })),
  };
}

/**
 * «🔔 Eslatish» — the author nudges the assignee, at most once per half hour
 * per task. The CAS IS the throttle: two taps in one second, or two phones,
 * send one reminder.
 */
export async function remindTask(id: string, ctx: TaskContext): Promise<{ reach: Reach; name: string | null }> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (before.createdBy !== ctx.actorId) throw new TaskError('not_author');
  if (before.status !== 'open') throw new TaskError('already_closed');
  const since = new Date(Date.now() - REMIND_GAP_MS).toISOString();
  const won = (await db.execute(sql`
    UPDATE tasks t SET reminded_at = now()
     WHERE t.id = ${id} AND ${givenByHandSql(ctx.actorId)}
       AND (t.reminded_at IS NULL OR t.reminded_at < ${since}::timestamptz)
    RETURNING t.id`)) as unknown as { id: string }[];
  if (won.length === 0) {
    const listed = (await db.execute(sql`SELECT 1 FROM tasks t WHERE t.id = ${id} AND ${givenByHandSql(ctx.actorId)}`)) as unknown as unknown[];
    throw new TaskError(listed.length > 0 ? 'remind_too_soon' : 'not_remindable');
  }
  const task = (await byId(id))!;
  await notifyStaffTelegram({
    userIds: [task.assigneeId],
    type: 'TaskReminder',
    text:
      `🔔 Eslatma: ${task.title}` +
      (task.dueAt ? `\n📅 ${telegramDue(task.dueAt, task.allDay)}` : '') +
      `\n👤 ${await userName(ctx.actorId)}` +
      `\n🔗 ${taskLinkFor(task)}`,
    extra: { ...taskButtonPayload(task) },
  });
  return {
    reach: (await reachOf([task.assigneeId], 'TaskReminder')).get(task.assigneeId) ?? 'no_chat',
    name: task.assigneeName,
  };
}

/** A question or an answer is at most this long — a message, not a document. */
export const COMMENT_MAX = 1000;

/**
 * «💬 Savol» — the assignee asks the author, through the bot (his 4a). An
 * audit row on the task (action `comment`), so the conversation is on the
 * task's own history and not only in two phones; the author's copy carries
 * «💬 Javob berish».
 *
 * Not on an automation task (the author wrote a rule, not this task) and not
 * on a job whose author is the presser.
 */
export async function askAboutTask(
  id: string,
  text: string,
  ctx: TaskContext,
): Promise<{ reach: Reach; name: string | null }> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const body = text.trim().slice(0, COMMENT_MAX);
  if (!body) throw new TaskError('empty_text');
  const task = await byId(id);
  if (!task) throw new TaskError('not_found');
  if (task.status !== 'open') throw new TaskError('already_closed');
  if (task.assigneeId !== ctx.actorId) throw new TaskError('not_assignee');
  if (!authorHearsPresses(task.origin) || task.createdBy === ctx.actorId) throw new TaskError('not_askable');
  await refuseOpenCalc(task);
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'comment',
    after: { kind: 'question', text: body, via: 'telegram' },
  });
  await notifyStaffTelegram({
    userIds: [task.createdBy],
    type: 'TaskQuestion',
    text: `❓ Savol: ${task.title}\n${body}\n👤 ${await userName(ctx.actorId)}\n🔗 ${taskLinkFor(task)}`,
    extra: { taskId: id },
  });
  return {
    reach: (await reachOf([task.createdBy], 'TaskQuestion')).get(task.createdBy) ?? 'no_chat',
    name: task.authorName,
  };
}

/**
 * «💬 Javob berish» — the author's answer, back to the assignee with the
 * task's own buttons again. Re-checked OPEN at the moment it is written
 * (telegram-mechanics-6): a closed task's «Javob berish» must not send a
 * message carrying live buttons for work that is over.
 */
export async function answerAboutTask(
  id: string,
  text: string,
  ctx: TaskContext,
): Promise<{ reach: Reach; name: string | null }> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const body = text.trim().slice(0, COMMENT_MAX);
  if (!body) throw new TaskError('empty_text');
  const task = await byId(id);
  if (!task) throw new TaskError('not_found');
  if (task.status !== 'open') throw new TaskError('already_closed');
  if (task.createdBy !== ctx.actorId) throw new TaskError('not_author');
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'comment',
    after: { kind: 'answer', text: body, via: 'telegram' },
  });
  await notifyStaffTelegram({
    userIds: [task.assigneeId],
    type: 'TaskAnswer',
    text: `💬 Javob: ${task.title}\n${body}\n👤 ${await userName(ctx.actorId)}\n🔗 ${taskLinkFor(task)}`,
    extra: { ...taskButtonPayload(task) },
  });
  return {
    reach: (await reachOf([task.assigneeId], 'TaskAnswer')).get(task.assigneeId) ?? 'no_chat',
    name: task.assigneeName,
  };
}

/** Everything outstanding on one record — the panel on a card. */
export async function tasksFor(entityType: string, entityId: string): Promise<TaskRow[]> {
  return base()
    .where(and(eq(tasks.entityType, entityType), eq(tasks.entityId, entityId)))
    .orderBy(
      // Open first, then by deadline, then newest.
      sql`CASE WHEN ${tasks.status} = 'open' THEN 0 ELSE 1 END`,
      sql`${tasks.dueAt} NULLS LAST`,
      desc(tasks.createdAt),
    )
    .limit(200);
}

/**
 * May this person act on somebody else's task?
 *
 * Creating stays open — a company of twenty asks each other for things all
 * day. CLOSING, cancelling, reassigning and rewriting are not open: without
 * this, any employee could finish or hand off any task in the company by its
 * id, and the audit trail would say they did it on purpose.
 *
 * The pair of codes is the one `/kalendar` already uses for "may look at
 * everyone's month", so there is one rule rather than two that drift.
 */
export function canActOnTask(
  task: { assigneeId: string; createdBy: string },
  actor: { id: string; permissions: Set<string> },
): boolean {
  if (task.assigneeId === actor.id || task.createdBy === actor.id) return true;
  return (
    actor.permissions.has('crm.leads.view_all') ||
    actor.permissions.has('reports.all_warehouses')
  );
}

export interface DayFilter {
  /** Whose tasks; omit for everyone (only for people allowed to see that). */
  assigneeId?: string;
  /** Inclusive day boundaries. */
  from?: Date;
  to?: Date;
  status?: 'open' | 'done' | 'cancelled' | 'all';
}

export async function listTasks(filter: DayFilter): Promise<TaskRow[]> {
  const where = [];
  if (filter.assigneeId) where.push(eq(tasks.assigneeId, filter.assigneeId));
  if (filter.status && filter.status !== 'all') where.push(eq(tasks.status, filter.status));
  else if (!filter.status) where.push(eq(tasks.status, 'open'));
  if (filter.from) where.push(gte(tasks.dueAt, filter.from));
  if (filter.to) where.push(lte(tasks.dueAt, filter.to));

  return base()
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${tasks.dueAt} NULLS LAST`, asc(tasks.priority), desc(tasks.createdAt))
    .limit(500);
}

/**
 * What one person has to deal with today: overdue first, then today, then
 * anything with no deadline at all.
 *
 * "Today" is compared against the END of the day, so an all-day task set for
 * today is not reported as late from one minute past midnight.
 *
 * **Each group is capped and counted on its own**, and that is not a detail.
 * One `LIMIT 300` over the three of them is a cap that DECIDES what the
 * screen is about: the rows come back oldest-first, so a person carrying 300
 * old tasks — which is exactly what the owner's calc backlog produced — gets
 * a screen made entirely of last winter, with today's work below the cut and
 * invisible. Round 74 answered the same shape on the funnel with a per-stage
 * rank; here three small queries do it, and each one reports how many there
 * really are so the screen can say when it is showing a slice.
 */
const DAY_CAP = 40;

export interface MyDay {
  overdue: TaskRow[];
  today: TaskRow[];
  undated: TaskRow[];
  /** Real totals, whether or not the cap bit. */
  counts: { overdue: number; today: number; undated: number };
}

export async function myDay(assigneeId: string, endOfToday: Date): Promise<MyDay> {
  const startOfToday = new Date(endOfToday);
  startOfToday.setUTCHours(0, 0, 0, 0);

  const mine = eq(tasks.assigneeId, assigneeId);
  const open = eq(tasks.status, 'open');
  const buckets = {
    // The LATEST overdue first: a task three days late is still live work,
    // while the top of a year-old pile is archaeology.
    overdue: and(mine, open, lt(tasks.dueAt, startOfToday)),
    today: and(mine, open, gte(tasks.dueAt, startOfToday), lte(tasks.dueAt, endOfToday)),
    undated: and(mine, open, isNull(tasks.dueAt)),
  } as const;

  const rowsOf = async (where: SQL | undefined, order: SQL) =>
    base().where(where).orderBy(order, asc(tasks.priority)).limit(DAY_CAP);
  const countOf = async (where: SQL | undefined) =>
    Number(
      (await db.select({ n: sql<number>`count(*)` }).from(tasks).where(where))[0]?.n ?? 0,
    );

  const [overdue, today, undated, nOverdue, nToday, nUndated] = await Promise.all([
    rowsOf(buckets.overdue, sql`${tasks.dueAt} DESC`),
    rowsOf(buckets.today, sql`${tasks.dueAt} ASC`),
    rowsOf(buckets.undated, sql`${tasks.createdAt} DESC`),
    countOf(buckets.overdue),
    countOf(buckets.today),
    countOf(buckets.undated),
  ]);

  return {
    overdue,
    today,
    undated,
    counts: { overdue: nOverdue, today: nToday, undated: nUndated },
  };
}

/** How many open tasks each person is carrying — for the assignment picker. */
export async function openCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ assigneeId: tasks.assigneeId, n: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.status, 'open'))
    .groupBy(tasks.assigneeId);
  return new Map(rows.map((row) => [row.assigneeId, Number(row.n)]));
}

/**
 * Tasks due in a window, for the calendar.
 *
 * The window is widened to WHOLE DAYS. A caller asking for "the 1st to the
 * 31st" means the whole of the 31st, and an all-day task is stored at 23:59 on
 * its day — so comparing against the caller's own clock silently dropped every
 * all-day task on the last day of the month. Found by the test.
 */
export async function calendarTasks(
  from: Date,
  to: Date,
  assigneeId?: string,
): Promise<TaskRow[]> {
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);
  const where = [gte(tasks.dueAt, start), lte(tasks.dueAt, end), ne(tasks.status, 'cancelled')];
  if (assigneeId) where.push(eq(tasks.assigneeId, assigneeId));
  return base()
    .where(and(...where))
    .orderBy(asc(tasks.dueAt), asc(tasks.priority))
    .limit(1000);
}

/**
 * Open tasks that went past their deadline — the nudge the digest sends.
 *
 * Grouped by assignee, because one message listing three tasks beats three
 * messages, and a person who ignores a stream of pings ignores all of them.
 */
export async function overdueByAssignee(now: Date): Promise<Map<string, TaskRow[]>> {
  const rows = await base()
    .where(and(eq(tasks.status, 'open'), lt(tasks.dueAt, now)))
    .orderBy(asc(tasks.dueAt))
    .limit(1000);
  const out = new Map<string, TaskRow[]>();
  for (const row of rows) out.set(row.assigneeId, [...(out.get(row.assigneeId) ?? []), row]);
  return out;
}

export async function listTaskTypes(includeInactive = false) {
  return db
    .select()
    .from(taskTypes)
    .where(includeInactive ? undefined : eq(taskTypes.active, true))
    .orderBy(asc(taskTypes.sortOrder), asc(taskTypes.name));
}

/** Titles for the records tasks point at, so a list can say what it is about. */
export async function aboutLabels(rows: TaskRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byType = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.entityType || !row.entityId) continue;
    byType.set(row.entityType, [...(byType.get(row.entityType) ?? []), row.entityId]);
  }
  for (const [type, ids] of byType) {
    // The owner's own records all live in one table, named by their NAME.
    if (type.startsWith('x_')) {
      const names = await recordNames([...new Set(ids)]);
      for (const [id, name] of names) out.set(`${type}:${id}`, name);
      continue;
    }
    const spec = entitySpec(type)?.lookup;
    if (!spec) continue;
    const found = await db.execute<{ id: string; label: string | null; secondary: string | null }>(
      sql`SELECT id::text AS id,
                 ${sql.identifier(spec.label)}::text AS label,
                 ${spec.secondary ? sql.identifier(spec.secondary) : sql`NULL`}::text AS secondary
          FROM ${sql.identifier(spec.table)}
          WHERE id IN (${sql.join([...new Set(ids)].map((id) => sql`${id}::uuid`), sql`, `)})`,
    );
    for (const row of found) {
      out.set(`${type}:${row.id}`, [row.secondary, row.label].filter(Boolean).join(' · '));
    }
  }
  return out;
}

/**
 * Cancel every open task on a record — for when the record itself goes.
 *
 * Returns WHICH it cancelled. Every caller runs this inside its own
 * transaction, so it cannot retire the tasks' Telegram copies itself — a
 * pool-plus-network call in there is #714's freeze — and the caller retires
 * them after its commit (`retireTaskCopiesSoon`, review telegram-mechanics-7).
 */
export async function cancelTasksFor(
  dbOrTx: Db | Tx,
  entityType: string,
  entityIds: string[],
): Promise<string[]> {
  if (entityIds.length === 0) return [];
  const rows = await dbOrTx
    .update(tasks)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(tasks.entityType, entityType),
        inArray(tasks.entityId, entityIds),
        eq(tasks.status, 'open'),
      ),
    )
    .returning({ id: tasks.id });
  return rows.map((row) => row.id);
}
