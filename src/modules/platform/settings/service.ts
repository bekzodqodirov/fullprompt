import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { settings } from '../db/schema';
import { parseDayOrInstant } from '../time/tashkent';
import { originsSettingValid } from '../http/origins';
import { reasonListValid } from './reason-list';
import { OPEN_CALC_CAP_SEAT_DEFAULT, readOpenCalcLimit } from './calc-cap';

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
  /**
   * «Olib ketilmagan yuk» (0116, the owner's 3a): after this many Tashkent
   * days in an issuing warehouse a client's cargo is announced to their
   * seller and on the office's svodka (level 1), and again at the alarm
   * (level 2). The claim is keyed on the LEVEL, never the number, so moving
   * either does not re-announce everybody.
   */
  uncollected_warn_days: 5,
  uncollected_alarm_days: 10,
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
   * How many OFFICE minutes an advert lead may wait for its first contact
   * before the owner is reminded (0113, his 5a: «15 minutdan keyin …»). Read
   * when the lead LANDS and frozen onto its arrival, like the quote's
   * validity; the sweep also asks it, so 0 switches the reminder off at once.
   * The measurement on /crm/tahlil does not read it — turning a reminder off
   * must not move anybody's numbers.
   */
  inbound_contact_minutes: 15,
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
   * How close a customs-import name must be to the VED's typed one before
   * its price fills the baza by itself (0..1, pg_trgm similarity).
   *
   * The owner's rule: «qanchalik togriligiga qarab olamiz agar togri bolmasa
   * baza yoq deb ved hodimi ozi qoyadi» — so this number is the line between
   * «fill it and mark it 📥» and «leave it empty and offer the list». 0.45 is
   * a first guess to be tuned on his real quarterly file; raising it fills
   * fewer rows and guesses less.
   */
  import_baza_min_sim: 0.45,
  /**
   * How close a product NAME must be to a sealed one before the AI-VED takes
   * that seal's baza (0096).
   *
   * Higher than the import's 0.45 on purpose: a memory hit outranks the
   * customs file, and what it copies is a price a person put their ✅ on for
   * a different consignment. A near-miss there is worse than none — the file
   * is still behind it, and the VED types the rest.
   */
  calc_memory_min_sim: 0.6,
  /**
   * How close a lot's NAME must be to a past lot's before «Oldingi narx»
   * shows that lot's truck price (0119). Its own number, not the memory's:
   * the corpus is every prixod ever received, not sealed calculations, and
   * the owner tunes the two apart.
   */
  price_history_min_sim: 0.6,
  /**
   * How many AI calls the calculation half may make in a day (0096).
   *
   * A soft budget, not a claim: one worker drains this queue, so two passes
   * cannot race past it the way ten people asking the assistant can (that one
   * reserves its slot atomically in `ai_questions`). Over the budget the pass
   * still runs on the sealed memory, the dictionaries and the customs file —
   * and the reply says the model was not asked.
   */
  ai_calc_daily_limit: 200,
  /**
   * How many times a day «Oldingi narx»'s 🤖 may ask the model (0119). Its
   * own count, not `ai_calc_daily_limit`'s: the accountant presses it across
   * a truck's lots, and a shared budget would let those presses stop the
   * VED's Telegram estimates until midnight.
   */
  price_history_ai_daily_limit: 50,
  /**
   * How many times a day the Bojxona tab's 🤖 may ask the model — the whole
   * company's presses together (0144, docs/TARKIB-TAKLIFLAR.md §2). One press
   * of «🤖 AI taklif (N)» is up to N calls, and before this the button had no
   * ledger row and no ceiling at all. Its own count, never
   * `ai_calc_daily_limit`'s. **0 switches the button off** — a cap on a bill
   * must not read «no cap» (the calc limit's 0 does, and is not copied).
   */
  tnved_ai_daily_limit: 300,
  /**
   * How many times a day «🤖 Fayldan to'ldirish» may ask the model to read a
   * client's document into a tarkib (0144, §3) — the whole company's
   * readings together. EVERY reading is one: a PDF, a photograph and a
   * spreadsheet alike (the spreadsheet goes to the model as text; the design
   * judge struck the «Excel is read with no model» path, which had three
   * answers to «does it count»). 0 switches the reading off.
   */
  tarkib_ai_daily_limit: 50,
  /**
   * The ✅ / ❌ row under the customer's «yukingiz qabul qilindi» push (0144,
   * §4 — his 5b). A switch because it is the one thing in that round that
   * writes to CUSTOMERS by itself: off, the push goes out exactly as before,
   * and «Mijozdan so'rash» on the prixod card still asks on a person's press.
   */
  client_confirm_on_receipt: true,
  /**
   * Ask the client AGAIN, by itself, when a re-weigh makes the question they
   * hold describe cargo that no longer exists (the owner's «1 b» of
   * 2026-11-12, docs/PRIXOD-JAVOBLAR.md §1 — `wms/receipts/client-reask.ts`).
   * On by his answer; a switch for the same reason as the one above: it writes
   * to CUSTOMERS by itself. Off: nothing is armed, a question already held is
   * not sent, and «Mijozdan so'rash» on the card still asks on a press.
   */
  client_reask_on_reweigh: true,
  /**
   * Write the AI-VED's estimate onto the card's lenta as well as into the
   * seller's chat (his answer 2a). A switch because it is the only thing on
   * this path that writes where OTHER people read.
   */
  ai_calc_reply_lenta: true,
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
   * Which cost types the truck's cost form PRESELECTS «yo'lkira tarifi
   * bo'yicha» for (0132, his 4a), as a JSON list of codes — the seeded
   * «Дорога / Yo'lkira» by default. It decides the preselection only: the
   * freight basis may be chosen by hand on any non-customs truck bill, and
   * «boshqa turlar og'irlik bo'yicha qoladi» is the default, not a lock.
   * Data for the same reason as the customs list: he mints his own types.
   */
  freight_tariff_cost_type_codes: '["freight"]',
  /**
   * The expense category an upsale payout is written into (VED phase D).
   *
   * MANDATORY and deliberately not overridable at the moment of paying: a
   * commission paid to a seller out of «Oyliklar» would read as salary on the
   * P&L's line, and on the recurring due list it would sit beside that
   * seller's monthly salary (a template since 0099, paid by «To'landi» since
   * 0106) as a look-alike payment. Empty = nobody has chosen one, and the
   * payout refuses with a sentence rather than guessing.
   */
  upsale_expense_category_id: '',
  /**
   * The expense category a KPI payout is written into (0117) — the upsale
   * category's rule for the same reason: mandatory, and refused in words while
   * empty, because a commission paid out of «Oyliklar» would sit on the salary
   * line and close that seller's month on the due list.
   */
  kpi_expense_category_id: '',
  /**
   * Which expense category IS the salary (0117, /hodimlar): a person's
   * recurring template in it reads as their «Oylik», any other template of
   * theirs as «Boshqa doimiy to'lovlar». Empty = every template naming a
   * person reads as salary, and the screen asks for the category in words.
   */
  salary_expense_category_id: '',
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
  /**
   * The two funnel stages the AI seller moves a lead to by itself (SPEC-P2-v2 §3.1, his item 4 ⭐): «AI birinchi
   * javob berdi» after its first reply went, «AI narx aytdi» after a price went. Forward only, between OPEN
   * stages — «Yutildi» and «Yo'qotildi» stay a person's, always. Empty = the AI moves nothing (how it ships).
   * OWN-DOOR (`OWN_DOOR_KEYS`): written only by /crm/settings, never by this screen's generic form.
   */
  crm_ai_contacted_stage: '',
  crm_ai_quoted_stage: '',
  /**
   * The markup the AI adds to the VED's answer before it tells the customer (SPEC-P2-v2 §2.1, his «foiz yokida fix
   * summa qoshib ayitshni belgilash»): `percent` or `fixed` dollars, and the value as a decimal STRING — empty =
   * NO markup, the AI quotes the VED's own figure (his answer of 2026-11-14, «bosh tursa usha yer ustama qoymasdan ozi
   * narx beraversin» — SPEC-P2-v2 §00 A1; a value that cannot be read fails closed). OWN-DOOR: written on /suhbatlar/ai
   * by the AI's holder or a super_admin, audited, and a change retires what was priced on the old rule.
   */
  agent_calc_markup_kind: 'percent' as 'percent' | 'fixed',
  agent_calc_markup_value: '',
  /**
   * How many calculation requests the AI seat may have open at once (SPEC-P2-v2 §1.3, his §7 Q11 ⭐ a: 100) — the
   * one bound on VED jobs and AI-VED calls for a machine with no daily count. Only while the seat holds the
   * account (`holderIsSeat`); every person keeps 20. A whole number 1..200, never 0 («no cap»). OWN-DOOR: written
   * on /suhbatlar/ai by a super_admin only — raising it is a widening, not a brake.
   */
  agent_calc_open_limit: OPEN_CALC_CAP_SEAT_DEFAULT,
  /**
   * The full AI seller's stage 1a (docs/ai-toliq/qurish/STAGE-0-1A.md §3.3) — each OWN-DOOR (`OWN_DOOR_KEYS`): the
   * generic form below never writes them. The kernel lands the key, its shape and its words; the package that
   * draws the box writes it (§3.3's last paragraph). A key read inside a transaction is read on that transaction.
   *
   * The persona's name (his answer 1, «GSR sotuv menejeri <ism>»): the AI introduces itself as «GSR sotuv menejeri»
   * with this name, and never says it is a person. Empty = no name. Letters (an Uzbek apostrophe inside a word —
   * «G‘ayrat» — is a letter of the name) and single spaces, at most 40 characters. Written on /suhbatlar/ai by a
   * super_admin. A NAME is data: no name of anybody is written in code.
   */
  agent_persona_name: '',
  /**
   * How long an ORDINARY reply waits on its card before it goes by itself, in seconds (his 11 a «suhbat darhol»,
   * and his ⭐ a of question 82: 0). 0-600; a price keeps `agent_auto_config.hold_sec` (30-600, 0145). Written on
   * /suhbatlar/ai by the holder or a super_admin (`mayTuneAuto`), as the price hold is.
   */
  agent_talk_hold_sec: 0,
  /**
   * Which prices may go by themselves between 22:00 and 08:00 Tashkent (his 4 a ⚠ and question 1 ⭐ a): `none`,
   * `table` (a truck-table or avia price goes after its hold; a VED price waits for the morning) or `all`.
   * Ordinary talk is never night-barred; the AI never writes FIRST at night. The holder or a super_admin.
   */
  agent_night_prices: 'table' as 'none' | 'table' | 'all',
  /**
   * The big-cargo signal's line in kub (his 3 b: «20 kub yoki fura»): a customer who states this much or more makes
   * the AI answer as ever AND tells the people designated for «Katta yuk signali». 0 = no size signal. 0-200, whole.
   * A super_admin's, on /suhbatlar/ai.
   */
  agent_big_cargo_m3: 20,
  /** «Fura», «to‘liq mashina» alone also signal (his 3 b), whatever the kub. A super_admin's. */
  agent_big_cargo_words: true,
  /**
   * Minutes a customer's line written in working hours may stand unanswered before ONE alarm goes to the
   * «rahbar va o‘rinbosar» pair (stage 1a §4.5 — the condition for taking the card off ordinary talk). 0 = off;
   * otherwise 3-120 (under 3 a healthy run — the debounce plus the model — would alarm). The holder or a super_admin.
   */
  agent_liveness_minutes: 10,
  /**
   * How long an AIR shipment takes, as «N-M» whole days (his 2 b: «3-5 kun» — no «reys bo‘lsa» clause): ONE reader
   * hands it to the prompt, the company-rule sources, the avia tool and the page (J2). 1-60 days, N below M. The
   * holder or a super_admin, on /suhbatlar/ai.
   */
  agent_avia_days: '3-5',
  /**
   * Show the AI's Telegram to clients with no seller of their own (his 7 b): the bot's «💬 Menejer», the Mini App's
   * contact card and the pushes' door name the seat. A client WITH a seller never sees it. Ships off. A
   * super_admin's, on /suhbatlar/ai.
   */
  client_ai_contact: false,
  costing_base_currency: 'USD',
  client_code_prefix: 'GS',
  /**
   * The next number the generator hands out (round 112). Empty = not set:
   * the generator keeps following the book's densest run, as it always has.
   * Only the generator advances it; a typed or imported code never does.
   */
  client_code_next: '',
  /**
   * The staff group's weekly TEAM goal in kub (0134, his 8a): the Saturday
   * rating draws «32 / 40 kub» with a bar, so everybody pulls one number up
   * and nobody is shamed for a low line. 0 = no goal, no line.
   */
  staff_rating_goal_m3: 0,
  /**
   * From which day a cost with no payer is the accountant's to place (0101):
   * the «kassasi ko'rsatilmagan» queue and the home counter start here.
   * Written by the migration on deploy day — every earlier cost has no kassa
   * by construction and is inside some till's counted opening balance.
   * Empty = no bound.
   */
  cost_kassa_since: '',
  /**
   * From which moment cargo with no price is handed over only with a
   * permission (0104, the owner's Q3b: «ruxsat berilmasa olib ketolmasin,
   * taqiq tursin»). Written by the migration as the deploy instant, Tashkent
   * wall clock with its offset, so an admin reads it; cargo standing in the
   * warehouses before it was never priced through the system and is listed,
   * not stopped. A day (`YYYY-MM-DD`) or an instant WITH an offset; EMPTY
   * switches the ban off. Anything else is refused at the save
   * (`SETTING_VALIDATORS`) and, if it reaches the table by hand, FAILS CLOSED
   * (`finance/unpriced.ts` `parseGateSince`).
   */
  unpriced_gate_since: '',
  /**
   * Whether the system closes a dollar residue BY ITSELF when a client's,
   * firm's or staff account reaches zero in its own currency (0103, the
   * owner's Q14 A). The kill-switch: «no» writes no NEW «kurs farqi» row, but
   * the rows already written go on being maintained — a stale one would
   * corrupt a balance the handover gate reads. Its partner twin
   * `fx_residue_since` is written by the migration and is deliberately NOT
   * here: no screen may move it (moving it back would post every hand-closed
   * residue a second time).
   */
  fx_residue_auto: true,
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
  /**
   * Which web pages may ask «who should this visitor write to?» (round 113),
   * space-separated exact origins. The website's questionnaire runs in the
   * visitor's browser, and the browser names the page it came from — so this
   * list is what stops somebody else's page from handing out our managers'
   * usernames and filling their load. A CSRF fence, not authentication: a
   * script outside a browser can type any origin it likes, and the rate limit
   * is what covers that.
   */
  lead_assign_origins: 'https://gsrlogistics.uz https://www.gsrlogistics.uz',
  /**
   * Website visitors to the AI seat (his 6 c, stage 1a §4.7): `off` — the least-busy ticked seller, as today; `all`
   * — every visitor but «Sotib olib berish» goes to the AI when it can take one, and to the roster when it cannot
   * (never «nobody» because of the AI). Ships `off` (his ⭐ 1: switched on after stage 2). OWN-DOOR: written on
   * /admin/taqsimot beside the roster it bypasses, where its line of truth («AI hozir qabul qiladi / qila olmaydi»)
   * is drawn — never as a bare value on the generic form.
   */
  lead_assign_ai: 'off' as 'off' | 'all',
  /**
   * Lost reasons that mean «never again» to the client-finding agent
   * (2026-10-23, docs/AGENT-FEED.md). `;`-separated labels, matched
   * case-insensitively against `leads.lost_reason` — the TEXT chosen at the
   * move, so a renamed reason keeps suppressing under its old spelling only
   * while that spelling stays listed here. Read by /api/agent/suppression and
   * by the agent door's landing belt; nothing else.
   */
  agent_no_contact_reasons: 'Qayta qilinmasin',
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

