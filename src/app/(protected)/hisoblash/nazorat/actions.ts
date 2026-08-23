'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { CalcLinkError, confirmCalcLink, setCalcLink } from '@/modules/wms/calc/link';
import { calcControlScopeFor } from '@/modules/wms/calc/control-scope';

export interface LinkFormState {
  ok?: boolean;
  error?: string;
}

/**
 * The control screen's two buttons.
 *
 * Gated on `calcControlScopeFor` and NOT on a permission code, because the
 * screen's audience is a composite the owner edits on /admin/roles (#170);
 * a `run()` over `authorize('…')` would have to invent a code for it.
 *
 * Both catch `isServerBehind`: 0089 is this release's migration and the one
 * machine whose schema is behind is production on deploy morning (#472).
 */
async function run(
  work: (
    actorId: string,
    scope: 'all' | 'own',
    meta: Record<string, unknown>,
  ) => Promise<unknown>,
) {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  const scope = calcControlScopeFor(actor);
  if (scope === 'none') return { error: 'forbidden' };
  try {
    // The SCOPE goes down with the call, and is not merely a door on the way
    // in: every list on the screen is scoped, so buttons that were not let a
    // VED confirm or erase the link that measures a colleague.
    await work(actor.id, scope, await requestMeta());
  } catch (err) {
    if (err instanceof CalcLinkError) return { error: err.code };
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc-control] server behind');
      return { error: 'server_behind' };
    }
    throw err;
  }
  revalidatePath('/hisoblash/nazorat');
  return { ok: true };
}

export async function confirmLinkAction(
  _prev: LinkFormState,
  form: FormData,
): Promise<LinkFormState> {
  const receiptId = String(form.get('receiptId') ?? '');
  return run((actorId, scope, meta) => confirmCalcLink(receiptId, scope, { actorId, ...meta }));
}

/** «No, this is not that cargo» — clears the guess so it stops being offered. */
export async function dropLinkAction(
  _prev: LinkFormState,
  form: FormData,
): Promise<LinkFormState> {
  const receiptId = String(form.get('receiptId') ?? '');
  return run((actorId, scope, meta) => setCalcLink(receiptId, null, scope, { actorId, ...meta }));
}

/**
 * The picker on the prixod card — the door that makes the join fill up when
 * the guess cannot: a client with two open jobs gets no suggestion at all,
 * and a busy client is always in that state.
 *
 * Same audience as the control screen. STATED to the owner as a default and
 * not a law: he is being asked whether the SELLER should be able to answer
 * this too, since they are often the person who knows.
 */
export async function setCalcLinkAction(
  receiptId: string,
  requestId: string | null,
): Promise<LinkFormState> {
  return run((actorId, scope, meta) =>
    setCalcLink(receiptId, requestId, scope, { actorId, ...meta }),
  );
}
