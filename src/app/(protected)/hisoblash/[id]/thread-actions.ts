'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { reachOf } from '@/modules/platform/notifications/staff';
import { THREAD_UUID } from '@/modules/platform/notifications/thread-ref';
import { announceNote } from '@/modules/wms/crm/internal-chat';
import { mayWriteThread } from '@/modules/wms/crm/thread-door';
import {
  addThreadMessage,
  ThreadError,
  type CalcThreadState,
  type UnreachableReason,
} from '@/modules/wms/crm/thread';

/**
 * «❓ Savol-javob» — one message under one calculation (the owner's E3 a /
 * E5 a). Its OWN file: the phone and the VED-on-the-deal packages both edit
 * `hisoblash/actions.ts`.
 *
 * Mounted twice — the calc page (the VED asks) and the card's fold (the
 * seller answers) — and it is the same door either way: `mayWriteThread`
 * over the calc thread, asked HERE (#531), never trusted from the box.
 *
 * The box is TOLD who will not hear it (§3.4 «what the box is told»): for a
 * VED writing, the requester and the person carrying the card; for anybody
 * else, the calculator. Each one that will not hear it gets a reason — the
 * door dropped him, he has no linked Telegram, or he muted these — and
 * «nobody receives this» is said only when there is nobody to expect at all
 * (a seller asks and the request is not assigned yet).
 */


export async function postCalcThreadAction(_prev: CalcThreadState, form: FormData): Promise<CalcThreadState> {
  const who = await getActor();
  if (!who) return { error: 'forbidden' };
  const requestId = String(form.get('requestId') ?? '');
  const body = String(form.get('body') ?? '');
  if (!THREAD_UUID.test(requestId)) return { error: 'not_found' };
  const ref = { kind: 'calc' as const, id: requestId };
  try {
    if (!(await mayWriteThread(who, ref))) return { error: 'forbidden' };
    const landed = await addThreadMessage({ ref, body }, { actorId: who.id, ...(await requestMeta()) });

    // The people this message is FOR, and whom of them it will not reach.
    const roles = await db.execute<{
      requested_by: string | null;
      assignee_id: string | null;
      owner_id: string | null;
    }>(sql`
      SELECT r.requested_by::text AS requested_by, r.assignee_id::text AS assignee_id,
             COALESCE(l.owner_id, d.owner_id)::text AS owner_id
        FROM calc_requests r
        LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
        LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
       WHERE r.id = ${requestId}::uuid
    `);
    const role = roles[0];
    const vedWriting =
      role !== undefined &&
      (who.id === role.assignee_id ||
        (who.permissions.has('ved.docs') && who.id !== role.requested_by && who.id !== role.owner_id));
    const expected = [
      ...new Set(
        (vedWriting ? [role?.requested_by, role?.owner_id] : [role?.assignee_id]).filter(
          (id): id is string => typeof id === 'string' && id !== who.id,
        ),
      ),
    ];

    let heard: string[] = [];
    let standingOnly: string[] = [];
    try {
      ({ heard, standingOnly } = await announceNote({
        entityType: landed.entityType,
        entityId: landed.entityId,
        note: body.trim(),
        authorId: who.id,
        activityId: landed.activityId,
        calcRequestId: landed.calcRequestId,
      }));
    } catch (err) {
      // The message is written; a ping that failed is a small failure, told
      // in the log and never as a refusal of a message that saved.
      logger.warn({ err, activityId: landed.activityId }, '[thread] announce failed');
    }

    const reaches = await reachOf(expected, 'CalcThread');
    const unreachableIds = expected
      .map((id) => {
        if (!heard.includes(id) && !standingOnly.includes(id)) return { id, reason: 'no_door' as const };
        const reach = reaches.get(id) ?? 'no_chat';
        return reach === 'ok' ? null : { id, reason: reach };
      })
      .filter((row): row is { id: string; reason: UnreachableReason } => row !== null);
    const names = unreachableIds.length
      ? await db.execute<{ id: string; name: string }>(sql`
          SELECT id::text AS id, full_name AS name FROM users
           WHERE id IN (${sql.join(unreachableIds.map((r) => sql`${r.id}::uuid`), sql`, `)})
        `)
      : [];
    const nameOf = new Map(names.map((row) => [row.id, row.name] as const));

    revalidatePath(`/hisoblash/${requestId}`);
    revalidatePath(landed.entityType === 'lead' ? `/crm/leads/${landed.entityId}` : `/bitimlar/${landed.entityId}`);
    revalidatePath('/hisoblash', 'layout');
    return {
      ok: true,
      unreachable: unreachableIds.map((row) => ({ name: nameOf.get(row.id) ?? '—', reason: row.reason })),
      noAudience: expected.length === 0,
      sent: Date.now(),
    };
  } catch (err) {
    if (err instanceof ThreadError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    logger.error({ err, requestId }, '[thread] calc message not saved');
    return { error: 'save_failed' };
  }
}
