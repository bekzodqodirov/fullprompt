'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
import { defaultBasisFor, uniformBazaOf } from '@/modules/wms/calc/basis';
import { parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
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
} from '../actions';
import { dutyText } from './duty-text';
import { ImportBazaDialog, type PickerTarget } from './import-baza-dialog';

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
 * The dirty law stands: while anything is dirty, every OTHER mutating
 * control (✅, confirm-all, propose, pull-bazas, certificate — and the seal,
 * gated in SealPanel) is off, replaced by «Avval saqlang». Drafts are keyed
 * by the item's immutable ID (a seq is re-minted after a delete), survive
 * until the refreshed workspace actually lands (no snap-back), and die with
 * their row on a delete — the audit's wedge, closed at both ends.
 */

interface ItemDraft {
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

interface NewRow {
  key: number;
  name: string;
  quantity: string;
  unit: string;
  weightKg: string;
  volumeM3: string;
  tnvedCode: string;
  measure: string;
  bazaValue: string;
  bazaBasis: BazaBasis;
}

const CODE_SHAPE = /^\d{4,10}$/;
const NUM_COLS = ['quantity', 'weightKg', 'volumeM3'] as const;
const EXT_UNITS: readonly MeasureUnit[] = ['juft', 'litr', 'm2', 'sm3'];

const parseCell = (raw: string): number | null => {
  const v = raw.trim().replace(/\s/g, '').replace(',', '.');
  return v === '' ? null : Number(v);
};
/** The live figure must equal the SAVED figure to the cent — postgres rounds
 * to the column scale on write, so the draft merge quantizes the same way. */
const q3 = (v: number) => Math.round(v * 1000) / 1000;
const q4 = (v: number) => Math.round(v * 10000) / 10000;

const emptyRow = (key: number): NewRow => ({
  key,
  name: '',
  quantity: '',
  unit: '',
  weightKg: '',
  volumeM3: '',
  tnvedCode: '',
  measure: '',
  bazaValue: '',
  bazaBasis: 'unit',
});

/** Which extended unit the group's law asks for — null for advalor/kg/dona. */
const requiredUnitOf = (group: WorkspaceGroup | null): MeasureUnit | null =>
  group && group.dutyUnit && (EXT_UNITS as readonly string[]).includes(group.dutyUnit)
    ? (group.dutyUnit as MeasureUnit)
    : null;

export function ItemsTable({
  workspace,
  pending,
  act,
  onDirty,
}: {
  workspace: Workspace;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  onDirty: (n: number) => void;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const id = workspace.requestId;

  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [tableError, setTableError] = useState<{ code: string; seq?: number } | null>(null);
  const [lastSave, setLastSave] = useState<{
    minted: string[];
    swept: number;
    merged: string[];
    measuresCleared: number[];
    measuresDropped: number[];
    basisSuspect: number[];
    importFilled: number[];
  } | null>(null);
  /** The rev the save was made against — drafts are held until the refreshed
   * workspace (a moved rev) lands, so the live figures never snap back to
   * pre-save numbers for the length of a round trip (#664's lesson). */
  const [clearAfterRev, setClearAfterRev] = useState<number | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const newKey = useRef(1);

  const allItems = useMemo(
    () => [...workspace.ungrouped, ...workspace.groups.flatMap((g) => g.items)].sort((a, b) => a.seq - b.seq),
    [workspace],
  );
  const itemById = useMemo(() => new Map(allItems.map((i) => [i.id, i])), [allItems]);
  const groupById = useMemo(() => new Map(workspace.groups.map((g) => [g.id, g])), [workspace.groups]);

  // Render-time adjustment, not an effect: the frame that brings the moved
  // rev must not paint once with the stale drafts before an effect clears
  // them. Guarded by the null-reset, so it settles in one re-render.
  if (clearAfterRev !== null && workspace.rev !== clearAfterRev) {
    setDrafts({});
    setNewRows([]);
    setClearAfterRev(null);
  }

  const ghostDirty = (r: NewRow) =>
    Boolean(
      r.name.trim() ||
        r.tnvedCode.trim() ||
        r.quantity.trim() ||
        r.weightKg.trim() ||
        r.volumeM3.trim() ||
        r.measure.trim() ||
        r.bazaValue.trim(),
    );
  const dirtyCount = Object.keys(drafts).length + newRows.filter(ghostDirty).length;
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

  useEffect(() => onDirty(dirtyCount), [dirtyCount, onDirty]);

  // One hour of typed rows must not die on a mis-tap of the card link.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirtyCount]);

  const groupOfItem = (item: WorkspaceItem): WorkspaceGroup | null =>
    item.groupId ? (groupById.get(item.groupId) ?? null) : null;

  const serverValueOf = (item: WorkspaceItem, field: keyof ItemDraft): string => {
    switch (field) {
      case 'name':
        return item.label;
      case 'tnvedCode':
        return item.tnvedCode ?? '';
      case 'note':
        return item.note ?? '';
      case 'measure':
        return item.measureQty === null ? '' : String(item.measureQty);
      case 'bazaValue':
        return item.bazaUsd === null ? '' : String(item.bazaUsd);
      case 'bazaBasis':
        // The same default the select renders — the self-clean must compare
        // against what the screen shows, not a bare 'unit' (#171).
        return item.bazaBasis ?? defaultBasisFor(groupOfItem(item));
      default:
        return String(item[field] ?? '');
    }
  };

  const setDraft = (itemId: string, field: keyof ItemDraft, raw: string) => {
    setLastSave(null);
    setDrafts((prev) => {
      const item = itemById.get(itemId);
      if (!item) return prev;
      const next = { ...prev, [itemId]: { ...prev[itemId], [field]: raw } };
      // A number the VED types is theirs, not the file's (0094).
      if (field === 'bazaValue' || field === 'bazaBasis') delete next[itemId]!.importRowId;
      // A draft equal to the server value is not a draft — the dirty count
      // must mean «cells the save will send». The baza pair self-cleans only
      // when BOTH halves match (a basis is part of the price).
      const cleanable =
        field === 'bazaValue' || field === 'bazaBasis'
          ? next[itemId]!.bazaValue === undefined ||
            (next[itemId]!.bazaValue === serverValueOf(item, 'bazaValue') &&
              (next[itemId]!.bazaBasis ?? serverValueOf(item, 'bazaBasis')) ===
                serverValueOf(item, 'bazaBasis'))
          : raw === serverValueOf(item, field);
      if (cleanable) {
        const rest: ItemDraft = { ...next[itemId] };
        delete rest[field];
        if (field === 'bazaValue') delete rest.bazaBasis;
        if (Object.keys(rest).length === 0) delete next[itemId];
        else next[itemId] = rest;
      }
      return next;
    });
  };

  /** The picker's one writer: amount, basis and provenance land TOGETHER —
   * setDraft deliberately drops the provenance, because a hand-typed number
   * is the VED's own. */
  const pickImport = (itemId: string, row: { id: string; pricePerUnitUsd: number; basis: BazaBasis }) => {
    setLastSave(null);
    setDrafts((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        bazaValue: String(row.pricePerUnitUsd),
        bazaBasis: row.basis,
        importRowId: row.id,
      },
    }));
  };

