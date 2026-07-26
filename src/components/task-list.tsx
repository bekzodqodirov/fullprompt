'use client';

import { useActionState, useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  cancelTaskAction,
  completeTaskAction,
  createTaskAction,
  reassignTaskAction,
  type TaskFormState,
} from '@/modules/platform/tasks/actions';

export interface TaskView {
  id: string;
  title: string;
  note: string | null;
  typeName: string | null;
  typeIcon: string | null;
  assigneeId: string;
  assigneeName: string | null;
  authorName: string | null;
  /** ISO string — a Date cannot cross into a client component. */
  dueAt: string | null;
  allDay: boolean;
  status: string;
  result: string | null;
  priority: number;
  repeatUnit: string | null;
  /** Where the record it is about lives, and what to call it. */
  aboutHref: string | null;
  aboutLabel: string | null;
}

export interface Person {
  id: string;
  name: string;
  openCount?: number;
}

export interface TaskType {
  id: string;
  name: string;
  icon: string | null;
}

/** Red when it is late, amber when it is today, plain otherwise. */
function dueClass(dueAt: string | null, status: string): string {
  if (!dueAt || status !== 'open') return 'text-ink-500';
  const due = new Date(dueAt);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (due < new Date(new Date().setHours(0, 0, 0, 0))) return 'text-bad font-semibold';
  if (due <= endOfToday) return 'text-warn font-semibold';
  return 'text-ink-500';
}

function dueText(dueAt: string | null, allDay: boolean): string {
  if (!dueAt) return '';
  const due = new Date(dueAt);
  const date = due.toISOString().slice(0, 10);
  if (allDay) return date;
  return `${date} ${due.toISOString().slice(11, 16)}`;
}

/**
 * One task, with the two things anyone ever does to it: close it, or hand it on.
 *
 * Closing asks for a result. That is not ceremony — "called, he will confirm on
 * Monday" is the only trace that survives, and a task closed with nothing said
 * teaches everyone that the field is decoration.
 */
