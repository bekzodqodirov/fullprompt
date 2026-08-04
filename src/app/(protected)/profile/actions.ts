'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { getSessionUser, requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';
import { listFromGroups, MUTE_GROUPS, type MuteGroup } from '@/modules/platform/notifications/mutes';

/** Self-service Telegram mute settings (spec §11) — no special permission. */
export async function setNotificationMutesAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;

  const all = formData.get('mute_all') === 'on';
  const groups = Object.fromEntries(
    (Object.keys(MUTE_GROUPS) as MuteGroup[]).map((g) => [g, formData.get(`mute_${g}`) === 'on']),
  ) as Record<MuteGroup, boolean>;
  const list = listFromGroups(all, groups);

  const before = await db.query.users.findFirst({
    columns: { mutedNotificationTypes: true },
    where: eq(users.id, user.id),
  });
  await db.update(users).set({ mutedNotificationTypes: list }).where(eq(users.id, user.id));
  const meta = await requestMeta();
  await writeAudit(db, { actorId: user.id, ...meta }, {
    entityType: 'user',
    entityId: user.id,
    action: 'update',
    before: { mutedNotificationTypes: before?.mutedNotificationTypes ?? [] },
    after: { mutedNotificationTypes: list },
  });
  revalidatePath('/profile');
}
