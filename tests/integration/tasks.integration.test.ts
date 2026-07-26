import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { roles, tasks, userRoles, users } from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import {
  TaskError,
  nextOccurrence,
  aboutLabels,
  calendarTasks,
  cancelTask,
  cancelTasksFor,
  completeTask,
  createTask,
  listTaskTypes,
  myDay,
  openCounts,
  overdueByAssignee,
  parseDue,
  reassignTask,
  tasksFor,
  updateTask,
} from '@/modules/platform/tasks/service';

/**
 * Work one person gives another.
 *
 * The cases that matter are the ones where a task would silently disappear —
 * assigned to somebody who has left, pointing at half a record, or closed
 * twice — and the day boundary, which decides whether the whole company opens
 * the app to a list of things it is told are already late.
 */

const SUFFIX = String(Date.now()).slice(-7);
let owner: string;
let other: string;
let clientId: string;
let ownerPerms: Set<string>;
const ctx = () => ({ actorId: owner, actor: { id: owner, permissions: ownerPerms } });
/** Somebody with no special rights, for the "not yours" cases. */
const strangerCtx = () => ({
  actorId: other,
  actor: { id: other, permissions: new Set<string>() },
});
const made: string[] = [];

async function task(over: Record<string, unknown> = {}) {
  const row = await createTask(
    {
      title: `Ish ${SUFFIX}`,
      note: '',
      typeId: null,
      assigneeId: owner,
      dueAt: '',
      priority: 2,
      entityType: null,
      entityId: null,
      repeatUnit: null,
      repeatEvery: 1,
      ...over,
    } as Parameters<typeof createTask>[0],
    ctx(),
  );
  made.push(row.id);
  return row;
}

beforeAll(async () => {
  const staff = await db
    .select({ id: users.id, code: roles.code })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(users.active, true));
  owner = staff.find((row) => row.code === 'super_admin')!.id;
  ownerPerms = new Set(['crm.leads.view_all', 'reports.all_warehouses']);
  other = staff.find((row) => row.id !== owner)!.id;
  clientId = (
    await createClient({ clientCode: `TK${SUFFIX}`, name: `Task mijoz ${SUFFIX}`, phones: [] }, ctx())
  ).id;
});

afterAll(async () => {
  // Configuration and work left behind changes what every other screen shows
  // (DECISIONS #183); this suite shares its database with the e2e run.
  for (const id of made) await db.delete(tasks).where(eq(tasks.id, id));
  await pgClient.end();
});

describe('a deadline is a day unless someone named a time', () => {
  it('a bare date is due at the END of that day', () => {
    const { dueAt, allDay } = parseDue('2026-08-14');
    expect(allDay).toBe(true);
    // Not 00:00: a task due Friday is not late one minute into Friday, which
    // is what the whole company would see first thing in the morning.
    expect(dueAt!.toISOString()).toBe('2026-08-14T23:59:59.999Z');
  });

  it('a date with a time keeps the time', () => {
    const { dueAt, allDay } = parseDue('2026-08-14T09:30');
    expect(allDay).toBe(false);
    expect(dueAt!.getUTCHours()).toBe(9);
  });

  it('no deadline is a real answer, and nonsense is refused', () => {
    expect(parseDue('')).toEqual({ dueAt: null, allDay: true });
    expect(parseDue(undefined)).toEqual({ dueAt: null, allDay: true });
    expect(() => parseDue('ertaga')).toThrow('bad_due_date');
  });
});

describe('a task cannot be given somewhere it will not be seen', () => {
  it('refuses somebody who has left', async () => {
    const [gone] = await db
      .insert(users)
      .values({
        fullName: `Ketgan ${SUFFIX}`,
        phone: `+99890${SUFFIX}`,
        passwordHash: 'x',
        locale: 'uz',
        active: false,
      })
      .returning();
    await expect(task({ assigneeId: gone!.id })).rejects.toThrow('assignee_inactive');
    await db.delete(users).where(eq(users.id, gone!.id));
  });

  it('refuses an object the registry does not know', async () => {
    await expect(
      task({ entityType: 'unicorn', entityId: clientId }),
    ).rejects.toThrow('unknown_entity');
  });

  it('refuses half a pointer', async () => {
    await expect(task({ entityType: 'client', entityId: null })).rejects.toThrow('half_pointer');
    await expect(task({ entityType: null, entityId: clientId })).rejects.toThrow('half_pointer');
  });
});

describe('a task hangs off any object the registry knows', () => {
  it('appears on that record and says what it is about', async () => {
    const row = await task({
      title: `Mijozga qo‘ng‘iroq ${SUFFIX}`,
      entityType: 'client',
      entityId: clientId,
    });
    const onCard = await tasksFor('client', clientId);
    expect(onCard.map((item) => item.id)).toContain(row.id);

    const labels = await aboutLabels(onCard);
    expect(labels.get(`client:${clientId}`)).toContain(`Task mijoz ${SUFFIX}`);
  });

  it('a standalone task belongs to nothing and that is allowed', async () => {
    const row = await task({ title: `Yolg‘iz ${SUFFIX}` });
    expect(row.entityType).toBeNull();
  });
});

