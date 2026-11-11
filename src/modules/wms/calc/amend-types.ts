/**
 * The add door's shapes (docs/SAKKIZ-R3.md K13, his 1.9 a): what a stored
 * request looks like to the bot, and what an add collection hands the one
 * writer. Type-only imports, so the bot's modules can name these without
 * pulling wms into platform at run time.
 */
import type { CalcGoodsFact, CalcSection, IntakeDoor } from './intake';
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
  /**
   * The row's stored note — where the landing's «og‘irlik umumiy
   * (brutto)dan olindi» lives (`weightFromTotalNote`): an addition that
   * changes such a row's weight clears that sentence and leaves the brutto
   * stale (review lmp-2). Optional — an addition built before it reads none.
   */
  note?: string | null;
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
  /**
   * The bot door the request came in through (0141, docs/IKKI-ESHIK.md §0.3):
   * the ➕ door and the seeded door open their collection's `ai` from it
   * ('plain' → false, 'ai' → true; null keeps today's flag). Optional: an add
   * collection hydrated with a base built before 0141 reads none — null, so
   * it keeps the flag it was opened with.
   */
  door?: IntakeDoor | null;
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
  /**
   * What the bot noted on RECEIVING the files (`IntakeState.fileNotes`, docs/
   * IKKI-ESHIK.md §1.2.5): a top-up's packing list is a «noted» file, its
   * totals «so‘rovga yozilmadi, VED fayldan ko‘radi» — said to the VED on the
   * card and in the thread, as the seeded landing says it (fix review
   * FR-SELL-6). Optional: a stored «waiting» row from before has none.
   */
  fileNotes?: string[];
  /**
   * The add collection's OWN reading was not whole (docs/FAYL-OQISH.md §1.6) —
   * what it did not read, as its table said it («1 ta PDF»). The addition is
   * written all the same, and NOTHING re-runs: a figure over a file nobody
   * read is the option b his ⭐ rejected. Absent = whole (and every row from
   * before the round).
   */
  unread?: string | null;
  /**
   * The files the add collection refused at arrival (`IntakeState.refusedFiles`,
   * as-built review WORDS-2): their goods are in no figure, and the VED reads
   * which in the thread and on the card. Absent = none (and every row from
   * before).
   */
  refusedFiles?: { name: string; why: string }[];
}
