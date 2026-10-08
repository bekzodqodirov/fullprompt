'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { logger } from '@/modules/platform/logger';
import { reachOf } from '@/modules/platform/notifications/staff';
import { THREAD_UUID, isCargoKind } from '@/modules/platform/notifications/thread-ref';
import { CARGO_UNREACHABLE_CAP, warehouseCodes, type CargoThreadState } from './cargo-thread';
import { announceNote, type CargoReach } from './internal-chat';
import { mayWriteThread } from './thread-door';
import { addThreadMessage, isThreadWriteBehind, ThreadError, type UnreachableReason } from './thread';

/**
 * «❓ Savol-javob» on a prixod or a truck card — one message in the cargo's
 * thread (round 2, 0129; the owner's E6 c warehouse half, E7 b). A shared
 * action in wms/crm (reply-actions.ts's precedent): two pages mount the box.
 *
 * The door is the thread's own (`mayWriteThread` — the office, or the staff
 * of the warehouse where the cargo stands), asked HERE (#531), never trusted
 * from the box. The box is drawn only for somebody the door admitted, so a
 * refusal here is the cargo having MOVED between the render and the press —
 * said as that to a scoped writer (`cargo_moved`), as the bot says it.
 *
 * What the box is told comes from the announce's own answer, never a second
 * rule: who of the arm will not hear it in Telegram and why, the standing
 * warehouses with NOBODY assigned («the message did not go THERE»), a
 * warehouse writer's message that reached no logist, and «nobody was sent
 * it» ONLY when nobody at all was — each line one fact.
 */
export async function postCargoThreadAction(_prev: CargoThreadState, form: FormData): Promise<CargoThreadState> {
  const who = await getActor();
  if (!who) return { error: 'forbidden' };
  const kind = String(form.get('kind') ?? '');
  const id = String(form.get('id') ?? '');
  const body = String(form.get('body') ?? '');
  if (!isCargoKind(kind) || !THREAD_UUID.test(id)) return { error: 'not_found' };
  const ref = { kind, id: id.toLowerCase() };
  try {
    if (!(await mayWriteThread(who, ref))) return { error: who.warehouseScoped ? 'cargo_moved' : 'forbidden' };
    const landed = await addThreadMessage({ ref, body }, { actorId: who.id, ...(await requestMeta()) });

    let heard: string[] = [];
    let mentioned: string[] = [];
    let cargo: CargoReach | null = null;
    try {
      ({ heard, mentioned, cargo } = await announceNote({
        entityType: landed.entityType,
        entityId: landed.entityId,
        note: body.trim(),
        authorId: who.id,
        activityId: landed.activityId,
        calcRequestId: landed.calcRequestId,
      }));
    } catch (err) {
      // The message is written; a ping that failed is a small failure, told
      // in the log and never as a refusal of a message that saved. All three
      // lists stay empty and `nobody` is true — the truth of a failed announce.
      logger.warn({ err, activityId: landed.activityId }, '[thread] cargo announce failed');
    }

    // The arm's people the door let through — whom THIS message is for.
    const expected = (cargo?.armIds ?? []).filter((person) => heard.includes(person));
    const reaches = await reachOf(expected, 'InternalNote');
    const unreachableIds = expected
      .map((person) => {
        const reach = reaches.get(person) ?? 'no_chat';
        return reach === 'ok' ? null : { id: person, reason: reach };
      })
      .filter((row): row is { id: string; reason: Exclude<UnreachableReason, 'no_door'> } => row !== null);
    const shown = unreachableIds.slice(0, CARGO_UNREACHABLE_CAP);
    const names = shown.length
      ? await db.execute<{ id: string; name: string }>(sql`
          SELECT id::text AS id, full_name AS name FROM users
           WHERE id IN (${sql.join(shown.map((row) => sql`${row.id}::uuid`), sql`, `)})
        `)
      : [];
    const nameOf = new Map(names.map((row) => [row.id, row.name] as const));
    const noStaffIds = cargo?.to === 'staff' ? cargo.noStaffAt : [];
    const codes = await warehouseCodes(noStaffIds);

    switch (ref.kind) {
      case 'receipt':
        revalidatePath(`/receipts/${ref.id}`);
        break;
      case 'batch':
        revalidatePath(`/batches/${ref.id}`);
        break;
      default: {
        const never: never = ref.kind;
        void never;
      }
    }
    return {
      ok: true,
      unreachable: shown.map((row) => ({ name: nameOf.get(row.id) ?? '—', reason: row.reason })),
      unreachableMore: Math.max(0, unreachableIds.length - shown.length),
      noStaffAt: noStaffIds.map((w) => codes.get(w) ?? '—'),
      noOffice: cargo?.to === 'office' && expected.length === 0,
      // Everyone the note addressed in Telegram — past authors and @-named
      // people included; «nobody» is said only when that list is empty.
      nobody: [...heard, ...mentioned].filter((person) => person !== who.id).length === 0,
      sent: Date.now(),
    };
  } catch (err) {
    if (err instanceof ThreadError) return { error: err.code };
    // A release ahead of 0129 (or 0127): the morning's expected state, no error line.
    if (isThreadWriteBehind(err)) return { error: 'server_behind' };
    logger.error({ err, kind, id }, '[thread] cargo message not saved');
    return { error: 'save_failed' };
  }
}
