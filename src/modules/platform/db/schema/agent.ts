import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { clients, users } from './platform';
import { calcOffers, calcRequests, leads, tgAccounts, tgMessages } from './wms';

/**
 * AI sotuvchi (0136, docs/AI-SOTUVCHI.md §17) — a file of its own, like debt.ts,
 * so the round's eleven tables do not sit in the middle of wms.ts.
 *
 * Nothing that existed before gains a column (review build-10): every fact the
 * agent keeps lives here, so a whole-row read of tg_outbox or tg_messages on a
 * database one migration behind names exactly what it names today.
 */

const AGENT_LOCALE_SQL = sql.raw(`('uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh')`);

/**
 * The one row that says whether the agent runs, for whom, and how far. `auto`
 * is in the CHECK for the phase that earns it and refused by every writer in
 * this one (§17.1: shadow only — he approves every message).
 */
export const agentConfig = pgTable(
  'agent_config',
  {
    id: smallint('id').primaryKey().default(1),
    mode: text('mode').notNull().default('off'),
    /** Whose personal account the agent speaks from — the person who approves. */
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    /** The old server's copy of the session confirmed gone (review ban-9). */
    sessionExclusiveAt: timestamp('session_exclusive_at', { withTimezone: true }),
    sessionExclusiveBy: uuid('session_exclusive_by').references(() => users.id),
    humanPauseMin: integer('human_pause_min').notNull().default(120),
    dailyDraftCap: integer('daily_draft_cap').notNull().default(150),
    dailyTokenCap: integer('daily_token_cap').notNull().default(3_000_000),
    startedAt: timestamp('started_at', { withTimezone: true }),
    styleGuide: text('style_guide'),
    styleGuideProposed: text('style_guide_proposed'),
    styleApprovedAt: timestamp('style_approved_at', { withTimezone: true }),
    styleApprovedBy: uuid('style_approved_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('agent_config_singleton_check', sql`${t.id} = 1`),
    check('agent_config_mode_check', sql`${t.mode} IN ('off', 'shadow', 'auto')`),
    check('agent_config_pause_check', sql`${t.humanPauseMin} BETWEEN 1 AND 10080`),
    check('agent_config_caps_check', sql`${t.dailyDraftCap} >= 0 AND ${t.dailyTokenCap} >= 0`),
    check(
      'agent_config_session_check',
      sql`(${t.sessionExclusiveAt} IS NULL) = (${t.sessionExclusiveBy} IS NULL)`,
    ),
    check(
      'agent_config_on_check',
      sql`${t.mode} = 'off' OR (${t.ownerUserId} IS NOT NULL AND ${t.sessionExclusiveAt} IS NOT NULL)`,
    ),
  ],
);

/** One row per (account, Telegram person): what the agent knows about the chat itself. */
export const agentConversations = pgTable(
  'agent_conversations',
  {
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    locale: text('locale'),
    /** A person wrote here himself: the agent stands down until then (his 7 ⭐, 120 min). */
    humanUntil: timestamp('human_until', { withTimezone: true }),
    mutedAt: timestamp('muted_at', { withTimezone: true }),
    muteReason: text('mute_reason'),
    peerTypingAt: timestamp('peer_typing_at', { withTimezone: true }),
    strangerCardAt: timestamp('stranger_card_at', { withTimezone: true }),
    identityClientId: uuid('identity_client_id').references(() => clients.id),
    identityLeadId: uuid('identity_lead_id').references(() => leads.id),
    identityStrength: text('identity_strength'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.managerUserId, t.peerId] }),
    check('agent_conversations_locale_check', sql`${t.locale} IS NULL OR ${t.locale} IN ${AGENT_LOCALE_SQL}`),
    check(
      'agent_conversations_strength_check',
      sql`${t.identityStrength} IS NULL OR ${t.identityStrength} IN ('phone', 'cabinet', 'rule', 'typed_code', 'lead')`,
    ),
  ],
);