/**
 * What a typed value must look like before the settings screen stores it.
 * `updateSettingAction` asks this before `setSetting`, and a refusal writes
 * NOTHING and says so in words (#472). The map exists so the next key that
 * needs a shape needs no second mechanism; today one key does — the
 * unpriced-cargo ban, where a typo would otherwise be read as «off».
 */
export const SETTING_VALIDATORS: Partial<Record<SettingKey, (raw: string) => boolean>> = {
  unpriced_gate_since: (raw) => parseDayOrInstant(raw) !== null,
  lead_assign_origins: originsSettingValid,
  agent_no_contact_reasons: reasonListValid,
  // The two pressed-AI ceilings (0144): 0 is «switched off for the whole
  // company», so the door must not let a typo BECOME 0 — an empty box is
  // `Number('') === 0`, «1 000» stored nothing and said nothing, «-5» and
  // «3.7» were stored as typed while the cap enforced something else.
  tnved_ai_daily_limit: wholeNumberSettingValid,
  tarkib_ai_daily_limit: wholeNumberSettingValid,
  // The full AI seller's part 2 (SPEC-P2-v2 K5): each own-door key keeps a shape here too, so its own writer and
  // any reader ask ONE rule — a value the shape refuses is read as «off» / the default, never guessed.
  agent_calc_markup_kind: calcMarkupKindValid,
  agent_calc_markup_value: calcMarkupValueValid,
  agent_calc_open_limit: (raw) => readOpenCalcLimit(raw) !== null,
  crm_ai_contacted_stage: stageSettingValid,
  crm_ai_quoted_stage: stageSettingValid,
  // The full AI seller's stage 1a (STAGE-0-1A.md §3.3): every key an own door, every shape here — its writer and
  // any reader ask ONE rule, and a stored value the shape refuses is read as the default, never guessed.
  agent_persona_name: personaNameValid,
  agent_talk_hold_sec: (raw) => wholeIn(raw, 0, AGENT_1A_BOUNDS.talkHoldMax),
  agent_night_prices: (raw) => (AGENT_NIGHT_PRICES as readonly string[]).includes(raw),
  agent_big_cargo_m3: (raw) => wholeIn(raw, 0, AGENT_1A_BOUNDS.bigCargoM3Max),
  agent_big_cargo_words: yesNoValid,
  agent_liveness_minutes: (raw) =>
    raw === '0' || wholeIn(raw, AGENT_1A_BOUNDS.livenessMin, AGENT_1A_BOUNDS.livenessMax),
  agent_avia_days: (raw) => aviaDaysRange(raw) !== null,
  client_ai_contact: yesNoValid,
  lead_assign_ai: (raw) => (LEAD_ASSIGN_AI_MODES as readonly string[]).includes(raw),
};

