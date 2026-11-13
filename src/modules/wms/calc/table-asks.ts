import { applyPacking, fmtFigure, sizeText, type CartonDoubt, type PackedField } from './carton-math';
import { needShortUz, type NeedUnit } from './needs';
import type { AskedQuestion, CalcGoodsFact, TableAsk } from './intake';

/**
 * What the table ASKS beyond a row's missing figure, built from the state
 * alone (docs/AI-SORAYDI.md §3.0; review JB-6, JS-7). Pure, and drawn by
 * `intakeTableText` in ONE place — nothing here decides what «to‘liq» means
 * beyond each ask's own `holds`.
 *
 * Release 1a: every ask is answered by TYPING — the row's figure as a table
 * answer («1: 2.49 m³»), or words through «➕ Yana ma’lumot». Buttons, offers
 * and the row grammar are release 1b's, and they build on these same asks.
 */

/** A row the table draws: its number, and where its good stands in `goods`. */
export interface AskRow {
  no: number;
  index: number;
}

const unitOf = (field: PackedField, row: CalcGoodsFact): NeedUnit =>
  field === 'volumeM3'
    ? 'm3'
    : field === 'weightKg'
      ? 'kg'
      : field === 'quantity'
        ? 'dona'
        : ((row.packing?.perCartonUnit && row.packing.perCartonUnit !== 'dona' ? row.packing.perCartonUnit : row.measureUnit) as NeedUnit | null) ?? 'dona';

/** «2.49 m³» — as the table prints a figure, and as a typed answer is read back. */
const label = (value: number, unit: NeedUnit): string => `${fmtFigure(value)} ${needShortUz(unit)}`;

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** A figure the doubt leaves EMPTY: asked only while the row still has none of its own. */
const NOTHING_WRITTEN: ReadonlySet<CartonDoubt['kind']> = new Set(['cube_clash', 'size_unit', 'size_owner', 'not_whole', 'measure_clash']);

/** At most this many asks stand under one row — the rest are the next draw's (review JS-7). */
export const ROW_ASKS_MAX = 3;

/**
 * One doubt of the carton arithmetic as the seller reads it. Null = said
 * elsewhere (`weight_kind` is one grouped line, `packingLegend`), or the row
 * has answered it already.
 */
export function doubtAsk(no: number, row: CalcGoodsFact, d: CartonDoubt): TableAsk | null {
  if (d.kind === 'weight_kind') return null;
  if (NOTHING_WRITTEN.has(d.kind) && positive(row[d.field] ?? null)) return null;
  const unit = unitOf(d.field, row);
  const id = `pk:${no}:${d.field}:${d.kind}`;
  const size = row.packing?.size ? sizeText(row.packing.size) : null;
  const blank = `«${no}: … ${needShortUz(unit)}»`;
  switch (d.kind) {
    case 'differs': {
      if (d.stated === null || d.derived === null) return null;
      const ours = label(d.derived.value, unit);
      const his = label(d.stated, unit);
      return {
        id,
        row: no,
        holds: true,
        example: `${no}: ${ours}`,
        text: `${his} yozilgan, karobkalar bo‘yicha ${ours} chiqadi (${d.derived.how}) — qaysi biri to‘g‘ri? Yozing: «${no}: ${ours}» yoki «${no}: ${his}».`,
      };
    }
    case 'one_or_all': {
      if (d.stated === null || d.derived === null) return null;
      const all = label(d.derived.value, unit);
      const his = label(d.stated, unit);
      return {
        id,
        row: no,
        holds: true,
        example: `${no}: ${all}`,
        text: `${his} — bitta ${d.perPiece ? 'donaniki' : 'karobkaniki'}mi yoki hammasinikimi? Hammasiniki bo‘lsa «${no}: ${his}», bittasiniki bo‘lsa «${no}: ${all}» deb yozing.`,
      };
    }
    case 'cube_clash': {
      if (d.stated === null || d.derived === null) return null;
      return {
        id,
        row: no,
        holds: false,
        text: `bitta karobka hajmi ${label(d.stated, 'm3')} yozilgan, o‘lchamidan (${d.derived.how}) ${label(d.derived.value, 'm3')} chiqadi — hajm hisoblanmadi. Qator hajmini yozing: ${blank}.`,
      };
    }
    case 'size_unit':
      return {
        id,
        row: no,
        // An open question about a size holds the «to‘liq» words (review JN-3):
        // the row's cube is not known, whatever the shipment's total says.
        holds: true,
        example: `${no}: 2 ${needShortUz(unit)}`,
        text: `o‘lcham${size ? ` ${size}` : ''} — birligi yozilmagan (sm? mm?), hajm hisoblanmadi. Qator hajmini yozing: ${blank}.`,
      };
    case 'size_owner':
      return {
        id,
        row: no,
        holds: true,
        example: `${no}: 2 ${needShortUz(unit)}`,
        text: `o‘lcham${size ? ` ${size}` : ''} — karobkanikimi yoki tovarning o‘zinikimi, yozilmagan; hajm hisoblanmadi. Qator hajmini yozing: ${blank}.`,
      };
    case 'not_whole':
      if (d.derived === null) return null;
      return {
        id,
        row: no,
        holds: false,
        text: `${d.derived.how} = ${fmtFigure(d.derived.value)} — butun son chiqmadi, soni hisoblanmadi. Yozing: ${blank}.`,
      };
    case 'measure_clash':
      if (d.stated === null || d.derived === null) return null;
      return {
        id,
        row: no,
        holds: false,
        text: `qatorda ${label(d.stated, (row.measureUnit as NeedUnit | null) ?? 'dona')} yozilgan, karobkalar bo‘yicha esa ${label(d.derived.value, unit)} (${d.derived.how}) — to‘g‘risini yozing: ${blank}.`,
      };
  }
  return null;
}

