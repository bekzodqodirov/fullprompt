import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../db/client';
import { customEntities, customFields, customFieldValues } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { resolveEntity } from '../entities/service';
import { ENTITY_SPECS, entitySpec } from './registry';
import {
  CHOICE_TYPES,
  FieldError,
  coerceValue,
  fromRow,
  isVisible,
  toColumns,
  type FieldDef,
  type FieldInput,
} from './types';

/**
 * Custom fields, for every object rather than two.
 *
 * This is the CRM engine from migration 0022 lifted to the platform layer and
 * given three things it lacked: an entity list the database enforces from a
 * registry, typed storage so a number filters and sorts as a number, and
 * per-field rules and conditional visibility.
 */

export async function listFields(
  entityType: string,
  includeInactive = false,
): Promise<FieldDef[]> {
  const rows = await db
    .select()
    .from(customFields)
    .where(
      includeInactive
        ? eq(customFields.entityType, entityType)
        : and(eq(customFields.entityType, entityType), eq(customFields.active, true)),
    )
    .orderBy(asc(customFields.sortOrder), asc(customFields.label));
  return rows as FieldDef[];
}

/** Every definition in the system, for the admin screen. */
export async function allFields(): Promise<FieldDef[]> {
  const rows = await db
    .select()
    .from(customFields)
    .orderBy(asc(customFields.entityType), asc(customFields.sortOrder), asc(customFields.label));
  return rows as FieldDef[];
}

export async function saveField(
  input: FieldInput & { id?: string },
  ctx: AuditContext,
): Promise<FieldDef> {
  if (!ctx.actorId) throw new FieldError('unauthenticated');
  // Registry object or the owner's own — one resolver, no second list (#186).
  const spec = await resolveEntity(input.entityType);
  if (!spec) throw new FieldError('unknown_entity');

  const choice = CHOICE_TYPES.includes(input.type);
  const opts = choice ? [...new Set(input.options.filter(Boolean))] : [];
  // A select with nothing to select from renders an empty dropdown that
  // silently refuses every save — catch it here, not in the browser.
  if (choice && opts.length === 0) throw new FieldError('options_required');

  const lookupEntity = input.type === 'lookup' ? input.lookupEntity : null;
  if (input.type === 'lookup' && !entitySpec(lookupEntity ?? '')?.lookup) {
    throw new FieldError('bad_lookup_entity');
  }
  if (input.rules.pattern) {
    try {
      new RegExp(input.rules.pattern);
    } catch {
      throw new FieldError('bad_pattern');
    }
  }

  if (input.id) {
    const before = await db.query.customFields.findFirst({ where: eq(customFields.id, input.id) });
    if (!before) throw new FieldError('not_found');
    // Changing the type would leave every stored answer in the wrong column.
    // Renaming, reordering and editing the choices stay allowed.
    if (before.type !== input.type) throw new FieldError('type_locked');
    if (before.entityType !== input.entityType) throw new FieldError('entity_locked');
  }

  await validateShowIf(input, input.id);

  const values = {
    entityType: input.entityType,
    label: input.label,
    type: input.type,
    options: opts,
    help: input.help || null,
    rules: input.rules,
    showIf: input.showIf,
    required: input.required,
    onList: input.onList,
    lookupEntity,
    sortOrder: input.sortOrder,
    active: input.active,
  };
  const [row] = input.id
    ? await db.update(customFields).set(values).where(eq(customFields.id, input.id)).returning()
    : await db.insert(customFields).values(values).returning();
  if (!row) throw new FieldError('not_found');

  await writeAudit(db, ctx, {
    entityType: 'custom_field',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row as FieldDef;
}

/**
 * A visibility rule must point at a real field, on the same object, that can
 * actually answer — and never at itself, which would make the field
 * permanently invisible with no way to reach it again.
 */
async function validateShowIf(input: FieldInput, selfId?: string): Promise<void> {
  const rule = input.showIf;
  if (!rule) return;
  if (rule.fieldId === selfId) throw new FieldError('show_if_self');
  const parent = await db.query.customFields.findFirst({
    where: eq(customFields.id, rule.fieldId),
  });
  if (!parent) throw new FieldError('show_if_missing');
  if (parent.entityType !== input.entityType) throw new FieldError('show_if_other_entity');
  if (!['select', 'multiselect', 'checkbox'].includes(parent.type)) {
    throw new FieldError('show_if_bad_parent');
  }
  // Nesting is refused rather than resolved: a chain of predicates is a
  // dependency graph, and the first cycle would hang the render.
  if (parent.showIf) throw new FieldError('show_if_nested');
}

/** Fields whose visibility depends on this one. */
export async function dependentFields(fieldId: string): Promise<FieldDef[]> {
  const rows = await db
    .select()
    .from(customFields)
    .where(sql`${customFields.showIf}->>'fieldId' = ${fieldId}`);
  return rows as FieldDef[];
}

export async function countFieldAnswers(id: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(customFieldValues)
    .where(eq(customFieldValues.fieldId, id));
  return Number(row?.n ?? 0);
}

/**
 * Delete a field AND its answers.
 *
 * Refused while another field's visibility depends on this one: the dependent
 * would be left with a predicate pointing at nothing, which evaluates to
 * "hidden" — so the owner deleting one dropdown would make a set of unrelated
 * fields quietly vanish from every card.
 *
 * Deactivating is the everyday move — it hides the field while keeping what
 * people already typed — so the screen shows the answer count before asking.
 */
export async function deleteField(id: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) throw new FieldError('unauthenticated');
  const field = await db.query.customFields.findFirst({ where: eq(customFields.id, id) });
  if (!field) throw new FieldError('not_found');
  const dependents = await dependentFields(id);
  if (dependents.length > 0) {
    throw new FieldError('has_dependents', dependents.map((row) => row.label).join(', '));
  }
  await db.delete(customFields).where(eq(customFields.id, id));
  await writeAudit(db, ctx, {
    entityType: 'custom_field',
    entityId: id,
    action: 'delete',
    before: { label: field.label, type: field.type, entityType: field.entityType },
  });
}

/** Stored answers for one record, keyed by field id. */
export async function fieldValues(
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(customFieldValues)
    .where(
      and(eq(customFieldValues.entityType, entityType), eq(customFieldValues.entityId, entityId)),
    );
  return Object.fromEntries(rows.map((row) => [row.fieldId, fromRow(row)]));
}

/** The same, for a list of records — one query instead of one per row. */
export async function fieldValuesFor(
  entityType: string,
  entityIds: string[],
): Promise<Record<string, Record<string, unknown>>> {
  if (entityIds.length === 0) return {};
  const rows = await db
    .select()
    .from(customFieldValues)
    .where(
      and(
        eq(customFieldValues.entityType, entityType),
        inArray(customFieldValues.entityId, entityIds),
      ),
    );
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    (out[row.entityId] ??= {})[row.fieldId] = fromRow(row);
  }
  return out;
}