/**
 * The keys that steer the machine and have a door of their OWN (SPEC-P2-v2 K5): never writable through the generic
 * `/admin/settings` form — it stores a string-default key verbatim when no validator stops it, and its door
 * (`admin.settings.manage`, the whole `admin` role) is not the door of the AI (`mayRunAgent`) nor the funnel's
 * (`crm.manage`). That screen draws them read-only and names the page that changes them; `updateSettingAction`
 * refuses them in words. The value is the page, and the key the bundles' `settings.ownDoorPage` reads.
 */
export const OWN_DOOR_KEYS = {
  agent_calc_markup_kind: 'agentAi',
  agent_calc_markup_value: 'agentAi',
  agent_calc_open_limit: 'agentAi',
  crm_ai_contacted_stage: 'crmSettings',
  crm_ai_quoted_stage: 'crmSettings',
  // Stage 1a (§3.3): the AI page's boxes, and the website's choice on the roster page it bypasses (J20 — a THIRD page).
  agent_persona_name: 'agentAi',
  agent_talk_hold_sec: 'agentAi',
  agent_night_prices: 'agentAi',
  agent_big_cargo_m3: 'agentAi',
  agent_big_cargo_words: 'agentAi',
  agent_liveness_minutes: 'agentAi',
  agent_avia_days: 'agentAi',
  client_ai_contact: 'agentAi',
  lead_assign_ai: 'taqsimot',
} as const satisfies Partial<Record<SettingKey, 'agentAi' | 'crmSettings' | 'taqsimot'>>;