/** The ledger of every model run: reserved first (the cap), settled with its outcome and its tokens. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    trigger: text('trigger').notNull(),
    anchorTgMessageId: bigint('anchor_tg_message_id', { mode: 'bigint' }),
    attempt: smallint('attempt').notNull().default(0),
    sourceKey: text('source_key'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    toolCalls: jsonb('tool_calls').notNull().default([]),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').notNull().default('reserved'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'agent_runs_trigger_check',
      sql`${t.trigger} IN ('inbound', 'owner_edit', 'calc_answer', 'hand_back', 'style')`,
    ),
    check(
      'agent_runs_outcome_check',
      sql`${t.outcome} IN ('reserved', 'draft', 'no_reply', 'notice', 'stood_down', 'refused', 'capped', 'error')`,
    ),
    check(
      'agent_runs_tokens_check',
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cacheReadTokens} >= 0 AND ${t.cacheWriteTokens} >= 0`,
    ),
    check('agent_runs_anchor_check', sql`${t.trigger} <> 'inbound' OR ${t.anchorTgMessageId} IS NOT NULL`),
    uniqueIndex('agent_runs_inbound_unique')
      .on(t.managerUserId, t.peerId, t.anchorTgMessageId, t.attempt)
      .where(sql`${t.trigger} = 'inbound'`),
    uniqueIndex('agent_runs_source_unique')
      .on(t.managerUserId, t.peerId, t.trigger, t.sourceKey)
      .where(sql`${t.sourceKey} IS NOT NULL`),
    index('agent_runs_day_idx').on(t.createdAt),
  ],
);

/** A reply the agent proposes. Nothing reaches the customer until its account holder presses ✅. */
export const agentDrafts = pgTable(
  'agent_drafts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    runId: uuid('run_id').references(() => agentRuns.id),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id').references(() => clients.id),
    leadId: uuid('lead_id').references(() => leads.id),
    identityStrength: text('identity_strength'),
    anchorTgMessageId: bigint('anchor_tg_message_id', { mode: 'bigint' }).notNull(),
    anchorEditedAt: timestamp('anchor_edited_at', { withTimezone: true }),
    kind: text('kind').notNull().default('reply'),
    proposedBody: text('proposed_body'),
    finalBody: text('final_body'),
    glossUz: text('gloss_uz'),
    language: text('language'),
    category: text('category'),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    nextStep: text('next_step'),
    policy: jsonb('policy').notNull().default({}),
    blocked: boolean('blocked').notNull().default(false),
    needsOwner: boolean('needs_owner').notNull().default(false),
    ownerQuestion: text('owner_question'),
    actions: jsonb('actions').notNull().default([]),
    citedMessageIds: jsonb('cited_message_ids').notNull().default([]),
    offerId: uuid('offer_id').references(() => calcOffers.id),
    status: text('status').notNull().default('pending'),
    actionStatus: text('action_status'),
    actionError: text('action_error'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('agent_drafts_kind_check', sql`${t.kind} IN ('reply', 'price', 'hand_back')`),
    check(
      'agent_drafts_status_check',
      sql`${t.status} IN ('pending', 'editing', 'approved', 'rejected', 'superseded', 'expired', 'taken_over')`,
    ),
    check(
      'agent_drafts_action_check',
      sql`${t.actionStatus} IS NULL OR ${t.actionStatus} IN ('pending', 'done', 'failed')`,
    ),
    check(
      'agent_drafts_category_check',
      sql`${t.category} IS NULL OR ${t.category} IN ('greeting', 'status', 'faq', 'qualification', 'price', 'complaint', 'other')`,
    ),
    check('agent_drafts_language_check', sql`${t.language} IS NULL OR ${t.language} IN ${AGENT_LOCALE_SQL}`),
    check(
      'agent_drafts_confidence_check',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
    check('agent_drafts_decided_check', sql`(${t.decidedAt} IS NULL) = (${t.decidedBy} IS NULL)`),
    check(
      'agent_drafts_json_check',
      sql`jsonb_typeof(${t.policy}) = 'object' AND jsonb_typeof(${t.actions}) = 'array' AND jsonb_typeof(${t.citedMessageIds}) = 'array'`,
    ),
    uniqueIndex('agent_drafts_live_unique')
      .on(t.managerUserId, t.peerId)
      .where(sql`${t.status} IN ('pending', 'editing')`),
    index('agent_drafts_status_idx').on(t.status, t.createdAt),
  ],
);

