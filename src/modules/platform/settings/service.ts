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
  // The owner's numbers (2026-07-28): green to 150, yellow to 250, light red
  // to 450, dark red above. Migration 0040 moves a stored row off the old
  // 200/300/400 default; anything else there is his own edit and stays.
  density_thresholds: { light: 150, medium: 250, heavy: 450 },
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
  /**
   * How long an approved "issue to this debtor" stays usable (phase 6).
   * Long enough for the client to reach the warehouse the same day; short
   * enough that last week's permission never opens today's bigger debt.
   */
  debt_approval_ttl_hours: 24,
  /**
   * How long a client may wait for an answer before their manager is
   * reminded (staff bot, round 36). A setting because the honest number is
   * the owner's to choose: too short and the reminder is noise during a
   * phone call, too long and the point of it is gone. 0 switches it off.
   */
  unanswered_reminder_minutes: 30,
  /**
   * How long a sealed VED price stands before it has to be recalculated
   * (owner: «bu narx turishi menimcha 1 oy bo'lgani yaxshi»).
   *
   * Read when the price is SEALED and frozen onto that version, so shortening
   * this never shortens a quote the client is already holding. Expiry itself
   * is decided at read time — there is no sweep and nothing to fall behind.
   */
  quote_valid_days: 30,
  /**
   * The month the dictionary review was last announced, as `YYYY-MM`.
   *
   * A CLAIM and not a preference — it is written by the sweep, never by a
   * person, and the settings screen shows it read-only-ish for the same
   * reason the backup panel shows its last run: an owner who wonders why the
   * reminder is quiet can see when it last spoke. Empty means «never».
   */
  calc_review_notified_month: '',
  /**
   * How long after the cargo LANDS the rastamojka figure counts as final
   * (VED phase E1).
   *
   * The clock starts at arrival and not at the seal, because the road is a
   * ten-day floor and a quote may stand for a month before the cargo even
   * ships — measured from the seal, every accuracy table would be empty until
   * about the 18th of any month. Before this many days, a calculation with no
   * cost typed against it reads «xarajat kiritilmagan» and is not scored.
   */
  calc_actual_settle_days: 7,
  /**
   * How far the rastamojka may differ from the quote before it is worth
   * looking at (VED phase E1). Its own number and not the deal threshold:
   * that one is about CARGO measuring differently, this one about money.
   */
  calc_customs_deviation_pct: 15,
  /**
   * Which cost types ARE «rastamojka», as a JSON list of codes.
   *
   * Data and not a constant, because the owner mints his own cost types and a
   * new one gets a `t_…` code that is matched by nothing. When a real customs
   * bill lands under a type that is not on this list the screen refuses the
   * comparison and NAMES the types it found, so the mapping is discoverable
   * rather than silently wrong.
   */
  calc_customs_cost_type_codes: '["customs"]',
  /**
   * The expense category an upsale payout is written into (VED phase D).
   *
   * MANDATORY and deliberately not overridable at the moment of paying:
   * `generateRecurring`'s idempotence slot is (category, date, employee,
   * warehouse) with no discriminator, so a commission paid to a seller out of
   * «Oyliklar» would occupy that month's salary slot and the salary would be
   * silently counted as already posted. Empty = nobody has chosen one, and
   * the payout refuses with a sentence rather than guessing.
   */
  upsale_expense_category_id: '',
  /**
   * The funnel stage a request for a price lands on (owner, round 83: «kim
   * botga tashlayotgan bo'lsa o'sha odamning accountiga biriktirilishi kerak
   * … va hisoblatish etapiga tushishi kerak»).
   *
   * A SETTING and not a column, because it names ONE stage — unlike
   * `deal_stages.cargo_trigger`, which had to say a different thing about
   * five. Empty means «leave the card where it is», which is what an
   * installation that has never opened this screen gets. Stored as an id;
   * a stage that is later deleted or closed simply stops matching, and the
   * lead lands on the first open stage as it did before.
   */
  crm_calc_stage: '',
  /** The same, for the DEAL board — a coded client's request lands there. */
  deal_calc_stage: '',
  costing_base_currency: 'USD',
  client_code_prefix: 'GS',
  /**
   * The next number the generator hands out (round 112). Empty = not set:
   * the generator keeps following the book's densest run, as it always has.
   * Only the generator advances it; a typed or imported code never does.
   */
  client_code_next: '',
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
  /**
   * AI questions per person per day, both doors together (bot + /ai). A
   * backstop against a runaway loop or a bored thumb, not a meter: the count
   * lives in `ai_questions`, so it survives restarts and is shared by every
   * process. 0 switches the assistant off without touching the key.
   */
  ai_daily_limit: 40,
  /**
   * Bazaviy hisoblash miqdori, in so'm (2026: 412 000). The customs FEE is a
   * step scale over the declaration's value measured in BHM, and the law
   * moves this number about once a year — a setting, so the owner types the
   * new figure instead of waiting for a deploy. The engine converts the
   * so'm fee to USD through the day's FX rate and refuses with a sentence
   * when no UZS rate exists, never inventing one.
   */
  bhm_uzs: 412000,
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

/**
 * The row every settings change is audited against.
 *
 * `audit_log.entity_id` is a uuid, and a setting's identity is its KEY — so
 * one fixed id carries them all and the key travels in before/after. Exported
 * because a setting may also be written from a picker on the screen it
 * belongs to (`upsale_expense_category_id`), and two doors writing two
 * different entity ids would split one setting's history in half.
 */
export const SETTINGS_AUDIT_ID = '00000000-0000-0000-0000-000000000001';

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
