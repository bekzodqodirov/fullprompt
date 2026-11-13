import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INTAKE_CONTRACTS } from '@/modules/wms/calc/intake-ai';

/**
 * docs/AI-SORAYDI.md §2.2, review JB-12 — the reading's CONTRACT is frozen.
 *
 * The prompt and the answer's shape are one thing read by seven packages
 * built side by side: the table, the typed answers, the pictures, the asks.
 * A package that adds a key or rewords a rule for its own need changes what
 * every other one is handed — and there is no key where this is written, so
 * no run would show it. So both are pinned by their hash, and only the LEAD
 * changes them: edit the contract, re-read the whole prompt, run
 * `tests/unit/intake-schema-budget.test.ts` (the API's own limits), then put
 * the new hash here in the same commit and say why in DECISIONS.
 *
 * A red run of this file is never fixed by pasting the hash it prints.
 */
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const FROZEN = {
  packing: {
    system: 'b328d87199a713703f3b88b7f82afdf93387d3983491dc2e1baf27257055e32f',
    schema: '70442353783888036dc96bb382c2702652063af7b664930924f9561947edb769',
  },
  // The legacy pair is what production ran before this round, and what a
  // refused schema falls back to: it must stay EXACTLY that reading.
  legacy: {
    system: '2596977c4881682fac0b7455af793526a61dd5d1c1f689a70e5901d0d3954472',
    schema: 'c0793a85d941becb099caa2a7c8f726f1b7532ba87650bb55c74dbf40f428b01',
  },
} as const;

describe('the reading’s contract is frozen (only the lead changes it)', () => {
  for (const name of ['packing', 'legacy'] as const) {
    it(`${name}: the prompt`, () => {
      expect(sha(INTAKE_CONTRACTS[name].system)).toBe(FROZEN[name].system);
    });
    it(`${name}: the answer’s shape`, () => {
      expect(sha(JSON.stringify(INTAKE_CONTRACTS[name].schema))).toBe(FROZEN[name].schema);
    });
  }

  it('the keys the round’s packages are built against are all there', () => {
    const schema = JSON.stringify(INTAKE_CONTRACTS.packing.schema);
    for (const key of ['name_source', 'photo', 'weight_kind', 'packing', 'code_sure', 'pieces_per_carton', 'size_of', 'questions', 'list', 'known_codes']) {
      expect(schema, key).toContain(`"${key}"`);
    }
    // A question says which list its number is in; a known row may be named.
    const top = (INTAKE_CONTRACTS.packing.schema as { properties: Record<string, { items: { required: string[] } }> }).properties;
    expect(top.questions!.items.required).toEqual(['list', 'n', 'kind', 'text']);
    expect(top.known_codes!.items.required).toEqual(['n', 'tnved_code', 'name']);
  });
});
