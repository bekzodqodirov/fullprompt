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
}: {
  entityType: string;
  entityId: string;
  revalidate: string;
}) {
  if (!(await resolveEntity(entityType))) return null;
  const actor = await getActor();
  if (!actor) return null;

  const [rows, people, types] = await Promise.all([
    tasksFor(entityType, entityId),
    assignablePeople(),
    taskTypeOptions(),
  ]);
  const tasks = await toTaskViews(rows);
  const open = tasks.filter((task) => task.status === 'open');
  const t = await getTranslations('tasks');

  return (
    <Panel
      title={`✅ ${t('title')}`}
      badge={open.length || undefined}
      testId="tasks-panel"
      open={open.length > 0}
    >
      <NewTaskForm
        people={people}
        types={types}
        revalidate={revalidate}
        defaultAssignee={actor.id}
        entityType={entityType}
        entityId={entityId}
      />
      <div className="border-t border-line pt-2">
        <TaskList tasks={tasks} people={people} revalidate={revalidate} empty={t('none')} />
      </div>
    </Panel>
  );
}