  /** ONE dialog for the whole table, not one per row.
   *
   * Per-row state meant N fetches in flight and a stale list sitting inside
   * a closed panel; and a per-row `<Overlay>` would mount already-open, so
   * its close-on-navigation effect would shut it the frame it appeared
   * (#684). `key` on the item makes the answer belong to the row it names. */
  const [picker, setPicker] = useState<PickerTarget | null>(null);

  const clearDraft = (itemId: string) =>
    setDrafts((prev) => {
      if (!(itemId in prev)) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });

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
   * live figure and the saved figure agree to the cent. */
  const liveItem = (
    item: WorkspaceItem,
    required: MeasureUnit | null,
    group: WorkspaceGroup | null,
  ): PricedItem => {
    const d = drafts[item.id];
    const numOf = (raw: string | undefined, server: number | null, scale: (v: number) => number) => {
      if (raw === undefined) return server;
      const v = parseCell(raw);
      return v === null || !Number.isFinite(v) ? null : scale(v);
    };
    const bazaUsd = numOf(d?.bazaValue, item.bazaUsd, q4);
    const bazaBasis =
      d?.bazaValue !== undefined
        ? bazaUsd === null
          ? null
          : (d.bazaBasis ?? item.bazaBasis ?? defaultBasisFor(group))
        : item.bazaBasis;
    // The measure mirrors the server's stamp rule: a draft prices in the
    // REQUIRED unit; a stored pair whose unit the code stopped asking for is
    // no measure at all (the save will clear it).
    let measureUnit: MeasureUnit | null = null;
    let measureQty: number | null = null;
    if (required !== null) {
      if (d?.measure !== undefined) {
        const v = parseCell(d.measure);
        if (v !== null && Number.isFinite(v)) {
          measureUnit = required;
          measureQty = q4(v);
        }
      } else if (item.measureUnit === required) {
        measureUnit = item.measureUnit;
        measureQty = item.measureQty;
      }
    }
    return {
      seq: item.seq,
      label: item.label,
      quantity: numOf(d?.quantity, item.quantity, q3),
      weightKg: numOf(d?.weightKg, item.weightKg, q3),
      bazaUsd,
      bazaBasis,
      measureUnit,
      measureQty,
    };
  };

