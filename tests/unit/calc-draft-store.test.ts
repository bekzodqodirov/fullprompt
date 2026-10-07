import { describe, expect, it } from 'vitest';
import {
  DRAFT_TTL_MS,
  draftStorageKey,
  mergeForStorage,
  parseStoredDrafts,
  planRestore,
  readStored,
  serializeDrafts,
  writeStored,
  type StoredDrafts,
} from '@/modules/wms/calc/draft-store';
import { emptyRow, type DraftItem, type NewRow } from '@/modules/wms/calc/row-draft';

/**
 * His B5 a — unsaved edits survive a closed tab and are OFFERED back,
 * «Saqlanmagan o'zgarishlar bor — tiklaymi?», never applied by themselves.
 * The guard is per field: what a colleague changed meanwhile is named and
 * not offered; what his own save already landed is blamed on nobody.
 */

const NOW = Date.parse('2026-10-07T10:00:00Z');
const item = (over: Partial<DraftItem> & { id: string }): DraftItem => ({
  seq: 1,
  label: 'kosa',
  tnvedCode: null,
  quantity: 10,
  weightKg: null,
  volumeM3: null,
  note: null,
  measureUnit: null,
  measureQty: null,
  bazaUsd: null,
  bazaBasis: null,
  ...over,
});
const ghost = (over: Partial<NewRow>): NewRow => ({ ...emptyRow(1), ...over });
const entry = (over: Partial<StoredDrafts>): StoredDrafts => ({
  v: 1,
  savedAt: new Date(NOW).toISOString(),
  rows: {},
  ghosts: [],
  ...over,
});
const basis = () => null;

describe('the key and the blob', () => {
  it('carries the viewer and the request — another login never reads it', () => {
    expect(draftStorageKey('U1', 'R1')).toBe('gsr.calc-draft.v1:U1:R1');
    expect(draftStorageKey('U2', 'R1')).not.toBe(draftStorageKey('U1', 'R1'));
  });

  it('a 72-hour-old entry is nothing; a fresh one reads back', () => {
    const fresh = JSON.stringify(
      entry({ rows: { A: { draft: { quantity: '4' }, base: { quantity: 1 } } } }),
    );
    expect(parseStoredDrafts(fresh, NOW)?.rows.A?.draft).toEqual({ quantity: '4' });
    expect(parseStoredDrafts(fresh, NOW + DRAFT_TTL_MS + 1)).toBeNull();
  });

  it('a corrupt or wrong-version blob is nothing, never a throw', () => {
    expect(parseStoredDrafts('{not json', NOW)).toBeNull();
    expect(parseStoredDrafts(JSON.stringify({ ...entry({}), v: 2 }), NOW)).toBeNull();
    expect(
      parseStoredDrafts(JSON.stringify({ v: 1, savedAt: 'x', rows: {}, ghosts: [] }), NOW),
    ).toBeNull();
    // A draft field with no base to judge it by is dropped.
    expect(
      parseStoredDrafts(
        JSON.stringify(entry({ rows: { A: { draft: { quantity: '4' }, base: {} } } })),
        NOW,
      ),
    ).toBeNull();
    // A forged unit is dropped.
    expect(
      parseStoredDrafts(
        JSON.stringify(
          entry({
            rows: {
              A: { draft: { bazaBasis: 'ton' as never }, base: { bazaUsd: null, bazaBasis: null } },
            },
          }),
        ),
        NOW,
      ),
    ).toBeNull();
  });

  it('serialize keeps dirty ghosts with their id and note, and nothing when nothing is drafted', () => {
    const g = ghost({ clientId: 'C1', name: 'likopcha', note: 'telefon' });
    const out = serializeDrafts(
      { drafts: {}, bases: {}, newRows: [g, ghost({ key: 2 })] },
      new Date(NOW),
    );
    expect(out?.ghosts).toEqual([g]);
    expect(
      serializeDrafts({ drafts: {}, bases: {}, newRows: [ghost({ key: 3 })] }, new Date(NOW)),
    ).toBeNull();
  });
});

