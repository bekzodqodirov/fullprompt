import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  type AnyPgColumn,
  date,
  doublePrecision,
  index,
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
import {
  attachments,
  clients,
  currencies,
  customFields,
  tasks,
  users,
  warehouses,
} from './platform';

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
    /**
     * Who clears THIS prixod through customs, when the truck's own answer is
     * not the whole story (round 39 follow-up): inside one batch some clients
     * clear their own cargo through their own firm and we clear the rest.
     * NULL means "as the batch says"; `customsByClient` true means the client
     * did it and no cost of ours is involved.
     */
    customsPartnerId: uuid('customs_partner_id').references(() => partners.id),
    customsByClient: boolean('customs_by_client'),
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
    /**
     * The CALCULATION this cargo was priced by (phase E1) — the join that
     * makes «hisob vs haqiqat» possible at all.
     *
     * At the receipt grain because that is the grain the business has: a deal
     * carries many prixods AND many calculations, so neither parent could
     * hold it. `auto` is a suggestion the control screen asks somebody to
     * confirm; only a CONFIRMED link is ever measured, because a guess that
     * silently scores a person is worse than no number.
     */
    calcRequestId: uuid('calc_request_id').references((): AnyPgColumn => calcRequests.id, {
      onDelete: 'set null',
    }),
    calcLinkSource: text('calc_link_source'),
    calcLinkConfirmedAt: timestamp('calc_link_confirmed_at', { withTimezone: true }),
    calcLinkConfirmedBy: uuid('calc_link_confirmed_by').references(() => users.id),
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
    check(
      'receipts_calc_link_source_check',
      sql`${t.calcLinkSource} IS NULL OR ${t.calcLinkSource} IN ('auto', 'person')`,
    ),
    // No constraint ties the confirmation to the link, and that is measured
    // rather than argued: `ON DELETE SET NULL` is an internal UPDATE of the
    // FK column alone, so ANY check spanning `calc_request_id` and a sibling
    // fails 23514 on it and aborts the delete. Every reader asks for both
    // columns, so an orphaned stamp scores nothing.
    index('receipts_calc_request_idx')
      .on(t.calcRequestId)
      .where(sql`${t.calcRequestId} IS NOT NULL`),
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

/**
 * Phase 6: permission to issue to a debtor, as a record instead of a phone
 * call. The snapshot is the approved CEILING — a debt that grew past it is a
 * different debt, and the gate refuses. Validity (status, expiry, amount) is
 * re-checked at read time, like the deal deferral.
 */
