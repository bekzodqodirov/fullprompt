import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/panel';
import { getActor } from '@/modules/platform/rbac/authorize';
import { resolveEntity } from '@/modules/platform/entities/service';
import { tasksFor } from '@/modules/platform/tasks/service';
import { assignablePeople, taskTypeOptions, toTaskViews } from '@/modules/platform/tasks/view';
import { NewTaskForm, TaskList } from './task-list';

/**
 * The work outstanding on one record — a single line on any card.
 *
 * Unlike the custom-fields panel this is shown even when empty, because its
 * value is the ADD button: the whole point is that a warehouse manager can ask
 * for a calculation from the receipt they are looking at, without going
 * somewhere else and describing which receipt they mean.
 */
export async function TasksPanel({
  entityType,
  entityId,
  revalidate,
  readOnly = false,
}: {
  entityType: string;
  entityId: string;
  revalidate: string;
  /**
   * The list without the ADD form — the VED on a deal card (17a): he reads
   * the card and does not raise work about its terms. The list's own ✅
   * still follows `canActOnTask`, and a bound calc task has none by design.
   * Hidden, not removed: the task ACTION has no per-entity gate by design
   * («everyone has tasks», platform/tasks/actions.ts).
   */
  readOnly?: boolean;
}) {
  if (!(await resolveEntity(entityType))) return null;
  const actor = await getActor();
  if (!actor) return null;

  const [rows, people, types] = await Promise.all([
    tasksFor(entityType, entityId),
    assignablePeople(),
    taskTypeOptions(),
  ]);
  const tasks = await toTaskViews(rows, actor);
  const open = tasks.filter((task) => task.status === 'open');
  const t = await getTranslations('tasks');

  return (
    <Panel
      title={`✅ ${t('title')}`}
      badge={open.length || undefined}
      testId="tasks-panel"
      open={open.length > 0}
    >
      {!readOnly && (
        <NewTaskForm
          people={people}
          types={types}
          revalidate={revalidate}
          defaultAssignee={actor.id}
          entityType={entityType}
          entityId={entityId}
        />
      )}
      {/* The divider separates the form from the list; with no form above it
          it would be a rule over nothing. Both strings literal (Tailwind
          only compiles what it can see). */}
      <div className={readOnly ? '' : 'border-t border-line pt-2'}>
        <TaskList tasks={tasks} people={people} revalidate={revalidate} empty={t('none')} />
      </div>
    </Panel>
  );
}
