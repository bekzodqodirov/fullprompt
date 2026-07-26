import { and, asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client';
import { attachments, currencies } from '../db/schema';
import type { AttachmentItem } from '@/components/attachments-panel';
import type { FieldView } from '@/components/custom-fields';
import { fieldValues, listFields, lookupChoices } from './service';
import { options, rulesOf, showIfOf, type FieldDef } from './types';

/**
 * Everything one card needs to render its custom fields, in one place.
 *
 * The definitions, the answers, the rows a lookup may point at, the currency
 * list and the attachment group behind each file field — assembled on the
 * server so the browser receives data rather than a licence to query.
 */
export interface CustomFieldsData {
  fields: FieldView[];
  values: Record<string, unknown>;
  choices: Record<string, { id: string; label: string }[]>;
  currencies: string[];
  files: Record<string, { groupId: string; items: AttachmentItem[] }>;
}

export function toFieldView(field: FieldDef): FieldView {
  return {
    id: field.id,
    label: field.label,
    type: field.type,
    options: options(field),
    help: field.help,
    required: field.required,
    rules: rulesOf(field),
    showIf: showIfOf(field),
  };
}

export async function customFieldsData(
  entityType: string,
  entityId: string,
): Promise<CustomFieldsData> {
  const [defs, values] = await Promise.all([
    listFields(entityType),
    fieldValues(entityType, entityId),
  ]);

  const choices: Record<string, { id: string; label: string }[]> = {};
  for (const field of defs) {
    if (field.type === 'lookup' && field.lookupEntity) {
      choices[field.id] = await lookupChoices(field.lookupEntity);
    }
  }

  const files: Record<string, { groupId: string; items: AttachmentItem[] }> = {};
  for (const field of defs) {
    if (field.type !== 'file') continue;
    const stored = values[field.id];
    // No answer yet: mint the group now so files can be attached before the
    // first save. An abandoned form leaves an orphan group and nothing else.
    const groupId = typeof stored === 'string' ? stored : uuidv7();
    const rows = await db
      .select({
        id: attachments.id,
        fileName: attachments.fileName,
        contentType: attachments.contentType,
        kind: attachments.kind,
      })
      .from(attachments)
      .where(and(eq(attachments.entityType, 'custom_field'), eq(attachments.entityId, groupId)))
      .orderBy(asc(attachments.createdAt));
    files[field.id] = { groupId, items: rows };
  }

  const ccy = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.active, true))
    .orderBy(asc(currencies.code));

  return {
    // A field hidden by its own rule is still SENT to the browser, which
    // decides live as the parent changes; only fields whose parent has no
    // answer at all start out hidden, and that is the browser's job too.
    fields: defs.map(toFieldView),
    values,
    choices,
    currencies: ccy.length ? ccy.map((row) => row.code) : ['USD'],
    files,
  };
}

/**
 * The same, for a CREATE form — where the record does not exist yet.
 *
 * A lookup still needs its choices and a file field still needs a group id to
 * upload into, so a create form that skipped this would render an empty
 * dropdown and a dead attach button.
 */
export async function blankFieldsData(entityType: string): Promise<CustomFieldsData> {
  const defs = await listFields(entityType);

  const choices: Record<string, { id: string; label: string }[]> = {};
  const files: Record<string, { groupId: string; items: AttachmentItem[] }> = {};
  for (const field of defs) {
    if (field.type === 'lookup' && field.lookupEntity) {
      choices[field.id] = await lookupChoices(field.lookupEntity);
    }
    if (field.type === 'file') files[field.id] = { groupId: uuidv7(), items: [] };
  }

  const ccy = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.active, true))
    .orderBy(asc(currencies.code));

  return {
    fields: defs.map(toFieldView),
    values: {},
    choices,
    currencies: ccy.length ? ccy.map((row) => row.code) : ['USD'],
    files,
  };
}
