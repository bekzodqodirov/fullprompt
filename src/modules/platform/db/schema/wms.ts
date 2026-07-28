import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  type AnyPgColumn,
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
    /**
     * The job this cargo was quoted under, when it was quoted at all.
     * Null for ever on the years of receipts that predate deals, and on the
     * cargo clients keep sending without asking a price first — which is
     * exactly the case the deal engine shouts about.
     */
    dealId: uuid('deal_id').references((): AnyPgColumn => deals.id),
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
    // The other half of "is this box on batch X" (migration 0032). Partial:
    // most boxes sit in a warehouse belonging to no truck at all.
    index('boxes_current_batch_idx').on(t.currentBatchId).where(sql`current_batch_id IS NOT NULL`),
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
  (t) => [
    index('box_movements_box_idx').on(t.boxId, t.createdAt),
    // "Is this box on batch X" — the question the loading snapshot, the batch
    // board, the truck map and the cost allocator all ask. Without it, a
    // sequential scan of this table per candidate box (migration 0032).
    index('box_movements_ref_idx').on(t.refType, t.refId, t.cause),
  ],
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
    fxRateUsed: numeric('fx_rate_used', { precision: 24, scale: 12 }),
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
    rateToUsd: numeric('rate_to_usd', { precision: 24, scale: 12 }).notNull(),
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
    /** Latest manual position pin: {key: at_border|in_kg|in_uz, at: ISO} — re-anchors the map estimate. */
    trackingCheckpoint: jsonb('tracking_checkpoint'),
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
// Driver tracking: the warehouse worker pairs the driver's phone with THIS
// trip while loading. Android streams real fixes; other phones stay on the
// logist's manual updates + the schedule estimate. Trip-scoped by design, so
// tracking stops by itself when the cargo is delivered.
// ---------------------------------------------------------------------------

export const driverDevices = pgTable(
  'driver_devices',
  {
    id: id(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id),
    platform: text('platform').notNull().default('android'),
    label: text('label'),
    /** Short code typed into the app once; cleared when the token is issued. */
    pairCode: text('pair_code').unique(),
    tokenHash: text('token_hash').unique(),
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('driver_devices_platform_check', sql`${t.platform} IN ('android', 'other')`),
    index('driver_devices_batch_idx').on(t.batchId),
  ],
);

