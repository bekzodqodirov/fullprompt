import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { crmFields, crmFieldValues } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { CrmError } from './service';

/**
 * Custom fields (owner: "maximalna custom qilish imkoni bo'lsin, amoCRM /
 * Bitrix kabi").
 *
 * The owner decides what a lead or a client card asks for — "qaysi shahar",
 * "oyiga necha kub", "qaysi tovar" — without a deploy. `type` is the load
 * bearing part: it picks the input widget AND the validation, so a field
 * declared as a date can never end up holding "keyinroq".
 *
 * Answers live in their own table rather than a jsonb blob on the card:
 * renaming a field must not orphan its answers, and a select field that loses
 * an option must be able to report which cards still carry it.
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
  | 'url';

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
];

/** Only these two carry a choice list; everything else ignores `options`. */
const CHOICE_TYPES: FieldType[] = ['select', 'multiselect'];

export const fieldSchema = z.object({
  entityType: z.enum(['lead', 'client']),
  label: z.string().trim().min(1).max(120),
  type: z.enum(FIELD_TYPES as [FieldType, ...FieldType[]]),
  options: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  required: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
});

export async function listFields(entityType: 'lead' | 'client', includeInactive = false) {
  return db
    .select()
    .from(crmFields)
    .where(
      includeInactive
        ? eq(crmFields.entityType, entityType)
        : and(eq(crmFields.entityType, entityType), eq(crmFields.active, true)),
    )
    .orderBy(asc(crmFields.sortOrder), asc(crmFields.label));
}

export async function saveField(
  input: z.infer<typeof fieldSchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const choice = CHOICE_TYPES.includes(input.type);
  const options = choice ? [...new Set(input.options.filter(Boolean))] : [];
  // A select with nothing to select from renders an empty dropdown that
  // silently refuses every save — catch it here, not in the browser.
  if (choice && options.length === 0) throw new CrmError('options_required');

  if (input.id) {
    const before = await db.query.crmFields.findFirst({ where: eq(crmFields.id, input.id) });
    if (!before) throw new CrmError('not_found');
    // Changing the type would leave every stored answer in the old shape.
    // Renaming, reordering and editing the choices stay allowed.
    if (before.type !== input.type) throw new CrmError('type_locked');
    if (before.entityType !== input.entityType) throw new CrmError('entity_locked');
  }

  const values = {
    entityType: input.entityType,
    label: input.label,
    type: input.type,
    options,
    required: input.required,
    sortOrder: input.sortOrder,
    active: input.active,
  };
  const [row] = input.id
    ? await db.update(crmFields).set(values).where(eq(crmFields.id, input.id)).returning()
    : await db.insert(crmFields).values(values).returning();
  if (!row) throw new CrmError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'crm_field',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

/**
 * Delete a field AND its answers.
 *
 * Deactivating is the everyday move — it hides the field while keeping what
 * people already typed — so this asks for the answer count first and the UI
 * shows it before confirming.
 */
export async function deleteField(id: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const field = await db.query.crmFields.findFirst({ where: eq(crmFields.id, id) });
  if (!field) throw new CrmError('not_found');
  await db.delete(crmFields).where(eq(crmFields.id, id));
  await writeAudit(db, ctx, {
    entityType: 'crm_field',
    entityId: id,
    action: 'delete',
    before: { label: field.label, type: field.type },
  });
}

export async function countFieldAnswers(id: string) {
  const rows = await db
    .select({ entityId: crmFieldValues.entityId })
    .from(crmFieldValues)
    .where(eq(crmFieldValues.fieldId, id));
  return rows.length;
}

/** Stored answers for one card, keyed by field id. */
export async function fieldValues(entityType: 'lead' | 'client', entityId: string) {
  const rows = await db
    .select()
    .from(crmFieldValues)
    .where(and(eq(crmFieldValues.entityType, entityType), eq(crmFieldValues.entityId, entityId)));
  return Object.fromEntries(rows.map((row) => [row.fieldId, row.value])) as Record<string, unknown>;
}

/** The same, for a list of cards — one query instead of one per row. */
export async function fieldValuesFor(entityType: 'lead' | 'client', entityIds: string[]) {
  if (entityIds.length === 0) return {} as Record<string, Record<string, unknown>>;
  const rows = await db
    .select()
    .from(crmFieldValues)
    .where(
      and(eq(crmFieldValues.entityType, entityType), inArray(crmFieldValues.entityId, entityIds)),
    );
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    (out[row.entityId] ??= {})[row.fieldId] = row.value;
  }
  return out;
}

/**
 * Coerce one raw form value to what its field declared.
 *
 * Returns `null` for "no answer" — the caller deletes those rows rather than
 * storing an empty string, so "field left blank" and "field answered with
 * nothing" cannot drift apart in the reports.
 */
export function coerceFieldValue(
  field: { type: string; options: unknown },
  raw: unknown,
): unknown | null {
  const options = Array.isArray(field.options) ? (field.options as string[]) : [];
  switch (field.type as FieldType) {
    case 'checkbox':
      // An unticked box is a real "no", not a missing answer.
      return raw === true || raw === 'on' || raw === 'true';
    case 'number': {
      if (raw === '' || raw === null || raw === undefined) return null;
      const value = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(value)) throw new CrmError('bad_number');
      return value;
    }
    case 'date': {
      const value = String(raw ?? '').trim();
      if (!value) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CrmError('bad_date');
      return value;
    }
    case 'select': {
      const value = String(raw ?? '').trim();
      if (!value) return null;
      if (!options.includes(value)) throw new CrmError('bad_option');
      return value;
    }
    case 'multiselect': {
      const list = (Array.isArray(raw) ? raw : [raw])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
      if (list.length === 0) return null;
      if (list.some((item) => !options.includes(item))) throw new CrmError('bad_option');
      return [...new Set(list)];
    }
    default: {
      const value = String(raw ?? '').trim();
      return value ? value.slice(0, 4000) : null;
    }
  }
}

/**
 * Write a whole card's custom answers.
 *
 * Only fields present in `raw` are touched, so a form that renders a subset
 * (the quick-add dialog) cannot wipe what the full card collected.
 */
export async function setFieldValues(
  entityType: 'lead' | 'client',
  entityId: string,
  raw: Record<string, unknown>,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new CrmError('unauthenticated');
  const fields = await listFields(entityType, true);
  const touched: Record<string, unknown> = {};

  for (const field of fields) {
    if (!(field.id in raw)) continue;
    const value = coerceFieldValue(field, raw[field.id]);
    if (value === null) {
      if (field.required && field.active) throw new CrmError('field_required');
      await db
        .delete(crmFieldValues)
        .where(and(eq(crmFieldValues.fieldId, field.id), eq(crmFieldValues.entityId, entityId)));
      touched[field.label] = null;
      continue;
    }
    await db
      .insert(crmFieldValues)
      .values({ fieldId: field.id, entityType, entityId, value })
      .onConflictDoUpdate({
        target: [crmFieldValues.fieldId, crmFieldValues.entityId],
        set: { value, updatedAt: new Date() },
      });
    touched[field.label] = value;
  }

  if (Object.keys(touched).length > 0) {
    await writeAudit(db, ctx, {
      entityType: `crm_${entityType}_fields`,
      entityId,
      action: 'update',
      after: touched,
    });
  }
}
