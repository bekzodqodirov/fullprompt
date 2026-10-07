import type { BazaBasis, MeasureUnit } from './pricing';
import { readNumberCell } from './number-cell';

/**
 * The calculation table's DRAFTS — what a VED has typed and the server has
 * not yet seen — and every rule about when a draft is settled, kept,
 * converted or warned about. Pure (no React, no clock of its own), so each
 * rule is a function a unit test calls (#166) rather than a pattern restated
 * in a component.
 *
 * The phone round (his B1 a … B6 a) made these rules load-bearing. The grid
 * used to wipe EVERY draft and EVERY new row the moment any save's refresh
 * landed — correct while one press posted everything, and a silent loss of
 * work once a phone sheet posts ONE row (B2 a: «a lost connection re-writes
 * at most one item»). So a save now settles exactly what it POSTED, by object
 * identity, at the revision the server says it committed.
 */

/** One existing row's typed-and-unsaved cells, keyed by the item's id. */
export interface ItemDraft {
  name?: string;
  quantity?: string;
  weightKg?: string;
  volumeM3?: string;
  tnvedCode?: string;
  note?: string;
  /** The extended-unit amount — applies only while the row's code asks one. */
  measure?: string;
  bazaValue?: string;
  bazaBasis?: BazaBasis;
  /** Set only by the import picker — the row the price was taken from. Any
   * hand edit of the amount clears it, because a retyped number is the VED's
   * own and must not wear the file's provenance. */
  importRowId?: string;
}

/** A row typed on the screen and not yet in the database (a «ghost»). */
export interface NewRow {
  key: number;
  /** The id this row will carry in the database, minted HERE (phase 0): a
   * save whose answer was lost can be pressed again and the server knows
   * the row it already wrote. Null only where the browser cannot mint one. */
  clientId: string | null;
  name: string;
  quantity: string;
  unit: string;
  weightKg: string;
  volumeM3: string;
  tnvedCode: string;
  measure: string;
  bazaValue: string;
  /** null = «avto» — the VED has not touched the select, so nothing is
   * posted and the server stamps the law's default once the code's block
   * exists (18a). A code keystroke never overwrites a touched pick. */
  bazaBasis: BazaBasis | null;
  /** B1 a lists the note; the server has always taken one on an add. */
  note: string;
  /**
   * The cells as a save POSTED them, while the answer to that save is
   * unknown — null until a save goes out (review PHONE-1).
   *
   * A ghost whose id later turns out to be a stored row (a lost answer, a
   * closed tab) is turned into a draft of that row, and the only honest
   * measure of what the VED typed AFTER the save is a comparison with what
   * the save carried — never with the stored row as it stands now: that row
   * may hold a colleague's correction made after our commit, and «differs
   * from the stored row» would read the correction as the VED's own edit and
   * write the stale cell back over it, unseen.
   *
   * The FIRST unanswered save's cells are kept: when a later press throws too,
   * the server holds either one, and only the first is certain to be older
   * than everything typed since. A refused save never stamps (the server
   * wrote nothing); a confirmed one settles the ghost away.
   */
  posted: PostedCells | null;
}

/** The cells of a new row a save carries — what the stamp records. */
export type PostedCells = Pick<
  NewRow,
  'name' | 'tnvedCode' | 'quantity' | 'weightKg' | 'volumeM3' | 'measure' | 'bazaValue' | 'bazaBasis' | 'note'
>;

export const postedCellsOf = (row: PostedCells): PostedCells => ({
  name: row.name,
  tnvedCode: row.tnvedCode,
  quantity: row.quantity,
  weightKg: row.weightKg,
  volumeM3: row.volumeM3,
  measure: row.measure,
  bazaValue: row.bazaValue,
  bazaBasis: row.bazaBasis,
  note: row.note,
});

/** A new row's own id. `randomUUID` exists on every secure origin, which is
 * every origin this app is served from; without it the row simply posts no
 * id and behaves as it did before phase 0. */
export const mintClientId = (): string | null =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : null;

export const emptyRow = (key: number): NewRow => ({
  key,
  clientId: mintClientId(),
  name: '',
  quantity: '',
  unit: '',
  weightKg: '',
  volumeM3: '',
  tnvedCode: '',
  measure: '',
  bazaValue: '',
  bazaBasis: null,
  note: '',
  posted: null,
});