export const driverPositions = pgTable(
  'driver_positions',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id),
    deviceId: uuid('device_id').references(() => driverDevices.id),
    lat: numeric('lat', { precision: 9, scale: 6 }).notNull(),
    lon: numeric('lon', { precision: 9, scale: 6 }).notNull(),
    accuracyM: integer('accuracy_m'),
    speedKmh: numeric('speed_kmh', { precision: 6, scale: 2 }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull().default('device'),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [
    check('driver_positions_source_check', sql`${t.source} IN ('device', 'manual')`),
    check('driver_positions_lat_check', sql`${t.lat} BETWEEN -90 AND 90`),
    check('driver_positions_lon_check', sql`${t.lon} BETWEEN -180 AND 180`),
    index('driver_positions_batch_idx').on(t.batchId, t.recordedAt),
  ],
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
    rateToUsd: numeric('rate_to_usd', { precision: 24, scale: 12 }).notNull(),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
    /** Payments only: cash / card / transfer (owner accepts all three). */
    method: text('method'),
    txDate: date('tx_date').notNull(),
    /** Charges from batch pricing point at the batch they price. */
    batchId: uuid('batch_id').references(() => batches.id),
    /**
     * The job this charge is for, when it was raised from one. Null for every
     * charge posted from batch pricing — which is a correct answer, not a gap:
     * a deferral cannot cover money nobody tied to a job.
     */
    dealId: uuid('deal_id').references(() => deals.id),
    /** Which cash box the payment landed in (Phase 2.4 cash flow). */
    accountId: uuid('account_id'),
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

// ---------------------------------------------------------------------------
// Phase 2.4 — Management accounting (owner: P&L, cash flow, profitability)
//
// Deliberately management accounting, not double-entry bookkeeping (owner's
// choice): the numbers here run the business, while the official books stay
// with the accountant. Cargo costs already live in `cost_entries` and reach
// every box through `cost_allocations`; what was missing was the overhead
// side (rent, salaries…) and somewhere for money to actually sit.
// ---------------------------------------------------------------------------

/** Operating-expense categories — maintained by hand, not hardcoded (owner). */
export const expenseCategories = pgTable('expense_categories', {
  id: id(),
  name: text('name').notNull().unique(),
  /**
   * False for expenses that never move money (depreciation). They belong in
   * the P&L but must stay out of the cash-flow report.
   */
  cash: boolean('cash').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** Where money actually sits. Owner's list: CN cash USD, UZ cash USD/UZS, card, company account. */
export const moneyAccounts = pgTable(
  'money_accounts',
  {
    id: id(),
    name: text('name').notNull().unique(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    kind: text('kind').notNull().default('cash'),
    /** Balance carried in from before the system started (owner: "ha kiritamiz"). */
    openingBalance: numeric('opening_balance', { precision: 16, scale: 2 })
      .notNull()
      .default('0'),
    openingDate: date('opening_date'),
    sortOrder: integer('sort_order').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('money_accounts_kind_check', sql`${t.kind} IN ('cash', 'bank', 'card')`)],
);

/**
 * One overhead expense. FX is frozen at entry exactly like a client
 * transaction (DECISIONS #108): a later rate correction must not silently
 * rewrite a month that has already been reported.
 */
export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    rateToUsd: numeric('rate_to_usd', { precision: 24, scale: 12 }).notNull(),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
    expenseDate: date('expense_date').notNull(),
    /** Optional: lets the P&L be split per warehouse / direction (owner). */
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    /** Salaries are entered per employee (owner's answer 5b). */
    employeeId: uuid('employee_id').references(() => users.id),
    /** Which cash box / account it was paid from — drives the cash flow. */
    accountId: uuid('account_id').references(() => moneyAccounts.id),
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
    check('expenses_amount_check', sql`${t.amount} > 0`),
    index('expenses_date_idx').on(t.expenseDate),
    index('expenses_category_idx').on(t.categoryId, t.expenseDate),
    index('expenses_account_idx').on(t.accountId, t.expenseDate),
  ],
);

/**
 * Rent, salaries and the like. A template, not an automatic posting: the
 * accountant presses "create this month's fixed costs" and reviews what
 * landed — a silent monthly insert would quietly falsify a P&L the month
 * something changed.
 */
export const recurringExpenses = pgTable(
  'recurring_expenses',
  {
    id: id(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    dayOfMonth: integer('day_of_month').notNull().default(1),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    employeeId: uuid('employee_id').references(() => users.id),
    accountId: uuid('account_id').references(() => moneyAccounts.id),
    note: text('note'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('recurring_expenses_amount_check', sql`${t.amount} > 0`),
    check('recurring_expenses_day_check', sql`${t.dayOfMonth} BETWEEN 1 AND 28`),
  ],
);

/**
 * Moving money between our own accounts (China cash → company account).
 * Without this the cash-flow report would read a transfer as an expense.
 */
export const accountTransfers = pgTable(
  'account_transfers',
  {
    id: id(),
    fromAccountId: uuid('from_account_id')
      .notNull()
      .references(() => moneyAccounts.id),
    toAccountId: uuid('to_account_id')
      .notNull()
      .references(() => moneyAccounts.id),
    /** Amounts are per side: a CNY cash box can fund a USD account. */
    amountFrom: numeric('amount_from', { precision: 14, scale: 2 }).notNull(),
    amountTo: numeric('amount_to', { precision: 14, scale: 2 }).notNull(),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
    transferDate: date('transfer_date').notNull(),
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
    check('account_transfers_amount_check', sql`${t.amountFrom} > 0 AND ${t.amountTo} > 0`),
    check('account_transfers_distinct_check', sql`${t.fromAccountId} <> ${t.toAccountId}`),
    index('account_transfers_date_idx').on(t.transferDate),
  ],
);

// ---------------------------------------------------------------------------
// CRM (Phase 2.3): leads, funnel, contact history
// ---------------------------------------------------------------------------

/** Where a lead came from — the owner maintains the list himself. */
export const leadSources = pgTable('lead_sources', {
  id: id(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/**
 * Funnel stages as data, not an enum: every company words its funnel
 * differently. `kind` is the only part the code reasons about — a stage is
 * still open, a won deal, or a lost one.
 */
export const leadStages = pgTable(
  'lead_stages',
  {
    id: id(),
    name: text('name').notNull().unique(),
    kind: text('kind').notNull().default('open'),
    /**
     * A fixed palette rather than free-form hex: the classes are compiled by
     * Tailwind, so an arbitrary colour would simply not render.
     */
    color: text('color').notNull().default('gray'),
    sortOrder: integer('sort_order').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check('lead_stages_kind_check', sql`${t.kind} IN ('open', 'won', 'lost')`),
    check(
      'lead_stages_color_check',
      sql`${t.color} IN ('gray', 'blue', 'green', 'amber', 'red', 'purple', 'teal')`,
    ),
  ],
);

/** Someone who has asked about cargo but has no client code yet. */
export const leads = pgTable(
  'leads',
  {
    id: id(),
    name: text('name').notNull(),
    phone: text('phone'),
    company: text('company'),
    sourceId: uuid('source_id').references(() => leadSources.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => leadStages.id),
    /** The sales manager who owns the conversation. */
    ownerId: uuid('owner_id').references(() => users.id),
    note: text('note'),
    /** "Call back on Friday" — what the follow-up list is built from. */
    nextActionAt: date('next_action_at'),
    nextActionNote: text('next_action_note'),
    /** Set when the lead becomes a client card; the lead row itself stays. */
    clientId: uuid('client_id').references(() => clients.id),
    /** Which human being this is, when several codes belong to one person. */
    personId: uuid('person_id'),
    lostReason: text('lost_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('leads_stage_idx').on(t.stageId),
    index('leads_owner_idx').on(t.ownerId),
    index('leads_person_idx').on(t.personId),
    index('leads_next_action_idx').on(t.nextActionAt),
    uniqueIndex('leads_client_unique').on(t.clientId).where(sql`${t.clientId} IS NOT NULL`),
  ],
);

/**
 * One log for both sides of the funnel. The call that won a lead and the call
 * about a late payment a year later belong on the same timeline; two tables
 * would have split a single person's history in half.
 */
export const crmActivities = pgTable(
  'crm_activities',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    kind: text('kind').notNull(),
    happenedAt: timestamp('happened_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('crm_activities_entity_check', sql`${t.entityType} IN ('lead', 'client')`),
    check('crm_activities_kind_check', sql`${t.kind} IN ('call', 'meeting', 'message', 'note')`),
    index('crm_activities_entity_idx').on(t.entityType, t.entityId, t.happenedAt),
  ],
);

/**
 * One human being holding several client codes (owner: "ha birlashtiraylik").
 *
 * A layer ABOVE clients, not a merge: each code keeps its own letters, stock,
 * cargo history and cabinet link — merging the rows would rewrite years of
 * receipts — while the person ties them together for the sales side.
 */
export const crmPeople = pgTable('crm_people', {
  id: id(),
  name: text('name').notNull(),
  phones: jsonb('phones').notNull().default([]),
  note: text('note'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Bitim (deal) — one client's job, from "please price this" to "paid"
//
// The specification is docs/DEALS.md, settled with the owner in his own words.
// The reason it exists is worth repeating here, because it decides the shape:
// the pain is NOT the absence of a record, it is the GAP between the price we
// quoted and the cargo that actually turned up, seen too late. So a deal holds
// the quote and the reality side by side — and the reality side is never typed
// in by a human, it is summed from the receipts pointing at the deal.
// ---------------------------------------------------------------------------

/** The board's columns; the owner reshapes his own pipeline. */
export const dealStages = pgTable(
  'deal_stages',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('open'),
    color: text('color').notNull().default('gray'),
    sortOrder: integer('sort_order').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check('deal_stages_kind_check', sql`${t.kind} IN ('open', 'won', 'lost')`),
    check(
      'deal_stages_color_check',
      sql`${t.color} IN ('gray', 'blue', 'green', 'amber', 'red', 'purple', 'teal')`,
    ),
  ],
);

export const deals = pgTable(
  'deals',
  {
    id: id(),
    /** `B-000123` — the number staff say out loud on the phone. */
    code: text('code').notNull().unique(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => dealStages.id),
    /**
     * Who is carrying it right now. Ownership changes hands mid-job here, so
     * this is a current value with an audit trail behind it, not a stamp.
     */
    ownerId: uuid('owner_id').references(() => users.id),
    title: text('title'),

    // The quote: what we told the client.
    quotedVolumeM3: numeric('quoted_volume_m3', { precision: 12, scale: 3 }),
    quotedWeightKg: numeric('quoted_weight_kg', { precision: 12, scale: 3 }),
    quotedAmount: numeric('quoted_amount', { precision: 14, scale: 2 }),
    quotedCurrency: varchar('quoted_currency', { length: 3 }).references(() => currencies.code),
    quotedAt: timestamp('quoted_at', { withTimezone: true }),
    quotedBy: uuid('quoted_by').references(() => users.id),
    /** The clock starts when the VED manager is GIVEN the task (DEALS.md #5). */
    quoteRequestedAt: timestamp('quote_requested_at', { withTimezone: true }),

    /** Damage is a discount ON THE DEAL, so profit per deal stays honest (#3). */
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    discountReason: text('discount_reason'),
    discountBy: uuid('discount_by').references(() => users.id),
    discountAt: timestamp('discount_at', { withTimezone: true }),

    /** "I'll pay when it's all here" — scoped to this job, with an end (#4). */
    deferralReason: text('deferral_reason'),
    deferredBy: uuid('deferred_by').references(() => users.id),
    deferredAt: timestamp('deferred_at', { withTimezone: true }),
    deferUntilAllArrived: boolean('defer_until_all_arrived').notNull().default(false),
    deferUntilDate: date('defer_until_date'),
    deferralEndedAt: timestamp('deferral_ended_at', { withTimezone: true }),

    note: text('note'),
    lostReason: text('lost_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'deals_quote_currency_check',
      sql`(${t.quotedAmount} IS NULL) OR (${t.quotedCurrency} IS NOT NULL)`,
    ),
    check('deals_discount_check', sql`${t.discountAmount} >= 0`),
    check(
      'deals_discount_reason_check',
      sql`(${t.discountAmount} = 0) OR (${t.discountReason} IS NOT NULL)`,
    ),
    check(
      'deals_deferral_check',
      sql`(${t.deferredAt} IS NULL) OR (${t.deferralReason} IS NOT NULL AND (${t.deferUntilAllArrived} OR ${t.deferUntilDate} IS NOT NULL))`,
    ),
    index('deals_client_idx').on(t.clientId, t.createdAt),
    index('deals_stage_idx').on(t.stageId),
    index('deals_owner_idx').on(t.ownerId),
  ],
);

/**
 * One priced item. A price may be set per line OR as one total on the deal —
 * the owner's people do both — so amounts here are nullable and the deal's own
 * `quotedAmount` wins when it is set.
 */
export const dealLines = pgTable(
  'deal_lines',
  {
    id: id(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    description: text('description').notNull(),
    tnvedCode: text('tnved_code'),
    quantity: numeric('quantity', { precision: 14, scale: 3 }),
    unit: text('unit'),
    quotedVolumeM3: numeric('quoted_volume_m3', { precision: 12, scale: 3 }),
    quotedWeightKg: numeric('quoted_weight_kg', { precision: 12, scale: 3 }),
    quotedAmount: numeric('quoted_amount', { precision: 14, scale: 2 }),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('deal_lines_deal_idx').on(t.dealId, t.seq)],
);

/**
 * Cargo a client has told us is on its way to one of our warehouses.
 *
 * The sales side hears "I'm sending five boxes to Yiwu on Friday" days before
 * those boxes exist anywhere in this system; until now that sentence lived in
 * a chat and the warehouse found out when a courier walked in. A waiting row
 * is a promise, not stock: it holds no boxes, no letters and no money, and it
 * closes when the real receipt is confirmed.
 */
export const expectedArrivals = pgTable(
  'expected_arrivals',
  {
    id: id(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    /** A known client, or a marking for someone who has no code yet. */
    clientId: uuid('client_id').references(() => clients.id),
    marking: text('marking'),
    /** The client's own count — the receipt is what corrects it. */
    boxCount: integer('box_count'),
    expectedOn: date('expected_on'),
    note: text('note'),
    status: text('status').notNull().default('waiting'),
    receiptId: uuid('receipt_id').references(() => receipts.id),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'expected_arrivals_status_check',
      sql`${t.status} IN ('waiting', 'arrived', 'cancelled')`,
    ),
    check(
      'expected_arrivals_who_check',
      sql`${t.clientId} IS NOT NULL OR ${t.marking} IS NOT NULL`,
    ),
    index('expected_arrivals_client_idx').on(t.clientId),
  ],
);

/**
 * The manager's Telegram conversation with a client, inside the CRM.
 *
 * The owner's reality: "biz clientlarimiz bn 95 foiz telegramda gaplashamiz."
 * Until now that conversation lived on one person's phone — when a manager
 * left, every promise, price and agreement went with them.
 *
 * Only conversations that MATCH THE CLIENT BOOK are ever written here. A
 * manager's family, friends and other business are read past and dropped, and
 * the schema helps keep that promise: `client_id` is NOT NULL, so there is
 * nowhere to put a message that belongs to nobody.
 */
export const tgMessages = pgTable(
  'tg_messages',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    /** Whose account it was read from — two managers are two conversations. */
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    tgMessageId: bigint('tg_message_id', { mode: 'bigint' }).notNull(),
    direction: text('direction').notNull(),
    body: text('body'),
    hasMedia: boolean('has_media').notNull().default(false),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tg_messages_direction_check', sql`${t.direction} IN ('in', 'out')`),
    // Re-running the import adds nothing. Per MANAGER, because the same client
    // may talk to two of them and both threads are worth keeping.
    uniqueIndex('tg_messages_unique_idx').on(t.managerUserId, t.peerId, t.tgMessageId),
    index('tg_messages_client_idx').on(t.clientId, t.sentAt),
  ],
);

/**
 * A manager's stored Telegram login, for live receiving.
 *
 * One row per manager and the row IS the record: there is exactly one current
 * session per account, and logging in again replaces it. Two live connections
 * on one personal account is what gets that account flagged, so the unique
 * constraint is a safety rule, not tidiness.
 *
 * `sessionEnc` is never a session string in the clear — see
 * `crm/telegram-session.ts` for what is done to it and why this one secret is
 * encrypted where every other credential here is hashed.
 */
export const tgAccounts = pgTable(
  'tg_accounts',
  {
    id: id(),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    /** The Telegram phone, which need not be their login phone in this system. */
    tgPhone: text('tg_phone').notNull(),
    sessionEnc: text('session_enc').notNull(),
    status: text('status').notNull().default('active'),
    /** Heartbeat: a row is not a live connection, and the screen must tell them apart. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tg_accounts_status_check', sql`${t.status} IN ('active', 'stopped', 'signed_out')`),
  ],
);
