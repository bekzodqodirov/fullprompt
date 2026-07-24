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
    currentBatchId: uuid('current_batch_id').references(() => batches.id),
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
    /** Set for whole-receipt returns; client issues span receipts and use clientId. */
    receiptId: uuid('receipt_id').references(() => receipts.id),
    clientId: uuid('client_id').references(() => clients.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    kind: text('kind').notNull().default('returned_to_sender'),
    personName: text('person_name').notNull(),
    personPhone: text('person_phone').notNull(),
    /** Phase 3 debt-control hook — checkbox only, no logic (spec). */
    debtOk: boolean('debt_ok').notNull().default(false),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('handovers_kind_check', sql`${t.kind} IN ('returned_to_sender', 'issued_to_client')`),
    check(
      'handovers_target_check',
      sql`(${t.kind} = 'returned_to_sender' AND ${t.receiptId} IS NOT NULL) OR (${t.kind} = 'issued_to_client' AND ${t.clientId} IS NOT NULL)`,
    ),
    index('handovers_receipt_idx').on(t.receiptId),
    index('handovers_client_idx').on(t.clientId),
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
    batchId: uuid('batch_id').references(() => batches.id),
    /** Crating cost target (owner's answer: cost sticks to the crate; M6 allocates to the client). */
    crateId: uuid('crate_id').references(() => crates.id),
    costTypeId: uuid('cost_type_id')
      .notNull()
      .references(() => costTypes.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** Derived by the recompute job: amount × dated FX rate (spec 6.9). */
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }),
    fxRateUsed: numeric('fx_rate_used', { precision: 18, scale: 8 }),
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

/** Manual dated FX rates (admin/accountant enters; USD is the costing base). */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: id(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** USD per 1 unit of the currency (CNY ≈ 0.14, UZS ≈ 0.00008). */
    rateToUsd: numeric('rate_to_usd', { precision: 18, scale: 8 }).notNull(),
    effectiveDate: date('effective_date').notNull(),
    enteredBy: uuid('entered_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('fx_rates_rate_check', sql`${t.rateToUsd} > 0`),
    uniqueIndex('fx_rates_currency_date_unique').on(t.currency, t.effectiveDate),
  ],
);

/**
 * Materialized per-box shares of a cost entry (spec 6.9) — rebuilt whole per
 * entry by the recompute job; a box's landed cost = Σ its rows.
 */
export const costAllocations = pgTable(
  'cost_allocations',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    costEntryId: uuid('cost_entry_id')
      .notNull()
      .references(() => costEntries.id, { onDelete: 'cascade' }),
    boxId: uuid('box_id')
      .notNull()
      .references(() => boxes.id),
    clientId: uuid('client_id').references(() => clients.id),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 4 }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cost_allocations_entry_box_unique').on(t.costEntryId, t.boxId),
    index('cost_allocations_box_idx').on(t.boxId),
    index('cost_allocations_client_idx').on(t.clientId),
  ],
);

// ---------------------------------------------------------------------------
// M3 — Planning, batches, scanning (spec 6.3–6.4, W3/W4)
// ---------------------------------------------------------------------------

