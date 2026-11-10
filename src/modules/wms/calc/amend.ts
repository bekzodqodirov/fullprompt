import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db, type Tx } from '../../platform/db/client';
import { calcAmendments, calcRequests, notifications, users } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { THREAD_TEXT_MAX } from '../../platform/notifications/thread-ref';
import type { AmendBase, AmendBaseItem, AmendSubmission } from './amend-types';
import { doorRow } from './door-row';
import { codedNote } from './row-coding';
import { figureLabel, MATERIAL_NOTE_CAP, REQUIRED_FIELDS, SECTION_LABEL, weightFromTotalNote, type CalcGoodsFact, type CalcSection } from './intake';
import { linesVolumeM3, roundM3, volumeIsLinesSum } from './line-totals';
import { needShortUz, type NeedUnit } from './needs';
import { prefillStanding } from './prefill';
import { queueCalcPrefill, ticketStanding } from './prefill-queue';
import type { MeasureUnit } from './pricing';
import { CalcError, endingOf, storedRequestFacts, type CalcEnding } from './service';
import {
  saveTable,
  type SaveTableApplied,
  type SaveTableRefusal,
  type TableExpect,
  type TableItemEdit,
  type TableNewItem,
} from './workspace';

/**
 * The add door's writer (docs/SAKKIZ-R3.md §9, his 1.9 a): what a seller
 * sends AFTER his request landed — a count the law asked, a forgotten line, a
 * second factory's packing list.
 *
 * His rule is two sentences: while the VED has not started, the addition goes
 * INTO the job and the machine computes again; once the VED has started, it
 * goes to the VED as words. Everything here is how those two sentences stay
 * true under a queue that drains when it drains, a VED saving at the same
 * second, and a deploy in the middle:
 *
 *  - «started» is read off the revision clock at SAVE time, never trusted from
 *    the moment the door opened (`amendStanding` → `prefillStanding` with the
 *    hands-off stamp), and the write itself is a compare-and-set on that stamp
 *    — a person's save in between turns the write into the VED's branch;
 *  - a machine pass still running makes the addition WAIT (stored, written by
 *    the job the moment the pass ends), because the pass would otherwise read
 *    the seller's own addition as «a person started»;
 *  - every number reaches its column through `doorRow`, the one normalisation
 *    every other door applies — «Kafel 120 m2» is a pair, never 120 pieces;
 *  - the once-key is `calc_amendments.note_id`, inserted in the same
 *    transaction as the thread message and the card note, so a repeat finds
 *    it and redoes only what is missing.
 *
 * The add door never writes a price, a rate, a zone or a certificate (law 1).
 */

export type AmendStanding = 'open' | 'started' | 'busy' | 'closed' | 'not_found';

/**
 * Where the request stands for an addition. ONE home for «has a person moved
 * it»: `prefillStanding` asked with the hands-off stamp — the machine's own
 * question, so the add door and the pass can never disagree about it.
 */
export async function amendStanding(requestId: string): Promise<{
  standing: AmendStanding;
  rev: number | null;
  handsoffRev: number | null;
  completedVia: string | null;
  returnReason: string | null;
  /** `endingOf` over the row; null while open. The door and the closed words key on it. */
  ending: CalcEnding | null;
}> {
  const [row] = await db
    .select({
      rev: calcRequests.rev,
      handsoffRev: calcRequests.handsoffRev,
      completedAt: calcRequests.completedAt,
      completedVia: calcRequests.completedVia,
      returnReason: calcRequests.returnReason,
      answerAmount: calcRequests.answerAmount,
    })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId))
    .limit(1);
  if (!row) {
    return { standing: 'not_found', rev: null, handsoffRev: null, completedVia: null, returnReason: null, ending: null };
  }
  const facts = {
    rev: row.rev,
    handsoffRev: row.handsoffRev,
    completedVia: row.completedVia,
    returnReason: row.returnReason,
    ending: endingOf(row),
  };
  if (row.completedAt) return { standing: 'closed', ...facts };
  // A machine pass owed or running is decided by its JOB, never a time window:
  // under a deep queue a window cleared «busy» before the landing pass had
  // even started, the addition applied, and the pass then told the seller
  // «VED allaqachon ishlayapti» about his own addition.
  if ((await ticketStanding(requestId)) === 'live') return { standing: 'busy', ...facts };
  // No stamp: a request from before 0139, or a correction (the VED's job).
  if (row.handsoffRev === null) return { standing: 'started', ...facts };
  const stand = await prefillStanding(requestId, row.handsoffRev);
  const standing: AmendStanding =
    stand === 'ok' ? 'open' : stand === 'closed' ? 'closed' : stand === 'not_found' ? 'not_found' : 'started';
  return { standing, ...facts };
}

/** A figure a goods line can state, by the stored column it lands in. */
export type AmendField = 'quantity' | 'weightKg' | 'volumeM3' | 'measureQty';

/** The unit a field is printed in («dona», «kg», «m3», or the pair's own). */
function unitOfField(field: AmendField, measureUnit: MeasureUnit | null | undefined): string {
  if (field === 'quantity') return 'dona';
  if (field === 'weightKg') return 'kg';
  if (field === 'volumeM3') return 'm3';
  return measureUnit ?? 'dona';
}

const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Stored numbers compared at the column's own scale. */
const sameFigure = (a: number | null | undefined, b: number | null | undefined, places: number) =>
  (a ?? null) === null || (b ?? null) === null
    ? (a ?? null) === (b ?? null)
    : Number(a!.toFixed(places)) === Number(b!.toFixed(places));

/**
 * A stored row the new material restates (law-money-5, product-fit-17): per
 * field the READ line states, a conflict when the stored figure DIFFERS — or
 * is EMPTY (`stored: null`; the first revision called that «changes nothing»,
 * and a packing list stating 120 kg for a row with no weight vanished). The
 * same figures change nothing. Never written on its own: the seller is asked
 * «qo‘shilsin / o‘rniga / VED hal qilsin», and unanswered it is the VED's.
 *
 * The read line is put through `doorRow` FIRST (law-money-4), because its
 * figures are the seller's as read — `unit` is his own word, routed only at
 * the door — while the stored row's are columns: compared raw, «CTN 50»
 * asked «faylda 50 dona» of a 300-piece row and its «o‘rniga» wrote 50
 * pieces, and a re-read «120 m2» was a piece count on a pair row. «Differs»
 * is at the column's own scale (3 places, the pair's 4) — a tolerance hid
 * 49 kg on a 10-tonne row. A pair counts only in the row's own pair unit: a
 * read «40 juft» is no statement about a row counted in m². Pure.
 */
export function conflictOf(
  kept: Pick<CalcGoodsFact, 'quantity' | 'weightKg' | 'volumeM3' | 'measureUnit' | 'measureQty'>,
  read: Pick<CalcGoodsFact, 'quantity' | 'weightKg' | 'volumeM3' | 'measureUnit' | 'measureQty'> & {
    name?: string;
    unit?: string | null;
  },
): { field: AmendField; unit: string; stored: number | null; read: number }[] {
  const out: { field: AmendField; unit: string; stored: number | null; read: number }[] = [];
  const routed = doorRow({
    name: read.name ?? '',
    quantity: read.quantity ?? null,
    unit: read.unit ?? null,
    weightKg: read.weightKg ?? null,
    volumeM3: read.volumeM3 ?? null,
    measureUnit: read.measureUnit ?? null,
    measureQty: read.measureQty ?? null,
  });
  for (const field of ['quantity', 'weightKg', 'volumeM3'] as const) {
    const said = routed[field];
    if (!positive(said)) continue;
    const stored = positive(kept[field]) ? kept[field]! : null;
    if (stored !== null && sameFigure(stored, said, 3)) continue;
    out.push({ field, unit: unitOfField(field, null), stored, read: said });
  }
  const pair = routed.measureQty;
  if (positive(pair) && routed.measureUnit && (!kept.measureUnit || kept.measureUnit === routed.measureUnit)) {
    const stored = positive(kept.measureQty) ? kept.measureQty! : null;
    if (stored === null || !sameFigure(stored, pair, 4)) {
      out.push({ field: 'measureQty', unit: routed.measureUnit, stored, read: pair });
    }
  }
  return out;
}

