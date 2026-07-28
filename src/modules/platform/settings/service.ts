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
  /** Days of silence before a client counts as gone quiet (owner: 60). */
  crm_dormant_days: 60,
  /**
   * Whether the CRM may SEND on a manager's personal Telegram (phase 4).
   *
   * Default OFF, and that is the point of it being a setting: deploying the
   * code must not, by itself, make anybody's own account start sending. It is
   * also the switch to reach for first if an account is ever flagged — one
   * change, every manager, immediately.
   */
  tg_sending_enabled: false,
  /**
   * How far the cargo may differ from the quote before anyone is told
   * (docs/DEALS.md answer 1: "notify above 10 %, never block loading").
   * A setting rather than a constant because the owner asked for it to be one.
   */
  deal_deviation_threshold_pct: 10,
  costing_base_currency: 'USD',
  client_code_prefix: 'GS',
  label_size: '100x100',
  translation_provider: 'libretranslate',
  default_locale: 'ru' as 'ru' | 'uz' | 'zh-CN' | 'en',
  pin_relock: false,
  block_issue_if_unpaid: false,
  // VED document header (spec W6) — owner supplies real values (open Q4).
  company_name: 'GSR LOGISTICS',
  company_address: '—',
  company_phone: '—',
  // INVOICE & PACKING LIST requisites — defaults taken from the owner's real
  // ka23 invoice file (feedback round 6); all editable in admin settings.
  ved_sender:
    'SHENZHEN SUNSHINE INTERNATIONAL LOGISTICS CO.,LTD\nADD: Room 1505, No.15, Niulanqian Building, minzhi road, Longhua new district, Shenzhen city, China',
  ved_seller:
    'Yiwu Attila International Trade Co., LTD\nАдрес: 15TH FLOOR, BUILDING A, FORTUNE BUILDING, FUTIAN STREET, YIWU, JINHUA, CHINA (ZHEJIANG) PILOT',
  ved_consignee:
    '"UNIVERSAL ELEGANCE МЧЖ" (311770414)\nМанзил: Андижон шахар храбек куча 15 уй\nБанк: УзМиллийбанк Андижон вилояти булими\nТел.: +998 97 991 00 09 Сидиков Ш',
  ved_transport: 'авто транспорт',
  ved_delivery_terms: 'CIP Андижан',
  ved_customs_post: 'Андижон ВЭД / 03011',
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