/** A ghost with anything typed into it — the only kind a save posts. */
export const ghostDirty = (r: NewRow): boolean =>
  Boolean(
    r.name.trim() ||
    r.tnvedCode.trim() ||
    r.quantity.trim() ||
    r.weightKg.trim() ||
    r.volumeM3.trim() ||
    r.measure.trim() ||
    r.bazaValue.trim() ||
    r.note.trim(),
  );

/** The slice of a STORED row these rules read — WorkspaceItem satisfies it. */
export interface DraftItem {
  id: string;
  seq: number;
  label: string;
  tnvedCode: string | null;
  quantity: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  note: string | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
  bazaUsd: number | null;
  bazaBasis: BazaBasis | null;
}

/* ------------------------------------------------------------------ */
/* Bases — what a draft field was typed OVER                            */
/* ------------------------------------------------------------------ */

export type BaseField =
  | 'label'
  | 'tnvedCode'
  | 'quantity'
  | 'weightKg'
  | 'volumeM3'
  | 'note'
  | 'measureUnit'
  | 'measureQty'
  | 'bazaUsd'
  | 'bazaBasis';

export const ALL_BASE_FIELDS: readonly BaseField[] = [
  'label',
  'tnvedCode',
  'quantity',
  'weightKg',
  'volumeM3',
  'note',
  'measureUnit',
  'measureQty',
  'bazaUsd',
  'bazaBasis',
];

/**
 * The server value each draft field was typed over, PER FIELD (B6 a).
 *
 * A base taken for the whole row at the first keystroke would warn about a
 * colleague's baza change the VED had already seen before typing his own
 * quantity; recorded per field when THAT field is first drafted, it warns
 * about exactly what changed under what he typed.
 */
export type RowBase = Partial<{
  label: string;
  tnvedCode: string | null;
  quantity: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  note: string | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
  bazaUsd: number | null;
  bazaBasis: BazaBasis | null;
}>;

/** Which stored values one draft field stands on. The baza pair is one edit
 * (baza-draft.ts) and stands on both halves; the provenance has no base — a
 * picked row's price is re-read from the file by the server. */
export function baseFieldsFor(field: keyof ItemDraft): BaseField[] {
  switch (field) {
    case 'name':
      return ['label'];
    case 'measure':
      return ['measureUnit', 'measureQty'];
    case 'bazaValue':
    case 'bazaBasis':
      return ['bazaUsd', 'bazaBasis'];
    case 'importRowId':
      return [];
    default:
      return [field];
  }
}

export function baseOf(item: DraftItem, fields: readonly BaseField[]): RowBase {
  const out: RowBase = {};
  for (const f of fields) (out as Record<string, unknown>)[f] = item[f];
  return out;
}

/** The base fields a draft needs right now. */
function neededBaseFields(draft: ItemDraft | undefined): Set<BaseField> {
  const out = new Set<BaseField>();
  if (!draft) return out;
  for (const key of Object.keys(draft) as (keyof ItemDraft)[]) {
    for (const f of baseFieldsFor(key)) out.add(f);
  }
  return out;
}

/**
 * Keep a row's bases in step with its draft: a field drafted for the first
 * time records what it was typed over (`??=` — idempotent, so StrictMode's
 * double updater cannot move it), a field no longer drafted forgets its base.
 * Returns the SAME object when nothing moved, so a memo'd card does not
 * re-render for a neighbour's keystroke.
 */
export function syncBase(
  base: RowBase | undefined,
  draft: ItemDraft | undefined,
  item: DraftItem,
): RowBase | undefined {
  const needed = neededBaseFields(draft);
  if (needed.size === 0) return undefined;
  const current = base ?? {};
  let moved = Object.keys(current).some((k) => !needed.has(k as BaseField));
  const next: RowBase = {};
  for (const f of needed) {
    if (f in current)
      (next as Record<string, unknown>)[f] = (current as Record<string, unknown>)[f];
    else {
      (next as Record<string, unknown>)[f] = item[f];
      moved = true;
    }
  }
  return moved || base === undefined ? next : base;
}

/** The word a change is listed under — the sheet maps it to a literal key. */
export type ChangeField =
  'name' | 'code' | 'qty' | 'kg' | 'm3' | 'note' | 'measure' | 'baza' | 'basis';