export type OwnDoorKey = keyof typeof OWN_DOOR_KEYS;

/** The page each own door lives on — the link `/admin/settings` draws beside the read-only value. */
export const OWN_DOOR_PAGES: Record<(typeof OWN_DOOR_KEYS)[OwnDoorKey], string> = {
  agentAi: '/suhbatlar/ai',
  crmSettings: '/crm/settings',
  taqsimot: '/admin/taqsimot',
};

export function isOwnDoorKey(key: string): key is OwnDoorKey {
  return Object.prototype.hasOwnProperty.call(OWN_DOOR_KEYS, key);
}

/** The markup's two kinds (SPEC-P2-v2 §2.1). */
export const CALC_MARKUP_KINDS = ['percent', 'fixed'] as const;
export type CalcMarkupKind = (typeof CALC_MARKUP_KINDS)[number];

export function calcMarkupKindValid(raw: string): boolean {
  return (CALC_MARKUP_KINDS as readonly string[]).includes(raw);
}

/** His §7 Q4 ⭐ a: a percent 0.01-100 with at most two decimals; a fixed sum a whole number of dollars 1-5 000. */
export const CALC_MARKUP_BOUNDS = { percentHundredthsMax: 10_000, fixedMax: 5_000 } as const;

/** A percent as hundredths («10.5» → 1050), read from its decimal STRING — never `Number()` on a float. */
export function percentHundredths(raw: string): number | null {
  const m = /^(0|[1-9]\d{0,2})(?:\.(\d{1,2}))?$/u.exec(raw);
  if (!m) return null;
  const h = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return h >= 1 && h <= CALC_MARKUP_BOUNDS.percentHundredthsMax ? h : null;
}

