'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Overlay } from '@/components/ui/overlay';
import { reloadFresh } from '@/components/build-check';
import type { BazaBasis, CustomsResult } from '@/modules/wms/calc/pricing';
import { basisLabel } from '@/modules/wms/calc/basis';
import { readNumberCell } from '@/modules/wms/calc/number-cell';
import type { ChangeField, FieldChange } from '@/modules/wms/calc/row-draft';
import type { WorkspaceItem } from '@/modules/wms/calc/workspace';
import { BasisSelect } from './basis-select';
import { useFieldWord } from './field-words';
import { refusalWord } from './words';

/**
 * ONE row of the calculation, edited on the phone (his B1 a, B2 a): tap the
 * card, edit the whole row, «Saqlash» inside the sheet — and that press posts
 * this ONE row, so a lost connection re-writes at most one item.
 *
 * Presentational: every fact lives in ItemsTable (the drafts, the ghost rows,
 * the live figure, the B6 look) and arrives here as a model. ONE Overlay for
 * the table, mounted once and toggled, with the BODY keyed per row — an
 * Overlay that mounts already open closes itself on the frame it appears
 * (#684, measured on the import dialog the same way).
 *
 * Every field is the 16 px `.input`: iPhone Safari zooms the whole page on
 * focus of anything smaller. The messages a press produces sit at the TOP of
 * the scroll body (the footer keeps only the live figure and the two buttons —
 * a fixed footer goes under the Android keyboard, #547, and an overloaded one
 * buries the field it is about).
 */

export type SheetFigure =
  { state: 'no_code' } | { state: 'unknown_law' } | { state: 'ok'; customs: CustomsResult };

export type SheetNumField = 'quantity' | 'weightKg' | 'volumeM3' | 'measure' | 'bazaValue';

/** The word a numeric cell is named by under its box (field-words.ts). */
const FIELD_WORD: Record<SheetNumField, ChangeField> = {
  quantity: 'qty',
  weightKg: 'kg',
  volumeM3: 'm3',
  measure: 'measure',
  bazaValue: 'baza',
};
export type SheetField = 'name' | 'tnvedCode' | 'note' | SheetNumField;

export interface SheetModel {
  kind: 'item' | 'ghost';
  /** `item:<id>` / `ghost:<key>` — the body's key. */
  key: string;
  seq: number | null;
  values: Record<SheetField, string>;
  drafted: Partial<Record<SheetField | 'bazaBasis', boolean>>;
  /** The seller's own unit word — display only (his 20a). */
  sellerUnit: string | null;
  /** The O'lchov box, when this row has one. */
  measure: { label: string; suffix: string | null; sm3: boolean } | null;
  basis: { value: BazaBasis | null; offered: BazaBasis[] };
  chips: { memory: boolean; import: boolean; reason: string | null };
  dictionaryBaza: WorkspaceItem['dictionaryBaza'];
  /** The 📥 door — a SAVED row with a SAVED code only. */
  importDoor: 'open' | 'row_dirty' | 'needs_code' | null;
  figure: SheetFigure;
}

