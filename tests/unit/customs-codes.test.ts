import { describe, expect, it } from 'vitest';
import { parseCustomsCodes } from '@/modules/wms/calc/customs-codes';

/**
 * `calc_customs_cost_type_codes` arrives in TWO shapes: the shipped default
 * (no row) as the JSON TEXT, and a saved row as an ARRAY — the row stores a
 * JSON text inside jsonb and drizzle parses jsonb once more. The old parse
 * stringified an array into «customs,x», JSON refused it, and every list the
 * owner ever saved read as the default.
 */
describe('parseCustomsCodes', () => {
  it('reads a saved row (an array) as the codes it holds', () => {
    expect(parseCustomsCodes(['customs', 'zatamojka'])).toEqual(['customs', 'zatamojka']);
    expect(parseCustomsCodes(['other'])).toEqual(['other']);
  });
  it('reads the default text, and degrades garbage to the shipped code', () => {
    expect(parseCustomsCodes('["customs"]')).toEqual(['customs']);
    expect(parseCustomsCodes(undefined)).toEqual(['customs']);
    expect(parseCustomsCodes('not json')).toEqual(['customs']);
    expect(parseCustomsCodes([])).toEqual(['customs']);
  });
});
