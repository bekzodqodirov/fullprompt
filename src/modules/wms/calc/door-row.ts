import type { MeasureUnit } from './pricing';
import { normalizeRowUnit, normalizeTnved, routeAmount } from './units';

/**
 * ONE normalisation at the door (docs/RASTAMOJKA-TUZATISH.md P1.2, §7.1):
 * every way into a calculation — the seller's card form, the bot, the chat
 * thread, an invoice file — hands `openCalcRequest` its lines, and this is
 * where each number is put in the column its unit NAMES and each code is
 * shape-checked. It has no rule of its own: the column is the kernel's
 * `normalizeRowUnit`, the code is the kernel's `normalizeTnved` (judge S7,
 * MR-18). Pure, so a door's row can be proven without a database.
 *
 * Nothing a door said is DROPPED. A number that moved leaves the seller's
 * words in the note («sotuvchi: 120 m2»); a carton count or a unit nobody
 * prices clears the piece column and says so; a code that is not 4-10
 * digits, or a typed nine-digit one, goes into the note and never into
 * `tnved_code`; a figure no column can hold is refused into the note rather
 * than overflowing the insert into a «server yangilanmoqda» lie.
 */
export interface DoorItemInput {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  measureUnit?: MeasureUnit | null;
  measureQty?: number | null;
  tnvedCode?: string | null;
  note?: string | null;
}

export interface DoorRow {
  name: string;
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
  /** The code as stored — null when there was none or it was not a code. */
  tnvedCode: string | null;
  note: string | null;
}

/** numeric(12,3) holds nine integer digits; measure_qty numeric(14,4), ten. */
const ROW_CAP = 1e9;
const PAIR_CAP = 1e10;

const fmt = (n: number) => String(Number(n.toFixed(4)));

export function doorRow(item: DoorItemInput): DoorRow {
  const notes: string[] = [];
  const figure = (value: number | null | undefined, cap: number, word: string): number | null => {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
    if (value >= cap) {
      notes.push(`sotuvchi: ${fmt(value)} ${word} — juda katta son, yozilmadi`);
      return null;
    }
    return value;
  };

  const unitWord = item.unit?.trim().slice(0, 20) || null;
  const quantity = figure(item.quantity, ROW_CAP, unitWord ?? 'dona');
  const weightKg = figure(item.weightKg, ROW_CAP, 'kg');
  const volumeM3 = figure(item.volumeM3, ROW_CAP, 'm³');

  // A structured pair is kept only in a unit the pair can hold — read by the
  // kernel's own router, so the door does not keep a second list of units.
  let measureUnit: MeasureUnit | null = null;
  let measureQty: number | null = null;
  const pairQty = figure(item.measureQty, PAIR_CAP, item.measureUnit ?? '');
  if (pairQty !== null) {
    const routed = item.measureUnit ? routeAmount(pairQty, item.measureUnit) : null;
    if (routed && 'measureUnit' in routed) {
      measureUnit = routed.measureUnit;
      measureQty = routed.measureQty;
    } else {
      notes.push(`o‘lchov ${fmt(pairQty)} ${item.measureUnit ?? ''} — birligi noma’lum`.trim());
    }
  }

  const routed = normalizeRowUnit({ quantity, unit: unitWord, weightKg, volumeM3, measureUnit, measureQty });
  const row = routed.moved
    ? routed.patch
    : { quantity, unit: unitWord, weightKg, volumeM3, measureUnit, measureQty };
  if (routed.moved) notes.push(routed.note);

  let tnvedCode: string | null = null;
  const rawCode = item.tnvedCode?.trim() ?? '';
  if (rawCode) {
    const code = normalizeTnved(rawCode);
    if (code && 'code' in code) tnvedCode = code.code;
    else if (code) notes.push(`TNVED «${code.text}» — 9 xonali: boshida 0 tushib qolganmi?`);
    else notes.push(`TNVED «${rawCode.slice(0, 40)}» — kod emas (4-10 raqam bo‘lishi kerak)`);
  }

  return {
    name: item.name.trim().slice(0, 300) || '(nomsiz)',
    quantity: row.quantity,
    unit: row.unit,
    weightKg: row.weightKg,
    volumeM3: row.volumeM3,
    measureUnit: row.measureUnit,
    measureQty: row.measureQty,
    tnvedCode,
    note: [item.note?.trim() || null, ...notes].filter(Boolean).join(' · ').slice(0, 500) || null,
  };
}
