import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Who changes a row's LAW, and who reconciles its measure pair afterwards
 * (0125).
 *
 * Since the pair follows `pairUnitFor(law, basis)` per ITEM, any door that
 * changes a group's `duty_unit` or moves an item into another group changes
 * what the row's one pair must hold. `saveTable`'s measure pass is the ONE
 * writer of the pair and of the «avto» stamp; every other door that moves
 * the law runs no pass, and the stored pair reconciles on the next Saqlash —
 * the same lag the law-pinned pair has always had, and stated here so it is
 * a decision and not an accident. The live screen asks `pairUnitFor` with
 * the unit on screen, so the box it draws is already the reconciled one.
 *
 * DERIVED: the exported functions whose bodies write a group's `dutyUnit`
 * or an item's `groupId` are FOUND, so a new door turns this red until
 * somebody writes down why it may skip the pass. Comments are stripped
 * first (#725).
 */
const SRC = readFileSync('src/modules/wms/calc/workspace.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Every top-level function's body, up to the NEXT top-level declaration —
 * not merely the next export, or a private helper (autoGroupInTx) would be
 * charged to whichever export happens to precede it. A private helper is
 * charged to the export that CALLS it below.
 */
function functionBodies(): Map<string, string> {
  const out = new Map<string, string>();
  const decl = /^(?:export )?(?:async )?function (\w+)/gm;
  const anyTop = /^(?:export |async function |function |interface |type |const |let )/gm;
  const tops: number[] = [];
  for (let m = anyTop.exec(SRC); m; m = anyTop.exec(SRC)) tops.push(m.index);
  for (let m = decl.exec(SRC); m; m = decl.exec(SRC)) {
    const end = tops.find((t) => t > m!.index) ?? SRC.length;
    out.set(m[1]!, SRC.slice(m.index, end));
  }
  return out;
}

function exportedBodies(): Map<string, string> {
  const all = functionBodies();
  const exported = new Set([...SRC.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!));
  // A private helper that moves the law is charged to every export calling it.
  const privateMovers = [...all.entries()]
    .filter(([name, body]) => !exported.has(name) && (writesLaw(body) || movesItems(body)))
    .map(([name]) => name);
  const out = new Map<string, string>();
  for (const name of exported) {
    let body = all.get(name)!;
    for (const helper of privateMovers) {
      if (new RegExp(`\\b${helper}\\(`).test(body)) body += `\n${all.get(helper)}`;
    }
    out.set(name, body);
  }
  return out;
}

/** Writes a group's law: `dutyUnit` inside an update or insert of calcGroups. */
const writesLaw = (body: string) =>
  /\.(update|insert)\(calcGroups\)[\s\S]{0,40}\.(set|values)\(\{[^}]*\bdutyUnit\b/.test(body);
/** Moves an item between groups: `groupId` set or inserted on an item row. */
const movesItems = (body: string) =>
  /\.set\(\{\s*groupId\b/.test(body) ||
  /\.insert\(calcRequestItems\)[\s\S]{0,40}\.values\(\{[^}]*\bgroupId\b/.test(body);

/** Every door but saveTable that moves the law, and why it may skip the pass. */
const SKIPS_THE_PASS: Record<string, string> = {
  setGroupRates:
    'the ⚙ rates door (and pullRatesFromDictionary through it): the pair reconciles on the next Saqlash',
  moveItemToGroup: 'no app caller since the table; the pair reconciles on the next Saqlash',
  applyProposal:
    'the ✨ pass: its pricing tail (priceProposedGroups) ends in saveTable, which runs the pass',
  // Re-worded deliberately (2026-10-09, judge MR-15/TT-8): the correction now
  // RE-READS today's book for every dictionary group, so the law it copies
  // may differ from the one the seal stood on. When that moves a group's
  // unit, the rows are NAMED (`remeasure`, shown once on the new request's
  // first load) and their pairs wait for the first Saqlash, like the ⚙ door.
  recalcFromSealed:
    'copies a SEALED request; a re-pulled law that moves a unit names its rows (remeasure) for the first Saqlash',
};

describe('the measure pair has ONE reconciler', () => {
  const bodies = exportedBodies();

  it('saveTable runs the pass — per item, the law first, then the basis', () => {
    const save = bodies.get('saveTable')!;
    // Re-anchored deliberately (2026-10-09, judge TT-3/MR-3/S2): «avto» is
    // the law first and then a pair the ROW states, so the stamp and the
    // required unit both read `autoBasisFor` — the law-only `defaultBasisFor`
    // stays the A2 suspect check's question, below.
    expect(save).toContain('const required = pairUnitFor(law, basis ?? auto);');
    expect(save).toContain('basis = auto;');
    expect(save).toContain('const auto = autoBasisFor(');
    expect(save).toContain('const lawBasis = defaultBasisFor({ dutyUnit: law });');
    expect(save).toContain('basisConflict.push(item.seq)');
  });

  it('every OTHER door that moves a row’s law is named, with its reason', () => {
    const movers = [...bodies.entries()]
      .filter(([name, body]) => name !== 'saveTable' && (writesLaw(body) || movesItems(body)))
      .map(([name]) => name)
      .sort();
    expect(movers).toEqual(Object.keys(SKIPS_THE_PASS).sort());
  });
});
