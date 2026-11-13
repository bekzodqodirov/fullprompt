/**
 * The 2.8 b block (docs/SAKKIZ-R3.md §10.2.6, his 2.8 b and 1.14 a): the rows
 * a stored request still owes a figure the LAW pins, asked of the seller in
 * the AI answer and offered first to an unaddressed answer in the add door.
 *
 * Built on `lineNeeds` — the add table's own ⚠️ rule and the VED's chips —
 * so the ask, the table and the chip cannot name three different figures for
 * one row (#513). Its `pinned` set IS the law-pinned set: the duty floor's
 * unit, a specific excise's, and the baza unit a law (or the VED's chosen
 * basis) pins. His 1.14 a widened the question to every such unit — dona,
 * 1000 dona, juft, and kg, m², litr when the floor or the excise is in that
 * unit — so nothing here filters by unit. What is NOT asked: a row whose only
 * gap is «any measure» (#910's one-measure rule: the VED chooses the basis),
 * and a row in a group a person has ✅'d — the VED vouched for it.
 *
 * Pure. The two adapters feed it the SAME facts from the two reads that
 * exist: the pass's own final workspace (`lawAsksInputOf`, no second read,
 * performance-9) and the bot's stored-request read (`lawAsksInputOfStored`,
 * `storedRequestFacts`, ≤ 4 statements).
 */
import {
  aiAskedOf,
  FIELD_LABEL,
  lineNeedWhat,
  lineNeeds,
  typedFigure,
  type CalcFacts,
  type CalcGoodsFact,
  type CalcSection,
} from './intake';
import { linesVolumeM3 } from './line-totals';
import { needLawOf, needWhatUz, needWhyUz, type NeedLaw, type NeedUnit, type RowNeed } from './needs';
import { sectionParts } from './pricing';
import type { storedRequestFacts } from './service';
import type { Workspace } from './workspace';

export interface LawAsk {
  itemId: string;
  /** The row's own number — the add table's `TableRow.no` and the VED's screen. */
  seq: number;
  name: string;
  /** The figures the law pins and the row does not state, each unit once. */
  needs: RowNeed[];
}

/**
 * ONE thing the AI's answer asks the SELLER (docs/AI-SORAYDI.md §3.4 A2;
 * review JB-18) — the shape `sellerAsksOf` returns, committed with the kernel
 * so the pass's ❓ block, the one-step reply's fence (A4: an answer writes at
 * once only into an EMPTY cell of a row the answer ASKED about) and the
 * notification's payload are built against one thing:
 *  - `law`         — a figure the row's LAW pins (`lawAsksOf`, as today);
 *  - `measure`     — a row with neither a count nor a weight;
 *  - `what`        — an uncoded row: what is it, what is it made of;
 *  - `ai`          — a question the reading asked that nobody answered
 *                    (`aiAskedOf(row.note)`, intake.ts — a row's question only:
 *                    one about the shipment goes to the card note, never here);
 *  - `total`       — the shipment's brutto / cube, when freight needs it;
 *  - `certificate` — nobody touched the toggle. NEVER EMITTED (review JR-8,
 *                    JS-12): «untouched» has no home after the landing — the
 *                    request's column is one boolean, TRUE by default, so the
 *                    ask would stand in every answer and «sertifikat bor»
 *                    could not satisfy it — and the seller changing it after
 *                    the pass (A7) waits on the owner's answer to question 9.
 *                    The answer STATES it («📄 Sertifikat: bor (deb
 *                    hisoblandi)»); the table asks it once, before «✅»
 *                    (release 1b). Kept in the union for that release.
 * `itemId` / `seq` are null for what is about no row. `needs` — the units a
 * figure answer may fill; empty where the answer is words.
 */
export interface SellerAsk {
  itemId: string | null;
  seq: number | null;
  kind: 'law' | 'measure' | 'what' | 'ai' | 'total' | 'certificate';
  text: string;
  needs: NeedUnit[];
}

