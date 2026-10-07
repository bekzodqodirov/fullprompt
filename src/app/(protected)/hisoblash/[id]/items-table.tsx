'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Workspace, WorkspaceGroup, WorkspaceItem } from '@/modules/wms/calc/workspace';
import type { TableItemEdit, TableNewItem } from '@/modules/wms/calc/workspace';
import {
  customsFor,
  pricedGroupOf,
  requestCustomsFor,
  totalsFor,
  type BazaBasis,
  type CustomsResult,
  type MeasureUnit,
  type PricedItem,
} from '@/modules/wms/calc/pricing';
import { basisLabel, defaultBasisFor, uniformBazaOf } from '@/modules/wms/calc/basis';
import { editBazaPair } from '@/modules/wms/calc/baza-draft';
import { pasteIdsFor } from '@/modules/wms/calc/paste-ids';
import { basisNotLaw } from '@/modules/wms/calc/warnings';
import { ghostScreenOf, screenRowOf, groupsByCodeOf, postedBasis } from '@/modules/wms/calc/screen-row';
import { readNumberCell } from '@/modules/wms/calc/number-cell';
import {
  ALL_BASE_FIELDS,
  baseOf,
  changedUnder,
  changeSignature,
  emptyRow,
  expectFor,
  ghostDirty,
  mintClientId,
  postedCellsOf,
  q3,
  q4,
  refreshWait,
  REFRESH_WAIT_MS,
  rowDirtyForPicker,
  settleDrafts,
  shouldRefresh,
  syncBase,
  type BaseField,
  type ClockProbe,
  type FieldChange,
  type ItemDraft,
  type NewRow,
  type PendingClear,
  type PostedCells,
  type RowBase,
} from '@/modules/wms/calc/row-draft';
import {
  draftStorageKey,
  mergeForStorage,
  parseStoredDrafts,
  planRestore,
  readStored,
  restorableCount,
  serializeDrafts,
  writeStored,
  type RestorePlan,
  type StoredDrafts,
} from '@/modules/wms/calc/draft-store';
import { parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import { isBuildStale, reloadFresh } from '@/components/build-check';
import {
  confirmAllAction,
  confirmGroupAction,
  deleteItemAction,
  proposeAction,
  pullBazasAction,
  pullRatesAction,
  saveRatesAction,
  saveTableAction,
  setCertificateAction,
  setRatesAction,
  type CalcFormState,
  type TableFormState,
} from '../actions';
import { dutyText } from '@/modules/wms/calc/duty-text';
import { ImportBazaDialog, type PickerTarget } from './import-baza-dialog';
import { BasisSelect } from './basis-select';
import { PhoneBlocks } from './phone-blocks';
import { RowSheet, type SheetField, type SheetFigure, type SheetModel, type SheetNumField } from './row-sheet';
import { DraftRestore } from './draft-restore';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * The Excel-table workspace (VED 2.0 phase 3) — the owner's own columns:
 * «tovar nomi, tnved kodi, olchov birligi, bazasi … yonida rastamojka
 * summasi chiqadigan».
 *
 * A group is INVISIBLE now: the VED types a code on the row and the rows
 * sharing it render as one declaration BLOCK whose footer line carries the
 * law (grey = the dictionary's word, black = typed), the value, the LIVE
 * customs figure and the ✅ — recomputed in the browser per keystroke by the
 * SAME pure engine the seal runs, so the two cannot disagree. The baza is
 * PER ROW (the owner's 1a: differently-priced goods are different rows), and
 * a code that prices per juft/litr/m²/sm³ grows the row an O'lchov line.
 *
 * Two RENDERS of one state since the phone round (his B1 a … B6 a): the grid
 * from `md` up, and below it cards that open one row's SHEET, saved on its
 * own (B2 a). Both write the same drafts through the same setters and post
 * through the same builders and the same one sender — the 0125 one-chain law
 * (screenRowOf / postedBasis, #886's live-equals-saved) holds only while the
 * phone has no second copy of it.
 *
 * The dirty law stands: while anything is unsaved — or waiting to be
 * restored — every OTHER mutating control (✅, confirm-all, propose,
 * pull-bazas, certificate — and the seal, gated in SealPanel) is off,
 * replaced by «Avval saqlang». Drafts are keyed by the item's immutable ID,
 * settle per POSTED row at the server's own rev (row-draft.ts), survive a
 * closed tab (draft-store.ts, B5 a), and die with their row on a delete.
 */

const CODE_SHAPE = /^\d{4,10}$/;
const NUM_COLS = ['quantity', 'weightKg', 'volumeM3'] as const;
/** How often an open sheet asks whether somebody wrote under it (B6 a). */
const POLL_MS = 15_000;

/** A refusal before or after the wire, naming the row — and for the
 * ambiguity question, the cell and its two readings. */
interface TableRefusal {
  code: string;
  seq?: number;
  field?: SheetNumField;
  decimalText?: string;
  thousandsText?: string;
  itemId?: string;
  ghostKey?: number;
}

interface LastSave {
  minted: string[];
  swept: number;
  merged: string[];
  measuresCleared: number[];
  measuresDropped: number[];
  basisSuspect: number[];
  basisConflict: number[];
  alreadySaved: number;
  importFilled: number[];
  memoryFilled: number[];
}
const EMPTY_SAVE: LastSave = {
  minted: [],
  swept: 0,
  merged: [],
  measuresCleared: [],
  measuresDropped: [],
  basisSuspect: [],
  basisConflict: [],
  alreadySaved: 0,
  importFilled: [],
  memoryFilled: [],
};

type SheetTarget = { kind: 'item'; id: string } | { kind: 'ghost'; key: number };
const sheetKeyOf = (s: SheetTarget | null) => (s === null ? null : s.kind === 'item' ? `item:${s.id}` : `ghost:${s.key}`);

interface Maps {
  itemById: Map<string, WorkspaceItem>;
  groupById: Map<string, WorkspaceGroup>;
  groupsByCode: Map<string, WorkspaceGroup>;
}

/** One typed cell, read by the ONE reader (number-cell.ts): a number, an
 * empty cell, or a refusal naming the row and the cell. */
function readCell(raw: string, seq: number, field: SheetNumField): { value: number | null } | { refusal: TableRefusal } {
  const cell = readNumberCell(raw);
  if (cell.state === 'empty') return { value: null };
  if (cell.state === 'ok') return { value: cell.value };
  if (cell.state === 'ambiguous') {
    return {
      refusal: {
        code: 'ambiguous_number',
        seq,
        field,
        decimalText: cell.decimalText,
        thousandsText: cell.thousandsText,
      },
    };
  }
  return { refusal: { code: 'bad_number', seq, field } };
}

/** What the cell SHOWS when nothing is drafted — the self-clean compares
 * against this, never a bare default (#171). `draft` is the row's current
 * draft, because the unit and the measure the screen shows depend on a
 * drafted CODE (the law it lands under). */
function serverValueOf(
  item: WorkspaceItem,
  field: keyof ItemDraft,
  draft: ItemDraft | undefined,
  groupById: Map<string, WorkspaceGroup>,
  groupsByCode: Map<string, WorkspaceGroup>,
): string {
  switch (field) {
    case 'name':
      return item.label;
    case 'tnvedCode':
      return item.tnvedCode ?? '';
    case 'note':
      return item.note ?? '';
    case 'measure': {
      const { pair } = screenRowOf(item, draft, groupById, groupsByCode);
      return pair !== null && (pair === 'any' || item.measureUnit === pair) && item.measureQty !== null
        ? String(item.measureQty)
        : '';
    }
    case 'bazaValue':
      return item.bazaUsd === null ? '' : String(item.bazaUsd);
    case 'bazaBasis': {
      // The unit as it stands without a basis draft — '' while «avto».
      const shown = screenRowOf(item, { ...draft, bazaBasis: undefined }, groupById, groupsByCode).basis;
      return shown ?? '';
    }
    default:
      return String(item[field] ?? '');
  }
}

/** A ghost row as the engine prices it — what THIS row's save would store:
 * the basis «avto» resolves to the block's default, and the measure counts
 * only in a unit the server keeps (the generic box of an unknown law prices
 * nothing until the save says what unit it is). */
function liveGhostItem(row: NewRow, lawGroup: WorkspaceGroup | null, groupsByCode: Map<string, WorkspaceGroup>): PricedItem {
  const num = (raw: string, scale: (v: number) => number) => {
    const cell = readNumberCell(raw);
    return cell.state === 'ok' ? scale(cell.value) : null;
  };
  const bazaUsd = num(row.bazaValue, q4);
  const pair = ghostScreenOf(row, groupsByCode).pair;
  const measureQty = pair !== null && pair !== 'any' ? num(row.measure, q4) : null;
  return {
    seq: -1,
    label: row.name,
    quantity: num(row.quantity, q3),
    weightKg: num(row.weightKg, q3),
    volumeM3: num(row.volumeM3, q3),
    bazaUsd,
    bazaBasis: bazaUsd === null ? null : (row.bazaBasis ?? defaultBasisFor(lawGroup)),
    measureUnit: measureQty === null ? null : (pair as MeasureUnit),
    measureQty,
  };
}

/** The clock probe (`/api/calc/rev/[id]`) — null on any failure, which the
 * callers read as «go on»: a probe that cannot answer must never become a
 * lock. */
async function probeClock(requestId: string): Promise<ClockProbe | null> {
  try {
    const res = await fetch(`/api/calc/rev/${requestId}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ClockProbe>;
    if (typeof data.rev !== 'number') return null;
    return { rev: data.rev, aiRunning: Boolean(data.aiRunning), closed: Boolean(data.closed) };
  } catch {
    return null;
  }
}

/** localStorage, or null where touching it throws (a private window). */
function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const numText = (v: number | null) => (v === null ? '' : String(v));

/** The current state, readable after an `await` — the probe's refresh can
 * convert the very ghost a press began on into a saved row. */
interface Latest extends Maps {
  drafts: Record<string, ItemDraft>;
  bases: Record<string, RowBase>;
  newRows: NewRow[];
  sheet: SheetTarget | null;
  workspaceRev: number;
  waitState: ReturnType<typeof refreshWait>['state'];
}

export function ItemsTable({
  workspace,
  pending,
  act,
  onDirty,
  viewerId,
}: {
  workspace: Workspace;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  onDirty: (n: number) => void;
  /** Whose drafts these are — the stored entry is keyed by the viewer. */
  viewerId: string;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const id = workspace.requestId;

  const [{ drafts, bases }, setDraftState] = useState<{
    drafts: Record<string, ItemDraft>;
    bases: Record<string, RowBase>;
  }>({ drafts: {}, bases: {} });
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  /** What each successful save POSTED, settled once its rev lands (D3). */
  const [pendingClears, setPendingClears] = useState<PendingClear[]>([]);
  const [saving, setSaving] = useState(false);
  const [tableError, setTableError] = useState<TableRefusal | null>(null);
  const [lastSave, setLastSave] = useState<LastSave | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  /** The ids a pasted list's rows carry (phase 0) — kept per LINE across
   * presses, so a second press after a lost answer posts the same ids and
   * the server treats the rows it already wrote as edits instead of doubling
   * five hundred goods — even when the VED fixed a typo in between, which
   * per-TEXT ids turned into a whole second copy (review units-2). */
  const pasteIds = useRef<{ keys: string[]; ids: (string | null)[] }>({ keys: [], ids: [] });
  const newKey = useRef(1);

  /* ---- the phone sheet ---- */
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ key: string | null; fields: SheetNumField[] }>({ key: null, fields: [] });
  const [wait, dispatchWait] = useReducer(refreshWait, { state: 'idle' });
  const [pressing, setPressing] = useState(false);
  /** The rev the sheet was opened at (moved to our own after our save). */
  const [sheetExpectRev, setSheetExpectRev] = useState<number | null>(null);
  /** The whole row as it stood when the sheet opened — the delete's look. */
  const [sheetOpenBase, setSheetOpenBase] = useState<RowBase | null>(null);
  const [deleteWarn, setDeleteWarn] = useState<FieldChange[] | null>(null);
  /** Rows WE deleted — a draft pruned with them is not «boshqa kishi». */
  const [ownDeleted, setOwnDeleted] = useState<ReadonlySet<string>>(() => new Set());
  const [prunedCount, setPrunedCount] = useState(0);
  const [rowGone, setRowGone] = useState(false);
  const pickerReturn = useRef<SheetTarget | null>(null);
  const inFlight = useRef(false);
  /** The highest rev this screen knows is not news: the workspace's, and
   * every rev our own sends and deletes were answered with. */
  const knownRev = useRef(workspace.rev);
  const landWaiters = useRef<{ rev: number; resolve: (outcome: 'landed' | 'timedOut') => void }[]>([]);

  /* ---- the restore (B5 a) ---- */
  const [restore, setRestore] = useState<RestorePlan | null>(null);
  const storagePhase = useRef<'init' | 'prompt' | 'live'>('init');
  const storedEntry = useRef<StoredDrafts | null>(null);
  const storageOk = useRef<boolean | null>(null);
  const storageKey = draftStorageKey(viewerId, id);

  /** ONE dialog for the whole table, not one per row (#684). */
  const [picker, setPicker] = useState<PickerTarget | null>(null);

  const allItems = useMemo(
    () => [...workspace.ungrouped, ...workspace.groups.flatMap((g) => g.items)].sort((a, b) => a.seq - b.seq),
    [workspace],
  );
  const itemById = useMemo(() => new Map(allItems.map((i) => [i.id, i])), [allItems]);
  const groupById = useMemo(() => new Map(workspace.groups.map((g) => [g.id, g])), [workspace.groups]);
  const groupsByCode = useMemo(() => groupsByCodeOf(workspace.groups), [workspace.groups]);
  const maps = useMemo<Maps>(() => ({ itemById, groupById, groupsByCode }), [itemById, groupById, groupsByCode]);

  // Render-time adjustment, not an effect: the frame that brings the moved
  // rev must not paint once with the stale drafts before an effect clears
  // them. `settleDrafts` reports no change over its own answer, so this
  // settles in one re-render.
  const settled = settleDrafts({
    drafts,
    bases,
    newRows,
    pending: pendingClears,
    items: itemById,
    workspaceRev: workspace.rev,
    keepGhostKey: sheet?.kind === 'ghost' ? sheet.key : null,
    sheetItemId: sheet?.kind === 'item' ? sheet.id : null,
  });
  if (settled.changed) {
    setDraftState({ drafts: settled.drafts, bases: settled.bases });
    setNewRows(settled.newRows);
    setPendingClears(settled.pending);
    const retarget = settled.retarget;
    if (retarget) {
      // The goods the open ghost sheet holds are a saved row now.
      setSheet({ kind: 'item', id: retarget.toId });
      const saved = itemById.get(retarget.toId);
      setSheetOpenBase(saved ? baseOf(saved, ALL_BASE_FIELDS) : null);
    }
    if (settled.gone !== null) {
      setSheet(null);
      if (!ownDeleted.has(settled.gone)) setRowGone(true);
    }
    const foreign = settled.prunedIds.filter((rowId) => !ownDeleted.has(rowId)).length;
    if (foreign > 0) setPrunedCount((n) => n + foreign);
  } else if (sheet?.kind === 'item' && !itemById.has(sheet.id)) {
    // The open row is gone with nothing drafted on it — close, never an
    // undefined body.
    setSheet(null);
    if (!ownDeleted.has(sheet.id)) setRowGone(true);
  }

  const dirtyGhosts = newRows.filter(ghostDirty);
  // Live ids only: a draft whose row a colleague deleted must release the
  // gate (settleDrafts prunes it on the next render anyway).
  const dirtyCount = Object.keys(drafts).filter((rowId) => itemById.has(rowId)).length + dirtyGhosts.length;
  /** The gate counts what is WAITING to be restored too: sealing over edits
   * the VED believes he made would lock a client price without them. */
  const gateCount = dirtyCount + (restore ? restorableCount(restore) : 0);
  // Intake prefills codes from the TNVED memory, so the commonest request
  // arrives coded-and-ungrouped with NOTHING dirty — the save's server-side
  // sweep places them; and legacy duplicate same-code groups normalize on the
  // same press, so both keep the button live.
  const codeCounts = new Map<string, number>();
  for (const g of workspace.groups) {
    const c = (g.tnvedCode ?? '').trim();
    if (c) codeCounts.set(c, (codeCounts.get(c) ?? 0) + 1);
  }
  const duplicateGroups = [...codeCounts.values()].filter((n) => n > 1).length;
  const sweepable = workspace.ungrouped.filter((i) => (i.tnvedCode ?? '').trim()).length;
  const saveable = dirtyCount > 0 || sweepable > 0 || duplicateGroups > 0;
  const aiRunning = workspace.aiRunningSince !== null;

  useEffect(() => onDirty(gateCount), [gateCount, onDirty]);

  /* ---- drafts: the setters (stable, so memo'd rows and cards hold) ---- */

  /** One row's draft and its per-field bases, moved together. */
  const withRowDraft = (
    prev: { drafts: Record<string, ItemDraft>; bases: Record<string, RowBase> },
    item: WorkspaceItem,
    rest: ItemDraft,
  ) => {
    const nextDrafts = { ...prev.drafts };
    const nextBases = { ...prev.bases };
    if (Object.keys(rest).length === 0) {
      delete nextDrafts[item.id];
      delete nextBases[item.id];
    } else {
      nextDrafts[item.id] = rest;
      const base = syncBase(prev.bases[item.id], rest, item);
      if (base) nextBases[item.id] = base;
      else delete nextBases[item.id];
    }
    return { drafts: nextDrafts, bases: nextBases };
  };

  const setDraft = useCallback(
    (itemId: string, field: keyof ItemDraft, raw: string) => {
      setLastSave(null);
      setDraftState((prev) => {
        const item = itemById.get(itemId);
        if (!item) return prev;
        const current: ItemDraft = { ...prev.drafts[itemId] };
        let rest: ItemDraft;
        if (field === 'bazaValue' || field === 'bazaBasis') {
          // The pair is ONE edit (baza-draft.ts): drafting its halves as two
          // updates made a unit picked on its own clean itself away.
          const halves = editBazaPair<string>(
            { bazaValue: current.bazaValue, bazaBasis: current.bazaBasis },
            field,
            raw,
            {
              bazaValue: serverValueOf(item, 'bazaValue', current, groupById, groupsByCode),
              bazaBasis: serverValueOf(item, 'bazaBasis', current, groupById, groupsByCode),
            },
          );
          delete current.bazaValue;
          delete current.bazaBasis;
          // A number the VED types is theirs, not the file's (0094).
          delete current.importRowId;
          rest = { ...current, ...(halves as Pick<ItemDraft, 'bazaValue' | 'bazaBasis'>) };
        } else {
          // A draft equal to the server value is not a draft — the dirty count
          // must mean «cells the save will send».
          rest = { ...current, [field]: raw };
          if (raw === serverValueOf(item, field, rest, groupById, groupsByCode)) delete rest[field];
        }
        return withRowDraft(prev, item, rest);
      });
    },
    [itemById, groupById, groupsByCode],
  );

  /** The picker's one writer: amount, basis and provenance land TOGETHER —
   * setDraft deliberately drops the provenance, because a hand-typed number
   * is the VED's own. */
  const pickImport = useCallback(
    (itemId: string, row: { id: string; pricePerUnitUsd: number; basis: BazaBasis }) => {
      setLastSave(null);
      setDraftState((prev) => {
        const item = itemById.get(itemId);
        if (!item) return prev;
        return withRowDraft(prev, item, {
          ...prev.drafts[itemId],
          bazaValue: String(row.pricePerUnitUsd),
          bazaBasis: row.basis,
          importRowId: row.id,
        });
      });
    },
    [itemById],
  );

  const clearDraft = useCallback((itemId: string) => {
    setDraftState((prev) => {
      if (!(itemId in prev.drafts) && !(itemId in prev.bases)) return prev;
      const nextDrafts = { ...prev.drafts };
      const nextBases = { ...prev.bases };
      delete nextDrafts[itemId];
      delete nextBases[itemId];
      return { drafts: nextDrafts, bases: nextBases };
    });
  }, []);

  const patchGhost = useCallback((key: number, patch: Partial<NewRow>) => {
    setLastSave(null);
    // A code keystroke no longer writes the unit at all: an untouched select
    // stays «avto» and the server stamps the law's default from the block the
    // row lands in (18a); a touched one is the VED's and no keystroke undoes it.
    setNewRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const removeGhost = useCallback((key: number) => setNewRows((rows) => rows.filter((r) => r.key !== key)), []);

  /** Before our own delete: the draft that dies with the row is ours. */
  const markOwnDelete = useCallback((itemId: string) => {
    setOwnDeleted((prev) => new Set(prev).add(itemId));
  }, []);

  const codesInRequest = useMemo(
    () =>
      [
        ...new Set(
          [...workspace.groups.map((g) => g.tnvedCode ?? ''), ...allItems.map((i) => i.tnvedCode ?? '')].filter(
            Boolean,
          ),
        ),
      ].sort(),
    [workspace.groups, allItems],
  );

  /* ---- the LIVE arithmetic: the browser runs the engine the seal runs ---- */

  /** An item with its drafts merged, quantized to the column scales so the
   * live figure and the saved figure agree to the cent. `d` is the row's own
   * draft by default; `null` prices the stored row (the sheet's figure merges
   * only the row it saves, D14). */
  const liveItem = (item: WorkspaceItem, d: ItemDraft | null | undefined = drafts[item.id]): PricedItem => {
    const numOf = (raw: string | undefined, server: number | null, scale: (v: number) => number) => {
      if (raw === undefined) return server;
      // An ambiguous or bad cell is no figure: nothing is computed from a
      // number nobody stated (B4 a).
      const cell = readNumberCell(raw);
      return cell.state === 'ok' ? scale(cell.value) : null;
    };
    // The unit and the pair the SCREEN shows (screenRowOf) — never a chain of
    // its own, or the live figure prices a unit the select is not showing.
    const row = screenRowOf(item, d ?? undefined, groupById, groupsByCode);
    const bazaUsd = numOf(d?.bazaValue, item.bazaUsd, q4);
    const bazaBasis = bazaUsd === null ? null : (row.basis ?? defaultBasisFor(null));
    // The measure mirrors the server's stamp rule: a draft prices in the
    // pair unit the row asks; a stored pair in another unit is no measure at
    // all (the save will clear it). The generic box of an unknown law prices
    // nothing until the save says what unit it is.
    const pair = row.pair === 'any' ? null : row.pair;
    let measureUnit: MeasureUnit | null = null;
    let measureQty: number | null = null;
    if (pair !== null) {
      if (d?.measure !== undefined) {
        const cell = readNumberCell(d.measure);
        if (cell.state === 'ok') {
          measureUnit = pair;
          measureQty = q4(cell.value);
        }
      } else if (item.measureUnit === pair) {
        measureUnit = item.measureUnit;
        measureQty = item.measureQty;
      }
    }
    return {
      seq: item.seq,
      label: item.label,
      quantity: numOf(d?.quantity, item.quantity, q3),
      weightKg: numOf(d?.weightKg, item.weightKg, q3),
      // An m³ baza prices from the drafted kub too (0125) — at the column's
      // own scale, or the live figure and the saved one part by a rounding.
      volumeM3: numOf(d?.volumeM3, item.volumeM3, q3),
      bazaUsd,
      bazaBasis,
      measureUnit,
      measureQty,
    };
  };

  const liveCustomsByGroup = useMemo(() => {
    const out = new Map<string, CustomsResult>();
    for (const g of workspace.groups) {
      out.set(g.id, customsFor(pricedGroupOf(g), g.items.map((i) => liveItem(i))));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, drafts]);

  /** Item 1: the block's one baza, read off the LIVE merged rows — the
   * footer must not print yesterday's baza beside a live customs figure
   * computed from the draft (two numbers from two moments on one row). */
  const liveBazaByGroup = useMemo(() => {
    const out = new Map<string, { bazaUsd: number; bazaBasis: BazaBasis } | null>();
    for (const g of workspace.groups) {
      out.set(g.id, uniformBazaOf(g.items.map((i) => liveItem(i))));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, drafts]);

  /** A1's chip over the same LIVE rows the footer's baza reads — the
   * server's verdict is about the stored rows, a moment the footer no
   * longer shows while anything is drafted (review units-r2-2). */
  const liveBasisNotLawByGroup = useMemo(() => {
    const out = new Map<string, boolean>();
    for (const g of workspace.groups) {
      out.set(g.id, basisNotLaw(g.dutyUnit, g.items.map((i) => liveItem(i))));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, drafts]);

  /** The bar's total — the SAME request-grain assembly the server runs, over
   * the live blocks. No partial sums: while any block or the fee refuses,
   * the bar shows the blocked state, never a smaller number. */
  const liveTotals = useMemo(() => {
    const assembled = requestCustomsFor({
      customs: workspace.groups.map((g) => liveCustomsByGroup.get(g.id)!),
      bhmUzs: workspace.bhmUzs,
      fxUzsPerUsd: workspace.fxUzsPerUsd,
      feeOverrideUsd: workspace.feeOverrideUsd,
    });
    if (!workspace.section || assembled.customsUsd === null) return null;
    if (workspace.parts.freight && !workspace.freight?.ok) return null;
    return totalsFor({
      section: workspace.section,
      customsUsd: assembled.customsUsd,
      freightUsd: workspace.freight?.ok ? workspace.freight.listUsd : 0,
      extrasUsd: workspace.extrasUsd,
      discountUsd: 0,
      weightKg: workspace.weightKg,
      volumeM3: workspace.volumeM3,
    });
  }, [workspace, liveCustomsByGroup]);

  /**
   * The open sheet's figure — what THIS Saqlash would store (#886): the
   * block the row's drafted code lands in, with ONLY this row's draft merged.
   * Other rows' drafts are not posted by this press, so merging them (as the
   * footer does) would print a figure the save cannot store.
   */
  const sheetFigure = useMemo((): SheetFigure | null => {
    if (!sheet) return null;
    if (sheet.kind === 'item') {
      const item = itemById.get(sheet.id);
      if (!item) return null;
      const d = drafts[item.id];
      const code = (d?.tnvedCode ?? item.tnvedCode ?? '').trim();
      if (!code) return { state: 'no_code' };
      const lawGroup = screenRowOf(item, d, groupById, groupsByCode).lawGroup;
      if (!lawGroup) return { state: 'unknown_law' };
      const members = lawGroup.items.map((i) => liveItem(i, i.id === item.id ? (d ?? null) : null));
      if (!lawGroup.items.some((i) => i.id === item.id)) members.push(liveItem(item, d ?? null));
      return { state: 'ok', customs: customsFor(pricedGroupOf(lawGroup), members) };
    }
    const row = newRows.find((r) => r.key === sheet.key);
    if (!row) return null;
    const code = row.tnvedCode.trim();
    if (!code) return { state: 'no_code' };
    const lawGroup = groupsByCode.get(code) ?? null;
    if (!lawGroup) return { state: 'unknown_law' };
    const members = lawGroup.items.map((i) => liveItem(i, null));
    members.push(liveGhostItem(row, lawGroup, groupsByCode));
    return { state: 'ok', customs: customsFor(pricedGroupOf(lawGroup), members) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, drafts, newRows, workspace]);

  /* ---- the current state, for code that resumes after an await ---- */
  const latest = useRef<Latest | null>(null);
  useLayoutEffect(() => {
    latest.current = {
      drafts,
      bases,
      newRows,
      sheet,
      itemById,
      groupById,
      groupsByCode,
      workspaceRev: workspace.rev,
      waitState: wait.state,
    };
  });

  // The rev the screen shows is never news to it.
  useEffect(() => {
    knownRev.current = Math.max(knownRev.current, workspace.rev);
    const ready = landWaiters.current.filter((w) => workspace.rev >= w.rev);
    if (ready.length === 0) return;
    landWaiters.current = landWaiters.current.filter((w) => workspace.rev < w.rev);
    for (const w of ready) w.resolve('landed');
  }, [workspace.rev]);

  /** Resolve once the screen shows `rev` — or after eight seconds: a refresh
   * that never lands must not become a lock (row-draft.ts `refreshWait`). */
  const waitForLanding = (rev: number) =>
    new Promise<'landed' | 'timedOut'>((resolve) => {
      if ((latest.current?.workspaceRev ?? workspace.rev) >= rev) {
        resolve('landed');
        return;
      }
      const entry = {
        rev,
        resolve: (outcome: 'landed' | 'timedOut') => {
          window.clearTimeout(timer);
          resolve(outcome);
        },
      };
      const timer = window.setTimeout(() => {
        landWaiters.current = landWaiters.current.filter((w) => w !== entry);
        resolve('timedOut');
      }, REFRESH_WAIT_MS);
      landWaiters.current.push(entry);
    });

  /* ---- B5 a: drafts survive a closed tab ---- */

  // The READ is declared FIRST, and it gates the write through a REF: one
  // commit's passive effects run together, so a prompt held only in state is
  // invisible to the write effect in the same flush — the first empty render
  // would delete the entry before the question was ever asked. The entry
  // lives in localStorage, which the server render cannot read: it is
  // offered after mount or the hydration would disagree with the server.
  useEffect(() => {
    const parsed = parseStoredDrafts(readStored(browserStorage(), storageKey), Date.now());
    const now = latest.current;
    const plan =
      parsed && now
        ? planRestore(parsed, now.itemById, (item) => screenRowOf(item, undefined, now.groupById, now.groupsByCode).basis)
        : null;
    if (parsed && plan && restorableCount(plan) > 0) {
      storedEntry.current = parsed;
      storagePhase.current = 'prompt';
      setRestore(plan);
    } else {
      // Nothing to bring back — at most news («already saved», «not
      // restored: changed meanwhile»), shown ONCE (review PHONE-6): the
      // write effect in this same flush replaces the entry with the live
      // state, so it does not greet every open for 72 hours.
      storagePhase.current = 'live';
      if (parsed && plan && (plan.skipped.length > 0 || plan.alreadySaved > 0)) setRestore(plan);
    }
  }, [storageKey]);

  useEffect(() => {
    if (storagePhase.current === 'init') return;
    const live = serializeDrafts({ drafts, bases, newRows }, new Date());
    // While the question stands, the stored rows a live draft has not
    // replaced are KEPT — new typing is saved even if he never answers.
    const value = storagePhase.current === 'prompt' ? mergeForStorage(storedEntry.current, live) : live;
    storageOk.current = writeStored(browserStorage(), storageKey, value);
  }, [drafts, bases, newRows, storageKey]);

  const applyRestore = () => {
    const stored = storedEntry.current;
    const now = latest.current;
    if (!stored || !now) return;
    // Judged again against the workspace as it is NOW, not as it was at mount.
    const plan = planRestore(stored, now.itemById, (item) =>
      screenRowOf(item, undefined, now.groupById, now.groupsByCode).basis,
    );
    setDraftState((prev) => {
      const nextDrafts = { ...prev.drafts };
      const nextBases = { ...prev.bases };
      for (const [rowId, entry] of Object.entries(plan.rows)) {
        const item = now.itemById.get(rowId);
        if (!item) continue;
        // A cell typed meanwhile wins over the stored one.
        const merged = { ...entry.draft, ...(prev.drafts[rowId] ?? {}) };
        nextDrafts[rowId] = merged;
        const base = syncBase({ ...entry.base, ...(prev.bases[rowId] ?? {}) }, merged, item);
        if (base) nextBases[rowId] = base;
      }
      return { drafts: nextDrafts, bases: nextBases };
    });
    if (plan.ghosts.length > 0) {
      setNewRows((rows) => [...rows, ...plan.ghosts.map((g) => ({ ...g, key: newKey.current++ }))]);
    }
    storagePhase.current = 'live';
    storedEntry.current = null;
    setRestore(null);
  };

  const dropRestore = () => {
    storagePhase.current = 'live';
    storedEntry.current = null;
    setRestore(null);
    // What was typed while the question stood is kept; the old entry is not.
    storageOk.current = writeStored(
      browserStorage(),
      storageKey,
      serializeDrafts({ drafts, bases, newRows }, new Date()),
    );
  };

  // One hour of typed rows must not die on a mis-tap — but only where the
  // drafts are NOT already safe in storage: with storage healthy a reload
  // loses nothing (B5 a), and Chrome's «Leave site?» over a pull-to-refresh
  // would contradict «yopsangiz ham yozganingiz qoladi».
  useEffect(() => {
    if (dirtyCount === 0) return;
    const guard = (e: BeforeUnloadEvent) => {
      if (storageOk.current !== true) e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirtyCount]);

  /* ---- the writers: builders + ONE sender ---- */

  /** One existing row's edit, built from its draft — or the refusal naming
   * the row and the cell. Null when the row is gone. The client refuses
   * NaN and an ambiguous comma before the wire; the server stays the
   * authority. */
  const buildEdit = (
    itemId: string,
    d: ItemDraft,
    m: Maps = maps,
  ): { edit: TableItemEdit } | { refusal: TableRefusal } | null => {
    const item = m.itemById.get(itemId);
    // The row is gone (a colleague's delete) — a draft with no row is not
    // an edit, and posting it would wedge every later save.
    if (!item) return null;
    const edit: TableItemEdit = { id: itemId, seq: item.seq };
    if (d.name !== undefined) edit.name = d.name;
    if (d.note !== undefined) edit.note = d.note || null;
    if (d.tnvedCode !== undefined) {
      const code = d.tnvedCode.trim();
      if (code && !CODE_SHAPE.test(code)) return { refusal: { code: 'bad_code', seq: item.seq, itemId } };
      edit.tnvedCode = code || null;
    }
    for (const field of NUM_COLS) {
      const raw = d[field];
      if (raw === undefined) continue;
      const read = readCell(raw, item.seq, field);
      if ('refusal' in read) return { refusal: { ...read.refusal, itemId } };
      edit[field] = read.value;
    }
    if (d.measure !== undefined) {
      // The cell applies only while the row asks a pair unit — the SAME
      // rule that draws the box (screenRowOf): a recode or a new unit that
      // stops asking strands the draft, and the save drops it client-side
      // rather than wedging on a box the screen no longer renders.
      if (screenRowOf(item, d, m.groupById, m.groupsByCode).pair !== null) {
        const read = readCell(d.measure, item.seq, 'measure');
        if ('refusal' in read) return { refusal: { ...read.refusal, itemId } };
        edit.measureQty = read.value;
      }
    }
    if (d.bazaValue !== undefined || d.bazaBasis !== undefined) {
      const read = readCell(
        d.bazaValue ?? serverValueOf(item, 'bazaValue', d, m.groupById, m.groupsByCode),
        item.seq,
        'bazaValue',
      );
      if ('refusal' in read) return { refusal: { ...read.refusal, itemId } };
      const v = read.value;
      edit.bazaUsd = v;
      // 0125's four states (workspace.ts TableItemEdit). A unit the VED
      // TOUCHED is posted with or without a price — on an unpriced row it
      // used to evaporate on Saqlash. An untouched one posts what is
      // stored (it stands), or null = «avto», which the server stamps from
      // the block the row ENDS in. Clearing the price: `postedBasis`.
      edit.bazaBasis = postedBasis(d.bazaBasis, v === null, item);
      // The picked row's id — the server re-reads it and takes the PRICE
      // from the file, so a browser that lies about the number is answered
      // by the declaration itself.
      if (v !== null && d.importRowId) edit.importRowId = d.importRowId;
    }
    return { edit };
  };

  /** One NEW row's add. A typo in a number is refused now (it used to post
   * a silent null) and an ambiguous comma is asked about. */
  const buildAdd = (row: NewRow, index: number): { add: TableNewItem } | { refusal: TableRefusal } => {
    const ghostSeq = -(index + 1);
    if (!row.name.trim()) return { refusal: { code: 'name_required', seq: ghostSeq, ghostKey: row.key } };
    const code = row.tnvedCode.trim();
    if (code && !CODE_SHAPE.test(code)) return { refusal: { code: 'bad_code', seq: ghostSeq, ghostKey: row.key } };
    const nums: Partial<Record<SheetNumField, number | null>> = {};
    for (const field of ['quantity', 'weightKg', 'volumeM3', 'measure', 'bazaValue'] as const) {
      const read = readCell(row[field], ghostSeq, field);
      if ('refusal' in read) return { refusal: { ...read.refusal, ghostKey: row.key } };
      nums[field] = read.value;
    }
    return {
      add: {
        clientId: row.clientId,
        name: row.name,
        quantity: nums.quantity ?? null,
        unit: row.unit.trim() || null,
        weightKg: nums.weightKg ?? null,
        volumeM3: nums.volumeM3 ?? null,
        tnvedCode: code || null,
        // Posted UNCONDITIONALLY — the ghost's one rule at both widths: the
        // box is on every ghost (its law is unknowable before the save), and
        // the server drops and NAMES a measure the law does not take.
        measureQty: nums.measure ?? null,
        bazaUsd: nums.bazaValue ?? null,
        // Null while untouched — «avto», stamped by the server from the block
        // the new code lands in; a touched unit stands with or without a price.
        bazaBasis: row.bazaBasis,
        note: row.note.trim() || null,
      },
    };
  };

  /** THE one sender. Returns the answer and writes no error of its own —
   * the grid's save and the sheet's press each say it where they are. */
  const send = async (
    items: TableItemEdit[],
    adds: TableNewItem[],
    posted: { drafts: Map<string, ItemDraft>; ghosts: Map<number, NewRow> },
  ): Promise<TableFormState> => {
    const now = latest.current;
    const revAtPress = now?.workspaceRev ?? workspace.rev;
    // The other drafted rows' stored values at the press — the re-base may
    // move a base only where nothing foreign already stood under it.
    const atPress: Record<string, RowBase> = {};
    for (const [rowId, base] of Object.entries(now?.bases ?? {})) {
      if (posted.drafts.has(rowId)) continue;
      const item = now?.itemById.get(rowId);
      if (item) atPress[rowId] = baseOf(item, Object.keys(base) as BaseField[]);
    }
    // Every posted ghost carries what it carried (review PHONE-1), written
    // with the press so a closed tab keeps it too: if the answer never
    // comes, a ghost the server turns out to hold is judged against THIS,
    // never against the stored row a colleague may have corrected since.
    // The FIRST unanswered post's stamp stands (row-draft.ts NewRow.posted).
    const stamped = new Map<number, NewRow>();
    const minted = new Map<number, PostedCells>();
    for (const [key, row] of posted.ghosts) {
      if (row.posted !== null) {
        stamped.set(key, row);
        continue;
      }
      const cells = postedCellsOf(row);
      minted.set(key, cells);
      stamped.set(key, { ...row, posted: cells });
    }
    if (minted.size > 0) {
      setNewRows((rows) =>
        rows.map((r) => (minted.has(r.key) && r === posted.ghosts.get(r.key) ? stamped.get(r.key)! : r)),
      );
    }
    setSaving(true);
    inFlight.current = true;
    try {
      const result = await saveTableAction(id, { items, adds });
      if (!result.ok) {
        // A REFUSAL wrote nothing (one transaction), so the stamp it minted
        // would vouch for a save that never happened — put back what stood.
        if (minted.size > 0) {
          setNewRows((rows) =>
            rows.map((r) =>
              minted.has(r.key) && r.posted === minted.get(r.key) ? { ...r, posted: null } : r,
            ),
          );
        }
        return result;
      }
      // A success with no clock is not one the screen can settle on.
      if (!Number.isFinite(result.rev)) return { error: 'save_failed' };
      knownRev.current = Math.max(knownRev.current, result.rev);
      setPrunedCount(0);
      setLastSave({
        minted: result.minted ?? [],
        swept: result.swept ?? 0,
        merged: result.merged ?? [],
        measuresCleared: result.measuresCleared ?? [],
        measuresDropped: result.measuresDropped ?? [],
        basisSuspect: result.basisSuspect ?? [],
        basisConflict: result.basisConflict ?? [],
        alreadySaved: result.alreadySaved ?? 0,
        importFilled: result.importFilled ?? [],
        memoryFilled: result.memoryFilled ?? [],
      });
      // Drafts are HELD until the refreshed workspace reaches this rev, so
      // the live figures never flash back to pre-save numbers — and only
      // what this press POSTED settles then.
      setPendingClears((prev) => [
        ...prev,
        { rev: result.rev, revAtPress, drafts: posted.drafts, ghosts: stamped, atPress },
      ]);
      router.refresh();
      return result;
    } catch {
      // A thrown action is a sentence, never a dead button — and after a
      // deploy it is the RIGHT sentence: the tab's action ids are gone.
      return { error: (await isBuildStale()) ? 'stale_build' : 'save_failed' };
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  /** The grid's ONE save — every live draft and every dirty ghost in one
   * transaction (an empty post runs the server's sweep). */
  const save = async () => {
    setTableError(null);
    const items: TableItemEdit[] = [];
    const postedDrafts = new Map<string, ItemDraft>();
    for (const [itemId, d] of Object.entries(drafts)) {
      const built = buildEdit(itemId, d);
      if (built === null) continue;
      if ('refusal' in built) {
        setTableError(built.refusal);
        return;
      }
      items.push(built.edit);
      postedDrafts.set(itemId, d);
    }
    const adds: TableNewItem[] = [];
    const postedGhosts = new Map<number, NewRow>();
    for (const [i, row] of newRows.entries()) {
      if (!ghostDirty(row)) continue;
      const built = buildAdd(row, i);
      if ('refusal' in built) {
        setTableError(built.refusal);
        return;
      }
      adds.push(built.add);
      postedGhosts.set(row.key, row);
    }
    const result = await send(items, adds, { drafts: postedDrafts, ghosts: postedGhosts });
    if (!result.ok) setTableError({ code: result.error, seq: result.seq });
  };

  /* ---- the phone sheet: open, close, press ---- */

  const resetSheetState = () => {
    setSheetError(null);
    setDeleteWarn(null);
    dispatchWait({ type: 'reset' });
  };

  const openItemSheet = useCallback(
    (itemId: string) => {
      const item = itemById.get(itemId);
      if (!item) return;
      setRowGone(false);
      setSheetError(null);
      setDeleteWarn(null);
      dispatchWait({ type: 'reset' });
      setSheetExpectRev(workspace.rev);
      setSheetOpenBase(baseOf(item, ALL_BASE_FIELDS));
      setSheet({ kind: 'item', id: itemId });
    },
    [itemById, workspace.rev],
  );

  const openGhostSheet = useCallback(
    (key: number) => {
      setRowGone(false);
      setSheetError(null);
      setDeleteWarn(null);
      dispatchWait({ type: 'reset' });
      setSheetExpectRev(workspace.rev);
      setSheetOpenBase(null);
      setSheet({ kind: 'ghost', key });
    },
    [workspace.rev],
  );

  const addGhostAndOpen = useCallback(() => {
    const row = emptyRow(newKey.current++);
    setNewRows((rows) => [...rows, row]);
    openGhostSheet(row.key);
  }, [openGhostSheet]);

  /** Closing ALWAYS closes — the draft lives here and in storage. An empty
   * new row goes with its sheet. */
  const closeSheet = () => {
    const was = latest.current?.sheet ?? sheet;
    setSheet(null);
    resetSheetState();
    if (was?.kind === 'ghost') {
      setNewRows((rows) => rows.filter((r) => r.key !== was.key || ghostDirty(r)));
    }
  };

  /** Is the sheet still on this row? Read from the CURRENT state, because a
   * press outlives the render it began in (review PHONE-3). */
  const showing = (target: SheetTarget) =>
    sheetKeyOf(latest.current?.sheet ?? null) === sheetKeyOf(target);

  /**
   * Say a refusal where the VED is (review PHONE-3): in the sheet while it
   * still shows the row the press was made on — the ambiguity question and a
   * bad number UNDER their own field (PHONE-4), anything else at the sheet's
   * top — else in the table's own line, which shows at every width. A sheet
   * closed, or another row opened, during the press's look must neither
   * swallow its answer nor wear it.
   */
  const showRefusal = (refusal: TableRefusal, pressed: SheetTarget) => {
    const key = sheetKeyOf(pressed);
    if (!showing(pressed)) {
      // The generic sentence: the two-button question in that line is the
      // desktop grid's (hidden md:block), and this row's sheet is closed.
      setTableError({ code: refusal.code, seq: refusal.seq });
      return;
    }
    if ((refusal.code === 'ambiguous_number' || refusal.code === 'bad_number') && refusal.field) {
      const field = refusal.field;
      setAsked((prev) => ({
        key,
        fields: [...(prev.key === key ? prev.fields : []), field],
      }));
      // The question sits under its field — bring it into view.
      const testId = refusal.code === 'ambiguous_number' ? 'calc-phone-ambiguous' : 'calc-phone-bad';
      requestAnimationFrame(() =>
        document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: 'nearest' }),
      );
      return;
    }
    setSheetError(refusal.code);
  };

  /** The open row's build, from a given moment's state. */
  const buildFor = (now: Latest) => {
    const target = now.sheet;
    if (!target) return null;
    if (target.kind === 'item') {
      const d = now.drafts[target.id];
      return d ? buildEdit(target.id, d, now) : null;
    }
    const index = now.newRows.findIndex((r) => r.key === target.key);
    return index === -1 ? null : buildAdd(now.newRows[index]!, index);
  };

  /** Where the pressed row is NOW — a ghost the refresh turned into its
   * saved row IS that row (the same goods), so the press goes on with it. */
  const pressedNow = (now: Latest, pressed: SheetTarget, clientId: string | null): SheetTarget | null => {
    if (pressed.kind === 'item') return now.itemById.has(pressed.id) ? pressed : null;
    if (now.newRows.some((r) => r.key === pressed.key)) return pressed;
    return clientId !== null && now.itemById.has(clientId) ? { kind: 'item', id: clientId } : null;
  };

  /** The row a table-line refusal names — none when it is gone. */
  const seqOf = (now: Latest, target: SheetTarget): number | undefined => {
    if (target.kind === 'item') return now.itemById.get(target.id)?.seq;
    const index = now.newRows.findIndex((r) => r.key === target.key);
    return index === -1 ? undefined : -(index + 1);
  };

  /**
   * Look before writing (B6 a): a rev past what the screen knows refreshes
   * first and waits for it, at most eight seconds — `landed`, `timedOut`, or
   * `none` when there was nothing to bring in. Our OWN last answer counts
   * too: a press made before the refresh of the previous save has landed
   * would post over values the screen no longer shows, and the commit's
   * compare-and-set (PHONE-2) would then blame «boshqa kishi» for our own
   * save. The wait is drawn only on the pressed row's own sheet.
   */
  const lookFirst = async (pressed: SheetTarget): Promise<'none' | 'landed' | 'timedOut'> => {
    const probe = await probeClock(id);
    const news = probe !== null && probe.rev > knownRev.current;
    const want = Math.max(news ? probe.rev : 0, knownRev.current);
    if ((latest.current?.workspaceRev ?? workspace.rev) >= want) return 'none';
    if (showing(pressed)) dispatchWait({ type: 'start', rev: want, now: Date.now() });
    // Asked again even for our own rev: a refresh Next discarded (#1242)
    // would otherwise leave every later press waiting out the eight seconds.
    router.refresh();
    const outcome = await waitForLanding(want);
    if (showing(pressed)) dispatchWait(outcome === 'timedOut' ? { type: 'rejected' } : { type: 'reset' });
    return outcome;
  };

  /**
   * The sheet's Saqlash (B2 a): ONE row posted through the grid's own
   * builders and sender. It looks before it writes (B6 a): a rev past what
   * the screen knows refreshes first, and when what changed is under THIS
   * row's drafted cells the press stops and shows it — the next press saves.
   * Anything else (the machine's sweep, our own lost commit) costs nothing.
   *
   * The press is BOUND to the row it was made on (review PHONE-3): the sheet
   * may be closed, or another row opened, while it looks, and neither cancels
   * it nor retargets it — the CURRENT state is read after every await (the
   * refresh can turn the very ghost it began on into a saved row), but always
   * for THIS row. And the look is not left to the probe alone (PHONE-2): the
   * edit carries what the screen showed under its cells, so a colleague's
   * save landing between the probe and our commit is refused by the server
   * (`changed_under`) and brought in, never overwritten unseen.
   */
  const saveSheetRow = async () => {
    const start = latest.current;
    if (!start?.sheet || inFlight.current) return;
    const pressed = start.sheet;
    const pressedClientId =
      pressed.kind === 'ghost' ? (start.newRows.find((r) => r.key === pressed.key)?.clientId ?? null) : null;
    setSheetError(null);
    setTableError(null);
    const pre = buildFor(start);
    if (pre && 'refusal' in pre) {
      showRefusal(pre.refusal, pressed);
      return;
    }
    const startItem = pressed.kind === 'item' ? start.itemById.get(pressed.id) : undefined;
    const shown = startItem ? changeSignature(changedUnder(start.bases[startItem.id], startItem)) : '';
    // A wait that already timed out is not asked twice: the label reads
    // «Baribir saqlash», the VED saw «hisob yangilandi», and this press saves
    // — a refresh that never lands must not become a lock.
    const acknowledged = start.waitState === 'timedOut';
    setPressing(true);
    try {
      if (!acknowledged && (await lookFirst(pressed)) === 'timedOut') {
        // The sheet still on this row says it (and «Baribir saqlash»); a
        // closed one cannot.
        if (!showing(pressed)) setTableError({ code: 'refresh_timeout', seq: seqOf(latest.current!, pressed) });
        return;
      }
      const now = latest.current!;
      const target = pressedNow(now, pressed, pressedClientId);
      // Discarded or deleted meanwhile — the prune names a colleague's delete.
      if (!target) return;
      if (target.kind === 'item') {
        const item = now.itemById.get(target.id)!;
        const d = now.drafts[target.id];
        if (!d) {
          // The lost add already landed and nothing differs — it IS saved.
          if (showing(target)) closeSheet();
          setLastSave({ ...EMPTY_SAVE, alreadySaved: 1 });
          return;
        }
        const changes = changedUnder(now.bases[target.id], item);
        if (changes.length > 0 && changeSignature(changes) !== shown) {
          // The row's own warning names it on its sheet; a closed sheet
          // cannot, so the table line does.
          if (!showing(target)) setTableError({ code: 'changed_under', seq: item.seq });
          return;
        }
        const built = buildEdit(target.id, d, now);
        if (built === null) return;
        if ('refusal' in built) {
          showRefusal(built.refusal, target);
          return;
        }
        const edit: TableItemEdit = acknowledged ? built.edit : { ...built.edit, expect: expectFor(item, d) };
        const result = await send([edit], [], { drafts: new Map([[target.id, d]]), ghosts: new Map() });
        if (!result.ok) {
          if (result.error === 'changed_under') {
            // Bring the colleague's save in: the row's own warning then names
            // it (or «hisob yangilandi» with «Baribir saqlash» when the
            // refresh is slow), and the next press — with it on the screen —
            // saves. Only a look that brought nothing in needs the sentence.
            if (showing(target) && (await lookFirst(target)) !== 'none') return;
            router.refresh();
          }
          showRefusal({ code: result.error, seq: result.seq }, target);
          return;
        }
        if (showing(target)) {
          setSheetExpectRev(result.rev);
          closeSheet();
        }
      } else {
        const index = now.newRows.findIndex((r) => r.key === target.key);
        const row = now.newRows[index];
        if (!row) return;
        const built = buildAdd(row, index);
        if ('refusal' in built) {
          showRefusal(built.refusal, target);
          return;
        }
        const result = await send([], [built.add], { drafts: new Map(), ghosts: new Map([[row.key, row]]) });
        if (!result.ok) {
          showRefusal({ code: result.error, seq: result.seq }, target);
          return;
        }
        if (showing(target)) {
          setSheetExpectRev(result.rev);
          closeSheet();
        }
      }
    } finally {
      setPressing(false);
    }
  };

  /** The sheet's 🗑 — the same look first; a row that changed since the
   * sheet opened takes a second press, a row with figures the desktop's
   * confirm. Bound to the row it was pressed on, like Saqlash (PHONE-3). */
  const deleteSheetRow = async () => {
    const start = latest.current;
    if (start?.sheet?.kind !== 'item' || inFlight.current) return;
    const pressed = start.sheet;
    const rowId = pressed.id;
    setSheetError(null);
    setTableError(null);
    setPressing(true);
    const say = (code: string, seq: number | undefined) =>
      showing(pressed) ? setSheetError(code) : setTableError({ code, seq });
    try {
      if (deleteWarn === null) {
        if (start.waitState !== 'timedOut') await lookFirst(pressed);
        const fresh = latest.current?.itemById.get(rowId);
        if (!fresh) return;
        const changes = sheetOpenBase ? changedUnder(sheetOpenBase, fresh) : [];
        if (changes.length > 0) {
          if (showing(pressed)) setDeleteWarn(changes);
          else setTableError({ code: 'changed_under', seq: fresh.seq });
          return;
        }
      }
      const item = latest.current?.itemById.get(rowId);
      if (!item) return;
      const hasData = item.bazaUsd !== null || item.quantity !== null || item.weightKg !== null;
      if (hasData && !window.confirm(`${tc('delete')}? ${item.label}`)) return;
      markOwnDelete(rowId);
      inFlight.current = true;
      try {
        const result = await deleteItemAction(id, rowId);
        // `not_found`: a lost answer whose delete already committed.
        if (result.ok || result.error === 'not_found') {
          if (result.ok) knownRev.current = Math.max(knownRev.current, result.rev);
          clearDraft(rowId);
          if (showing(pressed)) closeSheet();
          router.refresh();
        } else {
          say(result.error, item.seq);
        }
      } catch {
        say((await isBuildStale()) ? 'stale_build' : 'save_failed', item.seq);
      } finally {
        inFlight.current = false;
      }
    } finally {
      setPressing(false);
    }
  };

  const discardSheetRow = () => {
    const target = latest.current?.sheet ?? sheet;
    if (!target) return;
    if (target.kind === 'item') {
      clearDraft(target.id);
      setDeleteWarn(null);
    } else {
      removeGhost(target.key);
      setSheet(null);
      resetSheetState();
    }
  };

  /** The 📥 from the sheet: never two Overlays open at once (one Escape
   * would close both) — the sheet steps aside and comes back after. */
  const openPickerFromSheet = () => {
    if (sheet?.kind !== 'item') return;
    const item = itemById.get(sheet.id);
    if (!item?.tnvedCode) return;
    const d = drafts[item.id];
    const screen = screenRowOf(item, d, groupById, groupsByCode);
    const cell = readNumberCell(d?.bazaValue ?? numText(item.bazaUsd));
    pickerReturn.current = sheet;
    setSheet(null);
    setPicker({
      itemId: item.id,
      name: item.label,
      tnvedCode: item.tnvedCode,
      basis: d?.bazaBasis ?? null,
      current:
        screen.basis !== null && cell.state === 'ok' && cell.value > 0
          ? { usd: cell.value, basis: screen.basis }
          : null,
    });
  };

  // The probe (B6 a): every 15 s while a sheet is open or an AI pass holds
  // the request, once on open, and when the phone comes back on — never
  // while one of our own writes awaits its answer (#1242).
  const sheetKey = sheetKeyOf(sheet);
  useEffect(() => {
    if (sheetKey === null && !aiRunning) return;
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || inFlight.current) return;
      const probe = await probeClock(id);
      // An answer that arrives while we are writing is ignored.
      if (!alive || inFlight.current) return;
      if (shouldRefresh(probe, knownRev.current, aiRunning, inFlight.current)) router.refresh();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sheetKey, aiRunning, id, router]);

  /* ---- the sheet's model ---- */
  const sheetItem = sheet?.kind === 'item' ? (itemById.get(sheet.id) ?? null) : null;
  const sheetRow = sheet?.kind === 'ghost' ? (newRows.find((r) => r.key === sheet.key) ?? null) : null;
  /** What moved under THIS row's drafted cells — derived every render,
   * whichever path brought the refresh (the poll, the press, the open). */
  const mustConfirm = sheetItem ? changedUnder(bases[sheetItem.id], sheetItem) : [];
  const shownChanges = deleteWarn ?? mustConfirm;
  const sheetModel: SheetModel | null = (() => {
    if (sheetItem) {
      const d = drafts[sheetItem.id];
      const screen = screenRowOf(sheetItem, d, groupById, groupsByCode);
      const pair = screen.pair;
      return {
        kind: 'item',
        key: `item:${sheetItem.id}`,
        seq: sheetItem.seq,
        values: {
          name: d?.name ?? sheetItem.label,
          tnvedCode: d?.tnvedCode ?? sheetItem.tnvedCode ?? '',
          note: d?.note ?? sheetItem.note ?? '',
          quantity: d?.quantity ?? numText(sheetItem.quantity),
          weightKg: d?.weightKg ?? numText(sheetItem.weightKg),
          volumeM3: d?.volumeM3 ?? numText(sheetItem.volumeM3),
          measure: d?.measure ?? serverValueOf(sheetItem, 'measure', d, groupById, groupsByCode),
          bazaValue: d?.bazaValue ?? numText(sheetItem.bazaUsd),
        },
        drafted: Object.fromEntries(Object.keys(d ?? {}).map((k) => [k, true])),
        sellerUnit: sheetItem.unit,
        // EXACTLY the condition buildEdit posts the measure on.
        measure:
          pair === null
            ? null
            : {
                label:
                  pair === 'any'
                    ? t('table.measureGhost')
                    : t('table.measureFor', { unit: basisLabel(pair, t('perUnit')) }),
                suffix: pair === 'any' ? null : basisLabel(pair, t('perUnit')),
                sm3: pair === 'sm3',
              },
        basis: { value: screen.basis, offered: screen.offered },
        chips: {
          memory: sheetItem.bazaSource === 'memory' && d?.bazaValue === undefined,
          import: sheetItem.bazaSource === 'import' && d?.bazaValue === undefined,
          reason: d?.bazaValue === undefined ? sheetItem.bazaReason : null,
        },
        dictionaryBaza: sheetItem.dictionaryBaza,
        importDoor: sheetItem.tnvedCode ? (rowDirtyForPicker(d) ? 'row_dirty' : 'open') : 'needs_code',
        figure: sheetFigure ?? { state: 'no_code' },
      };
    }
    if (sheetRow) {
      const screen = ghostScreenOf(sheetRow, groupsByCode);
      return {
        kind: 'ghost',
        key: `ghost:${sheetRow.key}`,
        seq: null,
        values: {
          name: sheetRow.name,
          tnvedCode: sheetRow.tnvedCode,
          note: sheetRow.note,
          quantity: sheetRow.quantity,
          weightKg: sheetRow.weightKg,
          volumeM3: sheetRow.volumeM3,
          measure: sheetRow.measure,
          bazaValue: sheetRow.bazaValue,
        },
        drafted: sheetRow.bazaBasis !== null ? { bazaBasis: true } : {},
        sellerUnit: null,
        // ALWAYS on a ghost — the desktop ghost's own rule, and buildAdd
        // posts it unconditionally: a box on screen is a number that is
        // posted, and nothing hidden is posted.
        measure: { label: t('table.measureGhost'), suffix: null, sm3: false },
        basis: { value: screen.basis, offered: screen.offered },
        chips: { memory: false, import: false, reason: null },
        dictionaryBaza: null,
        importDoor: null,
        figure: sheetFigure ?? { state: 'no_code' },
      };
    }
    return null;
  })();
  const sheetHasPost = sheetItem ? drafts[sheetItem.id] !== undefined : sheetRow ? ghostDirty(sheetRow) : false;
  const changedElsewhere =
    sheet !== null &&
    mustConfirm.length === 0 &&
    (wait.state === 'timedOut' || (sheetExpectRev !== null && workspace.rev > sheetExpectRev));
  const askedNow = asked.key === sheetKey ? asked.fields : [];

  const onSheetField = (field: SheetField, raw: string) => {
    if (!sheet) return;
    if (sheet.kind === 'item') setDraft(sheet.id, field, raw);
    else patchGhost(sheet.key, { [field]: raw });
  };
  const onSheetBasis = (basis: BazaBasis) => {
    if (!sheet) return;
    // ONE edit: the pair rule drafts the amount as it stands beside the
    // unit, so the save posts a coherent pair (baza-draft.ts).
    if (sheet.kind === 'item') setDraft(sheet.id, 'bazaBasis', basis);
    else patchGhost(sheet.key, { bazaBasis: basis });
  };
  const onSheetAsk = (field: SheetNumField) =>
    setAsked((prev) => ({ key: sheetKey, fields: [...(prev.key === sheetKey ? prev.fields : []), field] }));

  /** The first unsaved row to reopen — live ids only, never a pruned one. */
  const firstDrafted = allItems.find((i) => drafts[i.id] !== undefined);
  const nextDraft: { kind: 'item'; id: string } | { kind: 'ghost'; key: number } | null = firstDrafted
    ? { kind: 'item', id: firstDrafted.id }
    : dirtyGhosts[0]
      ? { kind: 'ghost', key: dirtyGhosts[0].key }
      : null;

  /** The desktop's answer to «1,125»: the two readings as buttons that
   * rewrite exactly that cell. */
  const resolveAmbiguous = (refusal: TableRefusal, text: string) => {
    if (!refusal.field) return;
    if (refusal.itemId) setDraft(refusal.itemId, refusal.field, text);
    else if (refusal.ghostKey !== undefined) patchGhost(refusal.ghostKey, { [refusal.field]: text });
    setTableError(null);
  };

  /** Enter walks DOWN the column, Excel's motion; on the last row it grows
   * the table — the «sometimes 1 piece» trickle must not need the mouse. */
  const onCellKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, col: string, rowIndex: number, lastIndex: number) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const focusCell = (index: number) => {
        const el = document.querySelector<HTMLInputElement>(`[data-cell="${col}"][data-row="${index}"]`);
        el?.focus();
        el?.select();
      };
      if (rowIndex >= lastIndex) {
        setNewRows((rows) => [...rows, emptyRow(newKey.current++)]);
        requestAnimationFrame(() => focusCell(rowIndex + 1));
      } else {
        focusCell(rowIndex + 1);
      }
    },
    [],
  );

  /** Ctrl+V of a copied Excel column into a cell is the user's first
   * instinct — a multiline clipboard opens the paste preview instead of
   * dumping the blob into one input. */
  const onCellPaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (text.includes('\n') || text.includes('\t')) {
      e.preventDefault();
      setPasteText(text);
      setPasteOpen(true);
    }
  }, []);

  const parsedPaste = useMemo(() => {
    const lines = pasteText
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim());
    if (lines.length === 0) return [];
    if (lines.some((l) => l.includes('\t'))) {
      // Excel TSV — the deals importer's own pure parser (headers in four
      // languages, totals rows dropped).
      const cells: Cell[][] = lines.map((l) => l.split('\t').map((c) => c.trim()));
      return parseGoods(cells).goods.map((g) => ({
        name: g.description,
        quantity: g.quantity,
        unit: g.unit,
        weightKg: g.weightKg,
        volumeM3: g.volumeM3,
        tnvedCode: null as string | null,
      }));
    }
    // One product per line: «name, quantity, unit» — calc-send-form's shape.
    // The quantity is read by the ONE cell reader; an ambiguous one lands
    // empty rather than as a guess.
    return lines.map((line) => {
      const parts = line.split(/[,;]/).map((p) => p.trim());
      const cell = parts.length > 1 ? readNumberCell(parts[1]!) : null;
      return {
        name: parts[0]!,
        quantity: cell?.state === 'ok' ? cell.value : null,
        unit: parts[2] || null,
        weightKg: null,
        volumeM3: null,
        tnvedCode: null as string | null,
      };
    });
  }, [pasteText]);

  const applyPaste = () =>
    act(async () => {
      const rows = parsedPaste.filter((r) => r.name).slice(0, 500);
      // An unchanged line keeps its id; a changed line takes an id the last
      // press used and this one no longer matches (the typo fix becomes an
      // edit of the row that landed); only a line beyond those mints one.
      const ids = pasteIdsFor(pasteIds.current, rows.map((r) => JSON.stringify(r)), mintClientId);
      pasteIds.current = { keys: rows.map((r) => JSON.stringify(r)), ids };
      const result = await saveTableAction(id, {
        items: [],
        adds: rows.map((r, i) => ({ ...r, clientId: ids[i] ?? null })),
      });
      if (result.ok) {
        setPasteText('');
        setPasteOpen(false);
        pasteIds.current = { keys: [], ids: [] };
        knownRev.current = Math.max(knownRev.current, result.rev);
        setLastSave({
          ...EMPTY_SAVE,
          minted: result.minted ?? [],
          swept: result.swept ?? 0,
          merged: result.merged ?? [],
          alreadySaved: result.alreadySaved ?? 0,
          importFilled: result.importFilled ?? [],
          memoryFilled: result.memoryFilled ?? [],
        });
      }
      return result;
    });

  const busy = pending || saving;
  const unconfirmed = workspace.groups.filter((g) => g.confirmedAt === null).length;
  const unpriced = workspace.groups.filter((g) => !(liveCustomsByGroup.get(g.id)?.ok ?? false)).length;

  // Rendered row order: ungrouped first (the ⚠ pile a person must act on),
  // then each group's members — the DESKTOP grid walks this flat list so
  // Enter-down crosses group borders without caring about them. The block's
  // FOOTER renders after its last member, Excel's subtotal shape.
  const orderedRows: { item: WorkspaceItem; group: WorkspaceGroup | null }[] = [
    ...workspace.ungrouped.map((item) => ({ item, group: null as WorkspaceGroup | null })),
    ...workspace.groups.flatMap((group) => group.items.map((item) => ({ item, group }))),
  ];
  const lastIndex = orderedRows.length + newRows.length - 1;

  return (
    <section className="space-y-2" data-testid="calc-items">
      {/* ---- the sticky bar: progress, the one Saqlash, the gates ---- */}
      <div
        className="sticky top-14 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-raised/95 px-2 py-1.5 shadow-card backdrop-blur"
        data-testid="calc-bar"
      >
        <span className="text-2xs text-ink-600" data-testid="calc-progress">
          {allItems.length} {t('items')}
        </span>
        {workspace.ungrouped.length > 0 ? (
          <a className="chip chip-warn" href="#calc-ungrouped">
            ⚠ {t('ungrouped')}: {workspace.ungrouped.length}
          </a>
        ) : null}
        {unpriced > 0 ? (
          <a className="chip chip-warn" href={`#calc-g-${workspace.groups.find((g) => !(liveCustomsByGroup.get(g.id)?.ok ?? false))?.seq ?? 0}`}>
            ⚠ {t('table.unpriced')}: {unpriced}
          </a>
        ) : null}
        {liveTotals?.ok ? (
          <span className="font-mono text-sm font-semibold tabular-nums" data-testid="calc-bar-total">
            ${liveTotals.totalUsd.toFixed(2)}
            {dirtyCount > 0 ? (
              <span className="ml-1 align-middle text-2xs font-normal text-brand-700" data-testid="calc-live">
                {t('table.live')}
              </span>
            ) : null}
          </span>
        ) : null}
        {/* A live AI pass refuses every table write for ten minutes — said
            BEFORE a press, at every width, never only as a refusal after. */}
        {aiRunning ? (
          <span className="chip chip-warn" data-testid="calc-ai-running">
            {t('phone.aiRunning')}
          </span>
        ) : null}

        <span className="grow" />

        {/* Everything that ACTS on server state waits for the save — a ✅ or
            a seal over unsaved cells blesses numbers the server never saw. */}
        {gateCount > 0 ? (
          <span className="text-2xs text-warn" data-testid="calc-unsaved">
            {t('table.unsaved', { count: gateCount })}
          </span>
        ) : (
          <>
            <label className="flex items-center gap-1 text-2xs">
              <input
                type="checkbox"
                checked={workspace.hasCertificate}
                data-testid="calc-certificate"
                disabled={busy}
                onChange={(e) => act(() => setCertificateAction(id, e.target.checked))}
              />
              <span>{t('certificate')}</span>
            </label>
            {!workspace.hasCertificate ? (
              <span className="chip chip-warn" data-testid="calc-certificate-warn">
                ⚠ {t('certificateMissing')}
              </span>
            ) : null}
            {/* Desktop-only doors (his B3 a: no ✨ on the phone for now): an AI
                regroup or a mass baza pull has no place in a one-row sheet.
                The wrapper span is the hide — `.btn` is defined AFTER the
                utilities and its display beats a bare `hidden` (#419). */}
            <span className="hidden md:contents">
              {/* Not drawn at all on a server with no ANTHROPIC key (audit
                  A25): the press used to answer «ИИ не ответил», which reads
                  as «try again» and never becomes true. */}
              {workspace.aiConfigured ? (
                <button
                  type="button"
                  className="btn-secondary !min-h-8"
                  disabled={busy}
                  data-testid="calc-propose"
                  onClick={() => act(() => proposeAction(id))}
                >
                  ✨ {t('propose')}
                </button>
              ) : null}
              <button
                type="button"
                className="btn-secondary !min-h-8"
                disabled={busy}
                data-testid="calc-pull-bazas"
                onClick={() => act(() => pullBazasAction(id))}
              >
                {t('pullBazas')}
              </button>
            </span>
            {unconfirmed > 0 ? (
              <button
                type="button"
                className="btn-secondary !min-h-8"
                disabled={busy}
                data-testid="calc-confirm-all"
                onClick={() => act(() => confirmAllAction(id))}
              >
                {t('confirmAll')} ({unconfirmed})
              </button>
            ) : null}
          </>
        )}
        <span className="hidden md:contents">
          <button
            type="button"
            className="btn-primary !min-h-8"
            disabled={busy || !saveable}
            data-testid="calc-save-table"
            onClick={() => void save()}
          >
            {tc('save')}
            {dirtyCount > 0 ? ` (${dirtyCount})` : sweepable > 0 ? ` (${sweepable})` : ''}
          </button>
        </span>
      </div>

      {restore ? <DraftRestore plan={restore} onRestore={applyRestore} onDiscard={dropRestore} /> : null}

      {prunedCount > 0 ? (
        <p className="chip chip-warn" data-testid="calc-phone-pruned">
          {t('phone.pruned', { count: prunedCount })}
        </p>
      ) : null}

      {tableError ? (
        tableError.code === 'ambiguous_number' && tableError.field ? (
          // The phone asks under its own field (the sheet); this line is the
          // GRID's question, so it lives where the grid does.
          <div className="hidden md:block">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warn/40 bg-warn/10 px-2 py-1.5 text-sm" data-testid="calc-ambiguous">
              <span className="font-semibold text-warn">
                {tableError.seq !== undefined
                  ? tableError.seq < 0
                    ? `${t('table.newRowN', { n: -tableError.seq })}: `
                    : `${tableError.seq}${t('table.rowN')}: `
                  : ''}
                {tableError.field === 'bazaValue'
                  ? t('ambiguous.baza', { a: tableError.decimalText ?? '', b: tableError.thousandsText ?? '' })
                  : t('ambiguous.number', { a: tableError.decimalText ?? '', b: tableError.thousandsText ?? '' })}
              </span>
              <span className="text-2xs text-ink-600">{t('ambiguous.hint')}</span>
              {/* The two answers wrap TOGETHER: one alone on a line reads as
                  a third thing on the strip rather than the other choice. */}
              <span className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary !min-h-8 font-mono"
                  data-testid="calc-ambiguous-decimal"
                  onClick={() => resolveAmbiguous(tableError, tableError.decimalText ?? '')}
                >
                  {tableError.decimalText}
                </button>
                <button
                  type="button"
                  className="btn-secondary !min-h-8 font-mono"
                  data-testid="calc-ambiguous-thousands"
                  onClick={() => resolveAmbiguous(tableError, tableError.thousandsText ?? '')}
                >
                  {tableError.thousandsText}
                </button>
              </span>
            </div>
          </div>
        ) : (
          <p className="chip chip-warn" data-testid="calc-table-error">
            {tableError.seq !== undefined
              ? tableError.seq < 0
                ? `${t('table.newRowN', { n: -tableError.seq })}: `
                : `${tableError.seq}${t('table.rowN')}: `
              : ''}
            {t.has(`errors.${tableError.code}`)
              ? t(`errors.${tableError.code}` as 'errors.not_ready')
              : tableError.code}
            {tableError.code === 'stale_build' ? (
              <button
                type="button"
                className="btn-primary ml-2 !min-h-8"
                data-testid="calc-reload"
                onClick={() => void reloadFresh()}
              >
                {t('reloadPage')}
              </button>
            ) : null}
          </p>
        )
      ) : null}
      {lastSave &&
      (lastSave.minted.length > 0 ||
        lastSave.swept > 0 ||
        lastSave.merged.length > 0 ||
        lastSave.measuresCleared.length > 0 ||
        lastSave.measuresDropped.length > 0 ||
        lastSave.basisSuspect.length > 0 ||
        lastSave.basisConflict.length > 0 ||
        lastSave.alreadySaved > 0 ||
        lastSave.importFilled.length > 0 ||
        lastSave.memoryFilled.length > 0) ? (
        <p className="text-2xs text-ink-600" data-testid="calc-save-note">
          {[
            lastSave.minted.length > 0
              ? `${t('table.minted', { count: lastSave.minted.length })}: ${lastSave.minted.join(', ')}`
              : '',
            lastSave.swept > 0 ? t('table.swept', { count: lastSave.swept }) : '',
            lastSave.merged.length > 0 ? `${t('table.mergedNote')}: ${lastSave.merged.join(', ')}` : '',
            lastSave.measuresCleared.length > 0
              ? `${t('table.measureCleared')}: ${lastSave.measuresCleared.join(', ')}`
              : '',
            lastSave.measuresDropped.length > 0
              ? `${t('table.measureDropped')}: ${lastSave.measuresDropped.join(', ')}`
              : '',
            lastSave.basisSuspect.length > 0
              ? `⚠ ${t('table.basisSuspect')}: ${lastSave.basisSuspect.join(', ')}`
              : '',
            lastSave.basisConflict.length > 0
              ? `⚠ ${t('table.basisConflict')}: ${lastSave.basisConflict.join(', ')}`
              : '',
            lastSave.alreadySaved > 0
              ? t('table.alreadySaved', { count: lastSave.alreadySaved })
              : '',
            lastSave.importFilled.length > 0
              ? `📥 ${t('table.importFilled', { count: lastSave.importFilled.length })}: ${lastSave.importFilled.join(', ')}`
              : '',
            lastSave.memoryFilled.length > 0
              ? `🧠 ${t('table.memoryFilled', { count: lastSave.memoryFilled.length })}: ${lastSave.memoryFilled.join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}

      {/* ---- desktop: the editable grid ---- */}
      <div className="hidden md:block">
        <div className="card !p-0">
          <div className="overflow-x-auto rounded-xl">
            <table className="w-full min-w-[880px] table-fixed text-sm" data-testid="calc-table">
              <colgroup>
                <col className="w-10" />
                <col />
                <col className="w-16" />
                <col className="w-20" />
                <col className="w-20" />
                <col className="w-32" />
                {/* The baza column: a 56px amount, the 64px unit select
                    (BasisSelect, measured) and the gap, inside the cell's
                    own padding. */}
                <col className="w-36" />
                <col className="w-9" />
              </colgroup>
              <thead>
                <tr className="border-b border-line-strong bg-surface-sunken text-left text-2xs uppercase tracking-wide text-ink-500">
                  <th className="p-2">#</th>
                  <th className="p-2">{t('goods')}</th>
                  <th className="p-2 text-center">📦</th>
                  <th className="p-2 text-center">kg</th>
                  <th className="p-2 text-center">m³</th>
                  <th className="p-2">TNVED</th>
                  <th className="p-2">{t('baza')}</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {workspace.ungrouped.length > 0 ? (
                  <tr id="calc-ungrouped" className="scroll-mt-28 border-b border-line bg-warn/10">
                    <td className="p-2 text-2xs text-warn" colSpan={8} data-testid="calc-ungrouped-head">
                      ⚠ {t('ungrouped')}: {workspace.ungrouped.length} — {t('table.typeCode')}
                    </td>
                  </tr>
                ) : null}
                {orderedRows.map((row, index) => (
                  <ItemRowBlock
                    key={row.item.id}
                    id={id}
                    row={row}
                    index={index}
                    lastIndex={lastIndex}
                    endsGroup={
                      row.group !== null &&
                      (index === orderedRows.length - 1 || orderedRows[index + 1]!.group !== row.group)
                    }
                    liveCustoms={row.group ? (liveCustomsByGroup.get(row.group.id) ?? null) : null}
                    liveBaza={row.group ? (liveBazaByGroup.get(row.group.id) ?? null) : null}
                    liveBasisNotLaw={row.group ? (liveBasisNotLawByGroup.get(row.group.id) ?? false) : false}
                    drafts={drafts[row.item.id]}
                    groupById={groupById}
                    groupsByCode={groupsByCode}
                    busy={busy}
                    dirty={gateCount > 0}
                    act={act}
                    setDraft={setDraft}
                    clearDraft={clearDraft}
                    markOwnDelete={markOwnDelete}
                    onPickBaza={setPicker}
                    onCellKey={onCellKey}
                    onCellPaste={onCellPaste}
                  />
                ))}
                {newRows.map((row, i) => (
                  <NewRowCells
                    key={row.key}
                    row={row}
                    index={orderedRows.length + i}
                    lastIndex={lastIndex}
                    groupsByCode={groupsByCode}
                    onPatch={patchGhost}
                    onRemove={removeGhost}
                    onCellKey={onCellKey}
                    onCellPaste={onCellPaste}
                  />
                ))}
              </tbody>
            </table>
            <div className="flex border-t border-line">
              <button
                type="button"
                className="grow p-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"
                data-testid="calc-add-row"
                onClick={() => setNewRows((rows) => [...rows, emptyRow(newKey.current++)])}
              >
                ＋ {t('table.addRow')}
              </button>
              <button
                type="button"
                className="grow border-l border-line p-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"
                data-testid="calc-paste-open"
                onClick={() => setPasteOpen((v) => !v)}
              >
                📋 {t('table.paste')}
              </button>
            </div>
          </div>
        </div>

        {pasteOpen ? (
          <div className="card mt-2 !p-3" data-testid="calc-paste">
            <p className="text-2xs text-ink-500">{t('table.pasteHint')}</p>
            <textarea
              className="input mt-1 h-28 w-full font-mono text-xs"
              data-testid="calc-paste-text"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={busy || parsedPaste.length === 0}
                data-testid="calc-paste-apply"
                onClick={applyPaste}
              >
                {t('table.pasteAdd', { count: Math.min(parsedPaste.length, 500) })}
              </button>
              {parsedPaste.length > 500 ? (
                <span className="text-2xs text-warn">{t('table.pasteCap')}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* ONE dialog for the table, kept mounted and toggled (#684). The key
          that makes a stale answer impossible lives on its BODY, inside. A
          pick from the phone sheet sends the VED back to that sheet. */}
      <ImportBazaDialog
        target={picker}
        onClose={() => {
          setPicker(null);
          const back = pickerReturn.current;
          pickerReturn.current = null;
          if (back) setSheet(back);
        }}
        onPick={pickImport}
      />
      {/* …and ONE row sheet, the same way (#684): mounted once, the body
          keyed per row inside. */}
      <RowSheet
        open={sheet !== null && sheetModel !== null}
        model={sheetModel}
        codesListId={`codes-${id}`}
        busy={busy || pressing}
        saveDisabled={busy || pressing || aiRunning || wait.state === 'awaiting' || !sheetHasPost}
        saveAnyway={mustConfirm.length > 0 || wait.state === 'timedOut'}
        deleteAnyway={deleteWarn !== null}
        error={sheetError}
        aiRunning={aiRunning}
        refreshing={wait.state === 'awaiting'}
        changes={shownChanges}
        changedElsewhere={changedElsewhere}
        asked={askedNow}
        onField={onSheetField}
        onBasis={onSheetBasis}
        onAsk={onSheetAsk}
        onImport={openPickerFromSheet}
        onSave={() => void saveSheetRow()}
        onDelete={() => void deleteSheetRow()}
        onDiscard={discardSheetRow}
        onClose={closeSheet}
      />

      {/* One datalist feeds every code cell: repeats become 2-3 digits and a
          pick — 100 items over 5 codes must not cost 1 000 keystrokes. */}
      <datalist id={`codes-${id}`}>
        {codesInRequest.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>

      {/* ---- phone: the same rows as cards, each opening its own sheet ---- */}
      <PhoneBlocks
        workspace={workspace}
        drafts={drafts}
        ghosts={dirtyGhosts}
        liveCustomsByGroup={liveCustomsByGroup}
        liveBazaByGroup={liveBazaByGroup}
        groupById={groupById}
        groupsByCode={groupsByCode}
        gateCount={gateCount}
        dirtyCount={dirtyCount}
        sweepable={sweepable}
        nextDraft={nextDraft}
        rowGone={rowGone}
        busy={busy}
        act={act}
        onOpenItem={openItemSheet}
        onOpenGhost={openGhostSheet}
        onAdd={addGhostAndOpen}
        onSweep={() => void save()}
      />

      {workspace.reconcile.mismatch ? (
        <p className="text-2xs text-warn" data-testid="calc-reconcile">
          ⚠{' '}
          {t('reconcile', {
            groupKg: workspace.reconcile.groupKg ?? 0,
            groupM3: workspace.reconcile.groupM3 ?? 0,
            kg: workspace.weightKg ?? 0,
            m3: workspace.volumeM3 ?? 0,
          })}
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/** A typed comma the reader cannot decide (B4 a) is marked on the cell
 * itself — the question is in the error line above the grid. */
const cellBorder = (raw: string | undefined, drafted: boolean) =>
  raw !== undefined && readNumberCell(raw).state === 'ambiguous'
    ? ' border-warn'
    : drafted
      ? ' border-brand-500'
      : '';

/**
 * One item row, its O'lchov sub-line when the code asks an extended unit,
 * and the block FOOTER when the block ends here (Excel's subtotal shape).
 *
 * Memo'd on its own slice: 100 rows × controlled inputs re-rendering on
 * every keystroke is the round-70 board freeze in a grid's clothes — a row
 * whose props did not move must not pay for its neighbour's typing. The
 * block footer's live figure rides `liveCustoms`, which only changes when a
 * member's draft does.
 */
const ItemRowBlock = memo(function ItemRowBlock({
  id,
  row,
  index,
  lastIndex,
  endsGroup,
  liveCustoms,
  liveBaza,
  liveBasisNotLaw,
  drafts,
  groupById,
  groupsByCode,
  busy,
  dirty,
  act,
  setDraft,
  clearDraft,
  markOwnDelete,
  onPickBaza,
  onCellKey,
  onCellPaste,
}: {
  id: string;
  row: { item: WorkspaceItem; group: WorkspaceGroup | null };
  index: number;
  lastIndex: number;
  endsGroup: boolean;
  liveCustoms: CustomsResult | null;
  liveBaza: { bazaUsd: number; bazaBasis: BazaBasis } | null;
  liveBasisNotLaw: boolean;
  drafts: ItemDraft | undefined;
  groupById: Map<string, WorkspaceGroup>;
  groupsByCode: Map<string, WorkspaceGroup>;
  busy: boolean;
  dirty: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  setDraft: (itemId: string, field: keyof ItemDraft, raw: string) => void;
  clearDraft: (itemId: string) => void;
  markOwnDelete: (itemId: string) => void;
  onPickBaza: (target: PickerTarget) => void;
  onCellKey: (e: React.KeyboardEvent<HTMLInputElement>, col: string, rowIndex: number, lastIndex: number) => void;
  onCellPaste: (e: React.ClipboardEvent) => void;
}) {
  const t = useTranslations('calc');
  const item = row.item;
  // The ONE answer the select, the O'lchov line, the live figure and the
  // save all read (screenRowOf) — the drafted code's law, the unit on screen.
  const screen = screenRowOf(item, drafts, groupById, groupsByCode);
  // Per-row and LOCAL. Lifting «only one fold open» above a memo'd row is
  // round 70's board freeze in a grid's clothes, and two open folds harm
  // nothing — the ⚙ has allowed exactly that since the workspace shipped.
  const [menuOpen, setMenuOpen] = useState(false);

  const cell = (col: 'name' | 'quantity' | 'weightKg' | 'volumeM3' | 'tnvedCode', extra = '') => {
    const server =
      col === 'name'
        ? item.label
        : col === 'tnvedCode'
          ? (item.tnvedCode ?? '')
          : String(item[col] ?? '');
    const value = drafts?.[col] ?? server;
    return (
      <input
        className={`input-cell ${extra}${cellBorder(col === 'name' || col === 'tnvedCode' ? undefined : drafts?.[col], drafts?.[col] !== undefined)}`}
        aria-label={`${col} ${item.seq}`}
        data-cell={col}
        data-row={index}
        inputMode={col === 'name' ? undefined : col === 'tnvedCode' ? 'numeric' : 'decimal'}
        list={col === 'tnvedCode' ? `codes-${id}` : undefined}
        value={value}
        disabled={busy}
        onChange={(e) => setDraft(item.id, col, e.target.value)}
        onKeyDown={(e) => onCellKey(e, col, index, lastIndex)}
        onPaste={onCellPaste}
      />
    );
  };

  const bazaValue = drafts?.bazaValue ?? (item.bazaUsd === null ? '' : String(item.bazaUsd));
  // The measure sub-line: when the law counts in a pair unit, when the BASIS
  // is one (an m² baza on an advalor code — 0125), or the generic box while a
  // drafted code's law is unknown. A stored pair in the WRONG unit renders as
  // an EMPTY box (the old number under a new suffix would price something
  // nobody measured).
  const pair = screen.pair;
  const measureServer =
    pair !== null && (pair === 'any' || item.measureUnit === pair) && item.measureQty !== null
      ? String(item.measureQty)
      : '';
  const measureValue = drafts?.measure ?? measureServer;

  return (
    <>
      <tr
        id={`calc-i-${item.seq}`}
        className="scroll-mt-28 border-b border-line/60 last:border-0"
        data-testid="calc-row"
      >
        <td className="p-1.5 text-center font-mono text-2xs text-ink-500">{item.seq}</td>
        <td className="p-1.5">{cell('name')}</td>
        <td className="p-1.5">
          {cell('quantity', 'text-center')}
          {/* His 20a: the SELLER's own word («шт», «кг», «компл») beside the
              count, muted and DISPLAY ONLY — nothing posts it and the engine
              never reads it. What the baza is per is the select's question. */}
          {item.unit ? (
            <span
              className="mt-0.5 block truncate text-center text-2xs text-ink-500"
              data-testid="calc-item-unit"
              title={item.unit}
            >
              {item.unit}
            </span>
          ) : null}
        </td>
        <td className="p-1.5">{cell('weightKg', 'text-right font-mono tabular-nums')}</td>
        <td className="p-1.5">{cell('volumeM3', 'text-right font-mono tabular-nums')}</td>
        <td className="p-1.5">{cell('tnvedCode', 'font-mono tabular-nums')}</td>
        <td className="p-1.5">
          <span className="flex items-center gap-1">
            <input
              className={`input-cell !w-14 text-right font-mono tabular-nums${cellBorder(drafts?.bazaValue, drafts?.bazaValue !== undefined)}`}
              aria-label={`${t('baza')} ${item.seq}`}
              data-cell="bazaValue"
              data-row={index}
              data-testid="calc-baza"
              inputMode="decimal"
              value={bazaValue}
              disabled={busy}
              onChange={(e) => setDraft(item.id, 'bazaValue', e.target.value)}
              onKeyDown={(e) => onCellKey(e, 'bazaValue', index, lastIndex)}
              onPaste={onCellPaste}
            />
            <BasisSelect
              value={screen.basis}
              offered={screen.offered}
              label={`${t('basis')} ${item.seq}`}
              testId="calc-basis"
              drafted={drafts?.bazaBasis !== undefined}
              disabled={busy}
              // ONE edit: the pair rule drafts the amount as it stands beside
              // the unit, so the save posts a coherent pair (baza-draft.ts).
              onPick={(b) => setDraft(item.id, 'bazaBasis', b)}
              size="cell"
            />
          </span>
          {/* 0094: the price came out of the customs dump and nobody has
              retyped it. A draft on the amount hides the chip — the number on
              the screen is then the VED's, not the file's. */}
          {item.bazaSource === 'import' && drafts?.bazaValue === undefined ? (
            <span
              className="mt-0.5 block truncate text-2xs text-ink-500"
              data-testid="calc-baza-import"
              title={t('importGuessTitle')}
            >
              📥 {t('importGuess')}
            </span>
          ) : null}
          {/* 0096: the price is this company's own sealed answer on an earlier
              job. Same rule as the 📥 chip — a draft on the amount hides it,
              because the number on the screen is then the VED's. */}
          {item.bazaSource === 'memory' && drafts?.bazaValue === undefined ? (
            <span
              className="mt-0.5 block truncate text-2xs text-ink-500"
              data-testid="calc-baza-memory"
              title={t('memoryGuessTitle', {
                who: item.memoryFrom?.sealedByName ?? '—',
                date: item.memoryFrom ? item.memoryFrom.sealedAt.slice(0, 10) : '—',
              })}
            >
              🧠 {t('memoryGuess')}
            </span>
          ) : null}
          {/* 0096, owed since #909: the model's own reason for choosing THIS
              declaration. Without it a pick and the deterministic auto-fill
              landed identically and the VED could not tell which had put the
              number there. */}
          {item.bazaReason && drafts?.bazaValue === undefined ? (
            <span
              className="mt-0.5 block truncate text-2xs text-ink-500"
              data-testid="calc-baza-reason"
              title={item.bazaReason}
            >
              🤖 {item.bazaReason}
            </span>
          ) : null}
          {item.dictionaryBaza ? (
            <span className="mt-0.5 block truncate text-2xs text-ink-500" title={item.dictionaryBaza.effectiveDate}>
              ≈ ${item.dictionaryBaza.bazaUsd}/{basisLabel(item.dictionaryBaza.basis, t('perUnit'))}
              {item.dictionaryBaza.stale ? (
                <span className="ml-1 text-warn" data-testid="calc-baza-stale">
                  ⚠ {t('stale')}
                </span>
              ) : null}
            </span>
          ) : null}
        </td>
        <td className="p-1.5 text-center">
          {/* A touch box, not a 14px glyph: from 768px up this table is also
              what a tablet in portrait shows, and the ⋯ is now the door to
              both the note and the declaration picker. */}
          <button
            type="button"
            className="inline-flex min-h-11 min-w-9 items-center justify-center text-ink-400 hover:text-ink-900"
            aria-label={`⋯ ${item.seq}`}
            data-testid="calc-item-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
        </td>
      </tr>
      {menuOpen ? (
        <ItemFold
          id={id}
          item={item}
          busy={busy}
          act={act}
          setDraft={setDraft}
          clearDraft={clearDraft}
          markOwnDelete={markOwnDelete}
          onPickBaza={onPickBaza}
          noteDraft={drafts?.note}
          draftBasis={drafts?.bazaBasis}
          draftBazaValue={drafts?.bazaValue}
          rowDirty={rowDirtyForPicker(drafts)}
          screenBasis={screen.basis}
          onDone={() => setMenuOpen(false)}
        />
      ) : null}
      {pair !== null ? (
        <tr className="border-b border-line/60 text-2xs">
          <td />
          <td className="px-1.5 pb-1.5" colSpan={7}>
            <span className="flex items-center gap-1 text-ink-600">
              <span>
                {pair === 'any'
                  ? t('table.measureGhost')
                  : t('table.measureFor', { unit: basisLabel(pair, t('perUnit')) })}
              </span>
              <input
                className={`input-cell !w-24 text-right font-mono tabular-nums${cellBorder(drafts?.measure, drafts?.measure !== undefined)}`}
                aria-label={`measure ${item.seq}`}
                data-cell="measure"
                data-row={index}
                data-testid="calc-measure"
                inputMode="decimal"
                value={measureValue}
                disabled={busy}
                onChange={(e) => setDraft(item.id, 'measure', e.target.value)}
                onKeyDown={(e) => onCellKey(e, 'measure', index, lastIndex)}
              />
              {pair !== 'any' ? <span>{basisLabel(pair, t('perUnit'))}</span> : null}
              {/* The sm³ convention outlives the placeholder — a filled cell
                  must still say what its number means. */}
              {pair === 'sm3' ? <span className="text-ink-500">· {t('table.sm3Hint')}</span> : null}
            </span>
          </td>
        </tr>
      ) : null}
      {endsGroup && row.group ? (
        <BlockFooter
          id={id}
          group={row.group}
          liveCustoms={liveCustoms}
          liveBaza={liveBaza}
          liveBasisNotLaw={liveBasisNotLaw}
          busy={busy}
          dirty={dirty}
          act={act}
        />
      ) : null}
    </>
  );
});

/**
 * The declaration block's footer: the code, the law (grey = the
 * dictionary's word, black = typed over it), the value, the LIVE customs
 * figure (⚠ + reason, never $0), the ✅ and the suggestion buttons — the
 * self-announcing ones stay VISIBLE here, because a suggestion inside a
 * closed fold announces to nobody at exactly the moment a wrong confirm
 * happens.
 */
function BlockFooter({
  id,
  group,
  liveCustoms,
  liveBaza,
  liveBasisNotLaw,
  busy,
  dirty,
  act,
}: {
  id: string;
  group: WorkspaceGroup;
  liveCustoms: CustomsResult | null;
  liveBaza: { bazaUsd: number; bazaBasis: BazaBasis } | null;
  liveBasisNotLaw: boolean;
  busy: boolean;
  dirty: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
}) {
  const t = useTranslations('calc');
  const [open, setOpen] = useState(false);
  const customs = liveCustoms ?? group.customs;

  return (
    <>
      <tr
        id={`calc-g-${group.seq}`}
        className="scroll-mt-28 border-b border-line bg-surface-sunken/60"
        data-testid="calc-group-row"
      >
        <td className="p-1.5 text-center">
          {group.confirmedAt ? (
            <span className="text-2xs text-good" data-testid="calc-group-ok">
              ✅
            </span>
          ) : null}
        </td>
        <td className="p-1.5" colSpan={5}>
          <span className="font-mono font-semibold tabular-nums">{group.tnvedCode ?? '—'}</span>
          {group.aiProposed && group.confirmedAt === null ? (
            <span className="ml-1 chip chip-warn" data-testid="calc-group-ai">
              ✨ {group.aiConfidence ?? '—'}
            </span>
          ) : null}
          {/* The law in one phrase — grey while it is the dictionary's own
              word, ink once a person typed over it. */}
          <span
            className={`ml-2 text-2xs ${group.rateSource === 'typed' ? 'text-ink-900' : 'text-ink-500'}`}
            data-testid="calc-group-rates"
          >
            {group.dutyFree ? t('dutyFree') : dutyText(group)} ·{' '}
            {group.vatFree ? t('vatFree') : `${t('vat')} ${group.vatPct ?? '—'}%`}
          </span>
          {/* The book answered WITH a condition (the clauseCut vehicle rows) —
              a visible chip, not a hover title: a placeholder announces to
              nobody, and the confirm records `rate_noted`. */}
          {group.rateSource === 'dictionary' && group.dictionaryRates?.note ? (
            <span className="ml-1 chip chip-warn" data-testid="calc-note-warn" title={group.dictionaryRates.note}>
              ⚠ {t('table.rateNoted')}
            </span>
          ) : null}
          {customs.ok && customs.addDutyUsd > 0 ? (
            <span className="ml-1 text-2xs text-warn">
              +{customs.addDutyPct}% (${customs.addDutyUsd.toFixed(2)})
            </span>
          ) : null}
          {/* Item 1 (the owner's own example): the block's one baza is the
              line he reads — «baza 2$ za kg» — with the declared value kept
              beside it, visible, never a hover title (#420). Mixed bazas
              have no one number, so the value stands alone there. */}
          {liveBaza ? (
            <span className="ml-2 text-2xs text-ink-700" data-testid="calc-group-baza">
              {t('baza')}{liveBaza.bazaUsd}/{basisLabel(liveBaza.bazaBasis, t('perUnit'))}
            </span>
          ) : null}
          {/* A1 (0125): a priced row in this block is per another unit than
              the one the law counts in. Allowed — the baza is the row's own
              question — but VISIBLE, and the ✅ records it; silent on an
              advalor code, which pins no unit at all. */}
          {liveBasisNotLaw && group.dutyUnit ? (
            <span className="ml-1 chip chip-warn" data-testid="calc-basis-not-law">
              ⚠ {t('table.basisNotLaw', { unit: basisLabel(defaultBasisFor(group), t('perUnit')) })}
            </span>
          ) : null}
          {customs.ok ? (
            <span className="ml-2 text-2xs text-ink-500">
              {t('value')} ${customs.valueUsd.toFixed(2)}
            </span>
          ) : null}
          {group.dictionaryRates && group.rateSource !== 'dictionary' && !dirty ? (
            <button
              type="button"
              className="ml-2 text-2xs underline"
              disabled={busy}
              data-testid="calc-pull-rates"
              onClick={() => act(() => pullRatesAction(id, group.id))}
            >
              {t('pullRates')}: {dutyText(group.dictionaryRates)} / {group.dictionaryRates.vatPct}%
            </button>
          ) : null}
          {group.rateSource === 'typed' &&
          group.tnvedCode &&
          group.dutyPct !== null &&
          group.vatPct !== null &&
          !dirty &&
          (!group.dictionaryRates ||
            group.dictionaryRates.dutyPct !== group.dutyPct ||
            group.dictionaryRates.vatPct !== group.vatPct ||
            group.dictionaryRates.feeUsd !== (group.feeUsd ?? 0)) ? (
            <button
              type="button"
              className="ml-2 text-2xs underline"
              disabled={busy}
              data-testid="calc-teach-rates"
              onClick={() =>
                act(() =>
                  saveRatesAction({
                    tnvedCode: group.tnvedCode!,
                    dutyPct: group.dutyPct!,
                    vatPct: group.vatPct!,
                    effectiveDate: tashkentDay(),
                    source: 'correction',
                  }),
                )
              }
            >
              {t('teachRates')}
            </button>
          ) : null}
          {group.lgotaLast &&
          group.confirmedAt === null &&
          !dirty &&
          (group.lgotaLast.dutyFree !== group.dutyFree || group.lgotaLast.vatFree !== group.vatFree) ? (
            <button
              type="button"
              className="ml-2 text-2xs underline"
              disabled={busy}
              data-testid="calc-lgota-last"
              onClick={() =>
                act(() =>
                  setRatesAction(id, group.id, {
                    label: group.label,
                    tnvedCode: group.tnvedCode ?? '',
                    dutyPct: group.dutyPct,
                    vatPct: group.vatPct,
                    dutyFree: group.lgotaLast!.dutyFree,
                    vatFree: group.lgotaLast!.vatFree,
                  }),
                )
              }
            >
              {t('lgotaLast')}
              {group.lgotaLast.dutyFree ? ` · ${t('dutyFree')}` : ''}
              {group.lgotaLast.vatFree ? ` · ${t('vatFree')}` : ''}
            </button>
          ) : null}
          {group.confirmedAt === null && !dirty ? (
            <button
              type="button"
              className="ml-2 text-2xs underline text-good"
              disabled={busy}
              data-testid="calc-confirm-group"
              onClick={() => act(() => confirmGroupAction(id, group.id))}
            >
              {t('confirm')}
            </button>
          ) : null}
        </td>
        <td className="p-1.5 text-right font-mono tabular-nums" data-testid="calc-group-customs">
          {customs.ok ? (
            `$${customs.customsUsd.toFixed(2)}`
          ) : (
            <span className="text-warn">
              ⚠ {t.has(`refusals.${customs.reason}`)
                ? t(`refusals.${customs.reason}` as 'refusals.rates_missing')
                : customs.reason}
            </span>
          )}
        </td>
        <td className="p-1.5 text-center">
          <button
            type="button"
            className="btn-secondary !min-h-8 !px-2"
            data-testid="calc-group-edit"
            onClick={() => setOpen((v) => !v)}
          >
            ⚙
          </button>
        </td>
      </tr>
      {open ? <GroupFold id={id} group={group} busy={busy} act={act} onDone={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The ⚙ escape hatch: rates and the lgota by hand. Deliberately WITHOUT a
 * TNVED input — the code is minted by the item rows, and a second writer
 * would let the block's identity drift from its members'. Rendered as a
 * full-width fold, never a popover: the grid's own scroll container clips
 * anything absolutely positioned inside it.
 */
function GroupFold({
  id,
  group,
  busy,
  act,
  onDone,
}: {
  id: string;
  group: WorkspaceGroup;
  busy: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  onDone: () => void;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const [duty, setDuty] = useState(group.dutyPct === null ? '' : String(group.dutyPct));
  const [vat, setVat] = useState(group.vatPct === null ? '' : String(group.vatPct));
  const [dutyFree, setDutyFree] = useState(group.dutyFree);
  const [vatFree, setVatFree] = useState(group.vatFree);
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

  return (
    <tr className="border-b border-line bg-surface-sunken">
      <td className="p-2" colSpan={8}>
        <div className="flex flex-wrap items-end gap-2" data-testid="calc-group-form">
          <label className="text-2xs">
            <span className="label">{t('duty')} %</span>
            <input className="input input-sm !w-20" data-testid="calc-duty" value={duty} onChange={(e) => setDuty(e.target.value)} />
          </label>
          <label className="text-2xs">
            <span className="label">{t('vat')} %</span>
            <input className="input input-sm !w-20" data-testid="calc-vat" value={vat} onChange={(e) => setVat(e.target.value)} />
          </label>
          {/* The per-group «Сбор $» box is GONE (audit A2). The declaration
              fee is one per DECLARATION and the engine adds it once (#858) —
              a number typed here was added AGAIN inside every group's own
              customs, so a $50 «fee» on three groups charged the client $150
              on top of the automatic BHM figure. The one fee door is the
              request-level override under the totals. */}
          <label className="flex items-center gap-1 text-2xs">
            <input type="checkbox" checked={dutyFree} onChange={(e) => setDutyFree(e.target.checked)} />
            {t('dutyFree')}
          </label>
          <label className="flex items-center gap-1 text-2xs">
            <input type="checkbox" checked={vatFree} onChange={(e) => setVatFree(e.target.checked)} />
            {t('vatFree')}
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            data-testid="calc-save-rates"
            onClick={() =>
              act(async () => {
                const result = await setRatesAction(id, group.id, {
                  label: group.label,
                  tnvedCode: group.tnvedCode ?? '',
                  dutyPct: num(duty),
                  vatPct: num(vat),
                  dutyFree,
                  vatFree,
                });
                if (!result.error) onDone();
                return result;
              })
            }
          >
            {tc('save')}
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * The item's ⋯: a FULL-WIDTH FOLD, never a popover.
 *
 * It was a `absolute … w-72` panel inside the grid's `overflow-x-auto`
 * wrapper — and CSS computes the other axis to `auto` when one is not
 * `visible`, so it was clipped on both. The owner's screenshot shows its
 * delete button cut off by that edge. The answer already existed one
 * component down with its reason written in a comment: `GroupFold` is a fold
 * for exactly this, and the ⚙ has opened one since the workspace shipped.
 * The ITEM's ⋯ simply never got the same treatment.
 *
 * The note gets room without fighting the cascade (#419): `.input` carries
 * `w-full`, so instead of an `!w-…` override the LABEL is given a width and
 * the input fills it. Capped rather than `flex-1`: the table is
 * `min-w-[880px]` and at 768 the window onto it is ~512px after the sidebar,
 * so a note that eats the row's slack puts its own caret off-screen.
 */
function ItemFold({
  id,
  item,
  busy,
  act,
  setDraft,
  clearDraft,
  markOwnDelete,
  onPickBaza,
  noteDraft,
  draftBasis,
  draftBazaValue,
  rowDirty,
  screenBasis,
  onDone,
}: {
  id: string;
  item: WorkspaceItem;
  busy: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  setDraft: (itemId: string, field: keyof ItemDraft, raw: string) => void;
  clearDraft: (itemId: string) => void;
  markOwnDelete: (itemId: string) => void;
  onPickBaza: (target: PickerTarget) => void;
  noteDraft: string | undefined;
  /** A unit picked and not yet saved — the picker ranks by it (0125). */
  draftBasis: BazaBasis | undefined;
  /** The baza amount as typed and not yet saved — the «siz» marker's value. */
  draftBazaValue: string | undefined;
  /**
   * The code, count, weight or volume is drafted (a draft equal to the
   * saved value deletes itself, so «present» means «differs»). Both routes
   * read those off the SAVED row, so the list, the unit tabs, `matches`,
   * `pickable` and the ±25 % band would all describe the old row — and a pick
   * against a new code fails at save with `import_row_missing`.
   */
  rowDirty: boolean;
  /** The unit the select SHOWS — `screenRowOf`'s answer (0125's one chain),
   * never `draft ?? stored`, which is null on an untouched «avto» row whose
   * select shows the law's unit. */
  screenBasis: BazaBasis | null;
  onDone: () => void;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  return (
    <tr className="border-b border-line bg-surface-sunken text-2xs">
      <td className="p-2" colSpan={8}>
        <div className="flex flex-wrap items-end gap-2" data-testid="calc-item-form">
          <button
            type="button"
            className="btn-secondary !min-h-8 text-bad"
            disabled={busy}
            data-testid="calc-item-delete"
            onClick={() => {
              const hasData = item.bazaUsd !== null || item.quantity !== null || item.weightKg !== null;
              if (hasData && !window.confirm(`${tc('delete')}? ${item.label}`)) return;
              // The draft that dies with the row is OURS — never counted as
              // «boshqa kishi o'chirdi».
              markOwnDelete(item.id);
              act(async () => {
                const result = await deleteItemAction(id, item.id);
                if (!result.error) {
                  clearDraft(item.id);
                  onDone();
                }
                return { ok: result.ok, error: result.error };
              });
            }}
          >
            🗑 {tc('delete')}
          </button>
          {/* The customs dump's own answer for this code (0094). Offered on
              every coded row, not only the empty ones: his rule is that the
              VED decides, and a wrong auto-fill must be replaceable with the
              right declaration rather than only with a typed number. */}
          {item.tnvedCode ? (
            <button
              type="button"
              className="btn-secondary !min-h-8"
              data-testid="calc-import-pick"
              disabled={rowDirty}
              onClick={() => {
                // The ONE cell reader: «abc» or an ambiguous «1,125» is no
                // marker — a marker at `left: NaN%` must never be drawn.
                const cell =
                  draftBazaValue !== undefined
                    ? readNumberCell(draftBazaValue)
                    : item.bazaUsd === null
                      ? ({ state: 'empty' } as const)
                      : ({ state: 'ok', value: item.bazaUsd } as const);
                onPickBaza({
                  itemId: item.id,
                  name: item.label,
                  tnvedCode: item.tnvedCode!,
                  basis: draftBasis ?? null,
                  current:
                    screenBasis !== null && cell.state === 'ok' && cell.value > 0
                      ? { usd: cell.value, basis: screenBasis }
                      : null,
                });
              }}
            >
              📥 {t('importPick')}
              {rowDirty ? <span className="text-2xs font-normal text-warn">· {t('statsRowDirty')}</span> : null}
            </button>
          ) : null}
          <label className="w-full max-w-[22rem]">
            <span className="label">{t('table.note')}</span>
            <input
              className="input input-sm"
              data-testid="calc-item-note"
              value={noteDraft ?? item.note ?? ''}
              onChange={(e) => setDraft(item.id, 'note', e.target.value)}
            />
          </label>
        </div>
      </td>
    </tr>
  );
}

/** A ghost row: typed locally, born on the next Saqlash — code, baza and
 * even the extended measure in ONE save. The O'lchov box renders on every
 * ghost (the law shape is unknowable before the save); a qty typed against
 * a code that needs none is DROPPED with a named note, never refused. */
function NewRowCells({
  row,
  index,
  lastIndex,
  groupsByCode,
  onPatch,
  onRemove,
  onCellKey,
  onCellPaste,
}: {
  row: NewRow;
  index: number;
  lastIndex: number;
  /** The request's blocks by code — the one a typed code would join says
   * which units the row may take (`ghostScreenOf`). */
  groupsByCode: Map<string, WorkspaceGroup>;
  onPatch: (key: number, patch: Partial<NewRow>) => void;
  onRemove: (key: number) => void;
  onCellKey: (e: React.KeyboardEvent<HTMLInputElement>, col: string, rowIndex: number, lastIndex: number) => void;
  onCellPaste: (e: React.ClipboardEvent) => void;
}) {
  const t = useTranslations('calc');
  // The basis select and its offered units — the SAME answer the phone
  // sheet's ghost reads. The O'lchov box below is drawn on every ghost.
  const screen = ghostScreenOf(row, groupsByCode);
  const cell = (col: 'name' | 'quantity' | 'weightKg' | 'volumeM3' | 'tnvedCode', extra = '') => (
    <input
      className={`input-cell ${extra}${cellBorder(col === 'name' || col === 'tnvedCode' ? undefined : row[col], false)}`}
      aria-label={`new ${col} ${row.key}`}
      data-cell={col}
      data-row={index}
      data-testid="calc-new-cell"
      inputMode={col === 'name' ? undefined : col === 'tnvedCode' ? 'numeric' : 'decimal'}
      value={row[col]}
      onChange={(e) => onPatch(row.key, { [col]: e.target.value })}
      onKeyDown={(e) => onCellKey(e, col, index, lastIndex)}
      onPaste={onCellPaste}
    />
  );
  return (
    <>
      <tr className="border-b border-line/30 bg-brand-50/40" data-testid="calc-new-row">
        <td className="p-1.5 text-center text-2xs text-brand-700">＋</td>
        <td className="p-1.5">{cell('name')}</td>
        <td className="p-1.5">{cell('quantity', 'text-center')}</td>
        <td className="p-1.5">{cell('weightKg', 'text-right font-mono tabular-nums')}</td>
        <td className="p-1.5">{cell('volumeM3', 'text-right font-mono tabular-nums')}</td>
        <td className="p-1.5">{cell('tnvedCode', 'font-mono tabular-nums')}</td>
        <td className="p-1.5">
          <span className="flex items-center gap-1">
            <input
              className={`input-cell !w-14 text-right font-mono tabular-nums${cellBorder(row.bazaValue, false)}`}
              aria-label={`new baza ${row.key}`}
              data-cell="bazaValue"
              data-row={index}
              inputMode="decimal"
              value={row.bazaValue}
              onChange={(e) => onPatch(row.key, { bazaValue: e.target.value })}
              onKeyDown={(e) => onCellKey(e, 'bazaValue', index, lastIndex)}
            />
            {/* «avto» until TOUCHED (18a): nothing is posted, and the server
                stamps the law's default once the code's block exists. The
                units on offer are the matched block's law's (basesFor) — all
                six for a code this request has never seen. */}
            <BasisSelect
              value={screen.basis}
              offered={screen.offered}
              label={`new basis ${row.key}`}
              testId="calc-new-basis"
              drafted={row.bazaBasis !== null}
              disabled={false}
              onPick={(b) => onPatch(row.key, { bazaBasis: b })}
              size="cell"
            />
          </span>
        </td>
        <td className="p-1.5 text-center">
          <button
            type="button"
            className="text-ink-400 hover:text-bad"
            aria-label={`remove ${row.key}`}
            onClick={() => onRemove(row.key)}
          >
            ✕
          </button>
        </td>
      </tr>
      <tr className="border-b border-line/60 bg-brand-50/40 text-2xs">
        <td />
        <td className="px-1.5 pb-1.5" colSpan={7}>
          <span className="flex items-center gap-1 text-ink-600">
            <span>{t('table.measureGhost')}</span>
            <input
              className={`input-cell !w-24 text-right font-mono tabular-nums${cellBorder(row.measure, false)}`}
              aria-label={`new measure ${row.key}`}
              data-cell="measure"
              data-row={index}
              value={row.measure}
              inputMode="decimal"
              onChange={(e) => onPatch(row.key, { measure: e.target.value })}
              onKeyDown={(e) => onCellKey(e, 'measure', index, lastIndex)}
            />
          </span>
        </td>
      </tr>
    </>
  );
}

export default ItemsTable;
