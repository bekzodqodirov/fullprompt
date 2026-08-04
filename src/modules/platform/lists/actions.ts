'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, getActor } from '../rbac/authorize';
import { requestMeta } from '../auth/session';
import { ListViewError, deleteView, saveView, updateView } from './service';

/**
 * The saved-view buttons.
 *
 * Every list screen in the app shares these three, so they live beside the
 * service rather than in one screen's folder. They take the screen key and
 * the query string as data — nothing here knows what any list contains.
 *
 * Round 52's rule applies with force: this release adds a table, so every
 * action that touches it CATCHES. The one machine where the migration has
 * not run is production on the morning of a deploy, and a throw there is a
 * white page with a digest on it.
 */

export interface ViewActionState {
  ok?: boolean;
  error?: string;
}

async function actorOrThrow() {
  const actor = await getActor();
  if (!actor) throw new AuthError('not signed in', 'unauthenticated');
  return actor;
}

export async function saveViewAction(
  _prev: ViewActionState,
  formData: FormData,
): Promise<ViewActionState> {
  const screen = String(formData.get('screen') ?? '');
  const path = String(formData.get('path') ?? '/');
  try {
    const actor = await actorOrThrow();
    await saveView(
      {
        screen,
        name: String(formData.get('name') ?? ''),
        query: String(formData.get('query') ?? ''),
        makePublic: formData.getAll('makePublic').at(-1) === 'on',
        makeDefault: formData.getAll('makeDefault').at(-1) === 'on',
      },
      actor,
      { actorId: actor.id, ...(await requestMeta()) },
    );
  } catch (err) {
    return { error: errorCode(err) };
  }
  revalidatePath(path);
  return { ok: true };
}

export async function deleteViewAction(id: string, path: string): Promise<ViewActionState> {
  try {
    const actor = await actorOrThrow();
    await deleteView(id, actor, { actorId: actor.id, ...(await requestMeta()) });
  } catch (err) {
    return { error: errorCode(err) };
  }
  revalidatePath(path);
  return { ok: true };
}

export async function updateViewAction(
  id: string,
  patch: { pinned?: boolean; isDefault?: boolean },
  path: string,
): Promise<ViewActionState> {
  try {
    const actor = await actorOrThrow();
    await updateView(id, patch, actor);
  } catch (err) {
    return { error: errorCode(err) };
  }
  revalidatePath(path);
  return { ok: true };
}

/**
 * A code the button can render in the viewer's own language.
 *
 * `server_behind` is the deploy-morning case (#472): the code is newer than
 * the database, and the honest answer names that rather than "Something went
 * wrong". The real error goes to the log for whoever is looking.
 */
function errorCode(err: unknown): string {
  if (err instanceof ListViewError) return err.code;
  if (err instanceof AuthError) return 'forbidden';
  console.error('[list-views]', err);
  if (isMissingTable(err)) return 'server_behind';
  return 'failed';
}

function isMissingTable(err: unknown): boolean {
  // 42P01 = undefined_table. Anything else is a real fault, not a stale schema.
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '42P01'
  );
}
