import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Conventions (docs/ARCHITECTURE.md §0): UUIDv7 app-generated PKs for entity
// tables, bigint identity for append-only logs, text+CHECK instead of pg
// enums, timestamptz UTC everywhere, soft delete via active/voided.

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    phone: text('phone').notNull().unique(),
    username: text('username').unique(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    quickPinHash: text('quick_pin_hash'),
    locale: text('locale').notNull().default('ru'),
    // Telegram mute list (spec §11): event type names, or 'all'. The in-app
    // bell is never muted — it mirrors everything.
    mutedNotificationTypes: jsonb('muted_notification_types').notNull().default([]),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('users_locale_check', sql`${t.locale} IN ('ru', 'uz', 'zh-CN', 'en')`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    deviceLabel: text('device_label'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    identifier: text('identifier').notNull(),
    ip: inet('ip').notNull(),
    success: boolean('success').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('login_attempts_lookup_idx').on(t.identifier, t.ip, t.createdAt)],
);

// ---------------------------------------------------------------------------
// RBAC (data-driven, spec §16)
// ---------------------------------------------------------------------------

export const roles = pgTable('roles', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  /** Ships with the app: renameable, but never deletable. */
  isSystem: boolean('is_system').notNull().default(true),
  /**
   * Set the first time someone edits this role's grants. From then on the
   * seed leaves the role alone — otherwise the next deploy would restore
   * every permission the owner had just taken away.
   */
  grantsCustomised: boolean('grants_customised').notNull().default(false),
  createdAt: createdAt(),
});

export const permissions = pgTable('permissions', {
  id: id(),
  code: text('code').notNull().unique(),
  description: text('description'),
  createdAt: createdAt(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    /** 'seed' = shipped with the app, 'admin' = someone chose it. */
    source: text('source').notNull().default('seed'),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    check('role_permissions_source_check', sql`${t.source} IN ('seed', 'admin')`),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const userWarehouses = pgTable(
  'user_warehouses',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.warehouseId] })],
);

// ---------------------------------------------------------------------------
// Warehouses & clients (platform registries)
// ---------------------------------------------------------------------------

export const warehouses = pgTable(
  'warehouses',
  {
    id: id(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    country: varchar('country', { length: 2 }).notNull(),
    type: text('type').notNull(),
    timezone: text('timezone').notNull(),
    batchPrefix: text('batch_prefix').notNull(),
    address: text('address'),
    /** Optional storage capacity for the fill indicator (owner request, M6). */
    capacityM3: numeric('capacity_m3', { precision: 12, scale: 2 }),
    /**
     * Does a client collect their cargo here? (owner: only TAS and AND.)
     *
     * Handover used to be a permission alone, which handed every warehouse
     * operator a screen no client would ever stand in front of.
     */
    issuesToClients: boolean('issues_to_clients').notNull().default(false),
    // Letter sequencer state (spec 5.3): position is the 0-based index into
    // the A..ZZ sequence *before* blacklist skipping; cycleNo increments on
    // ZZ→A wrap. Locked with SELECT ... FOR UPDATE at receipt confirmation.
    letterPosition: integer('letter_position').notNull().default(0),
    letterCycleNo: integer('letter_cycle_no').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'warehouses_type_check',
      sql`${t.type} IN ('origin', 'hub', 'customs', 'distribution')`,
    ),
  ],
);

export const clients = pgTable(
  'clients',
  {
    id: id(),
    clientCode: text('client_code').notNull(),
    name: text('name').notNull(),
    phones: jsonb('phones').notNull().default([]),
    salesManagerId: uuid('sales_manager_id').references(() => users.id),
    messengerNote: text('messenger_note'),
    notes: text('notes'),
    /**
     * CRM follow-up (Phase 2.3). Lives on the client card rather than in a
     * separate table so a sales manager has ONE "who am I calling today"
     * list covering leads and existing clients alike.
     */
    nextActionAt: date('next_action_at'),
    nextActionNote: text('next_action_note'),
    /**
     * The human being behind the code, when one person holds several
     * (Phase 2.3). Declared without a drizzle reference on purpose: the FK
     * exists in SQL, but `crm_people` lives in the wms schema file and
     * platform never imports wms (ARCHITECTURE §0).
     */
    personId: uuid('person_id'),
    /**
     * The language this client reads their cabinet in (migration 0033).
     *
     * NULL means nobody has asked yet — different from "they chose Uzbek" —
     * so the bot may seed it once from Telegram's own language_code and stop
     * guessing the moment the client picks for themselves. Three values, not
     * the staff four: no customer here reads Chinese.
     */
    locale: text('locale'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('clients_code_unique').on(t.clientCode),
    check('clients_locale_check', sql`${t.locale} IS NULL OR ${t.locale} IN ('uz', 'ru', 'en')`),
    check('clients_code_upper_check', sql`${t.clientCode} = upper(${t.clientCode})`),
    index('clients_sales_manager_idx').on(t.salesManagerId),
    index('clients_next_action_idx').on(t.nextActionAt),
    index('clients_person_idx').on(t.personId),
  ],
);

// ---------------------------------------------------------------------------
// Settings, currencies, FX, letter blacklist
// ---------------------------------------------------------------------------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: updatedAt(),
});

