'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '../rbac/authorize';
import { requestMeta } from '../auth/session';
import {
  TaskError,
  cancelTask,
  completeTask,
  createTask,
  reassignTask,
  taskSchema,
  updateTask,
} from './service';

export interface TaskFormState {
  ok?: boolean;
  error?: string;
}

/**
 * Everyone has tasks, so nothing here mints a permission code.
 *
 * Being logged in is the gate for creating one and for closing one you were
 * given: this is a company of twenty people where the warehouse manager asks
 * the VED manager for a calculation twenty times a week, and a permission
 * matrix over that is bureaucracy nobody would maintain. What IS guarded is
 * seeing everybody else's work — that lives on the screens, not here.
 */
async function who() {
  const actor = await getActor();
  if (!actor) return null;
  return {
    actor,
    ctx: {
      actorId: actor.id,
      ...(await requestMeta()),
      // Carried so the service can answer "is this task yours".
      actor: { id: actor.id, permissions: actor.permissions },
    },
  };
}

export async function createTaskAction(
  revalidate: string,
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const me = await who();
  if (!me) return { error: 'unauthenticated' };

  const str = (name: string) => String(formData.get(name) ?? '').trim();
  // A date plus an optional clock time (round 28): the two inputs join into
  // the `YYYY-MM-DDTHH:mm` shape parseDue reads, and the hidden offset says
  // whose wall clock the time was typed on.
  const dueDate = str('dueAt');
  const dueTime = str('dueTime');
  const tzRaw = str('tzOffset');
  const parsed = taskSchema.safeParse({
    title: str('title'),
    note: str('note'),
    typeId: str('typeId') || null,
    assigneeId: str('assigneeId') || me.actor.id,
    dueAt: dueDate && dueTime ? `${dueDate}T${dueTime}` : dueDate,
    tzOffsetMin: tzRaw === '' ? null : Number(tzRaw),
    priority: Number(formData.get('priority')) || 2,
    entityType: str('entityType') || null,
    entityId: str('entityId') || null,
    repeatUnit: str('repeatUnit') || null,
    repeatEvery: Number(formData.get('repeatEvery')) || 1,
  });
  if (!parsed.success) return { error: 'validation' };

  try {
    await createTask(parsed.data, me.ctx);
  } catch (err) {
    if (err instanceof TaskError) return { error: err.code };
    throw err;
  }
  revalidatePath(revalidate);
  return { ok: true };
}

export async function completeTaskAction(
  id: string,
  revalidate: string,
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const me = await who();
  if (!me) return { error: 'unauthenticated' };
  try {
    await completeTask(id, String(formData.get('result') ?? ''), me.ctx);
  } catch (err) {
    if (err instanceof TaskError) return { error: err.code };
    throw err;
  }
  revalidatePath(revalidate);
  return { ok: true };
}

export async function cancelTaskAction(id: string, revalidate: string): Promise<TaskFormState> {
  const me = await who();
  if (!me) return { error: 'unauthenticated' };
  try {
    await cancelTask(id, '', me.ctx);
  } catch (err) {
    if (err instanceof TaskError) return { error: err.code };
    throw err;
  }
  revalidatePath(revalidate);
  return { ok: true };
}

export async function reassignTaskAction(
  id: string,
  assigneeId: string,
  revalidate: string,
): Promise<TaskFormState> {
  const me = await who();
  if (!me) return { error: 'unauthenticated' };
  try {
    await reassignTask(id, assigneeId, me.ctx);
  } catch (err) {
    if (err instanceof TaskError) return { error: err.code };
    throw err;
  }
  revalidatePath(revalidate);
  return { ok: true };
}

export async function updateTaskAction(
  id: string,
  revalidate: string,
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const me = await who();
  if (!me) return { error: 'unauthenticated' };
  const str = (name: string) => String(formData.get(name) ?? '').trim();
  const dueDate = str('dueAt');
  const dueTime = str('dueTime');
  const tzRaw = str('tzOffset');
  try {
    await updateTask(
      id,
      {
        title: str('title'),
        note: str('note'),
        typeId: str('typeId') || null,
        dueAt: dueDate && dueTime ? `${dueDate}T${dueTime}` : dueDate,
        tzOffsetMin: tzRaw === '' ? null : Number(tzRaw),
        priority: Number(formData.get('priority')) || 2,
      },
      me.ctx,
    );
  } catch (err) {
    if (err instanceof TaskError) return { error: err.code };
    throw err;
  }
  revalidatePath(revalidate);
  return { ok: true };
}
