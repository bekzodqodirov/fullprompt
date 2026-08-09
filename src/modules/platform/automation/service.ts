import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { automationRules, clients } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { createTask, TaskError } from '../tasks/service';
import { notifyStaffTelegram } from '../notifications/staff';
import { cardLink } from '../notifications/links';
import { resolveEntity } from '../entities/service';
import { logger } from '../logger';
import {
  conditionsMatch,
  conditionsSchema,
  conditionValues,
  isConditionField,
  ruleBoard,
  type Condition,
  type ConditionBoard,
} from './conditions';
import { fillPlaceholders, hasPlaceholder, valuesFromRecord } from './placeholders';
import { loadRuleRecord, type RuleRecord } from './record';
import { runStaleRules } from './stale';

/**
 * Phase 7: automation rules — «when X happens, do Y», written on a form.
 *
 * The design is the smallest thing that automates the owner's real morning:
 * a funnel move or a warehouse event fires, and the rule opens a task for
 * the right person or tells somebody in Telegram. No visual node editor (cut
 * by plan), no rule may trigger another — the two actions emit no domain
 * events, so the engine structurally cannot loop.
 *
 * Round 86 built the three things phase 7 deferred and the owner then asked
 * for by name: a TIME trigger (`stale.ts` — the card nobody touched, which
 * produces no event at all), CONDITIONS (`conditions.ts`) and PLACEHOLDERS
 * (`placeholders.ts`). Both trigger kinds now meet in `applyRuleAction`, so a
 * rule does exactly the same thing whether a person or a clock woke it.
 */

export class AutomationError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Curated event triggers — the ones that mean something to the business,
 * with an i18n label each (automation.events.*). The stage moves have their
 * own trigger kinds and are deliberately not in this list. */
export const RULE_EVENTS = [
  'ReceiptConfirmed',
  'BatchDeparted',
  'BatchUnloaded',
  'ReadyForPickup',
  'BoxIssued',
  'UnknownCargoReceived',
  'UnquotedCargo',
  'DealDeviation',
  'DealDeferralEnded',
  'MissingInTransit',
] as const;

const taskConfigSchema = z.object({
  title: z.string().trim().min(1).max(200),
  /** 'owner' = the record's responsible person, 'actor' = whoever caused the
   * event, or a concrete user id. */
  assignee: z.union([z.literal('owner'), z.literal('actor'), z.string().uuid()]),
  dueDays: z.number().int().min(0).max(365).nullable(),
  priority: z.number().int().min(1).max(3).default(2),
});
const notifyConfigSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(50),
  text: z.string().trim().min(1).max(1000),
});
export type TaskConfig = z.infer<typeof taskConfigSchema>;
export type NotifyConfig = z.infer<typeof notifyConfigSchema>;

/** Every trigger kind, in the order the form offers them. */
export const RULE_TRIGGERS = [
  'deal_stage',
  'lead_stage',
  'deal_stale',
  'lead_stale',
  'event',
] as const;

export const ruleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    triggerType: z.enum(RULE_TRIGGERS),
    triggerStageId: z.string().uuid().nullable().optional(),
    triggerEvent: z.enum(RULE_EVENTS).nullable().optional(),
    /** How long a card may sit still. Only the two time triggers read it. */
    staleDays: z.number().int().min(1).max(365).nullable().optional(),
    conditions: conditionsSchema.optional(),
    actionType: z.enum(['create_task', 'notify']),
    actionConfig: z.record(z.string(), z.unknown()),
  })
  .superRefine((rule, issues) => {
    const stale = rule.triggerType === 'lead_stale' || rule.triggerType === 'deal_stale';
    if (rule.triggerType === 'event' ? !rule.triggerEvent : !rule.triggerStageId) {
      issues.addIssue({ code: 'custom', message: 'trigger_target_required', path: ['triggerType'] });
    }
    if (stale && !rule.staleDays) {
      issues.addIssue({ code: 'custom', message: 'stale_days_required', path: ['staleDays'] });
    }
    // A condition is a question about a CARD, and a warehouse event is about
    // cargo. Refusing at the save is the honest answer: accepted-and-never-
    // fires would look like a working rule with a broken system behind it.
    const board = ruleBoard(rule.triggerType);
    for (const cond of rule.conditions ?? []) {
      if (!board || !isConditionField(board, cond.field)) {
        issues.addIssue({ code: 'custom', message: 'condition_field_invalid', path: ['conditions'] });
        break;
      }
    }
    const config =
      rule.actionType === 'create_task'
        ? taskConfigSchema.safeParse(rule.actionConfig)
        : notifyConfigSchema.safeParse(rule.actionConfig);
    if (!config.success) {
      issues.addIssue({ code: 'custom', message: 'action_config_invalid', path: ['actionConfig'] });
    }
  });