/** Truck size presets for the plan editor gauges (reference data). */
export const truckPresets = pgTable(
  'truck_presets',
  {
    id: id(),
    name: text('name').notNull(),
    maxKg: numeric('max_kg', { precision: 12, scale: 3 }).notNull(),
    maxM3: numeric('max_m3', { precision: 12, scale: 4 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('truck_presets_max_kg_check', sql`${t.maxKg} > 0`),
    check('truck_presets_max_m3_check', sql`${t.maxM3} > 0`),
  ],
);

export const batches = pgTable(
  'batches',
  {
    id: id(),
    /** `{WH}-{001}` per-origin-WH sequence. */
    code: text('code').notNull().unique(),
    originWarehouseId: uuid('origin_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    destWarehouseId: uuid('dest_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    type: text('type').notNull().default('transfer'),
    status: text('status').notNull().default('forming'),
    vehiclePlate: text('vehicle_plate'),
    driverName: text('driver_name'),
    driverPhone: text('driver_phone'),
    departedAt: timestamp('departed_at', { withTimezone: true }),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** VED "sent to agent" checkbox (export batches). */
    sentToAgentAt: date('sent_to_agent_at'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('batches_type_check', sql`${t.type} IN ('transfer', 'export', 'distribution')`),
    check(
      'batches_status_check',
      sql`${t.status} IN ('forming', 'loading', 'in_transit', 'arrived', 'unloaded', 'closed', 'cancelled')`,
    ),
    check('batches_route_check', sql`${t.originWarehouseId} <> ${t.destWarehouseId}`),
    index('batches_origin_status_idx').on(t.originWarehouseId, t.status),
  ],
);

/**
 * Load plans (W3). "Quick batch" internal transfers may create a batch with
 * no plan; a plan's batch_id is set at approval.
 */
export const loadPlans = pgTable(
  'load_plans',
  {
    id: id(),
    originWarehouseId: uuid('origin_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    destWarehouseId: uuid('dest_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    batchId: uuid('batch_id').references(() => batches.id).unique(),
    truckPresetId: uuid('truck_preset_id').references(() => truckPresets.id),
    /** Snapshot of the preset (or custom limits) at plan creation. */
    maxKg: numeric('max_kg', { precision: 12, scale: 3 }),
    maxM3: numeric('max_m3', { precision: 12, scale: 4 }),
    targetDate: date('target_date'),
    status: text('status').notNull().default('draft'),
    currentVersionNo: integer('current_version_no').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'load_plans_status_check',
      sql`${t.status} IN ('draft', 'pending_agent', 'changes_requested', 'approved', 'loading', 'completed', 'cancelled')`,
    ),
    index('load_plans_origin_idx').on(t.originWarehouseId, t.status),
  ],
);

/** Immutable per-submission snapshots; never updated after a verdict. */
export const loadPlanVersions = pgTable(
  'load_plan_versions',
  {
    id: id(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => loadPlans.id),
    versionNo: integer('version_no').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    totalBoxes: integer('total_boxes').notNull(),
    totalKg: numeric('total_kg', { precision: 12, scale: 3 }).notNull(),
    totalM3: numeric('total_m3', { precision: 12, scale: 4 }).notNull(),
    /** The agent stays outside the system — the logist records the verdict. */
    agentVerdict: text('agent_verdict'),
    agentComment: text('agent_comment'),
    verdictRecordedBy: uuid('verdict_recorded_by').references(() => users.id),
    verdictRecordedAt: timestamp('verdict_recorded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'load_plan_versions_verdict_check',
      sql`${t.agentVerdict} IS NULL OR ${t.agentVerdict} IN ('approved', 'changes_requested')`,
    ),
    uniqueIndex('load_plan_versions_plan_no_unique').on(t.planId, t.versionNo),
  ],
);

export const loadPlanLines = pgTable(
  'load_plan_lines',
  {
    id: id(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => loadPlanVersions.id),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => receiptLots.id),
    /**
     * Set when this line covers boxes packed in a crate — the crate is
     * planned as ONE place and approval reserves exactly its boxes.
     */
    crateId: uuid('crate_id').references(() => crates.id),
    /** Partial selection: may be < the lot's total; remainder stays in stock. */
    plannedBoxCount: integer('planned_box_count').notNull(),
    plannedKg: numeric('planned_kg', { precision: 12, scale: 3 }).notNull(),
    plannedM3: numeric('planned_m3', { precision: 12, scale: 4 }).notNull(),
  },
  (t) => [
    check('load_plan_lines_count_check', sql`${t.plannedBoxCount} > 0`),
    uniqueIndex('load_plan_lines_version_lot_unique').on(t.versionId, t.lotId, t.crateId),
    index('load_plan_lines_lot_idx').on(t.lotId),
    index('load_plan_lines_crate_idx').on(t.crateId),
  ],
);

/**
 * Scan facts (W4/W5/W8) — append-only. `clientEventUuid` is the offline
 * idempotency key; crate-scan fan-out rows get derived UUIDs (uuid5).
 */
export const scanEvents = pgTable(
  'scan_events',
  {
    id: id(),
    clientEventUuid: uuid('client_event_uuid').notNull().unique(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => boxes.id),
    crateId: uuid('crate_id').references(() => crates.id),
    batchId: uuid('batch_id').references(() => batches.id),
    handoverId: uuid('handover_id').references(() => handovers.id),
    type: text('type').notNull(),
    method: text('method').notNull(),
    manualReason: text('manual_reason'),
    addedOnSpot: boolean('added_on_spot').notNull().default(false),
    scannedBy: uuid('scanned_by')
      .notNull()
      .references(() => users.id),
    /** Client-side capture time (offline scans arrive late). */
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('scan_events_type_check', sql`${t.type} IN ('load', 'unload', 'issue')`),
    check('scan_events_method_check', sql`${t.method} IN ('qr', 'manual', 'crate')`),
    check(
      'scan_events_manual_reason_check',
      sql`${t.method} <> 'manual' OR ${t.manualReason} IS NOT NULL`,
    ),
    check(
      'scan_events_target_check',
      sql`(${t.type} = 'issue') = (${t.handoverId} IS NOT NULL) AND (${t.type} <> 'issue') = (${t.batchId} IS NOT NULL)`,
    ),
    index('scan_events_batch_type_idx').on(t.batchId, t.type),
    index('scan_events_box_idx').on(t.boxId),
    index('scan_events_scanner_idx').on(t.scannedBy, t.scannedAt),
  ],
);

// ---------------------------------------------------------------------------
// ТНВЭД memory (Phase 1.5): confirmed product→customs-code assignments.
// The AI is consulted only for products this table has never seen.
// ---------------------------------------------------------------------------

export const tnvedAssignments = pgTable(
  'tnved_assignments',
  {
    id: id(),
    /** Normalized zh product name — the lookup key. */
    productKey: text('product_key').notNull().unique(),
    productNameZh: text('product_name_zh').notNull(),
    productNameRu: text('product_name_ru'),
    tnvedCode: text('tnved_code').notNull(),
    source: text('source').notNull().default('manual'),
    aiReasoning: text('ai_reasoning'),
    assignedBy: uuid('assigned_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('tnved_assignments_source_check', sql`${t.source} IN ('manual', 'ai')`)],
);

// ---------------------------------------------------------------------------
// Client money ledger (Phase 2.1): no tariffs — every shipment's price is
// negotiated, so the ledger only records agreed charges and incoming
// payments. Balance = Σ charges − Σ payments, in USD via dated FX rates.
// ---------------------------------------------------------------------------

export const clientTransactions = pgTable(
  'client_transactions',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    type: text('type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** Frozen at entry time — a later FX edit must not move settled money. */
    rateToUsd: numeric('rate_to_usd', { precision: 18, scale: 8 }).notNull(),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
    /** Payments only: cash / card / transfer (owner accepts all three). */
    method: text('method'),
    txDate: date('tx_date').notNull(),
    /** Charges from batch pricing point at the batch they price. */
    batchId: uuid('batch_id').references(() => batches.id),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    check('client_transactions_type_check', sql`${t.type} IN ('charge', 'payment')`),
    check('client_transactions_amount_check', sql`${t.amount} > 0`),
    check(
      'client_transactions_method_check',
      sql`${t.method} IS NULL OR ${t.method} IN ('cash', 'card', 'transfer')`,
    ),
    index('client_transactions_client_idx').on(t.clientId, t.createdAt),
    index('client_transactions_batch_idx').on(t.batchId),
  ],
);
