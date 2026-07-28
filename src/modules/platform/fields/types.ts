import { z } from 'zod';
import { ENTITY_CODES } from './registry';

/**
 * What a custom field can be, and what an answer to it looks like.
 *
 * `formula` is deliberately absent from the list the owner gave: a
 * spreadsheet engine — parser, dependency graph, recalculation on every write
 * — is a project of its own, and every formula anyone here described (landed
 * cost, density, margin) is already computed by code that knows the domain.
 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'phone'
  | 'url'
  | 'money'
  | 'lookup'
  | 'file';

export const FIELD_TYPES: FieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'phone',
  'url',
  'money',
  'lookup',
  'file',
];

/** Only these two carry a choice list; everything else ignores `options`. */
export const CHOICE_TYPES: FieldType[] = ['select', 'multiselect'];

export class FieldError extends Error {
  constructor(
    public readonly code: string,
    /** The field the complaint is about, so the form can point at it. */
    public readonly fieldLabel?: string,
  ) {
    super(code);
  }
}

/**
 * Per-field validation the owner types in, not a developer.
 *
 * `pattern` is a regular expression, which is the one rule here that can hurt:
 * a catastrophic backtracker typed into an admin form would hang a request.
 * It is length-capped and only ever run against a value that is itself capped,
 * which bounds the damage; anything more would mean shipping a regex engine
 * with a timeout, and the audience for this box is one person.
 */
export const rulesSchema = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  minLength: z.number().int().min(0).max(4000).optional(),
  maxLength: z.number().int().min(1).max(4000).optional(),
  pattern: z.string().max(200).optional(),
});
export type FieldRules = z.infer<typeof rulesSchema>;

/** Show this field only when another one holds one of these answers. */
export const showIfSchema = z.object({
  fieldId: z.string().uuid(),
  values: z.array(z.string().max(200)).min(1).max(50),
});
export type ShowIf = z.infer<typeof showIfSchema>;

export const fieldSchema = z.object({
  entityType: z.enum(ENTITY_CODES as [string, ...string[]]),
  label: z.string().trim().min(1).max(120),
  type: z.enum(FIELD_TYPES as [FieldType, ...FieldType[]]),
  options: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  help: z.string().trim().max(300).optional().or(z.literal('')),
  rules: rulesSchema.default({}),
  showIf: showIfSchema.nullable().default(null),
  required: z.boolean().default(false),
  onList: z.boolean().default(false),
  lookupEntity: z.string().nullable().default(null),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
});
export type FieldInput = z.infer<typeof fieldSchema>;

/** The definition rows the rest of the module reads. */
export interface FieldDef {
  id: string;
  entityType: string;
  label: string;
  type: string;
  options: unknown;
  help: string | null;
  rules: unknown;
  showIf: unknown;
  required: boolean;
  onList: boolean;
  lookupEntity: string | null;
  sortOrder: number;
  active: boolean;
}

/** An answer, in the shape the typed columns store. */
export type StoredValue =
  | { kind: 'text'; text: string }
  | { kind: 'num'; num: number; ccy?: string }
  | { kind: 'date'; date: string }
  | { kind: 'bool'; bool: boolean }
  | { kind: 'list'; list: string[] }
  | { kind: 'ref'; ref: string };

export function options(field: Pick<FieldDef, 'options'>): string[] {
  return Array.isArray(field.options) ? (field.options as string[]) : [];
}

export function rulesOf(field: Pick<FieldDef, 'rules'>): FieldRules {
  const parsed = rulesSchema.safeParse(field.rules ?? {});
  return parsed.success ? parsed.data : {};
}

export function showIfOf(field: Pick<FieldDef, 'showIf'>): ShowIf | null {
  if (!field.showIf) return null;
  const parsed = showIfSchema.safeParse(field.showIf);
  return parsed.success ? parsed.data : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkText(value: string, rules: FieldRules, label: string): void {
  if (rules.minLength !== undefined && value.length < rules.minLength) {
    throw new FieldError('too_short', label);
  }
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    throw new FieldError('too_long', label);
  }
  if (rules.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(rules.pattern);
    } catch {
      // A pattern that no longer compiles must not block a save — the field
      // definition is the thing that is broken, and it is fixed elsewhere.
      return;
    }
    if (!re.test(value)) throw new FieldError('pattern', label);
  }
}

function checkNumber(value: number, rules: FieldRules, label: string): void {
  if (rules.min !== undefined && value < rules.min) throw new FieldError('too_small', label);
  if (rules.max !== undefined && value > rules.max) throw new FieldError('too_big', label);
}

/**
 * Coerce one raw form value to what its field declared, applying its rules.
 *
 * Returns `null` for "no answer" — the caller deletes those rows rather than
 * storing an empty string, so "left blank" and "answered with nothing" cannot
 * drift apart in a report.
 */