export interface FieldChange {
  field: ChangeField;
  before: string;
  after: string;
}

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
const sameText = (a: unknown, b: unknown) =>
  (a ?? '').toString().trim() === (b ?? '').toString().trim();

/**
 * What changed on the server UNDER the fields this row has drafted (B6 a):
 * every recorded base field whose stored value moved since the VED typed
 * over it. `fields` narrows it (the delete's look compares a whole-row
 * snapshot taken at sheet open). Never a lock — the caller decides what one
 * more look costs.
 */
export function changedUnder(
  bases: RowBase | undefined,
  item: DraftItem,
  fields?: readonly BaseField[],
): FieldChange[] {
  if (!bases) return [];
  const has = (f: BaseField) => f in bases && (!fields || fields.includes(f));
  const out: FieldChange[] = [];
  const text = (f: BaseField, field: ChangeField) => {
    if (has(f) && !sameText(bases[f], item[f]))
      out.push({ field, before: show(bases[f]), after: show(item[f]) });
  };
  const num = (f: 'quantity' | 'weightKg' | 'volumeM3' | 'bazaUsd', field: ChangeField) => {
    if (has(f) && (bases[f] ?? null) !== (item[f] ?? null)) {
      out.push({ field, before: show(bases[f]), after: show(item[f]) });
    }
  };
  text('label', 'name');
  text('tnvedCode', 'code');
  num('quantity', 'qty');
  num('weightKg', 'kg');
  num('volumeM3', 'm3');
  if (
    (has('measureQty') && (bases.measureQty ?? null) !== (item.measureQty ?? null)) ||
    (has('measureUnit') && (bases.measureUnit ?? null) !== (item.measureUnit ?? null))
  ) {
    const was = `${show(bases.measureQty)}${bases.measureUnit ? ` ${bases.measureUnit}` : ''}`;
    const now = `${show(item.measureQty)}${item.measureUnit ? ` ${item.measureUnit}` : ''}`;
    out.push({ field: 'measure', before: was, after: now });
  }
  num('bazaUsd', 'baza');
  if (has('bazaBasis') && (bases.bazaBasis ?? null) !== (item.bazaBasis ?? null)) {
    out.push({ field: 'basis', before: show(bases.bazaBasis), after: show(item.bazaBasis) });
  }
  text('note', 'note');
  return out;
}

/** A stable signature of a change list — «what the VED was shown». */
export const changeSignature = (changes: FieldChange[]): string =>
  changes.map((c) => `${c.field}:${c.before}>${c.after}`).join('|');

/* ------------------------------------------------------------------ */
/* Equality of a typed cell with a stored value                         */
/* ------------------------------------------------------------------ */

/** The live figure must equal the SAVED figure to the cent — postgres rounds
 * to the column scale on write, so a comparison quantizes the same way. */
export const q3 = (v: number) => Math.round(v * 1000) / 1000;
export const q4 = (v: number) => Math.round(v * 10000) / 10000;

/** Does a typed number mean the stored one? Empty means null; an ambiguous
 * or bad cell means nothing stored can equal it. */
export function sameNumber(
  raw: string,
  stored: number | null,
  scale: (v: number) => number,
): boolean {
  const cell = readNumberCell(raw);
  if (cell.state === 'empty') return stored === null;
  if (cell.state !== 'ok') return false;
  return stored !== null && scale(cell.value) === scale(stored);
}

/* ------------------------------------------------------------------ */
/* A ghost that the server already holds                               */
/* ------------------------------------------------------------------ */

/**
 * A new row whose client id is now a STORED row is never kept as a ghost
 * (the judge's #1): retried, the server turns it into an edit posting EVERY
 * cell that differs from the stored row (workspace.ts's retry-as-edit), so a
 * ghost whose values are older than a later correction would write its stale
 * cells back over it. It becomes a draft of that item carrying only what the
 * VED typed AFTER the save — a cell that differs from what was POSTED (an
 * emptied one included: emptying a typed cell is a clear) and from what the
 * row holds now.
 *
 * Measured against the POST and never against the stored row (review
 * PHONE-1): «differs from the stored row» reads a colleague's correction
 * made after our commit as the VED's own edit — the ghost's 5 against the
 * colleague's 0.5 became a draft of 5 standing on 0.5, i.e. a revert with no
 * warning. A ghost that carries no stamp went out as it stands (the stamp is
 * written with the press), so `posted` is then the ghost itself and nothing
 * differs.
 */
