import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
  (t) => [check('users_locale_check', sql`${t.locale} IN ('ru', 'uz', 'zh-CN')`)],
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
  isSystem: boolean('is_system').notNull().default(true),
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
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
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
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('clients_code_unique').on(t.clientCode),
    check('clients_code_upper_check', sql`${t.clientCode} = upper(${t.clientCode})`),
    index('clients_sales_manager_idx').on(t.salesManagerId),
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
