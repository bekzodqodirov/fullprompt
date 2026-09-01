'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Workspace, WorkspaceGroup, WorkspaceItem } from '@/modules/wms/calc/workspace';
import type { TableItemEdit, TableNewItem } from '@/modules/wms/calc/workspace';
import { parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import {
  addItemsAction,
  applyTableAction,
  confirmAllAction,
  confirmGroupAction,
  deleteGroupAction,
  deleteItemAction,
  proposeAction,
  pullBazasAction,
  pullRatesAction,
  saveRatesAction,
  setBazaAction,
  setCertificateAction,
  setRatesAction,
  type CalcFormState,
  type TableFormState,
} from '../actions';
import { dutyText } from './duty-text';

/**
 * The Excel-table workspace (VED 2.0 phase 2) — the owner's «gruh yasab
 * ulangan tovarlarni ulash juda ish ko'p» answered.
 *
 * A group stops being a thing a person creates: the VED types a TNVED code
 * on the ITEM row and the item lands in that code's group by itself, with
 * the PP-3818 rates pulled at mint. The grid is the receipt-cost-grid shape
 * (round 29): drafts in client state, ONE Saqlash posts every changed cell
 * in one transaction, a refused save keeps every typed input and NAMES the
 * row it refused on.
 *
 * The judge's law this file carries: while anything is dirty, every OTHER
 * mutating control (✅, confirm-all, propose, pull-bazas, certificate — and
 * the seal, gated in SealPanel) is off, replaced by «Avval saqlang» — a ✅
 * or a seal over unsaved cells confirms numbers the server has never seen.
 */

interface ItemDraft {
  name?: string;
  quantity?: string;
  weightKg?: string;
  volumeM3?: string;
  tnvedCode?: string;
  note?: string;
}

interface NewRow {
  key: number;
  name: string;
  quantity: string;
  unit: string;
  weightKg: string;
  volumeM3: string;
  tnvedCode: string;
}

interface BazaDraft {
  value: string;
  basis: 'unit' | 'kg';
}

const CODE_SHAPE = /^\d{4,10}$/;
const NUM_COLS = ['quantity', 'weightKg', 'volumeM3'] as const;

const parseCell = (raw: string): number | null => {
  const v = raw.trim().replace(/\s/g, '').replace(',', '.');
  return v === '' ? null : Number(v);
};

const emptyRow = (key: number): NewRow => ({
  key,
  name: '',
  quantity: '',
  unit: '',
  weightKg: '',
  volumeM3: '',
  tnvedCode: '',
});

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

  const [drafts, setDrafts] = useState<Record<number, ItemDraft>>({});
  const [bazaDrafts, setBazaDrafts] = useState<Record<string, BazaDraft>>({});
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [tableError, setTableError] = useState<{ code: string; seq?: number } | null>(null);
  const [lastSave, setLastSave] = useState<{ minted: string[]; swept: number } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const newKey = useRef(1);

  const allItems = useMemo(
    () => [...workspace.ungrouped, ...workspace.groups.flatMap((g) => g.items)].sort((a, b) => a.seq - b.seq),
    [workspace],
  );
  const itemBySeq = useMemo(() => new Map(allItems.map((i) => [i.seq, i])), [allItems]);

  const dirtyCount =
    Object.keys(drafts).length +
    Object.keys(bazaDrafts).length +
    newRows.filter((r) => r.name.trim() || r.tnvedCode.trim()).length;
  // Intake prefills codes from the TNVED memory, so the commonest request
  // arrives coded-and-ungrouped with NOTHING dirty — the save's server-side
  // sweep is what places them, so the button stays live for exactly that.
  const sweepable = workspace.ungrouped.filter((i) => (i.tnvedCode ?? '').trim()).length;
  const saveable = dirtyCount > 0 || sweepable > 0;

  useEffect(() => onDirty(dirtyCount), [dirtyCount, onDirty]);

  // One hour of typed rows must not die on a mis-tap of the card link.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirtyCount]);

  const setDraft = (seq: number, field: keyof ItemDraft, raw: string) => {
    setLastSave(null);
    setDrafts((prev) => {
      const item = itemBySeq.get(seq);
      const server =
        field === 'name'
          ? (item?.label ?? '')
          : field === 'tnvedCode'
            ? (item?.tnvedCode ?? '')
            : field === 'note'
              ? (item?.note ?? '')
              : String(item?.[field] ?? '');
      const next = { ...prev, [seq]: { ...prev[seq], [field]: raw } };
      // A draft equal to the server value is not a draft — the dirty count
      // must mean «cells the save will send».
      if (raw === server) {
        const rest: ItemDraft = { ...next[seq] };
        delete rest[field];
        if (Object.keys(rest).length === 0) delete next[seq];
        else next[seq] = rest;
      }
      return next;
    });
  };

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

  /** Build + send the ONE save. The client refuses NaN before the wire; the
   * server stays the authority (mustBeNumber, and codes re-checked). */
  const save = async () => {
    setTableError(null);
    const items: TableItemEdit[] = [];
    for (const [seqStr, d] of Object.entries(drafts)) {
      const seq = Number(seqStr);
      const edit: TableItemEdit = { seq };
      if (d.name !== undefined) edit.name = d.name;
      if (d.note !== undefined) edit.note = d.note || null;
      if (d.tnvedCode !== undefined) {
        const code = d.tnvedCode.trim();
        if (code && !CODE_SHAPE.test(code)) {
          setTableError({ code: 'bad_code', seq });
          return;
        }
        edit.tnvedCode = code || null;
      }
      for (const field of NUM_COLS) {
        const raw = d[field];
        if (raw === undefined) continue;
        const value = parseCell(raw);
        if (value !== null && !Number.isFinite(value)) {
          setTableError({ code: 'bad_number', seq });
          return;
        }
        edit[field] = value;
      }
      items.push(edit);
    }

    const groupBazas = [];
    for (const [code, d] of Object.entries(bazaDrafts)) {
      const value = parseCell(d.value);
      if (value !== null && !Number.isFinite(value)) {
        setTableError({ code: 'bad_number' });
        return;
      }
      const group = workspace.groups.find((g) => (g.tnvedCode ?? '') === code);
      const bazas = [...new Set((group?.items ?? []).map((i) => i.bazaUsd))];
      groupBazas.push({
        code,
        bazaUsd: value,
        basis: d.basis,
        // The stale-overwrite fence: what THIS screen showed. The server
        // refuses when the members moved underneath (a colleague's law-5
        // per-item bazas must not flatten unseen).
        sawBazaUsd: bazas.length === 1 ? bazas[0]! : null,
        sawMixed: bazas.length > 1,
      });
    }

    const adds: TableNewItem[] = [];
    for (const row of newRows) {
      if (!row.name.trim() && !row.tnvedCode.trim()) continue;
      if (!row.name.trim()) {
        setTableError({ code: 'name_required' });
        return;
      }
      const code = row.tnvedCode.trim();
      if (code && !CODE_SHAPE.test(code)) {
        setTableError({ code: 'bad_code' });
        return;
      }
      const num = (raw: string) => {
        const v = parseCell(raw);
        return v !== null && Number.isFinite(v) ? v : null;
      };
      adds.push({
        name: row.name,
        quantity: num(row.quantity),
        unit: row.unit.trim() || null,
        weightKg: num(row.weightKg),
        volumeM3: num(row.volumeM3),
        tnvedCode: code || null,
      });
    }

    setSaving(true);
    try {
      let minted: string[] = [];
      let swept = 0;
      const result = await applyTableAction(id, { items, groupBazas });
      if (result.error) {
        setTableError({ code: result.error, seq: result.seq });
        return;
      }
      minted = result.minted ?? [];
      swept = result.swept ?? 0;
      setDrafts({});
      setBazaDrafts({});
      if (adds.length > 0) {
        const added: TableFormState = await addItemsAction(id, adds);
        if (added.error) {
          // The edits landed; the new rows did not — keep exactly them.
          setTableError({ code: added.error, seq: added.seq });
          router.refresh();
          return;
        }
        minted = [...new Set([...minted, ...(added.minted ?? [])])];
        setNewRows([]);
      }
      setLastSave({ minted, swept });
      router.refresh();
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
      const result = await addItemsAction(id, rows);
      if (!result.error) {
        setPasteText('');
        setPasteOpen(false);
        setLastSave({ minted: result.minted ?? [], swept: 0 });
      }
      return result;
    });

  const groupBazaState = (group: WorkspaceGroup): { uniform: number | null; mixed: boolean } => {
    const set = [...new Set(group.items.map((i) => i.bazaUsd))];
    return { uniform: set.length === 1 ? set[0]! : null, mixed: set.length > 1 };
  };

  const busy = pending || saving;
  const unconfirmed = workspace.groups.filter((g) => g.confirmedAt === null).length;
  const unpriced = workspace.groups.filter((g) => !g.customs.ok).length;

  // Rendered row order: ungrouped first (the ⚠ pile a person must act on),
  // then each group's members — the DESKTOP grid walks this flat list so
  // Enter-down crosses group borders without caring about them.
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
          {allItems.length} {t('items')} · {workspace.groups.length} {t('groups').toLowerCase()}
        </span>
        {workspace.ungrouped.length > 0 ? (
          <a className="chip chip-warn" href="#calc-ungrouped">
            ⚠ {t('ungrouped')}: {workspace.ungrouped.length}
          </a>
        ) : null}
        {unpriced > 0 ? (
          <a className="chip chip-warn" href={`#calc-g-${workspace.groups.find((g) => !g.customs.ok)?.seq ?? 0}`}>
            ⚠ {t('table.unpriced')}: {unpriced}
          </a>
        ) : null}
        {workspace.totals?.ok ? (
          <span className="font-mono text-sm font-semibold tabular-nums" data-testid="calc-bar-total">
            ${workspace.totals.totalUsd.toFixed(2)}
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
                display beats a bare `hidden` (#419's cascade family,
                caught in this round's own phone screenshot). */}
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
          {tableError.seq !== undefined ? `${tableError.seq}${t('table.rowN')}: ` : ''}
          {t.has(`errors.${tableError.code}`)
            ? t(`errors.${tableError.code}` as 'errors.not_ready')
            : tableError.code}
        </p>
      ) : null}
      {lastSave && (lastSave.minted.length > 0 || lastSave.swept > 0) ? (
        <p className="text-2xs text-ink-600" data-testid="calc-save-note">
          {lastSave.minted.length > 0
            ? `${t('table.minted', { count: lastSave.minted.length })}: ${lastSave.minted.join(', ')}`
            : ''}
          {lastSave.minted.length > 0 && lastSave.swept > 0 ? ' · ' : ''}
          {lastSave.swept > 0 ? t('table.swept', { count: lastSave.swept }) : ''}
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
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {workspace.ungrouped.length > 0 ? (
                  <tr id="calc-ungrouped" className="scroll-mt-28 border-b border-line bg-warn/10">
                    <td className="p-2 text-2xs text-warn" colSpan={7} data-testid="calc-ungrouped-head">
                      ⚠ {t('ungrouped')}: {workspace.ungrouped.length} — {t('table.typeCode')}
                    </td>
                  </tr>
                ) : null}
                {orderedRows.map((row, index) => (
                  <ItemRowBlock
                    key={row.item.seq}
                    id={id}
                    row={row}
                    index={index}
                    lastIndex={lastIndex}
                    prevGroup={index === 0 ? null : orderedRows[index - 1]!.group}
                    drafts={drafts[row.item.seq]}
                    bazaDraft={row.group?.tnvedCode ? bazaDrafts[row.group.tnvedCode] : undefined}
                    busy={busy}
                    dirty={dirtyCount > 0}
                    act={act}
                    setDraft={setDraft}
                    setBazaDraft={(code, d) => {
                      setLastSave(null);
                      setBazaDrafts((prev) => {
                        if (d === null) {
                          const next = { ...prev };
                          delete next[code];
                          return next;
                        }
                        return { ...prev, [code]: d };
                      });
                    }}
                    groupBazaState={groupBazaState}
                    onCellKey={onCellKey}
                    onCellPaste={onCellPaste}
                    mixedConfirm={(group) => {
                      const values = [...new Set(group.items.map((i) => i.bazaUsd ?? '—'))].join(' / ');
                      return window.confirm(t('table.mixedConfirm', { count: group.items.length, values }));
                    }}
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
                      setNewRows((rows) => rows.map((r) => (r.key === row.key ? { ...r, ...patch } : r)));
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
              {group.confirmedAt ? (
                <span className="text-2xs text-good">✅</span>
              ) : (
                <button
                  type="button"
                  className="chip chip-brand"
                  disabled={busy}
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
                <li key={item.seq}>
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
 * One item row, PLUS its group's header row when the group starts here.
 *
 * Memo'd on its own slice: 100 rows × 6 controlled inputs re-rendering on
 * every keystroke is the round-70 board freeze in a grid's clothes — a row
 * whose props did not move must not pay for its neighbour's typing.
 */
const ItemRowBlock = memo(function ItemRowBlock({
  id,
  row,
  index,
  lastIndex,
  prevGroup,
  drafts,
  bazaDraft,
  busy,
  dirty,
  act,
  setDraft,
  setBazaDraft,
  groupBazaState,
  onCellKey,
  onCellPaste,
  mixedConfirm,
}: {
  id: string;
  row: { item: WorkspaceItem; group: WorkspaceGroup | null };
  index: number;
  lastIndex: number;
  prevGroup: WorkspaceGroup | null;
  drafts: ItemDraft | undefined;
  bazaDraft: BazaDraft | undefined;
  busy: boolean;
  dirty: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  setDraft: (seq: number, field: keyof ItemDraft, raw: string) => void;
  setBazaDraft: (code: string, d: BazaDraft | null) => void;
  groupBazaState: (group: WorkspaceGroup) => { uniform: number | null; mixed: boolean };
  onCellKey: (e: React.KeyboardEvent<HTMLInputElement>, col: string, rowIndex: number, lastIndex: number) => void;
  onCellPaste: (e: React.ClipboardEvent) => void;
  mixedConfirm: (group: WorkspaceGroup) => boolean;
}) {
  const item = row.item;
  const startsGroup = row.group !== null && row.group !== prevGroup;

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
        onChange={(e) => setDraft(item.seq, col, e.target.value)}
        onKeyDown={(e) => onCellKey(e, col, index, lastIndex)}
        onPaste={onCellPaste}
      />
    );
  };

  return (
    <>
      {startsGroup && row.group ? (
        <GroupHeaderRow
          id={id}
          group={row.group}
          bazaDraft={bazaDraft}
          busy={busy}
          dirty={dirty}
          act={act}
          setBazaDraft={setBazaDraft}
          groupBazaState={groupBazaState}
          mixedConfirm={mixedConfirm}
        />
      ) : null}
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
        <td className="p-1.5 text-center">
          <RowMenu id={id} item={item} busy={busy} act={act} setDraft={setDraft} noteDraft={drafts?.note} />
        </td>
      </tr>
    </>
  );
});

/**
 * The group's header: the code, the law (grey = the dictionary's word,
 * black = a person typed over it), ONE baza cell for the whole group — the
 * owner's «bitta tnved kod uchun narx bir xil» — the lgota chips, the ✅
 * and the group's customs figure (⚠ + reason, never $0).
 */
function GroupHeaderRow({
  id,
  group,
  bazaDraft,
  busy,
  dirty,
  act,
  setBazaDraft,
  groupBazaState,
  mixedConfirm,
}: {
  id: string;
  group: WorkspaceGroup;
  bazaDraft: BazaDraft | undefined;
  busy: boolean;
  dirty: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  setBazaDraft: (code: string, d: BazaDraft | null) => void;
  groupBazaState: (group: WorkspaceGroup) => { uniform: number | null; mixed: boolean };
  mixedConfirm: (group: WorkspaceGroup) => boolean;
}) {
  const t = useTranslations('calc');
  const [open, setOpen] = useState(false);
  const code = group.tnvedCode ?? '';
  const baza = groupBazaState(group);
  const bazaValue = bazaDraft?.value ?? (baza.mixed ? '' : baza.uniform === null ? '' : String(baza.uniform));
  const basis: 'unit' | 'kg' =
    bazaDraft?.basis ?? ((group.items.find((i) => i.bazaBasis)?.bazaBasis ?? 'unit') as 'unit' | 'kg');

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
        <td className="p-1.5">
          <span className="font-mono font-semibold tabular-nums">{code || '—'}</span>
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
          {group.customs.ok && group.customs.addDutyUsd > 0 ? (
            <span className="ml-1 text-2xs text-warn">
              +{group.customs.addDutyPct}% (${group.customs.addDutyUsd.toFixed(2)})
            </span>
          ) : null}
        </td>
        <td className="p-1.5" colSpan={3}>
          <span className="flex items-center gap-1">
            <span className="text-2xs text-ink-500">{t('baza')}</span>
            <input
              className={`input-cell !w-24 text-right font-mono tabular-nums${bazaDraft ? ' border-brand-500' : ''}`}
              aria-label={`${t('baza')} ${code}`}
              data-testid="calc-group-baza"
              inputMode="decimal"
              placeholder={baza.mixed ? t('table.mixed') : ''}
              value={bazaValue}
              disabled={busy || !code}
              onChange={(e) => {
                // Overwriting several careful per-item bazas with one number
                // is a decision, not a keystroke (law 5) — ask before the
                // first character enters the draft.
                if (baza.mixed && !bazaDraft && !mixedConfirm(group)) return;
                setBazaDraft(code, { value: e.target.value, basis });
              }}
            />
            <select
              className="input-cell !w-16"
              aria-label={`${t('basis')} ${code}`}
              data-testid="calc-group-basis"
              value={basis}
              disabled={busy || !code}
              onChange={(e) => {
                if (baza.mixed && !bazaDraft && !mixedConfirm(group)) return;
                setBazaDraft(code, { value: bazaValue, basis: e.target.value as 'unit' | 'kg' });
              }}
            >
              <option value="unit">{t('perUnit')}</option>
              <option value="kg">kg</option>
            </select>
          </span>
        </td>
        <td className="p-1.5 text-right font-mono tabular-nums" data-testid="calc-group-customs">
          {group.customs.ok ? (
            `$${group.customs.customsUsd.toFixed(2)}`
          ) : (
            <span className="text-warn">
              ⚠ {t.has(`refusals.${group.customs.reason}`)
                ? t(`refusals.${group.customs.reason}` as 'refusals.rates_missing')
                : group.customs.reason}
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
      <tr className="border-b border-line/60 text-2xs text-ink-600">
        <td className="px-2 pb-1.5" colSpan={7}>
          <span className="font-mono tabular-nums">
            {group.quantity ?? '—'} {group.unit ?? ''} · {group.weightKg ?? '—'} kg · {group.volumeM3 ?? '—'} m³
          </span>
          {group.customs.ok ? ` · ${t('value')} $${group.customs.valueUsd.toFixed(2)}` : ''}
          {group.rateSource ? ` · ${t(`source.${group.rateSource}` as 'source.typed')}` : ''}
          {group.dictionaryRates && group.rateSource !== 'dictionary' && !dirty ? (
            <button
              type="button"
              className="ml-2 underline"
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
              className="ml-2 underline"
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
              className="ml-2 underline"
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
              className="ml-2 underline text-good"
              disabled={busy}
              data-testid="calc-confirm-group"
              onClick={() => act(() => confirmGroupAction(id, group.id))}
            >
              {t('confirm')}
            </button>
          ) : null}
        </td>
      </tr>
      {open ? <GroupFold id={id} group={group} busy={busy} act={act} onDone={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The ⚙ escape hatch: rates/lgota/label by hand, per-item bazas (law 5's
 * several-products case), delete. Deliberately WITHOUT a TNVED input — the
 * code is minted by the item rows now, and a second writer would let the
 * group's identity drift from its members'.
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
      <td className="p-2" colSpan={7}>
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
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            data-testid="calc-delete-group"
            onClick={() => act(() => deleteGroupAction(id, group.id))}
          >
            🗑
          </button>
        </div>
        <ul className="mt-2 space-y-1">
          {group.items.map((item) => (
            <li key={item.seq} className="flex flex-wrap items-center gap-2 text-2xs">
              <span className="grow">{item.label}</span>
              <ItemBaza id={id} item={item} pending={busy} act={act} />
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

/** The item's ⋯: note, per-item baza, delete — the rare cases off the grid. */
function RowMenu({
  id,
  item,
  busy,
  act,
  setDraft,
  noteDraft,
}: {
  id: string;
  item: WorkspaceItem;
  busy: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  setDraft: (seq: number, field: keyof ItemDraft, raw: string) => void;
  noteDraft: string | undefined;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="text-ink-400 hover:text-ink-900"
        aria-label={`⋯ ${item.seq}`}
        data-testid="calc-item-menu"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <span className="absolute right-0 top-6 z-20 flex w-72 flex-col gap-2 rounded-xl border border-line bg-surface-raised p-2 shadow-pop">
          <label className="text-2xs">
            <span className="label">{t('table.note')}</span>
            <input
              className="input input-sm"
              data-testid="calc-item-note"
              value={noteDraft ?? item.note ?? ''}
              onChange={(e) => setDraft(item.seq, 'note', e.target.value)}
            />
          </label>
          <ItemBaza id={id} item={item} pending={busy} act={act} />
          <button
            type="button"
            className="btn-secondary !min-h-8 text-bad"
            disabled={busy}
            data-testid="calc-item-delete"
            onClick={() => {
              const hasData = item.bazaUsd !== null || item.quantity !== null || item.weightKg !== null;
              if (hasData && !window.confirm(`${tc('delete')}? ${item.label}`)) return;
              act(async () => {
                const result = await deleteItemAction(id, item.seq);
                if (!result.error) setOpen(false);
                return { ok: result.ok, error: result.error };
              });
            }}
          >
            🗑 {tc('delete')}
          </button>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The baza, per ITEM — law 5's exception behind the ⋯: one code holds
 * several products with different bazas, and the group cell must not be the
 * only door.
 */
function ItemBaza({
  id,
  item,
  pending,
  act,
}: {
  id: string;
  item: WorkspaceItem;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
}) {
  const t = useTranslations('calc');
  const [value, setValue] = useState(item.bazaUsd === null ? '' : String(item.bazaUsd));
  const [basis, setBasis] = useState<'unit' | 'kg'>(item.bazaBasis ?? 'unit');

  return (
    <span className="flex items-center gap-1">
      {item.dictionaryBaza?.stale ? (
        <span className="chip chip-warn" data-testid="calc-baza-stale" title={item.dictionaryBaza.effectiveDate}>
          ⚠ {t('stale')}
        </span>
      ) : null}
      <input
        className="input input-sm !w-20 font-mono tabular-nums"
        aria-label={`${t('baza')} ${item.seq}`}
        data-testid="calc-baza"
        placeholder={item.dictionaryBaza ? String(item.dictionaryBaza.bazaUsd) : t('baza')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <select
        className="input input-sm !w-16"
        aria-label={`${t('basis')} ${item.seq}`}
        value={basis}
        onChange={(e) => setBasis(e.target.value as 'unit' | 'kg')}
      >
        <option value="unit">{t('perUnit')}</option>
        <option value="kg">kg</option>
      </select>
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        data-testid="calc-save-baza"
        onClick={() =>
          act(() => setBazaAction(id, item.seq, value.trim() === '' ? null : Number(value.replace(',', '.')), basis))
        }
      >
        ✓
      </button>
    </span>
  );
}

/** A ghost row: typed locally, born on the next Saqlash via addItems. */
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
    <tr className="border-b border-line/60 bg-brand-50/40" data-testid="calc-new-row">
      <td className="p-1.5 text-center text-2xs text-brand-700">＋</td>
      <td className="p-1.5">{cell('name')}</td>
      <td className="p-1.5">{cell('quantity', 'text-center')}</td>
      <td className="p-1.5">{cell('weightKg', 'text-right font-mono tabular-nums')}</td>
      <td className="p-1.5">{cell('volumeM3', 'text-right font-mono tabular-nums')}</td>
      <td className="p-1.5">{cell('tnvedCode', 'font-mono tabular-nums')}</td>
      <td className="p-1.5 text-center">
        <button type="button" className="text-ink-400 hover:text-bad" aria-label={`remove ${row.key}`} onClick={onRemove}>
          ✕
        </button>
      </td>
    </tr>
  );
}

export default ItemsTable;
