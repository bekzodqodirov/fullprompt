'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import { CALC_SECTIONS, type CalcField, type CalcSection } from '@/modules/wms/calc/intake';
import { FIELD_LABELS, SECTION_LABELS } from '@/modules/wms/calc/labels';
import { readNumberCell } from '@/modules/wms/calc/number-cell';
import { parseGoodsLine, unitWordKey } from '@/modules/wms/calc/units';
import {
  AMOUNT_UNITS,
  answerAmbiguous,
  blankRow,
  codeLooksRight,
  dropBareNumbers,
  isBlankRow,
  isBlockingProblem,
  itemOfRow,
  keepPair,
  labelNumbers,
  nameKeepsNumber,
  rowFromDealLine,
  rowIssues,
  rowOfLine,
  textRows,
  type AmountUnit,
  type CellField,
  type RowIssue,
  type SendRow,
} from '@/modules/wms/calc/send-rows';
import type { MeasureUnit } from '@/modules/wms/calc/pricing';
import { submitCalcAction, type SendAsks } from '@/app/(protected)/hisoblash/actions';
import { measureNeedText, type CalcT } from '@/app/(protected)/hisoblash/[id]/words';

/** A deal's own goods line, as the prefill takes it (`dealLinesForCalc`). */
export interface DealLineSeed {
  name: string;
  tnvedCode: string | null;
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
}

/**
 * The desk half of «Hisoblatishga yuborish».
 *
 * Controlled inputs and no `<form action>`: this form holds a goods table and
 * an upload the person has already paid real time for, and the commonest
 * refusal — «forgot the section», «1,200 — which?» — must not also empty it
 * (#377/#419/#463). The reset is gated on success for the same reason:
 * clearing before reading the verdict is how uploads get orphaned.
 *
 * THE GOODS (2026-10-09, the owner's «tnved code va dona m2 juftda otadgan
 * tovarlarni kirgizadgan joyi yoqku»): one product per two-line block in the
 * card's 358 px rail (judge UX1) — name · count · ✕ over netto kg · amount
 * with its unit · TNVED — and above it the quick textarea every e2e and every
 * seller already types «nomi, soni» into, read LIVE by the kernel into rows
 * below it (UX2). Editing a row read from the text moves the text into the
 * table, so nothing is ever held twice. A number that reads two ways, two
 * pairs or unlabelled numbers stop the send with one-tap answers; a carton
 * count or an unknown unit is SENT, with a chip — the door writes the note.
 *
 * Files are pre-bound to a note id minted HERE (#180's pattern, the same one
 * the bot and the receive wizard use), so photos can be attached before the
 * request exists; the id travels to the action, which mints the note under it
 * and refuses an id that is already taken.
 */