export interface LawAsksInput {
  section: CalcSection;
  facts: CalcFacts;
  bookLaws: ReadonlyMap<string, NeedLaw>;
  confirmedSeqs: ReadonlySet<number>;
}

/**
 * The rows a stored request owes a figure the LAW pins (not the one-measure
 * rule): the ⚠️ rows of the add table that are law-pinned, outside ✅'d
 * groups, in seq order. A grouped row answers to its GROUP's law (judge S9) —
 * the goods carry it (`law`), and `bookLaws` answers only a row that carries
 * none. A freight-only section owes nothing (`lineNeeds` asks the section).
 */
export function lawAsksOf(stored: LawAsksInput): LawAsk[] {
  const goods = stored.facts.goods ?? [];
  const asks: LawAsk[] = [];
  for (const line of lineNeeds(stored.section, stored.facts, stored.bookLaws)) {
    if (line.pinned.length === 0) continue;
    const row = goods[line.index];
    // A row with no stored identity is not on the request yet — the add
    // table's NEW lines are asked there, never in an answer about the job.
    if (!row || row.seq === undefined || !row.itemId) continue;
    if (stored.confirmedSeqs.has(row.seq)) continue;
    asks.push({ itemId: row.itemId, seq: row.seq, name: row.name, needs: line.pinned });
  }
  return asks.sort((a, b) => a.seq - b.seq);
}

/**
 * The pass's final workspace as `lawAsksOf`'s input — the `ws` `aiPrefill`
 * already loaded, never a second read (performance-9).
 *
 * Null when a PERSON has written since the machine (`handsoffRev !== rev`,
 * 0139): the VED is on the job, and asking the seller a figure over the
 * VED's own screen would be two people asking one customer (p5-p6-12).
 *
 * `bookLaws` is empty on purpose: after the pass's sweep every coded row sits
 * in a group, so an ungrouped row has no code and no law. A sweep that failed
 * leaves a coded row un-asked — under-asking, never a wrong ask. The two
 * regression-3 flags as `storedRequestFacts` sets them: a stored row's weight
 * is its own, a stored total is what prices it — nothing derived.
 */
export function lawAsksInputOf(ws: Workspace): LawAsksInput | null {
  if (ws.handsoffRev === null || ws.handsoffRev !== ws.rev) return null;
  if (!ws.section) return null;
  const goods: CalcGoodsFact[] = [];
  const confirmedSeqs = new Set<number>();
  for (const g of ws.groups) {
    const law = needLawOf(g);
    for (const i of g.items) {
      goods.push(goodsOf(i, law));
      if (g.confirmedAt !== null) confirmedSeqs.add(i.seq);
    }
  }
  for (const i of ws.ungrouped) goods.push(goodsOf(i, null));
  goods.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return {
    section: ws.section,
    // The goods are what `lineNeeds` reads; the totals ride along as the
    // stored read hands them (the workspace carries no destination city).
    facts: {
      fromCity: ws.fromCity,
      weightKg: ws.weightKg,
      volumeM3: ws.volumeM3,
      goods,
      lineWeightsStated: true,
      totalsStored: true,
    },
    bookLaws: new Map(),
    confirmedSeqs,
  };
}

/** One workspace row in the stored-request projection (`storedGoodsFact`'s shape). */
function goodsOf(i: Workspace['ungrouped'][number], law: NeedLaw | null): CalcGoodsFact {
  return {
    seq: i.seq,
    itemId: i.id,
    name: i.label,
    quantity: i.quantity,
    weightKg: i.weightKg,
    volumeM3: i.volumeM3,
    measureUnit: i.measureUnit,
    measureQty: i.measureQty,
    tnvedCode: i.tnvedCode,
    bazaBasis: i.bazaBasis,
    // Read by `sellerAsksOf` alone (the AI's unanswered question, `aiAskedOf`);
    // `lineNeeds` derives nothing from a note.
    note: i.note,
    law,
  };
}

