'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { CrmError } from '@/modules/wms/crm/service';
import { deleteMapping, saveMapping } from '@/modules/wms/crm/field-map';
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

const numOrNull = (value: FormDataEntryValue | null): number | null => {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function addRouteAction(
  _prev: RoutingFormState,
  form: FormData,
): Promise<RoutingFormState> {
  try {
    await createRoute(
      {
        sourceKey: String(form.get('source') ?? '').trim() || null,
        keyword: String(form.get('keyword') ?? '').trim() || null,
        minM3: numOrNull(form.get('minM3')),
        maxM3: numOrNull(form.get('maxM3')),
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

export async function saveMappingAction(
  _prev: RoutingFormState,
  form: FormData,
): Promise<RoutingFormState> {
  // ONE select carries the whole answer: kub / kg / note, or `f_<id>` for a
  // custom field — one control per row keeps the row usable at 360 px (#421).
  const raw = String(form.get('target') ?? '');
  const isField = raw.startsWith('f_');
  try {
    await saveMapping(
      {
        key: String(form.get('key') ?? ''),
        target: isField
          ? 'field'
          : ((['kub', 'kg', 'note'] as const).find((t) => t === raw) ?? 'note'),
        fieldId: isField ? raw.slice(2) : null,
      },
      await ctx(),
    );
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof CrmError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/taqsimot');
  return { ok: true };
}

export async function deleteMappingAction(key: string): Promise<RoutingFormState> {
  try {
    await deleteMapping(key, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof CrmError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/taqsimot');
  return { ok: true };
}