export const currencies = pgTable('currencies', {
  code: varchar('code', { length: 3 }).primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

// fx_rates lives in wms.ts since M6: the M0 placeholder was pair-based
// (from/to); costing needs one USD-base rate per currency per date, so
// migration 0012 replaced the (never-written) table wholesale.

export const letterBlacklist = pgTable(
  'letter_blacklist',
  {
    combo: text('combo').primaryKey(),
    addedBy: uuid('added_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'letter_blacklist_combo_check',
      sql`${t.combo} = upper(${t.combo}) AND char_length(${t.combo}) BETWEEN 1 AND 2`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Audit log (append-only; grants stripped in migration SQL) & domain events
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entityType, t.entityId, t.createdAt),
    index('audit_actor_idx').on(t.actorId, t.createdAt),
    index('audit_warehouse_idx').on(t.warehouseId, t.createdAt),
  ],
);

export const events = pgTable(
  'events',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    actorId: uuid('actor_id').references(() => users.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('events_unprocessed_idx')
      .on(t.occurredAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Notifications & Telegram
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    eventId: bigint('event_id', { mode: 'bigint' }).references(() => events.id),
    channel: text('channel').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    /** Telegram sends that failed; at the cap the row goes terminal. */
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('notifications_channel_check', sql`${t.channel} IN ('in_app', 'telegram')`),
    check(
      'notifications_status_check',
      sql`${t.status} IN ('pending', 'sent', 'failed', 'muted')`,
    ),
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const telegramLinks = pgTable(
  'telegram_links',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }).unique(),
    linkCode: text('link_code').unique(),
    status: text('status').notNull().default('pending'),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('telegram_links_status_check', sql`${t.status} IN ('pending', 'linked', 'revoked')`),
  ],
);

/**
 * Client cabinet links (Phase 2.2): a CLIENT (not a staff user) connected to
 * the same bot via a one-time code minted by staff. A chat may represent
 * several clients (broker) and a client may have several chats.
 */
export const clientTelegramLinks = pgTable(
  'client_telegram_links',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }),
    linkCode: text('link_code').unique(),
    status: text('status').notNull().default('pending'),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'client_telegram_links_status_check',
      sql`${t.status} IN ('pending', 'linked', 'revoked')`,
    ),
    index('client_telegram_links_client_idx').on(t.clientId),
    index('client_telegram_links_chat_idx').on(t.telegramChatId),
  ],
);

// ---------------------------------------------------------------------------
// Attachments (polymorphic files, spec 4.8)
// ---------------------------------------------------------------------------

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    kind: text('kind').notNull().default('file'),
    storageKey: text('storage_key').notNull().unique(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    thumb200Key: text('thumb_200_key'),
    thumb800Key: text('thumb_800_key'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('attachments_kind_check', sql`${t.kind} IN ('photo', 'file', 'generated')`),
    index('attachments_entity_idx').on(t.entityType, t.entityId),
  ],
);

/**
 * Custom fields (owner: "hech qanday biznes-obyekt hard-coded bo'lmasin").
 *
 * Which OBJECTS may carry them is a table rather than a CHECK constraint: a
 * CHECK has to be edited in the SQL, in the drizzle schema, in a zod enum and
 * in a TypeScript union in lockstep, which is exactly the hard-coding the
 * owner asked to be rid of. `custom_entities` is synced from the registry in
 * `platform/fields/registry.ts` by the seed, and a later phase inserts the
 * owner's own entities straight into it.
 */