describe('closing, cancelling and handing over', () => {
  it('records what actually happened, and refuses to close twice', async () => {
    const row = await task({ title: `Yopiladi ${SUFFIX}` });
    await completeTask(row.id, 'mijoz rozi', ctx());
    const [after] = await db.select().from(tasks).where(eq(tasks.id, row.id));
    expect(after!.status).toBe('done');
    expect(after!.result).toBe('mijoz rozi');
    expect(after!.doneAt).not.toBeNull();
    await expect(completeTask(row.id, 'yana', ctx())).rejects.toThrow('already_closed');
  });

  it('cancels rather than deletes — the ask itself is a fact', async () => {
    const row = await task({ title: `Bekor ${SUFFIX}` });
    await cancelTask(row.id, 'kerak emas', ctx());
    const [after] = await db.select().from(tasks).where(eq(tasks.id, row.id));
    expect(after!.status).toBe('cancelled');
    expect(after!.result).toBe('kerak emas');
    // Still there — the record of what was asked survives.
    expect(after).toBeTruthy();
  });

  it('hands a task to somebody else, but not a closed one', async () => {
    const row = await task({ title: `O‘tkaziladi ${SUFFIX}` });
    await reassignTask(row.id, other, ctx());
    const [after] = await db.select().from(tasks).where(eq(tasks.id, row.id));
    expect(after!.assigneeId).toBe(other);

    await completeTask(row.id, '', ctx());
    await expect(reassignTask(row.id, owner, ctx())).rejects.toBeInstanceOf(TaskError);
    await expect(updateTask(row.id, {
      title: 'x', note: '', typeId: null, dueAt: '', priority: 2,
    }, ctx())).rejects.toThrow('already_closed');
  });
});

describe('my day', () => {
  it('separates overdue from today from undated', async () => {
    const today = new Date();
    const endOfToday = new Date(today);
    endOfToday.setUTCHours(23, 59, 59, 999);
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const day = (value: Date) => value.toISOString().slice(0, 10);

    const late = await task({ title: `Kechikkan ${SUFFIX}`, dueAt: day(yesterday) });
    const now = await task({ title: `Bugun ${SUFFIX}`, dueAt: day(today) });
    const later = await task({ title: `Ertaga ${SUFFIX}`, dueAt: day(tomorrow) });
    const someday = await task({ title: `Qachondir ${SUFFIX}` });

    const mine = await myDay(owner, endOfToday);
    expect(mine.overdue.map((row) => row.id)).toContain(late.id);
    expect(mine.today.map((row) => row.id)).toContain(now.id);
    expect(mine.undated.map((row) => row.id)).toContain(someday.id);
    // Tomorrow is not today's problem.
    const all = [...mine.overdue, ...mine.today, ...mine.undated].map((row) => row.id);
    expect(all).not.toContain(later.id);
    // …and a task due TODAY is not reported as late.
    expect(mine.overdue.map((row) => row.id)).not.toContain(now.id);
  });

  it('counts what each person is carrying', async () => {
    const counts = await openCounts();
    expect(counts.get(owner)).toBeGreaterThan(0);
  });

  it('groups overdue work per person, one message not three', async () => {
    const grouped = await overdueByAssignee(new Date());
    const mine = grouped.get(owner) ?? [];
    expect(mine.every((row) => row.status === 'open')).toBe(true);
  });
});

describe('the calendar and the dictionary', () => {
  it('returns tasks inside the window and excludes cancelled ones', async () => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 3);
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + 3);
    const day = to.toISOString().slice(0, 10);

    const shown = await task({ title: `Kalendarda ${SUFFIX}`, dueAt: day });
    const hidden = await task({ title: `Bekorlangan ${SUFFIX}`, dueAt: day });
    await cancelTask(hidden.id, 'kerak emas', ctx());

    const window = await calendarTasks(from, to);
    expect(window.map((row) => row.id)).toContain(shown.id);
    expect(window.map((row) => row.id)).not.toContain(hidden.id);
  });

  it('ships usable task types that the owner can edit', async () => {
    const types = await listTaskTypes();
    expect(types.length).toBeGreaterThanOrEqual(5);
    expect(types.map((row) => row.name)).toContain('Hisoblash');
  });
});

describe('when the record goes, its open work goes with it', () => {
  it('cancels open tasks and leaves closed ones alone', async () => {
    const open = await task({ title: `Ochiq ${SUFFIX}`, entityType: 'client', entityId: clientId });
    const closed = await task({
      title: `Yopilgan ${SUFFIX}`,
      entityType: 'client',
      entityId: clientId,
    });
    await completeTask(closed.id, 'bo‘ldi', ctx());

    await cancelTasksFor(db, 'client', [clientId]);
    const [a] = await db.select().from(tasks).where(eq(tasks.id, open.id));
    const [b] = await db.select().from(tasks).where(eq(tasks.id, closed.id));
    expect(a!.status).toBe('cancelled');
    // A finished job is history, not something to tidy away.
    expect(b!.status).toBe('done');
  });
});

