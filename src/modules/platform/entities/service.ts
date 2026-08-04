import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db } from '../db/client';
import { customEntities, customRecords } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { ENTITY_SPECS, entitySpec } from '../fields/registry';

/**
 * Phase 8: the owner's own objects (#174's promised «later phase»).
 *
 * A SHIPPED object lives in the registry — its label is an i18n key, its
 * write list ships with the release, its card is a real page. An OWNER-BORN
 * object is a `custom_entities` row carrying its own label and write list,
 * and its card is the generic one at /o. `resolveEntity` is the single door
 * both kinds pass through, so nothing downstream grows a second registry
 * (#186's rule, extended to rows).
 */

export class EntityError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * The audit log keys rows by uuid; an entity's primary key is its text
 * code. One deterministic uuid per code keeps every create/rename/hide of
 * the same object on one audit thread.
 */
const AUDIT_NS = '3f3a48f2-9c1e-4b6a-9a44-7c2c6f0a8e21';
const auditIdFor = (code: string) => uuidv5(code, AUDIT_NS);

export interface ResolvedEntity {
  code: string;
  /** i18n key for registry objects, null for owner-born ones. */
  labelKey: string | null;
  /** The owner's own label, null for registry objects. */
  label: string | null;
  /** ANY-of; empty = any signed-in member of staff. */
  writePermissions: string[];
  custom: boolean;
}

/** Registry first — it is code and costs nothing — then the owner's rows. */
export async function resolveEntity(code: string): Promise<ResolvedEntity | undefined> {
  const spec = entitySpec(code);
  if (spec) {
    return {
      code: spec.code,
      labelKey: spec.labelKey,
      label: null,
      writePermissions: spec.writePermissions,
      custom: false,
    };
  }
  const row = await db.query.customEntities.findFirst({
    where: and(eq(customEntities.code, code), eq(customEntities.active, true)),
  });
  if (!row || !row.isCustom) return undefined;
  return {
    code: row.code,
    labelKey: null,
    label: row.label ?? row.code,
    writePermissions: Array.isArray(row.writePermissions)
      ? (row.writePermissions as string[])
      : [],
    custom: true,
  };
}

/** ANY-of, and an empty list deliberately means everyone who can sign in. */
export function canWriteEntity(
  entity: Pick<ResolvedEntity, 'writePermissions'>,
  permissions: { has(code: string): boolean },
): boolean {
  if (entity.writePermissions.length === 0) return true;
  return entity.writePermissions.some((code) => permissions.has(code));
}

/**
 * Who may edit, offered as four understandable choices rather than a raw
 * permission-code picker — the mute-groups lesson applied to authorization.
 */
export const WRITE_CHOICES = {
  everyone: [] as string[],
  sales: ['crm.leads'],
  finance: ['finance.view'],
  admins: ['admin.dictionaries.manage'],
} as const;
export type WriteChoice = keyof typeof WRITE_CHOICES;

export function writeChoiceOf(permissionsList: string[]): WriteChoice {
  const entries = Object.entries(WRITE_CHOICES) as [WriteChoice, readonly string[]][];
  const match = entries.find(
    ([, codes]) =>
      codes.length === permissionsList.length && codes.every((c) => permissionsList.includes(c)),
  );
  return match?.[0] ?? 'admins';
}

export const customEntitySchema = z.object({
  label: z.string().trim().min(1).max(120),
  writeChoice: z.enum(Object.keys(WRITE_CHOICES) as [WriteChoice, ...WriteChoice[]]),
});

export async function listCustomEntities(includeInactive = false) {
  return db
    .select()
    .from(customEntities)
    .where(
      includeInactive
        ? eq(customEntities.isCustom, true)
        : and(eq(customEntities.isCustom, true), eq(customEntities.active, true)),
    )
    .orderBy(asc(customEntities.sortOrder), asc(customEntities.label));
}