export function coerceValue(field: FieldDef, raw: unknown): StoredValue | null {
  const label = field.label;
  const rules = rulesOf(field);
  const choices = options(field);
  const type = field.type as FieldType;

  switch (type) {
    case 'checkbox': {
      // An unticked box is a real "no", not a missing answer. The widget
      // posts a hidden 'off' FIRST and the tick appends 'on', so a ticked
      // box arrives as ['off','on'] — the LAST value is the real answer
      // (forms/checkbox.ts, the idiom this engine never adopted; without it
      // BOTH states coerced to false and every tick vanished on save).
      const last = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      return { kind: 'bool', bool: last === true || last === 'on' || last === 'true' };
    }

    case 'number':
    case 'money': {
      const first = Array.isArray(raw) ? raw[0] : raw;
      const text = String(first ?? '')
        .replace(/\s/g, '')
        .replace(',', '.');
      if (!text) return null;
      const num = Number(text);
      if (!Number.isFinite(num)) throw new FieldError('bad_number', label);
      checkNumber(num, rules, label);
      if (type === 'number') return { kind: 'num', num };
      // Money carries its currency in the same row; the amount is meaningless
      // without it, and a default would silently price things in dollars.
      const ccy = String((Array.isArray(raw) ? raw[1] : undefined) ?? '')
        .trim()
        .toUpperCase();
      if (!/^[A-Z]{3}$/.test(ccy)) throw new FieldError('bad_currency', label);
      return { kind: 'num', num, ccy };
    }

    case 'date': {
      const value = String(raw ?? '').trim();
      if (!value) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new FieldError('bad_date', label);
      return { kind: 'date', date: value };
    }

    case 'select': {
      const value = String(raw ?? '').trim();
      if (!value) return null;
      if (!choices.includes(value)) throw new FieldError('bad_option', label);
      return { kind: 'text', text: value };
    }

    case 'multiselect': {
      const list = (Array.isArray(raw) ? raw : [raw])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
      if (list.length === 0) return null;
      if (list.some((item) => !choices.includes(item))) throw new FieldError('bad_option', label);
      return { kind: 'list', list: [...new Set(list)] };
    }

    case 'lookup':
    case 'file': {
      const value = String(raw ?? '').trim();
      if (!value) return null;
      if (!UUID.test(value)) throw new FieldError('bad_reference', label);
      return { kind: 'ref', ref: value };
    }

    default: {
      const value = String(raw ?? '').trim();
      if (!value) return null;
      const clipped = value.slice(0, 4000);
      checkText(clipped, rules, label);
      return { kind: 'text', text: clipped };
    }
  }
}

/** The column patch a stored value writes. */
export function toColumns(value: StoredValue) {
  return {
    valueText: value.kind === 'text' ? value.text : null,
    valueNum: value.kind === 'num' ? String(value.num) : null,
    valueDate: value.kind === 'date' ? value.date : null,
    valueBool: value.kind === 'bool' ? value.bool : null,
    valueList: value.kind === 'list' ? value.list : null,
    valueRef: value.kind === 'ref' ? value.ref : null,
    valueCcy: value.kind === 'num' ? (value.ccy ?? null) : null,
  };
}

export interface ValueRow {
  valueText: string | null;
  valueNum: string | null;
  valueDate: string | null;
  valueBool: boolean | null;
  valueList: unknown;
  valueRef: string | null;
  valueCcy: string | null;
}

/** The plain JavaScript value a row holds, for rendering and export. */
export function fromRow(row: ValueRow): unknown {
  if (row.valueText !== null) return row.valueText;
  if (row.valueNum !== null) {
    return row.valueCcy ? { amount: Number(row.valueNum), currency: row.valueCcy } : Number(row.valueNum);
  }
  if (row.valueDate !== null) return row.valueDate;
  if (row.valueBool !== null) return row.valueBool;
  if (row.valueList !== null && row.valueList !== undefined) return row.valueList;
  if (row.valueRef !== null) return row.valueRef;
  return null;
}

/**
 * Is this field shown, given the answers alongside it?
 *
 * Used by the server to decide what to render and by the browser to hide and
 * show as the parent changes. A hidden field's answer is NOT deleted: a
 * predicate flipping — because someone changed a dropdown, or because the
 * parent field was deactivated — would otherwise wipe stored answers across
 * every record, silently, as unrelated edits were saved.
 */
export function isVisible(field: FieldDef, answers: Record<string, unknown>): boolean {
  const rule = showIfOf(field);
  if (!rule) return true;
  const parent = answers[rule.fieldId];
  if (parent === null || parent === undefined) return false;
  const have = Array.isArray(parent) ? parent.map(String) : [String(parent)];
  return have.some((value) => rule.values.includes(value));
}