export function ghostToItemDraft(ghost: NewRow, item: DraftItem, posted: PostedCells): ItemDraft {
  const out: ItemDraft = {};
  const typedSince = (field: keyof PostedCells) => ghost[field] !== posted[field];

  if (typedSince('name') && ghost.name.trim() !== '' && ghost.name.trim() !== item.label.trim())
    out.name = ghost.name;
  if (typedSince('tnvedCode') && ghost.tnvedCode.trim() !== (item.tnvedCode ?? ''))
    out.tnvedCode = ghost.tnvedCode;
  for (const f of ['quantity', 'weightKg', 'volumeM3'] as const) {
    if (typedSince(f) && !sameNumber(ghost[f], item[f], q3)) out[f] = ghost[f];
  }
  if (typedSince('measure') && !sameNumber(ghost.measure, item.measureQty, q4))
    out.measure = ghost.measure;
  if (typedSince('note') && ghost.note.trim() !== (item.note ?? '')) out.note = ghost.note;

  // The baza pair drafts together (baza-draft.ts): an amount always rides
  // beside a drafted unit, so the save posts a coherent pair. An amount not
  // retyped since the post is the row's own (the server may have filled an
  // empty one from the memory or the file) — never a clear nobody typed.
  const valueMoved = typedSince('bazaValue') && !sameNumber(ghost.bazaValue, item.bazaUsd, q4);
  const basisMoved =
    ghost.bazaBasis !== null && typedSince('bazaBasis') && ghost.bazaBasis !== item.bazaBasis;
  if (valueMoved || basisMoved) {
    out.bazaValue = typedSince('bazaValue')
      ? ghost.bazaValue
      : item.bazaUsd === null
        ? ''
        : String(item.bazaUsd);
    if (ghost.bazaBasis !== null) out.bazaBasis = ghost.bazaBasis;
  }
  return out;
}

/**
 * What a converted ghost's cells were typed OVER — the stored value our own
 * save would have left, per field (review PHONE-1). A cell the save carried
 * stands on what it carried, so a colleague's later change under it reads as
 * a change (the B6 line, or «tiklanmadi» on a restore). An EMPTY baza or
 * code, the «avto» unit and the measure stand on the row as it is: the server
 * fills those itself (the memory and the file fill an empty baza, the TNVED
 * memory an empty code, the measure pass stamps the unit and drops a measure
 * the law does not take) — its own fill is nobody's change. An empty count,
 * weight, volume or note it never fills, so those stand on the empty the save
 * carried, and a colleague's figure typed into one is named.
 */
export function postedBase(
  posted: PostedCells,
  item: DraftItem,
  fields: Iterable<BaseField>,
): RowBase {
  const num = (raw: string, scale: (v: number) => number): number | null => {
    const cell = readNumberCell(raw);
    return cell.state === 'ok' ? scale(cell.value) : null;
  };
  const out: RowBase = {};
  const put = <F extends BaseField>(f: F, v: RowBase[F]) => {
    (out as Record<string, unknown>)[f] = v;
  };
  for (const f of fields) {
    switch (f) {
      case 'label':
        put(f, posted.name.trim() || item.label);
        break;
      case 'tnvedCode':
        put(f, posted.tnvedCode.trim() || item.tnvedCode);
        break;
      case 'quantity':
      case 'weightKg':
      case 'volumeM3':
        put(f, num(posted[f], q3));
        break;
      case 'note':
        put(f, posted.note.trim() || null);
        break;
      case 'measureUnit':
        put(f, item.measureUnit);
        break;
      case 'measureQty':
        put(
          f,
          posted.measure.trim() === '' || item.measureUnit === null
            ? item.measureQty
            : num(posted.measure, q4),
        );
        break;
      case 'bazaUsd':
        put(f, posted.bazaValue.trim() === '' ? item.bazaUsd : num(posted.bazaValue, q4));
        break;
      case 'bazaBasis':
        put(f, posted.bazaBasis ?? item.bazaBasis);
        break;
    }
  }
  return out;
}

/**
 * What the screen SHOWED under a draft's cells at the press — the stored
 * values of exactly the fields the draft stands on. The phone posts it with
 * its one row (review PHONE-2), and the server refuses `changed_under` when
 * the row moved since: the press's own look sees what landed before its
 * probe, and this closes the round trip after it.
 */
