'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import type { Workspace, WorkspaceGroup, WorkspaceItem } from '@/modules/wms/calc/workspace';
import type { BazaBasis, CustomsResult } from '@/modules/wms/calc/pricing';
import { basisLabel, defaultBasisFor } from '@/modules/wms/calc/basis';
import { pendingUnitOnScreen, screenRowOf } from '@/modules/wms/calc/screen-row';
import { readNumberCell } from '@/modules/wms/calc/number-cell';
import type { ItemDraft, NewRow } from '@/modules/wms/calc/row-draft';
import { dutyText } from '@/modules/wms/calc/duty-text';
import { confirmGroupAction, type CalcFormState } from '../actions';
import { customsRefusalText, refusalWord } from './words';
import { WARNING_LABELS } from '@/modules/wms/calc/labels';
import { unitLabel, unitOf } from '@/modules/wms/calc/units';
import { unitWordsOf } from '@/modules/wms/calc/law-words';

/**
 * The phone's calculation (his B1 a): the same rows and blocks the desktop
 * grid draws, as cards a thumb can press — each card opens that row's sheet,
 * where the whole row is edited and saved on its own (B2 a).
 *
 * A different RENDER of the same state, never a second copy of it: the cards
 * read the table's one `drafts` / `newRows`, the block lines read the same
 * LIVE engine results the desktop footer does, and the ✅ waits on the same
 * gate (`gateCount` — the drafts AND the rows still waiting to be restored).
 * No ✨, no «bazalarni olish», no paste and no ⚙ rates here (B1, B3 a).
 */
