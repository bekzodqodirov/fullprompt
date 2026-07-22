import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { settings } from '../db/schema';

/**
 * Typed settings registry (spec §17). Values live as JSONB rows in
 * `settings`; every key has a default so the app works before seeding.
 */
export const SETTING_DEFAULTS = {
  letter_scope: 'warehouse' as 'warehouse' | 'global',
  exclude_ambiguous_letters: false,
  chargeable_weight_factor: 167,
  density_thresholds: { light: 200, medium: 300, heavy: 400 },
  unclaimed_aging_days: 7,
  stale_stock_days: 30,
  costing_base_currency: 'USD',
  client_code_prefix: 'GS',
  label_size: '100x100',
  translation_provider: 'libretranslate',
  default_locale: 'ru' as 'ru' | 'uz' | 'zh-CN',
  pin_relock: false,
  block_issue_if_unpaid: false,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  if (!row) return SETTING_DEFAULTS[key];
  return row.value as SettingValue<K>;
}

export async function getAllSettings(): Promise<Record<SettingKey, unknown>> {
  const rows = await db.select().from(settings);
  const result: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    if (row.key in SETTING_DEFAULTS) result[row.key] = row.value;
  }
  return result as Record<SettingKey, unknown>;
}

export async function setSetting(
  key: SettingKey,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy, updatedAt: new Date() } });
}
