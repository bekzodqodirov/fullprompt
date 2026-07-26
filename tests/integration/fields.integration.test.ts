import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  customFields,
  customFieldValues,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import {
  countFieldAnswers,
  deleteField,
  dependentFields,
  fieldValues,
  fieldValuesFor,
  listFields,
  lookupChoices,
  lookupLabels,
  saveField,
  setFieldValues,
  syncEntityRegistry,
  validateValues,
} from '@/modules/platform/fields/service';
import { FieldError, coerceValue, isVisible } from '@/modules/platform/fields/types';
import { decorateRows, fieldFilterSql, readFilters } from '@/modules/platform/fields/filter';
import { ENTITY_SPECS } from '@/modules/platform/fields/registry';

/**
 * Custom fields on every object.
 *
 * The engine used to serve two objects and store every answer in one jsonb
 * column. What matters now is that it reaches the rest of the app without
 * losing the guarantees it had, and that the three new things — typed
 * storage, rules and conditional visibility — cannot destroy data.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId: string;
const ctx = () => ({ actorId });

/** A field definition with the boring parts filled in. */
function def(over: Record<string, unknown>) {
  return {
    entityType: 'client',
    label: `F ${SUFFIX}`,
    type: 'text',
    options: [] as string[],
    help: '',
    rules: {},
    showIf: null,
    required: false,
    onList: false,
    lookupEntity: null,
    sortOrder: 100,
    active: true,
    ...over,
  } as Parameters<typeof saveField>[0];
}

async function field(over: Record<string, unknown>) {
  return saveField(def(over), ctx());
}

let clientA: string;
let clientB: string;

beforeAll(async () => {
  await syncEntityRegistry();
  const [actor] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = actor!.id;

  clientA = (
    await createClient({ clientCode: `CF${SUFFIX}A`, name: `A ${SUFFIX}`, phones: [] }, ctx())
  ).id;
  clientB = (
    await createClient({ clientCode: `CF${SUFFIX}B`, name: `B ${SUFFIX}`, phones: [] }, ctx())
  ).id;
});

afterAll(async () => {
  // The DEFINITIONS have to go, not just the answers. CI runs vitest and
  // Playwright against ONE database, so a field left behind here appears on
  // every client card in the e2e run — a leaked required field makes every
  // save fail, and a leaked lookup renders a list of every client, which is
  // enough to break an unrelated spec. Deleted straight from the table rather
  // than through deleteField, which refuses while a dependent exists; answers
  // follow by cascade.
  await db.delete(customFields).where(sql`${customFields.label} LIKE ${`% ${SUFFIX}`}`);
  await pgClient.end();
});