export async function createCustomEntity(
  input: z.infer<typeof customEntitySchema>,
  ctx: AuditContext,
): Promise<string> {
  if (!ctx.actorId) throw new EntityError('unauthenticated');
  // Minted, never typed: the code is an FK target and a URL segment for the
  // life of the database, and the x_ prefix keeps it out of the namespace a
  // future release's shipped codes could want.
  const code = `x_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(customEntities).values({
    code,
    label: input.label,
    isCustom: true,
    writePermissions: WRITE_CHOICES[input.writeChoice],
    sortOrder: 500,
  });
  await writeAudit(db, ctx, {
    entityType: 'custom_entity',
    entityId: auditIdFor(code),
    action: 'create',
    after: { label: input.label, writeChoice: input.writeChoice },
  });
  return code;
}

export async function updateCustomEntity(
  code: string,
  input: { label?: string; writeChoice?: WriteChoice; active?: boolean },
  ctx: AuditContext,
): Promise<void> {
  const before = await db.query.customEntities.findFirst({
    where: and(eq(customEntities.code, code), eq(customEntities.isCustom, true)),
  });
  if (!before) throw new EntityError('not_found');
  await db
    .update(customEntities)
    .set({
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.writeChoice !== undefined
        ? { writePermissions: WRITE_CHOICES[input.writeChoice] }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    })
    .where(eq(customEntities.code, code));
  await writeAudit(db, ctx, {
    entityType: 'custom_entity',
    entityId: auditIdFor(code),
    action: 'update',
    before: { label: before.label, active: before.active },
    after: {
      label: input.label ?? before.label,
      active: input.active ?? before.active,
      ...(input.writeChoice ? { writeChoice: input.writeChoice } : {}),
    },
  });
}

/** Everything the pickers need: shipped objects by key, owner's by label. */
export async function entityChoices(): Promise<
  { code: string; labelKey: string | null; label: string | null }[]
> {
  const custom = await listCustomEntities();
  return [
    ...ENTITY_SPECS.map((spec) => ({ code: spec.code, labelKey: spec.labelKey, label: null })),
    ...custom.map((row) => ({ code: row.code, labelKey: null, label: row.label ?? row.code })),
  ];
}

// ---------------------------------------------------------------------------
// Records

export const recordSchema = z.object({
  name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

export async function createRecord(
  entityCode: string,
  input: z.infer<typeof recordSchema>,
  ctx: AuditContext,
): Promise<string> {
  if (!ctx.actorId) throw new EntityError('unauthenticated');
  const entity = await resolveEntity(entityCode);
  if (!entity?.custom) throw new EntityError('not_found');
  const [row] = await db
    .insert(customRecords)
    .values({
      entityCode,
      name: input.name,
      note: input.note || null,
      createdBy: ctx.actorId,
    })
    .returning({ id: customRecords.id });
  await writeAudit(db, ctx, {
    entityType: entityCode,
    entityId: row!.id,
    action: 'create',
    after: { name: input.name },
  });
  return row!.id;
}

export async function updateRecord(
  id: string,
  input: { name?: string; note?: string; active?: boolean },
  ctx: AuditContext,
): Promise<void> {
  const before = await db.query.customRecords.findFirst({ where: eq(customRecords.id, id) });
  if (!before) throw new EntityError('not_found');
  await db
    .update(customRecords)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.note !== undefined ? { note: input.note || null } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customRecords.id, id));
  await writeAudit(db, ctx, {
    entityType: before.entityCode,
    entityId: id,
    action: 'update',
    before: { name: before.name, active: before.active },
    after: { name: input.name ?? before.name, active: input.active ?? before.active },
  });
}

export async function recordById(id: string) {
  return db.query.customRecords.findFirst({ where: eq(customRecords.id, id) });
}

/** Names for task rows and list decoration, one query for many ids. */
export async function recordNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: customRecords.id, name: customRecords.name })
    .from(customRecords)
    .where(inArray(customRecords.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Live record count per custom entity, for the /o index tiles. */
export async function recordCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ code: customRecords.entityCode, n: sql<number>`count(*)` })
    .from(customRecords)
    .where(eq(customRecords.active, true))
    .groupBy(customRecords.entityCode);
  return new Map(rows.map((row) => [row.code, Number(row.n)]));
}