/**
 * An approved reply on its way out — never tg_outbox (review regression-1): a
 * listener that predates this table cannot see the row, so it cannot send it.
 * `step` is where the send choreography stands (verify → read → typing → send).
 */
export const agentOutbox = pgTable(
  'agent_outbox',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    draftId: uuid('draft_id')
      .notNull()
      .unique()
      .references(() => agentDrafts.id),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id').references(() => clients.id),
    leadId: uuid('lead_id').references(() => leads.id),
    body: text('body').notNull(),
    /** Telegram's own dedup key, minted once: a resend after an unknown answer cannot become a second message. */
    randomId: bigint('random_id', { mode: 'bigint' }).notNull().unique(),
    replyToTgMessageId: bigint('reply_to_tg_message_id', { mode: 'bigint' }),
    answersTgMessageId: bigint('answers_tg_message_id', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().default('agent'),
    step: text('step').notNull().default('verify'),
    nextStepAt: timestamp('next_step_at', { withTimezone: true }).notNull().defaultNow(),
    typingCount: smallint('typing_count').notNull().default(0),
    readDone: boolean('read_done').notNull().default(false),
    queuedBy: uuid('queued_by')
      .notNull()
      .references(() => users.id),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    stepClaimedAt: timestamp('step_claimed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    tgMessageId: bigint('tg_message_id', { mode: 'bigint' }),
    lastError: text('last_error'),
  },
  (t) => [
    check('agent_outbox_owner_check', sql`${t.clientId} IS NOT NULL OR ${t.leadId} IS NOT NULL`),
    check('agent_outbox_body_check', sql`length(btrim(${t.body})) > 0 AND length(${t.body}) <= 4000`),
    check(
      'agent_outbox_status_check',
      sql`${t.status} IN ('agent', 'sending', 'sent', 'failed', 'cancelled', 'unknown', 'expired')`,
    ),
    check('agent_outbox_step_check', sql`${t.step} IN ('verify', 'read', 'typing', 'send')`),
    check('agent_outbox_sent_check', sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
    index('agent_outbox_queue_idx').on(t.managerUserId, t.status, t.nextStepAt),
    index('agent_outbox_message_idx').on(t.managerUserId, t.peerId, t.tgMessageId),
  ],
);

/**
 * What the agent may say as fact. A general fact is the company's; a client or
 * lead fact is that customer's alone and is never offered in another chat.
 * The trigram index is created in SQL (0136): drizzle has no gin_trgm_ops.
 */
export const kbFacts = pgTable(
  'kb_facts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    scope: text('scope').notNull().default('general'),
    clientId: uuid('client_id').references(() => clients.id),
    leadId: uuid('lead_id').references(() => leads.id),
    kind: text('kind').notNull().default('fact'),
    question: text('question'),
    answer: text('answer').notNull(),
    locale: text('locale'),
    source: text('source').notNull(),
    sourceRef: jsonb('source_ref'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id),
    usesCount: integer('uses_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('kb_facts_scope_check', sql`${t.scope} IN ('general', 'client', 'lead')`),
    check('kb_facts_general_check', sql`(${t.scope} = 'general') = (${t.clientId} IS NULL AND ${t.leadId} IS NULL)`),
    check('kb_facts_client_check', sql`(${t.scope} = 'client') = (${t.clientId} IS NOT NULL)`),
    check('kb_facts_lead_check', sql`(${t.scope} = 'lead') = (${t.leadId} IS NOT NULL)`),
    check('kb_facts_kind_check', sql`${t.kind} IN ('fact', 'policy', 'definition')`),
    check('kb_facts_source_check', sql`${t.source} IN ('owner', 'site', 'seed', 'manual')`),
    check('kb_facts_answer_check', sql`length(btrim(${t.answer})) > 0 AND length(${t.answer}) <= 2000`),
    check('kb_facts_locale_check', sql`${t.locale} IS NULL OR ${t.locale} IN ${AGENT_LOCALE_SQL}`),
    check(
      'kb_facts_approved_check',
      sql`(${t.approvedAt} IS NULL) = (${t.approvedBy} IS NULL) OR ${t.source} IN ('seed', 'site')`,
    ),
    index('kb_facts_owner_idx').on(t.scope, t.clientId, t.leadId).where(sql`${t.retiredAt} IS NULL`),
  ],
);

/** A calculation the agent sent to the VED queue, and the chat waiting on its answer. */
export const agentCalcLinks = pgTable(
  'agent_calc_links',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => calcRequests.id),
    /** The chain's root (a correction is a new request, #923): an answer on any link of it reaches this chat. */
    rootRequestId: uuid('root_request_id')
      .notNull()
      .references(() => calcRequests.id),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    draftId: uuid('draft_id').references(() => agentDrafts.id),
    lastNotifiedKind: text('last_notified_kind'),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_calc_links_root_idx').on(t.rootRequestId),
    index('agent_calc_links_chat_idx').on(t.managerUserId, t.peerId),
  ],
);

