import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
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
import { clients, currencies, users, warehouses } from './platform';

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

/**
 * Generic named counters (docs/ARCHITECTURE.md): receipt seq per WH per day,
 * box seq per WH per year, batch seq per WH. Incremented under row lock via
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
 */
export const counters = pgTable(
  'counters',
  {
    kind: text('kind').notNull(),
    scopeKey: text('scope_key').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.kind, t.scopeKey] })],
);

// ---------------------------------------------------------------------------
// Receipts (prixod) & lots
// ---------------------------------------------------------------------------

export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    number: text('number').unique(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    clientId: uuid('client_id').references(() => clients.id),
    status: text('status').notNull().default('draft'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    sourceNote: text('source_note'),
    /** Marking written on unknown-code boxes (owner's rule: keep it, resolve later). */
    unclaimedMarking: text('unclaimed_marking'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    /** Client-generated idempotency key for offline-safe confirm (spec §3). */
    clientEventUuid: uuid('client_event_uuid').unique(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('receipts_status_check', sql`${t.status} IN ('draft', 'confirmed', 'voided')`),
    check(
      'receipts_void_consistency',
      sql`(${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
    ),
    index('receipts_wh_received_idx').on(t.warehouseId, t.receivedAt),
    index('receipts_client_idx').on(t.clientId),
    index('receipts_unclaimed_idx')
      .on(t.warehouseId, t.receivedAt)
      .where(sql`${t.clientId} IS NULL AND ${t.status} = 'confirmed'`),
  ],
);

export const receiptLots = pgTable(
  'receipt_lots',
  {
    id: id(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id),
    seq: integer('seq').notNull(),
    /** Assigned at confirm (spec 5.3); immutable afterwards. */
    letter: text('letter'),
    cycleNo: integer('cycle_no'),
    productNameZh: text('product_name_zh').notNull(),
    productNameRu: text('product_name_ru'),
    boxCount: integer('box_count').notNull(),
    dimsMode: text('dims_mode').notNull().default('uniform'),
    boxLengthCm: integer('box_length_cm'),
    boxWidthCm: integer('box_width_cm'),
    boxHeightCm: integer('box_height_cm'),
    boxWeightKg: numeric('box_weight_kg', { precision: 12, scale: 3 }),
    totalWeightKg: numeric('total_weight_kg', { precision: 12, scale: 3 }).notNull(),
    totalVolumeM3: numeric('total_volume_m3', { precision: 12, scale: 4 }).notNull(),
    /** Free-text remark per line (owner's Kashgar file: notes like "loader miscounted"). */
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('receipt_lots_dims_mode_check', sql`${t.dimsMode} IN ('uniform', 'mixed')`),
    check('receipt_lots_box_count_check', sql`${t.boxCount} > 0`),
    uniqueIndex('receipt_lots_receipt_seq_unique').on(t.receiptId, t.seq),
    index('receipt_lots_letter_idx').on(t.letter),
  ],
);

// ---------------------------------------------------------------------------
// Boxes — the atomic tracked unit — and their movement history
// ---------------------------------------------------------------------------

export const boxes = pgTable(
  'boxes',
  {
    id: id(),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => receiptLots.id),
    shortCode: text('short_code').notNull().unique(),
    seqInLot: integer('seq_in_lot').notNull(),
    status: text('status').notNull().default('in_stock'),
    currentWarehouseId: uuid('current_warehouse_id').references(() => warehouses.id),
    /** FK to batches arrives with M3; plain uuid until then. */
    currentBatchId: uuid('current_batch_id'),
    crateId: uuid('crate_id').references(() => crates.id),
    labelPrintedAt: timestamp('label_printed_at', { withTimezone: true }),
    damaged: boolean('damaged').notNull().default(false),
    flags: jsonb('flags').notNull().default([]),
    statusReason: text('status_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'boxes_status_check',
      sql`${t.status} IN ('in_stock', 'planned', 'loading', 'in_transit', 'ready_for_pickup', 'issued', 'lost', 'void')`,
    ),
    uniqueIndex('boxes_lot_seq_unique').on(t.lotId, t.seqInLot),
    index('boxes_wh_status_idx').on(t.currentWarehouseId, t.status),
    index('boxes_lot_idx').on(t.lotId),
    index('boxes_crate_idx').on(t.crateId),
  ],
);

// ---------------------------------------------------------------------------
// Crates (yashik/karkas, spec 6.2) — physical consolidation of boxes; a crate
// scan substitutes for its member-box scans in every later scan mode.
// ---------------------------------------------------------------------------

export const crates = pgTable(
  'crates',
  {
    id: id(),
    /** `CR-{WH}{YY}-{00000}`, per-WH-per-year counter (DECISIONS #19). */
    code: text('code').notNull().unique(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    /** One client per crate (spec 6.2 v1 rule); unclaimed cargo cannot be crated. */
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    status: text('status').notNull().default('active'),
    /** Physical form printed on the label: ЯЩИК (yashik) or КАРКАС (karkas). */
    kind: text('kind').notNull().default('yashik'),
    /** Mirrors the real-world "ask the logist" step — no in-app approval flow. */
    logistApproved: boolean('logist_approved').notNull().default(false),
    note: text('note'),
    /** Measured after packing; may be filled in later. */
    lengthCm: integer('length_cm'),
    widthCm: integer('width_cm'),
    heightCm: integer('height_cm'),
    weightKg: numeric('weight_kg', { precision: 12, scale: 3 }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    dissolvedAt: timestamp('dissolved_at', { withTimezone: true }),
    dissolvedBy: uuid('dissolved_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('crates_status_check', sql`${t.status} IN ('active', 'dissolved')`),
    check('crates_kind_check', sql`${t.kind} IN ('yashik', 'karkas')`),
    check(
      'crates_dissolved_consistency',
      sql`(${t.dissolvedAt} IS NULL) = (${t.dissolvedBy} IS NULL)`,
    ),
    index('crates_wh_status_idx').on(t.warehouseId, t.status),
    index('crates_client_idx').on(t.clientId),
  ],
);

// ---------------------------------------------------------------------------
// Handovers — physical release of cargo to a person (M2: unclaimed cargo
// returned to the sender; issuing to clients reuses this in W7/M5).
// ---------------------------------------------------------------------------

export const handovers = pgTable(
  'handovers',
  {
    id: id(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    kind: text('kind').notNull().default('returned_to_sender'),
    personName: text('person_name').notNull(),
    personPhone: text('person_phone').notNull(),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('handovers_kind_check', sql`${t.kind} IN ('returned_to_sender', 'issued_to_client')`),
    index('handovers_receipt_idx').on(t.receiptId),
  ],
);

export const boxMovements = pgTable(
  'box_movements',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => boxes.id),
    fromWarehouseId: uuid('from_warehouse_id').references(() => warehouses.id),
    toWarehouseId: uuid('to_warehouse_id').references(() => warehouses.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    cause: text('cause').notNull(),
    refType: text('ref_type'),
    refId: uuid('ref_id'),
    actorId: uuid('actor_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('box_movements_box_idx').on(t.boxId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Product dictionary (zh → ru), spec §8
// ---------------------------------------------------------------------------

export const productDictionary = pgTable(
  'product_dictionary',
  {
    id: id(),
    zh: text('zh').notNull().unique(),
    ru: text('ru'),
    uz: text('uz'),
    usageCount: integer('usage_count').notNull().default(0),
    verified: boolean('verified').notNull().default(false),
    source: text('source').notNull().default('manual'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('product_dictionary_source_check', sql`${t.source} IN ('manual', 'api', 'import')`),
  ],
);

// ---------------------------------------------------------------------------
// Cost capture (allocation engine arrives in M6)
// ---------------------------------------------------------------------------

export const costTypes = pgTable('cost_types', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const costEntries = pgTable(
  'cost_entries',
  {
    id: id(),
    scope: text('scope').notNull(),
    receiptId: uuid('receipt_id').references(() => receipts.id),
    /** FK to batches arrives with M3. */
    batchId: uuid('batch_id'),
    /** Crating cost target (owner's answer: cost sticks to the crate; M6 allocates to the client). */
    crateId: uuid('crate_id').references(() => crates.id),
    costTypeId: uuid('cost_type_id')
      .notNull()
      .references(() => costTypes.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    costDate: date('cost_date').notNull(),
    allocationBasis: text('allocation_basis').notNull().default('weight'),
    clientId: uuid('client_id').references(() => clients.id),
    note: text('note'),
    enteredBy: uuid('entered_by')
      .notNull()
      .references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('cost_entries_scope_check', sql`${t.scope} IN ('receipt', 'batch', 'crate')`),
    check(
      'cost_entries_scope_target_check',
      sql`(${t.scope} = 'receipt' AND ${t.receiptId} IS NOT NULL) OR (${t.scope} = 'batch' AND ${t.batchId} IS NOT NULL) OR (${t.scope} = 'crate' AND ${t.crateId} IS NOT NULL)`,
    ),
    check('cost_entries_amount_check', sql`${t.amount} > 0`),
    check(
      'cost_entries_basis_check',
      sql`${t.allocationBasis} IN ('weight', 'volume', 'chargeable', 'boxes', 'direct_to_client')`,
    ),
    index('cost_entries_receipt_idx').on(t.receiptId),
    index('cost_entries_batch_idx').on(t.batchId),
  ],
);