  const liveCustomsByGroup = useMemo(() => {
    const out = new Map<string, CustomsResult>();
    for (const g of workspace.groups) {
      const required = requiredUnitOf(g);
      out.set(
        g.id,
        customsFor(
          pricedGroupOf(g),
          g.items.map((i) => liveItem(i, required, g)),
        ),
      );
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
      const required = requiredUnitOf(g);
      out.set(g.id, uniformBazaOf(g.items.map((i) => liveItem(i, required, g))));
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

  /** Build + send the ONE save — edits and new rows in one transaction. The
   * client refuses NaN before the wire; the server stays the authority. */
  const save = async () => {
    setTableError(null);
    const items: TableItemEdit[] = [];
    for (const [itemId, d] of Object.entries(drafts)) {
      const item = itemById.get(itemId);
      // The row is gone (a colleague's delete) — a draft with no row is not
      // an edit, and posting it would wedge every later save.
      if (!item) continue;
      const edit: TableItemEdit = { id: itemId, seq: item.seq };
      if (d.name !== undefined) edit.name = d.name;
      if (d.note !== undefined) edit.note = d.note || null;
      if (d.tnvedCode !== undefined) {
        const code = d.tnvedCode.trim();
        if (code && !CODE_SHAPE.test(code)) {
          setTableError({ code: 'bad_code', seq: item.seq });
          return;
        }
        edit.tnvedCode = code || null;
      }
      for (const field of NUM_COLS) {
        const raw = d[field];
        if (raw === undefined) continue;
        const value = parseCell(raw);
        if (value !== null && !Number.isFinite(value)) {
          setTableError({ code: 'bad_number', seq: item.seq });
          return;
        }
        edit[field] = value;
      }
      if (d.measure !== undefined) {
        // The cell applies only while the row's code asks an extended unit —
        // a recode strands the draft and the save drops it client-side
        // rather than wedging on a box the screen no longer renders.
        const required = requiredUnitOf(item.groupId ? (groupById.get(item.groupId) ?? null) : null);
        if (required !== null) {
          const v = parseCell(d.measure);
          if (v !== null && !Number.isFinite(v)) {
            setTableError({ code: 'bad_number', seq: item.seq });
            return;
          }
          edit.measureQty = v;
        }
      }
      if (d.bazaValue !== undefined) {
        const v = parseCell(d.bazaValue);
        if (v !== null && !Number.isFinite(v)) {
          setTableError({ code: 'bad_number', seq: item.seq });
          return;
        }
        edit.bazaUsd = v;
        // The SAME chain the select renders (#171): a baza typed on an m²
        // row must save per m², not per the bare fallback.
        edit.bazaBasis =
          v === null ? null : (d.bazaBasis ?? item.bazaBasis ?? defaultBasisFor(groupOfItem(item)));
        // The picked row's id — the server re-reads it and takes the PRICE
        // from the file, so a browser that lies about the number is answered
        // by the declaration itself.
        if (v !== null && d.importRowId) edit.importRowId = d.importRowId;
      }
      items.push(edit);
    }

    const adds: TableNewItem[] = [];
    for (const [i, row] of newRows.entries()) {
      if (!ghostDirty(row)) continue;
      const ghostSeq = -(i + 1);
      if (!row.name.trim()) {
        setTableError({ code: 'name_required', seq: ghostSeq });
        return;
      }
      const code = row.tnvedCode.trim();
      if (code && !CODE_SHAPE.test(code)) {
        setTableError({ code: 'bad_code', seq: ghostSeq });
        return;
      }
      const num = (raw: string) => {
        const v = parseCell(raw);
        return v !== null && Number.isFinite(v) ? v : null;
      };
      const bazaUsd = num(row.bazaValue);
      adds.push({
        name: row.name,
        quantity: num(row.quantity),
        unit: row.unit.trim() || null,
        weightKg: num(row.weightKg),
        volumeM3: num(row.volumeM3),
        tnvedCode: code || null,
        measureQty: num(row.measure),
        bazaUsd,
        bazaBasis: bazaUsd === null ? null : row.bazaBasis,
      });
    }

    setSaving(true);
    try {
      const result = await saveTableAction(id, { items, adds });
      if (result.error) {
        setTableError({ code: result.error, seq: result.seq });
        return;
      }
      setLastSave({
        minted: result.minted ?? [],
        swept: result.swept ?? 0,
        merged: result.merged ?? [],
        measuresCleared: result.measuresCleared ?? [],
        measuresDropped: result.measuresDropped ?? [],
        basisSuspect: result.basisSuspect ?? [],
        importFilled: result.importFilled ?? [],
      });
      // Drafts are HELD until the refreshed workspace lands (the rev moves),
      // so the live figures never flash back to pre-save numbers.
      setClearAfterRev(workspace.rev);
      router.refresh();
    } catch {
      // A thrown action (network, db) must not be a dead button.
      setTableError({ code: 'save_failed' });
    } finally {
      setSaving(false);
    }
  };

  /** Enter walks DOWN the column, Excel's motion; on the last row it grows
   * the table — the «sometimes 1 piece» trickle must not need the mouse. */
  const onCellKey = (e: React.KeyboardEvent<HTMLInputElement>, col: string, rowIndex: number, lastIndex: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (rowIndex >= lastIndex) {
      setNewRows((rows) => [...rows, emptyRow(newKey.current++)]);
      requestAnimationFrame(() => focusCell(col, rowIndex + 1));
    } else {
      focusCell(col, rowIndex + 1);
    }
  };
  const focusCell = (col: string, rowIndex: number) => {
    const el = document.querySelector<HTMLInputElement>(`[data-cell="${col}"][data-row="${rowIndex}"]`);
    el?.focus();
    el?.select();
  };

  /** Ctrl+V of a copied Excel column into a cell is the user's first
   * instinct — a multiline clipboard opens the paste preview instead of
   * dumping the blob into one input. */
  const onCellPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (text.includes('\n') || text.includes('\t')) {
      e.preventDefault();
      setPasteText(text);
      setPasteOpen(true);
    }
  };

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
    return lines.map((line) => {
      const parts = line.split(/[,;]/).map((p) => p.trim());
      const quantity = parts.length > 1 ? parseCell(parts[1]!) : null;
      return {
        name: parts[0]!,
        quantity: quantity !== null && Number.isFinite(quantity) ? quantity : null,
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
      const result = await saveTableAction(id, { items: [], adds: rows });
      if (!result.error) {
        setPasteText('');
        setPasteOpen(false);
        setLastSave({
          minted: result.minted ?? [],
          swept: result.swept ?? 0,
          merged: result.merged ?? [],
          measuresCleared: [],
          measuresDropped: [],
          basisSuspect: [],
          importFilled: result.importFilled ?? [],
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

        <span className="grow" />

        {/* Everything that ACTS on server state waits for the save — a ✅ or
            a seal over unsaved cells blesses numbers the server never saw. */}
        {dirtyCount > 0 ? (
          <span className="text-2xs text-warn" data-testid="calc-unsaved">
            {t('table.unsaved', { count: dirtyCount })}
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
            {/* Desktop-only doors: a phone edits nothing, so an AI regroup
                or a mass baza pull has no place there. The wrapper span is
                the hide — `.btn` is defined AFTER the utilities and its
                display beats a bare `hidden` (#419's cascade family). */}
            <span className="hidden md:contents">
              <button
                type="button"
                className="btn-secondary !min-h-8"
                disabled={busy}
                data-testid="calc-propose"
                onClick={() => act(() => proposeAction(id))}
              >
                ✨ {t('propose')}
              </button>
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

      {tableError ? (
        <p className="chip chip-warn" data-testid="calc-table-error">
          {tableError.seq !== undefined
            ? tableError.seq < 0
              ? `${t('table.newRowN', { n: -tableError.seq })}: `
              : `${tableError.seq}${t('table.rowN')}: `
            : ''}
          {t.has(`errors.${tableError.code}`)
            ? t(`errors.${tableError.code}` as 'errors.not_ready')
            : tableError.code}
        </p>
      ) : null}
      {lastSave &&
      (lastSave.minted.length > 0 ||
        lastSave.swept > 0 ||
        lastSave.merged.length > 0 ||
        lastSave.measuresCleared.length > 0 ||
        lastSave.measuresDropped.length > 0 ||
        lastSave.basisSuspect.length > 0 ||
        lastSave.importFilled.length > 0) ? (
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
            lastSave.importFilled.length > 0
              ? `📥 ${t('table.importFilled', { count: lastSave.importFilled.length })}: ${lastSave.importFilled.join(', ')}`
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
                <col className="w-28" />
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
                    drafts={drafts[row.item.id]}
                    busy={busy}
                    dirty={dirtyCount > 0}
                    act={act}
                    setDraft={setDraft}
                    clearDraft={clearDraft}
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
                    onChange={(patch) => {
                      setLastSave(null);
                      // Typing a code states the row's law: the basis select
                      // follows the matched group's default (a brand-new code
                      // has no group yet and stays per-dona until the mint —
                      // the save's own basisSuspect warning names it then).
                      const withBasis =
                        patch.tnvedCode !== undefined
                          ? {
                              ...patch,
                              bazaBasis: defaultBasisFor(
                                workspace.groups.find(
                                  (g) => (g.tnvedCode ?? '') === patch.tnvedCode!.trim(),
                                ) ?? null,
                              ),
                            }
                          : patch;
                      setNewRows((rows) =>
                        rows.map((r) => (r.key === row.key ? { ...r, ...withBasis } : r)),
                      );
                    }}
                    onRemove={() => setNewRows((rows) => rows.filter((r) => r.key !== row.key))}
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
          that makes a stale answer impossible lives on its BODY, inside. */}
      <ImportBazaDialog
        target={picker}
        onClose={() => setPicker(null)}
        onPick={pickImport}
      />

      {/* One datalist feeds every code cell: repeats become 2-3 digits and a
          pick — 100 items over 5 codes must not cost 1 000 keystrokes. */}
      <datalist id={`codes-${id}`}>
        {codesInRequest.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>

      {/* ---- phone: read-only, but a decision is still a decision ---- */}
      <div className="md:hidden space-y-2">
        <p className="text-2xs text-ink-500">{t('table.editOnDesktop')}</p>
        {workspace.ungrouped.length > 0 ? (
          <p className="text-sm text-warn">
            ⚠ {t('ungrouped')}: {workspace.ungrouped.length}
          </p>
        ) : null}
        {workspace.groups.map((group) => (
          <div key={group.id} className="card !p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold tabular-nums">{group.tnvedCode ?? '—'}</span>
              {(() => {
                const ub = uniformBazaOf(group.items);
                return ub ? (
                  <span className="text-2xs text-ink-600">
                    {t('baza')}{ub.bazaUsd}/
                    {ub.bazaBasis === 'unit' ? t('perUnit') : ub.bazaBasis === 'm2' ? 'm²' : ub.bazaBasis}
                  </span>
                ) : null;
              })()}
              {group.confirmedAt ? (
                <span className="text-2xs text-good">✅</span>
              ) : (
                <button
                  type="button"
                  className="chip chip-brand"
                  disabled={busy}
                  data-testid="calc-phone-confirm"
                  onClick={() => act(() => confirmGroupAction(id, group.id))}
                >
                  {t('confirm')}
                </button>
              )}
              <span className="ml-auto font-mono tabular-nums">
                {group.customs.ok ? `$${group.customs.customsUsd.toFixed(2)}` : `⚠`}
              </span>
            </div>
            <ul className="mt-1 space-y-0.5 text-2xs text-ink-600">
              {group.items.map((item) => (
                <li key={item.id}>
                  {item.seq}. {item.label}
                  {item.quantity != null ? ` · ${item.quantity} ${item.unit ?? ''}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

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
  drafts,
  busy,
  dirty,
  act,
  setDraft,
  clearDraft,
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
  drafts: ItemDraft | undefined;
  busy: boolean;
  dirty: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  setDraft: (itemId: string, field: keyof ItemDraft, raw: string) => void;
  clearDraft: (itemId: string) => void;
  onPickBaza: (target: PickerTarget) => void;
  onCellKey: (e: React.KeyboardEvent<HTMLInputElement>, col: string, rowIndex: number, lastIndex: number) => void;
  onCellPaste: (e: React.ClipboardEvent) => void;
}) {
  const t = useTranslations('calc');
  const item = row.item;
  const required = requiredUnitOf(row.group);
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
        className={`input-cell ${extra}${drafts?.[col] !== undefined ? ' border-brand-500' : ''}`}
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

  // The stored basis ALWAYS renders as an option, marked when the code's law
  // no longer offers it — a select that cannot render the stored value
  // silently rewrites it on the next submit (#171).
  const storedBasis = item.bazaBasis;
  const draftBasis = drafts?.bazaBasis;
  // Item 3: the law's own unit is the default — the VED only types the
  // number. The save and the live figure use the SAME chain (#171).
  const basisValue: BazaBasis = draftBasis ?? storedBasis ?? defaultBasisFor(row.group);
  const offered: BazaBasis[] = ['unit', 'kg'];
  if (required && required !== 'sm3') offered.push(required);
  const basisOptions = offered.includes(basisValue) ? offered : [...offered, basisValue];
  const bazaValue = drafts?.bazaValue ?? (item.bazaUsd === null ? '' : String(item.bazaUsd));
  // The measure sub-line: only when the code prices per juft/litr/m²/sm³.
  // A stored pair in the WRONG unit renders as an EMPTY box (the old number
  // under a new suffix would price something nobody measured).
  const measureServer = item.measureUnit === required && item.measureQty !== null ? String(item.measureQty) : '';
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
        <td className="p-1.5">{cell('quantity', 'text-center')}</td>
        <td className="p-1.5">{cell('weightKg', 'text-right font-mono tabular-nums')}</td>
        <td className="p-1.5">{cell('volumeM3', 'text-right font-mono tabular-nums')}</td>
        <td className="p-1.5">{cell('tnvedCode', 'font-mono tabular-nums')}</td>
        <td className="p-1.5">
          <span className="flex items-center gap-1">
            <input
              className={`input-cell !w-14 text-right font-mono tabular-nums${drafts?.bazaValue !== undefined ? ' border-brand-500' : ''}`}
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
            <select
              className="input-cell !w-12 !px-0.5"
              aria-label={`${t('basis')} ${item.seq}`}
              data-testid="calc-basis"
              value={basisValue}
              disabled={busy}
              onChange={(e) => {
                // The pair travels together: touching the basis drafts the
                // amount too, so the save always posts a coherent pair.
                if (drafts?.bazaValue === undefined) setDraft(item.id, 'bazaValue', bazaValue);
                setDraft(item.id, 'bazaBasis', e.target.value);
              }}
            >
              {basisOptions.map((b) => (
                <option key={b} value={b}>
                  {b === 'unit' ? t('perUnit') : b === 'm2' ? 'm²' : b}
                  {offered.includes(b) ? '' : ' ⚠'}
                </option>
              ))}
            </select>
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
          {item.dictionaryBaza ? (
            <span className="mt-0.5 block truncate text-2xs text-ink-500" title={item.dictionaryBaza.effectiveDate}>
              ≈ ${item.dictionaryBaza.bazaUsd}/
              {item.dictionaryBaza.basis === 'unit' ? t('perUnit') : item.dictionaryBaza.basis}
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
          onPickBaza={onPickBaza}
          noteDraft={drafts?.note}
          onDone={() => setMenuOpen(false)}
        />
      ) : null}
      {required ? (
        <tr className="border-b border-line/60 text-2xs">
          <td />
          <td className="px-1.5 pb-1.5" colSpan={7}>
            <span className="flex items-center gap-1 text-ink-600">
              <span>{t('table.measureFor', { unit: required === 'm2' ? 'm²' : required })}</span>
              <input
                className={`input-cell !w-24 text-right font-mono tabular-nums${drafts?.measure !== undefined ? ' border-brand-500' : ''}`}
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
              <span>{required === 'm2' ? 'm²' : required}</span>
              {/* The sm³ convention outlives the placeholder — a filled cell
                  must still say what its number means. */}
              {required === 'sm3' ? <span className="text-ink-500">· {t('table.sm3Hint')}</span> : null}
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
  busy,
  dirty,
  act,
}: {
  id: string;
  group: WorkspaceGroup;
  liveCustoms: CustomsResult | null;
  liveBaza: { bazaUsd: number; bazaBasis: BazaBasis } | null;
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
              {t('baza')}{liveBaza.bazaUsd}/
              {liveBaza.bazaBasis === 'unit' ? t('perUnit') : liveBaza.bazaBasis === 'm2' ? 'm²' : liveBaza.bazaBasis}
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
                    feeUsd: group.feeUsd ?? 0,
                    effectiveDate: new Date().toISOString().slice(0, 10),
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
                    feeUsd: group.feeUsd,
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
  const [fee, setFee] = useState(group.feeUsd === null ? '' : String(group.feeUsd));
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
          <label className="text-2xs">
            <span className="label">{t('fee')} $</span>
            <input className="input input-sm !w-24" value={fee} onChange={(e) => setFee(e.target.value)} />
          </label>
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
                  feeUsd: num(fee),
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
  onPickBaza,
  noteDraft,
  onDone,
}: {
  id: string;
  item: WorkspaceItem;
  busy: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  setDraft: (itemId: string, field: keyof ItemDraft, raw: string) => void;
  clearDraft: (itemId: string) => void;
  onPickBaza: (target: PickerTarget) => void;
  noteDraft: string | undefined;
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
              onClick={() =>
                onPickBaza({ itemId: item.id, name: item.label, tnvedCode: item.tnvedCode! })
              }
            >
              📥 {t('importPick')}
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
  onChange,
  onRemove,
  onCellKey,
  onCellPaste,
}: {
  row: NewRow;
  index: number;
  lastIndex: number;
  onChange: (patch: Partial<NewRow>) => void;
  onRemove: () => void;
  onCellKey: (e: React.KeyboardEvent<HTMLInputElement>, col: string, rowIndex: number, lastIndex: number) => void;
  onCellPaste: (e: React.ClipboardEvent) => void;
}) {
  const t = useTranslations('calc');
  const cell = (col: 'name' | 'quantity' | 'weightKg' | 'volumeM3' | 'tnvedCode', extra = '') => (
    <input
      className={`input-cell ${extra}`}
      aria-label={`new ${col} ${row.key}`}
      data-cell={col}
      data-row={index}
      data-testid="calc-new-cell"
      inputMode={col === 'name' ? undefined : col === 'tnvedCode' ? 'numeric' : 'decimal'}
      value={row[col]}
      onChange={(e) => onChange({ [col]: e.target.value })}
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
              className="input-cell !w-14 text-right font-mono tabular-nums"
              aria-label={`new baza ${row.key}`}
              data-cell="bazaValue"
              data-row={index}
              inputMode="decimal"
              value={row.bazaValue}
              onChange={(e) => onChange({ bazaValue: e.target.value })}
              onKeyDown={(e) => onCellKey(e, 'bazaValue', index, lastIndex)}
            />
            <select
              className="input-cell !w-12 !px-0.5"
              aria-label={`new basis ${row.key}`}
              value={row.bazaBasis}
              onChange={(e) => onChange({ bazaBasis: e.target.value as BazaBasis })}
            >
              {(['unit', 'kg', 'juft', 'litr', 'm2'] as const).map((b) => (
                <option key={b} value={b}>
                  {b === 'unit' ? t('perUnit') : b === 'm2' ? 'm²' : b}
                </option>
              ))}
            </select>
          </span>
        </td>
        <td className="p-1.5 text-center">
          <button type="button" className="text-ink-400 hover:text-bad" aria-label={`remove ${row.key}`} onClick={onRemove}>
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
              className="input-cell !w-24 text-right font-mono tabular-nums"
              aria-label={`new measure ${row.key}`}
              data-cell="measure"
              data-row={index}
              value={row.measure}
              inputMode="decimal"
              onChange={(e) => onChange({ measure: e.target.value })}
              onKeyDown={(e) => onCellKey(e, 'measure', index, lastIndex)}
            />
          </span>
        </td>
      </tr>
    </>
  );
}

export default ItemsTable;