export type RuleInput = z.infer<typeof ruleSchema>;

export type RuleRow = typeof automationRules.$inferSelect;

/**
 * Does this rule fire for this event? Pure, so the tests state the whole
 * matching table without a database.
 */
export function ruleMatches(
  rule: Pick<RuleRow, 'active' | 'triggerType' | 'triggerStageId' | 'triggerEvent'>,
  event: { type: string; payload: Record<string, unknown> },
): boolean {
  if (!rule.active) return false;
  if (rule.triggerType === 'lead_stage') {
    return event.type === 'LeadStageChanged' && event.payload.stageId === rule.triggerStageId;
  }
  if (rule.triggerType === 'deal_stage') {
    return event.type === 'DealStageChanged' && event.payload.stageId === rule.triggerStageId;
  }
  return event.type === rule.triggerEvent;
}

export async function listRules(): Promise<RuleRow[]> {
  return db.select().from(automationRules).orderBy(desc(automationRules.createdAt));
}

export async function saveRule(
  input: RuleInput & { id?: string },
  ctx: AuditContext,
): Promise<string> {
  if (!ctx.actorId) throw new AutomationError('unauthenticated');
  const stale = input.triggerType === 'lead_stale' || input.triggerType === 'deal_stale';
  const values = {
    name: input.name,
    triggerType: input.triggerType,
    triggerStageId: input.triggerType === 'event' ? null : (input.triggerStageId ?? null),
    triggerEvent: input.triggerType === 'event' ? (input.triggerEvent ?? null) : null,
    // Blanked rather than kept for the kinds that ignore it, so the row never
    // says something the engine does not read.
    staleDays: stale ? (input.staleDays ?? null) : null,
    conditions: input.conditions ?? [],
    actionType: input.actionType,
    actionConfig: input.actionConfig,
  };
  if (input.id) {
    const before = await db.query.automationRules.findFirst({
      where: eq(automationRules.id, input.id),
    });
    if (!before) throw new AutomationError('not_found');
    await db
      .update(automationRules)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(automationRules.id, input.id));
    await writeAudit(db, ctx, {
      entityType: 'automation_rule',
      entityId: input.id,
      action: 'update',
      before: { name: before.name },
      after: { name: input.name, trigger: input.triggerType, action: input.actionType },
    });
    return input.id;
  }
  const [row] = await db
    .insert(automationRules)
    .values({ ...values, createdBy: ctx.actorId })
    .returning({ id: automationRules.id });
  await writeAudit(db, ctx, {
    entityType: 'automation_rule',
    entityId: row!.id,
    action: 'create',
    after: { name: input.name, trigger: input.triggerType, action: input.actionType },
  });
  return row!.id;
}

export async function setRuleActive(id: string, active: boolean, ctx: AuditContext): Promise<void> {
  const before = await db.query.automationRules.findFirst({ where: eq(automationRules.id, id) });
  if (!before) throw new AutomationError('not_found');
  await db
    .update(automationRules)
    .set({ active, updatedAt: new Date() })
    .where(eq(automationRules.id, id));
  await writeAudit(db, ctx, {
    entityType: 'automation_rule',
    entityId: id,
    action: 'update',
    before: { active: before.active },
    after: { active },
  });
}

