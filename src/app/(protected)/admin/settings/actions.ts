'use server';

import { revalidatePath } from 'next/cache';
import { authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { db } from '@/modules/platform/db/client';
import {
  getSetting,
  SETTING_DEFAULTS,
  setSetting,
  type SettingKey,
} from '@/modules/platform/settings/service';

const SETTINGS_ENTITY_ID = '00000000-0000-0000-0000-000000000001';

export async function updateSettingAction(formData: FormData): Promise<void> {
  const actor = await authorize('admin.settings.manage');
  const key = String(formData.get('key')) as SettingKey;
  if (!(key in SETTING_DEFAULTS)) return;

  const raw = String(formData.get('value') ?? '');
  const defaultValue = SETTING_DEFAULTS[key];
  let value: unknown = raw;
  if (typeof defaultValue === 'boolean') value = raw === 'true' || raw === 'on';
  else if (typeof defaultValue === 'number') {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    value = parsed;
  } else if (typeof defaultValue === 'object') {
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
  }

  const before = await getSetting(key);
  await setSetting(key, value, actor.id);

  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'settings',
      entityId: SETTINGS_ENTITY_ID,
      action: 'update',
      before: { [key]: before },
      after: { [key]: value },
    },
  );
  revalidatePath('/admin/settings');
}
