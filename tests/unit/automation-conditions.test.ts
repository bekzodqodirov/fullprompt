import { describe, expect, it } from 'vitest';
import {
  CONDITION_FIELDS,
  conditionValues,
  conditionsMatch,
  isConditionField,
  ruleBoard,
  type Condition,
} from '@/modules/platform/automation/conditions';

/**
 * Round 86's «only if…». Every case here is one the owner could actually
 * write on the form, plus the three the evaluator has to be wrong about
 * quietly rather than loudly.
 */

const cond = (field: string, op: Condition['op'], value = ''): Condition => ({ field, op, value });

describe('conditionsMatch', () => {
  it('an empty list matches everything — every rule written before this keeps its meaning', () => {
    expect(conditionsMatch([], {})).toBe(true);
    expect(conditionsMatch([], { amount: '5' })).toBe(true);
  });

  it('ANDs: all of them or none of it', () => {
    const record = { amount: '900', source: 'Instagram' };
    expect(conditionsMatch([cond('amount', 'gt', '500'), cond('source', 'eq', 'instagram')], record))
      .toBe(true);
    expect(conditionsMatch([cond('amount', 'gt', '500'), cond('source', 'eq', 'telegram')], record))
      .toBe(false);
  });

  it('compares text case-insensitively and trimmed — the owner types «Instagram», we store «instagram»', () => {
    expect(conditionsMatch([cond('source', 'eq', '  Instagram ')], { source: 'instagram' })).toBe(
      true,
    );
    expect(conditionsMatch([cond('source', 'neq', 'instagram')], { source: 'Telegram' })).toBe(true);
  });

  it('numbers compare as numbers, not as text — «9» is not more than «10»', () => {
    expect(conditionsMatch([cond('volumeM3', 'gt', '10')], { volumeM3: '9' })).toBe(false);
    expect(conditionsMatch([cond('volumeM3', 'lt', '10')], { volumeM3: '9' })).toBe(true);
    // postgres hands numerics back at full scale; the comparison must not care.
    expect(conditionsMatch([cond('amount', 'gt', '200')], { amount: '200.50' })).toBe(true);
  });

  it('a comparison nobody can make is «does not apply», never «fire»', () => {
    expect(conditionsMatch([cond('amount', 'gt', '5')], { amount: null })).toBe(false);
    expect(conditionsMatch([cond('amount', 'gt', 'katta')], { amount: '900' })).toBe(false);
    expect(conditionsMatch([cond('amount', 'lt', '5')], { amount: '' })).toBe(false);
  });

  it('empty / not_empty ask about the box', () => {
    expect(conditionsMatch([cond('phone', 'empty')], { phone: null })).toBe(true);
    expect(conditionsMatch([cond('phone', 'empty')], { phone: '   ' })).toBe(true);
    expect(conditionsMatch([cond('phone', 'not_empty')], { phone: '+998901112233' })).toBe(true);
    expect(conditionsMatch([cond('phone', 'not_empty')], { phone: null })).toBe(false);
  });

  it('an UNKNOWN field is false, not skipped — a rule written wrong stays quiet', () => {
    expect(conditionsMatch([cond('salary', 'not_empty')], { amount: '5' })).toBe(false);
    // …and it must not become true just because the operator is a negation.
    expect(conditionsMatch([cond('salary', 'neq', 'x')], { amount: '5' })).toBe(false);
    expect(conditionsMatch([cond('salary', 'empty')], { amount: '5' })).toBe(false);
  });
});

describe('conditionValues', () => {
  it('gives each board exactly the fields the form offers it', () => {
    const record = {
      source: 'Instagram',
      phone: '+998901112233',
      clientCode: 'GS777',
      amount: '900',
      volumeM3: '5',
      weightKg: '120',
      ownerId: 'u1',
    };
    expect(Object.keys(conditionValues('lead', record)).sort()).toEqual(
      [...CONDITION_FIELDS.lead].sort(),
    );
    expect(Object.keys(conditionValues('deal', record)).sort()).toEqual(
      [...CONDITION_FIELDS.deal].sort(),
    );
  });

  it('a field the board does not have is ABSENT, so asking is «does not apply» and not «it is empty»', () => {
    const deal = conditionValues('deal', { clientCode: 'GS777', amount: '900' });
    expect('phone' in deal).toBe(false);
    // The distinction that makes it matter: absent must not answer `empty`.
    expect(conditionsMatch([cond('phone', 'empty')], deal)).toBe(false);
  });
});

describe('ruleBoard', () => {
  it('both lead triggers answer lead, both deal triggers answer deal, a warehouse event answers neither', () => {
    expect(ruleBoard('lead_stage')).toBe('lead');
    expect(ruleBoard('lead_stale')).toBe('lead');
    expect(ruleBoard('deal_stage')).toBe('deal');
    expect(ruleBoard('deal_stale')).toBe('deal');
    expect(ruleBoard('event')).toBeNull();
  });
});

describe('isConditionField', () => {
  it('is the fence: only what the board carries', () => {
    expect(isConditionField('lead', 'source')).toBe(true);
    expect(isConditionField('deal', 'source')).toBe(false);
    expect(isConditionField('lead', 'clientCode')).toBe(false);
    expect(isConditionField('deal', 'clientCode')).toBe(true);
    // Not a column name anybody may reach for.
    expect(isConditionField('lead', 'password_hash')).toBe(false);
  });
});