type StoredFacts = NonNullable<Awaited<ReturnType<typeof storedRequestFacts>>>;

/**
 * `storedRequestFacts`' answer as `lawAsksOf`'s input — the add door's and
 * the add table's adapter. The rows already carry their law (group's, else
 * the book's), so `bookLaws` is empty; a row is ✅'d when its group is.
 */
export function lawAsksInputOfStored(stored: Pick<StoredFacts, 'base' | 'facts'>): LawAsksInput {
  // The stored row's NOTE rides on `base.items` (the checklist's projection,
  // `storedGoodsFact`, carries none) — put back on the goods by seq, so
  // `sellerAsksOf` reads the AI's unanswered question here as it does over
  // the pass's workspace. A row whose note the read did not carry keeps none.
  const notes = new Map(stored.base.items.map((i) => [i.seq, i.note ?? null]));
  const goods = stored.facts.goods?.map((g) =>
    g.seq !== undefined && notes.has(g.seq) && g.note === undefined ? { ...g, note: notes.get(g.seq) ?? null } : g,
  );
  return {
    section: stored.base.section,
    facts: goods ? { ...stored.facts, goods } : stored.facts,
    bookLaws: new Map(),
    confirmedSeqs: new Set(stored.base.items.filter((i) => i.confirmed).map((i) => i.seq)),
  };
}

/**
 * A product name as a phone reads it — one line, at most 60 characters, the
 * reply's own cap (ai-reply.ts imports it from here, so the ❓ block and the
 * group lines cut a name alike). A real invoice description is 300
 * characters with its own newlines.
 */
const NAME_CAP = 60;
export function askName(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length <= NAME_CAP ? flat : `${flat.slice(0, NAME_CAP - 1)}…`;
}

/** The uncoded row's question (A2): what it is, from what, for what — the coder reads the note. */
export const WHAT_ASK = 'bu nima — nimadan qilingan, nima uchun ishlatiladi?';

/** Why a shipment total is asked: the road is priced on it (podklyuch). */
const TOTAL_WHY = 'yo‘lkira shunga bog‘liq';

/**
 * EVERYTHING the AI door's answer asks the SELLER (docs/AI-SORAYDI.md §3.4
 * A2, his 4a of 2026-11-11: «so‘rasin va to‘ldirsin»; review JR-13 — the AI
 * door's ONE list, read by the answer's ❓ block, by the add door's asked rows
 * and, in release 2, by the one-step reply's fence). In row order, and within
 * a row: the law's unit, then «neither a count nor a weight», then «what is
 * it», then the reading's own question; the shipment's totals last.
 *
 *  - `law`: `lawAsksOf`, exactly as the NULL door asks it — one rule for the
 *    two doors' «what does the law pin» (#513).
 *  - `measure`: a row stating NO figure at all (`lineNeeds().anyMeasure`).
 *    Today the engine refuses such a row `baza_missing` first (no baza can be
 *    chosen for a row with no figure) and the tail blames the VED; the figure
 *    is the seller's, so it is asked here.
 *  - `what`: an uncoded row on a customs section — the pass's coder could not
 *    name it from the name alone, and «Zapchast XJ-200» tells nobody what it
 *    is made of or for. What only the VED can give — a baza, a rate — is not
 *    here (A10).
 *  - `ai`: the question the reading asked about THIS row and nobody answered
 *    before «✅» (`aiAskedOf` on the row's note — the kernel's pair). One
 *    about the shipment goes to the card note, never here (review JB-18).
 *  - `total`: the shipment's brutto or cube when the ROAD is priced on it
 *    (a podklyuch job) and missing — by the road's own rule
 *    (`freightAnswerFor`: the stored cube, else the lines' Σ; a figure that
 *    is not a number is the VED's to correct, never asked again).
 *
 * The certificate is NOT asked (review JR-8, JS-12 — see `SellerAsk`).
 * Pure: the pass's workspace and the stored-request read feed it the same
 * facts through the two adapters above. A ✅'d group's rows, and a row not yet
 * stored, are asked nothing — the rules `lawAsksOf` keeps.
 */