export async function deleteRule(id: string, ctx: AuditContext): Promise<void> {
  const before = await db.query.automationRules.findFirst({ where: eq(automationRules.id, id) });
  if (!before) throw new AutomationError('not_found');
  await db.delete(automationRules).where(eq(automationRules.id, id));
  await writeAudit(db, ctx, {
    entityType: 'automation_rule',
    entityId: id,
    action: 'delete',
    before: { name: before.name },
  });
}

/**
 * What a rule is being fired ABOUT, whichever trigger woke it.
 *
 * The event path fills this from the payload (plus the loaded card when the
 * rule needs one); the stale sweep fills it from the card alone — nobody
 * caused a silence, so `actorId` is null there and an «assignee: whoever did
 * it» rule correctly finds nobody.
 */
export interface RuleTarget {
  ownerId: string | null;
  actorId: string | null;
  clientId: string | null;
  entityType: string | null;
  entityId: string | null;
  /** The card, when it was loaded — the source of every `{ism}`. */
  record: RuleRecord | null;
}

/** The record's responsible person, the event's actor, or the named user. */
async function resolveAssignee(
  strategy: TaskConfig['assignee'],
  target: RuleTarget,
): Promise<string | null> {
  if (strategy === 'actor') return target.actorId;
  if (strategy !== 'owner') return strategy;
  if (target.ownerId) return target.ownerId;
  if (target.clientId) {
    const client = await db.query.clients.findFirst({ where: eq(clients.id, target.clientId) });
    return client?.salesManagerId ?? null;
  }
  return null;
}

/** Only entity types the task registry knows may be linked; others carry no card. */
async function linkableEntity(entityType: string | null): Promise<boolean> {
  return Boolean(entityType && (await resolveEntity(entityType)));
}

/**
 * Do what the rule says. ONE implementation, both triggers.
 *
 * Written this way because a rule is a sentence the owner wrote, and «open a
 * task for the responsible person» has to mean the same thing whether a stage
 * move or three days of silence set it off. The alternative — a copy per
 * trigger — is how the two halves drift until only one of them fills `{ism}`.
 *
 * Throws; the caller owns the per-rule fence.
 */
export async function applyRuleAction(rule: RuleRow, target: RuleTarget): Promise<boolean> {
  const values = target.record ? valuesFromRecord(target.record) : {};
  if (rule.actionType === 'create_task') {
    const config = taskConfigSchema.parse(rule.actionConfig);
    const assigneeId = await resolveAssignee(config.assignee, target);
    if (!assigneeId) {
      logger.warn({ ruleId: rule.id }, 'automation rule found no assignee, skipped');
      return false;
    }
    const linked = await linkableEntity(target.entityType);
    await createTask(
      {
        title: fillPlaceholders(config.title, values),
        note: '',
        typeId: null,
        assigneeId,
        dueAt:
          config.dueDays === null
            ? ''
            : new Date(Date.now() + config.dueDays * 86_400_000).toISOString().slice(0, 10),
        priority: config.priority,
        entityType: linked ? target.entityType : null,
        entityId: linked ? target.entityId : null,
        repeatUnit: null,
        repeatEvery: 1,
      },
      // The rule acts with its author's authority: the task's "created by" is
      // the person who WROTE the rule, and the audit trail says so.
      { actorId: rule.createdBy, ip: null, userAgent: null },
    );
    return true;
  }
  const config = notifyConfigSchema.parse(rule.actionConfig);
  const link =
    target.entityType && target.entityId && (await linkableEntity(target.entityType))
      ? cardLink(target.entityType, target.entityId)
      : null;
  await notifyStaffTelegram({
    userIds: config.userIds,
    type: 'AutomationRule',
    text: `⚙️ ${rule.name}\n${fillPlaceholders(config.text, values)}${link ? `\n🔗 ${link}` : ''}`,
  });
  return true;
}

