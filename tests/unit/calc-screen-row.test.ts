import { describe, expect, it } from 'vitest';
import { groupsByCodeOf, postedBasis, screenRowOf } from '@/modules/wms/calc/screen-row';
import { basisNotLaw } from '@/modules/wms/calc/warnings';
import { pasteIdsFor } from '@/modules/wms/calc/paste-ids';

/**
 * The unit a row's select SHOWS must be the unit Saqlash STORES (#886's
 * live-equals-saved, #171). The review found the one row shape that broke it:
 * a stored code with no block yet — how intake hands the VED most requests —
 * read as «no law», drew a fixed «шт», and the save's sweep stamped the
 * code's own unit (kg, m²) under a price typed «per piece» (review units-3).
 */
const tile = { id: 'g-tile', dutyUnit: 'm2', tnvedCode: '6907210000' };
const wool = { id: 'g-wool', dutyUnit: 'kg', tnvedCode: '5701100000' };
const groups = [tile, wool];
const byId = new Map(groups.map((g) => [g.id, g]));
const byCode = groupsByCodeOf(groups);

describe('screenRowOf — the law a row is read under', () => {
  it('a coded row no block holds yet reads its code’s block when the request carries one', () => {
    const row = screenRowOf({ groupId: null, tnvedCode: '6907210000', bazaBasis: null }, undefined, byId, byCode);
    expect(row.lawGroup).toBe(tile);
    expect(row.basis).toBe('m2');
    expect(row.pair).toBe('m2');
  });

  it('a coded row whose code no block carries is «avto» with the generic box — never a promised unit', () => {
    const row = screenRowOf({ groupId: null, tnvedCode: '6403990000', bazaBasis: null }, undefined, byId, byCode);
    expect(row).toMatchObject({ lawGroup: null, lawUnknown: true, basis: null, pair: 'any' });
  });

  it('a stored choice still stands on such a row', () => {
    const row = screenRowOf({ groupId: null, tnvedCode: '6403990000', bazaBasis: 'kg' }, undefined, byId, byCode);
    expect(row.basis).toBe('kg');
  });

  it('a drafted code wins over the stored one, and a grouped row reads its own block', () => {
    const drafted = screenRowOf({ groupId: null, tnvedCode: '6907210000', bazaBasis: null }, { tnvedCode: '5701100000' }, byId, byCode);
    expect(drafted.lawGroup).toBe(wool);
    expect(drafted.basis).toBe('kg');
    const grouped = screenRowOf({ groupId: 'g-wool', tnvedCode: '5701100000', bazaBasis: null }, undefined, byId, byCode);
    expect(grouped).toMatchObject({ lawGroup: wool, lawUnknown: false, basis: 'kg', pair: null });
  });

  it('an uncoded ungrouped row has no law and reads the plain default', () => {
    const row = screenRowOf({ groupId: null, tnvedCode: null, bazaBasis: null }, undefined, byId, byCode);
    expect(row).toMatchObject({ lawGroup: null, lawUnknown: false, basis: 'unit', pair: null });
  });
});

describe('pasteIdsFor — a retried paste posts the ids its first press used (review units-2)', () => {
  let n = 0;
  const mint = () => `new-${++n}`;
  const prev = { keys: ['a', 'b', 'c'], ids: ['id-a', 'id-b', 'id-c'] };

  it('the same lines keep their ids', () => {
    expect(pasteIdsFor(prev, ['a', 'b', 'c'], mint)).toEqual(['id-a', 'id-b', 'id-c']);
  });

  it('a line fixed in between takes the id its typo’d self landed under — an edit, not a copy', () => {
    expect(pasteIdsFor(prev, ['a', 'B!', 'c'], mint)).toEqual(['id-a', 'id-b', 'id-c']);
  });

  it('a line added mints; a line removed leaves its id unused', () => {
    const added = pasteIdsFor(prev, ['a', 'b', 'c', 'd'], mint);
    expect(added.slice(0, 3)).toEqual(['id-a', 'id-b', 'id-c']);
    expect(added[3]).toMatch(/^new-/);
    expect(pasteIdsFor(prev, ['a', 'c'], mint)).toEqual(['id-a', 'id-c']);
  });

  it('identical lines consume their ids in order, and a first paste mints them all', () => {
    expect(pasteIdsFor({ keys: ['x', 'x'], ids: ['i1', 'i2'] }, ['x', 'x'], mint)).toEqual(['i1', 'i2']);
    const fresh = pasteIdsFor({ keys: [], ids: [] }, ['p', 'q'], mint);
    expect(new Set(fresh).size).toBe(2);
    expect(fresh.every((v) => typeof v === 'string' && v.startsWith('new-'))).toBe(true);
  });
});

describe('postedBasis — clearing a price never invents a choice (review units-r2-1)', () => {
  it('a priced row cleared with the select untouched goes back to «avto» — whatever its unit was', () => {
    // A pre-0125 «шт» on a juft code, and a kg fill on an advalor code: both
    // differ from today's default and neither was picked by anyone.
    expect(postedBasis(undefined, true, { bazaUsd: 3, bazaBasis: 'unit' })).toBeNull();
    expect(postedBasis(undefined, true, { bazaUsd: 2, bazaBasis: 'kg' })).toBeNull();
  });

  it('a unit chosen on an unpriced row survives a price typed and cleared again', () => {
    expect(postedBasis(undefined, true, { bazaUsd: null, bazaBasis: 'm3' })).toBe('m3');
  });

  it('a touched select always wins, and an untouched one keeps what is stored', () => {
    expect(postedBasis('litr', true, { bazaUsd: 3, bazaBasis: 'unit' })).toBe('litr');
    expect(postedBasis(undefined, false, { bazaUsd: 3, bazaBasis: 'unit' })).toBe('unit');
    expect(postedBasis(undefined, false, { bazaUsd: 3, bazaBasis: null })).toBeNull();
  });
});

describe('basisNotLaw — the footer asks the server’s own sentence over the LIVE rows (review units-r2-2)', () => {
  it('a row re-picked to the law’s unit is no longer flagged; one re-picked away from it is', () => {
    expect(basisNotLaw('litr', [{ bazaUsd: 1, bazaBasis: 'litr' }])).toBe(false);
    expect(basisNotLaw('juft', [{ bazaUsd: 4, bazaBasis: 'kg' }])).toBe(true);
  });

  it('an unpriced row and a law that pins no unit are silent', () => {
    expect(basisNotLaw('juft', [{ bazaUsd: null, bazaBasis: 'kg' }])).toBe(false);
    expect(basisNotLaw(null, [{ bazaUsd: 4, bazaBasis: 'kg' }])).toBe(false);
    expect(basisNotLaw('dona', [{ bazaUsd: 4, bazaBasis: 'kg' }])).toBe(false);
  });
});