describe('the engine reaches every object, not two', () => {
  it('accepts a field on an object that is not a lead or a client', async () => {
    const row = await field({ entityType: 'receipt', label: `Shartnoma ${SUFFIX}` });
    expect(row.entityType).toBe('receipt');
    expect((await listFields('receipt')).some((f) => f.id === row.id)).toBe(true);
  });

  it('refuses an object that is not in the registry', async () => {
    await expect(field({ entityType: 'unicorn', label: `X ${SUFFIX}` })).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('the database enforces the registry rather than a hand-edited CHECK', async () => {
    // The point of the entity TABLE: an unknown code is refused by a foreign
    // key, not by a constraint that has to be edited in four files at once.
    await expect(
      db.insert(customFieldValues).values({
        fieldId: uuidv4(),
        entityType: 'nonsense',
        entityId: clientA,
        valueText: 'x',
      }),
    ).rejects.toBeTruthy();
  });

  it('every registry entry has a translation key and a write permission', () => {
    for (const spec of ENTITY_SPECS) {
      expect(spec.labelKey).toBeTruthy();
      expect(spec.writePermissions.length).toBeGreaterThan(0);
    }
  });
});

describe('answers are stored in a column of the right type', () => {
  it('a number sorts as a number, not as text', async () => {
    const volume = await field({ label: `Kub ${SUFFIX}`, type: 'number' });
    await setFieldValues('client', clientA, { [volume.id]: '5' }, ctx());
    await setFieldValues('client', clientB, { [volume.id]: '40' }, ctx());

    const rows = await db
      .select({ id: customFieldValues.entityId, num: customFieldValues.valueNum })
      .from(customFieldValues)
      .where(eq(customFieldValues.fieldId, volume.id))
      .orderBy(customFieldValues.valueNum);
    // As text "40" sorts before "5"; the whole reason for the typed column.
    expect(rows.map((row) => row.id)).toEqual([clientA, clientB]);
  });

  it('money keeps its currency, and refuses an amount without one', async () => {
    const price = await field({ label: `Narx ${SUFFIX}`, type: 'money' });
    await setFieldValues('client', clientA, { [price.id]: ['1500,50', 'USD'] }, ctx());
    expect((await fieldValues('client', clientA))[price.id]).toEqual({
      amount: 1500.5,
      currency: 'USD',
    });
    await expect(
      setFieldValues('client', clientA, { [price.id]: ['20', ''] }, ctx()),
    ).rejects.toThrow('bad_currency');
  });

  it('a comma decimal is what an Uzbek keyboard produces', async () => {
    const n = await field({ label: `Vergul ${SUFFIX}`, type: 'number' });
    await setFieldValues('client', clientA, { [n.id]: '12,5' }, ctx());
    expect((await fieldValues('client', clientA))[n.id]).toBe(12.5);
  });

  it('a checkbox left unticked is a real "no", not a missing answer', async () => {
    const flag = await field({ label: `VIP ${SUFFIX}`, type: 'checkbox' });
    await setFieldValues('client', clientA, { [flag.id]: undefined }, ctx());
    expect((await fieldValues('client', clientA))[flag.id]).toBe(false);
    await setFieldValues('client', clientA, { [flag.id]: 'on' }, ctx());
    expect((await fieldValues('client', clientA))[flag.id]).toBe(true);
  });

  it('clearing an answer removes the row rather than storing an empty string', async () => {
    const note = await field({ label: `Izoh ${SUFFIX}` });
    await setFieldValues('client', clientA, { [note.id]: 'bor' }, ctx());
    await setFieldValues('client', clientA, { [note.id]: '' }, ctx());
    expect(note.id in (await fieldValues('client', clientA))).toBe(false);
  });

  it('a partial form cannot wipe the answers it does not render', async () => {
    const a = await field({ label: `A ${SUFFIX}` });
    const b = await field({ label: `B ${SUFFIX}` });
    await setFieldValues('client', clientA, { [a.id]: 'bir', [b.id]: 'ikki' }, ctx());
    await setFieldValues('client', clientA, { [a.id]: 'yangi' }, ctx());
    const stored = await fieldValues('client', clientA);
    expect(stored[a.id]).toBe('yangi');
    expect(stored[b.id]).toBe('ikki');
  });
});

describe('the rules the owner types are enforced on the server', () => {
  it('a number outside its range is refused', async () => {
    const n = await field({ label: `Chegara ${SUFFIX}`, type: 'number', rules: { min: 1, max: 10 } });
    await expect(setFieldValues('client', clientA, { [n.id]: '0' }, ctx())).rejects.toThrow(
      'too_small',
    );
    await expect(setFieldValues('client', clientA, { [n.id]: '11' }, ctx())).rejects.toThrow(
      'too_big',
    );
    await setFieldValues('client', clientA, { [n.id]: '10' }, ctx());
    expect((await fieldValues('client', clientA))[n.id]).toBe(10);
  });

  it('a pattern is applied, and a broken pattern never blocks a save', async () => {
    const code = await field({
      label: `Kod ${SUFFIX}`,
      rules: { pattern: '^[A-Z]{2}-\\d{3}$' },
    });
    await expect(setFieldValues('client', clientA, { [code.id]: 'xx' }, ctx())).rejects.toThrow(
      'pattern',
    );
    await setFieldValues('client', clientA, { [code.id]: 'AB-123' }, ctx());
    expect((await fieldValues('client', clientA))[code.id]).toBe('AB-123');

    // A pattern that cannot compile is a broken DEFINITION; refusing every
    // save would make the card unusable until an admin noticed.
    expect(coerceValue({ ...code, rules: { pattern: '([' } }, 'anything')).toEqual({
      kind: 'text',
      text: 'anything',
    });
  });

  it('refuses a regex that does not compile when the field is defined', async () => {
    await expect(field({ label: `Yomon ${SUFFIX}`, rules: { pattern: '([' } })).rejects.toThrow(
      'bad_pattern',
    );
  });

  it('a required field must be answered', async () => {
    const req = await field({ label: `Majburiy ${SUFFIX}`, required: true });
    await expect(setFieldValues('client', clientA, { [req.id]: '' }, ctx())).rejects.toThrow(
      'field_required',
    );
  });

  it('validates a whole payload before the record it belongs to is created', async () => {
    const req = await field({ label: `Oldin ${SUFFIX}`, type: 'number', rules: { max: 5 } });
    // The parent write and the answers are not one transaction, so the check
    // has to be able to run on its own, before anything exists.
    await expect(validateValues('client', { [req.id]: '9' })).rejects.toBeInstanceOf(FieldError);
    await expect(validateValues('client', { [req.id]: '4' })).resolves.toBeUndefined();
  });
});

describe('conditional visibility cannot destroy an answer', () => {
  it('a hidden field keeps what it already holds', async () => {
    const parent = await field({
      label: `Tur ${SUFFIX}`,
      type: 'select',
      options: ['Yuk', 'Xizmat'],
    });
    const child = await field({
      label: `Yuk izohi ${SUFFIX}`,
      showIf: { fieldId: parent.id, values: ['Yuk'] },
    });

    await setFieldValues(
      'client',
      clientA,
      { [parent.id]: 'Yuk', [child.id]: 'katta quti' },
      ctx(),
    );
    // The parent flips, so the browser stops rendering the child — which
    // means the child is absent from the next payload, NOT emptied.
    await setFieldValues('client', clientA, { [parent.id]: 'Xizmat' }, ctx());
    const stored = await fieldValues('client', clientA);
    expect(stored[child.id]).toBe('katta quti');
    // …and it is correctly reported as hidden while the parent says so.
    const defs = await listFields('client');
    const childDef = defs.find((f) => f.id === child.id)!;
    expect(isVisible(childDef, stored)).toBe(false);
    expect(isVisible(childDef, { ...stored, [parent.id]: 'Yuk' })).toBe(true);
  });

  it('a hidden required field does not block the rest of the card', async () => {
    const parent = await field({ label: `Bor ${SUFFIX}`, type: 'checkbox' });
    const child = await field({
      label: `Shart ${SUFFIX}`,
      required: true,
      showIf: { fieldId: parent.id, values: ['true'] },
    });
    // Nobody can answer a field they cannot see.
    await expect(
      setFieldValues('client', clientB, { [parent.id]: 'off', [child.id]: '' }, ctx()),
    ).resolves.toBeUndefined();
    expect(child.id in (await fieldValues('client', clientB))).toBe(false);
  });

  it('refuses a rule that would make a field unreachable', async () => {
    const text = await field({ label: `Matn ${SUFFIX}` });
    const parent = await field({ label: `Ota ${SUFFIX}`, type: 'select', options: ['a', 'b'] });
    const child = await field({
      label: `Bola ${SUFFIX}`,
      showIf: { fieldId: parent.id, values: ['a'] },
    });

    // A free-text parent has no finite answers to compare against.
    await expect(
      field({ label: `X1 ${SUFFIX}`, showIf: { fieldId: text.id, values: ['x'] } }),
    ).rejects.toThrow('show_if_bad_parent');
    // A parent on another object is never on the same card.
    const other = await field({ entityType: 'lead', label: `Boshqa ${SUFFIX}`, type: 'checkbox' });
    await expect(
      field({ label: `X2 ${SUFFIX}`, showIf: { fieldId: other.id, values: ['true'] } }),
    ).rejects.toThrow('show_if_other_entity');
    // A chain is a dependency graph, and the first cycle would hang a render.
    await expect(
      field({ label: `X3 ${SUFFIX}`, showIf: { fieldId: child.id, values: ['a'] } }),
    ).rejects.toThrow('show_if_bad_parent');
    await expect(
      saveField(
        def({ id: parent.id, label: `Ota ${SUFFIX}`, type: 'select', options: ['a', 'b'], showIf: { fieldId: parent.id, values: ['a'] } }),
        ctx(),
      ),
    ).rejects.toThrow('show_if_self');
  });

  it('refuses to delete a field another field depends on', async () => {
    const parent = await field({ label: `Asos ${SUFFIX}`, type: 'checkbox' });
    const child = await field({
      label: `Bog‘liq ${SUFFIX}`,
      showIf: { fieldId: parent.id, values: ['true'] },
    });
    expect((await dependentFields(parent.id)).map((f) => f.id)).toEqual([child.id]);
    // Without this guard the child's predicate would point at nothing, which
    // evaluates to "hidden" — the field vanishes from every card in silence.
    await expect(deleteField(parent.id, ctx())).rejects.toThrow('has_dependents');
    await deleteField(child.id, ctx());
    await expect(deleteField(parent.id, ctx())).resolves.toBeUndefined();
  });
});

describe('lookups point at real rows and survive their loss', () => {
  it('resolves a target to a label, and tombstones one that is gone', async () => {
    const who = await field({
      label: `Sotuvchi ${SUFFIX}`,
      type: 'lookup',
      lookupEntity: 'user',
    });
    await setFieldValues('client', clientA, { [who.id]: actorId }, ctx());
    const labels = await lookupLabels('user', [actorId]);
    expect(labels.get(actorId)).toBeTruthy();
    // A uuid that is not there resolves to nothing; the answer still stands.
    expect((await lookupLabels('user', [uuidv4()])).size).toBe(0);
    expect((await fieldValues('client', clientA))[who.id]).toBe(actorId);
  });

  it('offers only entities the registry says can be pointed at', async () => {
    expect((await lookupChoices('user')).length).toBeGreaterThan(0);
    // A box has no name a human could pick out of a list.
    expect(await lookupChoices('box')).toEqual([]);
    await expect(
      field({ label: `Yomon ${SUFFIX}`, type: 'lookup', lookupEntity: 'box' }),
    ).rejects.toThrow('bad_lookup_entity');
  });

  it('refuses a value that is not a reference at all', async () => {
    const who = await field({ label: `Kim ${SUFFIX}`, type: 'lookup', lookupEntity: 'client' });
    await expect(setFieldValues('client', clientA, { [who.id]: 'Ali' }, ctx())).rejects.toThrow(
      'bad_reference',
    );
  });
});

describe('filtering and sorting by a custom field', () => {
  it('filters in SQL so the cap does not hide matches', async () => {
    const city = await field({
      label: `Shahar ${SUFFIX}`,
      type: 'select',
      options: ['Toshkent', 'Andijon'],
      onList: true,
    });
    await setFieldValues('client', clientA, { [city.id]: 'Toshkent' }, ctx());
    await setFieldValues('client', clientB, { [city.id]: 'Andijon' }, ctx());

    const defs = await listFields('client');
    const filters = readFilters({ [`cf_${city.id}`]: 'Toshkent' }, defs);
    expect(filters).toHaveLength(1);

    const where = fieldFilterSql('client', clients.id, defs, filters)!;
    const found = await db.select({ id: clients.id }).from(clients).where(where);
    const ids = found.map((row) => row.id);
    expect(ids).toContain(clientA);
    expect(ids).not.toContain(clientB);
  });

  it('understands a range and a comparison on a number', async () => {
    const kub = await field({ label: `Hajm ${SUFFIX}`, type: 'number', onList: true });
    await setFieldValues('client', clientA, { [kub.id]: '3' }, ctx());
    await setFieldValues('client', clientB, { [kub.id]: '30' }, ctx());
    const defs = await listFields('client');

    const matches = async (expr: string) => {
      const where = fieldFilterSql('client', clients.id, defs, [
        { fieldId: kub.id, value: expr },
      ])!;
      const rows = await db.select({ id: clients.id }).from(clients).where(where);
      return rows.map((row) => row.id);
    };
    expect(await matches('>10')).toEqual([clientB]);
    expect(await matches('<10')).toEqual([clientA]);
    expect(await matches('1..5')).toEqual([clientA]);
    expect(await matches('30')).toEqual([clientB]);
  });

  it('ignores a filter naming a field that does not exist', async () => {
    const defs = await listFields('client');
    expect(readFilters({ [`cf_${uuidv4()}`]: 'x', q: 'y' }, defs)).toEqual([]);
  });

  it('hangs answers onto rows as cf_<id>, resolving lookups once', async () => {
    const city = (await listFields('client')).find((f) => f.label === `Shahar ${SUFFIX}`)!;
    const rows = await decorateRows(
      'client',
      [
        { id: clientA, code: 'A' },
        { id: clientB, code: 'B' },
      ],
      [city],
    );
    expect(rows[0]![`cf_${city.id}`]).toBe('Toshkent');
    expect(rows[1]![`cf_${city.id}`]).toBe('Andijon');
  });

  it('reads a page of answers in one query', async () => {
    const values = await fieldValuesFor('client', [clientA, clientB]);
    expect(Object.keys(values).sort()).toEqual([clientA, clientB].sort());
  });
});

describe('a definition change never silently rewrites answers', () => {
  it('refuses a type change after the fact', async () => {
    const row = await field({ label: `Qulf ${SUFFIX}` });
    await expect(
      saveField(def({ id: row.id, label: `Qulf ${SUFFIX}`, type: 'number' }), ctx()),
    ).rejects.toThrow('type_locked');
  });

  it('refuses a select with nothing to select', async () => {
    await expect(field({ label: `Bo‘sh ${SUFFIX}`, type: 'select' })).rejects.toThrow(
      'options_required',
    );
  });

  it('deleting a field takes its answers with it, and says how many first', async () => {
    const row = await field({ label: `O‘chadi ${SUFFIX}` });
    await setFieldValues('client', clientA, { [row.id]: 'javob' }, ctx());
    expect(await countFieldAnswers(row.id)).toBe(1);
    await deleteField(row.id, ctx());
    expect(await countFieldAnswers(row.id)).toBe(0);
    expect(
      (
        await db
          .select()
          .from(customFieldValues)
          .where(
            and(
              eq(customFieldValues.entityType, 'client'),
              eq(customFieldValues.entityId, clientA),
            ),
          )
      ).some((v) => v.fieldId === row.id),
    ).toBe(false);
  });
});