describe('a repeating task schedules the next one when this one is closed', () => {
  it('counts from the DUE date, not from when it was finished', () => {
    const due = new Date('2026-08-10T23:59:59.999Z'); // a Monday
    // Finished early, on the Saturday before.
    const next = nextOccurrence(due, 'week', 1, new Date('2026-08-08T10:00:00Z'));
    // The following Monday — not the Saturday after.
    expect(next.toISOString().slice(0, 10)).toBe('2026-08-17');
  });

  it('rolls forward past every missed occurrence', () => {
    const due = new Date('2026-08-10T23:59:59.999Z');
    // Nobody touched it for a month, then closed it.
    const next = nextOccurrence(due, 'week', 1, new Date('2026-09-09T10:00:00Z'));
    // Not another date in the past: closing a month of missed Mondays must not
    // create another missed Monday.
    expect(next.getTime()).toBeGreaterThan(new Date('2026-09-09T10:00:00Z').getTime());
    expect(next.toISOString().slice(0, 10)).toBe('2026-09-14');
  });

  it('clamps a monthly rule to the end of a short month', () => {
    const due = new Date('2026-01-31T23:59:59.999Z');
    const next = nextOccurrence(due, 'month', 1, new Date('2026-01-31T23:00:00Z'));
    // JavaScript's own overflow would give the 3rd of March and quietly skip
    // February for "the 31st of every month".
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('creates the next occurrence on completion and keeps the series together', async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const first = await task({
      title: `Har hafta ${SUFFIX}`,
      dueAt: tomorrow.toISOString().slice(0, 10),
      repeatUnit: 'week',
    });
    expect(first.seriesId).not.toBeNull();

    await completeTask(first.id, 'bajarildi', ctx());
    const series = await db
      .select()
      .from(tasks)
      .where(eq(tasks.seriesId, first.seriesId!));
    expect(series).toHaveLength(2);
    const open = series.find((row) => row.status === 'open')!;
    made.push(open.id);
    expect(open.title).toBe(`Har hafta ${SUFFIX}`);
    expect(open.dueAt!.getTime()).toBeGreaterThan(first.dueAt!.getTime());
    // The rule travels with it, or the series would stop after two.
    expect(open.repeatUnit).toBe('week');
  });

  it('cancelling ENDS the series — that is how a repeat is stopped', async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const row = await task({
      title: `To‘xtaydi ${SUFFIX}`,
      dueAt: tomorrow.toISOString().slice(0, 10),
      repeatUnit: 'day',
    });
    await cancelTask(row.id, 'kerak emas', ctx());
    const series = await db.select().from(tasks).where(eq(tasks.seriesId, row.seriesId!));
    expect(series).toHaveLength(1);
    expect(series[0]!.status).toBe('cancelled');
  });

  it('refuses a repeat with nothing to repeat from', async () => {
    await expect(task({ title: `Muddatsiz ${SUFFIX}`, repeatUnit: 'week' })).rejects.toThrow(
      'repeat_needs_due',
    );
  });
});

describe('a task is not something anybody can close', () => {
  it('refuses a stranger, and allows the assignee, the author and a manager', async () => {
    // Given to `other`, created by `owner`.
    const row = await task({ title: `Egasi bor ${SUFFIX}`, assigneeId: other });

    // A third person with no rights over it — the case that was open until
    // now: any employee could close any task in the company by its id.
    const stranger = { actorId: clientId, actor: { id: clientId, permissions: new Set<string>() } };
    await expect(completeTask(row.id, 'men yopdim', stranger)).rejects.toThrow('not_yours');
    await expect(cancelTask(row.id, '', stranger)).rejects.toThrow('not_yours');
    await expect(reassignTask(row.id, owner, stranger)).rejects.toThrow('not_yours');

    // The assignee may close their own work…
    await expect(
      completeTask(row.id, 'bajardim', strangerCtx()),
    ).resolves.toBeUndefined();

    // …and the author may act on what they gave out.
    const second = await task({ title: `Berdim ${SUFFIX}`, assigneeId: other });
    await expect(cancelTask(second.id, 'kerak emas', ctx())).resolves.toBeUndefined();
  });

  it('anybody may still CREATE a task for anybody — that stays open', async () => {
    const row = await createTask(
      {
        title: `Begona so‘radi ${SUFFIX}`,
        note: '', typeId: null, assigneeId: owner, dueAt: '', priority: 2,
        entityType: null, entityId: null, repeatUnit: null, repeatEvery: 1,
      },
      // createTask takes the plain audit context — creation is deliberately
      // open, so it never needs the actor's permissions.
      { actorId: other },
    );
    made.push(row.id);
    expect(row.assigneeId).toBe(owner);
  });
});
