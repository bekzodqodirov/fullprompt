'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  RoutingError,
  createRoute,
  deleteRoute,
  moveRoute,
  setRotaMembers,
  setRouteActive,
} from '@/modules/wms/crm/routing';

export interface RoutingFormState {
  ok?: boolean;
  error?: string;
}

/** The settings screen's gate, not a freshly minted permission (#170). */
async function ctx() {
  const actor = await authorize('admin.settings.manage');
  return { actorId: actor.id, ...(await requestMeta()) };
}

export async function saveRotaAction(
  _prev: RoutingFormState,
  form: FormData,
): Promise<RoutingFormState> {
  try {
    // Replace-all is sound here because every box on the form is enabled —
    // the posted set IS the whole answer (#171).
    await setRotaMembers(form.getAll('member').map(String).filter(Boolean), await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  revalidatePath('/admin/taqsimot');
  return { ok: true };
}

export async function addRouteAction(
  _prev: RoutingFormState,
  form: FormData,
): Promise<RoutingFormState> {
  try {
    await createRoute(
      {
        sourceKey: String(form.get('source') ?? '').trim() || null,
        keyword: String(form.get('keyword') ?? '').trim() || null,
        userIds: form.getAll('routeMember').map(String).filter(Boolean),
      },
      await ctx(),
    );
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof RoutingError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/taqsimot');
  return { ok: true };
}

export async function deleteRouteAction(id: string): Promise<RoutingFormState> {
  try {
    await deleteRoute(id, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof RoutingError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/taqsimot');
  return { ok: true };
}

export async function toggleRouteAction(id: string, active: boolean): Promise<RoutingFormState> {
  try {
    await setRouteActive(id, active, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof RoutingError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/taqsimot');
  return { ok: true };
}

export async function moveRouteAction(id: string, dir: 'up' | 'down'): Promise<RoutingFormState> {
  try {
    await moveRoute(id, dir, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof RoutingError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/taqsimot');
  return { ok: true };
}
