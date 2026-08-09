import { describe, expect, it } from 'vitest';
import {
  RULE_EVENTS,
  ruleMatches,
  ruleNeedsRecord,
  ruleSchema,
} from '@/modules/platform/automation/service';

/**
 * Phase 7's matching table and the form contract, as pure predicates — the
 * real functions, not restatements (#166). The db half (a rule actually
 * opening a task) lives in the integration suite.
 */

const stageId = '11111111-1111-4111-8111-111111111111';
const otherStage = '22222222-2222-4222-8222-222222222222';

describe('rule matching', () => {
  const dealRule = {
    active: true,
    triggerType: 'deal_stage',
    triggerStageId: stageId,
    triggerEvent: null,
  };

  it('a deal-stage rule fires only for ITS stage of the right event', () => {
    expect(ruleMatches(dealRule, { type: 'DealStageChanged', payload: { stageId } })).toBe(true);
    expect(
      ruleMatches(dealRule, { type: 'DealStageChanged', payload: { stageId: otherStage } }),
    ).toBe(false);
    // A LEAD reaching the same-named stage is a different funnel entirely.
    expect(ruleMatches(dealRule, { type: 'LeadStageChanged', payload: { stageId } })).toBe(false);
    expect(ruleMatches(dealRule, { type: 'ReceiptConfirmed', payload: {} })).toBe(false);
  });

  it('an event rule fires on exactly its event', () => {
    const rule = {
      active: true,
      triggerType: 'event',
      triggerStageId: null,
      triggerEvent: 'ReceiptConfirmed',
    };
    expect(ruleMatches(rule, { type: 'ReceiptConfirmed', payload: {} })).toBe(true);
    expect(ruleMatches(rule, { type: 'BoxIssued', payload: {} })).toBe(false);
  });

  it('a paused rule never fires', () => {
    expect(
      ruleMatches({ ...dealRule, active: false }, { type: 'DealStageChanged', payload: { stageId } }),
    ).toBe(false);
  });
});

describe('rule form contract', () => {
  const base = {
    name: 'Yangi mijozga qo‘ng‘iroq',
    triggerType: 'deal_stage',
    triggerStageId: stageId,
    triggerEvent: null,
    actionType: 'create_task',
    actionConfig: { title: 'Qo‘ng‘iroq qiling', assignee: 'owner', dueDays: 2, priority: 2 },
  };

  it('accepts a well-formed task rule and a notify rule', () => {
    expect(ruleSchema.safeParse(base).success).toBe(true);
    expect(
      ruleSchema.safeParse({
        ...base,
        actionType: 'notify',
        actionConfig: { userIds: [stageId], text: 'Yuk keldi' },
      }).success,
    ).toBe(true);
  });

  it('a stage trigger without a stage — or an event trigger without an event — is refused', () => {
    expect(ruleSchema.safeParse({ ...base, triggerStageId: null }).success).toBe(false);
    expect(
      ruleSchema.safeParse({ ...base, triggerType: 'event', triggerStageId: null }).success,
    ).toBe(false);
  });

  it('the action config is validated for ITS action type, not just any shape', () => {
    // A notify config under a task action is not a task config.
    expect(
      ruleSchema.safeParse({ ...base, actionConfig: { userIds: [stageId], text: 'x' } }).success,
    ).toBe(false);
    // Empty recipient list means the rule would fire into silence.
    expect(
      ruleSchema.safeParse({
        ...base,
        actionType: 'notify',
        actionConfig: { userIds: [], text: 'x' },
      }).success,
    ).toBe(false);
  });

  it('only curated events may trigger — the audit-trail-only types are not offered', () => {
    expect((RULE_EVENTS as readonly string[]).includes('BoxLabeled')).toBe(false);
    expect(
      ruleSchema.safeParse({
        ...base,
        triggerType: 'event',
        triggerStageId: null,
        triggerEvent: 'BoxLabeled',
      }).success,
    ).toBe(false);
  });
});

/**
 * Round 86's three additions to the form contract. Every refusal here is one
 * the owner can actually reach on /admin/rules, and each has words of its own
 * in all four bundles — a code with no message would print the key.
 */
describe('the form contract, round 86', () => {
  const taskAction = {
    actionType: 'create_task' as const,
    actionConfig: { title: 'x', assignee: 'owner', dueDays: null, priority: 2 },
  };

  it('a time trigger needs BOTH halves: which column, and how long is too long', () => {
    const base = {
      name: 'qotgan lid',
      triggerType: 'lead_stale' as const,
      triggerStageId: stageId,
      triggerEvent: null,
      ...taskAction,
    };
    expect(ruleSchema.safeParse({ ...base, staleDays: 3 }).success).toBe(true);
    const noDays = ruleSchema.safeParse({ ...base, staleDays: null });
    expect(noDays.success).toBe(false);
    expect(noDays.error?.issues.map((i) => i.message)).toContain('stale_days_required');
    // No column to watch is the same refusal the move triggers already gave.
    expect(
      ruleSchema.safeParse({ ...base, triggerStageId: null, staleDays: 3 }).success,
    ).toBe(false);
    // A silence measured in zero days is not a silence.
    expect(ruleSchema.safeParse({ ...base, staleDays: 0 }).success).toBe(false);
  });

  it('a condition must name a field the trigger’s own board carries', () => {
    const dealRule = {
      name: 'katta bitim',
      triggerType: 'deal_stage' as const,
      triggerStageId: stageId,
      triggerEvent: null,
      ...taskAction,
    };
    expect(
      ruleSchema.safeParse({
        ...dealRule,
        conditions: [{ field: 'amount', op: 'gt', value: '500' }],
      }).success,
    ).toBe(true);
    // `source` is a LEAD's field; a deal has none.
    const wrongBoard = ruleSchema.safeParse({
      ...dealRule,
      conditions: [{ field: 'source', op: 'eq', value: 'Instagram' }],
    });
    expect(wrongBoard.success).toBe(false);
    expect(wrongBoard.error?.issues.map((i) => i.message)).toContain('condition_field_invalid');
    // And nothing may reach for a column that is not on the list at all.
    expect(
      ruleSchema.safeParse({
        ...dealRule,
        conditions: [{ field: 'password_hash', op: 'not_empty', value: '' }],
      }).success,
    ).toBe(false);
  });

  it('a warehouse event may carry no condition — cargo belongs to no funnel', () => {
    const eventRule = {
      name: 'yuk keldi',
      triggerType: 'event' as const,
      triggerStageId: null,
      triggerEvent: 'ReceiptConfirmed' as const,
      ...taskAction,
    };
    expect(ruleSchema.safeParse(eventRule).success).toBe(true);
    expect(
      ruleSchema.safeParse({
        ...eventRule,
        conditions: [{ field: 'amount', op: 'gt', value: '5' }],
      }).success,
    ).toBe(false);
  });
});

describe('ruleNeedsRecord', () => {
  it('only a rule that filters or names somebody pays for the extra query', () => {
    expect(
      ruleNeedsRecord({ conditions: [], actionConfig: { title: 'Mijozga qo‘ng‘iroq qiling' } }),
    ).toBe(false);
    expect(
      ruleNeedsRecord({ conditions: [], actionConfig: { title: '{ism} ga qo‘ng‘iroq qiling' } }),
    ).toBe(true);
    expect(ruleNeedsRecord({ conditions: [], actionConfig: { text: '{kod} kutyapti' } })).toBe(true);
    expect(
      ruleNeedsRecord({
        conditions: [{ field: 'amount', op: 'gt', value: '5' }],
        actionConfig: { title: 'fixed' },
      }),
    ).toBe(true);
  });
});