export const issueApprovals = pgTable(
  'issue_approvals',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    blockingDebtUsd: numeric('blocking_debt_usd', { precision: 14, scale: 2 }).notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    requestNote: text('request_note'),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    consumedHandoverId: uuid('consumed_handover_id').references(() => handovers.id),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'issue_approvals_status_check',
      sql`${t.status} IN ('pending', 'approved', 'refused', 'consumed')`,
    ),
    check('issue_approvals_decided_check', sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL)`),
    check(
      'issue_approvals_consumed_check',
      sql`(${t.status} = 'consumed') = (${t.consumedHandoverId} IS NOT NULL)`,
    ),
    index('issue_approvals_gate_idx').on(t.clientId, t.warehouseId, t.status),
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
    /**
     * Somebody else settled this cost — the customs firm's own account, the
     * transport company's. The cost still belongs to the cargo, so tannarx is
     * unchanged; what changes is that our cash box never opened and the debt
     * lands on that partner's ledger instead (round 39).
     */
    partnerId: uuid('partner_id').references(() => partners.id),
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
    /**
     * Which firm cleared this truck (round 39). Usually one firm per batch —
     * ours, whose bill lands on its partner ledger — but a client sometimes
     * clears their own cargo through their own firm, and then the only thing
     * worth recording is that they did: no cost of ours is involved.
     */
    customsPartnerId: uuid('customs_partner_id').references(() => partners.id),
    customsByClient: boolean('customs_by_client').notNull().default(false),
    /** Latest manual position pin: {key: at_border|in_kg|in_uz, at: ISO} — re-anchors the map estimate. */
    trackingCheckpoint: jsonb('tracking_checkpoint'),
    /**
     * When the customs declaration cleared (owner: «ha rastamojka tugadi
     * tugmasini qo'sh»).
     *
     * Deliberately NOT a fourth `tracking_checkpoint` key: that jsonb is a
     * POSITION and `CHECKPOINT_SEGMENTS` maps each of its keys onto a leg of
     * the route to re-anchor the map's clock. Clearing customs is not a place.
     *
     * NULL means «nobody has said», which is what every truck that departed
     * before this column existed honestly is — never «not cleared».
     */
    customsClearedAt: timestamp('customs_cleared_at', { withTimezone: true }),
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
    /**
     * "This silence has been reported" (round 55) — set when the silent-truck
     * sweep tells the logists, cleared by the next position, so one silence
     * is one message however many times the sweep runs.
     */
    silentNotifiedAt: timestamp('silent_notified_at', { withTimezone: true }),
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
    /**
     * The payment reached us through this partner's account instead of a cash
     * box of ours — the client settled their debt into our transport
     * company's account in China, and the firm took it off what we owe them.
     * `accountId` is NULL on these by construction: no till opened.
     */
    partnerId: uuid('partner_id').references(() => partners.id),
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
    /**
     * Paid THROUGH a partner rather than out of a cash box — the owner rents
     * the Chinese warehouses jointly with a transport company and pays the
     * Chinese staff through it. The expense is ours; the money is not.
     */
    partnerId: uuid('partner_id').references(() => partners.id),
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
 * Rasxod xabari (round 107, migration 0083) — a warehouse operator's «men
 * pul sarfladim» with the chek photo, waiting for whoever holds
 * `finance.expenses` to enter the REAL expense with the right kontragent.
 * The skladchi never touches the expense book; the request row is the queue
 * and the audit. `expense_id` lands only after the expense saved — a claim
 * that crashes between the two shows as done-with-nothing on the panel
 * rather than being silently re-enterable (the double-money race is the
 * common case, the crash is not).
 */
export const expenseRequests = pgTable(
  'expense_requests',
  {
    id: id(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    /** What the money bought — mandatory, it becomes the expense's note. */
    note: text('note').notNull(),
    status: text('status').notNull().default('open'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expenseId: uuid('expense_id').references(() => expenses.id),
    rejectReason: text('reject_reason'),
  },
  (t) => [
    check('expense_requests_amount_check', sql`${t.amount} > 0`),
    check(
      'expense_requests_status_check',
      sql`${t.status} IN ('open', 'done', 'rejected')`,
    ),
    // The 0054 paired-CHECK idiom: a rejection is exactly a written reason.
    check(
      'expense_requests_reject_check',
      sql`(${t.status} = 'rejected') = (${t.rejectReason} IS NOT NULL)`,
    ),
    // One request per expense — the claim's second half.
    uniqueIndex('expense_requests_expense_unique')
      .on(t.expenseId)
      .where(sql`expense_id IS NOT NULL`),
    index('expense_requests_status_idx').on(t.status, t.createdAt),
    index('expense_requests_author_idx').on(t.createdBy, t.createdAt),
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
  /**
   * A stable handle the CODE uses, while the NAME stays the owner's to edit.
   * Find-or-create by name would split `funnelReport` the first time somebody
   * renamed «Instagram» (migration 0065).
   */
  key: text('key'),
  /**
   * The shared secret for `POST /api/leads/in/<key>` (migration 0068). NULL
   * means that door does not exist and the route 404s — a webhook that
   * authenticates nothing is a public write into the funnel.
   */
  webhookSecret: text('webhook_secret'),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/**
 * The owner's list of why a job dies (round 98, «yopilish sababini listdan
 * belgilaydigan qilishimiz kerak»). The pickers offer these; the record on
 * the lead/deal stays TEXT — the label at the moment of choosing — so a
 * rename never rewrites what somebody recorded, and reasons typed before the
 * list existed keep their words.
 */
export const lostReasons = pgTable(
  'lost_reasons',
  {
    id: id(),
    label: text('label').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('lost_reasons_label_unique').on(sql`lower(${t.label})`)],
);

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
    /**
     * The SERVICE price quoted after the hisoblatish stage (round 71, the
     * owner's answer overriding #108's "no price on a lead"): «tovarga
     * hisoblatish bosqichidan keyin bizning servicemiz narxi yozilishi kerak
     * va shu narx yutildimi yo'qmi etapiga o'tadi». Nullable — an unquoted
     * lead is the normal state — and carried into the deal's quote when the
     * won lead opens its job.
     */
    quotedAmount: numeric('quoted_amount', { precision: 14, scale: 2 }),
    quotedCurrency: varchar('quoted_currency', { length: 3 }),
    quotedVolumeM3: numeric('quoted_volume_m3', { precision: 12, scale: 3 }),
    quotedWeightKg: numeric('quoted_weight_kg', { precision: 12, scale: 3 }),
    /** "Call back on Friday" — what the follow-up list is built from. */
    nextActionAt: date('next_action_at'),
    nextActionNote: text('next_action_note'),
    /** Set when the lead becomes a client card; the lead row itself stays. */
    clientId: uuid('client_id').references(() => clients.id),
    /** Which human being this is, when several codes belong to one person. */
    personId: uuid('person_id'),
    lostReason: text('lost_reason'),
    /**
     * When the card was DECIDED — stamped on a move into won/lost, cleared
     * by a revival (0076). `updated_at` moves on every edit and cannot
     * answer «what did we close this month».
     */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * Null when the lead arrived by itself — an advert, the public form, the
     * bot. Naming the round-robin owner as its author would put a sentence in
     * the audit trail that nobody said (migration 0065).
     */
    createdBy: uuid('created_by').references(() => users.id),
    /** Set when a machine created it; what the inbound rotation counts. */
    inboundAt: timestamp('inbound_at', { withTimezone: true }),
    /**
     * Where the card sits in its column, by the owner's own hand (0075).
     *
     * NULL means nobody has placed it, which sorts FIRST — the top of the
     * column, where a brand-new lead has always appeared.
     */
    boardOrder: doublePrecision('board_order'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('leads_stage_idx').on(t.stageId),
    index('leads_board_order_idx').on(t.stageId, t.boardOrder),
    index('leads_owner_idx').on(t.ownerId),
    index('leads_person_idx').on(t.personId),
    index('leads_next_action_idx').on(t.nextActionAt),
    index('leads_closed_idx').on(t.closedAt),
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
    /** Null for a note a machine wrote — see leads.createdBy (0065). */
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('crm_activities_entity_check', sql`${t.entityType} IN ('lead', 'client', 'deal')`),
    check('crm_activities_kind_check', sql`${t.kind} IN ('call', 'meeting', 'message', 'note')`),
    index('crm_activities_entity_idx').on(t.entityType, t.entityId, t.happenedAt),
  ],
);

/**
 * Every lead that arrived by ITSELF — an advert, the public form, the bot.
 *
 * It exists for two jobs a `leads` row cannot do. The first is idempotency:
 * Meta re-delivers a webhook until it is answered 200, and a form page reloads,
 * so the second copy has to be refused by the DATABASE rather than by a check
 * somebody can forget. The second is the honest record of what was NOT created
 * — the capped, the duplicated, the ones that turned out to be a client. «Why
 * did the advert produce nothing today» is not answerable from a table that
 * only holds what exists.
 */
export const leadIntakes = pgTable(
  'lead_intakes',
  {
    id: id(),
    channel: text('channel').notNull(),
    /** Meta's leadgen id — the idempotency key. Null for a form post. */
    externalId: text('external_id'),
    sourceKey: text('source_key'),
    /** Whatever names the campaign: {utm} or {form_id, ad_id, page_id}. */
    ref: jsonb('ref'),
    phone: text('phone'),
    name: text('name'),
    outcome: text('outcome').notNull(),
    /** 'no_contact' / 'replay' / 'capped' — only when nothing was created. */
    reason: text('reason'),
    /**
     * The form's raw question/answer pairs (0074), capped in code — the
     * «seen questions» the mapping screen lists. Null for doors that carry
     * no questions and for every row before the column existed.
     */
    fields: jsonb('fields'),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    check('lead_intakes_channel_check', sql`${t.channel} IN ('form', 'meta', 'telegram')`),
    check(
      'lead_intakes_outcome_check',
      sql`${t.outcome} IN ('created', 'joined', 'client', 'dropped')`,
    ),
    uniqueIndex('lead_intakes_external_idx')
      .on(t.channel, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('lead_intakes_phone_idx')
      .on(t.phone, t.createdAt)
      .where(sql`${t.phone} IS NOT NULL`),
    index('lead_intakes_source_idx').on(t.sourceKey, t.createdAt),
  ],
);

/**
 * One routing rule for inbound leads (migration 0073): «this stream goes to
 * these people». Read top-down by sortOrder, first match wins; no match falls
 * back to the general per-person rotation (`users.inbound_rota`). Inside a
 * matched rule the same fewest-first fairness applies over its members.
 */
export const inboundRoutes = pgTable(
  'inbound_routes',
  {
    id: id(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Null = any source; otherwise one of INBOUND_SOURCE_KEYS. */
    sourceKey: text('source_key'),
    /** Null = no text condition; case-insensitive contains over name + note. */
    keyword: text('keyword'),
    /**
     * The volume window (0074): matched against the mapped kub answer or a
     * volume read from the arrival's own text; a rule with a window set does
     * NOT match an arrival whose volume is unknown.
     */
    minM3: numeric('min_m3', { precision: 12, scale: 3 }),
    maxM3: numeric('max_m3', { precision: 12, scale: 3 }),
    /** Members, as the automation notify action stores its userIds. */
    userIds: jsonb('user_ids').notNull().default([]),
    active: boolean('active').notNull().default(true),
    /** How many leads this rule has assigned — the list's fire_count. */
    assignedCount: integer('assigned_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('inbound_routes_order_idx').on(t.sortOrder, t.createdAt)],
);

/**
 * The tarjimon (0074): one decision per advert-form question key. `note` is a
 * stored decision too — a key somebody answered «leave it in the note» about
 * must stop reappearing in the unmapped list (round 82's include/exclude
 * shape). The field FK CASCADEs because a mapping is derived configuration:
 * deleting its field must not strand a row that 23503s the fields admin.
 */
export const leadFieldMap = pgTable(
  'lead_field_map',
  {
    id: id(),
    key: text('key').notNull().unique(),
    target: text('target').notNull(),
    fieldId: uuid('field_id').references(() => customFields.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('lead_field_map_target_check', sql`${t.target} IN ('kub', 'kg', 'field', 'note')`),
    check('lead_field_map_field_check', sql`(${t.target} = 'field') = (${t.fieldId} IS NOT NULL)`),
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
    /**
     * Round 26 (owner's item 6): the cargo state that pulls a deal INTO this
     * stage by itself — forward only, open deals only. Null = the stage is
     * moved to by hand alone, which is how every stage shipped.
     */
    cargoTrigger: text('cargo_trigger'),
    createdAt: createdAt(),
  },
  (t) => [
    check('deal_stages_kind_check', sql`${t.kind} IN ('open', 'won', 'lost')`),
    check(
      'deal_stages_color_check',
      sql`${t.color} IN ('gray', 'blue', 'green', 'amber', 'red', 'purple', 'teal')`,
    ),
    check(
      'deal_stages_cargo_trigger_check',
      sql`${t.cargoTrigger} IS NULL OR ${t.cargoTrigger} IN ('received', 'departed', 'arrived', 'ready', 'handed_partial', 'handed')`,
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
    /** See `leads.closedAt` — the same column, the same rule (0076). */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    /** See `leads.boardOrder` — the same column, the same rule (0075). */
    boardOrder: doublePrecision('board_order'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('deals_board_order_idx').on(t.stageId, t.boardOrder),
    index('deals_closed_idx').on(t.closedAt),
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
    /** …and the two numbers the price is made of, when the client knows them. */
    weightKg: numeric('weight_kg', { precision: 12, scale: 3 }),
    volumeM3: numeric('volume_m3', { precision: 12, scale: 4 }),
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
    /**
     * Nullable since 0064 — a conversation may belong to an open LEAD, which
     * is how a customer who is not in the book yet stops being invisible.
     * The CHECK keeps the fence structural: client OR lead, never neither.
     */
    clientId: uuid('client_id').references(() => clients.id),
    /** The open lead this chat opened (0064), until it becomes a client. */
    leadId: uuid('lead_id').references(() => leads.id),
    /** Whose account it was read from — two managers are two conversations. */
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    tgMessageId: bigint('tg_message_id', { mode: 'bigint' }).notNull(),
    direction: text('direction').notNull(),
    body: text('body'),
    hasMedia: boolean('has_media').notNull().default(false),
    /**
     * Which message this one answers (0072) — Telegram's own id, resolved
     * through the (manager, peer, tg_message_id) index rather than an FK.
     * A reply can point at a message older than anything we imported, and an
     * FK would refuse the whole row instead of leaving one quote unresolved.
     */
    replyToTgMessageId: bigint('reply_to_tg_message_id', { mode: 'bigint' }),
    /** Who it was forwarded from, in Telegram's own words (0072). */
    fwdFrom: text('fwd_from'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the manager was reminded that this incoming message is still
     * unanswered (migration 0053). Once per silence, never per sweep.
     */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    /**
     * When the stored copy was last rewritten by a Telegram edit (0084).
     * NULL = never. The chat pulse watches maxima and counts, and an edit
     * is an UPDATE that would otherwise move neither — a corrected number
     * must reach the screen without waiting for an unrelated message.
     */
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => [
    check('tg_messages_direction_check', sql`${t.direction} IN ('in', 'out')`),
    // Re-running the import adds nothing. Per MANAGER, because the same client
    // may talk to two of them and both threads are worth keeping.
    uniqueIndex('tg_messages_unique_idx').on(t.managerUserId, t.peerId, t.tgMessageId),
    index('tg_messages_client_idx').on(t.clientId, t.sentAt),
    // The round-20 scoped reads lead with the manager (migration 0048).
    index('tg_messages_manager_idx').on(t.managerUserId, t.clientId, t.sentAt),
  ],
);

/**
 * How far each manager has READ each of their own Telegram dialogs
 * (migration 0071).
 *
 * Telegram pushes this as `UpdateReadHistoryInbox` the moment the manager
 * reads on any of their devices, so the CRM learns it without asking and
 * without anybody changing how they work. It is what turns one alarm into
 * three states — see `crm/waiting.ts` for the rule and why the signal is
 * Telegram's rather than «somebody opened the thread here».
 *
 * Keyed on (manager, peer) because a read is a fact about ONE person's own
 * dialog: two managers talking to the same customer each read their own.
 */
export const tgChatReads = pgTable(
  'tg_chat_reads',
  {
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    /** Telegram's own id — a high-water mark, so the test is `>=`. */
    lastReadTgMessageId: bigint('last_read_tg_message_id', { mode: 'bigint' }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.managerUserId, t.peerId] })],
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
    /**
     * The Telegram phone, which need not be their login phone in this system.
     * UNIQUE (migration 0038): the invariant is one listener per TELEGRAM
     * ACCOUNT, and this is the key the listener looks itself up by. Two rows
     * for one number would be two locks and two connections.
     */
    tgPhone: text('tg_phone').notNull().unique(),
    /**
     * NULL once the manager disconnects (round 50): the credential is not
     * kept in a disabled row, it is destroyed. A row with no session can
     * never be started by the supervisor.
     */
    sessionEnc: text('session_enc'),
    status: text('status').notNull().default('active'),
    /**
     * Is this number used ONLY for clients (0064)?
     *
     * False by default, and that default is the design: on a personal number
     * an unknown chat becomes a question on a tray, on a work number it
     * becomes a lead by itself. The safe answer must be the one nobody has
     * to choose (owner: «shaxsiy raqam ham bor ish raqam ham bor, kalit
     * qilib ber har kim ozi tanlasin»).
     */
    workAccount: boolean('work_account').notNull().default(false),
    /** Heartbeat: a row is not a live connection, and the screen must tell them apart. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastError: text('last_error'),
    /**
     * When the last-week history pull finished (0070). NULL = owed: the
     * listener runs it once per CONNECT, and `saveAccount` clears it so a
     * reconnection pulls the week the bridge missed.
     */
    historyBackfilledAt: timestamp('history_backfilled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tg_accounts_status_check', sql`${t.status} IN ('active', 'stopped', 'signed_out')`),
  ],
);

/**
 * Which chats belong in the CRM, when the automatic rule is not the answer.
 *
 * Per MANAGER: the same Telegram user can be a client in one person's phone
 * and a friend in another's, and neither of them answers for the other.
 *
 * It holds the narrowest thing a decision can be made from — an id, a display
 * name, a number if Telegram shows one — and never a message. A chat nobody
 * has said "yes" to must leave no trace of what was said in it.
 */
/**
 * Which numbers each connected account has a chat with — as HASHES.
 *
 * The owner asked that creating a lead, a deal or a client look back into
 * the connected Telegram accounts and offer an existing conversation. That
 * question can only be answered from a list of every chat an account holds,
 * and stored the obvious way that list is a copy of an employee's private
 * address book living in the company database.
 *
 * So it holds no name and no number: `phone_hash` is sha256 over the
 * normalised last nine digits with a pepper, which answers «is this number
 * one of them?» and nothing else. There is no query that turns this table
 * back into a list of people, which is the point (owner: «hash bilan qil»).
 *
 * Rows here never authorise a read. Finding a match only lets a screen say
 * «this manager has a chat with this number» — opening it still goes through
 * the same per-manager fence every other Telegram read uses (round 20).
 */
export const tgPeerIndex = pgTable(
  'tg_peer_index',
  {
    id: id(),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    /** sha256(normalised last 9 + pepper). Never the number itself. */
    phoneHash: text('phone_hash').notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tg_peer_index_peer_uniq').on(t.managerUserId, t.peerId),
    index('tg_peer_index_hash_idx').on(t.phoneHash),
  ],
);

export const tgChatRules = pgTable(
  'tg_chat_rules',
  {
    id: id(),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    /** pending (a scan found it) · include (store it) · exclude (never ask again). */
    decision: text('decision').notNull().default('pending'),
    clientId: uuid('client_id').references(() => clients.id),
    /**
     * An included chat may belong to an open LEAD instead (0065) — the answer
     * «this is business, but they are nobody yet» the tray could not give.
     */
    leadId: uuid('lead_id').references(() => leads.id),
    /** A snapshot for the screen, refreshed by a scan — not kept in step. */
    peerTitle: text('peer_title'),
    peerPhone: text('peer_phone'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tg_chat_rules_decision_check', sql`${t.decision} IN ('pending', 'include', 'exclude')`),
    // An included chat must name SOMEBODY — a client or an open lead (0065,
    // widened from client-only). Without it a rule could promise a message a
    // home it does not have; `tg_messages` carries the twin of this check.
    check(
      'tg_chat_rules_include_check',
      sql`${t.decision} <> 'include' OR ${t.clientId} IS NOT NULL OR ${t.leadId} IS NOT NULL`,
    ),
    uniqueIndex('tg_chat_rules_unique_idx').on(t.managerUserId, t.peerId),
    index('tg_chat_rules_pending_idx').on(t.managerUserId, t.decision),
  ],
);

/**
 * A reply waiting to go out through a manager's Telegram — phase 4.
 *
 * A queue rather than a direct send, because only ONE process may hold a
 * connection to an account and that process is the listener. The web app
 * writes here; the listener applies the rate limits and sends.
 *
 * `status` is explicit and the screens must respect it: a queued row is not a
 * delivered message, and if the bridge is down the client is still waiting.
 */
export const tgOutbox = pgTable(
  'tg_outbox',
  {
    id: id(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    /** Whose account it goes out from — whose name the client sees on it. */
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('queued'),
    queuedBy: uuid('queued_by')
      .notNull()
      .references(() => users.id),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Telegram's id once it exists, to reconcile with the echoed copy. */
    tgMessageId: bigint('tg_message_id', { mode: 'bigint' }),
    /** One file per message; body doubles as its caption (may be empty then). */
    attachmentId: uuid('attachment_id').references(() => attachments.id),
    /** The message this reply quotes (0072) — Telegram's id, as incoming. */
    replyToTgMessageId: bigint('reply_to_tg_message_id', { mode: 'bigint' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    check(
      'tg_outbox_status_check',
      sql`${t.status} IN ('queued', 'sending', 'sent', 'failed', 'cancelled')`,
    ),
    // A blank send would still cost a rate-limit slot on a personal account;
    // a photo with no caption is a real message.
    check('tg_outbox_body_check', sql`length(btrim(${t.body})) > 0 OR ${t.attachmentId} IS NOT NULL`),
    index('tg_outbox_queue_idx').on(t.managerUserId, t.status, t.queuedAt),
    index('tg_outbox_client_idx').on(t.clientId, t.queuedAt),
  ],
);

// ---------------------------------------------------------------------------
// Hisoblash — a calculation JOB standing in the VED queue, with a clock
//
// Round 28's ask, in the owner's words: «VED xodimlarim qanchada hisoblab
// berayotganini bilishim kerak». The VED module (phase A, migration 0085)
// widened it from «price this card» to the consignment itself: which service
// is being asked for (section), the route, the weight and volume, the goods
// (calc_request_items), and the materials the seller sent — ONE crm_activity
// note holding the text and every file.
//
// The deadline scales with item_count (30 min a line, two hours at the cap)
// and the speed report is requested_at → completed_at. completed_via says HOW
// it ended: 'lines' = the calculation was saved on the deal (the honest end),
// 'task' = closed by hand, 'returned' = handed back for missing information.
// **Every speed figure must exclude 'returned'**, or a person who bounces
// everything back in ninety seconds is the fastest calculator in the company.
//
// assignee_id and task_id are nullable because the queue owns assignment: a
// request nobody can be given (nobody holds `ved.docs`) is still a request.
// section and source are nullable because rows written before 0085 never said.
// ---------------------------------------------------------------------------

export const calcRequests = pgTable(
  'calc_requests',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    assigneeId: uuid('assignee_id').references(() => users.id),
    itemCount: integer('item_count').notNull(),
    taskId: uuid('task_id').references(() => tasks.id),
    /** yolkira | rastamojka | podklyuch — which service is being priced. */
    section: text('section'),
    fromCity: text('from_city'),
    toCity: text('to_city'),
    weightKg: numeric('weight_kg', { precision: 12, scale: 3 }),
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }),
    /** card | bot — which door it came in through. */
    source: text('source'),
    /** The materials, as sent: one crm_activity note with its attachments. */
    noteId: uuid('note_id').references(() => crmActivities.id, { onDelete: 'set null' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
    completedVia: text('completed_via'),
    /** Why it was handed back — mandatory on the 'returned' ending. */
    returnReason: text('return_reason'),
    /** The answer: phase A records the figure, phase B seals the breakdown. */
    answerAmount: numeric('answer_amount', { precision: 14, scale: 2 }),
    answerCurrency: text('answer_currency'),
    answerNote: text('answer_note'),
    /** Stamped by the sweep so a late calculation is announced exactly once. */
    overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true }),
    /** How many prices this request has sealed (phase B). 0 = none yet. */
    currentVersionNo: integer('current_version_no').notNull().default(0),
    /** A correction is a NEW request seeded from the sealed one, never a
     * re-opening — clearing `completed_at` would re-arm the sweep, the clock
     * and the manual ending against a request with a locked price behind it. */
    supersedesRequestId: uuid('supersedes_request_id').references((): AnyPgColumn => calcRequests.id, {
      onDelete: 'set null',
    }),
    /** Which freight column prices this job — chosen, never inferred. */
    freightZone: text('freight_zone'),
    /** The proposal claims its request so two presses cannot both spend a call. */
    aiProposalStartedAt: timestamp('ai_proposal_started_at', { withTimezone: true }),
    /**
     * Origin certificate present? Default TRUE by the owner's own answer —
     * without one the 28.02.2026 additional duty adds 5-20 % by value band,
     * so the flag flips the whole calculation. Inheritable per group (a
     * sborniy truck mixes senders).
     */
    hasCertificate: boolean('has_certificate').notNull().default(true),
    /**
     * The BHM step scale prices a DECLARATION and this system prices a
     * REQUEST — usually the same thing, not always. A typed override wins
     * over the computed tier; NULL means «compute it».
     */
    feeOverrideUsd: numeric('fee_override_usd', { precision: 12, scale: 2 }),
    /**
     * The revision clock (0092). The seal and both confirm doors compute on
     * pool reads (#714 keeps loadWorkspace out of transactions), so their
     * write tx compares this integer under FOR UPDATE to know the workspace
     * they computed still stands. Every mutator bumps it; a millisecond
     * timestamp collides, a counter cannot.
     */
    rev: integer('rev').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'calc_requests_fee_override_check',
      sql`${t.feeOverrideUsd} IS NULL OR (${t.feeOverrideUsd} >= 0 AND ${t.feeOverrideUsd} <> 'NaN'::numeric)`,
    ),
    check('calc_requests_entity_check', sql`${t.entityType} IN ('deal', 'lead')`),
    check('calc_requests_items_check', sql`${t.itemCount} BETWEEN 0 AND 1000`),
    check(
      'calc_requests_via_check',
      sql`${t.completedVia} IS NULL OR ${t.completedVia} IN ('lines', 'task', 'returned', 'sealed')`,
    ),
    check(
      'calc_requests_section_check',
      sql`${t.section} IS NULL OR ${t.section} IN ('yolkira', 'rastamojka', 'podklyuch')`,
    ),
    check(
      'calc_requests_source_check',
      sql`${t.source} IS NULL OR ${t.source} IN ('card', 'bot')`,
    ),
    // Read by the attachment gate on every file render (see access.ts).
    index('calc_requests_note_idx').on(t.noteId),
    index('calc_requests_assignee_idx').on(t.assigneeId, t.requestedAt),
    // Read by `stampCalcLink` inside createReceipt's transaction (phase E1).
    index('calc_requests_entity_idx').on(t.entityType, t.entityId),
  ],
);

/**
 * The goods a request carries, at the grain the client's own invoice comes in.
 *
 * Phase B groups these by TNVED code; a group is a layer OVER items and is
 * born there, because a grouping proposed by a model at submit time would be
 * load-bearing before anybody confirmed it. `seq` is the seller's ordering and
 * never moves — phase B's groups refer to items by position.
 */
export const calcRequestItems = pgTable(
  'calc_request_items',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => calcRequests.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }),
    unit: text('unit'),
    weightKg: numeric('weight_kg', { precision: 12, scale: 3 }),
    volumeM3: numeric('volume_m3', { precision: 12, scale: 3 }),
    amount: numeric('amount', { precision: 14, scale: 2 }),
    currency: text('currency'),
    /** Filled from the TNVED memory at intake, before any model is asked. */
    tnvedCode: text('tnved_code'),
    note: text('note'),
    /** Which group prices it (phase B). A group is a layer OVER items. */
    groupId: uuid('group_id').references((): AnyPgColumn => calcGroups.id, { onDelete: 'set null' }),
    /**
     * The ITEM is the priced unit.
     *
     * The owner's law: a baza is per PRODUCT and one TNVED code holds several
     * products with different bazas — so the customs value is a SUM over
     * items, never one baza times the group's totals. Two products under one
     * code at $8/kg and $3/kg priced at either number is ±45 %.
     */
    bazaUsd: numeric('baza_usd', { precision: 14, scale: 4 }),
    bazaBasis: text('baza_basis'),
    /** 'dictionary' | 'typed' — never 'ai'. A model's estimate has nowhere to land. */
    bazaSource: text('baza_source'),
    /**
     * The law's own measure (0092): the quantity in the unit the code's duty
     * is per, for the four units no other column holds. kg / dona / 1000_dona
     * deliberately stay on weight_kg / quantity — one home per fact. Written
     * and cleared only as a PAIR (a quantity is a statement IN a unit).
     */
    measureUnit: text('measure_unit'),
    measureQty: numeric('measure_qty', { precision: 14, scale: 4 }),
  },
  (t) => [
    uniqueIndex('calc_request_items_seq_idx').on(t.requestId, t.seq),
    index('calc_request_items_group_idx').on(t.groupId),
    check(
      'calc_items_baza_basis_check',
      sql`${t.bazaBasis} IS NULL OR ${t.bazaBasis} IN ('unit', 'kg', 'juft', 'litr', 'm2')`,
    ),
    check(
      'calc_items_baza_source_check',
      sql`${t.bazaSource} IS NULL OR ${t.bazaSource} IN ('dictionary', 'typed')`,
    ),
    check(
      'calc_items_measure_unit_check',
      sql`${t.measureUnit} IS NULL OR ${t.measureUnit} IN ('juft', 'litr', 'm2', 'sm3')`,
    ),
    check(
      'calc_items_measure_qty_check',
      sql`${t.measureQty} IS NULL OR (${t.measureQty} > 0 AND ${t.measureQty} <> 'NaN'::numeric)`,
    ),
    check(
      'calc_items_measure_pair_check',
      sql`(${t.measureUnit} IS NULL) = (${t.measureQty} IS NULL)`,
    ),
  ],
);

/**
 * A product's customs valuation — the «baza», versioned by the date it took
 * effect (VED phase B, migration 0086).
 *
 * `fx_rates`' shape, with one deliberate departure written into the reader:
 * there is NO earliest-row fallback. fx_rates falls back because a cost
 * entered before the first rate still has to convert; here a missing baza
 * means «nobody has ever priced this product», and inventing a number for it
 * is the class of defect this whole module exists to remove.
 *
 * Keyed on `product_key` — the same `productKey()` normaliser the TNVED
 * memory uses — because one TNVED code holds several products with different
 * bazas, so the value belongs to the PRODUCT and the rates below to the CODE.
 */
export const calcBazas = pgTable(
  'calc_bazas',
  {
    id: id(),
    productKey: text('product_key').notNull(),
    label: text('label').notNull(),
    tnvedCode: text('tnved_code'),
    bazaUsd: numeric('baza_usd', { precision: 14, scale: 4 }).notNull(),
    /** 'unit' | 'kg' — what the number is per. */
    basis: text('basis').notNull(),
    effectiveDate: date('effective_date').notNull(),
    note: text('note'),
    enteredBy: uuid('entered_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    // No sm3 on purpose: nothing is VALUED per cm³ of displacement — a
    // vehicle's baza is its invoice price per dona (0092).
    check('calc_bazas_basis_check', sql`${t.basis} IN ('unit', 'kg', 'juft', 'litr', 'm2')`),
    check('calc_bazas_value_check', sql`${t.bazaUsd} > 0`),
    uniqueIndex('calc_bazas_key_date_unique').on(t.productKey, t.effectiveDate),
  ],
);

/**
 * A TNVED code's rates, versioned the same way and learned from corrections —
 * but only when a person says so. `source` tells a taught rate from a typed
 * one; a rate learned silently from every seal would learn a one-off
 * lgota-driven number and then quietly price the next job with it.
 */
export const calcRates = pgTable(
  'calc_rates',
  {
    id: id(),
    tnvedCode: text('tnved_code').notNull(),
    dutyPct: numeric('duty_pct', { precision: 6, scale: 3 }).notNull().default('0'),
    vatPct: numeric('vat_pct', { precision: 6, scale: 3 }).notNull().default('0'),
    feeUsd: numeric('fee_usd', { precision: 12, scale: 2 }).notNull().default('0'),
    /**
     * How PP-3818 prices this code: advalor (BQ × %), specific (Miqdor × T),
     * max (the greater of the two — 198 rows), plus (their sum — the vehicle
     * rows). `duty_pct` alone can store the 20 and silently lose the $3/dona
     * floor, which on light goods IS the duty.
     */
    dutyMode: text('duty_mode').notNull().default('advalor'),
    dutySpecific: numeric('duty_specific', { precision: 12, scale: 4 }),
    /** The law's own unit vocabulary. The engine prices kg/dona/1000_dona and
     * refuses the rest (`unit_unsupported`) — the dictionary stores all seven,
     * because dropping litr rows would answer «no rate» about priced codes. */
    dutyUnit: text('duty_unit'),
    effectiveDate: date('effective_date').notNull(),
    source: text('source').notNull().default('manual'),
    note: text('note'),
    enteredBy: uuid('entered_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('calc_rates_source_check', sql`${t.source} IN ('manual', 'correction', 'pp3818')`),
    check(
      'calc_rates_pct_check',
      sql`${t.dutyPct} >= 0 AND ${t.dutyPct} <= 100 AND ${t.vatPct} >= 0 AND ${t.vatPct} <= 100 AND ${t.feeUsd} >= 0`,
    ),
    check('calc_rates_duty_mode_check', sql`${t.dutyMode} IN ('advalor', 'specific', 'max', 'plus')`),
    check(
      'calc_rates_duty_unit_check',
      sql`${t.dutyUnit} IS NULL OR ${t.dutyUnit} IN ('kg', 'dona', 'litr', 'juft', '1000_dona', 'sm3', 'm2')`,
    ),
    check(
      'calc_rates_specific_check',
      sql`${t.dutySpecific} IS NULL OR (${t.dutySpecific} >= 0 AND ${t.dutySpecific} <> 'NaN'::numeric)`,
    ),
    // Two-directional: 'advalor' carries no specific half, every other mode
    // carries both — one direction alone lets a 'max' row lose its floor.
    check(
      'calc_rates_mode_pair_check',
      sql`((${t.dutyMode} = 'advalor') = (${t.dutySpecific} IS NULL)) AND ((${t.dutyMode} = 'advalor') = (${t.dutyUnit} IS NULL))`,
    ),
    uniqueIndex('calc_rates_code_date_unique').on(t.tnvedCode, t.effectiveDate),
  ],
);

/**
 * The owner's own freight table, as LOWER BOUNDS: a row is «this density and
 * up, until the next row».
 *
 * Seeded with the eleven rows he wrote and not one more. His table has a hole
 * at 900-999 kg/m³, lists 700 twice and steps from $320/m³ to $0.55/kg at
 * 1000 — and every one of those is money (30 m³ at 950 kg/m³ is $9,600 or
 * $15,675 depending on the reading), so the engine REFUSES an uncovered
 * density rather than choosing the cheaper band on his behalf.
 */
export const calcFreightTariffs = pgTable(
  'calc_freight_tariffs',
  {
    id: id(),
    /** 'cn' (Yiwu and Guangzhou share his column) | 'kashgar'. */
    zone: text('zone').notNull(),
    minDensity: numeric('min_density', { precision: 10, scale: 2 }).notNull(),
    /**
     * The band's top, inclusive. NULL is the open-ended ≥1000 row.
     *
     * A band that knew only its floor would answer every density, and his
     * table does not answer every density — it has a hole at 900-999. The
     * top bound is what lets the lookup refuse instead of guessing.
     */
    maxDensity: numeric('max_density', { precision: 10, scale: 2 }),
    priceUsd: numeric('price_usd', { precision: 10, scale: 4 }).notNull(),
    /** The ≥1000 kg/m³ rows are charged per kilogram, not per cube. */
    perKg: boolean('per_kg').notNull().default(false),
    effectiveDate: date('effective_date').notNull(),
    enteredBy: uuid('entered_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('calc_freight_price_check', sql`${t.priceUsd} > 0`),
    check(
      'calc_freight_density_check',
      sql`${t.minDensity} >= 0 AND (${t.maxDensity} IS NULL OR ${t.maxDensity} >= ${t.minDensity})`,
    ),
    uniqueIndex('calc_freight_zone_band_date_unique').on(t.zone, t.minDensity, t.effectiveDate),
  ],
);

/**
 * The groups a calculation is made of.
 *
 * A group carries what is genuinely per-CODE: the code, its rates, and the
 * lgota decided for THIS calculation (the same code is exempt on one job and
 * not on the next — the owner's «goh unday goh bunday»). What it does not
 * carry is the baza: that is per product and lives on the items.
 *
 * `rate_source` is the fence that keeps «AI advises, never decides» true —
 * its legal values are 'dictionary' and 'typed', so a model's estimate has
 * nowhere to land. `ai_duty_pct` is kept for the record and read by nothing.
 */
export const calcGroups = pgTable(
  'calc_groups',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => calcRequests.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    label: text('label').notNull(),
    tnvedCode: text('tnved_code'),
    dutyPct: numeric('duty_pct', { precision: 6, scale: 3 }),
    vatPct: numeric('vat_pct', { precision: 6, scale: 3 }),
    feeUsd: numeric('fee_usd', { precision: 12, scale: 2 }),
    rateSource: text('rate_source'),
    /** NULL reads as 'advalor', so every group sealed before 0091 keeps
     * meaning exactly what it meant. */
    dutyMode: text('duty_mode'),
    dutySpecific: numeric('duty_specific', { precision: 12, scale: 4 }),
    dutyUnit: text('duty_unit'),
    /** NULL means none — excise names a short list of goods. */
    excisePct: numeric('excise_pct', { precision: 6, scale: 3 }),
    /** NULL inherits the request's answer. */
    hasCertificate: boolean('has_certificate'),
    dutyFree: boolean('duty_free').notNull().default(false),
    vatFree: boolean('vat_free').notNull().default(false),
    aiProposed: boolean('ai_proposed').notNull().default(false),
    aiConfidence: text('ai_confidence'),
    /** The model's ESTIMATE. Recorded, never multiplied. */
    aiDutyPct: numeric('ai_duty_pct', { precision: 6, scale: 3 }),
    /**
     * The model's own words, kept as their own value (phase E1).
     *
     * `ai_duty_pct` alone cannot answer «did the VED change anything» — the
     * grouping and the code are what a person most often corrects, and a diff
     * nobody kept is not a diff. Written by `applyProposal`, read by the
     * control screen, multiplied by nothing.
     */
    aiProposal: jsonb('ai_proposal'),
    /**
     * The warnings that stood on the screen at the moment ✅ was pressed.
     *
     * Not re-derivable: the dictionaries move, so today's warnings are not
     * the ones that person confirmed over. This is the owner's «ko'rmasdan
     * tasdiqlagan» question, recorded at the only moment it is answerable.
     */
    confirmedWarnings: jsonb('confirmed_warnings'),
    /** single | bulk — «Hammasini tasdiqlash» is a different act. */
    confirmVia: text('confirm_via'),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'calc_groups_confirm_via_check',
      sql`${t.confirmVia} IS NULL OR ${t.confirmVia} IN ('single', 'bulk')`,
    ),
    // A ✅ must not outlive the numbers it was about. TWO writers clear it —
    // `unconfirm()` and the clear `setGroupRates` inlines — and this CHECK is
    // what makes forgetting the second one loud instead of silent.
    check(
      'calc_groups_confirm_pair_check',
      sql`${t.confirmVia} IS NULL OR ${t.confirmedAt} IS NOT NULL`,
    ),
    check(
      'calc_groups_rate_source_check',
      sql`${t.rateSource} IS NULL OR ${t.rateSource} IN ('dictionary', 'typed')`,
    ),
    check(
      'calc_groups_confidence_check',
      sql`${t.aiConfidence} IS NULL OR ${t.aiConfidence} IN ('high', 'medium', 'low')`,
    ),
    check(
      'calc_groups_duty_mode_check',
      sql`${t.dutyMode} IS NULL OR ${t.dutyMode} IN ('advalor', 'specific', 'max', 'plus')`,
    ),
    check(
      'calc_groups_duty_unit_check',
      sql`${t.dutyUnit} IS NULL OR ${t.dutyUnit} IN ('kg', 'dona', 'litr', 'juft', '1000_dona', 'sm3', 'm2')`,
    ),
    check(
      'calc_groups_specific_check',
      sql`${t.dutySpecific} IS NULL OR (${t.dutySpecific} >= 0 AND ${t.dutySpecific} <> 'NaN'::numeric)`,
    ),
    check(
      'calc_groups_excise_check',
      sql`${t.excisePct} IS NULL OR (${t.excisePct} >= 0 AND ${t.excisePct} <= 100)`,
    ),
    // The dictionary's pair rule, read through the NULL-means-advalor lens.
    check(
      'calc_groups_mode_pair_check',
      sql`((coalesce(${t.dutyMode}, 'advalor') = 'advalor') = (${t.dutySpecific} IS NULL)) AND ((coalesce(${t.dutyMode}, 'advalor') = 'advalor') = (${t.dutyUnit} IS NULL))`,
    ),
    uniqueIndex('calc_groups_seq_unique').on(t.requestId, t.seq),
  ],
);

/** CCT and whatever else this job needs, pointing at the EXISTING cost-type
 * dictionary so phase E compares like with like. */
export const calcExtras = pgTable(
  'calc_extras',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => calcRequests.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    costTypeId: uuid('cost_type_id').references(() => costTypes.id),
    label: text('label').notNull(),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    check('calc_extras_amount_check', sql`${t.amountUsd} >= 0`),
    uniqueIndex('calc_extras_seq_unique').on(t.requestId, t.seq),
  ],
);

/**
 * THE SEAL — an immutable, versioned, priced document. Never updated.
 *
 * `load_plan_versions`' shape: snapshots plus a `current_version_no` pointer
 * on the parent. It carries the freight row's IDENTITY rather than an FK
 * alone, because the tariff will be edited and an old quote must go on
 * reading its own numbers; `breakdown` holds the whole calculation so phase E
 * can compare a year-old quote with what the truck actually cost.
 *
 * Two concessions, two columns, because they mean different things: a BAND
 * OVERRIDE is the VED's judgement about the cargo, a DISCOUNT is a price
 * concession to this client — and it is the second that phase D reads when it
 * withdraws the seller's right to add anything on top.
 */
/**
 * Dictionary 4 — the SELLING price book (docs/VED.md phase C).
 *
 * Keyed on the TNVED CODE and deliberately not on a product name. The spec
 * says «product/category» and the owner's example is the bare word
 * «monitor», while the warehouse types «Монитор 27 дюйм» — a code is the
 * category grain, it is confirmed by a person before anything can be sealed
 * with it, and it needs no new column on the items.
 *
 * It holds what we CHARGE, which is not what a calculation COST: the sealed
 * price is the floor the seller's price sits above (law 4).
 */
export const calcPriceBook = pgTable(
  'calc_price_book',
  {
    id: id(),
    tnvedCode: text('tnved_code').notNull(),
    /** What the owner reads. «Monitorlar», not «8528520000». */
    label: text('label').notNull(),
    priceUsd: numeric('price_usd', { precision: 14, scale: 4 }).notNull(),
    unit: text('unit').notNull().default('m3'),
    effectiveDate: date('effective_date').notNull(),
    note: text('note'),
    enteredBy: uuid('entered_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('calc_price_book_unit_check', sql`${t.unit} IN ('m3', 'kg')`),
    check(
      'calc_price_book_value_check',
      sql`${t.priceUsd} > 0 AND ${t.priceUsd} <> 'NaN'::numeric`,
    ),
    uniqueIndex('calc_price_book_code_date_unique').on(t.tnvedCode, t.effectiveDate),
  ],
);

/**
 * What was actually OFFERED to a client, and for how much.
 *
 * A sealed version is what the calculation cost; this is what the seller told
 * the customer. They are different numbers by design, and this is the one the
 * price book learns from — and the one that answers «what did we quote this
 * client last time», which nothing could answer before.
 */
export const calcOffers = pgTable(
  'calc_offers',
  {
    id: id(),
    /** The sealed-floor anchor (phase C). NULL on a Готово-answered offer. */
    versionId: uuid('version_id').references((): AnyPgColumn => calcVersions.id, {
      onDelete: 'cascade',
    }),
    /**
     * The ANSWER anchor (phase 4, 0093): the offer stands on a completed
     * request's typed Готово figure instead of a sealed version — production's
     * only price while the dictionaries are empty. Exactly one of the two
     * anchors is set (CHECK below); the floor is `answer_amount`.
     */
    requestId: uuid('request_id').references((): AnyPgColumn => calcRequests.id, {
      onDelete: 'cascade',
    }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    clientPriceUsd: numeric('client_price_usd', { precision: 14, scale: 2 }).notNull(),
    /**
     * TRUE when the seller quoted BELOW the sealed floor.
     *
     * The row is always written — the flag is how the owner sees who is
     * discounting. What law 4 locks is the PROMISE, not the record: a
     * below-floor offer is born pending and sends nothing until an admin
     * stamps `approved_at`.
     */
    belowFloor: boolean('below_floor').notNull().default(false),
    /** Why. Mandatory when below the floor, exactly as a discount's reason is. */
    belowFloorReason: text('below_floor_reason'),
    /** Until this is stamped: no Telegram text, no PDF, not the card's price, never payable. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id),
    locale: text('locale').notNull(),
    /** Exactly what was sent, so «what did we tell them» is answerable. */
    text: text('text').notNull(),
    offeredBy: uuid('offered_by')
      .notNull()
      .references(() => users.id),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The payout, and the whole pay-twice fence.
     *
     * One expense settles several offers — a seller is paid once a week, not
     * once per quote — so this is deliberately not unique. NULL means unpaid,
     * and `WHERE payout_expense_id IS NULL` is what the claim locks on.
     */
    payoutExpenseId: uuid('payout_expense_id').references((): AnyPgColumn => expenses.id),
    payoutAt: timestamp('payout_at', { withTimezone: true }),
    payoutBy: uuid('payout_by').references(() => users.id),
    /** The seller's credited USD, computed server-side — never typed. */
    payoutUsd: numeric('payout_usd', { precision: 14, scale: 2 }),
  },
  (t) => [
    check('calc_offers_entity_check', sql`${t.entityType} IN ('deal', 'lead')`),
    check('calc_offers_locale_check', sql`${t.locale} IN ('uz', 'ru', 'en')`),
    // Exactly one anchor: both = two floors for one promise, neither = a
    // promise measured against nothing.
    check('calc_offers_one_anchor_check', sql`(${t.versionId} IS NULL) <> (${t.requestId} IS NULL)`),
    check(
      'calc_offers_price_check',
      sql`${t.clientPriceUsd} > 0 AND ${t.clientPriceUsd} <> 'NaN'::numeric`,
    ),
    check(
      'calc_offers_below_floor_reason_check',
      sql`${t.belowFloorReason} IS NULL OR btrim(${t.belowFloorReason}) <> ''`,
    ),
    // A reason and an approval are facts ABOUT a below-floor price; on an
    // ordinary offer they would be noise every report has to explain away.
    check(
      'calc_offers_below_floor_only_check',
      sql`${t.belowFloor} OR (${t.belowFloorReason} IS NULL AND ${t.approvedAt} IS NULL)`,
    ),
    check(
      'calc_offers_approval_pair_check',
      sql`(${t.approvedAt} IS NULL) = (${t.approvedBy} IS NULL)`,
    ),
    check(
      'calc_offers_payout_amount_check',
      sql`${t.payoutUsd} IS NULL OR (${t.payoutUsd} > 0 AND ${t.payoutUsd} <> 'NaN'::numeric)`,
    ),
    // 0054's paired idiom: paid is all four columns, or none of them.
    check(
      'calc_offers_payout_pair_check',
      sql`(${t.payoutExpenseId} IS NULL) = (${t.payoutAt} IS NULL)
        AND (${t.payoutExpenseId} IS NULL) = (${t.payoutBy} IS NULL)
        AND (${t.payoutExpenseId} IS NULL) = (${t.payoutUsd} IS NULL)`,
    ),
    index('calc_offers_version_idx').on(t.versionId),
    index('calc_offers_entity_idx').on(t.entityType, t.entityId, t.offeredAt),
  ],
);

export const calcVersions = pgTable(
  'calc_versions',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => calcRequests.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
    sealedBy: uuid('sealed_by')
      .notNull()
      .references(() => users.id),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    section: text('section').notNull(),
    weightKg: numeric('weight_kg', { precision: 12, scale: 3 }),
    volumeM3: numeric('volume_m3', { precision: 12, scale: 4 }),
    density: numeric('density', { precision: 12, scale: 4 }),
    customsUsd: numeric('customs_usd', { precision: 14, scale: 2 }).notNull().default('0'),
    freightUsd: numeric('freight_usd', { precision: 14, scale: 2 }).notNull().default('0'),
    extrasUsd: numeric('extras_usd', { precision: 14, scale: 2 }).notNull().default('0'),
    totalUsd: numeric('total_usd', { precision: 14, scale: 2 }).notNull(),
    perM3Usd: numeric('per_m3_usd', { precision: 14, scale: 2 }),
    perKgUsd: numeric('per_kg_usd', { precision: 14, scale: 4 }),
    freightZone: text('freight_zone'),
    freightBandMin: numeric('freight_band_min', { precision: 10, scale: 2 }),
    freightRate: numeric('freight_rate', { precision: 10, scale: 4 }),
    freightPerKg: boolean('freight_per_kg'),
    freightListUsd: numeric('freight_list_usd', { precision: 14, scale: 2 }),
    bandOverrideMin: numeric('band_override_min', { precision: 10, scale: 2 }),
    bandOverrideReason: text('band_override_reason'),
    discountUsd: numeric('discount_usd', { precision: 14, scale: 2 }).notNull().default('0'),
    discountReason: text('discount_reason'),
    /** How much of this was still the model's when it was sealed (phase E). */
    aiGroupsSealed: integer('ai_groups_sealed').notNull().default(0),
    lowConfidenceSealed: integer('low_confidence_sealed').notNull().default(0),
    /**
     * Phase E1's three counters, carried to the seal so the owner's list
     * survives the version. The `breakdown` snapshot cannot answer these
     * after the dictionaries have moved underneath it, which is the whole
     * reason they are columns and not a query.
     */
    warnedGroups: integer('warned_groups').notNull().default(0),
    /** Confirmed with LOW confidence, unedited, and no dictionary rate. */
    aiBlindGroups: integer('ai_blind_groups').notNull().default(0),
    /** The model's own duty rate survived to the seal. */
    aiRateTakenGroups: integer('ai_rate_taken_groups').notNull().default(0),
    breakdown: jsonb('breakdown').notNull().default({}),
  },
  (t) => [
    check(
      'calc_versions_section_check',
      sql`${t.section} IN ('yolkira', 'rastamojka', 'podklyuch')`,
    ),
    check('calc_versions_total_check', sql`${t.totalUsd} >= 0`),
    check(
      'calc_versions_e_counts_check',
      sql`${t.warnedGroups} >= 0 AND ${t.aiBlindGroups} >= 0 AND ${t.aiRateTakenGroups} >= 0`,
    ),
    check('calc_versions_discount_check', sql`${t.discountUsd} >= 0`),
    uniqueIndex('calc_versions_request_no_unique').on(t.requestId, t.versionNo),
    index('calc_versions_sealed_idx').on(t.sealedAt),
  ],
);

// ---------------------------------------------------------------------------
// Kontragentlar (round 39) — the OTHER side of the money.
//
// The ledger had one counterparty, the client. Everything else was a cost
// with no creditor: trucks taken on credit, customs paid out of another
// firm's account, Chinese warehouse rent and salaries settled through the
// transport company, and the two people who wire money into our bank account
// and collect cash from the till. All four are the same shape — an account
// per counterparty — so they are one table, not four features.
// ---------------------------------------------------------------------------

/** Editable by the owner, never a compiled list (his rule for every dictionary). */
export const partnerTypes = pgTable('partner_types', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const partners = pgTable(
  'partners',
  {
    id: id(),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => partnerTypes.id),
    /**
     * The client this counterparty IS, when they are the same person (owner:
     * «kontragent klient bolishi ham mumkun»). One card, two ledgers: cargo
     * money stays on the client side, service money lands here.
     */
    clientId: uuid('client_id').references(() => clients.id),
    phone: text('phone'),
    note: text('note'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Two accounts for one person would each show half the truth.
    uniqueIndex('partners_client_uniq').on(t.clientId).where(sql`${t.clientId} IS NOT NULL`),
    index('partners_type_idx').on(t.typeId).where(sql`${t.active}`),
  ],
);

/**
 * The partner ledger. Balance = Σ(charge, receipt) − Σ(payment, offset) ± adjust,
 * in USD, frozen at entry exactly like the client ledger (#108).
 *
 * - `charge`  they billed us / we took the service    debt ↑, no cash
 * - `receipt` they put money into an account of OURS  debt ↑, cash ↑
 * - `payment` we settled from a cash box              debt ↓, cash ↓
 * - `offset`  a client paid them on our behalf        debt ↓, no cash
 * - `adjust`  correction or rate difference           either, no cash
 *
 * `receipt` is the leg the cash buyers need: som lands in the company account
 * and we owe them dollars until they collect it.
 */
export const partnerTransactions = pgTable(
  'partner_transactions',
  {
    id: id(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => partners.id),
    type: text('type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    rateToUsd: numeric('rate_to_usd', { precision: 24, scale: 12 }).notNull(),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
    txDate: date('tx_date').notNull(),
    accountId: uuid('account_id').references(() => moneyAccounts.id),
    /** A truck line points at the batch it carried. */
    batchId: uuid('batch_id').references(() => batches.id),
    costEntryId: uuid('cost_entry_id').references(() => costEntries.id),
    expenseId: uuid('expense_id').references(() => expenses.id),
    /** The client payment this offset pairs with. */
    clientTxId: uuid('client_tx_id').references(() => clientTransactions.id),
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
    check(
      'partner_tx_type_check',
      sql`${t.type} IN ('charge', 'receipt', 'payment', 'offset', 'adjust')`,
    ),
    check(
      'partner_tx_amount_check',
      sql`CASE WHEN ${t.type} = 'adjust' THEN ${t.amount} <> 0 ELSE ${t.amount} > 0 END`,
    ),
    // Money that moved must name its cash box; money that did not must not.
    check(
      'partner_tx_account_check',
      sql`(${t.type} IN ('receipt', 'payment')) = (${t.accountId} IS NOT NULL)`,
    ),
    index('partner_tx_partner_idx').on(t.partnerId, t.txDate),
    index('partner_tx_batch_idx').on(t.batchId),
  ],
);

/**
 * Qo'ng'iroq yozg'ich (the calls round): a seller's phone, bound to their
 * USER — not to a trip, because a seller records for as long as they work
 * here. Token hashed; revocation keeps the hash so the phone hears 410, not
 * a 401 it would retry for ever (the driver app's lesson, #289).
 */
export const callRecorderDevices = pgTable(
  'call_recorder_devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    label: text('label'),
    pairCode: text('pair_code').unique(),
    tokenHash: text('token_hash').unique(),
    platform: text('platform').notNull().default('android'),
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('call_recorder_devices_user_idx').on(t.userId)],
);

/**
 * One phone call that matched the client book. `client_id` NOT NULL is the
 * privacy rule as a constraint (the tg-import rule): a number the book does
 * not know is never stored, so a hodim's personal calls structurally cannot
 * be here. The audio arrives in a SECOND request when the phone's recorder
 * has closed the file — nullable, and a call never recorded stays a call.
 */
export const callLogs = pgTable(
  'call_logs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Nullable since 0063 — a call may belong to an open LEAD instead. */
    clientId: uuid('client_id').references(() => clients.id),
    /** The open lead whose phone matched (0063) — the owner's widened door. */
    leadId: uuid('lead_id').references(() => leads.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => callRecorderDevices.id),
    direction: text('direction').notNull(),
    phone: text('phone').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    durationSec: integer('duration_sec').notNull().default(0),
    attachmentId: uuid('attachment_id').references(() => attachments.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('call_logs_direction_check', sql`${t.direction} IN ('in', 'out')`),
    // Every stored call names its owner — the privacy rule structurally:
    // a number on neither the client book nor an open lead is never stored.
    check('call_logs_owner_check', sql`${t.clientId} IS NOT NULL OR ${t.leadId} IS NOT NULL`),
    // The phone re-sends its recent log every cycle (a missed upload heals
    // that way), so the same call arriving twice must be a no-op — keyed by
    // USER, not device (0061): a device is a pairing, and revoke + re-pair
    // re-reported a whole day under the new id on production's first day.
    unique('call_logs_dedup').on(t.userId, t.phone, t.startedAt),
    index('call_logs_client_idx').on(t.clientId, t.startedAt),
    index('call_logs_user_idx').on(t.userId, t.startedAt),
  ],
);