export function PhoneBlocks({
  workspace,
  drafts,
  ghosts,
  liveCustomsByGroup,
  liveBazaByGroup,
  groupById,
  groupsByCode,
  gateCount,
  dirtyCount,
  sweepable,
  pendingMoves,
  nextDraft,
  rowGone,
  busy,
  act,
  onOpenItem,
  onOpenGhost,
  onAdd,
  onSweep,
}: {
  workspace: Workspace;
  drafts: Record<string, ItemDraft>;
  /** Dirty ghost rows only. */
  ghosts: NewRow[];
  liveCustomsByGroup: Map<string, CustomsResult>;
  liveBazaByGroup: Map<string, { bazaUsd: number; bazaBasis: BazaBasis } | null>;
  groupById: Map<string, WorkspaceGroup>;
  groupsByCode: Map<string, WorkspaceGroup>;
  gateCount: number;
  dirtyCount: number;
  sweepable: number;
  /** Old rows the next Saqlash moves (UX7) — they hold the gate, so this
   * screen must offer the press that clears them, or ✅ waits for ever. */
  pendingMoves: number;
  /** The first unsaved row to reopen — a LIVE item id, or a ghost key. */
  nextDraft: { kind: 'item'; id: string } | { kind: 'ghost'; key: number } | null;
  rowGone: boolean;
  busy: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  onOpenItem: (id: string) => void;
  onOpenGhost: (key: number) => void;
  onAdd: () => void;
  onSweep: () => void;
}) {
  const t = useTranslations('calc');
  const id = workspace.requestId;

  return (
    <div className="md:hidden space-y-2">
      <p className="text-2xs text-ink-500" data-testid="calc-phone-hint">
        {t('phone.hint')}
      </p>
      {dirtyCount > 0 && nextDraft ? (
        <button
          type="button"
          className="btn-secondary !min-h-11 w-full"
          data-testid="calc-phone-next-draft"
          onClick={() =>
            nextDraft.kind === 'item' ? onOpenItem(nextDraft.id) : onOpenGhost(nextDraft.key)
          }
        >
          {t('phone.nextDraft')}
        </button>
      ) : null}
      {rowGone ? (
        <p className="chip chip-warn" data-testid="calc-phone-row-gone">
          {t('phone.rowGone')}
        </p>
      ) : null}
      {/* Intake prefills codes, so the commonest request arrives coded and
          ungrouped with nothing dirty — and the seal refuses
          `ungrouped_items` until a save places them. Never drawn while
          anything is unsaved, so this press can post nothing but the sweep.
          Drawn on what it PLACES alone (review PHONE-5): legacy same-code
          duplicates with equal rates merge on any row's save anyway, ones
          with differing rates no press can merge (workspace.ts step 5), and
          neither blocks the seal — a button over them read «(0)» and did
          nothing, for good. */}
      {/* Old rows the save moves hold the gate too (review gate-ux): with
          nothing else unsaved the phone had no press that posts the empty
          save, so ✅ waited on a save the phone could not make. */}
      {(gateCount === 0 && sweepable > 0) || (pendingMoves > 0 && gateCount === pendingMoves) ? (
        <button
          type="button"
          className="btn-primary !min-h-11 w-full"
          disabled={busy}
          data-testid="calc-phone-sweep"
          onClick={onSweep}
        >
          {pendingMoves > 0
            ? t('phone.healSave', { count: pendingMoves })
            : t('phone.sweep', { count: sweepable })}
        </button>
      ) : null}

      {/* NAMED, not counted (audit A32) — and now each one opens. */}
      {workspace.ungrouped.length > 0 ? (
        <div className="space-y-1" data-testid="calc-phone-ungrouped">
          <p className="text-sm text-warn">
            ⚠ {t('ungrouped')}: {workspace.ungrouped.length}
          </p>
          {workspace.ungrouped.map((item) => (
            <PhoneItemCard
              key={item.id}
              item={item}
              draft={drafts[item.id]}
              groupById={groupById}
              groupsByCode={groupsByCode}
              onOpen={onOpenItem}
            />
          ))}
        </div>
      ) : null}

      {workspace.groups.map((group) => {
        const customs = liveCustomsByGroup.get(group.id) ?? group.customs;
        const liveBaza = liveBazaByGroup.get(group.id) ?? null;
        const drafted = group.items.some((i) => drafts[i.id] !== undefined);
        return (
          <div key={group.id} className="card !p-2 text-sm" data-testid="calc-phone-block">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold tabular-nums">{group.tnvedCode ?? '—'}</span>
              {liveBaza ? (
                <span className="text-2xs text-ink-600">
                  {t('baza')}
                  {liveBaza.bazaUsd}/{basisLabel(liveBaza.bazaBasis, t('perUnit'))}
                </span>
              ) : null}
              {group.confirmedAt ? (
                <span className="text-2xs text-good">✅</span>
              ) : gateCount > 0 ? (
                // The desktop's dirty law on the phone too: both shapes share
                // ONE set of drafts, and a ✅ pressed over unsaved cells — or
                // over rows still waiting to be restored — would record
                // `confirmed_warnings` about numbers the server never saw.
                <span className="text-2xs text-warn" data-testid="calc-phone-save-first">
                  {t('table.saveFirst', { count: gateCount })}
                </span>
              ) : (
                <button
                  type="button"
                  // ≥44 px, like every other control a thumb has to hit (A9/A30).
                  className="btn-secondary !min-h-11"
                  disabled={busy}
                  data-testid="calc-phone-confirm"
                  onClick={() => act(() => confirmGroupAction(id, group.id, 'phone'))}
                >
                  {t('confirm')}
                </button>
              )}
              <span
                className="ml-auto font-mono tabular-nums"
                data-testid="calc-phone-block-customs"
              >
                {customs.ok
                  ? `$${customs.customsUsd.toFixed(2)}`
                  : `⚠ ${refusalWord(t, customs.reason)}`}
                {drafted ? (
                  <span className="ml-1 align-middle text-2xs font-normal text-brand-700">
                    {t('table.live')}
                  </span>
                ) : null}
              </span>
            </div>
            {/* WHAT THE ✅ IS ABOUT (audit A18): the rates the confirm records. */}
            <p
              className={`mt-1 text-2xs ${group.rateSource === 'typed' ? 'text-ink-700' : 'text-ink-500'}`}
              data-testid="calc-phone-rates"
            >
              {group.dutyFree ? t('dutyFree') : dutyText(group)} ·{' '}
              {group.vatFree ? t('vatFree') : `${t('vat')} ${group.vatPct ?? '—'}%`}
              {group.aiProposed && group.confirmedAt === null
                ? ` · ✨ ${group.aiConfidence ?? '—'}`
                : ''}
              {group.rateSource === 'dictionary' && group.dictionaryRates?.note
                ? ` · ⚠ ${t('table.rateNoted')}`
                : ''}
              {group.warnings.includes('basis_not_law') && group.dutyUnit
                ? ` · ⚠ ${t('table.basisNotLaw', { unit: basisLabel(defaultBasisFor(group), t('perUnit')) })}`
                : ''}
            </p>
            {/* EVERY warning the ✅ records, in words (judge S10): the phone
                drew basis_not_law alone, so a confirm on a phone recorded
                warnings its presser was never shown. */}
            {group.warnings.some((w) => w !== 'basis_not_law') ? (
              <p className="mt-0.5 text-2xs text-warn" data-testid="calc-phone-warnings">
                ⚠{' '}
                {group.warnings
                  .filter((w) => w !== 'basis_not_law')
                  .map((w) => (WARNING_LABELS[w] ? t(WARNING_LABELS[w] as 'warnings.rateNoted') : w))
                  .join(' · ')}
              </p>
            ) : null}
            {/* WHY it could not be priced, in words (A31) — from the LIVE
                result, so a fixed baza clears it before the save. */}
            {!customs.ok ? (
              <p className="mt-0.5 text-2xs text-warn" data-testid="calc-phone-refusal">
                ⚠ {customsRefusalText(t, customs)}
              </p>
            ) : null}
            <div className="mt-1 space-y-1">
              {group.items.map((item) => (
                <PhoneItemCard
                  key={item.id}
                  item={item}
                  draft={drafts[item.id]}
                  groupById={groupById}
                  groupsByCode={groupsByCode}
                  onOpen={onOpenItem}
                />
              ))}
            </div>
          </div>
        );
      })}

      {ghosts.map((row) => (
        <PhoneGhostCard key={row.key} row={row} onOpen={onOpenGhost} />
      ))}
      <button
        type="button"
        className="btn-secondary !min-h-11 w-full"
        disabled={busy}
        data-testid="calc-phone-add"
        onClick={onAdd}
      >
        ＋ {t('table.addRow')}
      </button>
    </div>
  );
}