function TaskCard({
  task,
  people,
  revalidate,
  canManage,
}: {
  task: TaskView;
  people: Person[];
  revalidate: string;
  canManage: boolean;
}) {
  const t = useTranslations('tasks');
  const tc = useTranslations('common');
  const [closing, setClosing] = useState(false);
  const [pending, start] = useTransition();
  const complete = completeTaskAction.bind(null, task.id, revalidate);
  const [state, formAction, saving] = useActionState<TaskFormState, FormData>(complete, {});

  const done = task.status !== 'open';

  return (
    <div
      className={`card space-y-1.5 !p-3 ${done ? 'opacity-60' : ''}`}
      data-testid={`task-${task.id}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        {task.typeIcon && <span>{task.typeIcon}</span>}
        <span className={`min-w-0 flex-1 font-semibold ${done ? 'line-through' : ''}`}>
          {task.title}
        </span>
        {task.priority === 1 && <span className="chip-bad">🔥</span>}
        {task.dueAt && (
          <span className={`num text-xs ${dueClass(task.dueAt, task.status)}`}>
            {dueText(task.dueAt, task.allDay)}
          </span>
        )}
      </div>

      {task.note && <p className="text-sm text-ink-700 [overflow-wrap:anywhere]">{task.note}</p>}

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
        {task.aboutHref && task.aboutLabel && (
          <Link href={task.aboutHref} className="text-brand-700 underline">
            {task.aboutLabel}
          </Link>
        )}
        <span>👤 {task.assigneeName}</span>
        {task.authorName && task.authorName !== task.assigneeName && (
          <span>← {task.authorName}</span>
        )}
        {task.status === 'done' && task.result && <span className="text-good">✅ {task.result}</span>}
        {task.status === 'cancelled' && <span className="text-ink-400">✖ {t('cancelled')}</span>}
        {task.repeatUnit && <span title={t('repeat')}>🔁</span>}
      </div>

      {!done && (
        <div className="flex flex-wrap gap-2">
          {!closing ? (
            <>
              <button
                type="button"
                data-testid={`close-${task.id}`}
                onClick={() => setClosing(true)}
                className="btn-primary !min-h-9 flex-1 px-3"
              >
                ✅ {t('finish')}
              </button>
              {canManage && people.length > 1 && (
                <select
                  aria-label={t('reassign')}
                  data-testid={`reassign-${task.id}`}
                  defaultValue=""
                  disabled={pending}
                  className="input !min-h-9 !w-36"
                  onChange={(event) => {
                    const next = event.target.value;
                    if (!next) return;
                    start(async () => {
                      await reassignTaskAction(task.id, next, revalidate);
                    });
                  }}
                >
                  <option value="">{t('reassign')}</option>
                  {people
                    .filter((person) => person.id !== task.assigneeId)
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                </select>
              )}
              {canManage && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!window.confirm(t('confirmCancel'))) return;
                    start(async () => {
                      await cancelTaskAction(task.id, revalidate);
                    });
                  }}
                  className="btn-secondary !min-h-9 px-3 text-bad"
                  title={t('cancel')}
                >
                  ✖
                </button>
              )}
            </>
          ) : (
            <form action={formAction} className="flex w-full flex-wrap gap-2">
              <input
                name="result"
                data-testid={`result-${task.id}`}
                placeholder={t('resultPlaceholder')}
                aria-label={t('result')}
                className="input min-w-40 flex-1"
                autoFocus
              />
              <button
                type="submit"
                data-testid={`save-close-${task.id}`}
                disabled={saving}
                className="btn-primary !min-h-9 px-3"
              >
                {saving ? tc('loading') : tc('save')}
              </button>
              <button
                type="button"
                onClick={() => setClosing(false)}
                className="btn-secondary !min-h-9 px-3"
              >
                {tc('cancel')}
              </button>
              {state.error && <p className="w-full text-xs font-semibold text-bad">{tc('error')}</p>}
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** Add a task — the same form on a card and on the day screen. */
export function NewTaskForm({
  people,
  types,
  revalidate,
  defaultAssignee,
  entityType,
  entityId,
}: {
  people: Person[];
  types: TaskType[];
  revalidate: string;
  defaultAssignee: string;
  entityType?: string;
  entityId?: string;
}) {
  const t = useTranslations('tasks');
  const tc = useTranslations('common');
  const action = createTaskAction.bind(null, revalidate);
  const [state, formAction, pending] = useActionState<TaskFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-2" data-testid="new-task">
      {entityType && <input type="hidden" name="entityType" value={entityType} />}
      {entityId && <input type="hidden" name="entityId" value={entityId} />}
      <input
        name="title"
        data-testid="task-title"
        placeholder={t('titlePlaceholder')}
        aria-label={t('title')}
        className="input"
        required
      />
      <div className="flex flex-wrap gap-2">
        <select
          name="assigneeId"
          defaultValue={defaultAssignee}
          aria-label={t('assignee')}
          data-testid="task-assignee"
          className="input min-w-40 flex-1"
        >
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
              {person.openCount ? ` (${person.openCount})` : ''}
            </option>
          ))}
        </select>
        <input
          name="dueAt"
          type="date"
          aria-label={t('due')}
          data-testid="task-due"
          className="input !w-40"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <select name="typeId" aria-label={t('type')} className="input min-w-32 flex-1">
          <option value="">—</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.icon} {type.name}
            </option>
          ))}
        </select>
        <select name="priority" defaultValue="2" aria-label={t('priority')} className="input !w-32">
          <option value="1">🔥 {t('high')}</option>
          <option value="2">{t('normal')}</option>
          <option value="3">{t('low')}</option>
        </select>
        <button
          type="submit"
          data-testid="save-task"
          disabled={pending}
          className="btn-primary flex-1"
        >
          {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          name="note"
          placeholder={t('notePlaceholder')}
          aria-label={t('note')}
          className="input min-w-40 flex-1"
        />
        {/* Repeating needs a deadline to repeat FROM, so the server refuses a
            rule without one and the hint says why before it is typed. */}
        <select
          name="repeatUnit"
          defaultValue=""
          aria-label={t('repeat')}
          data-testid="task-repeat"
          className="input !w-40"
        >
          <option value="">{t('repeatNever')}</option>
          <option value="day">{t('repeatDay')}</option>
          <option value="week">{t('repeatWeek')}</option>
          <option value="month">{t('repeatMonth')}</option>
        </select>
      </div>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}
    </form>
  );
}

export function TaskList({
  tasks,
  people,
  revalidate,
  canManage = true,
  empty,
}: {
  tasks: TaskView[];
  people: Person[];
  revalidate: string;
  canManage?: boolean;
  empty?: string;
}) {
  if (tasks.length === 0) {
    return empty ? <p className="text-sm text-ink-500">{empty}</p> : null;
  }
  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          people={people}
          revalidate={revalidate}
          canManage={canManage}
        />
      ))}
    </div>
  );
}
