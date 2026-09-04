import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The ✨ proposal is WIRED to its pricing tail.
 *
 * `priceProposedGroups` is proven behaviourally in the integration suite —
 * it pulls the book's rate and stamps the item's code — but that test calls
 * it DIRECTLY, because `proposeGroups` needs a model and this container has
 * no key. Removing the call from `proposeGroups` therefore left the whole
 * suite green: #531's rule, met in its own round («a service-level test of a
 * form-fed path proves the service, not the system»), and #166's («a red
 * proof that will not go red is evidence about the fixture»).
 *
 * So the CALL is pinned here, as source shape. What it protects is the
 * defect the round measured: without the tail, pressing ✨ produces a
 * request nobody can price — groups with a code and no rates, items with no
 * code at all — over a seeded book of 1,489 PP-3818 rates.
 */
const SRC = readFileSync('src/modules/wms/calc/workspace.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** One exported function's body, up to the next top-level export. */
function body(name: string): string {
  const at = SRC.indexOf(`export async function ${name}`);
  expect(at, `${name} vanished from workspace.ts`).toBeGreaterThan(-1);
  const next = SRC.indexOf('\nexport ', at + name.length + 30);
  return SRC.slice(at, next === -1 ? SRC.length : next);
}

describe('a proposal is turned into a calculation', () => {
  it('proposeGroups runs the pricing tail after applyProposal', () => {
    const fn = body('proposeGroups');
    expect(fn).toContain('applyProposal(');
    expect(fn).toContain('priceProposedGroups(');
    // Order matters: the groups must exist before they can be priced.
    expect(fn.indexOf('applyProposal(')).toBeLessThan(fn.indexOf('priceProposedGroups('));
  });

  it('the tail writes through the doors that lock, never a bare UPDATE', () => {
    const fn = body('priceProposedGroups');
    expect(fn).toContain('pullRatesFromDictionary(');
    expect(fn).toContain('saveTable(');
    // It READS the rate columns to decide what still needs pulling, and
    // writes NOTHING itself: a bare UPDATE here would put a rate this
    // function chose beside the model's code, and the book's own answer is
    // the only one allowed to price a proposal.
    expect(fn).not.toMatch(/\.set\(/);
    expect(fn).not.toMatch(/\.insert\(/);
  });

  it('rates are pulled BEFORE the codes are stamped', () => {
    // The group's duty_unit is what says which of the customs file's units
    // may price a row (0094's unitsForRow), and saveTable is what runs the
    // import fill — so the rates have to be there first or every fill asks
    // the wrong unit.
    const fn = body('priceProposedGroups');
    expect(fn.indexOf('pullRatesFromDictionary(')).toBeLessThan(fn.indexOf('saveTable('));
  });
});