/**
 * Would this rule need the card loaded?
 *
 * A rule with no conditions and fixed words is answered entirely from the
 * event payload, and the event path fires on every drain — so the query is
 * paid only by the rules that actually spend it (#432).
 */
export function ruleNeedsRecord(rule: Pick<RuleRow, 'conditions' | 'actionConfig'>): boolean {
  if (Array.isArray(rule.conditions) && rule.conditions.length > 0) return true;
  const config = (rule.actionConfig ?? {}) as Record<string, unknown>;
  return hasPlaceholder(String(config.title ?? '')) || hasPlaceholder(String(config.text ?? ''));
}

/**
 * Fire every matching rule for one event. Called from the event worker, per
 * event, BEFORE the event is marked processed — and each rule is fenced in
 * its own try/catch, because one broken rule must neither kill the others
 * nor hold up the notification fan-out.
 */
export async function runAutomationRules(event: {
  type: string;
  payload: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  actorId: string | null;
}): Promise<number> {
  const rules = (await db
    .select()
    .from(automationRules)
    .where(eq(automationRules.active, true))) as RuleRow[];
  let fired = 0;
  for (const rule of rules) {
    if (!ruleMatches(rule, event)) continue;
    try {
      const board = ruleBoard(rule.triggerType);
      const record = ruleNeedsRecord(rule) ? await recordForEvent(board, event.payload) : null;

      const conditions = conditionsSchema.parse(rule.conditions ?? []);
      if (conditions.length > 0) {
        // A rule that asks a question it cannot answer stays quiet. The card
        // vanishing between the event and the drain is the real case here,
        // and firing anyway would apply a filtered rule unfiltered.
        if (!board || !record) continue;
        if (!conditionsMatch(conditions, conditionValues(board, record))) continue;
      }

      const payloadOwner = event.payload.ownerId;
      const payloadClient = event.payload.clientId;
      const acted = await applyRuleAction(rule, {
        ownerId: record?.ownerId ?? (typeof payloadOwner === 'string' ? payloadOwner : null),
        actorId: event.actorId,
        clientId: typeof payloadClient === 'string' ? payloadClient : null,
        entityType: event.entityType,
        entityId: event.entityId,
        record,
      });
      if (!acted) continue;

      await db
        .update(automationRules)
        .set({ fireCount: sql`${automationRules.fireCount} + 1`, lastFiredAt: new Date() })
        .where(eq(automationRules.id, rule.id));
      fired += 1;
    } catch (err) {
      if (err instanceof TaskError) {
        // An inactive assignee is a data condition, not a crash.
        logger.warn({ ruleId: rule.id, code: err.code }, 'automation rule action refused');
      } else {
        logger.error({ err, ruleId: rule.id }, 'automation rule failed');
      }
    }
  }
  return fired;
}

/** The card a funnel event was about, or null for a warehouse event. */
async function recordForEvent(
  board: ConditionBoard | null,
  payload: Record<string, unknown>,
): Promise<RuleRecord | null> {
  if (!board) return null;
  const id = board === 'lead' ? payload.leadId : payload.dealId;
  return typeof id === 'string' && id ? loadRuleRecord(board, id) : null;
}

/**
 * The hourly pass for the two time triggers.
 *
 * Lives here rather than in `stale.ts` so the sweep and the drain hand the
 * SAME `applyRuleAction` the same target — the sweep owns «which cards have
 * gone quiet», this file owns «and what a rule does about it».
 */
export async function runStaleAutomation(): Promise<number> {
  return runStaleRules(async (rule, board, card) =>
    applyRuleAction(rule, {
      ownerId: card.ownerId,
      // Nobody caused a silence. A rule assigning to «whoever did it» finds
      // no one and is skipped, loudly, in the log.
      actorId: null,
      clientId: null,
      entityType: board,
      entityId: card.id,
      record: card,
    }),
  );
}

export type { Condition, ConditionBoard };