export function expectFor(item: DraftItem, draft: ItemDraft): RowBase {
  return baseOf(item, [...neededBaseFields(draft)]);
}

/* ------------------------------------------------------------------ */
/* Settling a save                                                     */
/* ------------------------------------------------------------------ */

/** What one successful save posted, and the revision it committed at. */
export interface PendingClear {
  /** The server's own rev after the save (saveTable bumps it exactly once). */
  rev: number;
  /** `workspace.rev` when the press began. */
  revAtPress: number;
  /** The EXACT draft objects posted, by item id. */
  drafts: Map<string, ItemDraft>;
  /** The EXACT ghost objects posted, by key. */
  ghosts: Map<number, NewRow>;
  /** The other drafted rows' stored values at the press — the re-base may
   * move a base only where nothing foreign stood under it already. */
  atPress: Record<string, RowBase>;
}

export interface SettleInput {
  drafts: Record<string, ItemDraft>;
  bases: Record<string, RowBase>;
  newRows: NewRow[];
  pending: PendingClear[];
  items: Map<string, DraftItem>;
  workspaceRev: number;
  /** The ghost an open sheet shows — never dropped from under it. */
  keepGhostKey: number | null;
  /** The item an open sheet shows — reported `gone` when pruned. */
  sheetItemId: string | null;
}

export interface SettleOutput {
  changed: boolean;
  drafts: Record<string, ItemDraft>;
  bases: Record<string, RowBase>;
  newRows: NewRow[];
  pending: PendingClear[];
  /** Ghosts turned into item drafts (or removed, nothing differing). */
  converted: number;
  /** Drafts dropped because their row is gone (a colleague's delete). */
  pruned: number;
  /** …and which — the screen does not blame «boshqa kishi» for its own. */
  prunedIds: string[];
  /** The open ghost sheet's goods are now a saved row. */
  retarget: { fromKey: number; toId: string; hasDraft: boolean } | null;
  /** The open item sheet's row is gone. */
  gone: string | null;
}

