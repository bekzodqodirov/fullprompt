import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { automationRules, clients } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { createTask, TaskError } from '../tasks/service';
import { notifyStaffTelegram } from '../notifications/staff';
import { cardLink } from '../notifications/links';
import { entitySpec } from '../fields/registry';
import { logger } from '../logger';

/**
 * Phase 7: automation rules — «when X happens, do Y», written on a form.
 *
 * The design is the smallest thing that automates the owner's real morning:
 * a funnel move or a warehouse event fires, and the rule opens a task for
 * the right person or tells somebody in Telegram. No visual node editor (cut
 * by plan), no conditions v1, no rule may trigger another — the two actions
 * emit no domain events, so the engine structurally cannot loop.
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

export const ruleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    triggerType: z.enum(['lead_stage', 'deal_stage', 'event']),
    triggerStageId: z.string().uuid().nullable().optional(),
    triggerEvent: z.enum(RULE_EVENTS).nullable().optional(),
    actionType: z.enum(['create_task', 'notify']),
    actionConfig: z.record(z.string(), z.unknown()),
  })
  .superRefine((rule, issues) => {
    if (rule.triggerType === 'event' ? !rule.triggerEvent : !rule.triggerStageId) {
      issues.addIssue({ code: 'custom', message: 'trigger_target_required', path: ['triggerType'] });
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
  const values = {
    name: input.name,
    triggerType: input.triggerType,
    triggerStageId: input.triggerType === 'event' ? null : (input.triggerStageId ?? null),
    triggerEvent: input.triggerType === 'event' ? (input.triggerEvent ?? null) : null,
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

/** The record's responsible person, the event's actor, or the named user. */
async function resolveAssignee(
  strategy: TaskConfig['assignee'],
  event: { payload: Record<string, unknown>; actorId: string | null },
): Promise<string | null> {
  if (strategy === 'actor') return event.actorId;
  if (strategy !== 'owner') return strategy;
  const ownerId = event.payload.ownerId;
  if (typeof ownerId === 'string' && ownerId) return ownerId;
  const clientId = event.payload.clientId;
  if (typeof clientId === 'string' && clientId) {
    const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    return client?.salesManagerId ?? null;
  }
  return null;
}

/** Only entity types the task registry knows may be linked; others carry no card. */
function linkableEntity(entityType: string | null): boolean {
  return Boolean(entityType && entitySpec(entityType));
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
      if (rule.actionType === 'create_task') {
        const config = taskConfigSchema.parse(rule.actionConfig);
        const assigneeId = await resolveAssignee(config.assignee, event);
        if (!assigneeId) {
          logger.warn({ ruleId: rule.id }, 'automation rule found no assignee, skipped');
          continue;
        }
        const linked = linkableEntity(event.entityType);
        await createTask(
          {
            title: config.title,
            note: '',
            typeId: null,
            assigneeId,
            dueAt: config.dueDays === null
              ? ''
              : new Date(Date.now() + config.dueDays * 86_400_000).toISOString().slice(0, 10),
            priority: config.priority,
            entityType: linked ? event.entityType : null,
            entityId: linked ? event.entityId : null,
            repeatUnit: null,
            repeatEvery: 1,
          },
          // The rule acts with its author's authority: the task's "created
          // by" is the person who WROTE the rule, and the audit trail says so.
          { actorId: rule.createdBy, ip: null, userAgent: null },
        );
      } else {
        const config = notifyConfigSchema.parse(rule.actionConfig);
        const link =
          event.entityType && event.entityId && linkableEntity(event.entityType)
            ? cardLink(event.entityType, event.entityId)
            : null;
        await notifyStaffTelegram({
          userIds: config.userIds,
          type: 'AutomationRule',
          text: `⚙️ ${rule.name}\n${config.text}${link ? `\n🔗 ${link}` : ''}`,
        });
      }
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