/**
 * The account's pause and the flood wait Telegram ordered — persisted so a
 * restart cannot forget them (review ban-1/ban-2). Every connected account,
 * not only the agent's: a spam limit stops the CRM's own replies too.
 */
export const tgAccountGuard = pgTable(
  'tg_account_guard',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => tgAccounts.id),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pauseReason: text('pause_reason'),
    pausedKind: text('paused_kind'),
    floodUntil: timestamp('flood_until', { withTimezone: true }),
    /** A listener that knows agent_outbox stamps this; the app refuses ✅ into a pump that will never send. */
    agentPumpAt: timestamp('agent_pump_at', { withTimezone: true }),
    caughtUpAt: timestamp('caught_up_at', { withTimezone: true }),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: uuid('cleared_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tg_account_guard_pause_check', sql`(${t.pausedAt} IS NULL) = (${t.pausedKind} IS NULL)`),
    check(
      'tg_account_guard_kind_check',
      sql`${t.pausedKind} IS NULL OR ${t.pausedKind} IN ('peer_flood', 'restricted', 'frozen', 'flood_repeat', 'blocks')`,
    ),
  ],
);

/** Every flood wait Telegram ordered — slept through by gramjs, or raised to us. */
export const tgAccountFloods = pgTable(
  'tg_account_floods',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => tgAccounts.id),
    method: text('method').notNull(),
    seconds: integer('seconds').notNull(),
    source: text('source').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tg_account_floods_source_check', sql`${t.source} IN ('sleep', 'raise')`),
    check('tg_account_floods_seconds_check', sql`${t.seconds} >= 0`),
    index('tg_account_floods_recent_idx').on(t.accountId, t.at),
  ],
);

/** Facts about a stored message: deleted for both sides, or written by the customer's own auto-replier. */
export const tgMessageFlags = pgTable('tg_message_flags', {
  messageId: uuid('message_id')
    .primaryKey()
    .references(() => tgMessages.id, { onDelete: 'cascade' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  autoSent: boolean('auto_sent').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** «Pull this one stranger's chat» — written by the app, done by the listener (the only Telegram connection). */
export const tgPeerPulls = pgTable(
  'tg_peer_pulls',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    peerId: bigint('peer_id', { mode: 'bigint' }).notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    storedCount: integer('stored_count'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('tg_peer_pulls_open_unique')
      .on(t.managerUserId, t.peerId)
      .where(sql`${t.doneAt} IS NULL`),
  ],
);