const sameBase = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * Settle drafts against the refreshed workspace — ONE pure helper, called at
 * render time by the table, so the frame that brings the new rev never paints
 * once with stale drafts. Rules, in order:
 *
 *  1. Each pending save whose rev has LANDED (`workspaceRev >= rev` — a
 *     probe-driven refresh can land a colleague's rev first, and a refresh
 *     that already includes our save must still clear) settles what it
 *     posted: a draft that is still the very object posted is gone with its
 *     bases; one typed over during the round trip keeps only the cells that
 *     moved since the post; a posted ghost that is still the object posted
 *     is gone, one edited in flight becomes a draft of its new row carrying
 *     what moved since the post. Then the remaining drafts' bases are
 *     RE-BASED to the server —
 *     only when nothing foreign can have interleaved (`rev === revAtPress+1`
 *     and `workspaceRev === rev`, since saveTable bumps exactly once), and
 *     only where nothing foreign already stood under the base at the press —
 *     so our own save's fills never read as «boshqa kishi o'zgartirdi».
 *  2. A ghost whose client id is a stored row is converted: what was typed
 *     since its first unanswered post, standing on that post (PHONE-1).
 *  3. Drafts whose row is gone are PRUNED — a colleague's delete must
 *     release the dirty gate, never wedge it.
 *  4. When a save settled, empty ghosts go (today's post-save tidy) — except
 *     the one an open sheet shows.
 */
export function settleDrafts(input: SettleInput): SettleOutput {
  const { items, workspaceRev, keepGhostKey, sheetItemId } = input;
  let drafts = input.drafts;
  let bases = input.bases;
  let newRows = input.newRows;
  let changed = false;
  let converted = 0;
  let pruned = 0;
  const prunedIds: string[] = [];
  let retarget: SettleOutput['retarget'] = null;
  let gone: string | null = null;

  const editDrafts = () => {
    if (drafts === input.drafts) drafts = { ...drafts };
    if (bases === input.bases) bases = { ...bases };
    changed = true;
  };
  const editRows = () => {
    if (newRows === input.newRows) newRows = [...newRows];
    changed = true;
  };
  const putDraft = (id: string, draft: ItemDraft, base: RowBase | undefined) => {
    editDrafts();
    if (Object.keys(draft).length === 0) {
      delete drafts[id];
      delete bases[id];
    } else {
      drafts[id] = draft;
      if (base) bases[id] = base;
      else delete bases[id];
    }
  };
  /** A converted ghost joins any draft its row already has — that one wins
   * per field, bases included — and what it adds stands on `standOn`: what
   * the save carried, or the stored row when nothing foreign can have
   * interleaved (review PHONE-1). */
  const adopt = (ghost: NewRow, item: DraftItem, from: ItemDraft, standOn: RowBase) => {
    const existing = drafts[item.id];
    const merged: ItemDraft = { ...from, ...(existing ?? {}) };
    putDraft(item.id, merged, syncBase({ ...standOn, ...(bases[item.id] ?? {}) }, merged, item));
    converted += 1;
    if (keepGhostKey === ghost.key) {
      retarget = { fromKey: ghost.key, toId: item.id, hasDraft: Object.keys(merged).length > 0 };
    }
  };

  // 1. Landed saves.
  const settling = input.pending.filter((p) => workspaceRev >= p.rev);
  const pending =
    settling.length === 0 ? input.pending : input.pending.filter((p) => workspaceRev < p.rev);
  if (settling.length > 0) changed = true;
  for (const entry of settling) {
    // saveTable bumps the clock exactly once, so any rev past ours — before
    // the press or inside this refresh — is somebody else's.
    const rebaseOk = entry.rev === entry.revAtPress + 1 && workspaceRev === entry.rev;
    for (const [id, posted] of entry.drafts) {
      const current = drafts[id];
      if (current === undefined) continue;
      const item = items.get(id);
      if (current === posted || !item) {
        editDrafts();
        delete drafts[id];
        delete bases[id];
        continue;
      }
      // Typed over during the round trip: what still equals the post is
      // saved now; what moved is the next save's.
      const kept: ItemDraft = { ...current };
      const pair = ['bazaValue', 'bazaBasis', 'importRowId'] as const;
      const pairSame = pair.every((k) => current[k] === posted[k]);
      for (const key of Object.keys(posted) as (keyof ItemDraft)[]) {
        if ((pair as readonly string[]).includes(key)) continue;
        if (current[key] === posted[key]) delete kept[key];
      }
      if (pairSame && pair.some((k) => posted[k] !== undefined))
        for (const k of pair) delete kept[k];
      let base = syncBase(bases[id], kept, item);
      // A cell posted and then typed over again stands on OUR save now: with
      // nothing foreign in between, its base is what the server holds, or
      // our own write would read as «boshqa kishi» on the next look.
      if (base && rebaseOk) {
        for (const key of Object.keys(kept) as (keyof ItemDraft)[]) {
          if (!(key in posted)) continue;
          for (const f of baseFieldsFor(key)) {
            if (base === bases[id]) base = { ...base };
            (base as Record<string, unknown>)[f] = item[f];
          }
        }
      }
      putDraft(id, kept, base);
    }
    for (const [key, posted] of entry.ghosts) {
      const index = newRows.findIndex((r) => r.key === key);
      if (index === -1) continue;
      const ghost = newRows[index]!;
      const item = ghost.clientId !== null ? items.get(ghost.clientId) : undefined;
      if (ghost === posted || ghost.clientId === null) {
        editRows();
        newRows.splice(newRows.indexOf(ghost), 1);
        continue;
      }
      if (!item) continue;
      editRows();
      newRows.splice(newRows.indexOf(ghost), 1);
      // Edited in flight: what moved since THIS post is the next save's. It
      // stands on our own commit when nothing foreign can have interleaved,
      // else on what was posted — a colleague's change after our commit is
      // then named (B6), never swallowed into the base.
      const from = ghostToItemDraft(ghost, item, posted);
      const fields = [...neededBaseFields(from)];
      adopt(ghost, item, from, rebaseOk ? baseOf(item, fields) : postedBase(posted, item, fields));
    }
    if (rebaseOk) {
      for (const id of Object.keys(drafts)) {
        if (entry.drafts.has(id)) continue;
        const item = items.get(id);
        const base = bases[id];
        const before = entry.atPress[id];
        if (!item || !base || !before) continue;
        let next: RowBase | null = null;
        for (const f of Object.keys(base) as BaseField[]) {
          // Something foreign already stood under this field at the press —
          // the VED is owed that warning; never swallow it here.
          if (!(f in before) || !sameBase(before[f], base[f])) continue;
          if (sameBase(item[f], base[f])) continue;
          next ??= { ...base };
          (next as Record<string, unknown>)[f] = item[f];
        }
        if (next) {
          editDrafts();
          bases[id] = next;
        }
      }
    }
  }

  // 2. A ghost the server already holds (a lost answer): only what was typed
  //    since its first unanswered post is a draft, standing on that post.
  for (const ghost of [...newRows]) {
    if (ghost.clientId === null) continue;
    const item = items.get(ghost.clientId);
    if (!item) continue;
    editRows();
    newRows.splice(newRows.indexOf(ghost), 1);
    const stamp = ghost.posted ?? ghost;
    const from = ghostToItemDraft(ghost, item, stamp);
    adopt(ghost, item, from, postedBase(stamp, item, neededBaseFields(from)));
  }

  // 3. Drafts on rows that are gone.
  for (const id of Object.keys(drafts)) {
    if (items.has(id)) continue;
    editDrafts();
    delete drafts[id];
    delete bases[id];
    pruned += 1;
    prunedIds.push(id);
    if (sheetItemId === id) gone = id;
  }
  for (const id of Object.keys(bases)) {
    if (id in drafts) continue;
    editDrafts();
    delete bases[id];
  }

  // 4. The post-save tidy.
  if (settling.length > 0 && newRows.some((r) => !ghostDirty(r) && r.key !== keepGhostKey)) {
    editRows();
    newRows = newRows.filter((r) => ghostDirty(r) || r.key === keepGhostKey);
  }

  return { changed, drafts, bases, newRows, pending, converted, pruned, prunedIds, retarget, gone };
}

/* ------------------------------------------------------------------ */
/* Small rules the screens share                                       */
/* ------------------------------------------------------------------ */

/**
 * The 📥 waits on a row whose code, count, weight or volume is drafted
 * (analytics' rule, #1299): both import routes read those off the SAVED row,
 * so the list, the unit tabs and the ±25 % band would describe the old row —
 * and a pick against a new code fails at save with `import_row_missing`.
 * ONE helper, asked by the desktop ⋯ fold and the phone sheet.
 */
export function rowDirtyForPicker(draft: ItemDraft | undefined): boolean {
  return (['tnvedCode', 'quantity', 'weightKg', 'volumeM3'] as const).some(
    (k) => draft?.[k] !== undefined,
  );
}

/** What the clock probe answers (`/api/calc/rev/[id]`). */
export interface ClockProbe {
  rev: number;
  aiRunning: boolean;
  closed: boolean;
}

/**
 * Should a probe's answer refresh the page? Never while one of OUR writes
 * is awaiting its answer: the probe can see our own commit before the answer
 * arrives, and a refresh issued mid-action is how Next discards it (#1242).
 */
export function shouldRefresh(
  probe: ClockProbe | null,
  knownRev: number,
  aiRunningNow: boolean,
  inFlight: boolean,
): boolean {
  if (inFlight || probe === null) return false;
  return probe.rev > knownRev || probe.aiRunning !== aiRunningNow || probe.closed;
}

/** How long a press waits for the refresh it asked for. */
export const REFRESH_WAIT_MS = 8_000;

export type RefreshWait =
  | { state: 'idle' }
  | { state: 'awaiting'; rev: number; since: number }
  | { state: 'landed' }
  | { state: 'timedOut' };

export type RefreshEvent =
  | { type: 'start'; rev: number; now: number }
  | { type: 'tick'; workspaceRev: number; now: number }
  | { type: 'rejected' }
  | { type: 'reset' };

/**
 * The press's wait for a refresh to land — a small state machine so that a
 * refresh which never lands cannot become a lock: `landed` once the screen's
 * rev reaches the probe's, `timedOut` after eight seconds or on a refusal.
 */
export function refreshWait(state: RefreshWait, event: RefreshEvent): RefreshWait {
  switch (event.type) {
    case 'reset':
      return { state: 'idle' };
    case 'start':
      return { state: 'awaiting', rev: event.rev, since: event.now };
    case 'rejected':
      return state.state === 'awaiting' ? { state: 'timedOut' } : state;
    case 'tick':
      if (state.state !== 'awaiting') return state;
      if (event.workspaceRev >= state.rev) return { state: 'landed' };
      if (event.now - state.since >= REFRESH_WAIT_MS) return { state: 'timedOut' };
      return state;
  }
}