describe('planRestore — offered, skipped, or already saved', () => {
  it('a base that still stands → restorable, carrying only what the server lacks', () => {
    const stored = entry({
      rows: { A: { draft: { quantity: '40', note: 'x' }, base: { quantity: 10, note: null } } },
    });
    const plan = planRestore(stored, new Map([['A', item({ id: 'A', note: 'x' })]]), basis);
    expect(plan.rows.A).toEqual({ draft: { quantity: '40' }, base: { quantity: 10 } });
    expect(plan.skipped).toEqual([]);
  });

  it('a base that moved under the draft (server ≠ base and ≠ draft) → skipped and NAMED', () => {
    const stored = entry({ rows: { A: { draft: { quantity: '40' }, base: { quantity: 10 } } } });
    const plan = planRestore(stored, new Map([['A', item({ id: 'A', quantity: 42 })]]), basis);
    expect(plan.rows).toEqual({});
    expect(plan.skipped).toEqual([{ seq: 1, field: 'qty', before: '10', after: '42' }]);
  });

  it('draft 1.125 over base null, server now 1.125 → already saved, never «boshqa kishi»', () => {
    const stored = entry({
      rows: { A: { draft: { bazaValue: '1.125' }, base: { bazaUsd: null, bazaBasis: null } } },
    });
    const plan = planRestore(
      stored,
      new Map([['A', item({ id: 'A', bazaUsd: 1.125, bazaBasis: 'kg' })]]),
      basis,
    );
    expect(plan.alreadySaved).toBe(1);
    expect(plan.skipped).toEqual([]);
    expect(plan.rows).toEqual({});
  });

  it('a row that is gone → dropped', () => {
    const stored = entry({ rows: { Z: { draft: { quantity: '4' }, base: { quantity: 1 } } } });
    expect(planRestore(stored, new Map(), basis).dropped).toBe(1);
  });

  it('a ghost whose id is a row with nothing later → already saved', () => {
    const stored = entry({ ghosts: [ghost({ clientId: 'C', name: 'likopcha', quantity: '5' })] });
    const plan = planRestore(
      stored,
      new Map([['C', item({ id: 'C', label: 'likopcha', quantity: 5 })]]),
      basis,
    );
    expect(plan.alreadySaved).toBe(1);
    expect(plan.ghosts).toEqual([]);
  });

  it('…with a later correction → restorable as that row’s draft carrying the correction', () => {
    const stored = entry({ ghosts: [ghost({ clientId: 'C', name: 'likopcha', quantity: '6' })] });
    const plan = planRestore(
      stored,
      new Map([['C', item({ id: 'C', label: 'likopcha', quantity: 5 })]]),
      basis,
    );
    expect(plan.rows.C).toEqual({ draft: { quantity: '6' }, base: { quantity: 5 } });
    expect(plan.alreadySaved).toBe(0);
  });

  it('otherwise a ghost comes back as it was — SAME id and note', () => {
    const g = ghost({ clientId: 'NEW', name: 'likopcha', note: 'telefon' });
    expect(planRestore(entry({ ghosts: [g] }), new Map(), basis).ghosts).toEqual([g]);
  });
});

describe('mergeForStorage — the write while the question stands', () => {
  const a = { draft: { quantity: '40' }, base: { quantity: 10 } };
  const b = { draft: { note: 'x' }, base: { note: null } };
  it('a live draft on A replaces stored A; untouched stored B is kept; a new live C is added', () => {
    const stored = entry({ rows: { A: a, B: b } });
    const live = entry({
      rows: { A: { draft: { quantity: '41' }, base: { quantity: 10 } }, C: a },
    });
    const out = mergeForStorage(stored, live)!;
    expect(out.rows.A!.draft).toEqual({ quantity: '41' });
    expect(out.rows.B).toEqual(b);
    expect(out.rows.C).toEqual(a);
  });
  it('empty live + stored → stored unchanged', () => {
    const stored = entry({ rows: { A: a } });
    expect(mergeForStorage(stored, null)).toBe(stored);
  });
});

describe('storage that refuses', () => {
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  it('never throws, and the write says it did not land', () => {
    expect(readStored(throwing, 'k')).toBeNull();
    expect(writeStored(throwing, 'k', entry({}))).toBe(false);
    expect(writeStored(null, 'k', entry({}))).toBe(false);
  });
});
