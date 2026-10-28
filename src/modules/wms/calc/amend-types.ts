/**
 * The add door's shapes (docs/SAKKIZ-R3.md K13, his 1.9 a): what a stored
 * request looks like to the bot, and what an add collection hands the one
 * writer. Type-only imports, so the bot's modules can name these without
 * pulling wms into platform at run time.
 */
import type { CalcGoodsFact, CalcSection } from './intake';
import type { NeedLaw } from './needs';
import type { MeasureUnit } from './pricing';

export interface AmendBaseItem {
  itemId: string;
  seq: number;
  name: string;
  quantity: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
  tnvedCode: string | null;
  /** The group's law (judge S9) when grouped, else the book's; null = no law known. */
  law: NeedLaw | null;
  /** In a group a person has ✅'d. */
  confirmed: boolean;
}

export interface AmendBase {
  requestId: string;
  cardLabel: string;
  entityType: 'deal' | 'lead';
  entityId: string;
  /** Does the card still take a job (null on a deal) — `leadTakesJobs`' rule,
   * read in `storedRequestFacts`; asked again under the lock at the save. */
  leadOpen: boolean | null;
  section: CalcSection;
  clientLabel: string | null;
  openedRev: number;
  /** Seq order. */
  items: AmendBaseItem[];
  weightKg: number | null;
  volumeM3: number | null;
  fromCity: string | null;
  toCity: string | null;
}

/** What an add collection hands the wms writer — built from the collection by
 * the bot's pure `amendSubmissionOf(state)`, so wms never names `IntakeState`. */
export interface AmendSubmission {
  /** Answered fields of STORED rows, by item id. */
  rowAnswers: {
    itemId: string;
    patch: Partial<Pick<CalcGoodsFact, 'quantity' | 'weightKg' | 'volumeM3' | 'measureUnit' | 'measureQty' | 'tnvedCode'>>;
  }[];
  /** Lines the add collection read or was told, in table order. Raw as read:
   * the writer hands every one through `doorRow`, like every other door. */
  newLines: CalcGoodsFact[];
  /** Only what a table answer set («jami …», a route) — never what a reading
   * found. An absent key is untouched; there is no `null` (an addition never
   * clears a total or a city). */
  totals: { weightKg?: number; volumeM3?: number } | null;
  route: { fromCity?: string; toCity?: string } | null;
  /** Stored rows the new material restated with another figure, still
   * unanswered or sent to the VED. An answered 'add' / 'rep' is a
   * `rowAnswers` entry instead. */
  conflicts: { itemId: string; seq: number; name: string; field: string; unit: string; stored: number | null; read: number }[];
  /** Totals answers that later material doubts: absent from `totals` and
   * named to the VED. */
  doubtedTotals: { field: 'weightKg' | 'volumeM3'; asked: number; read: number }[];
  /** Law 11: the verbatim words (material, then the answers) and the file count. */
  material: string[];
  fileCount: number;
}