export function CalcSendForm({
  entityType,
  entityId,
  revalidate,
  dealLines = [],
}: {
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
  /** The deal's «📋 Qatorlar», for «Bitim qatorlaridan to‘ldirish» (UX17). */
  dealLines?: DealLineSeed[];
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [asks, setAsks] = useState<SendAsks | null>(null);

  const [noteId, setNoteId] = useState(() => uuidv4());
  const [section, setSection] = useState<CalcSection>('podklyuch');
  const [fromCity, setFromCity] = useState('');
  const [toCity, setToCity] = useState('');
  const [weight, setWeight] = useState('');
  const [volume, setVolume] = useState('');
  const [goodsText, setGoodsText] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState(0);
  const [uploading, setUploading] = useState(false);

  const nextKey = useRef(1);
  const mint = () => nextKey.current++;
  const [rows, setRows] = useState<SendRow[]>(() => [blankRow(0)]);

  // The quick box, read live. Keys are offset so they never meet a table key.
  const fromText = useMemo(() => textRows(goodsText, 1_000_000), [goodsText]);
  // The pristine first row steps aside while the quick box holds lines, so
  // a seller who only types there does not see an empty row above them.
  const keptHand = () => rows.filter((r) => r.touched || !isBlankRow(r));
  const handRows = fromText.length > 0 ? keptHand() : rows;
  const shown: { row: SendRow; textIndex: number | null }[] = [
    ...handRows.map((row) => ({ row, textIndex: null })),
    ...fromText.map((row, i) => ({ row, textIndex: i })),
  ];

  /** The non-empty textarea lines, by their position among the rows. */
  const textLineAt = (i: number) => {
    const all = goodsText.split('\n');
    let seen = -1;
    for (let at = 0; at < all.length; at += 1) {
      if (all[at]!.replace(/\r$/, '').trim()) seen += 1;
      if (seen === i) return at;
    }
    return -1;
  };

  /** Move the text rows into the table — the moment one of them is edited,
   * or a row is added after them — so nothing is ever held twice. */
  const takeText = (): SendRow[] => {
    const absorbed = fromText.map((r) => ({ ...r, key: mint() }));
    if (absorbed.length > 0) setGoodsText('');
    return absorbed;
  };

  const editRow = (at: number, change: (row: SendRow) => SendRow | SendRow[]) => {
    const entry = shown[at];
    if (!entry) return;
    const asList = (r: SendRow | SendRow[]) => (Array.isArray(r) ? r : [r]);
    if (entry.textIndex === null) {
      const list = [...rows];
      const idx = list.findIndex((r) => r.key === entry.row.key);
      list.splice(idx < 0 ? list.length : idx, idx < 0 ? 0 : 1, ...asList(change(entry.row)));
      setRows(list.length > 0 ? list : [blankRow(mint())]);
      return;
    }
    const kept = keptHand();
    const absorbed = takeText();
    absorbed.splice(entry.textIndex, 1, ...asList(change(absorbed[entry.textIndex]!)));
    setRows([...kept, ...absorbed]);
  };

  const setCell = (at: number, field: keyof SendRow, value: string) =>
    editRow(at, (row) => ({ ...row, [field]: value, touched: true }));

  /** A one-tap answer: rewrite the row's text and read it again. */
  const answerText = (at: number, rewrite: (raw: string) => string) => {
    const entry = shown[at];
    if (!entry || entry.row.raw === null) return;
    const raw = rewrite(entry.row.raw);
    if (entry.textIndex !== null) {
      const lines = goodsText.split('\n');
      const line = textLineAt(entry.textIndex);
      if (line >= 0) lines[line] = raw;
      setGoodsText(lines.join('\n'));
      return;
    }
    editRow(at, (row) => rowOfLine(parseGoodsLine(raw), row.key, raw));
  };

  const removeRow = (at: number) => {
    const entry = shown[at];
    if (!entry) return;
    if (entry.textIndex !== null) {
      const lines = goodsText.split('\n');
      const line = textLineAt(entry.textIndex);
      if (line >= 0) lines.splice(line, 1);
      setGoodsText(lines.join('\n'));
      return;
    }
    const next = rows.filter((r) => r.key !== entry.row.key);
    setRows(next.length > 0 ? next : [blankRow(mint())]);
  };

  const addRow = (focus = true) => {
    const fresh = { ...blankRow(mint()), touched: true };
    setRows([...handRows, ...takeText(), fresh]);
    if (focus) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>(`[data-send-row="${fresh.key}"] [data-testid="calc-row-name"]`)?.focus(),
      );
    }
  };

  /** A multi-line paste into a name cell becomes rows (UX2). */
  const pasteIntoName = (at: number, text: string): boolean => {
    const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
    if (lines.length < 2) return false;
    editRow(at, (row) => {
      const read = lines.map((l) => rowOfLine(parseGoodsLine(l), mint(), l));
      return isBlankRow(row) ? read : [row, ...read];
    });
    return true;
  };

  /** «Bitim qatorlaridan to‘ldirish» — EMPTY rows first, then appended (UX17). */
  const fillFromDeal = () => {
    const seeds = dealLines.map((dl) => rowFromDealLine(dl, mint()));
    const out = [...handRows, ...takeText()];
    for (const seed of seeds) {
      const empty = out.findIndex((r) => isBlankRow(r));
      if (empty >= 0) out[empty] = seed;
      else out.push(seed);
    }
    setRows(out);
  };

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const body = new FormData();
        body.append('file', file);
        body.append('entityType', 'crm_activity');
        body.append('entityId', noteId);
        const res = await fetch('/api/files/upload', {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(String(res.status));
        setFiles((n) => n + 1);
      }
      setError(null);
    } catch {
      setError('failed');
    } finally {
      setUploading(false);
    }
  }

  const live = shown.map((s) => s.row).filter((r) => !isBlankRow(r));
  const weightCell = readNumberCell(weight);
  const volumeCell = readNumberCell(volume);
  const totalsBlocked = [weightCell, volumeCell].some((c) => c.state === 'ambiguous' || c.state === 'bad');
  const rowsBlocked = live.some((r) => rowIssues(r).blocking.length > 0);

  function send() {
    if (rowsBlocked || totalsBlocked) {
      setLocalError(t('sendTable.fixFirst'));
      return;
    }
    setLocalError(null);
    const goods = live.map(itemOfRow).filter((g) => g !== null);
    startTransition(async () => {
      const result = await submitCalcAction({
        entityType,
        entityId,
        section,
        fromCity,
        toCity,
        weightKg: weightCell.state === 'ok' ? weightCell.value : null,
        volumeM3: volumeCell.state === 'ok' ? volumeCell.value : null,
        goods,
        // A note is written only when there is something to say — text, or
        // files already uploaded against this id.
        noteId: note.trim() || files > 0 ? noteId : '',
        noteText: note.trim() || t('panelTitle'),
        revalidate,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setSent(true);
      setAsks(result.asks ?? null);
      setGoodsText('');
      setRows([blankRow(mint())]);
      setNote('');
      setFiles(0);
      // The next request is a NEW one — its files must not join this one.
      setNoteId(uuidv4());
      router.refresh();
    });
  }

  return (
    <div className="space-y-2" data-testid="calc-send-form">
      <div>
        <span className="label">{t('sectionLabel')}</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {CALC_SECTIONS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`calc-section-${value}`}
              aria-pressed={section === value}
              className={section === value ? 'chip chip-brand' : 'chip chip-neutral'}
              onClick={() => setSection(value)}
            >
              {t(SECTION_LABELS[value] as 'sections.podklyuch')}
            </button>
          ))}
        </div>
      </div>

      {section !== 'rastamojka' ? (
        <div className="flex flex-wrap gap-2">
          <input
            className="input !w-36"
            placeholder={t('fields.fromCity')}
            data-testid="calc-from-city"
            value={fromCity}
            onChange={(event) => setFromCity(event.target.value)}
          />
          <input
            className="input !w-36"
            placeholder={t('fields.toCity')}
            data-testid="calc-to-city"
            value={toCity}
            onChange={(event) => setToCity(event.target.value)}
          />
        </div>
      ) : null}

      {/* The SHIPMENT totals — brutto, for the truck (and the upsale's
          quoted measure, judge MR-9). A line's own weight is netto, below. */}
      <div className="grid grid-cols-2 gap-2">
        <TotalBox
          label={t('sendTable.totalWeight')}
          testId="calc-weight"
          value={weight}
          onChange={setWeight}
        />
        <TotalBox
          label={t('sendTable.totalVolume')}
          testId="calc-volume"
          value={volume}
          onChange={setVolume}
        />
      </div>

      <div>
        <label className="label" htmlFor="calc-goods">
          {t('sendTable.quickLabel')}
        </label>
        <textarea
          id="calc-goods"
          data-testid="calc-goods"
          className="input h-20"
          placeholder={t('sendTable.quickHint')}
          value={goodsText}
          onChange={(event) => setGoodsText(event.target.value)}
        />
      </div>

      <div className="space-y-1.5" data-testid="calc-rows">
        {shown.map((entry, at) => (
          <RowBlock
            key={entry.row.key}
            row={entry.row}
            index={at}
            last={at === shown.length - 1}
            t={t}
            onCell={(field, value) => setCell(at, field, value)}
            onRemove={() => removeRow(at)}
            onAnswer={(rewrite) => answerText(at, rewrite)}
            onRow={(change) => editRow(at, change)}
            onAddRow={() => addRow(true)}
            onPasteName={(text) => pasteIntoName(at, text)}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary !min-h-9" data-testid="calc-add-row" onClick={() => addRow(true)}>
            {t('sendTable.addRow')}
          </button>
          {entityType === 'deal' && dealLines.length > 0 ? (
            <button type="button" className="btn-secondary !min-h-9" data-testid="calc-from-deal" onClick={fillFromDeal}>
              {t('sendTable.fromDeal')}
            </button>
          ) : null}
        </div>
      </div>

      <textarea
        data-testid="calc-note"
        className="input h-16"
        placeholder={t('answerNote')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-secondary cursor-pointer !min-h-9">
          📎
          <input
            type="file"
            multiple
            className="hidden"
            data-testid="calc-files"
            onChange={(event) => addFiles(event.target.files)}
          />
        </label>
        {files > 0 ? <span className="text-2xs text-ink-500">{files}</span> : null}
        {uploading ? <span className="text-2xs text-ink-500">{tc('loading')}</span> : null}
      </div>

      <button
        type="button"
        disabled={pending || uploading}
        data-testid="calc-send"
        className="btn-primary w-full"
        onClick={send}
      >
        {pending ? tc('loading') : sent ? '✅' : t('send')}
      </button>

      {localError ? (
        <p role="alert" data-testid="calc-send-blocked" className="text-sm font-semibold text-warn">
          {localError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="calc-send-error" className="text-sm font-semibold text-bad">
          {t(`errors.${error}` as 'errors.failed')}
        </p>
      ) : null}
      {sent && asks && (asks.missing.length > 0 || asks.lines.length > 0) ? <SentAsks asks={asks} t={t} /> : null}
      <p className="text-2xs text-ink-500">{t('deadlineHint')}</p>
    </div>
  );
}

/** A shipment total — read by the ONE cell reader, «1,200» asked (B4 a). */
function TotalBox({
  label,
  testId,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations('calc');
  const cell = readNumberCell(value);
  return (
    <div className="min-w-0">
      <span className="block text-2xs text-ink-500">{label}</span>
      <input
        className="input-cell"
        inputMode="decimal"
        aria-label={label}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {cell.state === 'ambiguous' ? (
        <AmbiguousPick
          a={cell.decimalText}
          b={cell.thousandsText}
          onPick={(text) => onChange(text)}
          question={t('ambiguous.number', { a: cell.decimalText, b: cell.thousandsText })}
        />
      ) : cell.state === 'bad' ? (
        <p className="text-2xs text-bad">{t('sendTable.badCell', { text: value })}</p>
      ) : null}
    </div>
  );
}

function AmbiguousPick({
  question,
  a,
  b,
  onPick,
}: {
  question: string;
  a: string;
  b: string;
  onPick: (text: string) => void;
}) {
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-warn" data-testid="calc-ambiguous">
      <span>{question}</span>
      <button type="button" className="chip chip-warn" onClick={() => onPick(a)}>
        {a}
      </button>
      <button type="button" className="chip chip-warn" onClick={() => onPick(b)}>
        {b}
      </button>
    </div>
  );
}

/**
 * One product as a two-line block (judge UX1): line 1 name · count · ✕,
 * line 2 netto kg · amount + unit · TNVED last, so «nomi → soni» stays two
 * keystrokes apart. Enter or Tab in the last row's TNVED adds a row. A row
 * with an unanswered question is READ-ONLY until it is answered — editing
 * around a figure nobody has read would drop it in silence.
 */
function RowBlock({
  row,
  index,
  last,
  t,
  onCell,
  onRemove,
  onAnswer,
  onRow,
  onAddRow,
  onPasteName,
}: {
  row: SendRow;
  index: number;
  last: boolean;
  t: CalcT;
  onCell: (field: keyof SendRow, value: string) => void;
  onRemove: () => void;
  onAnswer: (rewrite: (raw: string) => string) => void;
  onRow: (change: (row: SendRow) => SendRow) => void;
  onAddRow: () => void;
  onPasteName: (text: string) => boolean;
}) {
  const { blocking, said } = rowIssues(row);
  const locked = row.raw !== null && row.problems.some(isBlockingProblem);
  const line = row.raw !== null ? parseGoodsLine(row.raw) : null;
  const unitWord = (u: string) => {
    const key = unitWordKey(u);
    return key ? t(`units.${key}` as 'units.dona') : u;
  };
  // A number cell names its unit AFTER it is filled too — «300» and «150»
  // side by side read as nothing once the placeholders are gone, and the
  // whole point of the table is which column a figure is in. The full name
  // stays the box's label and its hover.
  const cell = (
    field: CellField,
    label: string,
    testId: string,
    width: string,
    suffix?: { word: string; hint: string },
  ) => {
    const input = (
      <input
        className={`input-cell ${width}${suffix ? ' !pr-9' : ''}`}
        inputMode="decimal"
        placeholder={suffix ? suffix.hint : label}
        aria-label={label}
        title={label}
        data-testid={testId}
        value={row[field]}
        readOnly={locked}
        onChange={(event) => onCell(field, event.target.value)}
      />
    );
    if (!suffix) return input;
    return (
      <span className="relative shrink-0">
        {input}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-ink-500"
        >
          {suffix.word}
        </span>
      </span>
    );
  };
  return (
    <div
      className={`space-y-1 rounded-lg border p-1.5 ${blocking.length > 0 ? 'border-warn' : 'border-line'}`}
      data-testid="calc-row"
      data-row={index}
      data-send-row={row.key}
    >
      <div className="flex items-center gap-1.5">
        <input
          className="input-cell min-w-0 flex-1"
          placeholder={t('sendTable.name')}
          aria-label={t('sendTable.name')}
          data-testid="calc-row-name"
          value={row.name}
          readOnly={locked}
          onChange={(event) => onCell('name', event.target.value)}
          onPaste={(event) => {
            if (onPasteName(event.clipboardData.getData('text'))) event.preventDefault();
          }}
        />
        {cell('qty', t('sendTable.qty'), 'calc-row-qty', '!w-24', {
          word: t('units.dona'),
          hint: t('sendTable.qtyShort'),
        })}
        <button
          type="button"
          tabIndex={-1}
          className="btn-ghost !min-h-9 shrink-0 !px-2"
          aria-label={t('sendTable.remove')}
          data-testid="calc-row-remove"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        {cell('kg', t('sendTable.kg'), 'calc-row-kg', '!w-24', {
          word: t('units.kg'),
          hint: t('sendTable.kgShort'),
        })}
        {cell('amount', t('sendTable.amount'), 'calc-row-amount', '!w-16')}
        <select
          className="input-cell !w-14 !px-1"
          aria-label={t('sendTable.unitLabel')}
          data-testid="calc-row-unit"
          value={row.unit}
          disabled={locked}
          onChange={(event) => onCell('unit', event.target.value as AmountUnit)}
        >
          {AMOUNT_UNITS.map((u) => (
            <option key={u} value={u}>
              {unitWord(u)}
            </option>
          ))}
        </select>
        <input
          className="input-cell min-w-0 flex-1 !px-1.5 tabular-nums"
          placeholder={t('sendTable.code')}
          aria-label={t('sendTable.code')}
          data-testid="calc-row-code"
          value={row.code}
          readOnly={locked}
          onChange={(event) => onCell('code', event.target.value)}
          onKeyDown={(event) => {
            if (last && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
              event.preventDefault();
              onAddRow();
            }
          }}
        />
      </div>

      {/* What stops the send, each with its one-tap answer (UX3). */}
      {blocking.map((issue, i) => (
        <IssueLine
          key={i}
          issue={issue}
          row={row}
          line={line}
          t={t}
          unitWord={unitWord}
          onAnswer={onAnswer}
          onRow={onRow}
          onCell={onCell}
        />
      ))}
      {/* …and what is only said: the door writes it into the row's note. */}
      {row.notes.length > 0 || said.length > 0 || !codeLooksRight(row.code) || row.extraVolume !== null ? (
        <div className="flex flex-wrap gap-1" data-testid="calc-row-chips">
          {row.notes.map((n, i) => (
            <span key={`n${i}`} className="chip chip-warn !text-2xs">
              📝 {n}
              {row.problems.some((p) => p.kind === 'cartons_only') && i === 0 ? ` — ${t('pasteProblems.askedLater')}` : ''}
            </span>
          ))}
          {said.map((issue, i) =>
            issue.kind === 'line' && issue.problem.kind === 'code_short' ? (
              <span key={`s${i}`} className="chip chip-warn !text-2xs">
                {t('pasteProblems.codeShort', { text: issue.problem.text })}
              </span>
            ) : issue.kind === 'line' && issue.problem.kind === 'repeated' ? (
              <span key={`s${i}`} className="chip chip-warn !text-2xs">
                {t('pasteProblems.repeated', { unit: unitWord(issue.problem.unit === 'karobka' ? 'dona' : issue.problem.unit) })}
              </span>
            ) : null,
          )}
          {!codeLooksRight(row.code) && !said.some((s) => s.kind === 'line' && s.problem.kind === 'code_short') ? (
            <span className="chip chip-warn !text-2xs">{t('sendTable.codeBad', { text: row.code })}</span>
          ) : null}
          {row.extraVolume !== null ? (
            <span className="chip chip-neutral !text-2xs">{t('sendTable.extraVolume', { n: String(row.extraVolume) })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IssueLine({
  issue,
  row,
  line,
  t,
  unitWord,
  onAnswer,
  onRow,
  onCell,
}: {
  issue: RowIssue;
  row: SendRow;
  line: ReturnType<typeof parseGoodsLine> | null;
  t: CalcT;
  unitWord: (u: string) => string;
  onAnswer: (rewrite: (raw: string) => string) => void;
  onRow: (change: (row: SendRow) => SendRow) => void;
  onCell: (field: keyof SendRow, value: string) => void;
}) {
  if (issue.kind === 'no_name') {
    return <p className="text-2xs text-warn" data-testid="calc-row-problem">{t('sendTable.noName')}</p>;
  }
  if (issue.kind === 'cell') {
    if (issue.cell.state === 'bad') {
      return (
        <p className="text-2xs text-bad" data-testid="calc-row-problem">
          {t('sendTable.badCell', { text: issue.text })}
        </p>
      );
    }
    const { decimalText, thousandsText } = issue.cell;
    return (
      <AmbiguousPick
        question={t('ambiguous.number', { a: decimalText, b: thousandsText })}
        a={decimalText}
        b={thousandsText}
        onPick={(text) => onCell(issue.field, text)}
      />
    );
  }
  const p = issue.problem;
  if (p.kind === 'ambiguous') {
    return (
      <div className="flex flex-wrap items-center gap-1 text-2xs text-warn" data-testid="calc-row-problem">
        <span>{t('ambiguous.number', { a: String(p.decimal), b: String(p.thousands) })}</span>
        <button type="button" className="chip chip-warn" data-testid="calc-row-fix-0" onClick={() => onAnswer((raw) => answerAmbiguous(raw, p.text, p.decimal))}>
          {String(p.decimal)}
        </button>
        <button type="button" className="chip chip-warn" data-testid="calc-row-fix-1" onClick={() => onAnswer((raw) => answerAmbiguous(raw, p.text, p.thousands))}>
          {String(p.thousands)}
        </button>
      </div>
    );
  }
  if (p.kind === 'two_pairs' && line) {
    return (
      <div className="flex flex-wrap items-center gap-1 text-2xs text-warn" data-testid="calc-row-problem">
        <span>{t('pasteProblems.twoPairs')}</span>
        {p.units.map((u: MeasureUnit, i) => (
          <button
            key={u}
            type="button"
            className="chip chip-warn"
            data-testid={`calc-row-fix-${i}`}
            onClick={() => onAnswer((raw) => keepPair(raw, line, u))}
          >
            {t('pasteProblems.keepPair', { unit: unitWord(u) })}
          </button>
        ))}
      </div>
    );
  }
  if (p.kind === 'unlabelled' && line) {
    const two = p.values.length === 2 ? (p.values as [number, number]) : null;
    // «nomda» writes the row outright, so it is offered only when this is
    // the line's ONE open question — releasing the row's text with another
    // still standing would drop that figure unread.
    const alone = row.problems.filter(isBlockingProblem).length === 1;
    return (
      <div className="flex flex-wrap items-center gap-1 text-2xs text-warn" data-testid="calc-row-problem">
        <span>{two ? t('pasteProblems.unlabelled') : t('pasteProblems.unlabelledMany')}</span>
        {two ? (
          <>
            <button type="button" className="chip chip-warn" data-testid="calc-row-fix-0" onClick={() => onAnswer(() => labelNumbers(line, two, true))}>
              {t('pasteProblems.pairLabel', { a: String(two[0]), b: String(two[1]) })}
            </button>
            <button type="button" className="chip chip-warn" data-testid="calc-row-fix-1" onClick={() => onAnswer(() => labelNumbers(line, two, false))}>
              {t('pasteProblems.pairLabel', { a: String(two[1]), b: String(two[0]) })}
            </button>
            {alone ? (
              <button
                type="button"
                className="chip chip-warn"
                data-testid="calc-row-fix-name"
                onClick={() => onRow((current) => nameKeepsNumber(current, line, two))}
              >
                {t('pasteProblems.nameKeeps', { a: String(two[0]), b: String(two[1]) })}
              </button>
            ) : null}
          </>
        ) : null}
        <button type="button" className="chip chip-neutral" data-testid="calc-row-drop" onClick={() => onAnswer(() => dropBareNumbers(line))}>
          {t('pasteProblems.dropNumbers')}
        </button>
      </div>
    );
  }
  return null;
}

/**
 * «Yuborildi. VED so‘raydi: …» (judge UX13) — non-blocking; the request is
 * already in the queue. The words are the VED chips' own (`measureNeedText`,
 * `FIELD_LABELS`), capped like every list of lines (UX18).
 */
function SentAsks({ asks, t }: { asks: SendAsks; t: CalcT }) {
  const fields = asks.missing.filter((f) => f !== 'itemMeasure' && f !== 'lineNeed');
  const lines = asks.lines.slice(0, 8);
  return (
    <div className="rounded-lg border border-warn/50 p-2 text-2xs" data-testid="calc-sent-asks">
      <p className="font-semibold text-warn">{t('sendTable.sentAsks')}</p>
      {fields.length > 0 ? (
        <p className="text-ink-600">{fields.map((f) => t(FIELD_LABELS[f as CalcField] as 'fields.goods')).join(', ')}</p>
      ) : null}
      <ul className="mt-0.5 space-y-0.5 text-ink-600">
        {lines.map((l) => (
          <li key={l.row}>
            {l.pinned.length > 0
              ? l.pinned
                  .map((n) =>
                    measureNeedText(t, {
                      reason: 'measure_missing',
                      itemSeq: l.row,
                      itemLabel: l.label,
                      unit: n.unit,
                      half: n.why,
                      rate: n.rate,
                    }),
                  )
                  .filter(Boolean)
                  .join('; ')
              : t('sendTable.askAny', { row: String(l.row), label: l.label })}
          </li>
        ))}
        {asks.lines.length > lines.length ? (
          <li>{t('sendTable.more', { n: String(asks.lines.length - lines.length) })}</li>
        ) : null}
      </ul>
    </div>
  );
}