/**
 * One home for «which totals does this addition leave stale» (law-money-1) —
 * the add table, `amendDiff` and the re-run reply read it.
 *
 * The m³ follows by ARITHMETIC when the stored figure IS the lines' Σ (R2's
 * 2.7 b): it stays the Σ after the addition — a whole Σ is re-summed, a Σ
 * that is no longer whole (a new line with no m³) is stale. A TYPED m³ is
 * never re-derived: lines added under it make it stale. Brutto has no Σ rule
 * (R2 MR-8 — the lines are netto), so an added line always leaves it stale. A
 * total the seller answered in the table is his and never stale; a total
 * nobody stated is missing, which the table already asks. Pure.
 */
export function amendTotalsStale(input: {
  section: CalcSection;
  stored: {
    weightKg: number | null;
    volumeM3: number | null;
    items: readonly { volumeM3: number | null; weightKg?: number | null; note?: string | null }[];
  };
  linesAfter: readonly { volumeM3: number | null; weightKg?: number | null }[];
  added: number;
  answered: { weightKg: boolean; volumeM3: boolean };
}): { stale: ('weightKg' | 'volumeM3')[]; resummedM3: number | null } {
  const needs = REQUIRED_FIELDS[input.section];
  const stale: ('weightKg' | 'volumeM3')[] = [];
  let resummedM3: number | null = null;
  const storedLines = input.stored.items;
  const volumeMoved =
    input.added > 0 ||
    storedLines.some((l, i) => {
      const after = input.linesAfter[i]?.volumeM3 ?? null;
      const before = l.volumeM3 ?? null;
      return (after === null ? null : roundM3(after)) !== (before === null ? null : roundM3(before));
    });
  if (needs.includes('volumeM3') && !input.answered.volumeM3 && volumeMoved) {
    const typed = input.stored.volumeM3 !== null && !volumeIsLinesSum(input.stored.volumeM3, storedLines);
    if (typed) stale.push('volumeM3');
    else {
      const sum = linesVolumeM3(input.linesAfter);
      if (sum === null) {
        // A stored Σ that the addition left un-whole is no longer the shipment's.
        if (input.stored.volumeM3 !== null) stale.push('volumeM3');
      } else if (input.stored.volumeM3 === null || roundM3(input.stored.volumeM3) !== sum) {
        resummedM3 = sum;
      }
    }
  }
  // A row whose weight the landing COPIED from the shipment total (review
  // lmp-2): its correction is the shipment's too — the brutto it was copied
  // from no longer agrees with it, and the road must not be priced on the old.
  const copiedMoved = storedLines.some((l, i) => {
    if (weightFromTotalNote(l.note ?? null) === null) return false;
    const after = input.linesAfter[i]?.weightKg;
    return after !== undefined && after !== null && !sameFigure(after, l.weightKg ?? null, 3);
  });
  if (
    needs.includes('weightKg') &&
    !input.answered.weightKg &&
    (input.added > 0 || copiedMoved) &&
    input.stored.weightKg !== null
  ) {
    stale.push('weightKg');
  }
  return { stale, resummedM3 };
}

/**
 * The stored note with the landing's lone-weight sentence taken out — what an
 * edit of that row's weight posts (review lmp-2): left, the note goes on
 * saying the row's weight was copied from the brutto after the seller typed
 * its own, and every reader of `weightFromTotalNote` says «bruttodan» about
 * it. Null = nothing else was in the note. Pure.
 */
export function noteWithoutLoneWeight(note: string | null): string | null {
  const rest = (note ?? '')
    .split(/\s*·\s*/u)
    .filter((part) => part.trim() !== '' && weightFromTotalNote(part) === null)
    .join(' · ')
    .trim();
  return rest === '' ? null : rest;
}

/** What `amendDiff` says the addition is, over a FRESH base — and, once the
 * save ran, what it really wrote (`applied`). Stored on the amendment row. */
export interface AmendChange {
  edits: {
    itemId: string;
    seq: number;
    name: string;
    set: Partial<{
      quantity: number | null;
      weightKg: number | null;
      volumeM3: number | null;
      measureUnit: MeasureUnit | null;
      measureQty: number | null;
      tnvedCode: string;
    }>;
    expect: TableExpect;
    /** A conflict the seller answered «qo‘shilsin»: the figure is stored + read. */
    sum?: { field: AmendField; unit: string; stored: number; read: number };
    /** The note with the lone-weight copy's sentence out (`noteWithoutLoneWeight`, lmp-2) — present only then. */
    note?: string | null;
  }[];
  /** A different code for a coded row — for the VED only (⭐ of Question 3). */
  codesKept: { seq: number; name: string; typed: string; stored: string }[];
  /** A seller's code that is no code, on a stored row: not written, named. */
  notWritten: { seq: number; name: string; text: string }[];
  /** For the VED only (law-money-5). */
  conflicts: AmendSubmission['conflicts'];
  /** For the VED only (CONC-2: a totals answer later material doubts). */
  doubtedTotals: AmendSubmission['doubtedTotals'];
  /** Through `doorRow`, each with its deterministic client id. */
  adds: TableNewItem[];
  /** Present keys only; no null (law-money-6). */
  cargo: { weightKg?: number; volumeM3?: number; fromCity?: string; toCity?: string } | null;
  /** The m³ the lines re-summed (R2's 2.7 b kept after the addition), when it moved. */
  resummedM3: number | null;
  /** Totals the new lines left behind, not re-answered (law-money-1). */
  totalsStale: ('weightKg' | 'volumeM3')[];
  /** The card's label and the job's section, as the diff read them — the words' own. */
  card: string;
  section: CalcSection;
  /** Set by the `to_ved` write: what the redo's words key on. `refused`: a
   * stored «waiting» addition `saveTable` refused when its turn came —
   * nobody is at the press any more to read a refusal, so it is the VED's,
   * with the refusal's name (`code`). */
  told?: {
    reason: 'started' | 'closed' | 'lead_closed' | 'refused';
    ending: CalcEnding | null;
    returnReason: string | null;
    code?: SaveTableRefusal;
  };
  /** Set by the open branch's save: what it really wrote of the measures, and
   * the seq each new line got — the redo's words and the thread read it. */
  applied?: AppliedWrite;
  /** The re-pass reached the queue (set after the commit, read by the redo). */
  repassQueued?: boolean;
  /**
   * The addition's own reading did not read this (`AmendSubmission.unread`,
   * docs/FAYL-OQISH.md §1.6): written, and NO re-pass — neither at the save
   * nor by a redo of the same note. The seller's words say it.
   */
  unread?: string;
}

/** `saveTable`'s own account of the measures, and the seq each added line got. */
export type AppliedWrite = SaveTableApplied & { addSeqs: Record<string, number> };

/** The namespace a new line's client id is minted in — the same note and index is the same row. */
const AMEND_LINE_NS = '5d3e8a52-4f0b-4c7e-9a61-2f8d0c4b7e13';

/** A conflict the seller answered «qo‘shilsin», carried on its row answer (P4's own field). */
export type AmendRowAnswer = AmendSubmission['rowAnswers'][number] & {
  sum?: { field: AmendField; unit: string; stored: number; read: number };
};

/**
 * One row answer through the door's normalisation (`doorRow`'s routing, the
 * rule every door applies). Only the fields the answer named are written; an
 * answer that is no number (or past the column) is dropped by `doorRow`
 * itself; a code is shape-checked there too. Pure.
 */
function doorPatch(
  item: AmendBaseItem,
  patch: AmendSubmission['rowAnswers'][number]['patch'],
): { set: AmendChange['edits'][number]['set']; code: { kept: string } | { refused: string } | null } {
  const routed = doorRow({
    name: item.name,
    quantity: patch.quantity ?? null,
    weightKg: patch.weightKg ?? null,
    volumeM3: patch.volumeM3 ?? null,
    measureUnit: patch.measureUnit ?? null,
    measureQty: patch.measureQty ?? null,
    tnvedCode: patch.tnvedCode ?? null,
  });
  const set: AmendChange['edits'][number]['set'] = {};
  if (routed.quantity !== null && !sameFigure(routed.quantity, item.quantity, 3)) set.quantity = routed.quantity;
  if (routed.weightKg !== null && !sameFigure(routed.weightKg, item.weightKg, 3)) set.weightKg = routed.weightKg;
  if (routed.volumeM3 !== null && !sameFigure(routed.volumeM3, item.volumeM3, 3)) set.volumeM3 = routed.volumeM3;
  if (
    routed.measureQty !== null &&
    (routed.measureUnit !== item.measureUnit || !sameFigure(routed.measureQty, item.measureQty, 4))
  ) {
    set.measureUnit = routed.measureUnit;
    set.measureQty = routed.measureQty;
  }
  let code: { kept: string } | { refused: string } | null = null;
  const typed = patch.tnvedCode?.trim() ?? '';
  if (typed) {
    if (routed.tnvedCode === null) code = { refused: typed };
    else if (item.tnvedCode === null) set.tnvedCode = routed.tnvedCode;
    else if (routed.tnvedCode !== item.tnvedCode) code = { kept: routed.tnvedCode };
  }
  return { set, code };
}