/**
 * Coerce a whole payload WITHOUT writing anything.
 *
 * Called before the parent record is created, because the two writes are not
 * in one transaction: `createLead` commits and only then are the custom
 * answers stored, so a value the rules reject used to leave a saved record and
 * an error message that looked like nothing had happened. Validating first
 * turns that into a plain rejection with no record created.
 */
export async function validateValues(
  entityType: string,
  raw: Record<string, unknown>,
): Promise<void> {
  const fields = await listFields(entityType, true);
  for (const field of fields) {
    if (!(field.id in raw)) continue;
    const value = coerceValue(field, raw[field.id]);
    if (value === null && field.required && field.active && isVisible(field, raw)) {
      throw new FieldError('field_required', field.label);
    }
  }
}

/**
 * Write a record's custom answers.
 *
 * Only fields PRESENT in `raw` are touched, so a form that renders a subset —
 * the quick-add dialog, or a card where a conditional field is hidden —
 * cannot wipe what the full card collected.
 */
export async function setFieldValues(
  entityType: string,
  entityId: string,
  raw: Record<string, unknown>,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new FieldError('unauthenticated');
  const fields = await listFields(entityType, true);
  const touched: Record<string, unknown> = {};

  // One transaction for the whole record. Every field used to be its own
  // statement, so a rejection half-way down a card left the first fields
  // written and the rest not, with no sign that anything had gone wrong.
  await db.transaction(async (tx) => {
    for (const field of fields) {
      if (!(field.id in raw)) continue;
      const value = coerceValue(field, raw[field.id]);
      if (value === null) {
        if (field.required && field.active && isVisible(field, raw)) {
          throw new FieldError('field_required', field.label);
        }
        await tx
          .delete(customFieldValues)
          .where(
            and(
              eq(customFieldValues.fieldId, field.id),
              eq(customFieldValues.entityId, entityId),
            ),
          );
        touched[field.label] = null;
        continue;
      }
      const columns = toColumns(value);
      await tx
        .insert(customFieldValues)
        .values({ fieldId: field.id, entityType, entityId, ...columns })
        .onConflictDoUpdate({
          target: [customFieldValues.fieldId, customFieldValues.entityId],
          set: { ...columns, updatedAt: new Date() },
        });
      touched[field.label] = fromRow({ ...columns, valueList: columns.valueList ?? null });
    }
  });

  if (Object.keys(touched).length > 0) {
    await writeAudit(db, ctx, {
      entityType: `${entityType}_fields`,
      entityId,
      action: 'update',
      after: touched,
    });
  }
}

