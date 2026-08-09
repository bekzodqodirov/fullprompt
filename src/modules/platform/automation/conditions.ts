import { z } from 'zod';

/**
 * «Only if the cargo is more than 5 kub», «only Instagram leads» (round 86).
 *
 * Phase 7 shipped a rule as trigger → action, and the owner's own example for
 * what was missing was a condition: a rule that fires on every card in a stage
 * is a rule that gets switched off after a week. The list is ANDed and empty
 * matches everything, so every rule written before this keeps its meaning.
 *
 * The FIELDS are a fixed, curated list rather than «any column», and that is
 * the whole safety of the feature: a rule is written by an admin and evaluated
 * by the server against a record it did not choose, so an open field name
 * would be a way to read anything the row happens to carry. Each entry names
 * one board, so the form can only offer what the trigger can actually answer.
 *
 * The two boards deliberately SHARE the names of the four things both carry
 * (round 71 gave a lead its own quote), so one loaded record answers either
 * board and a rule reads the same whichever funnel it watches.
 */

export const CONDITION_FIELDS = {
  lead: ['source', 'phone', 'amount', 'volumeM3', 'weightKg', 'ownerId'],
  deal: ['clientCode', 'amount', 'volumeM3', 'weightKg', 'ownerId'],
} as const;

export type ConditionBoard = keyof typeof CONDITION_FIELDS;

/**
 * Which funnel a trigger is about — null for a warehouse event, which is
 * about cargo and belongs to no board. Conditions and `{ism}` both need this
 * answer, so it is stated once.
 */
export function ruleBoard(triggerType: string): ConditionBoard | null {
  if (triggerType === 'lead_stage' || triggerType === 'lead_stale') return 'lead';
  if (triggerType === 'deal_stage' || triggerType === 'deal_stale') return 'deal';
  return null;
}

/**
 * Six operators, and no more.
 *
 * `gt`/`lt` are numeric and refuse a value that is not a number on BOTH sides
 * — comparing «5» with «katta yuk» must be false rather than whatever
 * JavaScript decides, because the answer to a comparison nobody can make is
 * «this rule does not apply», never «fire».
 */
export const CONDITION_OPS = ['eq', 'neq', 'gt', 'lt', 'empty', 'not_empty'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const conditionSchema = z.object({
  field: z.string().trim().min(1).max(40),
  op: z.enum(CONDITION_OPS),
  /** Compared as text or as a number depending on the operator; never eval'd. */
  value: z.string().trim().max(200).default(''),
});
export type Condition = z.infer<typeof conditionSchema>;

export const conditionsSchema = z.array(conditionSchema).max(10).default([]);

/** Is this a field the named board is allowed to be asked about? */
export function isConditionField(board: ConditionBoard, field: string): boolean {
  return (CONDITION_FIELDS[board] as readonly string[]).includes(field);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Does this record satisfy every condition?
 *
 * ANDed, and an UNKNOWN field is false — not skipped. A rule that names a
 * field the record does not carry is a rule somebody wrote wrong, and firing
 * it on everything would be the loudest possible way to be wrong; refusing to
 * fire is quiet and the rule's own fire count says it never ran.
 */
export function conditionsMatch(conditions: Condition[], record: Record<string, unknown>): boolean {
  return conditions.every((cond) => {
    if (!(cond.field in record)) return false;
    const raw = record[cond.field];

    if (cond.op === 'empty') return asText(raw) === '';
    if (cond.op === 'not_empty') return asText(raw) !== '';

    if (cond.op === 'gt' || cond.op === 'lt') {
      const left = asNumber(raw);
      const right = asNumber(cond.value);
      // Either side unreadable as a number: the comparison cannot be made, so
      // the rule does not apply.
      if (left === null || right === null) return false;
      return cond.op === 'gt' ? left > right : left < right;
    }

    // Text equality, trimmed and case-insensitive: the owner types «Instagram»
    // into a box and the stored source may be «instagram».
    const left = asText(raw).toLowerCase();
    const right = asText(cond.value).toLowerCase();
    return cond.op === 'eq' ? left === right : left !== right;
  });
}

/**
 * A loaded card, keyed the way `CONDITION_FIELDS` names things.
 *
 * Structural on purpose: the loader and the stale sweep both hand their row
 * here, so the evaluator and the form's field list cannot drift apart. A
 * field the board does not have is ABSENT rather than null, because
 * `conditionsMatch` reads absence as «this rule does not apply» and null as
 * «empty» — asking a deal about `phone` must not answer «yes, it is empty».
 */
export function conditionValues(
  board: ConditionBoard,
  record: {
    source?: string | null;
    phone?: string | null;
    clientCode?: string | null;
    amount?: string | null;
    volumeM3?: string | null;
    weightKg?: string | null;
    ownerId?: string | null;
  },
): Record<string, unknown> {
  const shared = {
    amount: record.amount ?? null,
    volumeM3: record.volumeM3 ?? null,
    weightKg: record.weightKg ?? null,
    ownerId: record.ownerId ?? null,
  };
  return board === 'lead'
    ? { source: record.source ?? null, phone: record.phone ?? null, ...shared }
    : { clientCode: record.clientCode ?? null, ...shared };
}