/** A name compared as two lists compare it: case, spacing and punctuation aside. */
const nameKey = (name: string) => name.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

/**
 * The seller's answers over a FRESH base (`storedRequestFacts` at save time):
 * `set` = every answered field that differs from the stored value NOW,
 * `expect` = those stored values (the row's compare-and-set); a new line goes
 * through `doorRow` with a client id minted from the note and its index, so a
 * retried save is the same row. A new line repeating a stored row by name is
 * no new line: with the same figures it is nothing, with others it is the
 * row's conflict (the reading's `sameGoodsLine` removed the wide matches
 * already; this is the last fence before a line is priced twice). Pure.
 */
export function amendDiff(fresh: AmendBase, sub: AmendSubmission, noteId: string): AmendChange {
  const byId = new Map(fresh.items.map((i) => [i.itemId, i]));
  const edits: AmendChange['edits'] = [];
  const codesKept: AmendChange['codesKept'] = [];
  const notWritten: AmendChange['notWritten'] = [];
  for (const answer of sub.rowAnswers as AmendRowAnswer[]) {
    const item = byId.get(answer.itemId);
    // A row the VED deleted since: there is nothing to write it into; the
    // seller's words reach the VED in the thread with the material.
    if (!item) continue;
    const { set, code } = doorPatch(item, answer.patch);
    if (code && 'kept' in code) codesKept.push({ seq: item.seq, name: item.name, typed: code.kept, stored: item.tnvedCode! });
    if (code && 'refused' in code) notWritten.push({ seq: item.seq, name: item.name, text: code.refused });
    if (Object.keys(set).length === 0) continue;
    const expect: TableExpect = {};
    for (const key of Object.keys(set) as (keyof typeof set)[]) {
      if (key === 'tnvedCode') expect.tnvedCode = item.tnvedCode;
      else expect[key] = item[key] as never;
    }
    const sum = answer.sum && set[answer.sum.field] !== undefined ? answer.sum : undefined;
    // «stored + read» was made of the figure the READING saw: a row moved
    // since then fails this compare-and-set and becomes the VED's — 500
    // written over a newer figure would be a sum nobody made.
    if (sum) expect[sum.field] = sum.stored;
    // The seller typed the weight of a row whose weight the landing copied
    // from the brutto (lmp-2): the copy's sentence leaves the note with it,
    // under the note's own compare-and-set.
    const copied = set.weightKg !== undefined && weightFromTotalNote(item.note ?? null) !== null;
    if (copied) expect.note = item.note ?? null;
    edits.push({
      itemId: item.itemId,
      seq: item.seq,
      name: item.name,
      set,
      expect,
      ...(sum ? { sum } : {}),
      ...(copied ? { note: noteWithoutLoneWeight(item.note ?? null) } : {}),
    });
  }

  const conflicts: AmendChange['conflicts'] = [...sub.conflicts];
  const adds: TableNewItem[] = [];
  sub.newLines.forEach((line, index) => {
    const twin = fresh.items.find((i) => nameKey(i.name) === nameKey(line.name));
    if (twin) {
      for (const c of conflictOf(twin, line)) {
        if (!conflicts.some((k) => k.itemId === twin.itemId && k.field === c.field)) {
          conflicts.push({ itemId: twin.itemId, seq: twin.seq, name: twin.name, field: c.field, unit: c.unit, stored: c.stored, read: c.read });
        }
      }
      return;
    }
    const row = doorRow({
      name: line.name,
      quantity: line.quantity ?? null,
      unit: line.unit ?? null,
      weightKg: line.weightKg ?? null,
      volumeM3: line.volumeM3 ?? null,
      measureUnit: line.measureUnit ?? null,
      measureQty: line.measureQty ?? null,
      tnvedCode: line.tnvedCode ?? null,
      note: line.note ?? null,
    });
    adds.push({
      clientId: uuidv5(`${noteId}:${index}`, AMEND_LINE_NS),
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
      weightKg: row.weightKg,
      volumeM3: row.volumeM3,
      measureUnit: row.measureUnit,
      measureQty: row.measureQty,
      tnvedCode: row.tnvedCode,
      // A code the reading's model proposed lands marked, as the INSERT's
      // rows do (`AI_CODE_NOTE`, docs/IKKI-ESHIK.md §3.1) — only while the
      // door kept it.
      note: codedNote(row.note, row.tnvedCode ? line.tnvedSource : null),
    });
  });

  const answered = { weightKg: sub.totals?.weightKg !== undefined, volumeM3: sub.totals?.volumeM3 !== undefined };
  const linesAfter = [
    ...fresh.items.map((i) => {
      const e = edits.find((x) => x.itemId === i.itemId);
      return {
        volumeM3: e?.set.volumeM3 !== undefined ? e.set.volumeM3 : i.volumeM3,
        weightKg: e?.set.weightKg !== undefined ? e.set.weightKg : i.weightKg,
      };
    }),
    ...adds.map((a) => ({ volumeM3: a.volumeM3 ?? null, weightKg: a.weightKg ?? null })),
  ];
  const { stale, resummedM3 } = amendTotalsStale({
    section: fresh.section,
    stored: { weightKg: fresh.weightKg, volumeM3: fresh.volumeM3, items: fresh.items },
    linesAfter,
    added: adds.length,
    answered,
  });

  const cargo: NonNullable<AmendChange['cargo']> = {};
  if (sub.totals?.weightKg !== undefined && !sameFigure(sub.totals.weightKg, fresh.weightKg, 3)) cargo.weightKg = sub.totals.weightKg;
  if (sub.totals?.volumeM3 !== undefined && !sameFigure(sub.totals.volumeM3, fresh.volumeM3, 3)) cargo.volumeM3 = sub.totals.volumeM3;
  else if (resummedM3 !== null) cargo.volumeM3 = resummedM3;
  const city = (v: string | undefined, stored: string | null) =>
    v !== undefined && v.trim() !== '' && v.trim().toLowerCase() !== (stored ?? '').trim().toLowerCase() ? v.trim() : undefined;
  const from = city(sub.route?.fromCity, fresh.fromCity);
  const to = city(sub.route?.toCity, fresh.toCity);
  if (from !== undefined) cargo.fromCity = from;
  if (to !== undefined) cargo.toCity = to;

  return {
    edits,
    codesKept,
    notWritten,
    conflicts,
    doubtedTotals: [...sub.doubtedTotals],
    adds,
    cargo: Object.keys(cargo).length > 0 ? cargo : null,
    resummedM3: cargo.volumeM3 !== undefined && sub.totals?.volumeM3 === undefined ? resummedM3 : null,
    totalsStale: stale,
    card: fresh.cardLabel,
    section: fresh.section,
    ...(sub.unread ? { unread: sub.unread } : {}),
  };
}

/**
 * The save's edits: the answered fields and the row's compare-and-set, and
 * NOTHING else. A `note` only where the edit set the weight of a row the
 * landing copied it into from the brutto (lmp-2): there the stored note, its
 * «og‘irlik umumiy (brutto)dan olindi» taken out, under the note's own
 * compare-and-set — any other edit's note would REPLACE the stored one and
 * erase that sentence, which `weightFromTotalNote` reads (re-check p4-17).
 * Never a baza, a basis, an import row or a reason (law 1: the add door posts
 * no price). Pure.
 */
export function tableEditsOf(change: Pick<AmendChange, 'edits'>): TableItemEdit[] {
  return change.edits.map((e) => ({
    id: e.itemId,
    seq: e.seq,
    ...e.set,
    ...(e.note !== undefined ? { note: e.note } : {}),
    expect: e.expect,
  }));
}

/** Does the change write anything into the rows (edits, adds or totals)? */
export function changeWrites(change: AmendChange): boolean {
  return change.edits.length > 0 || change.adds.length > 0 || change.cargo !== null;
}

/** Does the addition carry anything at all — a write, a word for the VED, the seller's material, a file? */
function changeSays(change: AmendChange, sub: AmendSubmission): boolean {
  return (
    changeWrites(change) ||
    change.conflicts.length > 0 ||
    change.doubtedTotals.length > 0 ||
    change.codesKept.length > 0 ||
    change.notWritten.length > 0 ||
    sub.material.some((m) => m.trim() !== '') ||
    sub.fileCount > 0
  );
}