export const customEntities = pgTable('custom_entities', {
  code: text('code').primaryKey(),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** One field definition. `type` drives the widget, the validation and storage. */
export const customFields = pgTable(
  'custom_fields',
  {
    id: id(),
    entityType: text('entity_type')
      .notNull()
      .references(() => customEntities.code),
    label: text('label').notNull(),
    type: text('type').notNull(),
    /** Choices for select / multiselect; empty for every other type. */
    options: jsonb('options').notNull().default([]),
    /** A hint rendered under the input. */
    help: text('help'),
    /** {min,max,minLength,maxLength,pattern} — server-checked, input-mirrored. */
    rules: jsonb('rules').notNull().default({}),
    /** {fieldId, values:[…]} — render only when another field answers so. */
    showIf: jsonb('show_if'),
    required: boolean('required').notNull().default(false),
    /** Appears as a column and a filter on the list screen. */
    onList: boolean('on_list').notNull().default(false),
    /** For type='lookup': which entity the answer points at. */
    lookupEntity: text('lookup_entity').references(() => customEntities.code),
    sortOrder: integer('sort_order').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'custom_fields_type_check',
      sql`${t.type} IN ('text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox', 'phone', 'url', 'money', 'lookup', 'file')`,
    ),
    check(
      'custom_fields_lookup_check',
      sql`(${t.type} = 'lookup') = (${t.lookupEntity} IS NOT NULL)`,
    ),
    uniqueIndex('custom_fields_label_unique').on(t.entityType, sql`lower(${t.label})`),
    unique('custom_fields_id_entity_uk').on(t.id, t.entityType),
  ],
);

/**
 * One answer per (field, record), in a column of the right TYPE.
 *
 * A single jsonb blob sorted numbers as text and could not be indexed for a
 * range filter — and the owner asked to filter and sort by these fields, so
 * "5" ordering before "40" is a wrong answer rather than a cosmetic one.
 * `value_ref` holds a lookup's target row or a file field's attachment group;
 * it carries no foreign key because its table varies by field.
 */
export const customFieldValues = pgTable(
  'custom_field_values',
  {
    fieldId: uuid('field_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    valueText: text('value_text'),
    valueNum: numeric('value_num'),
    valueDate: date('value_date'),
    valueBool: boolean('value_bool'),
    valueList: jsonb('value_list'),
    valueRef: uuid('value_ref'),
    valueCcy: varchar('value_ccy', { length: 3 }).references(() => currencies.code),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fieldId, t.entityId] }),
    foreignKey({
      columns: [t.fieldId, t.entityType],
      foreignColumns: [customFields.id, customFields.entityType],
      name: 'custom_field_values_field_fk',
    }).onDelete('cascade'),
    index('custom_field_values_entity_idx').on(t.entityType, t.entityId),
    index('custom_field_values_text_idx').on(t.fieldId, t.valueText),
    index('custom_field_values_num_idx').on(t.fieldId, t.valueNum),
    index('custom_field_values_date_idx').on(t.fieldId, t.valueDate),
    index('custom_field_values_ref_idx').on(t.valueRef),
  ],
);

/**
 * Tasks (owner: "tasklar calendarlar").
 *
 * The entity link reuses `custom_entities`, so a task hangs off any object the
 * registry knows — and the owner's own entities, when they arrive, carry tasks
 * without another migration. Both columns null = a standalone task.
 *
 * Deliberately NOT a replacement for the CRM follow-up on a lead: that is a
 * reminder someone sets for themselves, this is work one person gives another,
 * with a due time and a closing note. `/bugun` shows both in one list.
 */
export const taskTypes = pgTable(
  'task_types',
  {
    id: id(),
    name: text('name').notNull(),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('task_types_name_unique').on(sql`lower(${t.name})`)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    title: text('title').notNull(),
    note: text('note'),
    typeId: uuid('type_id').references(() => taskTypes.id),
    assigneeId: uuid('assignee_id')
      .notNull()
      .references(() => users.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    /** Optional: "sometime" is a real answer, and a forced date is a fake one. */
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** Most deadlines are a DAY; the flag keeps "Friday" off 00:00. */
    allDay: boolean('all_day').notNull().default(true),
    status: text('status').notNull().default('open'),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: uuid('done_by').references(() => users.id),
    /** What actually happened — the answer, not the question. */
    result: text('result'),
    entityType: text('entity_type').references(() => customEntities.code),
    entityId: uuid('entity_id'),
    priority: integer('priority').notNull().default(2),
    /** 'day' | 'week' | 'month', or null for a one-off. */
    repeatUnit: text('repeat_unit'),
    repeatEvery: integer('repeat_every').notNull().default(1),
    /** Shared by every occurrence of one rule. */
    seriesId: uuid('series_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tasks_status_check', sql`${t.status} IN ('open', 'done', 'cancelled')`),
    check('tasks_priority_check', sql`${t.priority} BETWEEN 1 AND 3`),
    check('tasks_entity_check', sql`(${t.entityType} IS NULL) = (${t.entityId} IS NULL)`),
    check('tasks_done_check', sql`(${t.status} = 'done') = (${t.doneAt} IS NOT NULL)`),
    check(
      'tasks_repeat_check',
      sql`${t.repeatUnit} IS NULL OR ${t.repeatUnit} IN ('day', 'week', 'month')`,
    ),
    check('tasks_repeat_every_check', sql`${t.repeatEvery} BETWEEN 1 AND 365`),
    // "Every week" starting when? A rule with no deadline has nothing to
    // repeat from.
    check('tasks_repeat_needs_due', sql`${t.repeatUnit} IS NULL OR ${t.dueAt} IS NOT NULL`),
    index('tasks_assignee_idx').on(t.assigneeId, t.status, t.dueAt),
    index('tasks_entity_idx').on(t.entityType, t.entityId),
  ],
);