/** What a typed cell shows on the card — as typed, ⚠ when it cannot be read. */
const typed = (raw: string) => {
  const cell = readNumberCell(raw);
  return cell.state === 'ok' || cell.state === 'empty' ? raw.trim() : `${raw.trim()} ⚠`;
};

/**
 * One row as a card — the MERGED values (the draft over the stored row), the
 * source chips the ✅ is about, and ⚠ where something the price needs is
 * missing. Memo'd: its props are stable between keystrokes, so a 100-row
 * request re-renders only the card whose draft changed.
 */
export const PhoneItemCard = memo(function PhoneItemCard({
  item,
  draft,
  groupById,
  groupsByCode,
  onOpen,
}: {
  item: WorkspaceItem;
  draft: ItemDraft | undefined;
  groupById: Map<string, WorkspaceGroup>;
  groupsByCode: Map<string, WorkspaceGroup>;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('calc');
  const screen = screenRowOf(item, draft, groupById, groupsByCode);
  // The desktop row's sentence (UX7), on the card: «120» under the seller's
  // «m2» reads as 120 dona until a Saqlash moves it.
  const pendingUnit = pendingUnitOnScreen(
    item,
    {
      confirmed: Boolean(screen.lawGroup?.confirmedAt),
      lawDutyUnit: screen.lawGroup?.dutyUnit ?? null,
      grouped: screen.lawGroup !== null,
    },
    draft,
  );
  const name = draft?.name ?? item.label;
  const code = (draft?.tnvedCode ?? item.tnvedCode ?? '').trim();
  const qty =
    draft?.quantity !== undefined
      ? typed(draft.quantity)
      : item.quantity === null
        ? ''
        : String(item.quantity);
  const kg =
    draft?.weightKg !== undefined
      ? typed(draft.weightKg)
      : item.weightKg === null
        ? ''
        : String(item.weightKg);
  const m3 =
    draft?.volumeM3 !== undefined
      ? typed(draft.volumeM3)
      : item.volumeM3 === null
        ? ''
        : String(item.volumeM3);
  const pair = screen.pair;
  const storedMeasure =
    pair !== null && (pair === 'any' || item.measureUnit === pair) && item.measureQty !== null
      ? String(item.measureQty)
      : '';
  const measure =
    pair === null ? '' : draft?.measure !== undefined ? typed(draft.measure) : storedMeasure;
  const baza =
    draft?.bazaValue !== undefined
      ? typed(draft.bazaValue)
      : item.bazaUsd === null
        ? ''
        : String(item.bazaUsd);
  const missing = code === '' || baza === '' || (pair !== null && pair !== 'any' && measure === '');
  const counts = [
    // A count prints as PIECES: the seller's word only when it is itself a
    // count word — «300 kg» under a number that is pieces was MR-6.
    qty ? `${qty} ${item.unit && unitOf(item.unit) === 'dona' ? item.unit : t('units.dona')}` : '',
    kg ? `${kg} kg` : '',
    m3 ? `${m3} m³` : '',
    measure && pair !== null && pair !== 'any'
      ? `${measure} ${basisLabel(pair, t('perUnit'))}`
      : '',
  ].filter(Boolean);

  return (
    <button
      type="button"
      className="block min-h-11 w-full rounded-xl border border-line bg-surface-raised p-2 text-left hover:bg-surface-sunken"
      data-testid="calc-phone-row"
      data-drafted={draft !== undefined ? '1' : undefined}
      onClick={() => onOpen(item.id)}
    >
      <span className="line-clamp-2 break-words text-sm font-semibold text-ink-900">
        {item.seq}. {name}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-ink-600">
        {code ? <span className="font-mono tabular-nums">{code}</span> : null}
        {counts.length > 0 ? <span>{counts.join(' · ')}</span> : null}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs">
        {baza ? (
          <span className="font-mono tabular-nums text-ink-700">
            ${baza}/{basisLabel(screen.basis ?? defaultBasisFor(screen.lawGroup), t('perUnit'))}
          </span>
        ) : null}
        {item.bazaStale && draft?.bazaValue === undefined ? (
          <span className="text-warn" data-testid="calc-phone-baza-stale">
            ⚠ {t('stale')}
          </span>
        ) : null}
        {item.bazaSource === 'memory' && draft?.bazaValue === undefined ? (
          <span className="text-ink-500" data-testid="calc-phone-chip-memory">
            🧠
          </span>
        ) : null}
        {item.bazaSource === 'import' && draft?.bazaValue === undefined ? (
          <span className="text-ink-500" data-testid="calc-phone-chip-import">
            📥
          </span>
        ) : null}
        {item.bazaReason && draft?.bazaValue === undefined ? (
          <span className="text-ink-500" data-testid="calc-phone-chip-reason">
            🤖
          </span>
        ) : null}
        {missing ? <span className="text-warn">⚠</span> : null}
        {draft !== undefined ? (
          <span className="chip chip-warn" data-testid="calc-phone-drafted">
            {t('phone.drafted')}
          </span>
        ) : null}
      </span>
      {pendingUnit ? (
        <span className="mt-0.5 block text-2xs text-warn" data-testid="calc-phone-unit-pending">
          ⚠{' '}
          {pendingUnit.kind === 'move'
            ? t('grid.pendingMove', {
                said: `${pendingUnit.quantity} ${pendingUnit.word}`,
                to: unitLabel(
                  pendingUnit.to,
                  unitWordsOf((k) => t(`units.${k}` as 'units.dona')),
                ),
              })
            : t('grid.pendingAsk', { said: `${pendingUnit.quantity} ${pendingUnit.word}` })}
        </span>
      ) : null}
    </button>
  );
});

/** A new row typed on the phone and not yet saved — tappable, like the rest. */
export const PhoneGhostCard = memo(function PhoneGhostCard({
  row,
  onOpen,
}: {
  row: NewRow;
  onOpen: (key: number) => void;
}) {
  const t = useTranslations('calc');
  const counts = [
    row.quantity.trim() ? `${typed(row.quantity)}` : '',
    row.weightKg.trim() ? `${typed(row.weightKg)} kg` : '',
    row.volumeM3.trim() ? `${typed(row.volumeM3)} m³` : '',
  ].filter(Boolean);
  return (
    <button
      type="button"
      className="block min-h-11 w-full rounded-xl border border-dashed border-brand-500 bg-brand-50/40 p-2 text-left"
      data-testid="calc-phone-ghost"
      onClick={() => onOpen(row.key)}
    >
      <span className="line-clamp-2 break-words text-sm font-semibold text-ink-900">
        ＋ {row.name.trim() || t('phone.newItem')}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-ink-600">
        {row.tnvedCode.trim() ? (
          <span className="font-mono tabular-nums">{row.tnvedCode.trim()}</span>
        ) : null}
        {counts.length > 0 ? <span>{counts.join(' · ')}</span> : null}
        <span className="chip chip-warn" data-testid="calc-phone-drafted">
          {t('phone.drafted')}
        </span>
      </span>
    </button>
  );
});