const clip = (name: string, max = 40) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);

/** «40 juft», «12 m³» — the field's own unit word. */
function figureText(value: number, unit: string): string {
  const known = ['dona', 'kg', 'm3', 'm2', 'juft', 'litr', 'sm3', '1000_dona'];
  return known.includes(unit) ? figureLabel(value, unit as NeedUnit) : `${Number(value.toFixed(4))} ${unit}`;
}

const unitWord = (unit: string) =>
  ['dona', 'kg', 'm3', 'm2', 'juft', 'litr', 'sm3', '1000_dona'].includes(unit) ? needShortUz(unit as NeedUnit) : unit;

/** The most lines the seller's words carry; the rest is counted. */
export const AMEND_LINES_MAX = 20;

/**
 * §2.4's change lines — ONE home for the seller's reply, the thread message
 * and the VED branch. On the `applied` branch they are built from what the
 * SAVE wrote, not from what was posted: a measure the law dropped or a unit
 * the row cannot hold is said «yozilmadi», never «yozildi» (regression-16).
 * `maxLines` = at most this many, then «· … yana {n} ta o‘zgarish». Pure.
 */
export function amendChangeText(
  change: AmendChange,
  fileCount: number,
  applied?: AppliedWrite | SaveTableApplied,
  opts: { maxLines?: number } = {},
): string[] {
  const written = applied ?? change.applied;
  const dropped = new Set(written?.measuresDropped ?? []);
  const cleared = new Set([...(written?.measuresCleared ?? []), ...(written?.basisConflict ?? [])]);
  const lines: string[] = [];
  const notWrittenPair = (seq: number | null, unit: string, qty: number) => {
    if (seq === null) return null;
    if (dropped.has(seq)) return `${figureText(qty, unit)} — yozilmadi (kod ${unitWord(unit)} so‘ramaydi)`;
    if (cleared.has(seq)) return `${figureText(qty, unit)} — yozilmadi (qatorning birligi boshqa)`;
    return null;
  };

  for (const e of change.edits) {
    const head = `· ${e.seq}-qator «${clip(e.name)}»: `;
    const parts: string[] = [];
    const pair =
      e.set.measureQty !== undefined && e.set.measureQty !== null && e.set.measureUnit
        ? { unit: e.set.measureUnit as string, qty: e.set.measureQty }
        : null;
    const pairRefused = pair ? notWrittenPair(e.seq, pair.unit, pair.qty) : null;
    // A summed pair the save dropped is said once, «yozilmadi» — never also «qo‘shildi».
    if (e.sum && !(e.sum.field === 'measureQty' && pairRefused)) {
      const total = e.sum.stored + e.sum.read;
      parts.push(`${Number(e.sum.stored.toFixed(4))} + ${Number(e.sum.read.toFixed(4))} = ${figureText(total, e.sum.unit)} (ikkinchi fayl qo‘shildi)`);
    }
    const summed = e.sum?.field;
    if (e.set.quantity != null && summed !== 'quantity') parts.push(figureText(e.set.quantity, 'dona'));
    if (e.set.weightKg != null && summed !== 'weightKg') parts.push(figureText(e.set.weightKg, 'kg'));
    if (e.set.volumeM3 != null && summed !== 'volumeM3') parts.push(figureText(e.set.volumeM3, 'm3'));
    if (pair && !pairRefused && summed !== 'measureQty') parts.push(figureText(pair.qty, pair.unit));
    if (e.set.tnvedCode) parts.push(`kod ${e.set.tnvedCode}`);
    if (parts.length) lines.push(head + parts.join(' · '));
    if (pairRefused) lines.push(head + pairRefused);
  }
  for (const n of change.notWritten) {
    lines.push(`· ${n.seq}-qator «${clip(n.name)}»: «${clip(n.text, 30)}» — kod emas, yozilmadi`);
  }
  const addSeqs: Record<string, number> = written && 'addSeqs' in written ? (written as AppliedWrite).addSeqs : {};
  for (const a of change.adds) {
    const parts: string[] = [];
    if (a.quantity != null) parts.push(figureText(a.quantity, 'dona'));
    if (a.weightKg != null) parts.push(figureText(a.weightKg, 'kg'));
    if (a.volumeM3 != null) parts.push(figureText(a.volumeM3, 'm3'));
    const seq = a.clientId ? (addSeqs[a.clientId] ?? null) : null;
    const pairRefused =
      a.measureQty != null && a.measureUnit ? notWrittenPair(seq, a.measureUnit, a.measureQty) : null;
    if (a.measureQty != null && a.measureUnit && !pairRefused) parts.push(figureText(a.measureQty, a.measureUnit));
    if (a.tnvedCode) parts.push(a.tnvedCode);
    lines.push(`· yangi qator: «${clip(a.name)}»${parts.length ? ` — ${parts.join(' · ')}` : ''}`);
    if (pairRefused) lines.push(`· yangi qator «${clip(a.name)}»: ${pairRefused}`);
  }
  if (change.cargo?.weightKg !== undefined) lines.push(`· umumiy brutto: ${figureText(change.cargo.weightKg, 'kg')}`);
  if (change.cargo?.volumeM3 !== undefined) {
    lines.push(
      change.resummedM3 !== null
        ? `· umumiy hajm: ${figureText(change.cargo.volumeM3, 'm3')} (qatorlardan qayta hisoblandi)`
        : `· umumiy hajm: ${figureText(change.cargo.volumeM3, 'm3')}`,
    );
  }
  if (change.cargo?.fromCity !== undefined || change.cargo?.toCity !== undefined) {
    lines.push(`· yo‘nalish: ${change.cargo.fromCity ?? '…'} → ${change.cargo.toCity ?? '…'}`);
  }
  for (const d of change.doubtedTotals) {
    const label = d.field === 'weightKg' ? 'umumiy brutto' : 'umumiy hajm';
    const unit = d.field === 'weightKg' ? 'kg' : 'm3';
    lines.push(`· ${label}: ${figureText(d.asked, unit)} so‘ralgan, faylda ${figureText(d.read, unit)} — VED hal qiladi`);
  }
  for (const k of change.codesKept) {
    lines.push(`· ${k.seq}-qator «${clip(k.name)}»: sotuvchi kodi ${k.typed} (so‘rovda ${k.stored} — VED hal qiladi)`);
  }
  for (const c of change.conflicts) {
    const stored = c.stored === null ? 'so‘rovda yo‘q' : `so‘rovda ${Number(c.stored.toFixed(4))}`;
    // No «sotuvchi tanlamadi»: since his 1a the seller is never asked (docs/
    // IKKI-ESHIK.md §1.1), so the line is a statement, not a skipped question
    // (as-built review CHAT-5).
    lines.push(`· ${c.seq}-qator «${clip(c.name)}»: faylda ${figureText(c.read, c.unit)} (${stored}) — VED hal qiladi`);
  }
  // «yangi tovar qo‘shildi» only when a line was (fix review W-2): a stored
  // row's weight copied from the brutto and corrected (lmp-2), or a stored
  // row's m³ under a typed total, leaves the total behind with nothing added.
  const why = change.adds.length > 0 ? ' — yangi tovar qo‘shildi' : '';
  for (const field of change.totalsStale) {
    lines.push(field === 'weightKg' ? `· ⚠️ umumiy brutto yangilanmagan${why}` : `· ⚠️ umumiy hajm yangilanmagan${why}`);
  }
  if (fileCount > 0) lines.push(`· 📎 ${fileCount} ta fayl kartadagi lentada`);

  const max = opts.maxLines ?? AMEND_LINES_MAX;
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `· … yana ${lines.length - max} ta o‘zgarish`];
}

/**
 * A thread message: its head sentence and the change lines, fitted to the
 * thread's own cap (`THREAD_TEXT_MAX`) — lines dropped from the END into
 * «· … yana {n} ta o‘zgarish», never a refused message. Pure.
 */
export function amendThreadBody(head: string, lines: readonly string[], max = THREAD_TEXT_MAX): string {
  const all = [head, ...lines];
  if (all.join('\n').length <= max) return all.join('\n');
  for (let keep = lines.length - 1; keep >= 0; keep -= 1) {
    const body = [head, ...lines.slice(0, keep), `· … yana ${lines.length - keep} ta o‘zgarish`].join('\n');
    if (body.length <= max) return body;
  }
  return head.slice(0, max);
}

