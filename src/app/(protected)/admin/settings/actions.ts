'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { db } from '@/modules/platform/db/client';
import {
  getSetting,
  SETTING_DEFAULTS,
  SETTING_VALIDATORS,
  SETTINGS_AUDIT_ID,
  setSetting,
  type SettingKey,
} from '@/modules/platform/settings/service';

export async function updateSettingAction(formData: FormData): Promise<void> {
  const actor = await authorize('admin.settings.manage');
  const key = String(formData.get('key')) as SettingKey;
  if (!(key in SETTING_DEFAULTS)) return;

  const raw = String(formData.get('value') ?? '');
  // A value with a shape (the unpriced-cargo ban's instant) is checked before
  // anything is written, and a refusal says so in words on the screen (#472)
  // — for the ban, a typo stored verbatim would read as a broken setting,
  // and a silent no-op would leave the admin believing he had moved it.
  const validator = SETTING_VALIDATORS[key];
  if (validator && !validator(raw.trim())) redirect(`/admin/settings?bad=${encodeURIComponent(key)}`);
  const defaultValue = SETTING_DEFAULTS[key];
  let value: unknown = validator ? raw.trim() : raw;
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
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      before: { [key]: before },
      after: { [key]: value },
    },
  );
  revalidatePath('/admin/settings');
  // Off the refusal's address once a good value is saved, or its sentence
  // would stay under the input it no longer describes.
  redirect('/admin/settings');
}
