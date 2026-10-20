'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { db } from '@/modules/platform/db/client';
import { attachments } from '@/modules/platform/db/schema';
import { logger } from '@/modules/platform/logger';
import { getSetting, setSetting, SETTINGS_AUDIT_ID } from '@/modules/platform/settings/service';
import { writeAudit } from '@/modules/platform/audit/service';
import { purgeAttachment } from '@/modules/platform/files/service';
import { connectStaffGroup, disconnectStaffGroup, activeStaffGroup } from '@/modules/platform/telegram/staff-group';
import { queueGroupPost, retryGroupPost } from '@/modules/platform/telegram/staff-group-posts';
import { STAFF_GROUP_MEDIA_ENTITY, STAFF_GROUP_MEDIA_TYPE } from '@/modules/platform/telegram/staff-group-media';
import { postMonthChampion, postWeeklyRating } from '@/modules/wms/staff/rating';
import { GROUP_ERRORS, type GroupError } from './errors';

/**
 * The staff group panel's doors (0134). Each asks `admin.settings.manage`
 * itself (the page's gate is not the action's) and answers a CODE the panel
 * turns into words — never a white page (#472).
 */
export type GroupActionResult = { ok: true; note?: 'requeued' } | { ok: false; error: GroupError };

const PATH = '/admin/jamoa-guruhi';

function refused(error: GroupError): GroupActionResult {
  return { ok: false, error: GROUP_ERRORS.includes(error) ? error : 'failed' };
}

export async function connectGroupAction(chatId: string): Promise<GroupActionResult> {
  const actor = await authorize('admin.settings.manage');
  if (!/^-?\d{1,20}$/.test(chatId)) return refused('not_found');
  try {
    const done = await connectStaffGroup(chatId, { actorId: actor.id, ...(await requestMeta()) });
    revalidatePath(PATH);
    return done.ok ? { ok: true } : refused(done.error);
  } catch (err) {
    logger.error({ err }, '[staff-group] connect failed');
    return refused('failed');
  }
}

export async function disconnectGroupAction(): Promise<GroupActionResult> {
  const actor = await authorize('admin.settings.manage');
  try {
    await disconnectStaffGroup({ actorId: actor.id, ...(await requestMeta()) });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, '[staff-group] disconnect failed');
    return refused('failed');
  }
}

/** «Sinov xabari» — one test post with a GIF, to see the group hears the bot. Each press is its own. */
export async function testPostAction(): Promise<GroupActionResult> {
  const actor = await authorize('admin.settings.manage');
  try {
    if (!(await activeStaffGroup())) return refused('no_group');
    const queued = await queueGroupPost({
      kind: 'test',
      dedupeKey: `test:${actor.id}:${Date.now()}`,
      html: '✅ GSR tizimi bu guruhga ulandi. Tabriklar va shanba reytingi shu yerga keladi.',
      subjectUserId: actor.id,
      withMedia: true,
    });
    revalidatePath(PATH);
    return queued ? { ok: true } : refused('failed');
  } catch (err) {
    logger.error({ err }, '[staff-group] test failed');
    return refused('failed');
  }
}

/** «Reytingni yuborish» — the last closed week, for a Saturday the bot missed. Never twice. */
export async function sendRatingNowAction(): Promise<GroupActionResult> {
  await authorize('admin.settings.manage');
  try {
    if (!(await activeStaffGroup())) return refused('no_group');
    const outcome = await postWeeklyRating(new Date(), { manual: true });
    revalidatePath(PATH);
    if (outcome === 'already') return refused('already_posted');
    return outcome === 'requeued' ? { ok: true, note: 'requeued' } : { ok: true };
  } catch (err) {
    logger.error({ err }, '[staff-group] rating failed');
    return refused('failed');
  }
}

/** «Oy chempionini yuborish» — last month's podium, for an 8th the bot missed. Never twice. */
export async function sendChampionNowAction(): Promise<GroupActionResult> {
  await authorize('admin.settings.manage');
  try {
    if (!(await activeStaffGroup())) return refused('no_group');
    const outcome = await postMonthChampion(new Date(), { manual: true });
    revalidatePath(PATH);
    if (outcome === 'already') return refused('already_posted');
    return outcome === 'requeued' ? { ok: true, note: 'requeued' } : { ok: true };
  } catch (err) {
    logger.error({ err }, '[staff-group] champion failed');
    return refused('failed');
  }
}

export async function retryGroupPostAction(id: string): Promise<GroupActionResult> {
  await authorize('admin.settings.manage');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return refused('not_found');
  try {
    const ok = await retryGroupPost(id);
    revalidatePath(PATH);
    return ok ? { ok: true } : refused('not_found');
  } catch (err) {
    logger.error({ err }, '[staff-group] retry failed');
    return refused('failed');
  }
}

/** A GIF off the rotation — asked here (the settings admin), never by the shared delete route. */
export async function deleteGroupMediaAction(id: string): Promise<GroupActionResult> {
  await authorize('admin.settings.manage');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return refused('not_found');
  try {
    const [row] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.entityType, STAFF_GROUP_MEDIA_TYPE),
          eq(attachments.entityId, STAFF_GROUP_MEDIA_ENTITY),
        ),
      )
      .limit(1);
    if (!row) return refused('not_found');
    await purgeAttachment(row.id);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, '[staff-group] media delete failed');
    return refused('failed');
  }
}

/** The team's weekly goal in kub (8a); empty or 0 = no goal line. */
export async function saveGoalAction(raw: string): Promise<GroupActionResult> {
  const actor = await authorize('admin.settings.manage');
  const text = raw.trim().replace(',', '.');
  const value = text === '' ? 0 : Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 100_000) return refused('bad_goal');
  try {
    const next = Math.round(value * 100) / 100;
    const before = await getSetting('staff_rating_goal_m3');
    await setSetting('staff_rating_goal_m3', next, actor.id);
    await writeAudit(db, { actorId: actor.id, ...(await requestMeta()) }, {
      entityType: 'settings',
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      before: { staff_rating_goal_m3: before },
      after: { staff_rating_goal_m3: next },
    });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, '[staff-group] goal failed');
    return refused('failed');
  }
}
