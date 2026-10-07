import { describe, expect, it } from 'vitest';
import {
  changedUnder,
  emptyRow,
  ghostToItemDraft,
  refreshWait,
  REFRESH_WAIT_MS,
  rowDirtyForPicker,
  settleDrafts,
  shouldRefresh,
  syncBase,
  type DraftItem,
  type ItemDraft,
  type NewRow,
  type PendingClear,
  type RowBase,
  type SettleInput,
} from '@/modules/wms/calc/row-draft';
import { aiClaimLive } from '@/modules/wms/calc/workspace';

/**
 * The phone round's draft rules (his B2 a, B5 a, B6 a), as pure functions.
 *
 * The headline is `settleDrafts`: a save settles exactly what it POSTED, by
 * object identity, at the revision the server says it committed — the grid's
 * old «wipe every draft once the rev moves» deletes every OTHER unsaved row
 * the moment a one-row phone save lands.
 */

const item = (over: Partial<DraftItem> & { id: string }): DraftItem => ({
  seq: 1,
  label: 'kafel',
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

const base = (over: Partial<SettleInput>): SettleInput => ({
  drafts: {},
  bases: {},
  newRows: [],
  pending: [],
  items: new Map(),
  workspaceRev: 0,
  keepGhostKey: null,
  sheetItemId: null,
  ...over,
});

const entry = (over: Partial<PendingClear>): PendingClear => ({
  rev: 6,
  revAtPress: 5,
  drafts: new Map(),
  ghosts: new Map(),
  atPress: {},
  ...over,
});

describe('settleDrafts — a save settles what it posted', () => {
  const a = item({ id: 'A', quantity: 40 });
  const b = item({ id: 'B', seq: 2, quantity: 10 });
  const items = new Map([
    ['A', a],
    ['B', b],
  ]);

  it('a posted draft still the object posted is removed with its bases; an unposted row keeps its draft', () => {
    const postedA: ItemDraft = { quantity: '40' };
    const draftB: ItemDraft = { quantity: '12' };
    const out = settleDrafts(
      base({
        drafts: { A: postedA, B: draftB },
        bases: { A: { quantity: 10 }, B: { quantity: 10 } },
        items,
        workspaceRev: 6,
        pending: [entry({ drafts: new Map([['A', postedA]]) })],
      }),
    );
    expect(out.changed).toBe(true);
    expect(out.drafts).toEqual({ B: draftB });
    expect(out.bases.A).toBeUndefined();
    expect(out.bases.B).toEqual({ quantity: 10 });
    expect(out.pending).toEqual([]);
  });

  it('a draft typed over during the round trip stays — only the cell that moved', () => {
    const posted: ItemDraft = { quantity: '40', note: 'x' };
    const now: ItemDraft = { quantity: '41', note: 'x' };
    const out = settleDrafts(
      base({
        drafts: { A: now },
        bases: { A: { quantity: 10, note: null } },
        items,
        workspaceRev: 6,
        pending: [entry({ drafts: new Map([['A', posted]]) })],
      }),
    );
    expect(out.drafts).toEqual({ A: { quantity: '41' } });
    // Nothing foreign in between: the moved cell stands on OUR save now.
    expect(out.bases.A).toEqual({ quantity: 40 });
  });

  it('an entry whose rev has not landed changes nothing', () => {
    const posted: ItemDraft = { quantity: '40' };
    const input = base({
      drafts: { A: posted },
      bases: { A: { quantity: 10 } },
      items,
      workspaceRev: 5,
      pending: [entry({ drafts: new Map([['A', posted]]) })],
    });
    const out = settleDrafts(input);
    expect(out.changed).toBe(false);
    expect(out.drafts).toBe(input.drafts);
  });

  it('a posted ghost still the object posted is removed', () => {
    const g = ghost({ key: 3, clientId: 'C', name: 'kosa' });
    const out = settleDrafts(
      base({
        newRows: [g],
        items: new Map([...items, ['C', item({ id: 'C', label: 'kosa', quantity: null })]]),
        workspaceRev: 6,
        pending: [entry({ ghosts: new Map([[3, g]]) })],
      }),
    );
    expect(out.newRows).toEqual([]);
    expect(out.drafts).toEqual({});
  });

  it('a ghost edited in flight becomes a draft of its new row carrying only what moved since the post — no ghost left', () => {
    const posted = ghost({ key: 3, clientId: 'C', name: 'likopcha', quantity: '5' });
    const now = { ...posted, quantity: '6' };
    const c = item({ id: 'C', label: 'likopcha', quantity: 5 });
    const out = settleDrafts(
      base({
        newRows: [now],
        items: new Map([...items, ['C', c]]),
        workspaceRev: 6,
        keepGhostKey: 3,
        pending: [entry({ ghosts: new Map([[3, posted]]) })],
      }),
    );
    expect(out.newRows).toEqual([]);
    expect(out.drafts).toEqual({ C: { quantity: '6' } });
    expect(out.bases.C).toEqual({ quantity: 5 });
    expect(out.retarget).toEqual({ fromKey: 3, toId: 'C', hasDraft: true });
  });

  it('a ghost whose id appeared with no pending entry (a lost answer) → a stored-mode draft of what differs', () => {
    const g = ghost({ key: 4, clientId: 'C', name: 'likopcha', quantity: '6' });
    const c = item({ id: 'C', label: 'likopcha', quantity: 5 });
    const out = settleDrafts(base({ newRows: [g], items: new Map([...items, ['C', c]]), workspaceRev: 9 }));
    expect(out.newRows).toEqual([]);
    expect(out.drafts).toEqual({ C: { quantity: '6' } });
  });

  it('…or is simply removed when nothing differs', () => {
    const g = ghost({ key: 4, clientId: 'C', name: 'likopcha', quantity: '5' });
    const c = item({ id: 'C', label: 'likopcha', quantity: 5 });
    const out = settleDrafts(base({ newRows: [g], items: new Map([...items, ['C', c]]), workspaceRev: 9 }));
    expect(out.newRows).toEqual([]);
    expect(out.drafts).toEqual({});
    expect(out.converted).toBe(1);
  });

  it('after a save, empty ghosts go — except the one an open sheet shows', () => {
    const open = ghost({ key: 7, clientId: 'X' });
    const stray = ghost({ key: 8, clientId: 'Y' });
    const posted: ItemDraft = { quantity: '40' };
    const out = settleDrafts(
      base({
        drafts: { A: posted },
        bases: { A: { quantity: 10 } },
        newRows: [open, stray],
        items,
        workspaceRev: 6,
        keepGhostKey: 7,
        pending: [entry({ drafts: new Map([['A', posted]]) })],
      }),
    );
    expect(out.newRows.map((r) => r.key)).toEqual([7]);
  });

  it('a draft on a row that is gone is pruned, counted, and an open sheet on it is gone', () => {
    const out = settleDrafts(
      base({
        drafts: { Z: { quantity: '3' }, A: { quantity: '41' } },
        bases: { Z: { quantity: 1 }, A: { quantity: 40 } },
        items,
        workspaceRev: 3,
        sheetItemId: 'Z',
      }),
    );
    expect(out.drafts).toEqual({ A: { quantity: '41' } });
    expect(out.pruned).toBe(1);
    expect(out.gone).toBe('Z');
  });

  it('re-base: nothing foreign → the remaining drafts’ bases move to the server', () => {
    const posted: ItemDraft = { quantity: '40' };
    const bMoved = { ...b, bazaUsd: 3 };
    const out = settleDrafts(
      base({
        drafts: { A: posted, B: { quantity: '12' } },
        bases: { A: { quantity: 10 }, B: { quantity: 10, bazaUsd: null } },
        items: new Map([
          ['A', a],
          ['B', { ...bMoved, quantity: 11 }],
        ]),
        workspaceRev: 6,
        pending: [entry({ drafts: new Map([['A', posted]]), atPress: { B: { quantity: 10, bazaUsd: null } } })],
      }),
    );
    expect(out.bases.B).toEqual({ quantity: 11, bazaUsd: 3 });
  });

  it('re-base: a rev past ours in the same refresh → the bases stay', () => {
    const posted: ItemDraft = { quantity: '40' };
    const out = settleDrafts(
      base({
        drafts: { A: posted, B: { quantity: '12' } },
        bases: { A: { quantity: 10 }, B: { quantity: 10 } },
        items: new Map([
          ['A', a],
          ['B', { ...b, quantity: 11 }],
        ]),
        workspaceRev: 7,
        pending: [entry({ drafts: new Map([['A', posted]]), atPress: { B: { quantity: 10 } } })],
      }),
    );
    expect(out.bases.B).toEqual({ quantity: 10 });
  });

  it('re-base: a foreign change already under the base at the press is never swallowed', () => {
    const posted: ItemDraft = { quantity: '40' };
    const out = settleDrafts(
      base({
        drafts: { A: posted, B: { quantity: '12' } },
        bases: { A: { quantity: 10 }, B: { quantity: 10 } },
        items: new Map([
          ['A', a],
          ['B', { ...b, quantity: 11 }],
        ]),
        workspaceRev: 6,
        // The colleague's 11 was already on the screen when we pressed.
        pending: [entry({ drafts: new Map([['A', posted]]), atPress: { B: { quantity: 11 } } })],
      }),
    );
    expect(out.bases.B).toEqual({ quantity: 10 });
  });

  it('a second call over its own answer changes nothing (it settles in one re-render)', () => {
    const posted: ItemDraft = { quantity: '40' };
    const first = settleDrafts(
      base({
        drafts: { A: posted, Z: { quantity: '1' } },
        bases: { A: { quantity: 10 }, Z: { quantity: 2 } },
        newRows: [ghost({ key: 2, clientId: 'C', name: 'x' })],
        items: new Map([...items, ['C', item({ id: 'C', label: 'y' })]]),
        workspaceRev: 6,
        pending: [entry({ drafts: new Map([['A', posted]]) })],
      }),
    );
    const second = settleDrafts(
      base({
        drafts: first.drafts,
        bases: first.bases,
        newRows: first.newRows,
        pending: first.pending,
        items: new Map([...items, ['C', item({ id: 'C', label: 'y' })]]),
        workspaceRev: 6,
      }),
    );
    expect(second.changed).toBe(false);
  });
});

describe('changedUnder — what moved under the drafted fields', () => {
  const stored = item({ id: 'A', quantity: 42, bazaUsd: 2 });

  it('a drafted field that moved is listed with its old and new value', () => {
    expect(changedUnder({ quantity: 40 }, stored)).toEqual([{ field: 'qty', before: '40', after: '42' }]);
  });

  it('a field that is not drafted is not listed, whatever moved under it', () => {
    expect(changedUnder({ note: null }, stored)).toEqual([]);
  });

  it('a base recorded AFTER a colleague’s change is not listed', () => {
    // syncBase records what the field was typed OVER, at the first keystroke.
    const recorded = syncBase(undefined, { quantity: '45' }, stored);
    expect(recorded).toEqual({ quantity: 42 });
    expect(changedUnder(recorded, stored)).toEqual([]);
  });

  it('nothing drafted → nothing to confirm, whatever the rev did', () => {
    expect(changedUnder(undefined, stored)).toEqual([]);
    expect(changedUnder({}, stored)).toEqual([]);
  });

  it('the baza pair stands on both halves', () => {
    const base: RowBase = { bazaUsd: 1, bazaBasis: null };
    expect(changedUnder(base, { ...stored, bazaUsd: 1, bazaBasis: 'kg' })).toEqual([
      { field: 'basis', before: '—', after: 'kg' },
    ]);
  });
});

describe('ghostToItemDraft — stored mode never invents a difference', () => {
  const stored = item({ id: 'C', label: 'kosa', quantity: 5, bazaUsd: 3, bazaBasis: 'kg' });

  it('an empty ghost cell beside a filled stored baza is no difference', () => {
    expect(ghostToItemDraft(ghost({ name: 'kosa', quantity: '5' }), stored, 'stored')).toEqual({});
  });

  it('an untouched «avto» unit beside a stamped one is no difference', () => {
    expect(ghostToItemDraft(ghost({ name: 'kosa', bazaValue: '3', bazaBasis: null }), stored, 'stored')).toEqual({});
  });

  it('«1.125» beside a stored 1.125 is no difference', () => {
    const s = { ...stored, bazaUsd: 1.125 };
    expect(ghostToItemDraft(ghost({ name: 'kosa', bazaValue: '1.125' }), s, 'stored')).toEqual({});
  });

  it('posted mode takes an emptied cell as a clear', () => {
    const posted = ghost({ name: 'kosa', quantity: '5' });
    expect(ghostToItemDraft({ ...posted, quantity: '' }, stored, 'posted', posted)).toEqual({ quantity: '' });
  });
});

describe('shouldRefresh — never while our own write is in flight', () => {
  const probe = { rev: 9, aiRunning: false, closed: false };
  it('in flight → no, whatever the rev', () => {
    expect(shouldRefresh(probe, 1, false, true)).toBe(false);
  });
  it('a rev past what we know → yes', () => {
    expect(shouldRefresh(probe, 8, false, false)).toBe(true);
    expect(shouldRefresh(probe, 9, false, false)).toBe(false);
  });
  it('the AI claim flipped → yes', () => {
    expect(shouldRefresh({ ...probe, aiRunning: true }, 9, false, false)).toBe(true);
  });
  it('a failed probe → no', () => {
    expect(shouldRefresh(null, 0, false, false)).toBe(false);
  });
});

describe('refreshWait — a refresh that never lands is not a lock', () => {
  const started = refreshWait({ state: 'idle' }, { type: 'start', rev: 7, now: 1000 });
  it('idle → awaiting → landed on the rev', () => {
    expect(started).toEqual({ state: 'awaiting', rev: 7, since: 1000 });
    expect(refreshWait(started, { type: 'tick', workspaceRev: 6, now: 2000 })).toBe(started);
    expect(refreshWait(started, { type: 'tick', workspaceRev: 7, now: 2000 })).toEqual({ state: 'landed' });
  });
  it('awaiting → timedOut after eight seconds', () => {
    expect(refreshWait(started, { type: 'tick', workspaceRev: 6, now: 1000 + REFRESH_WAIT_MS })).toEqual({
      state: 'timedOut',
    });
  });
  it('awaiting → timedOut on a rejection', () => {
    expect(refreshWait(started, { type: 'rejected' })).toEqual({ state: 'timedOut' });
  });
});

describe('rowDirtyForPicker — the 📥 waits on a drafted code, count, weight or volume', () => {
  it.each([
    [{ tnvedCode: '6907' }, true],
    [{ quantity: '4' }, true],
    [{ weightKg: '1' }, true],
    [{ volumeM3: '2' }, true],
    [{ bazaValue: '2' }, false],
    [{ note: 'x' }, false],
    [{ name: 'y' }, false],
    [undefined, false],
  ] as [ItemDraft | undefined, boolean][])('%j → %s', (draft, dirty) => {
    expect(rowDirtyForPicker(draft)).toBe(dirty);
  });
});

describe('aiClaimLive — the raw execute hands a timestamptz back as TEXT', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  it('an ISO string a minute old is live; eleven minutes old is not', () => {
    expect(aiClaimLive('2026-10-07T09:59:00Z', now)).toBe(true);
    expect(aiClaimLive('2026-10-07 09:49:00+00', now)).toBe(false);
  });
  it('garbage and null are not live; a Date a minute old is', () => {
    expect(aiClaimLive('garbage', now)).toBe(false);
    expect(aiClaimLive(null, now)).toBe(false);
    expect(aiClaimLive(new Date(now - 60_000), now)).toBe(true);
  });
});
