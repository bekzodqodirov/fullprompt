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
import { lineNeeds, type CalcFacts, type CalcGoodsFact, type CalcSection } from './intake';
import { needLawOf, type NeedLaw, type RowNeed } from './needs';
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
  return {
    section: stored.base.section,
    facts: stored.facts,
    bookLaws: new Map(),
    confirmedSeqs: new Set(stored.base.items.filter((i) => i.confirmed).map((i) => i.seq)),
  };
}
