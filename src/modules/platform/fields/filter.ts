import { sql, type Column, type SQL } from 'drizzle-orm';
import { customFieldValues } from '../db/schema';
import { fieldValuesFor, lookupLabels } from './service';
import type { FieldDef } from './types';

/**
 * Filtering, sorting and exporting BY a custom field.
 *
 * Deliberately not a generic query builder. Every list screen in this app is
 * hand-written against its own tables with its own warehouse scoping, and a
 * builder that reproduced all of that from a registry would be a second,
 * untyped copy of the whole read layer. Instead this returns SQL FRAGMENTS a
 * screen drops into the query it already has, and a decorator that hangs the
 * answers onto rows it has already fetched.
 */

export interface FieldFilter {
  fieldId: string;
  /** The raw value from the query string. */
  value: string;
}

/**
 * Read `cf_<uuid>=…` out of a screen's searchParams.
 *
 * Same prefix as the form inputs, so a filter and an answer are named the same
 * thing everywhere and nobody has to remember two conventions.
 */
export function readFilters(
  params: Record<string, string | string[] | undefined>,
  fields: FieldDef[],
): FieldFilter[] {
  const known = new Set(fields.map((field) => field.id));
  const out: FieldFilter[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (!key.startsWith('cf_')) continue;
    const fieldId = key.slice(3);
    if (!known.has(fieldId)) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) out.push({ fieldId, value });
  }
  return out;
}

/**
 * One EXISTS per filter, ANDed — the shape that composes with any query.
 *
 * A JOIN would multiply rows when a record answers several fields, and a
 * subquery in the join predicate is the table scan DECISIONS #152 was written
 * about. EXISTS is index-backed by (field_id, value_*) and cannot change the
 * row count.
 */
export function fieldFilterSql(
  entityType: string,
  idColumn: Column,
  fields: FieldDef[],
  filters: FieldFilter[],
): SQL | undefined {
  const parts: SQL[] = [];
  for (const filter of filters) {
    const field = fields.find((candidate) => candidate.id === filter.fieldId);
    if (!field) continue;
    const predicate = valuePredicate(field, filter.value);
    if (!predicate) continue;
    parts.push(
      sql`EXISTS (SELECT 1 FROM ${customFieldValues} v
                  WHERE v.entity_id = ${idColumn}
                    AND v.entity_type = ${entityType}
                    AND v.field_id = ${filter.fieldId}
                    AND ${predicate})`,
    );
  }
  if (parts.length === 0) return undefined;
  return sql.join(parts, sql` AND `);
}

/**
 * What "matches" means for each type.
 *
 * A number filter accepts `5`, `>5`, `<5` and `5..9`, because "show me
 * everyone shipping more than ten cubes a month" is the question the owner
 * actually asked, and a dropdown of exact amounts cannot answer it.
 */
/**
 * A real number, not merely digits and dots.
 *
 * Anything this refuses becomes «no filter» rather than a malformed cast: a
 * half-typed box is a person still typing, and the honest answer to that is
 * the unfiltered list, never an error page.
 */
export function isNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

function valuePredicate(field: FieldDef, raw: string): SQL | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  switch (field.type) {
    case 'checkbox':
      return sql`v.value_bool = ${value === 'true' || value === 'on'}`;

    case 'number':
    case 'money': {
      const range = value.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/);
      if (range) {
        return sql`v.value_num BETWEEN ${range[1]} AND ${range[2]}`;
      }
      const cmp = value.match(/^([<>]=?)\s*(-?[\d.]+)$/);
      if (cmp && isNumeric(cmp[2]!)) {
        const num = cmp[2]!;
        if (cmp[1] === '>') return sql`v.value_num > ${num}`;
        if (cmp[1] === '>=') return sql`v.value_num >= ${num}`;
        if (cmp[1] === '<') return sql`v.value_num < ${num}`;
        return sql`v.value_num <= ${num}`;
      }
      // `[\d.]+` is a character CLASS, not a number: it accepts «5..», which
      // is exactly what a manager types halfway through the range syntax the
      // filter box's own placeholder teaches them (`Kub (>10, 5..9)`). That
      // reached postgres as `value_num = '5..'` → 22P02, and /admin/clients
      // is a server component with no catch, so the whole client book became
      // the error page until the box was cleared.
      if (!isNumeric(value)) return undefined;
      return sql`v.value_num = ${value}`;
    }

    case 'date': {
      const range = value.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
      if (range) return sql`v.value_date BETWEEN ${range[1]} AND ${range[2]}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
      return sql`v.value_date = ${value}`;
    }

    case 'select':
      return sql`v.value_text = ${value}`;

    case 'multiselect':
      // Chose this option among however many the record carries.
      return sql`v.value_list @> ${JSON.stringify([value])}::jsonb`;

    case 'lookup':
    case 'file':
      return sql`v.value_ref::text = ${value}`;

    default:
      // Free text is a contains match: nobody filters a note by typing it out.
      return sql`v.value_text ILIKE ${`%${value}%`}`;
  }
}

/**
 * Hang each row's answers onto it as `cf_<id>` keys.
 *
 * That is exactly the shape `sortRows` already understands, so sorting by a
 * custom field is the existing mechanism with a longer allow-list rather than
 * a second one. Sorting stays in memory on purpose: every list here is capped
 * with `.limit()` and none of them paginate, so the rows being ordered are
 * already in hand — and a number sorts as a number because it arrives from a
 * numeric column rather than out of a jsonb blob.
 */
export async function decorateRows<T extends { id: string }>(
  entityType: string,
  rows: T[],
  fields: FieldDef[],
): Promise<(T & Record<string, unknown>)[]> {
  if (rows.length === 0 || fields.length === 0) return rows as (T & Record<string, unknown>)[];
  const values = await fieldValuesFor(
    entityType,
    rows.map((row) => row.id),
  );

  // Lookup answers are uuids; resolve them once for the whole page.
  const labels = new Map<string, Map<string, string>>();
  for (const field of fields) {
    if (field.type !== 'lookup' || !field.lookupEntity) continue;
    const ids = rows
      .map((row) => values[row.id]?.[field.id])
      .filter((value): value is string => typeof value === 'string');
    if (ids.length) labels.set(field.id, await lookupLabels(field.lookupEntity, [...new Set(ids)]));
  }

  return rows.map((row) => {
    const decorated: Record<string, unknown> = { ...row };
    for (const field of fields) {
      decorated[`cf_${field.id}`] = displayValue(field, values[row.id]?.[field.id], labels.get(field.id));
    }
    return decorated as T & Record<string, unknown>;
  });
}

/** One answer as text, for a table cell or a spreadsheet column. */
export function displayValue(
  field: FieldDef,
  value: unknown,
  labels?: Map<string, string>,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'checkbox':
      return value === true;
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'money': {
      const money = value as { amount: number; currency: string };
      return typeof money?.amount === 'number' ? `${money.amount} ${money.currency}` : null;
    }
    case 'multiselect':
      return Array.isArray(value) ? value.join(', ') : null;
    case 'lookup':
      // The row it pointed at is gone; the answer still happened.
      return labels?.get(String(value)) ?? '—';
    case 'file':
      return value ? '📎' : null;
    default:
      return String(value);
  }
}

/** The custom columns a list screen shows, in the order the owner set. */
export function listColumns(fields: FieldDef[]): FieldDef[] {
  return fields.filter((field) => field.active && field.onList);
}