export function sellerAsksOf(input: LawAsksInput): SellerAsk[] {
  const goods = input.facts.goods ?? [];
  const parts = sectionParts(input.section);
  const rows = new Map<number, SellerAsk[]>();
  const add = (seq: number, ask: SellerAsk) => rows.set(seq, [...(rows.get(seq) ?? []), ask]);
  const askable = (row: CalcGoodsFact | undefined): row is CalcGoodsFact & { seq: number; itemId: string } =>
    !!row && row.seq !== undefined && !!row.itemId && !input.confirmedSeqs.has(row.seq);
  const label = (row: CalcGoodsFact & { seq: number }) => `${row.seq}-qator «${askName(row.name)}»`;

  for (const a of lawAsksOf(input)) {
    add(a.seq, {
      itemId: a.itemId,
      seq: a.seq,
      kind: 'law',
      text: `${a.seq}-qator «${askName(a.name)}»: ${a.needs.map((n) => `${needWhatUz(n.unit)} — ${needWhyUz(n)}`).join('; ')}`,
      needs: a.needs.map((n) => n.unit),
    });
  }
  for (const line of lineNeeds(input.section, input.facts, input.bookLaws)) {
    if (!line.anyMeasure) continue;
    const row = goods[line.index];
    if (!askable(row)) continue;
    add(row.seq, { itemId: row.itemId, seq: row.seq, kind: 'measure', text: `${label(row)}: ${lineNeedWhat(line)}`, needs: line.units });
  }
  for (const row of goods) {
    if (!askable(row)) continue;
    // Only where the row's customs is computed: a yo‘lkira job prices no code.
    if (parts.customs && !row.tnvedCode?.trim()) {
      add(row.seq, { itemId: row.itemId, seq: row.seq, kind: 'what', text: `${label(row)}: ${WHAT_ASK}`, needs: [] });
    }
    const asked = aiAskedOf(row.note ?? null);
    if (asked) add(row.seq, { itemId: row.itemId, seq: row.seq, kind: 'ai', text: `${label(row)}: ${asked}`, needs: [] });
  }

  const out = [...rows.keys()].sort((a, b) => a - b).flatMap((seq) => rows.get(seq)!);
  if (parts.freight) {
    // The road's own gaps (`freightAnswerFor`): a figure that is not a
    // number is the VED's, a stored cube or the lines' Σ prices the road.
    const weight = input.facts.weightKg ?? null;
    if (weight === null || (Number.isFinite(weight) && typedFigure(weight) === null)) {
      out.push({ itemId: null, seq: null, kind: 'total', text: `${FIELD_LABEL.weightKg} — ${TOTAL_WHY}`, needs: ['kg'] });
    }
    const cube = input.facts.volumeM3 ?? null;
    const m3 = cube ?? linesVolumeM3(goods.map((g) => ({ volumeM3: g.volumeM3 ?? null })));
    if (m3 === null || (Number.isFinite(m3) && typedFigure(m3) === null)) {
      out.push({ itemId: null, seq: null, kind: 'total', text: `${FIELD_LABEL.volumeM3} — ${TOTAL_WHY}`, needs: ['m3'] });
    }
  }
  return out;
}

/**
 * The rows the add table prefers for an UNADDRESSED figure («300 dona» typed
 * with no row number) — the AI door's answer's rows asked a FIGURE (review
 * JR-13: the reply asked rows 1-3, and a list built by the law alone routed
 * the figure to the law's row only). A row asked only in words («bu nima?»)
 * takes no figure, and counting it would let the table say «✅ So‘ralgan
 * sonlar yozildi» about a row that was never asked one. Each seq once, in
 * order.
 */
export function askedSeqsOf(asks: readonly SellerAsk[]): number[] {
  return [...new Set(asks.filter((a) => a.seq !== null && a.needs.length > 0).map((a) => a.seq!))].sort((a, b) => a - b);
}
