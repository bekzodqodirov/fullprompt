import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  customEntities,
  customFieldValues,
  customFields,
  customRecords,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import {
  canWriteEntity,
  createCustomEntity,
  createRecord,
  recordNames,
  resolveEntity,
  updateCustomEntity,
  updateRecord,
} from '@/modules/platform/entities/service';
import { fieldValues, saveField, setFieldValues, syncEntityRegistry } from '@/modules/platform/fields/service';
import { fieldSchema } from '@/modules/platform/fields/types';
import { aboutLabels, createTask } from '@/modules/platform/tasks/service';

/**
 * Phase 8 against a real database: an object the OWNER invents behaves like
 * a shipped one everywhere the code used to consult the compiled registry —
 * fields, tasks, labels — and the seed can no longer kill it.
 */

const STAMP = Date.now();
let actorId: string;
let entityCode: string;
const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const [staff] = await db.select().from(users).where(eq(users.active, true)).limit(1);
  actorId = staff!.id;
  entityCode = await createCustomEntity(
    { label: `Yetkazuvchilar ${STAMP}`, writeChoice: 'everyone' },
    ctx(),
  );
});

afterAll(async () => {
  // Field DEFINITIONS are configuration (#183): delete them and their
  // answers; the entity itself is deactivated (records hang off it by FK).
  const defs = await db.select().from(customFields).where(eq(customFields.entityType, entityCode));
  if (defs.length > 0) {
    await db.delete(customFieldValues).where(
      inArray(customFieldValues.fieldId, defs.map((d) => d.id)),
    );
    await db.delete(customFields).where(eq(customFields.entityType, entityCode));
  }
  await db.delete(tasks).where(eq(tasks.entityType, entityCode));
  await db.update(customEntities).set({ active: false }).where(eq(customEntities.code, entityCode));
  await pgClient.end();
});

describe('an owner-invented object', () => {
  it('resolves like a shipped one, with its own label and write list', async () => {
    expect(entityCode.startsWith('x_')).toBe(true);
    const resolved = (await resolveEntity(entityCode))!;
    expect(resolved.custom).toBe(true);
    expect(resolved.label).toBe(`Yetkazuvchilar ${STAMP}`);
    // 'everyone' = empty list = any signed-in member of staff.
    expect(canWriteEntity(resolved, { has: () => false })).toBe(true);

    await updateCustomEntity(entityCode, { writeChoice: 'admins' }, ctx());
    const gated = (await resolveEntity(entityCode))!;
    expect(canWriteEntity(gated, { has: () => false })).toBe(false);
    expect(canWriteEntity(gated, { has: (c) => c === 'admin.dictionaries.manage' })).toBe(true);
    await updateCustomEntity(entityCode, { writeChoice: 'everyone' }, ctx());

    // A code nobody invented resolves to nothing.
    expect(await resolveEntity('x_never_was')).toBeUndefined();
  });

  it('carries custom fields end to end — definition, answer, read-back', async () => {
    const parsed = fieldSchema.parse({
      entityType: entityCode,
      label: 'Telefon',
      type: 'text',
      onList: true,
    });
    const field = await saveField(parsed, ctx());
    const record = await createRecord(entityCode, { name: `Guangzhou ${STAMP}` }, ctx());
    await setFieldValues(entityCode, record, { [field.id]: '+8613800000000' }, ctx());
    const values = await fieldValues(entityCode, record);
    expect(values[field.id]).toBe('+8613800000000');
  });

  it('takes tasks like any shipped object, and the task list can NAME the record', async () => {
    const record = await createRecord(entityCode, { name: `Yiwu Metal ${STAMP}` }, ctx());
    const task = await createTask(
      {
        title: `Shartnoma ${STAMP}`,
        note: '',
        typeId: null,
        assigneeId: actorId,
        dueAt: '',
        priority: 2,
        entityType: entityCode,
        entityId: record,
        repeatUnit: null,
        repeatEvery: 1,
      },
      ctx(),
    );
    expect(task.entityType).toBe(entityCode);
    const labels = await aboutLabels([task]);
    expect(labels.get(`${entityCode}:${record}`)).toBe(`Yiwu Metal ${STAMP}`);
    expect((await recordNames([record])).get(record)).toBe(`Yiwu Metal ${STAMP}`);
  });

  it('SURVIVES the seed: syncEntityRegistry must not deactivate the owner’s rows', async () => {
    await syncEntityRegistry();
    const [row] = await db
      .select()
      .from(customEntities)
      .where(eq(customEntities.code, entityCode));
    expect(row!.active).toBe(true);
  });

  it('record edits are audited, and deactivation hides rather than deletes', async () => {
    const record = await createRecord(entityCode, { name: `Old name ${STAMP}` }, ctx());
    await updateRecord(record, { name: `New name ${STAMP}`, active: false }, ctx());
    const [row] = await db.select().from(customRecords).where(eq(customRecords.id, record));
    expect(row!.name).toBe(`New name ${STAMP}`);
    expect(row!.active).toBe(false);

    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, record));
    expect(trail.some((r) => r.action === 'create')).toBe(true);
    expect(
      trail.some(
        (r) => r.action === 'update' && (r.after as { name?: string })?.name === `New name ${STAMP}`,
      ),
    ).toBe(true);
  });
});