/** Delete every answer belonging to a record — for when the record goes. */
export async function dropFieldValues(
  dbOrTx: Db | Tx,
  entityType: string,
  entityId: string,
): Promise<void> {
  await dbOrTx
    .delete(customFieldValues)
    .where(
      and(eq(customFieldValues.entityType, entityType), eq(customFieldValues.entityId, entityId)),
    );
}

/**
 * Resolve lookup answers to something readable.
 *
 * Returns a label per referenced id. A target row that has been deleted is
 * absent from the map, and the caller shows a tombstone rather than a bare
 * uuid — the answer is still true, the thing it pointed at is simply gone.
 */
export async function lookupLabels(
  entityCode: string,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const spec = entitySpec(entityCode)?.lookup;
  if (!spec || ids.length === 0) return out;
  const rows = await db.execute<{ id: string; label: string | null; secondary: string | null }>(
    sql`SELECT id::text AS id,
               ${sql.identifier(spec.label)}::text AS label,
               ${spec.secondary ? sql.identifier(spec.secondary) : sql`NULL`}::text AS secondary
        FROM ${sql.identifier(spec.table)}
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`,
  );
  for (const row of rows) {
    out.set(row.id, [row.secondary, row.label].filter(Boolean).join(' · '));
  }
  return out;
}

/** The rows a lookup field offers to pick from. */
export async function lookupChoices(
  entityCode: string,
  limit = 500,
): Promise<{ id: string; label: string }[]> {
  const spec = entitySpec(entityCode)?.lookup;
  if (!spec) return [];
  const rows = await db.execute<{ id: string; label: string | null; secondary: string | null }>(
    sql`SELECT id::text AS id,
               ${sql.identifier(spec.label)}::text AS label,
               ${spec.secondary ? sql.identifier(spec.secondary) : sql`NULL`}::text AS secondary
        FROM ${sql.identifier(spec.table)}
        ${spec.active ? sql`WHERE ${sql.identifier(spec.active)}` : sql``}
        ORDER BY ${sql.identifier(spec.secondary ?? spec.label)}
        LIMIT ${limit}`,
  );
  return rows.map((row) => ({
    id: row.id,
    label: [row.secondary, row.label].filter(Boolean).join(' · '),
  }));
}

/**
 * Bring `custom_entities` in line with the registry (called by the seed).
 *
 * Insert-and-reactivate only. A code that disappears from the registry is
 * DEACTIVATED rather than deleted: its fields and every answer to them hang
 * off it by foreign key, and removing the row would take a company's data with
 * it because someone tidied a TypeScript array.
 */
export async function syncEntityRegistry(): Promise<void> {
  for (const spec of ENTITY_SPECS) {
    await db
      .insert(customEntities)
      .values({ code: spec.code, sortOrder: spec.sortOrder })
      .onConflictDoUpdate({
        target: customEntities.code,
        set: { sortOrder: spec.sortOrder, active: true },
      });
  }
  await db
    .update(customEntities)
    .set({ active: false })
    .where(
      and(
        notInArray(customEntities.code, ENTITY_SPECS.map((spec) => spec.code)),
        // The owner's own objects (phase 8) were never in the registry —
        // deactivating them on every deploy would kill his lists nightly.
        eq(customEntities.isCustom, false),
      ),
    );
}