export function RowSheet({
  open,
  model,
  codesListId,
  busy,
  saveDisabled,
  saveAnyway,
  deleteAnyway,
  error,
  aiRunning,
  refreshing,
  changes,
  changedElsewhere,
  asked,
  onField,
  onBasis,
  onAsk,
  onImport,
  onSave,
  onDelete,
  onDiscard,
  onClose,
}: {
  open: boolean;
  model: SheetModel | null;
  codesListId: string;
  busy: boolean;
  saveDisabled: boolean;
  /** A warning is on the screen, so the press is the acknowledgement. */
  saveAnyway: boolean;
  deleteAnyway: boolean;
  error: string | null;
  aiRunning: boolean;
  refreshing: boolean;
  /** «boshqa kishi hozirgina o'zgartirdi: …» — the row's own fields. */
  changes: FieldChange[];
  changedElsewhere: boolean;
  /** The fields whose ambiguity question was asked (blur or a press). */
  asked: SheetNumField[];
  onField: (field: SheetField, raw: string) => void;
  onBasis: (basis: BazaBasis) => void;
  onAsk: (field: SheetNumField) => void;
  onImport: () => void;
  onSave: () => void;
  onDelete: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('calc');
  return (
    <Overlay
      open={open}
      onClose={() => {
        // The draft lives in the table (and in storage, B5 a), so closing
        // never loses anything and is never refused.
        onClose();
        return true;
      }}
      closeLabel={t('phone.close')}
      testId="calc-phone-sheet"
      className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface-raised p-4 pb-safe shadow-pop md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[80dvh] md:w-[40rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
    >
      {model ? (
        <SheetBody
          key={model.key}
          model={model}
          codesListId={codesListId}
          busy={busy}
          saveDisabled={saveDisabled}
          saveAnyway={saveAnyway}
          deleteAnyway={deleteAnyway}
          error={error}
          aiRunning={aiRunning}
          refreshing={refreshing}
          changes={changes}
          changedElsewhere={changedElsewhere}
          asked={asked}
          onField={onField}
          onBasis={onBasis}
          onAsk={onAsk}
          onImport={onImport}
          onSave={onSave}
          onDelete={onDelete}
          onDiscard={onDiscard}
          onClose={onClose}
        />
      ) : null}
    </Overlay>
  );
}

function SheetBody({
  model,
  codesListId,
  busy,
  saveDisabled,
  saveAnyway,
  deleteAnyway,
  error,
  aiRunning,
  refreshing,
  changes,
  changedElsewhere,
  asked,
  onField,
  onBasis,
  onAsk,
  onImport,
  onSave,
  onDelete,
  onDiscard,
  onClose,
}: Omit<Parameters<typeof RowSheet>[0], 'open' | 'model'> & { model: SheetModel }) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const word = useFieldWord();
  const top = useRef<HTMLDivElement>(null);
  const messageKey = `${error ?? ''}|${aiRunning}|${refreshing}|${changes.length}|${changedElsewhere}`;

  // A message a press produced must be SEEN — it sits above the fields, and
  // a VED scrolled down to the baza would otherwise press again into it.
  useEffect(() => {
    if (messageKey !== '|false|false|0|false') top.current?.scrollIntoView({ block: 'nearest' });
  }, [messageKey]);

  const v = model.values;
  /** The reading of a numeric cell when it is the B4 a shape. */
  const ambiguityOf = (name: SheetField) => {
    if (name === 'name' || name === 'tnvedCode' || name === 'note') return null;
    const cell = readNumberCell(v[name]);
    return cell.state === 'ambiguous' ? cell : null;
  };
  /** A numeric cell nothing can read, once it was left or pressed (review
   * PHONE-4) — five number boxes and one sentence at the top named none of
   * them. Not while typing: «1.» on the way to «1.5» is no mistake yet. */
  const badHere = (name: SheetField) =>
    name !== 'name' &&
    name !== 'tnvedCode' &&
    name !== 'note' &&
    asked.includes(name) &&
    readNumberCell(v[name]).state === 'bad';
  const field = (name: SheetField) => {
    const numeric = name !== 'name' && name !== 'tnvedCode' && name !== 'note';
    const ambiguous = ambiguityOf(name);
    const testId = {
      name: 'calc-phone-name',
      tnvedCode: 'calc-phone-code',
      note: 'calc-phone-note',
      quantity: 'calc-phone-qty',
      weightKg: 'calc-phone-kg',
      volumeM3: 'calc-phone-m3',
      measure: 'calc-phone-measure',
      bazaValue: 'calc-phone-baza',
    }[name];
    // `!`: `.input` is declared after the utilities and its own border
    // colour wins over a plain `border-warn` (#419's cascade) — measured, the
    // mark was in the class list and nowhere on the screen.
    const warn = ambiguous || badHere(name) ? ' !border-warn' : model.drafted[name] ? ' border-brand-500' : '';
    const input =
      name === 'name' || name === 'note' ? (
        <textarea
          className={`input h-24${warn}`}
          data-testid={testId}
          value={v[name]}
          disabled={busy}
          onChange={(e) => onField(name, e.target.value)}
        />
      ) : (
        <input
          className={`input font-mono tabular-nums${warn}`}
          data-testid={testId}
          inputMode={name === 'tnvedCode' ? 'numeric' : 'decimal'}
          list={name === 'tnvedCode' ? codesListId : undefined}
          value={v[name]}
          disabled={busy}
          onChange={(e) => onField(name, e.target.value)}
          onBlur={() => {
            if (numeric) onAsk(name as SheetNumField);
          }}
        />
      );
    return input;
  };

  /** «1.125 dollarmi yoki 1125 dollarmi?» — under its ROW at the full width
   * of the sheet (a half-width column left the two answers below the fold),
   * shown on blur and on a press, gone with the keystroke that settles it. */
  const question = (name: SheetNumField) => {
    if (badHere(name)) {
      return (
        <p className="mt-1 text-sm text-warn" data-testid="calc-phone-bad">
          ⚠ {word(FIELD_WORD[name])}: {t('errors.bad_number')}
        </p>
      );
    }
    const ambiguous = ambiguityOf(name);
    if (!ambiguous || !asked.includes(name)) return null;
    return (
      <div
        className="mt-1 rounded-xl border border-warn/40 bg-warn/10 p-2 text-sm"
        data-testid="calc-phone-ambiguous"
      >
        <p className="font-semibold text-warn">
          {name === 'bazaValue'
            ? t('ambiguous.baza', { a: ambiguous.decimalText, b: ambiguous.thousandsText })
            : t('ambiguous.number', { a: ambiguous.decimalText, b: ambiguous.thousandsText })}
        </p>
        <p className="mt-0.5 text-2xs text-ink-600">{t('ambiguous.hint')}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary !min-h-11 font-mono"
            data-testid="calc-phone-ambiguous-decimal"
            onClick={() => onField(name, ambiguous.decimalText)}
          >
            {ambiguous.decimalText}
          </button>
          <button
            type="button"
            className="btn-secondary !min-h-11 font-mono"
            data-testid="calc-phone-ambiguous-thousands"
            onClick={() => onField(name, ambiguous.thousandsText)}
          >
            {ambiguous.thousandsText}
          </button>
        </div>
      </div>
    );
  };

  const figure = model.figure;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="calc-phone-body">
      <div ref={top} className="space-y-1">
        <h2 className="text-sm font-semibold">
          {model.kind === 'item' && model.seq !== null
            ? t('phone.rowTitle', { seq: model.seq })
            : t('phone.newItem')}
        </h2>
        {error ? (
          <p className="chip chip-warn" data-testid="calc-phone-error">
            {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_ready') : error}
            {error === 'stale_build' ? (
              <button
                type="button"
                className="btn-primary ml-2 !min-h-9"
                data-testid="calc-reload"
                onClick={() => void reloadFresh()}
              >
                {t('reloadPage')}
              </button>
            ) : null}
          </p>
        ) : null}
        {aiRunning ? (
          <p className="text-2xs text-warn" data-testid="calc-phone-ai-running">
            {t('phone.aiRunning')}
          </p>
        ) : null}
        {refreshing ? (
          <p className="text-2xs text-ink-500" data-testid="calc-phone-refreshing">
            {t('phone.refreshing')}
          </p>
        ) : null}
        {changes.length > 0 ? (
          <div
            className="rounded-xl border border-warn/40 bg-warn/10 p-2 text-sm"
            data-testid="calc-phone-changed"
          >
            <p className="font-semibold text-warn">
              {t('phone.changed', {
                fields: changes.map((c) => `${word(c.field)}: ${c.before} → ${c.after}`).join('; '),
              })}
            </p>
            <p className="mt-0.5 text-2xs text-ink-600">{t('phone.changedOverwrite')}</p>
          </div>
        ) : changedElsewhere ? (
          <p className="text-2xs text-ink-500" data-testid="calc-phone-changed-elsewhere">
            {t('phone.changedElsewhere')}
          </p>
        ) : null}
      </div>

      <div className="mt-2 space-y-3">
        <label className="block">
          <span className="label">{t('phone.name')}</span>
          {field('name')}
        </label>
        <label className="block">
          <span className="label">{t('phone.code')}</span>
          {field('tnvedCode')}
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="block min-w-0">
            <span className="label">{t('phone.qty')}</span>
            {field('quantity')}
          </label>
          <label className="block min-w-0">
            <span className="label">{t('phone.kg')}</span>
            {field('weightKg')}
          </label>
          <label className="block min-w-0">
            <span className="label">{t('phone.m3')}</span>
            {field('volumeM3')}
          </label>
        </div>
        {question('quantity')}
        {question('weightKg')}
        {question('volumeM3')}
        {model.sellerUnit ? (
          <p className="text-2xs text-ink-500">
            {t('phone.sellerUnit', { unit: model.sellerUnit })}
          </p>
        ) : null}
        {model.measure ? (
          <label className="block">
            <span className="label">
              {model.measure.label}
              {model.measure.sm3 ? ` · ${t('table.sm3Hint')}` : ''}
            </span>
            {field('measure')}
            {question('measure')}
          </label>
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <label className="block min-w-0">
            <span className="label">{t('phone.baza')}</span>
            {field('bazaValue')}
          </label>
          <label className="block min-w-0">
            <span className="label">{t('phone.basis')}</span>
            <BasisSelect
              value={model.basis.value}
              offered={model.basis.offered}
              label={t('phone.basis')}
              testId="calc-phone-basis"
              drafted={model.drafted.bazaBasis === true}
              disabled={busy}
              onPick={onBasis}
              size="field"
            />
          </label>
        </div>
        {question('bazaValue')}
        {model.chips.memory || model.chips.import || model.chips.reason || model.dictionaryBaza ? (
          <div className="space-y-0.5 text-2xs text-ink-500">
            {model.chips.memory ? (
              <p data-testid="calc-phone-chip-memory">🧠 {t('memoryGuess')}</p>
            ) : null}
            {model.chips.import ? (
              <p data-testid="calc-phone-chip-import">📥 {t('importGuess')}</p>
            ) : null}
            {model.chips.reason ? (
              <p className="break-words" data-testid="calc-phone-chip-reason">
                🤖 {model.chips.reason}
              </p>
            ) : null}
            {model.dictionaryBaza ? (
              <p>
                ≈ ${model.dictionaryBaza.bazaUsd}/
                {basisLabel(model.dictionaryBaza.basis, t('perUnit'))}
                {model.dictionaryBaza.stale ? (
                  <span className="ml-1 text-warn">⚠ {t('stale')}</span>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
        {model.importDoor === 'needs_code' ? (
          <p className="text-2xs text-ink-500">{t('phone.importNeedsCode')}</p>
        ) : model.importDoor ? (
          <button
            type="button"
            className="btn-secondary !min-h-11 w-full"
            data-testid="calc-phone-import"
            disabled={busy || model.importDoor === 'row_dirty'}
            onClick={onImport}
          >
            📥 {t('importPick')}
            {model.importDoor === 'row_dirty' ? (
              <span className="text-2xs font-normal text-warn"> · {t('statsRowDirty')}</span>
            ) : null}
          </button>
        ) : null}
        <label className="block">
          <span className="label">{t('table.note')}</span>
          {field('note')}
        </label>

        {/* Away from Saqlash, at the bottom of the body. */}
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {model.kind === 'item' ? (
            <>
              <button
                type="button"
                className="btn-secondary !min-h-11 text-bad"
                disabled={busy}
                data-testid="calc-phone-delete"
                onClick={onDelete}
              >
                🗑 {deleteAnyway ? t('phone.deleteAnyway') : tc('delete')}
              </button>
              {Object.keys(model.drafted).length > 0 ? (
                <button
                  type="button"
                  className="btn-ghost !min-h-11"
                  disabled={busy}
                  data-testid="calc-phone-discard"
                  onClick={onDiscard}
                >
                  {t('phone.discard')}
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className="btn-ghost !min-h-11"
              disabled={busy}
              data-testid="calc-phone-discard"
              onClick={onDiscard}
            >
              {t('phone.removeNew')}
            </button>
          )}
        </div>
        <p className="text-2xs text-ink-500">{t('phone.closeKeeps')}</p>
      </div>

      <div
        className="sticky bottom-0 -mx-1 mt-3 space-y-1 border-t border-line bg-surface-raised px-1 pt-2"
        data-testid="calc-phone-footer"
      >
        <p className="text-2xs text-ink-700" data-testid="calc-phone-live">
          {figure.state === 'no_code'
            ? t('phone.liveNoCode')
            : figure.state === 'unknown_law'
              ? t('phone.liveUnknownLaw')
              : t('phone.live', {
                  amount: figure.customs.ok
                    ? `$${figure.customs.customsUsd.toFixed(2)}`
                    : `⚠ ${refusalWord(t, figure.customs.reason)}`,
                })}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary !min-h-11 min-w-0 grow !px-3"
            disabled={saveDisabled}
            data-testid="calc-phone-save"
            onClick={onSave}
          >
            {saveAnyway ? t('phone.saveAnyway') : tc('save')}
          </button>
          <button
            type="button"
            className="btn-secondary !min-h-11 shrink-0 !px-3"
            data-testid="calc-phone-close"
            onClick={onClose}
          >
            {t('phone.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