/** Every row's doubts, in the table's order — at most `ROW_ASKS_MAX` under one row. */
export function packingAsks(rows: readonly AskRow[], goods: readonly CalcGoodsFact[]): TableAsk[] {
  const out: TableAsk[] = [];
  for (const r of rows) {
    const row = goods[r.index];
    if (!row?.packing) continue;
    const own = applyPacking(row)
      .doubts.map((d) => doubtAsk(r.no, row, d))
      .filter((a): a is TableAsk => a !== null);
    out.push(...own.slice(0, ROW_ASKS_MAX));
  }
  return out;
}

/**
 * The model's questions (docs/AI-SORAYDI.md §3.3 M4), each by the NAME of its
 * good — never a row number: the model's index is into ITS list (review
 * JR-2). Only «what are these goods?» holds the «to‘liq» line; the rest land
 * for the VED unanswered.
 */
export function aiQuestionAsks(questions: readonly AskedQuestion[]): TableAsk[] {
  return questions.map((q, i) => ({
    id: `ai:${i}`,
    row: null,
    holds: q.kind === 'what_goods',
    text: q.about ? `«${q.about}»: ${q.text}` : q.text,
  }));
}

/** What the rows' marks mean, and what the bot did to a figure — said once each, never hidden by a cut (review JS-7). */
export interface PackingLegend {
  /** Some figure is the bot's product: the «*» is explained. */
  computed: boolean;
  /** A stated figure REPLACED by the product — one line each, capped by the draw. */
  replaced: { no: number; field: PackedField; was: number; now: number; how: string; unit: NeedUnit; perPiece: boolean }[];
  /** Rows whose size carried no unit and was taken as centimetres. */
  assumedCm: number[];
  /** Rows whose computed weight rests on a per-carton weight nobody called netto or brutto. */
  weightKindUnsaid: number[];
  /** Rows named from a picture. */
  photo: number[];
}

export const COMPUTED_MARK = '*';
export const PHOTO_MARK = '📷';

const FIELDS: readonly PackedField[] = ['quantity', 'weightKg', 'measureQty', 'volumeM3'];

/** Which of a row's figures the bot computed — the fields that carry the «*». */
export function computedFields(row: CalcGoodsFact | undefined): ReadonlySet<PackedField> {
  const d = row?.derived;
  return new Set(d ? FIELDS.filter((f) => d[f] !== undefined) : []);
}

export function packingLegend(rows: readonly AskRow[], goods: readonly CalcGoodsFact[]): PackingLegend {
  const out: PackingLegend = { computed: false, replaced: [], assumedCm: [], weightKindUnsaid: [], photo: [] };
  for (const r of rows) {
    const row = goods[r.index];
    if (!row) continue;
    if (row.nameFrom === 'photo') out.photo.push(r.no);
    const d = row.derived;
    if (!d) continue;
    const made = computedFields(row);
    if (made.size > 0) out.computed = true;
    for (const field of made) {
      const was = d.replaced?.[field];
      const now = row[field];
      if (was !== undefined && positive(now)) {
        out.replaced.push({ no: r.no, field, was, now, how: d[field] as string, unit: unitOf(field, row), perPiece: field === 'weightKg' && d.weightFromPieces === true });
      }
    }
    if (d.assumedCm) out.assumedCm.push(r.no);
    if (row.packing && made.has('weightKg') && !d.weightFromPieces && applyPacking(row).doubts.some((x) => x.kind === 'weight_kind')) {
      out.weightKindUnsaid.push(r.no);
    }
  }
  return out;
}

const FIELD_WORD: Record<PackedField, string> = { volumeM3: 'hajm', weightKg: 'og‘irlik', quantity: 'soni', measureQty: 'miqdori' };

/** At most this many «replaced» lines are named; the rest are counted. */
export const REPLACED_LINES_MAX = 5;

/** The legend as lines — `ranges` is the table's own «1, 3, 5–7». */
export function legendLines(legend: PackingLegend, ranges: (nos: readonly number[]) => string): string[] {
  const lines: string[] = [];
  if (legend.computed) lines.push(`${COMPUTED_MARK} — bot hisoblagan (karobka soni × bittasiniki).`);
  for (const r of legend.replaced.slice(0, REPLACED_LINES_MAX)) {
    lines.push(
      `♻️ ${r.no}-qator: ${FIELD_WORD[r.field]} ${label(r.was, r.unit)} bitta ${r.perPiece ? 'donaniki' : 'karobkaniki'} ekan — ${r.how} = ${label(r.now, r.unit)} deb olindi. Noto‘g‘ri bo‘lsa yozing: «${r.no}: ${label(r.was, r.unit)}».`,
    );
  }
  if (legend.replaced.length > REPLACED_LINES_MAX) {
    lines.push(`♻️ … va yana ${legend.replaced.length - REPLACED_LINES_MAX} ta qatorda shunday: ${ranges(legend.replaced.slice(REPLACED_LINES_MAX).map((r) => r.no))}.`);
  }
  if (legend.assumedCm.length > 0) lines.push(`📐 ${ranges(legend.assumedCm)}-qator: o‘lcham birligi yozilmagan — sm deb olindi.`);
  if (legend.weightKindUnsaid.length > 0) {
    lines.push(`⚖️ ${ranges(legend.weightKindUnsaid)}-qator: karobka og‘irligi netto yoki brutto ekani yozilmagan — sof og‘irligi boshqa bo‘lsa yozing.`);
  }
  if (legend.photo.length > 0) lines.push(`${PHOTO_MARK} — nomi rasmdan olingan (AI taxmini): noto‘g‘ri bo‘lsa to‘g‘risini «➕ Yana ma’lumot» bilan yozing.`);
  return lines;
}
