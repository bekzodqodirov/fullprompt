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
  // The viewer the strip was drawn for, doors included: the AI sotuvchi's tab
  // is opened by a fact in wms (`agentNavDoors`), and a ☆ on a tab the strip
  // offered must not come back «not offered». Dynamic across platform → wms,
  // the tasks service's idiom; a failure costs that one door, never the star.
  let doors: ReadonlySet<string> = new Set();
  try {
    const { agentNavDoors } = await import('../../wms/agent/web-door');
    doors = await agentNavDoors(actor);
  } catch {
    doors = new Set();
  }
  const result = await setStar(actor.id, { permissions: actor.permissions, roles: actor.roles, doors }, href, on);
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}
