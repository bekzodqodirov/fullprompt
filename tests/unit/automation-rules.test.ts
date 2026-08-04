import { describe, expect, it } from 'vitest';
import { RULE_EVENTS, ruleMatches, ruleSchema } from '@/modules/platform/automation/service';

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