/** A fixed markup in whole dollars, or null. */
export function fixedDollars(raw: string): number | null {
  if (!/^[1-9]\d{0,3}$/u.test(raw)) return null;
  const n = Number(raw);
  return n <= CALC_MARKUP_BOUNDS.fixedMax ? n : null;
}

/**
 * The value alone, as `SETTING_VALIDATORS` sees it (no kind beside it): empty («no markup», §00 A1), or a shape one of
 * the two kinds takes. Its own writer asks the whole rule (`calcMarkupRuleValid`).
 */
export function calcMarkupValueValid(raw: string): boolean {
  return raw === '' || percentHundredths(raw) !== null || fixedDollars(raw) !== null;
}

/** The whole rule: the kind, and a value that kind takes — or an empty value («no markup», §00 A1). */
export function calcMarkupRuleValid(kind: string, value: string): boolean {
  if (!calcMarkupKindValid(kind)) return false;
  if (value === '') return true;
  return kind === 'percent' ? percentHundredths(value) !== null : fixedDollars(value) !== null;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A funnel stage setting: empty («do nothing») or a stage id. Whether it names an OPEN, active stage is its door's. */
export function stageSettingValid(raw: string): boolean {
  return raw === '' || UUID_SHAPE.test(raw);
}

/** A whole number, typed as digits and nothing else — «0» is allowed and means off. */
export function wholeNumberSettingValid(raw: string): boolean {
  return /^\d{1,6}$/.test(raw);
}

/**
 * Stage 1a's bounds (STAGE-0-1A.md §3.3), ONE home: the shapes above, the writers that draw the boxes and the words
 * that name the bounds read these, never a second copy. The price hold's own bounds are 0145's CHECK (30-600).
 */
export const AGENT_1A_BOUNDS = {
  talkHoldMax: 600,
  bigCargoM3Max: 200,
  livenessMin: 3,
  livenessMax: 120,
  aviaDaysMax: 60,
  personaMax: 40,
} as const;

/** `agent_night_prices` — which prices go by themselves at night (his 4 a, question 1 ⭐ a: `table`). */
export const AGENT_NIGHT_PRICES = ['none', 'table', 'all'] as const;
export type AgentNightPrices = (typeof AGENT_NIGHT_PRICES)[number];

/** `lead_assign_ai` — the website's visitors to the sellers, or to the AI (his 6 c). */
export const LEAD_ASSIGN_AI_MODES = ['off', 'all'] as const;

/** A whole number in [min, max], written the way a person writes it: digits, no sign, no leading zero. */
function wholeIn(raw: string, min: number, max: number): boolean {
  if (!/^(0|[1-9]\d{0,5})$/u.test(raw)) return false;
  const n = Number(raw);
  return n >= min && n <= max;
}

/** A yes / no own-door key as its writer posts it. */
function yesNoValid(raw: string): boolean {
  return raw === 'true' || raw === 'false';
}

/**
 * The persona's name: empty, or words of letters separated by ONE space, at most `personaMax` characters. An Uzbek
 * apostrophe between two letters («G‘ayrat», «Ra'no» — five spellings of it are typed) belongs to the word; a digit,
 * a dot, an emoji or a leading apostrophe does not (the name is spoken to customers as written).
 */
export function personaNameValid(raw: string): boolean {
  if (raw === '') return true;
  if ([...raw].length > AGENT_1A_BOUNDS.personaMax) return false;
  return /^[\p{L}\p{M}]+(?:['ʻʼ‘’][\p{L}\p{M}]+)*(?: [\p{L}\p{M}]+(?:['ʻʼ‘’][\p{L}\p{M}]+)*)*$/u.test(raw);
}

