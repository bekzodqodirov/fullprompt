'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '../rbac/authorize';
import { setStar, type StarResult } from './usage';

/**
 * The ☆ at the end of a workspace's tab strip. The layout carries the
 * «Tez-tez» block, so the whole layout is revalidated — the theme toggle's
 * precedent.
 */
export async function toggleStarAction(href: string, on: boolean): Promise<StarResult> {
  const actor = await getActor();
  if (!actor) return { ok: false, error: 'not_offered' };
  const result = await setStar(actor.id, { permissions: actor.permissions, roles: actor.roles }, href, on);
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}
