import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 0 of the phone round, and 0125's one-chain rule — as SOURCE SHAPE,
 * because none of it is visible to a behavioural test this suite can run:
 * a thrown server action only exists on a broken network, the phone card is
 * `md:hidden` markup no mobile spec opens, and «the four sites ask one
 * function» is a property of the code rather than of any one screen.
 *
 * Comments are stripped first (#725): a rule that trips on the sentence
 * explaining it is a rule that gets deleted.
 */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const WS = strip(readFileSync('src/app/(protected)/hisoblash/[id]/calc-workspace.tsx', 'utf8'));
const TABLE = strip(readFileSync('src/app/(protected)/hisoblash/[id]/items-table.tsx', 'utf8'));

describe('a thrown action is a sentence, never the error page', () => {
  it('act() wraps the work in try/catch and says save_failed', () => {
    const at = WS.indexOf('const act =');
    expect(at).toBeGreaterThan(-1);
    const body = WS.slice(at, WS.indexOf(';\n\n', at) + 1);
    expect(body).toContain('try {');
    expect(body).toMatch(/catch\s*\{\s*setError\('save_failed'\)/);
  });
});

describe('the phone ✅ waits on unsaved cells, as the desktop one does', () => {
  it('the confirm button renders only when nothing is dirty', () => {
    const at = TABLE.indexOf('data-testid="calc-phone-confirm"');
    expect(at).toBeGreaterThan(-1);
    // The branch that draws it sits behind the dirty gate, with the «save
    // first» sentence in its place.
    const before = TABLE.slice(Math.max(0, at - 1200), at);
    expect(before).toContain('dirtyCount > 0 ?');
    expect(before).toContain('data-testid="calc-phone-save-first"');
  });
});

describe('new rows carry the id their screen minted', () => {
  it('the ghost row and the paste both post a clientId', () => {
    expect(TABLE).toContain('clientId: row.clientId');
    expect(TABLE).toMatch(/clientId: ids\[i\]/);
    expect(TABLE).toContain('clientId: mintClientId()');
  });
});

describe('ONE chain for the unit on screen (#886, #171)', () => {
  it('the old per-group law helpers are gone from the grid', () => {
    expect(TABLE).not.toContain('requiredUnitOf');
    expect(TABLE).not.toContain('EXT_UNITS');
    // No hand-written basis list left in the grid either.
    expect(TABLE).not.toMatch(/\['unit', 'kg'/);
  });

  it('the row, the live engine item, the save and the self-clean all ask screenRowOf', () => {
    const uses = TABLE.match(/screenRowOf\(item, /g) ?? [];
    // serverValueOf (measure + basis), liveItem, save(), ItemRowBlock.
    expect(uses.length).toBeGreaterThanOrEqual(5);
    const live = TABLE.slice(TABLE.indexOf('const liveItem'), TABLE.indexOf('const liveCustomsByGroup'));
    expect(live).toContain('screenRowOf(item');
    expect(live).toContain('volumeM3: numOf(d?.volumeM3');
    const save = TABLE.slice(TABLE.indexOf('const save = async'), TABLE.indexOf('const onCellKey'));
    expect(save).toContain('screenRowOf(item, d,');
    // The unit a baza edit posts is ONE rule (screen-row.ts), unit-tested in
    // calc-screen-row.test.ts — a touched unit, a cleared price, a stored one.
    expect(save).toContain('edit.bazaBasis = postedBasis(d.bazaBasis, v === null, item);');
  });

  it('the desktop footer’s A1 chip reads the LIVE rows its baza reads (review units-r2-2)', () => {
    const memo = TABLE.slice(TABLE.indexOf('const liveBasisNotLawByGroup'), TABLE.indexOf('const liveTotals'));
    expect(memo).toContain('basisNotLaw(g.dutyUnit, g.items.map((i) => liveItem(i)))');
    const footer = TABLE.slice(TABLE.indexOf('function BlockFooter'));
    expect(footer).toContain('{liveBasisNotLaw && group.dutyUnit ? (');
    expect(footer).not.toContain("group.warnings.includes('basis_not_law')");
  });
});
