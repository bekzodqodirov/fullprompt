import { describe, expect, it } from 'vitest';
import { INTAKE_CONTRACTS } from '@/modules/wms/calc/intake-ai';

/**
 * docs/AI-SORAYDI.md §2.1 — the structured-output BUDGET.
 *
 * The API compiles the answer's schema into a grammar and refuses one past
 * its limits with a 400 «Schema is too complex for compilation» — for every
 * request that carries it. Two of the limits are countable: at most 16
 * parameters with a union type (`anyOf`, or a type array such as
 * `["number","null"]`) and at most 24 optional parameters (a property not
 * listed in `required`). The numbers are the platform's own
 * (build-with-claude/structured-outputs, read 2026-11-12) and are restated
 * HERE on purpose: a test that read them out of the module would bless
 * whatever the module said.
 *
 * There is no API key where this code is written, so the first real request
 * is made in production. This walk is what stands between «one more nullable
 * field» and every reading failing on deploy morning.
 */
const UNION_TYPED_MAX = 16;
const OPTIONAL_MAX = 24;

interface Node {
  type?: unknown;
  anyOf?: unknown;
  properties?: Record<string, Node>;
  required?: readonly string[];
  items?: Node;
  additionalProperties?: unknown;
  enum?: readonly unknown[];
}

interface Count {
  unions: string[];
  optional: string[];
  open: string[];
  unsupported: string[];
}

/** Keywords the platform's strict schemas do not accept (same page). */
const UNSUPPORTED = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'];

function walk(node: Node, path: string, into: Count): void {
  for (const key of UNSUPPORTED) if (key in node) into.unsupported.push(`${path}.${key}`);
  if (Array.isArray(node.type) || node.anyOf !== undefined) into.unions.push(path);
  const isObject = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
  if (isObject) {
    if (node.additionalProperties !== false) into.open.push(path);
    const required = new Set(node.required ?? []);
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      if (!required.has(name)) into.optional.push(`${path}.${name}`);
      walk(child, `${path}.${name}`, into);
    }
  }
  if (node.items) walk(node.items, `${path}[]`, into);
}

function count(schema: object): Count {
  const into: Count = { unions: [], optional: [], open: [], unsupported: [] };
  walk(schema as Node, '$', into);
  return into;
}

describe('the reading’s answer schema stays inside the structured-output budget', () => {
  for (const contract of Object.values(INTAKE_CONTRACTS)) {
    describe(`contract «${contract.name}»`, () => {
      const counted = count(contract.schema);

      it(`has at most ${UNION_TYPED_MAX} union-typed parameters`, () => {
        expect(counted.unions.length, counted.unions.join(', ')).toBeLessThanOrEqual(UNION_TYPED_MAX);
      });

      it('has no optional parameter at all (every property is required)', () => {
        expect(counted.optional).toEqual([]);
        expect(counted.optional.length).toBeLessThanOrEqual(OPTIONAL_MAX);
      });

      it('closes every object and uses no keyword the platform refuses', () => {
        expect(counted.open).toEqual([]);
        expect(counted.unsupported).toEqual([]);
      });
    });
  }

  it('the packing contract adds its keys WITHOUT spending a union: the count is the legacy one', () => {
    const legacy = count(INTAKE_CONTRACTS.legacy.schema).unions;
    const packing = count(INTAKE_CONTRACTS.packing.schema).unions;
    // Twelve — five on the answer, seven on a good — and not one more: the
    // new keys say «not stated» as 0 / "unknown" / [], never as null.
    expect(legacy).toHaveLength(12);
    expect(packing.sort()).toEqual(legacy.sort());
  });

  it('the walk itself sees what it claims to: a nullable key is counted, an unlisted one is optional', () => {
    const probe = count({
      type: 'object',
      properties: {
        a: { type: ['number', 'null'] },
        b: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        c: { type: 'string' },
        d: { type: 'array', items: { type: 'object', properties: { e: { type: ['string', 'null'], maxLength: 5 } } } },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    });
    expect(probe.unions.sort()).toEqual(['$.a', '$.b', '$.d[].e']);
    expect(probe.optional.sort()).toEqual(['$.c', '$.d', '$.d[].e']);
    expect(probe.open).toEqual(['$.d[]']);
    expect(probe.unsupported).toEqual(['$.d[].e.maxLength']);
  });

  it('every figure has ONE home (the prompt audit’s PR-3): the second measure is m², pairs or litres only', () => {
    type Props = { properties: { goods: { items: { properties: Record<string, { enum?: unknown[] }> } } } };
    const good = (INTAKE_CONTRACTS.packing.schema as Props).properties.goods.items.properties;
    // Pieces, kilos, cubes and cartons have keys of their own — offered again
    // through `unit`, one carton's cube landed as the line's by the second door.
    expect(good.unit!.enum).toEqual(['m2', 'juft', 'litr', null]);
    expect(INTAKE_CONTRACTS.packing.system).not.toContain('measure_qty + unit "m3"');
    expect(INTAKE_CONTRACTS.packing.system).not.toContain('unit = "karobka"');
    // The legacy contract keeps the list production is known to accept.
    const legacy = (INTAKE_CONTRACTS.legacy.schema as Props).properties.goods.items.properties;
    expect(legacy.unit!.enum).toContain('karobka');
  });

  it('`note` is the LAST key of a good and `questions` follows `goods` — what a cut answer keeps depends on both', () => {
    type Shape = { required: string[]; properties: { goods: { items: { required: string[] } } } };
    const schema = INTAKE_CONTRACTS.packing.schema as Shape;
    expect(schema.properties.goods.items.required.at(-1)).toBe('note');
    expect(Object.keys((schema as unknown as { properties: object }).properties)).toEqual(schema.required);
    expect(schema.required.indexOf('questions')).toBe(schema.required.indexOf('goods') + 1);
  });

  it('the two contracts pair their own prompt with their own shape', () => {
    expect(INTAKE_CONTRACTS.packing.system).toContain('pieces_per_carton');
    expect(INTAKE_CONTRACTS.packing.system).toContain('name_source = "picture"');
    expect(INTAKE_CONTRACTS.legacy.system).not.toContain('cartons');
    expect(JSON.stringify(INTAKE_CONTRACTS.legacy.schema)).not.toContain('cartons');
    expect(JSON.stringify(INTAKE_CONTRACTS.packing.schema)).toContain('"questions"');
  });
});