/**
 * «N-M» whole days of an air shipment (his 2 b: «3-5 kun»), read from the string: N from 1, M up to
 * `aviaDaysMax`, N below M — a range, never one figure (a single number reads as a promise). Null = not that shape;
 * a reader treats a stored value it cannot read as the default.
 */
export function aviaDaysRange(raw: string): AviaDays | null {
  const m = /^([1-9]\d?)-([1-9]\d?)$/u.exec(raw);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  return min < max && max <= AGENT_1A_BOUNDS.aviaDaysMax ? { min, max } : null;
}

/** An air shipment's whole days, as `aviaDaysRange` reads them: N below M. */
export interface AviaDays {
  readonly min: number;
  readonly max: number;
}

/** The shipped «3-5» (his 2 b), read by the same shape — what a stored value nobody can read falls back to. */
export const AVIA_DAYS_DEFAULT: AviaDays = aviaDaysRange(SETTING_DEFAULTS.agent_avia_days)!;

/**
 * The flight's days (stage 1a P7, J2, his 2 b: «3-5 kun» — no «reys bo‘lsa» clause) — the ONE reader of
 * `agent_avia_days`: what the prompt's rule 9, the avia tool (its description, its words, its day sources), the
 * company rule the policy vouches by (run `memoryFor`) and the AI page say, read ONCE per run so every one of them
 * says the same days — and read again by every policy check (`policyFor`), so a draft written before he changed it is
 * judged at ✅ by today's pair. The stored value when its shape holds, else the default — a value typed into the table
 * by hand is never guessed at. On the pool: never inside a transaction (#714), and never from the listener — the send
 * step re-prices the flight by its rate alone and states no day.
 */
