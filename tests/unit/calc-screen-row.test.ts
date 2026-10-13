import { describe, expect, it } from 'vitest';
import {
  ghostAutoBasis,
  ghostFixedPair,
  groupsByCodeOf,
  liveMembership,
  neededCells,
  pendingUnitOnScreen,
  postedBasis,
  screenRowOf,
  type ScreenItem,
} from '@/modules/wms/calc/screen-row';
import type { NeedLaw } from '@/modules/wms/calc/needs';
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
/** A row with no figures — the shapes these tests are about. */
const row0 = (over: Pick<ScreenItem, 'groupId' | 'tnvedCode' | 'bazaBasis'> & Partial<ScreenItem>): ScreenItem => ({
  quantity: null,
  weightKg: null,
  measureUnit: null,
  measureQty: null,
  ...over,
});

describe('screenRowOf — the law a row is read under', () => {
  it('a coded row no block holds yet reads its code’s block when the request carries one', () => {
    const row = screenRowOf(row0({ groupId: null, tnvedCode: '6907210000', bazaBasis: null }), undefined, byId, byCode);
    expect(row.lawGroup).toBe(tile);
    expect(row.basis).toBe('m2');
    expect(row.pair).toBe('m2');
  });

  it('a coded row whose code no block carries is «avto» with the generic box — never a promised unit', () => {
    const row = screenRowOf(row0({ groupId: null, tnvedCode: '6403990000', bazaBasis: null }), undefined, byId, byCode);
    expect(row).toMatchObject({ lawGroup: null, lawUnknown: true, basis: null, pair: 'any' });
  });

  it('a stored choice still stands on such a row', () => {
    const row = screenRowOf(row0({ groupId: null, tnvedCode: '6403990000', bazaBasis: 'kg' }), undefined, byId, byCode);
    expect(row.basis).toBe('kg');
  });

  it('a drafted code wins over the stored one, and a grouped row reads its own block', () => {
    const drafted = screenRowOf(row0({ groupId: null, tnvedCode: '6907210000', bazaBasis: null }), { tnvedCode: '5701100000' }, byId, byCode);
    expect(drafted.lawGroup).toBe(wool);
    expect(drafted.basis).toBe('kg');
    const grouped = screenRowOf(row0({ groupId: 'g-wool', tnvedCode: '5701100000', bazaBasis: null }), undefined, byId, byCode);
    expect(grouped).toMatchObject({ lawGroup: wool, lawUnknown: false, basis: 'kg', pair: null });
  });

  it('an uncoded ungrouped row has no law and reads the plain default', () => {
    const row = screenRowOf(row0({ groupId: null, tnvedCode: null, bazaBasis: null }), undefined, byId, byCode);
    expect(row).toMatchObject({ lawGroup: null, lawUnknown: false, basis: 'unit', pair: null });
  });
  /**
   * «avto» is the SAVE's rule now (2026-10-09, judge MR-17): the law, then
   * what the row states. The select used to show the law alone — «dona» on a
   * weight-only row the save then stamped per kg.
   */
  it('«avto» reads the row: a weight-only advalor row is kg, a stated m² is m², a drafted count turns it back', () => {
    const weightOnly = row0({ groupId: null, tnvedCode: null, bazaBasis: null, weightKg: 40 });
    expect(screenRowOf(weightOnly, undefined, byId, byCode).basis).toBe('kg');
    expect(screenRowOf(weightOnly, { quantity: '10' }, byId, byCode).basis).toBe('unit');
    const tiles = row0({ groupId: null, tnvedCode: null, bazaBasis: null, measureUnit: 'm2', measureQty: 120 });
    const read = screenRowOf(tiles, undefined, byId, byCode);
    expect(read).toMatchObject({ basis: 'm2', pair: 'm2' });
    // The law still wins: a kg law keeps kg whatever the row states.
    expect(screenRowOf({ ...tiles, tnvedCode: '5701100000' }, undefined, byId, byCode).basis).toBe('kg');
  });

  it('a ghost row’s «avto» reads what is typed, the unit select included', () => {
    expect(ghostAutoBasis({ quantity: '', weightKg: '12', measure: '', measureUnit: null }, null)).toBe('kg');
    expect(ghostAutoBasis({ quantity: '', weightKg: '', measure: '120', measureUnit: 'm2' }, null)).toBe('m2');
    expect(ghostAutoBasis({ quantity: '', weightKg: '', measure: '120', measureUnit: 'm2' }, wool)).toBe('kg');
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

/**
 * P3.2: the cell a refusal will name is marked BEFORE anybody presses
 * anything — the owner's kg-and-dona goods («kg hamda donani birga
 * kirgizadgan tovarlar», 2026-10-09). The law and the baza ask two different
 * figures whenever their units differ, and the row must state both.
 */
describe('neededCells — which cells a row still owes the engine', () => {
  const law = (over: Partial<NeedLaw>): NeedLaw => ({
    dutyMode: 'advalor',
    dutyUnit: null,
    dutySpecific: null,
    dutyFree: false,
    ...over,
  });
  const item = (over: Partial<ScreenItem & { volumeM3: number | null; bazaUsd: number | null }>) => ({
    ...row0({ groupId: 'g', tnvedCode: '6201000000', bazaBasis: null }),
    volumeM3: null,
    bazaUsd: null,
    ...over,
  });
  const cells = (n: ReturnType<typeof neededCells>) => n.map((x) => `${x.cell}:${x.why}`);

  it('a jacket priced per kg under «kamida $3/dona» marks its COUNT, with the floor’s rate', () => {
    const needs = neededCells(
      { basis: 'kg', pair: null },
      law({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: 3 }),
      item({ bazaUsd: 5, bazaBasis: 'kg', weightKg: 100 }),
      undefined,
    );
    expect(cells(needs)).toEqual(['quantity:duty']);
    expect(needs[0]).toMatchObject({ unit: 'dona', rate: 3 });
  });

  it('a table priced per piece under «kamida $0.4/kg» marks its WEIGHT', () => {
    const needs = neededCells(
      { basis: 'unit', pair: null },
      law({ dutyMode: 'max', dutyUnit: 'kg', dutySpecific: 0.4 }),
      item({ bazaUsd: 20, bazaBasis: 'unit', quantity: 10 }),
      undefined,
    );
    expect(cells(needs)).toEqual(['weightKg:duty']);
  });

  it('an UNPRICED row asks nothing for its baza — a guessed unit marked on every new row is noise', () => {
    expect(neededCells({ basis: 'unit', pair: null }, law({}), item({}), undefined)).toEqual([]);
    // …while the law's floor asks whether or not a price is typed.
    expect(
      cells(neededCells({ basis: null, pair: null }, law({ dutyMode: 'specific', dutyUnit: 'kg', dutySpecific: 1 }), item({}), undefined)),
    ).toEqual(['weightKg:duty']);
  });

  it('a priced m² baza with no m² stated marks the O‘lchov box; the stated pair clears it', () => {
    const asked = neededCells({ basis: 'm2', pair: 'm2' }, law({}), item({ bazaUsd: 4, bazaBasis: 'm2', quantity: 120 }), undefined);
    expect(cells(asked)).toEqual(['measure:baza']);
    expect(
      neededCells({ basis: 'm2', pair: 'm2' }, law({}), item({ bazaUsd: 4, bazaBasis: 'm2', measureUnit: 'm2', measureQty: 120 }), undefined),
    ).toEqual([]);
    // A stored pair in ANOTHER unit is no m² at all — the save clears it.
    expect(
      cells(neededCells({ basis: 'm2', pair: 'm2' }, law({}), item({ bazaUsd: 4, bazaBasis: 'm2', measureUnit: 'litr', measureQty: 120 }), undefined)),
    ).toEqual(['measure:baza']);
  });

  it('the drafts are read: a typed count clears the mark, an ambiguous «1,125» does not, a cleared price stops asking', () => {
    const floor = law({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: 3 });
    const jacket = item({ bazaUsd: 5, bazaBasis: 'kg', weightKg: 100 });
    expect(neededCells({ basis: 'kg', pair: null }, floor, jacket, { quantity: '40' })).toEqual([]);
    expect(cells(neededCells({ basis: 'kg', pair: null }, floor, jacket, { quantity: '1,125' }))).toEqual(['quantity:duty']);
    // The weight cleared in the draft: the baza asks it again, beside the floor.
    expect(cells(neededCells({ basis: 'kg', pair: null }, floor, jacket, { weightKg: '' }))).toEqual([
      'weightKg:baza',
      'quantity:duty',
    ]);
    expect(
      neededCells({ basis: 'm2', pair: 'm2' }, law({}), item({ bazaUsd: 4, bazaBasis: 'm2' }), { bazaValue: '' }),
    ).toEqual([]);
  });

  it('a duty-free (lgota) row asks no floor; a specific excise per litre asks the litres', () => {
    expect(
      neededCells({ basis: null, pair: null }, law({ dutyMode: 'max', dutyUnit: 'kg', dutySpecific: 1, dutyFree: true }), item({}), undefined),
    ).toEqual([]);
    const beer = neededCells(
      { basis: null, pair: 'litr' },
      law({ exciseSpecific: 0.2, exciseUnit: 'litr' }),
      item({ tnvedCode: '2203000100' }),
      undefined,
    );
    expect(cells(beer)).toEqual(['measure:excise']);
    // An ad-valorem excise charges no specific one, so it asks nothing.
    expect(
      neededCells({ basis: null, pair: 'litr' }, law({ excisePct: 10, exciseSpecific: 0.2, exciseUnit: 'litr' }), item({}), undefined),
    ).toEqual([]);
  });

  it('a row with no known law asks only what its own price is per', () => {
    expect(neededCells({ basis: 'kg', pair: null }, null, item({ bazaUsd: 3, bazaBasis: 'kg' }), undefined).map((n) => n.cell)).toEqual([
      'weightKg',
    ]);
  });
});

/**
 * UX7: a row stored before the doors learned units says so BEFORE any press
 * — with the save's own predicate, so the sentence never promises a move
 * the save does not make.
 */
describe('pendingUnitOnScreen — the sentence is the save’s own decision', () => {
  const old = (over: Partial<ScreenItem & { unit: string | null; volumeM3: number | null; bazaUsd: number | null }>) => ({
    ...row0({ groupId: null, tnvedCode: null, bazaBasis: null }),
    unit: 'm2',
    quantity: 120,
    volumeM3: null,
    bazaUsd: null,
    ...over,
  });
  const ctx = { confirmed: false, lawDutyUnit: null };

  it('«120 m2» in the piece column moves; «500 kg» moves to the weight', () => {
    expect(pendingUnitOnScreen(old({}), ctx, undefined)).toMatchObject({ kind: 'move', to: 'm2', quantity: 120, word: 'm2' });
    expect(pendingUnitOnScreen(old({ unit: 'kg', quantity: 500 }), ctx, undefined)).toMatchObject({ kind: 'move', to: 'kg' });
  });

  it('a carton count, an unknown word and a pair the law contradicts are ASKED, never moved', () => {
    expect(pendingUnitOnScreen(old({ unit: 'karobka', quantity: 12 }), ctx, undefined)?.kind).toBe('ask');
    expect(pendingUnitOnScreen(old({ unit: 'qop', quantity: 12 }), ctx, undefined)?.kind).toBe('ask');
    expect(pendingUnitOnScreen(old({}), { confirmed: false, lawDutyUnit: 'juft' }, undefined)?.kind).toBe('ask');
    // The law's own pair is a plain move.
    expect(pendingUnitOnScreen(old({}), { confirmed: false, lawDutyUnit: 'm2' }, undefined)?.kind).toBe('move');
  });

  it('a priced, unit-chosen or confirmed row is left as it stands — and so is a price typed in the draft', () => {
    expect(pendingUnitOnScreen(old({ bazaUsd: 3, bazaBasis: 'unit' }), ctx, undefined)).toBeNull();
    expect(pendingUnitOnScreen(old({ bazaBasis: 'm2' }), ctx, undefined)).toBeNull();
    expect(pendingUnitOnScreen(old({}), { confirmed: true, lawDutyUnit: null }, undefined)).toBeNull();
    expect(pendingUnitOnScreen(old({}), ctx, { bazaValue: '3' })).toBeNull();
    // An emptied or ambiguous price is no price: the save still moves it.
    expect(pendingUnitOnScreen(old({ bazaUsd: 3 }), ctx, { bazaValue: '' })?.kind).toBe('move');
  });

  it('a count word, an empty count and a row with no word ask nothing', () => {
    expect(pendingUnitOnScreen(old({ unit: 'шт' }), ctx, undefined)).toBeNull();
    expect(pendingUnitOnScreen(old({ quantity: null }), ctx, undefined)).toBeNull();
    expect(pendingUnitOnScreen(old({ unit: null }), ctx, undefined)).toBeNull();
  });
});

/**
 * P3.8 (judge MR-22): the live bar prices each row in the block the SAVE
 * will put it in. It used to price a re-coded row in its old block and count
 * ungrouped rows off the stored list — a total the next Saqlash changes.
 */
describe('liveMembership — the drafted blocks, by the save’s own regroup', () => {
  const r = (id: string, over: Pick<ScreenItem, 'groupId' | 'tnvedCode'>) => ({
    id,
    ...row0({ bazaBasis: null, ...over }),
  });
  const items = [
    r('a', { groupId: 'g-tile', tnvedCode: '6907210000' }),
    r('b', { groupId: 'g-tile', tnvedCode: '6907210000' }),
    r('c', { groupId: null, tnvedCode: null }),
  ];
  const ids = (list: { id: string }[] | undefined) => (list ?? []).map((i) => i.id);

  it('nothing drafted: the stored blocks, and nothing moved', () => {
    const live = liveMembership(items, {}, byId, byCode);
    expect(ids(live.members.get('g-tile'))).toEqual(['a', 'b']);
    expect(ids(live.ungrouped)).toEqual(['c']);
    expect(live).toMatchObject({ unsavedCode: false });
    expect([...live.moved]).toEqual([]);
  });

  it('a row re-coded to another block’s code prices THERE; both blocks are «moved»', () => {
    const live = liveMembership(items, { b: { tnvedCode: '5701100000' } }, byId, byCode);
    expect(ids(live.members.get('g-tile'))).toEqual(['a']);
    expect(ids(live.members.get('g-wool'))).toEqual(['b']);
    expect([...live.moved].sort()).toEqual(['g-tile', 'g-wool']);
  });

  it('a code drafted EMPTY leaves its block and counts as ungrouped; an uncoded row given a code joins', () => {
    const live = liveMembership(items, { a: { tnvedCode: '' }, c: { tnvedCode: '5701100000' } }, byId, byCode);
    expect(ids(live.ungrouped)).toEqual(['a']);
    expect(ids(live.members.get('g-wool'))).toEqual(['c']);
  });

  it('a drafted code no block carries means no figure until the save mints it', () => {
    const live = liveMembership(items, { c: { tnvedCode: '6403990000' } }, byId, byCode);
    expect(live.unsavedCode).toBe(true);
    expect(ids(live.ungrouped)).toEqual([]);
  });
});

/**
 * The new row's O'lchov unit select and the unit its add posts ask the LAW
 * or a CHOSEN unit — never the pair the typed measure states (found by m9zr
 * in a browser: asked of `pair`, the select vanished the moment m² was
 * picked, the add posted no unit, and the save dropped the 120 m²).
 */
describe('ghostFixedPair — what the law or a chosen unit names, never the typed measure', () => {
  it('an uncoded row names nothing, whatever its typed measure says; the VED picks', () => {
    expect(ghostFixedPair({ tnvedCode: '', bazaBasis: null }, byCode)).toBeNull();
  });
  it('a code whose block counts in m² names m²; an unknown code names nothing', () => {
    expect(ghostFixedPair({ tnvedCode: '6907210000', bazaBasis: null }, byCode)).toBe('m2');
    expect(ghostFixedPair({ tnvedCode: '6403990000', bazaBasis: null }, byCode)).toBeNull();
  });
  it('a CHOSEN pair basis names its unit', () => {
    expect(ghostFixedPair({ tnvedCode: '', bazaBasis: 'juft' }, byCode)).toBe('juft');
    expect(ghostFixedPair({ tnvedCode: '5701100000', bazaBasis: 'kg' }, byCode)).toBeNull();
  });
  it('the add and the select ask it — `screen.pair` follows the typed measure and would post nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const table = readFileSync('src/app/(protected)/hisoblash/[id]/items-table.tsx', 'utf8');
    expect(table).toContain('(nums.measure ?? null) !== null && ghostFixedPair(row, maps.groupsByCode) === null');
    expect(table).toContain('const fixedPair = ghostFixedPair(row, groupsByCode);');
    expect(table).toContain('{fixedPair !== null ? (');
  });
});