/** The thread's head sentences, by what became of the addition (§2.4). */
export const AMEND_THREAD_HEAD = {
  applied: '➕ Sotuvchi qo‘shimcha yubordi — so‘rovga yozildi, AI qayta hisoblaydi:',
  started: '➕ Sotuvchi qo‘shimcha yubordi — so‘rovga avtomatik yozilmadi (siz ishlayapsiz), o‘zgartirishni kiriting:',
  closed: '➕ Sotuvchi qo‘shimcha yubordi — so‘rov yopilgan, avtomatik yozilmadi:',
  waiting:
    '➕ Sotuvchi qo‘shimcha yubordi — AI hisobi tugagach so‘rovga avtomatik yoziladi (agar siz boshlamagan bo‘lsangiz):',
  waitedApplied: '➕ Kutib turgan qo‘shimcha so‘rovga yozildi, AI qayta hisoblaydi.',
  refused: '➕ Kutib turgan qo‘shimchani so‘rovga avtomatik yozib bo‘lmadi — o‘zgartirishni kiriting:',
  noted: '➕ Sotuvchi fayl yoki matn yubordi — so‘rov qatorlari o‘zgarmadi, kartadagi lentada:',
} as const;

/**
 * The card's lenta note — only when the add collection carried material or
 * files (the files are pre-bound to it). Law 11: the seller's words verbatim,
 * cut where every collection's note is cut. Pure.
 */
export function amendNoteText(input: {
  section: CalcSection;
  card: string;
  collectedBy: string;
  fileCount: number;
  material: readonly string[];
  /** The receipt-time notes (`AmendSubmission.fileNotes`), under the file count. */
  fileNotes?: readonly string[];
}): string {
  const raw = input.material.map((m) => m.trim()).filter(Boolean).join('\n');
  const material = raw.length > MATERIAL_NOTE_CAP ? `${raw.slice(0, MATERIAL_NOTE_CAP)}\n… (qisqartirildi)` : raw;
  const notes = (input.fileNotes ?? []).map((n) => n.trim()).filter(Boolean);
  return (
    `➕ Qo‘shimcha — ${SECTION_LABEL[input.section]} · ${input.card}\n` +
    `Yig‘di: ${input.collectedBy} (Telegram bot)\n` +
    (input.fileCount ? `Fayllar: ${input.fileCount}\n` : '') +
    (notes.length > 0 ? `${notes.join('\n')}\n` : '') +
    (material ? `\nSotuvchi yuborgani (asl matn):\n${material}\n` : '')
  ).trimEnd();
}

/**
 * The receipt-time notes as thread lines (fix review FR-SELL-6): a top-up's
 * noted packing list — «packing list jami: brutto 177 kg … VED fayldan
 * ko‘radi» — reached only the seller's prompt, and the VED read neither the
 * card nor the thread saying it. Pure.
 */
function fileNoteLines(submission: AmendSubmission): string[] {
  return (submission.fileNotes ?? []).map((n) => n.trim()).filter(Boolean).map((n) => `· ${n}`);
}

export type CalcAmendmentRow = typeof calcAmendments.$inferSelect;

export type AmendOutcome =
  | { kind: 'applied'; amendmentId: string; rev: number; queued: boolean; lines: string[]; change: AmendChange }
  | {
      kind: 'to_ved';
      amendmentId: string;
      reason: 'started' | 'closed' | 'lead_closed' | 'refused';
      ending: CalcEnding | null;
      returnReason: string | null;
      code?: SaveTableRefusal;
      lines: string[];
      change: AmendChange;
    }
  | { kind: 'waiting'; amendmentId: string; lines: string[]; change: AmendChange; stillWaiting: boolean }
  | { kind: 'noted'; amendmentId: string; lines: string[]; change: AmendChange }
  | { kind: 'empty' }
  | { kind: 'duplicate'; row: CalcAmendmentRow }
  | { kind: 'not_yours' }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: SaveTableRefusal };

/** A repeat of one note inside the save's own transaction: nothing may follow it. */
class AmendDuplicate extends Error {
  constructor() {
    super('amendment already recorded');
    this.name = 'AmendDuplicate';
  }
}

/**
 * Every `saveTable` refusal by name — `AmendOutcome.refused`'s domain. A
 * `Record` over the union, so a refusal `saveTable` learns tomorrow is a
 * compile error here, never a rethrow retried three times into «Qo‘shib
 * bo‘lmadi».
 */
const SAVE_TABLE_REFUSAL_NAMES: Record<SaveTableRefusal, true> = {
  ai_running: true,
  already_closed: true,
  amended_since: true,
  bad_basis: true,
  bad_code: true,
  bad_number: true,
  basis_shown_changed: true,
  baza_positive: true,
  changed_under: true,
  conflict: true,
  import_row_missing: true,
  measure_positive: true,
  name_required: true,
  not_found: true,
  too_many_items: true,
};
const SAVE_TABLE_REFUSALS = Object.keys(SAVE_TABLE_REFUSAL_NAMES) as SaveTableRefusal[];

/**
 * The request's card, read through the transaction from the LOCKED row — never
 * the card the add collection remembered: Uch band's win split moves a won
 * lead's requests onto its deal. FOR UPDATE first: one lock order with
 * `mutateRequest` (the request row before anything else), so a waiting run
 * and an open run of one note cannot deadlock on the row and the note key.
 */
async function cardUnderLockTx(tx: Tx, requestId: string): Promise<{ entityType: 'deal' | 'lead'; entityId: string }> {
  const rows = await tx.execute<{ entity_type: string; entity_id: string }>(sql`
    SELECT entity_type, entity_id::text AS entity_id FROM calc_requests WHERE id = ${requestId}::uuid FOR UPDATE
  `);
  const row = rows[0];
  if (!row) throw new CalcError('not_found');
  return { entityType: row.entity_type === 'lead' ? 'lead' : 'deal', entityId: row.entity_id };
}