export async function aviaDays(): Promise<AviaDays> {
  const raw = await getSetting('agent_avia_days');
  return aviaDaysRange(String(raw)) ?? AVIA_DAYS_DEFAULT;
}

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  if (!row) return SETTING_DEFAULTS[key];
  return row.value as SettingValue<K>;
}

/**
 * The ordinary reply's hold in seconds (stage 1a, `agent_talk_hold_sec`), as its readers use it: the stored value
 * when its shape holds, else the default — a value typed into the table by hand is never guessed at. On the pool:
 * a reader inside a transaction reads the row on that transaction instead (#714).
 */
export async function readAgentTalkHoldSec(): Promise<number> {
  const raw = await getSetting('agent_talk_hold_sec');
  return SETTING_VALIDATORS.agent_talk_hold_sec!(String(raw)) ? Number(raw) : SETTING_DEFAULTS.agent_talk_hold_sec;
}

/**
 * Which prices go by themselves at night (stage 1a, `agent_night_prices`, his 4 a), as the gate reads it: the stored
 * value when it is one of the three, else the default — a value typed into the table by hand is never guessed at. On
 * the pool: the gate's facts are read before any transaction is open (#714).
 */
export async function readAgentNightPrices(): Promise<AgentNightPrices> {
  const raw = await getSetting('agent_night_prices');
  return SETTING_VALIDATORS.agent_night_prices!(String(raw)) ? (String(raw) as AgentNightPrices) : SETTING_DEFAULTS.agent_night_prices;
}

/**
 * The persona's name as the AI says it (stage 1a P3): the stored value when it has the setting's shape, else none — a
 * row written by hand that the shape refuses is never spoken to a customer. Read on the pool, once per run and at each
 * policy check; never inside a transaction.
 */
export async function readAgentPersonaName(): Promise<string> {
  const raw = await getSetting('agent_persona_name');
  return typeof raw === 'string' && personaNameValid(raw) ? raw : '';
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