/** Uch band's rule (a closed lead takes no job at any door), asked again under the lock. */
async function leadStillOpenTx(tx: Tx, card: { entityType: 'deal' | 'lead'; entityId: string }): Promise<void> {
  if (card.entityType !== 'lead') return;
  const rows = await tx.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM leads l JOIN lead_stages s ON s.id = l.stage_id
     WHERE l.id = ${card.entityId}::uuid AND s.kind = 'open' FOR SHARE OF l
  `);
  if (rows.length === 0) throw new CalcError('lead_closed');
}

/**
 * The amendment row — the once-key. A fresh save INSERTs (no row back = this
 * note was recorded already); a stored «waiting» one moves on from 'waiting'
 * and only from there. Through `tx` alone (#714).
 */
async function recordAmendmentInTx(
  tx: Tx,
  row: {
    id: string;
    requestId: string;
    noteId: string;
    staffId: string;
    chatId: bigint;
    outcome: 'waiting' | 'applied' | 'to_ved' | 'noted';
    rev: number | null;
    submission: AmendSubmission;
    change: AmendChange;
    waitingId?: string;
  },
): Promise<string | null> {
  if (row.waitingId) {
    const moved = await tx
      .update(calcAmendments)
      // A new outcome writes a new thread message (`threadIdOf`), so its ping
      // is owed afresh: the waiting message's `announced_at` is not this one's.
      .set({ outcome: row.outcome, rev: row.rev, change: row.change, outcomeSentAt: null, announcedAt: null })
      .where(and(eq(calcAmendments.id, row.waitingId), eq(calcAmendments.outcome, 'waiting')))
      .returning({ id: calcAmendments.id });
    return moved[0]?.id ?? null;
  }
  const inserted = await tx
    .insert(calcAmendments)
    .values({
      id: row.id,
      requestId: row.requestId,
      noteId: row.noteId,
      staffId: row.staffId,
      chatId: row.chatId,
      outcome: row.outcome,
      rev: row.rev,
      submission: row.submission,
      change: row.change,
    })
    .onConflictDoNothing({ target: calcAmendments.noteId })
    .returning({ id: calcAmendments.id });
  return inserted[0]?.id ?? null;
}

/** The seq each added line got — read through the save's own transaction by the
 * id the line was minted with (a screen-minted client id IS the row's id). */
async function addSeqsTx(tx: Tx, requestId: string, adds: readonly TableNewItem[]): Promise<Record<string, number>> {
  const ids = adds.map((a) => a.clientId).filter((v): v is string => !!v);
  if (ids.length === 0) return {};
  const rows = await tx.execute<{ client_id: string; seq: number }>(sql`
    SELECT id::text AS client_id, seq FROM calc_request_items
     WHERE request_id = ${requestId}::uuid AND id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `);
  return Object.fromEntries(rows.map((r) => [r.client_id, Number(r.seq)]));
}

/** What the commit hands the ping: the thread message `insertThreadMessageInTx` wrote. */
interface Written {
  amendmentId: string;
  activityId: string;
  entityType: 'deal' | 'lead' | 'client' | 'receipt' | 'batch';
  entityId: string;
  createdAt: string | null;
  body: string;
}

/**
 * The card note and the thread message, in the amendment's own transaction,
 * right AFTER its row was recorded (so the note's primary key can never
 * collide: a repeat found the row and wrote nothing). Through `tx` alone.
 */
async function noteAndThreadTx(
  tx: Tx,
  input: {
    requestId: string;
    noteId: string;
    staffId: string;
    staffName: string;
    card: { entityType: 'deal' | 'lead'; entityId: string };
    change: AmendChange;
    submission: AmendSubmission;
    writeNote: boolean;
    body: string;
    /** The thread message's own id — `threadIdOf`, so a redo finds it. */
    threadId: string;
  },
): Promise<Omit<Written, 'amendmentId'>> {
  const { insertActivityTx } = await import('../crm/service');
  const { insertThreadMessageInTx } = await import('../crm/thread');
  if (input.writeNote && (input.submission.material.some((m) => m.trim()) || input.submission.fileCount > 0)) {
    await insertActivityTx(
      tx,
      {
        id: input.noteId,
        entityType: input.card.entityType,
        entityId: input.card.entityId,
        kind: 'note',
        note: amendNoteText({
          section: input.change.section,
          card: input.change.card,
          collectedBy: input.staffName,
          fileCount: input.submission.fileCount,
          material: input.submission.material,
          ...(input.submission.fileNotes ? { fileNotes: input.submission.fileNotes } : {}),
        }),
      },
      { actorId: input.staffId, ip: null, userAgent: 'telegram-bot' },
    );
  }
  const thread = await insertThreadMessageInTx(tx, {
    id: input.threadId,
    ref: { kind: 'calc', id: input.requestId },
    body: input.body,
    actorId: input.staffId,
  });
  return {
    activityId: thread.activityId,
    entityType: thread.entityType,
    entityId: thread.entityId,
    createdAt: thread.createdAt,
    body: input.body,
  };
}

/**
 * The id of the thread message an amendment's outcome wrote: one per outcome
 * (a «waiting» row writes one, and its later write another), derived — so a
 * redo rebuilds the ping from the very message, never from a search.
 */
export function threadIdOf(amendmentId: string, outcome: CalcAmendmentRow['outcome']): string {
  return uuidv5(`${amendmentId}:${outcome}`, AMEND_LINE_NS);
}

/** The ping that announces the thread message, and the author's read mark — after the commit. */
async function announceWritten(written: Written, requestId: string, staffId: string): Promise<void> {
  try {
    const { announceNote } = await import('../crm/internal-chat');
    const { markThreadRead } = await import('../crm/thread');
    await announceNote({
      entityType: written.entityType,
      entityId: written.entityId,
      note: written.body,
      authorId: staffId,
      activityId: written.activityId,
      calcRequestId: requestId,
    });
    if (written.createdAt) await markThreadRead(staffId, { kind: 'calc', id: requestId }, written.createdAt);
    await db
      .update(calcAmendments)
      .set({ announcedAt: new Date() })
      .where(eq(calcAmendments.id, written.amendmentId));
  } catch (err) {
    // The message itself is in the thread already; a lost ping is redone by
    // the next run of this note (`announced_at IS NULL`).
    logger.warn({ err, amendmentId: written.amendmentId }, '[calc-amend] thread ping failed');
  }
}

/** The thread head for a write that does not go into the rows. */
function headFor(reason: 'started' | 'closed' | 'lead_closed' | 'refused' | 'noted' | 'waiting'): string {
  if (reason === 'started') return AMEND_THREAD_HEAD.started;
  if (reason === 'refused') return AMEND_THREAD_HEAD.refused;
  if (reason === 'noted') return AMEND_THREAD_HEAD.noted;
  if (reason === 'waiting') return AMEND_THREAD_HEAD.waiting;
  return AMEND_THREAD_HEAD.closed;
}

/**
 * The ONE writer of a seller's addition (§9.5). Reads on the pool first
 * (#714), then exactly one of four short transactions — waiting, noted, the
 * VED's branch, or `saveTable` with its in-transaction hook — each recording
 * the amendment row, the card note and the thread message together.
 */
export async function amendRequest(input: {
  requestId: string;
  staffId: string;
  staffName: string;
  noteId: string;
  chatId: bigint;
  submission: AmendSubmission | null;
  /** Writing a stored «waiting» addition: its row id (the row must still be 'waiting'). */
  waitingId?: string;
}): Promise<AmendOutcome> {
  const stored = await storedRequestFacts(input.requestId);
  if (!stored) return { kind: 'not_found' };
  if (stored.requestedBy !== input.staffId) return { kind: 'not_yours' };

  const [existing] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, input.noteId)).limit(1);
  let submission = input.submission;
  if (existing) {
    if (!input.waitingId || existing.id !== input.waitingId || existing.outcome !== 'waiting') {
      return { kind: 'duplicate', row: existing };
    }
    submission = existing.submission as AmendSubmission;
  } else if (input.waitingId) {
    return { kind: 'not_found' };
  }
  if (!submission) return { kind: 'empty' };

  const change = amendDiff(stored.base, submission, input.noteId);
  const waited = input.waitingId !== undefined;
  if (!waited && !changeSays(change, submission)) return { kind: 'empty' };
  // A fresh row's id is random: the once-key is the NOTE (its unique index),
  // and a deterministic primary key would collide before the note's arbiter.
  const amendmentId = input.waitingId ?? randomUUID();
  const fileCount = submission.fileCount;
  const sub = submission;

  /** One short transaction for every branch that writes nothing into the rows. */
  const recordOnly = async (
    outcome: 'waiting' | 'to_ved' | 'noted',
    why: 'started' | 'closed' | 'lead_closed' | 'refused' | 'noted' | 'waiting',
    told: AmendChange['told'],
  ): Promise<{ written: Written } | 'duplicate' | 'lead_closed' | 'not_found'> => {
    const stamped: AmendChange = told ? { ...change, told } : change;
    const lines = [...amendChangeText(stamped, fileCount, undefined, { maxLines: Number.POSITIVE_INFINITY }), ...fileNoteLines(sub)];
    const body = amendThreadBody(headFor(why), lines);
    try {
      return await db.transaction(async (tx) => {
        const card = await cardUnderLockTx(tx, input.requestId);
        if (why !== 'lead_closed') await leadStillOpenTx(tx, card);
        const id = await recordAmendmentInTx(tx, {
          id: amendmentId,
          requestId: input.requestId,
          noteId: input.noteId,
          staffId: input.staffId,
          chatId: input.chatId,
          outcome,
          rev: null,
          submission: sub,
          change: stamped,
          ...(waited ? { waitingId: input.waitingId } : {}),
        });
        if (!id) throw new AmendDuplicate();
        const thread = await noteAndThreadTx(tx, {
          requestId: input.requestId,
          noteId: input.noteId,
          staffId: input.staffId,
          staffName: input.staffName,
          card,
          change: stamped,
          submission: sub,
          writeNote: !waited,
          body,
          threadId: threadIdOf(id, outcome),
        });
        return { written: { amendmentId: id, ...thread } };
      });
    } catch (err) {
      if (err instanceof AmendDuplicate) return 'duplicate';
      if (err instanceof CalcError && err.code === 'lead_closed') return 'lead_closed';
      // Deleted between the read and the lock: the press's own words, never
      // three retries into «qayta bosing» (§2.4: `not_found` is an outcome).
      if (err instanceof CalcError && err.code === 'not_found') return 'not_found';
      throw err;
    }
  };

  const duplicate = async (): Promise<AmendOutcome> => {
    const [row] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, input.noteId)).limit(1);
    if (!row) throw new Error('amendment vanished after its duplicate');
    return { kind: 'duplicate', row };
  };

  const toVed = async (
    reason: 'started' | 'closed' | 'lead_closed' | 'refused',
    standing: { ending: CalcEnding | null; returnReason: string | null },
    code?: SaveTableRefusal,
  ): Promise<AmendOutcome> => {
    const told = { reason, ending: standing.ending, returnReason: standing.returnReason, ...(code ? { code } : {}) };
    const out = await recordOnly('to_ved', reason, told);
    if (out === 'duplicate') return duplicate();
    if (out === 'not_found') return { kind: 'not_found' };
    if (out === 'lead_closed') return toVed('lead_closed', standing);
    await announceWritten(out.written, input.requestId, input.staffId);
    const stamped = { ...change, told };
    return { kind: 'to_ved', amendmentId: out.written.amendmentId, ...told, lines: amendChangeText(stamped, fileCount), change: stamped };
  };

  const waitFor = async (): Promise<AmendOutcome> => {
    // A stored «waiting» row stays as it is; the next settle hands it back.
    if (waited) return { kind: 'waiting', amendmentId, lines: amendChangeText(change, fileCount), change, stillWaiting: true };
    const out = await recordOnly('waiting', 'waiting', undefined);
    if (out === 'duplicate') return duplicate();
    if (out === 'not_found') return { kind: 'not_found' };
    if (out === 'lead_closed') return toVed('lead_closed', await amendStanding(input.requestId));
    await announceWritten(out.written, input.requestId, input.staffId);
    return { kind: 'waiting', amendmentId: out.written.amendmentId, lines: amendChangeText(change, fileCount), change, stillWaiting: false };
  };

  const standing = await amendStanding(input.requestId);
  if (standing.standing === 'not_found') return { kind: 'not_found' };
  if (standing.standing === 'busy') return waitFor();
  if (standing.standing === 'closed') return toVed('closed', standing);

  if (!changeWrites(change)) {
    const out = await recordOnly('noted', 'noted', undefined);
    if (out === 'duplicate') return duplicate();
    if (out === 'not_found') return { kind: 'not_found' };
    if (out === 'lead_closed') return toVed('lead_closed', standing);
    await announceWritten(out.written, input.requestId, input.staffId);
    return { kind: 'noted', amendmentId: out.written.amendmentId, lines: amendChangeText(change, fileCount), change };
  }
  if (standing.standing === 'started' || standing.handsoffRev === null) return toVed('started', standing);

  // The open branch: into the rows, under the stamp's compare-and-set.
  let written: Written | null = null;
  let applied: AppliedWrite | null = null;
  let rev = 0;
  const edits = tableEditsOf(change);
  try {
    await saveTable(
      input.requestId,
      { items: edits, adds: change.adds, ...(change.cargo ? { cargo: change.cargo } : {}) },
      { actorId: input.staffId, ip: null, userAgent: 'telegram-bot' },
      {
        expectRev: standing.handsoffRev,
        handsOff: true,
        inTx: async (tx, newRev, saved) => {
          const card = await cardUnderLockTx(tx, input.requestId);
          await leadStillOpenTx(tx, card);
          const addSeqs = await addSeqsTx(tx, input.requestId, change.adds);
          const done: AppliedWrite = { ...saved, addSeqs };
          const stamped: AmendChange = { ...change, applied: done };
          const id = await recordAmendmentInTx(tx, {
            id: amendmentId,
            requestId: input.requestId,
            noteId: input.noteId,
            staffId: input.staffId,
            chatId: input.chatId,
            outcome: 'applied',
            rev: newRev,
            submission: sub,
            change: stamped,
            ...(waited ? { waitingId: input.waitingId } : {}),
          });
          if (!id) throw new AmendDuplicate();
          const lines = [...amendChangeText(stamped, fileCount, done, { maxLines: Number.POSITIVE_INFINITY }), ...fileNoteLines(sub)];
          const thread = await noteAndThreadTx(tx, {
            requestId: input.requestId,
            noteId: input.noteId,
            staffId: input.staffId,
            staffName: input.staffName,
            card,
            change: stamped,
            submission: sub,
            writeNote: !waited,
            body: amendThreadBody(waited ? AMEND_THREAD_HEAD.waitedApplied : AMEND_THREAD_HEAD.applied, lines),
            threadId: threadIdOf(id, 'applied'),
          });
          written = { amendmentId: id, ...thread };
          applied = done;
          rev = newRev;
        },
      },
    );
  } catch (err) {
    if (err instanceof AmendDuplicate) return duplicate();
    if (err instanceof CalcError) {
      if (err.code === 'conflict' || err.code === 'changed_under') return toVed('started', standing);
      if (err.code === 'already_closed') return toVed('closed', await amendStanding(input.requestId));
      if (err.code === 'lead_closed') return toVed('lead_closed', standing);
      if (err.code === 'ai_running') {
        // Law-money-7: never «birozdan keyin qayta bosing». A machine pass's
        // claim is the waiting branch; a person's ✨ is a person starting work.
        const again = await amendStanding(input.requestId);
        return again.standing === 'busy' ? waitFor() : toVed('started', again);
      }
      if (err.code === 'not_found') return { kind: 'not_found' };
      if ((SAVE_TABLE_REFUSALS as readonly string[]).includes(err.code)) {
        // A stored «waiting» addition has nobody at the press to read a
        // refusal, and the next settle would requeue it for ever: it is the
        // VED's, named, and the seller is told so (by the row's chat).
        if (waited) return toVed('refused', standing, err.code as SaveTableRefusal);
        return { kind: 'refused', code: err.code as SaveTableRefusal };
      }
    }
    throw err;
  }
  // Assigned inside the hook, which control flow does not follow.
  const done = written as Written | null;
  const appliedNow = applied as AppliedWrite | null;
  if (!done) throw new Error('saveTable returned without its in-transaction hook');
  const stamped: AmendChange = { ...change, applied: appliedNow ?? undefined };
  // An addition its own reading did not read in full re-runs nothing (§1.6):
  // the rows it did read are written for the VED, and no AI figure follows.
  const queued = change.unread
    ? false
    : await queueCalcPrefill({
        requestId: input.requestId,
        staffId: input.staffId,
        section: stored.base.section,
        pass: `amend:${done.amendmentId}`,
        atRev: rev,
      });
  if (queued) await markRepassQueued(done.amendmentId);
  await announceWritten(done, input.requestId, input.staffId);
  return {
    kind: 'applied',
    amendmentId: done.amendmentId,
    rev,
    queued,
    lines: amendChangeText(stamped, fileCount, appliedNow ?? undefined),
    change: { ...stamped, repassQueued: queued },
  };
}

/** The re-pass reached the queue — so a redo of this note never queues it twice. */
async function markRepassQueued(amendmentId: string): Promise<void> {
  await db
    .update(calcAmendments)
    .set({ change: sql`${calcAmendments.change} || '{"repassQueued": true}'::jsonb` })
    .where(eq(calcAmendments.id, amendmentId))
    .catch((err: unknown) => logger.warn({ err, amendmentId }, '[calc-amend] re-pass mark not written'));
}

/** The seller was told the CURRENT outcome. */
export async function stampTold(amendmentId: string): Promise<void> {
  await db.update(calcAmendments).set({ outcomeSentAt: new Date() }).where(eq(calcAmendments.id, amendmentId));
}

/**
 * A repeat of one note (durability-5): the row is the record of which of its
 * effects are done, and only the missing ones run again — the re-pass, the
 * ping. The seller's words are the caller's (they go by chat id), so the row
 * comes back as it stands NOW: words rebuilt from the row read before the
 * redo would say «navbatga tushmadi» about a re-pass this very call queued.
 */
export async function redoAmendment(row: CalcAmendmentRow, staffId: string): Promise<CalcAmendmentRow> {
  const change = row.change as AmendChange;
  if (row.outcome === 'applied' && row.rev !== null && !change.repassQueued && !change.unread) {
    const ticket = await ticketStanding(row.requestId);
    // Bounded like sayOnce's claim (review lmp-3): the re-pass answer is
    // addressed to the seller who queued it and is never older than its
    // amendment (sayOnce's day of slack kept) — unbounded, the probe read
    // every CalcPrefilled row there is.
    const spoke = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'CalcPrefilled'),
          eq(notifications.userId, staffId),
          sql`${notifications.createdAt} >= ${new Date(row.createdAt).toISOString()}::timestamptz - interval '1 day'`,
          sql`${notifications.payload} ->> 'pass' = ${`amend:${row.id}`}`,
        ),
      )
      .limit(1);
    if (ticket === 'none' && spoke.length === 0) {
      const queued = await queueCalcPrefill({
        requestId: row.requestId,
        staffId,
        section: change.section,
        pass: `amend:${row.id}`,
        atRev: row.rev,
      });
      if (queued) await markRepassQueued(row.id);
    }
  }
  if (row.announcedAt === null) {
    // Rebuilt from the thread message the row's own transaction wrote.
    const rows = await db.execute<{ id: string; entity_type: string; entity_id: string; note: string; created_at: string }>(sql`
      SELECT id::text AS id, entity_type, entity_id::text AS entity_id, note,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM crm_activities WHERE id = ${threadIdOf(row.id, row.outcome)}::uuid
    `);
    const note = rows[0];
    if (note) {
      await announceWritten(
        {
          amendmentId: row.id,
          activityId: note.id,
          entityType: note.entity_type as Written['entityType'],
          entityId: note.entity_id,
          createdAt: note.created_at,
          body: note.note,
        },
        row.requestId,
        staffId,
      );
    }
  }
  return (await amendmentById(row.id)) ?? row;
}

/** How long a stored «waiting» addition is handed back before it is only logged. */
export const WAITING_REQUEUE_HOURS = 24;

/** The rows past `WAITING_REQUEUE_HOURS` this process has named in the log already. */
const namedStale = new Set<string>();

/**
 * Every stored «waiting» addition (of one request, or all) whose machine pass
 * is gone — and every addition decided but never told (dur-4) — handed back
 * to the save job. No `singletonKey`: the once-fence of
 * an addition is its note id, and a duplicate job answers `duplicate`. The
 * settle (P5) calls it per request; the sweep (P1) for all — the net under a
 * lost enqueue. Answers how many it handed back.
 *
 * Bounded by age (`WAITING_REQUEUE_HOURS`): a refusal now ends a waited run
 * as the VED's, but a run that THROWS every time would otherwise be handed
 * back on every sweep tick for ever — past a day such a row is named in the
 * log instead, where a person can see it.
 */
export async function requeueWaitingAmendments(requestId?: string): Promise<number> {
  const all = await db
    .select({
      id: calcAmendments.id,
      requestId: calcAmendments.requestId,
      noteId: calcAmendments.noteId,
      staffId: calcAmendments.staffId,
      chatId: calcAmendments.chatId,
      outcome: calcAmendments.outcome,
      fresh: sql<boolean>`${calcAmendments.createdAt} > now() - make_interval(hours => ${WAITING_REQUEUE_HOURS}::int)`,
    })
    .from(calcAmendments)
    .where(
      and(
        // A waited addition the job DECIDED but whose words never reached the
        // seller (review dur-4): its collection is long gone, so neither the
        // sweep's dead-save settle nor the hydrate's untold net reads it, and
        // «AI tugatgach so‘rovga avtomatik yoziladi» was never followed by a
        // word. Handed back, the job answers `duplicate`, says the words once
        // and stamps them. Five minutes old at least: a fresh save's own job
        // is still telling it. And only while no collection holds its note
        // (fix review fdur-5, fdur-6): a FRESH save whose words failed keeps
        // its collection frozen, and the sweep's dead-save settle tells it —
        // the fresh words with their lines, then the collection ended. Handed
        // back too, it was told twice (no claim between the two tellers), or
        // told as a WAITED run, «Kutib turgan …» with no lines, and the
        // collection left frozen. Qualified by the TABLE (#128): a bare column
        // here binds to the subquery's own note_id.
        or(
          eq(calcAmendments.outcome, 'waiting'),
          and(
            isNull(calcAmendments.outcomeSentAt),
            sql`${calcAmendments.createdAt} < now() - interval '5 minutes'`,
            sql`NOT EXISTS (SELECT 1 FROM telegram_calc_intakes t WHERE t.note_id = ${calcAmendments}.note_id)`,
          ),
        ),
        isNotNull(calcAmendments.staffId),
        requestId ? eq(calcAmendments.requestId, requestId) : undefined,
      ),
    );
  // Named ONCE per process (fix review FR-7): past the day nothing hands such
  // a row back, and every 5-minute tick wrote the same warning for ever. Split
  // by what is owed: a waiting addition was never written, a decided one was
  // written and only its words were never delivered.
  const stale = all.filter((r) => !r.fresh && !namedStale.has(r.id));
  for (const r of stale) namedStale.add(r.id);
  const waiting = stale.filter((r) => r.outcome === 'waiting');
  const untold = stale.filter((r) => r.outcome !== 'waiting');
  if (waiting.length > 0) {
    logger.warn(
      { amendmentIds: waiting.map((r) => r.id) },
      '[calc-amend] waiting additions older than a day — not requeued; the VED must enter them',
    );
  }
  if (untold.length > 0) {
    logger.warn(
      { amendmentIds: untold.map((r) => r.id) },
      '[calc-amend] additions decided over a day ago whose words never reached the seller — not requeued; written, only the reply is owed',
    );
  }
  const rows = all.filter((r) => r.fresh);
  if (rows.length === 0) return 0;
  const { enqueue } = await import('../../platform/jobs/boss');
  const free = new Map<string, boolean>();
  let handed = 0;
  for (const row of rows) {
    if (!free.has(row.requestId)) free.set(row.requestId, (await ticketStanding(row.requestId)) === 'none');
    if (!free.get(row.requestId)) continue;
    try {
      const id = randomUUID();
      await enqueue(
        'calc.amend-save',
        {
          chatId: row.chatId.toString(),
          staffId: row.staffId!,
          requestId: row.requestId,
          noteId: row.noteId,
          submission: null,
          amendmentId: row.id,
          savingToken: null,
        },
        { id, expireInSeconds: 120, retryLimit: 3 },
      );
      handed += 1;
    } catch (err) {
      logger.warn({ err, amendmentId: row.id }, '[calc-amend] waiting addition not requeued');
    }
  }
  return handed;
}

/** Who the seller is, by name — the card note's «Yig‘di:». */
export async function staffNameOf(staffId: string): Promise<string> {
  const [row] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, staffId)).limit(1);
  return row?.name ?? 'Xodim';
}

/** The amendment a note recorded, if any — what a release asks before it says «Qo‘shib bo‘lmadi». */
export async function amendmentByNote(noteId: string): Promise<CalcAmendmentRow | null> {
  const [row] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, noteId)).limit(1);
  return row ?? null;
}

/**
 * The certificate answer a returned request carried — a NEW collection seeded
 * from it keeps it (⭐ of Question 6), never the collector's optimistic default
 * that would leave the additional duty out of the re-send. Null = not found.
 */
export async function requestHasCertificate(requestId: string): Promise<boolean | null> {
  const [row] = await db
    .select({ has: calcRequests.hasCertificate })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId))
    .limit(1);
  return row ? row.has : null;
}

/** Rows by id — the redo's read of one amendment. */
export async function amendmentById(id: string): Promise<CalcAmendmentRow | null> {
  const [row] = await db.select().from(calcAmendments).where(inArray(calcAmendments.id, [id])).limit(1);
  return row ?? null;
}

/**
 * The customer of a returned request, as a NEW collection names it (⭐ of
 * Question 6): the deal's client code; for a lead, the colleague's client it
 * is about (0136's side row, read only when the table is there), else the
 * lead's phone — never the lead's name alone, which the landing cannot find
 * a customer by. Empty = the collection asks the customer question.
 */
export async function returnedClientHint(base: AmendBase): Promise<string> {
  if (base.entityType === 'deal') {
    const rows = await db.execute<{ code: string | null }>(sql`
      SELECT c.client_code AS code FROM deals d LEFT JOIN clients c ON c.id = d.client_id WHERE d.id = ${base.entityId}::uuid
    `);
    return rows[0]?.code?.trim() ?? '';
  }
  const { aboutClientsOf } = await import('../crm/lead-about');
  const about = (await aboutClientsOf([base.entityId])).get(base.entityId);
  if (about) return about.clientCode;
  const rows = await db.execute<{ phone: string | null }>(sql`SELECT phone FROM leads WHERE id = ${base.entityId}::uuid`);
  return rows[0]?.phone?.trim() ?? '';
}

/**
 * The staff member's OPEN requests an offer may name (product-fit-16): his own
 * (`requested_by`), not closed, asked in the last `days` — `calc_requests`
 * has no `created_at`; its clock is `requested_at` — at most the two newest,
 * with the card's label. One statement; no index on `requested_by` (a few
 * thousand rows, stated), and the caller caches it per chat for a minute.
 */
export async function openRequestsToOffer(staffId: string, days: number): Promise<{ id: string; card: string }[]> {
  const rows = await db.execute<{ id: string; card: string | null }>(sql`
    SELECT r.id::text AS id, COALESCE(d.code, l.name) AS card
      FROM calc_requests r
      LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
      LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
     WHERE r.requested_by = ${staffId}::uuid
       AND r.completed_at IS NULL
       AND r.requested_at > now() - make_interval(days => ${days}::int)
     ORDER BY r.requested_at DESC
     LIMIT 2
  `);
  return rows.map((r) => ({ id: r.id, card: r.card?.trim() || '—' }));
}
