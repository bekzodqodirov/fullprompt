import { logger } from '../logger';
import { staffForChat } from './staff-bot';
import type { AmendBase } from '../../wms/calc/amend-types';
import type { CalcGoodsFact, CalcFacts, TotalDoubt } from '../../wms/calc/intake';
import type { TableTarget } from '../../wms/calc/line-address';
import type { CodedRow, CodingLookups, CodingRow } from '../../wms/calc/row-coding';
import type { KnownCode } from '../../wms/calc/intake-ai';
import type { IntakeFiles } from './calc-files';
import {
  goodsNameKey,
  goodsNameKeys,
  LINE_FIGURES,
  figureOf,
  namesContradict,
  namesMeet,
  packingTotals,
  sameFigures,
  sameLine,
  type GoodsFileMeta,
  type NameKeys,
} from './file-goods';
// The name keys and «the same line» moved to file-goods.ts (docs/IKKI-ESHIK.md
// §1.2) — the hydrate reads them too; every importer keeps its import here.
export { goodsNameKey, goodsNameKeys, sameGoodsLine } from './file-goods';

/**
 * The «Hisoblatish» collection, as the bot holds it.
 *
 * A collection is a few minutes of one person's attention: press the button,
 * forward the client's files and facts, press «Bo'ldi». It lives in memory
 * with a TTL, like the round-35 task-result pendings and the round-21
 * connect flow — the FILES are not in memory, they go straight to storage
 * pre-bound to the note id minted here, exactly as the receiving wizard
 * pre-binds lot photos before the receipt exists.
 *
 * What that costs, stated plainly: a bot restart mid-collection loses the
 * typed text and the person starts again. The alternative — a table, a
 * status column and a cleanup job for abandoned rows — is more machinery
 * than a five-minute conversation deserves, and the confirmed result is
 * persisted the moment it matters.
 *
 * The store itself is calc-store.ts (docs/SAKKIZ-R3.md K3); its four calls are
 * re-exported here, so every importer keeps its import.
 */

/**
 * Where the collection stands. `review` is the TABLE stage (docs/SAKKIZ-R3.md
 * §8.2.1, his 1.10 c): one message names every line ✅ or ⚠️ and the seller
 * answers any of them; the `question` stage that asked one line at a time is
 * retired.
 */
export type IntakeStage = 'section' | 'client' | 'material' | 'review';

/**
 * A spreadsheet's text, whether its reader stopped before the end (round-2
 * review, C1) and whether it only shortened some cells (round-3, R3-C2) — and
 * the file it came from, as the seller was told it («A.xlsx»), so a LATER file
 * that squeezes it out of the model's shared budget can name it (round-4
 * integration S-d). The model is never shown the label.
 */
export type SheetText = import('../../wms/calc/intake-ai').IntakeSheetText & {
  label?: string;
  /**
   * A workbook's sheets with NO header the reader mapped (docs/FAYL-OQISH.md
   * §4.1) — beside the Excel rows, material the model reads that may hold
   * goods of its own, so a line the model finds there is named, never dropped
   * in silence (§4.6). Absent: a mapped sheet's own text — a packing list of
   * the same goods, or a sheet read for the totals — or a text stored before.
   */
  unmapped?: true;
  /** What the reader saw on a header-less file, for its words (§4.4, `sheetTextLine`). */
  why?: 'header' | 'no_rows';
  /** The workbook carries pictures nothing reads (§4.4). */
  pictures?: true;
};

/** An inline keyboard as Telegram takes it — what a stored reply carries. */
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

/**
 * One table answer as the seller was told it (P3, docs/SAKKIZ-R3.md §2.2), so
 * «↩️ Bekor qilish» can put back exactly what it changed. K: nothing writes one.
 */
export interface IntakeEcho {
  /** 8 hex, random — `cu:<tag>`. */
  tag: string;
  /** The echo's own message (joins `ownMessageIds`). */
  messageId: number | null;
  lines: {
    index: number;
    no: number;
    itemId: string | null;
    name: string;
    before: Partial<CalcGoodsFact>;
    patch: Partial<CalcGoodsFact>;
  }[];
  /** The undo restores the previous answer WHOLE (figures and `at`) and the doubts it retired. */
  totals: {
    before: Partial<CalcFacts>;
    patch: Partial<CalcFacts>;
    answerBefore: IntakeState['totalsAnswer'];
    doubtsBefore: TotalDoubt[];
  } | null;
  undone: boolean;
}

export interface IntakeState {
  section: import('../../wms/calc/intake').CalcSection;
  stage: IntakeStage;
  /** Minted up front so photos can be stored against it while they arrive. */
  noteId: string;
  /**
   * The member of staff collecting, and the clocks the durable store keeps
   * (docs/SAKKIZ-R3.md K4, P1). `touchedAt` is the seller's last action;
   * `remindedAt` the reminder's mark. Inert in K: `expires` still decides.
   */
  staffId: string;
  openedAt: number;
  touchedAt: number;
  remindedAt: number | null;
  /** The highest Telegram message id this collection applied (durability-1, regression-6). */
  takenUpTo: number;
  /** The message whose press (or reply) opened it — a restart pressed from it again resumes. */
  openedBy: number | null;
  /** This collection's own bot messages: prompt, table, echoes, reminder, pause notice (last 40). */
  ownMessageIds: number[];
  /** Non-null = an add collection: «➕ Shu so‘rovga qo‘shish» (P4). */
  amend: AmendBase | null;
  /**
   * Question 6 a: a returned request's rows, kept through every reading like an
   * add collection's stored rows, but landed as a NEW request through
   * `landIntake` — Uch band decides its card (P4).
   */
  seed: CalcGoodsFact[] | null;
  /**
   * The returned request a seeded collection was opened from (COMP-3): a
   * second ➕ on that request resumes it, and a reply to that request's AI
   * answer is its own, never «another request's». Optional — a row written
   * before this field reads as null.
   */
  seededFrom?: string | null;
  /**
   * A seeded collection's SOURCE door (docs/IKKI-ESHIK.md §0.3), written when
   * it opens: what its chat words follow — the plain door's summary, or
   * today's table on a legacy NULL source, which the `ai` flag alone cannot
   * tell from a plain yo‘lkira one. Optional — a row written before it reads
   * as legacy.
   */
  seedDoor?: import('../../wms/calc/intake').IntakeDoor | null;
  /**
   * The customer the DOOR wrote into `clientHintRaw` — an add collection's
   * card label, a seeded one's carried code (review PF-9). Not the seller's
   * typing: a collection holding only this is empty, never reminded and never
   * said goodbye to. Optional — a row written before this field reads as none.
   */
  doorHint?: string | null;
  /**
   * The certificate answer the collection opened with — a seeded one's,
   * carried from the returned request (fix review FR-10): a press that
   * changes it is the seller's content (`intakeIsEmpty`). Optional — a row
   * written before this field reads as none.
   */
  certificateAtOpen?: boolean | null;
  /** Seqs the law asks a count for (P5's `lawAsksOf`), when an add collection opens (P4). */
  askedSeqs: number[] | null;
  /**
   * A stored row the new material restates with another figure, or with a
   * figure in a field the row has empty (`stored: null`) (P4). `choice` is the
   * seller's answer; null = unanswered, which is 'ved' at the save.
   */
  conflicts: {
    itemId: string;
    seq: number;
    field: 'quantity' | 'weightKg' | 'volumeM3' | 'measureQty';
    unit: string;
    stored: number | null;
    read: number;
    choice: 'add' | 'rep' | 'ved' | null;
  }[];
  /** «✅ Qo‘shish» pressed: the save job owns the collection until it answers (P4). */
  saving: { token: string; at: number; jobId: string | null } | null;
  /** The add door's standing when it opened (P4): 'started' makes the echo say «VED ga yuboriladi». */
  standingAtOpen: 'open' | 'started' | 'busy' | null;
  /** The message that drew the LIVE `offers` (P3): a pick from any other message is stale. */
  offersMessageId: number | null;
  /** Messages taken through a `cf:` offer press (P4), one per album part: older than `takenUpTo` by nature (calc-amend `REPLIED_TAKEN_KEPT`). */
  repliedTaken: number[];
  /** The table, for edit-in-place (P3). */
  tableMessageId: number | null;
  /** The last table text drawn (P3, performance-5). */
  tableHash: string | null;
  /** When the reading's token was minted (P2's staleness). */
  analysingAt: number | null;
  /** The reading's pg-boss job id (P2, performance-1). */
  analysingJob: string | null;
  /** «Tahlil qilib bo‘lmadi» already said for this token (P2). */
  readingSaidDead: boolean;
  /**
   * A reading's reply stored before it was sent (P2): `at` = when it was
   * stored; `jobId` = the delivery-only follow-up's job, when a flood wait sent
   * the delivery there (durability-16); `noticeMessageId` = the press's
   * «⏳ AI o‘qiyapti…», so whoever delivers the reply late — the sweep has no
   * job payload — still points it down (§2.6; reviews spec-5, adv-11).
   * Optional: a row stored before it existed reads as no notice.
   */
  pendingReply: {
    token: string;
    text: string;
    keyboard: InlineKeyboard | null;
    at: number;
    jobId: string | null;
    noticeMessageId?: number | null;
    /**
     * What the «⏳ AI o‘qiyapti…» notice is edited to (docs/FAYL-OQISH.md
     * §2.3), decided at SETTLE from what the reading did — never from the
     * stage at delivery. Absent on a reply stored before it: today's
     * «✅ O‘qildi».
     */
    notice?: 'read' | 'cut' | 'failed' | 'no_model' | 'arrived';
  } | null;
  /** The table answers the seller was told, for the undo (P3). */
  echoes: IntakeEcho[];
  /**
   * What the last «↩️» took back on the AI door (docs/IKKI-ESHIK.md §3.4):
   * the table's last block says it — «↩️ Bekor qilindi: …», or that a row a
   * later answer changed was kept — until the next answer or reading, since
   * no echo message is left to edit. `tag`: the echo it undid. Optional — a
   * row written before it reads as none.
   */
  lastUndo?: { tag: string; done: string[]; notes: string[] } | null;
  /**
   * What the last reading READ — the material and files of its snapshot
   * (docs/IKKI-ESHIK.md §1.4, review PC-SPEC-5 / PC-ADV-6): «is there
   * anything new to read» is anything sent beyond it (`nothingNewToRead`).
   * Without it a first collection collecting again after «➕ Yana ma’lumot»
   * always counted as unread: the summary lost its buttons and its ✅ was
   * refused «avval Bo‘ldi» with nothing sent, a billed re-read for a job that
   * was complete. Optional — a row written before it reads as no reading.
   */
  readMark?: TotalsMark | null;
  /** What staff typed to name the customer — a code, a phone, or a name. */
  clientHintRaw: string;
  /** Everything typed or captioned, in the order it came. */
  material: string[];
  fileCount: number;
  facts: import('../../wms/calc/intake').CalcFacts;
  /** The model's own notes on what it did — the summary shows three. */
  steps: string[];
  /**
   * The BOT's own sentences about the reading — the lines left out because an
   * Excel answered for them (`sameAsInvoiceNote`, `typedLeftOutNote`). Kept
   * apart from `steps` (round-4 review, C-r1 nit): put first among the model's
   * notes, one of its three was pushed out of the summary, and the sentence
   * read as the AI's. The summary prints them on their own lines; the card's
   * lenta keeps them ahead of the model's notes, as before.
   */
  notes: string[];
  /**
   * The RECEIPT-time notes (docs/IKKI-ESHIK.md §1.2.5, §1.4): what the bot
   * decided about a file when it arrived — the Excel-vs-Excel comparison, «N
   * ta tovar o‘qildi», «rasm sifatida o‘qiladi», the reader's cut and size
   * warnings — written in the same patch as the file. They survive every
   * reading (`settleAnalysis` keeps the live row's), are lines of the ONE
   * prompt, and land on the card note ahead of `notes` and `steps`.
   * READING-time notes stay in `notes`. A row written before it reads []
   * (`migrateIntakeState`).
   */
  fileNotes: string[];
  aiUsed: boolean;
  /**
   * Photographs the model is allowed to LOOK at, downscaled.
   *
   * The owner's report: «kub kilosi rasimni ichiga yozilgan bo'lsa analiz
   * qilmayabti» — and he is right, the analysis only ever saw text. His
   * office photographs the packing list; the numbers on it were stored on
   * the card and read by nobody.
   *
   * The FILES are in storage against the note id from the moment they
   * arrive; the collection keeps their attachment ids and never the bytes
   * (docs/SAKKIZ-R3.md K4 — a Buffer never reaches the durable row). The
   * reading loads them (`loadIntakeFiles`). Capped in both directions: a
   * handful of images, downscaled, or a forwarded album is a request body
   * nobody budgeted for.
   */
  images: { attachmentId: string; mediaType: 'image/jpeg' }[];
  /** How many photos arrived but were NOT reduced — counted, never silent. */
  imagesSkipped: number;
  /**
   * The one live «Bo'ldi» control. Every material message used to answer
   * with a fresh keyboard, so eight forwards left eight buttons and the
   * person could not tell which was current (his second report). The prompt
   * is EDITED in place instead, and its id is how.
   */
  promptMessageId: number | null;
  /**
   * The «🤖 AI rastamojka» door (sub-round C), as opposed to the plain
   * «🧮 Hisoblatish» one.
   *
   * It changes what the bot DOES after the confirm, never what it collects:
   * the same collector, the same landing, the same queue. What the flag buys
   * the seller is the follow-up questions and the promise of a figure in the
   * chat — so an ordinary collection is not made slower by questions nobody
   * asked for.
   */
  ai: boolean;
  /**
   * Has the customer a certificate of origin? TRUE by default, which is the
   * request column's own default since 0091 — the additional duty only bites
   * when there is none, and assuming the worse case would quote every job
   * high.
   */
  hasCertificate: boolean;
  /**
   * Where the road runs, when the AI podklyuch door asked (item 13): the
   * tariff zone the seller pressed, and the cities it stands for. The zone is
   * what prices the road; the cities fill the checklist's «qayerdan/qayerga»
   * only where neither the seller's words nor the model named them.
   */
  route: { zone: string; fromCity: string; toCity: string } | null;
  /**
   * What the seller ANSWERED for the totals in the table («jami 3500 kg»), as
   * READ (judge concurrency-4) — put back on top of every re-read, the way
   * `lineAnswers` is: an answer is never material, so a re-read would
   * otherwise rebuild the facts without it.
   *
   * `at` is where the material and files stood when it was given (review
   * CONC-2): what arrives AFTER it may state the figure differently, and is
   * then asked about rather than outranked (`totalsDoubts`).
   */
  totalsAnswer: { weightKg: number | null; volumeM3: number | null; at: TotalsMark };
  /**
   * The totals a further packing-shaped Excel GAVE (docs/IKKI-ESHIK.md
   * §1.2.2, §1.2.5): its gross Σ as the brutto — or, from a net column only,
   * offered as a netto (`weightNetto`), which the freight total refuses where
   * the section needs brutto — and its m³ Σ. Written in the same patch as the
   * file, so a re-read cannot lose it. Ranked below the seller's typed figure
   * and `totalsAnswer`, above the model; `at` is where the material stood, so
   * a `totalsAnswer` older than it is doubted (`totalsDoubts`). `label` names
   * the file. Null = no such file. Optional in the stored row: a row written
   * before it reads null (`migrateIntakeState`).
   */
  fileTotals: {
    weightKg: number | null;
    volumeM3: number | null;
    weightNetto: boolean;
    label: string;
    at: TotalsMark;
    /**
     * The figures two files disagreed on (`withFileTotals`): left to the VED,
     * and the model's reading does not land in their place (review
     * PF-ADV-8). Absent = none.
     */
    clash?: ('weightKg' | 'volumeM3')[];
  } | null;
  /**
   * A route answered in the table (docs/SAKKIZ-R3.md K15; P3 writes it), kept
   * beside `totalsAnswer` so a re-read cannot erase it — a typed «Yiwu →
   * Toshkent» lived only in `facts`, and the next reading rebuilt `facts`
   * from the material. Marked like it (`at`) so later material can doubt it.
   * Present keys only. Inert in K: nothing writes it.
   */
  routeAnswer: { fromCity?: string; toCity?: string; at: TotalsMark } | null;
  /**
   * What the seller ANSWERED per line, kept so a re-analysis after «➕ Yana
   * ma'lumot» can put it back. The audit's finding: the re-read rebuilt the
   * goods from the material and threw every typed count and weight away,
   * while the seller believed those lines were answered. Matched back by
   * index AND name — a re-read that reorders the lines must not hand one
   * line's answer to another.
   *
   * `index` is the line the answer was PLACED on by the last reading — WRITTEN
   * BACK by `placeByName` (regression-7, the rule `carryLineDone` held for
   * ⏭); a stored row's answer also carries its item id (P3/P4, K4). -1 = not
   * placed this reading, kept by name for a later one, and never matched by
   * index, so answering row 1 cannot delete another line's kept answer.
   */
  lineAnswers: {
    index: number;
    name: string;
    patch: Partial<import('../../wms/calc/intake').CalcGoodsFact>;
    itemId?: string | null;
  }[];
  /**
   * The figures the last answer's buttons stand for («[50 dona] [50 kg]»,
   * judge UX4). A button carries only its position (`c:pick_N`); the figure
   * and the row it answers (`target`) are read back from here, and only from
   * the message that drew them (`offersMessageId`), so a stale or forged
   * press can only pick among what THAT answer offered (regression-23).
   * `taken`: its row was answered by a pick — the same message's buttons for
   * OTHER rows stay live (review adv-7), its own are «eskirgan».
   */
  offers: { unit: import('../../wms/calc/needs').NeedUnit; value: number; target: TableTarget; taken?: boolean }[];
  /**
   * Totals the typed material states two ways, or states against the
   * seller's own answer (review CONC-2) — the summary asks them.
   */
  ambiguousTotals: import('../../wms/calc/intake').TotalDoubt[];
  /**
   * Goods read out of an invoice the seller attached (XLSX/CSV).
   *
   * Held beside the material rather than merged into it. Since 2026-10-09
   * (P1.6) a file that yields a line IS the goods list — it is exact about
   * its rows, codes and units, and the model's reading of a caption used to
   * replace it — while the seller's typed totals, route and per-line
   * answers still win over anything read.
   */
  invoiceGoods: import('../../wms/calc/intake').CalcFacts['goods'];
  /**
   * PDF invoices, small enough to show the model as document blocks.
   *
   * Capped like the images and for the same reason: a request body nobody
   * budgeted for is a request that fails slowly. It used to be ONE — «the
   * first wins» — so the second factory's invoice of a two-factory order was
   * stored on the card and read by nobody (his 1.13). Up to
   * `MAX_INTAKE_PDFS`, read TOGETHER; past the cap the seller is told.
   *
   * By attachment id, like the images (K4); `bytes` keeps the cap arithmetic.
   */
  pdfs: { attachmentId: string; name: string; bytes: number }[];
  /**
   * Spreadsheets the reader could not map onto columns (no header it knows),
   * as text — the model reads them (his 1.2 b). A sheet the reader DID map is
   * `invoiceGoods`, exact, and never sent to the model twice. SEPARATE files
   * only: the other sheets of a mapped workbook are `invoiceTexts`, because
   * they belong to that workbook and leave with it (round-1 review, c7).
   * Each carries the reader's own «I stopped before the end» (`cut`), so the
   * seller is told when the file arrives and the model when it reads (round-2
   * review, C1).
   */
  sheetTexts: SheetText[];
  /**
   * The OTHER sheets of the workbooks `invoiceGoods` came from — the
   * «Packing list» beside the «Invoice», whose TOTAL G.W./CBM are the
   * shipment's totals. Shown to the model as context, never as a second
   * goods list (#1458) — under their OWN heading, «for the totals, do not
   * list these goods» (round-2 review, C2: joined into the goods block, a
   * «boshqa zavod» answer re-listed the workbook's own lines). Kept per
   * workbook, out of `sheetTexts` (round-1 review, c7); since his 1a no file
   * replaces another, and a packing-shaped further Excel's WHOLE text joins
   * here too (docs/IKKI-ESHIK.md §1.2.2) — its «TOTAL G.W.» row is read under
   * the totals-only heading.
   */
  invoiceTexts: SheetText[];
  /**
   * RETIRED by his 1a (docs/IKKI-ESHIK.md §1.1): further spreadsheets that
   * waited for «qo‘shilsin yoki o‘rniga?» (his 1.13 c). Nothing writes it any
   * more — a further Excel is compared row by row as it arrives
   * (file-goods.ts `foldInvoice`) — and a collection hydrated holding one is
   * resolved by the same rule before it is put in memory
   * (`migrateIntakeState`), so after the hydrate nothing is pending. Kept in
   * the type for that one read.
   */
  pendingInvoice: {
    goods: import('../../wms/calc/intake').CalcFacts['goods'];
    label: string;
    texts: SheetText[];
  } | null;
  /**
   * What the MODEL's goods are worth once an Excel list exists (round-1
   * review, c4; his 1.13: two invoices from two factories). A PDF or a
   * header-less sheet beside an Excel list is no longer asked about (his 1a,
   * docs/IKKI-ESHIK.md §1.2.2, M3): the bot writes `add` — the model is shown
   * the Excel's list (`knownGoods`) and told to list only goods not on it,
   * `pickGoods` drops a line the Excel already carries (by name, or by a count
   * AND a weight equal to exactly one row's, M1 c), and the reading names
   * what it added (`modelAddedNote`). `context` (the same goods, read for the
   * totals only) and `ask` (the question open) are a hydrated collection's —
   * `ask` becomes `add` at the hydrate (`migrateIntakeState`); new code only
   * WRITES `add`. Null = no such pair has arisen: photos and typed text
   * beside an Excel keep that rule (the Excel answers, the extra lines are
   * named).
   *
   * STATED, not built (round-2 review, C2): the model reads the documents
   * together and returns one list, which names no file per line — the dedup
   * against the Excel is what stands for per-file answers.
   */
  aiGoods: 'ask' | 'add' | 'context' | null;
  /**
   * The mapped Excels' blocks of `invoiceGoods`, in order (docs/IKKI-ESHIK.md
   * §1.2.2): which file each row came from, its shape and weight kind — so a
   * further file compares a gross weight only with a gross one, and a packing
   * list that came FIRST hands the goods role to the invoice after it.
   * Optional in the stored row: a row written before it reads [] and every
   * held row's weight kind unknown.
   */
  goodsFiles?: GoodsFileMeta[];
  /**
   * The last text the customer question filed as MATERIAL. The same text sent
   * again is the seller insisting it IS the customer, and is taken as one —
   * otherwise a name the goods reader mistook for a line («Ali aka 2») looped
   * on the question for ever (round-1 review, t23).
   */
  clientAskedWith: string | null;
  /**
   * RETIRED (docs/SAKKIZ-R3.md §7.2.10): what the readings cost used to be
   * appended here and billed at the landing. The reading job now writes the
   * ledger the moment the model answered, on the collection's note, so
   * nothing reads this any more; optional for one release, for a collection
   * hydrated with it, then removed.
   */
  usages?: { model: string; inputTokens: number; outputTokens: number; at?: number }[];
  /** Why the model's reading is missing (his 1.6 a) — null when it read. */
  aiFailure: import('../../wms/calc/intake').AiReadFailure | null;
  /**
   * docs/FAYL-OQISH.md §10 — what the reading did NOT read, as state, so the
   * table, the save branch, the landing and the sweep all ask the same
   * `aiReadingWhole` (reading-whole.ts). Optional: a row written before this
   * round reads as «nothing unread» (`migrateIntakeState` defaults them).
   *
   * `aiCut` — the model stopped before the end; the goods it completed are
   * the reading's, and the rest is unread (§3.3). Written by every reading.
   */
  aiCut?: import('../../wms/calc/intake-ai').AiReadingCut | null;
  /** «🔄» was pressed once on a clock cut; new material clears it (§1.2). */
  aiCutRetried?: boolean;
  /** The model was not shown all of an accepted sheet text (§1.1 f). Written by every reading. */
  aiInputCut?: boolean;
  /** Stored files the reading could not load (§2.5). Written by every reading. */
  filesMissing?: number;
  /** PDFs the API refused (attachment ids) — skipped by later readings, named on the table (§3.4). */
  unreadPdfs?: string[];
  /** Files refused AT ARRIVAL, with the words the seller was told — named, never blocking (§1.1). */
  refusedFiles?: { name: string; why: string }[];
  /** The restart question stands: material is refused in words until it is answered (§2.4). */
  restartAsked?: { messageId: number | null; at: number } | null;
  /** What the landing press chose — the AI's figure, or the VED alone (§1.3 a). */
  landAs?: 'ai' | 'ved' | null;
  /**
   * The analysis in flight, by a token minted at «Bo'ldi».
   *
   * The analysis runs on a SNAPSHOT for up to a few minutes, and its result
   * used to be written back over the live collection — so a message sent
   * while it ran (the bot had answered «Qabul qilindi») was erased, a second
   * «Bo'ldi» started a second paid call, and a cancel mid-analysis was undone
   * by the result arriving. The result now lands only on the collection that
   * still carries ITS token, and keeps whatever arrived meanwhile.
   */
  analysing: string | null;
  /**
   * The seller's typed table answers, verbatim, for the card — each saying
   * where it went («3-qator: …», «Umumiy: …»).
   * NOT material: material is re-read for the shipment's totals, and a line's
   * «150 kg» read as the whole truck's weight is what made a re-analysis
   * overrule the documents (the diagnosis' cause 5).
   */
  answers: string[];
  /**
   * RETIRED (docs/IKKI-ESHIK.md §1.5): the album the customer question was
   * last re-asked for. The question is one message now, redrawn coalesced
   * per chat, so nothing writes or reads it; kept, so a row written before
   * still parses.
   */
  reaskedGroup: string | null;
  expires: number;
}

/** How much material and how many files a collection held at a moment. */
export interface TotalsMark {
  material: number;
  files: number;
}

const figure = (n: number) => String(Math.round(n * 1000) / 1000);

// R2's totals-shape helpers live in a zero-import module now (docs/SAKKIZ-R3.md
// K6), so the pure wms table parser can read them without this file's
// staff-bot import; re-exported, so no importer moved.
export { bareTotalsNumber, looksLikeTotalsAnswer, totalsAnswerShape, totalsFigureCount } from './totals-shape';

/**
 * The totals the material states two ways that the seller has NOT since
 * answered (review P3-3) — an answer to the totals question retires its own
 * «1.2 mi yoki 1200 mi?». The material is re-parsed on every reading and the
 * answer is never material (`totalsAnswer`), so without this the summary
 * asked again about the figure printed beside it, under «to‘liq». Pure.
 */
export function unansweredAmbiguity(
  ambiguous: IntakeState['ambiguousTotals'],
  answer: Pick<IntakeState['totalsAnswer'], 'weightKg' | 'volumeM3'>,
): IntakeState['ambiguousTotals'] {
  return ambiguous.filter((a) => (a.field === 'weightKg' ? answer.weightKg : answer.volumeM3) === null);
}

type Totals = Pick<import('../../wms/calc/intake').CalcFacts, 'weightKg' | 'volumeM3'>;

/**
 * The totals answer, judged against what came AFTER it (review CONC-2) — the
 * doubts it leaves, if any.
 *
 * The answer used to win over every later reading for good: a packing list
 * sent after «➕ Yana ma’lumot» saying G.W. 4200 kg, or the seller typing
 * «brutto 4200 kg», was outranked by the «3500» typed to the bot's question
 * before he had the list — and the stale figure landed and priced the road.
 *
 * A figure for an answered field that the LATER material states — typed
 * after the answer (`since`, read against the whole text's goods lines), or
 * else what the reading of everything now finds — and that is not the answer
 * DOUBTS it: the field is asked again with both figures named, never one
 * picked in silence. A later figure written two ways doubts it too, and its
 * own «mi yoki» is the question. The answer itself is KEPT, so the doubt is
 * found again on every re-read until the seller answers again — an answer
 * moves its mark past the material that doubted it — and is never lost to a
 * reading that then takes the document's figure in silence. Nothing having
 * arrived since, the answer stands: the seller answered looking at all of
 * it. Pure.
 */
export function totalsDoubts(
  answer: IntakeState['totalsAnswer'],
  later: {
    /** Material and files now. */
    now: TotalsMark;
    /** What the text typed after the answer states (`parseManualFacts(…, { from })`). */
    since: Totals & { ambiguous: import('../../wms/calc/intake').AmbiguousTotal[] };
    /** What the reading of the whole collection finds, before the answer is put back. */
    reading: Totals;
  },
): IntakeState['ambiguousTotals'] {
  const arrived = later.now.material > answer.at.material || later.now.files > answer.at.files;
  if (!arrived) return [];
  const doubts: IntakeState['ambiguousTotals'] = [];
  for (const field of ['weightKg', 'volumeM3'] as const) {
    const answered = answer[field];
    if (answered === null) continue;
    const twoWays = later.since.ambiguous.find((a) => a.field === field);
    const said = Number(later.since[field] ?? later.reading[field]);
    if (twoWays) doubts.push(twoWays);
    else if (said > 0 && figure(said) !== figure(answered)) doubts.push({ field, answered, stated: said });
  }
  return doubts;
}

/** The same route answer — the same cities, given at the same point? Pure. */
export function sameRouteAnswer(
  a: IntakeState['routeAnswer'] | undefined,
  b: IntakeState['routeAnswer'] | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.fromCity === b.fromCity &&
    a.toCity === b.toCity &&
    a.at.material === b.at.material &&
    a.at.files === b.at.files
  );
}

/**
 * The route answer's cities that still stand over a (re-)read — `totalsAnswer`'s
 * rule for the route (R2's CONC-2): a key is applied while no material written
 * AFTER the answer names a different city for it, and then the reading's city
 * stands. `since` is that later material's own reading, or null when nothing
 * came after (an answer typed while a reading ran is newer than all of it).
 * Pure.
 */
export function answeredRoute(
  answer: IntakeState['routeAnswer'] | undefined,
  since: { fromCity?: string | null; toCity?: string | null } | null,
): { fromCity?: string; toCity?: string } {
  if (!answer) return {};
  const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
  const out: { fromCity?: string; toCity?: string } = {};
  for (const key of ['fromCity', 'toCity'] as const) {
    const said = answer[key];
    if (!said) continue;
    const later = since?.[key];
    if (later && !same(later, said)) continue;
    out[key] = said;
  }
  return out;
}

/** Is this the same totals answer — the same figures, given at the same point? Pure. */
export function sameTotalsAnswer(a: IntakeState['totalsAnswer'], b: IntakeState['totalsAnswer']): boolean {
  return (
    a.weightKg === b.weightKg &&
    a.volumeM3 === b.volumeM3 &&
    a.at.material === b.at.material &&
    a.at.files === b.at.files
  );
}

/**
 * The facts once the answer is judged: the answer on top (`mergeTotalsAnswer`),
 * and a DOUBTED field emptied so the totals question asks it again — a cube
 * flagged as stated-but-unsettled, as a cube typed two ways is, so the lines'
 * Σ does not answer the question instead (`factsVolumeM3`). Pure.
 */
export function factsWithAnswer(
  answer: IntakeState['totalsAnswer'],
  doubts: IntakeState['ambiguousTotals'],
  facts: IntakeState['facts'],
): IntakeState['facts'] {
  const merged = mergeTotalsAnswer(answer, facts);
  for (const doubt of doubts) {
    if (doubt.field === 'weightKg') {
      merged.weightKg = null;
      delete merged.weightNetto;
    } else {
      merged.volumeM3 = null;
      merged.volumeAmbiguous = true;
    }
  }
  return merged;
}

/**
 * The totals answer, put back on top of a (re-)read's facts (judge
 * concurrency-4) — `mergeLineAnswers`' rule for the totals. What the seller
 * answered wins over what a re-read found: it was said in reply to the
 * bot's own question. Pure.
 */
export function mergeTotalsAnswer(
  answer: IntakeState['totalsAnswer'],
  facts: IntakeState['facts'],
): IntakeState['facts'] {
  // An answered cube is no longer the ambiguous one (review P3-R2), and an
  // answered weight is the BRUTTO the question asked — no longer a netto
  // standing in for it (review PF-3).
  const { volumeAmbiguous, weightNetto, ...rest } = facts;
  return {
    ...rest,
    weightKg: answer.weightKg ?? facts.weightKg ?? null,
    volumeM3: answer.volumeM3 ?? facts.volumeM3 ?? null,
    ...(volumeAmbiguous && answer.volumeM3 === null ? { volumeAmbiguous } : {}),
    ...(weightNetto && answer.weightKg === null ? { weightNetto } : {}),
  };
}

/** At most this many buttons answer one question — two readings × three units. */
export const MAX_OFFERS = 6;

/**
 * Where each of the seller's per-line answers stands on a (re-)read goods
 * list, and the list with them put back — the ONE placement rule
 * (docs/SAKKIZ-R3.md §8.2.8):
 *  - the stored row's `itemId` first;
 *  - else the same index while the line there still carries the name;
 *  - else the first UNCLAIMED line of that name;
 *  - else nowhere (-1), the name kept for a later reading.
 * A line is claimed once (round-3 review R3-C5's rule, which only the ⏭
 * record had): answers to two «Kurtka» lines land on two lines, never one
 * line twice while the other is lost.
 *
 * The placement is WRITTEN BACK (regression-7, round 4's C-r2 lesson): the
 * readers that store answers store the returned `entries`, each `index`
 * rewritten to where it landed. Carried by the old index, an answer to
 * [Kurtka] re-read as [Shim, Kurtka] still pointed at row 0, and the next
 * answer to row 1 «Shim» replaced it — Kurtka's figure was lost. Pure.
 */
export function placeByName(
  goods: NonNullable<import('../../wms/calc/intake').CalcFacts['goods']>,
  entries: IntakeState['lineAnswers'],
): { goods: NonNullable<import('../../wms/calc/intake').CalcFacts['goods']>; entries: IntakeState['lineAnswers'] } {
  const out = goods.map((g) => ({ ...g }));
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const taken = new Set<number>();
  const placed: IntakeState['lineAnswers'] = [...entries];
  // An answer the last reading placed somewhere claims before one it placed
  // nowhere (-1): an orphan's name fallback took the line a later correction
  // held by its index, and the seller's fresh figure moved to the other
  // «Kurtka» (review spec-10, adv-6). Within each, the list's order.
  const order = entries.map((_e, i) => i).sort((a, b) => Number(entries[a]!.index < 0) - Number(entries[b]!.index < 0));
  for (const n of order) {
    const entry = entries[n]!;
    const free = (i: number) => i >= 0 && i < out.length && !taken.has(i);
    let at = entry.itemId ? out.findIndex((g, i) => free(i) && g.itemId === entry.itemId) : -1;
    if (at < 0 && free(entry.index) && sameName(out[entry.index]!.name, entry.name)) at = entry.index;
    if (at < 0) at = out.findIndex((g, i) => free(i) && sameName(g.name, entry.name));
    if (at >= 0) {
      taken.add(at);
      out[at] = { ...out[at]!, ...rowPatchOf(out[at]!, entry.patch) };
    }
    placed[n] = { ...entry, index: at };
  }
  return { goods: out, entries: placed };
}

/**
 * What an answer puts on its row. A stored row's code is the VED's: a
 * different code the seller typed rides in the answer, for the VED to be told
 * (`codesKept`, §9.5), and is never drawn over the stored one — the echo said
 * «yangi kod yozilmadi» (review adv-11). Pure.
 */
export function rowPatchOf(row: CalcGoodsFact, patch: Partial<CalcGoodsFact>): Partial<CalcGoodsFact> {
  // A code the seller typed is the row's OWN from here on (docs/IKKI-ESHIK.md
  // §3.1): it stays on top of the reading's coding, and never lands marked as
  // the model's proposal it replaced.
  const typed = (p: Partial<CalcGoodsFact>) => (p.tnvedCode ? { ...p, tnvedSource: 'row' as const } : p);
  if (!row.itemId || !row.tnvedCode || !patch.tnvedCode || patch.tnvedCode === row.tnvedCode) return typed(patch);
  const rest = { ...patch };
  delete rest.tnvedCode;
  return rest;
}

/**
 * A code the seller TYPED in the table is the row's own at the landing too
 * (docs/IKKI-ESHIK.md §3.1, review PF-ADV-11): the table writes the code onto
 * its row and leaves the row's `tnvedSource`, so a row the model had coded,
 * corrected by the seller and confirmed straight away, landed with «TNVED: AI
 * taklifi (o‘qishda) — tekshiring» over the seller's own code. Only a re-read
 * cleared it (`rowPatchOf`). A row whose code IS its answer's code is the
 * seller's; a stored row (the add door's) is the VED's and is left. Pure.
 */
export function typedCodesOwn(
  goods: readonly CalcGoodsFact[],
  answers: IntakeState['lineAnswers'],
): CalcGoodsFact[] {
  return goods.map((g, i) => {
    if (g.itemId || g.tnvedSource === 'row' || !g.tnvedCode?.trim()) return g;
    const typed = answers.some((e) => e.index === i && !e.itemId && e.patch.tnvedCode?.trim() === g.tnvedCode!.trim());
    return typed ? { ...g, tnvedSource: 'row' } : g;
  });
}

/**
 * Put the seller's earlier per-line answers back onto a re-read goods list —
 * `placeByName`'s goods, the signature every caller already used (K4). Pure.
 */
export function mergeLineAnswers(
  goods: NonNullable<import('../../wms/calc/intake').CalcFacts['goods']>,
  answers: IntakeState['lineAnswers'],
): NonNullable<import('../../wms/calc/intake').CalcFacts['goods']> {
  return placeByName(goods, answers).goods;
}

/** The hint's non-empty lines, each with its spacing collapsed. */
function hintLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** A line that is only a label waiting for its value («Mijoz:»). */
const isBareLabel = (line: string) => /[:：]$/.test(line);

/**
 * The messengers a number is ON — «Sardor WhatsApp +998 …», «Jasur Viber …».
 * The keyboard capitalises their names whatever they mean, so their capital
 * says nothing of a shop (`nameOwnWord`, round-5 probe, collector). Lower case.
 */
const MESSENGERS = ['whatsapp', 'вотсап', 'ватсап', 'telegram', 'телеграм', 'tg', 'viber', 'wechat'];

/**
 * The words a contact line carries beside its value, in the spellings a
 * seller writes them — «Tel», «Telefon raqami», «Номер телефона», «Phone
 * number», «WhatsApp», «Kontakt», «Aloqa», «T:», «ID», «Mijoz kodi» — and the
 * joining words between two values («va», «и»). Judged WORD by word, never as
 * one listed label (round-4 review, C-r1/C-r2 ND1: a fixed list of opening
 * labels missed «Telefon raqami» — the very words the bot's own question asks
 * for — and the phone went back into the lead's name). Lower case.
 */
const CONTACT_WORDS = new Set([
  'tel', 'telefon', 'telefoni', 'telefonim', 'raqam', 'raqami', 'raqamim', 'nomer', 'nomeri', 'mob', 'mobil',
  'kontakt', 'kontakti', 'aloqa', 'mijoz', 'klient', 'kod', 'kodi', 'id', 't', 'va', 'yoki',
  'тел', 'телефон', 'телефона', 'номер', 'номера', 'моб', 'мобильный', 'контакт', 'контакты', 'клиент',
  'клиента', 'код', 'т', 'и', 'или',
  'phone', 'number', 'no', 'mobile', 'contact', 'client', 'code', 'and', 'or',
  ...MESSENGERS,
]);

/** Where a cut was made in a line: a character no seller types. */
const CUT = '\u0000';
/**
 * A run of digits as a phone is written: «+998 90 123-45-67», «(90) 123 45
 * 67». An opening bracket belongs to the run when it closes around the run's
 * first digits — cut without it, «Sardor (90) 123-45-67» named the lead
 * «Sardor (» (round-4 probe, collector).
 */
const DIGIT_RUN = /\+?(?:\(\d+\)|\d)(?:[\d\s\-–().]*\d)?/g;
/** A Telegram handle — contact, never a name («Telegram: @murod_uz»). */
const HANDLE = /@[\p{L}\p{N}_.]+/gu;
/** The code's number written after its label, the prefix left off: «Kod 777», «Mijoz kodi: 777», «Код клиента 777» for GS777. */
const CODE_LABEL = String.raw`(?:mijoz(?:\s+kodi)?|klient(?:\s+kodi)?|client(?:\s+code)?|клиент|kod(?:i)?|код(?:\s+клиента)?|code|id)[\s.:：#№\-–]*|№\s*`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The line with the hint's OWN phone and code cut out (each cut marked
 * `CUT`), and whether anything was (round-4 review, C-r1/C-r2 ND1). Judged
 * against what `parseClientHint` TOOK, never by the shape alone: «3-filial»
 * and «Ali aka 2» carry digits and are names, and a phone the hint did not
 * take stays where it is written (round-3, R3-C4). The phone is found by its
 * digits whatever the spacing, the code with or without its separator
 * («GS 777», «gs-777») or as its own number after its label («Kod 777»).
 * Once the hint was found here, a second phone and a handle on the same line
 * are contact too («Tel: 90 123 45 67, 91 234 56 78») and are cut with it.
 */
function cutHint(line: string, hint: { code?: string; phone?: string }): { text: string; took: boolean } {
  let text = line;
  let took = false;
  const phone = hint.phone ? hint.phone.replace(/\D/g, '') : '';
  if (phone.length >= 7) {
    text = text.replace(DIGIT_RUN, (run) => {
      const digits = run.replace(/\D/g, '');
      if (digits.length >= 7 && phone.endsWith(digits)) {
        took = true;
        return CUT;
      }
      if (!digits.endsWith(phone)) return run;
      // The phone is the run's TAIL — what stands before it («Mijoz 777 90 …»,
      // «GS 777 90 …») is somebody else's digits and stays.
      took = true;
      let seen = 0;
      const head = digits.length - phone.length;
      for (let i = 0; i < run.length; i += 1) {
        if (!/\d/.test(run[i]!)) continue;
        if (seen === head) return head === 0 ? CUT : `${run.slice(0, i)}${CUT}`;
        seen += 1;
      }
      return run;
    });
  }
  const code = hint.code?.replace(/[\s\-–]/g, '').toUpperCase() ?? '';
  const parts = /^(\p{L}*)(\d+)$/u.exec(code);
  if (code) {
    const whole = parts
      ? `${escapeRe(parts[1]!)}[\\s\\-–.]*${parts[2]}`
      : code.split('').map(escapeRe).join('[\\s\\-–.]*');
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${whole}(?!\\p{N})`, 'giu'), () => {
      took = true;
      return CUT;
    });
    if (parts?.[1]) {
      text = text.replace(new RegExp(`((?<![\\p{L}\\p{N}])(?:${CODE_LABEL}))${parts[2]}(?!\\p{N})`, 'giu'), (_m, label: string) => {
        took = true;
        return `${label}${CUT}`;
      });
    }
  }
  if (took) {
    text = text
      .replace(HANDLE, CUT)
      .replace(DIGIT_RUN, (run) => (run.replace(/\D/g, '').length >= 7 ? CUT : run));
  }
  return { text, took };
}

/**
 * The apostrophes a seller types inside an Uzbek Latin word («Ra'no», «Sa’id»,
 * «o‘g‘li»); ʻ and ʼ are letters already. Between two letters one is part of
 * the word, never a boundary — read as one, the tail of «Ra'no» was the
 * contact word «no» and the lead was named «Ra» (round-4 probe, collector).
 */
const APOS = "['’‘`]";
/** A word: letters and digits, an apostrophe between two of them included. */
const WORD = String.raw`[\p{L}\p{N}]+(?:${APOS}[\p{L}\p{N}]+)*`;

/** The words of a text — `WORD`s, everything else a separator. */
const wordsOf = (text: string) => text.match(new RegExp(WORD, 'gu')) ?? [];

/**
 * Is this line contact and nothing else (round-4 review, C-r1/C-r2 ND1) — the
 * hint's phone or code was cut out of it (`cutHint`), and every word left is
 * contact vocabulary (`CONTACT_WORDS`)? «Telefon raqami: 90 123 45 67», «GS777
 * / +998 …», «Kod GS777 tel 90 …», «ID: GS777», «+998 … (WhatsApp)» are; «Tel:
 * 90 123 45 67 Ali» is not — a name word is left, so the line stays as written
 * (both round-4 reviewers' «what is left» rule).
 */
function isContactLine(line: string, hint: { code?: string; phone?: string } | null): boolean {
  if (!hint) return false;
  const cut = cutHint(line, hint);
  return cut.took && wordsOf(cut.text).every((w) => CONTACT_WORDS.has(w.toLowerCase()));
}

/** A contact word standing beside a cut — «Ali aka, tel: ⟨cut⟩» is «Ali aka». */
const CONTACT_WORD_RE = [...CONTACT_WORDS].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const HUG_SEP = String.raw`[\s.,:：;/|\\#№«»"'\-–—+]*`;
/** A contact word as a whole `WORD` — never the tail of «Ra'no» or the head of «No'mon». */
const HUG_WORD = String.raw`(?<![\p{L}\p{N}]${APOS}?)(?:${CONTACT_WORD_RE})(?![\p{L}\p{N}]|${APOS}[\p{L}\p{N}])`;
const HUG = new RegExp(`(?:${HUG_SEP}${HUG_WORD})*${HUG_SEP}${CUT}(?:${HUG_SEP}${HUG_WORD})*${HUG_SEP}`, 'giu');
/** The first word of a text with what stands before and after it — and `TAIL_WORD` the last. */
const LEAD_WORD = new RegExp(String.raw`^([^\p{L}\p{N}]*)(${WORD})([^\p{L}\p{N}]*)`, 'u');
const TAIL_WORD = new RegExp(String.raw`([^\p{L}\p{N}]*)(${WORD})([^\p{L}\p{N}]*)$`, 'u');

/**
 * A capitalised contact word of four letters or more, joined by a bare space
 * or hyphen to a capitalised word that is not one, is a word of a shop's or
 * firm's NAME — «Smart Mobile», «Uz-Mobile», «Магазин Телефон», «Phone
 * Market» — and never the phone's label (round-4 probe, collector: the name
 * lost its last word). A label is written as one: lower case («Ali aka tel»),
 * short («Ali Tel»), with its mark («Telefon:»), or apart from any name
 * («Mijoz GS777 …»). The capital counts only where the WRITER chose it — a
 * capital before lower case, never a messenger's name (`MESSENGERS`) nor a
 * word of an all-caps line, which every word passes («SARDOR TELEFON …»,
 * round-5 probe, collector) — bar a word HYPHENED to the name, which no label
 * ever is: «UZ-MOBILE» is a shop in capitals. The cost, an all-caps shop name
 * joined by a space: «SMART MOBILE 90 …» names the lead «SMART» (the summary
 * still prints the whole line, `intakeClientSummary`).
 */
function nameOwnWord(word: string, joint: string, neighbour: string | undefined, mark: string): boolean {
  const hyphened = /[-–]/u.test(joint);
  return (
    (/^\p{Lu}\p{Ll}/u.test(word) || (hyphened && /^\p{Lu}/u.test(word))) &&
    !MESSENGERS.includes(word.toLowerCase()) &&
    word.replace(/[^\p{L}]/gu, '').length >= 4 &&
    /^\s*[-–]?\s*$/u.test(joint) &&
    !/[:：.№#]/u.test(mark) &&
    neighbour !== undefined &&
    /^\p{Lu}/u.test(neighbour) &&
    !CONTACT_WORDS.has(neighbour.toLowerCase())
  );
}

/**
 * One `HUG` (the contact words on both sides of a cut, the cut, their
 * separators) as it leaves the line: a space, with the OUTERMOST word of each
 * side given back when it is the name's own (`nameOwnWord`).
 */
function unhug(hug: string, at: number, line: string): string {
  const cut = hug.indexOf(CUT);
  const left = hug.slice(0, cut);
  const right = hug.slice(cut + 1);
  let keep = ' ';
  const first = LEAD_WORD.exec(left);
  if (first) {
    const [, lead, word, mark] = first;
    const before = TAIL_WORD.exec(line.slice(0, at));
    if (nameOwnWord(word!, `${before?.[3] ?? ''}${lead}`, before?.[2], mark!)) keep = `${lead}${word} `;
  }
  const last = TAIL_WORD.exec(right);
  if (last) {
    const [, , word, trail] = last;
    const after = LEAD_WORD.exec(line.slice(at + hug.length));
    if (nameOwnWord(word!, `${trail}${after?.[1] ?? ''}`, after?.[2], '')) keep += `${word}${trail}`;
  }
  return keep;
}

/**
 * A ONE-line hint with the hint's phone and code cut OUT of it (round-4
 * review, C-r2 close-variant: «Ali aka +998 90 123 45 67», «Murod GS777»,
 * «Rustam (GS777)» — the commonest way a seller types a prospect — named the
 * lead with the phone, which the hint already puts in its own column). The
 * contact words beside a cut go with it — bar a shop’s own word
 * (`nameOwnWord`) — and a bracket left empty. Null =
 * nothing name-like is left («GS 777 90 123 45 67», «Kod 777»).
 */
function nameBesideHint(line: string, hint: { code?: string; phone?: string }): string | null {
  const cut = cutHint(line, hint);
  if (!cut.took) return line;
  const rest = cut.text
    .replace(HUG, unhug)
    // «Rustam (aka ⟨cut⟩)» keeps «(aka)», and «Rustam (⟨cut⟩)» loses the pair.
    .replace(/([(（\[])\s+/gu, '$1')
    .replace(/\s+([)）\]])/gu, '$1')
    .replace(/[(（\[][\s.,:：;/|\-–—]*[)）\]]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,:：;/|\\\-–—]+|[\s.,:：;/|\\\-–—]+$/gu, '');
  return /\p{L}/u.test(rest) ? rest : null;
}

/**
 * The customer's NAME, on one line: the lead's name (round-2 review, C8; the
 * summary prints the whole hint, `intakeClientSummary`). Since the typed round
 * a hint may be two or three lines («Ali aka» over «+998 90 123 45 67»), and
 * the raw text named the lead with a newline AND the phone, which the hint
 * already puts in its own column.
 *
 * Several lines: the lines dropped are the ones that are the hint's contact
 * and nothing else (`isContactLine`; round-3 review R3-C4 — no longer every
 * line with a digit, «Ali aka 2» keeps its «2»; round 4 — any label, a second
 * phone, a handle), and a line that is only a label waiting for its value
 * («Mijoz:»). Every other line is kept as written. When nothing is left: the
 * code, or nobody (the lead's call of 2026-10-22 over R3-C4's collapsed text,
 * which put the phone back into the name); with no hint at all, the text
 * collapsed onto one line.
 *
 * One line: the hint's phone and code are cut out of it (`nameBesideHint`,
 * round 4), and when nothing name-like is left the lead is named by the code,
 * or by nobody (round-4 integration S-c: «GS 777 90 123 45 67» named it with
 * the phone) — the same rule as several lines now.
 *
 * Null = nothing typed, or a one-line hint that is only a phone: the caller
 * has its own word for that. Pure.
 */
export function intakeClientLabel(raw: string, hint: { code?: string; phone?: string } | null): string | null {
  const lines = hintLines(raw);
  if (lines.length === 1 && hint) return nameBesideHint(lines[0]!, hint) ?? hint.code ?? null;
  const named = lines.filter((l) => !isBareLabel(l) && !isContactLine(l, hint));
  if (named.length > 0) return named.join(' ');
  // Nothing name-like left: the lead is named by the code, or by nobody —
  // never by the phone (lead 2026-10-22: S-c over R3-C4's collapsed text,
  // «GS777\n+998 90 …» named the lead with the number its own column holds).
  return hint ? (hint.code ?? null) : lines.join(' ') || null;
}

/**
 * The customer as the confirm's «Mijoz:» prints it — EVERYTHING typed, on one
 * line (round-3 review, R3-C3). The summary is the one screen the seller
 * checks before «Tasdiqlash», and the landing finds the customer by the code
 * or phone in the hint: printed as the lead's name («Ali aka» for «Ali aka /
 * GS777»), a mistyped GS771 could not be seen before it landed. Lines are
 * joined by « · »; a bare label («Mijoz:») takes its value with a space, so
 * «Mijoz:» over «GS777» reads «Mijoz: GS777». Null = nothing typed. Pure.
 */
export function intakeClientSummary(raw: string): string | null {
  const parts: string[] = [];
  let open = false;
  for (const line of hintLines(raw)) {
    if (open && parts.length > 0) parts[parts.length - 1] += ` ${line}`;
    else parts.push(line);
    open = isBareLabel(line);
  }
  return parts.join(' · ') || null;
}

type GoodsList = NonNullable<import('../../wms/calc/intake').CalcFacts['goods']>;


/** A line the Excel kept out of the job, and why — see `PickedGoods.sameAsInvoice`. */
export type LeftOutLine = GoodsList[number] & { why: 'same' | 'typed' | 'file' };

/** What `pickGoods` lands, and the lines it left out because an Excel answered for them. */
export interface PickedGoods {
  goods: GoodsList;
  /**
   * The lines NOT landed because an Excel answers for them — named to the
   * seller, never dropped in silence: the job would land short by them with
   * no word anywhere. `why`:
   *  - `same` — a model line an Excel line is the same product as (round-3
   *    review, R3-C1);
   *  - `typed` — a line the seller TYPED, which the model read too, that the
   *    Excel does not carry, while nobody was asked whether another file is
   *    another factory's (round-4 integration S-a: an Excel and a typed «Shim
   *    200 dona», no PDF — the line was dropped and nobody was asked);
   *  - `file` — a line the model read off material beside the Excel that can
   *    hold other goods (a workbook's header-less sheet, the typed text) and
   *    the Excel does not carry (docs/FAYL-OQISH.md §4.6, xlsxN-02 J2): with
   *    `aiGoods` null it was dropped with no word at all.
   */
  sameAsInvoice: LeftOutLine[];
}


/**
 * Which goods list a collection lands, in the order of how EXACT each source
 * is about the lines. Pure, so the order is a test and not a reading of
 * `analyzeCollected`.
 *
 *  1. An attached invoice (XLSX/CSV) answers whenever it yields a line
 *     (2026-10-09, P1.6): its rows carry the supplier's own codes, units,
 *     weights and volumes. On the add path — a model-read document beside
 *     the Excel, `aiGoods: 'add'` (round-1 review c4; since his 1a the bot
 *     takes it without asking, docs/IKKI-ESHIK.md §1.2.2) — the model's
 *     lines are appended — or, when the model did not read, the TYPED lines
 *     (round-4 integration S-a: «add» answered, the PDF unread, and the typed
 *     «Shim 200 dona» vanished) — except those the Excel already carries,
 *     because the model was shown the PDF and the text, and the text can
 *     repeat a line the Excel has. «Already carries» (round-3 review, R3-C1):
 *      - the same WHOLE name (`goodsNameKey`) — base's rule, kept;
 *      - a name the line answers to (`goodsNameKeys`: the model's «Russian
 *        (original)» meets its Excel original, round-2 review C2) — and then
 *        only when the figures agree too (`figuresAgree`). The wide match
 *        alone threw factory B's «Kurtka (qora)» 200 away against factory A's
 *        «Kurtka» 300, and two factories shipping one generic name is this
 *        business's ordinary day.
 *     The wide match is between a model line and the INVOICE only; among the
 *     lines ADDED, the same whole name is one line and nothing wider — the
 *     model's «Kurtka» and «Kurtka (qora)» are two products it read. A line
 *     whose same-named twin was the Excel's is judged on its own (round-4,
 *     C-r1 nit / C-r2 ND: «Куртка женская (Ladies jacket)» 300 beside the
 *     same name at 200 lost the 200 unnamed). What was left out is returned
 *     (`sameAsInvoice`), for the seller to see.
 *     Also «already carried»: a model line whose count AND weight equal
 *     exactly ONE Excel row's under another name (M1 c, `sameFigures`),
 *     unless the names contradict.
 *     With no model-read document (`aiGoods` null: no PDF and no header-less sheet
 *     beside the Excel), the Excel alone answers — and a typed line the model
 *     read too and the Excel does not carry is NAMED (round-4 integration
 *     S-a). Only one the model read: a typed reading alone is the regex's
 *     guess, and t22 says a guess does not overrule a reading.
 *  2. The model's goods, when there is no file — and when it READ and found
 *     none, only the lines the seller LABELLED as goods («Tovar: …»): an
 *     unlabelled «Salom, 12 kub 3500 kg» is not a product the model missed,
 *     and a regex must not overrule a reading that said «no goods» (round-1
 *     review, t22).
 *  3. Every typed line, when there was no reading at all (no key, budget,
 *     an outage) — before 2026-10-21 that left «Tovarlar: —» over a typed
 *     name.
 */
export function pickGoods(input: {
  invoice: GoodsList;
  aiGoods: IntakeState['aiGoods'];
  /** The model's goods — null when the model did not read. */
  model: GoodsList | null;
  typed: GoodsList;
  typedLabelled: GoodsList;
  /**
   * The model was shown PHOTOS (docs/IKKI-ESHIK.md §1.2.2): beside an Excel a
   * line it read off one is named, never added (review PF-SPEC-3 / PF-ADV-10
   * — a product the seller photographed vanished in silence). Absent = none.
   */
  modelSawImages?: boolean;
  /**
   * The model read material beside the Excel that can hold OTHER goods
   * (docs/FAYL-OQISH.md §4.6, narrowed by sheets-08): a workbook's sheet with
   * no header mapped, or typed text. Only then is a model line the Excel does
   * not carry named on the null path — a lone Excel's model can only restate
   * the Excel's own rows, and a translation of each («Куртка женская» 300
   * beside «Ladies jacket» 300) read as «AI found another good». Absent =
   * none.
   */
  otherMaterial?: boolean;
}): PickedGoods {
  if (input.invoice.length > 0) {
    const invoice = input.invoice.map((row) => ({ row, names: goodsNameKeys(row.name) }));
    // …or, on the add path, a model line whose count AND weight equal exactly
    // ONE Excel row's under another name (docs/IKKI-ESHIK.md §1.2.2, M1 c):
    // the model reads a Chinese PDF's «女士夹克» as «Куртка женская», and only
    // the figures say it is the Excel's «Ladies jacket».
    const carried = (g: GoodsList[number], names: NameKeys) =>
      invoice.some((inv) => sameLine(inv.row, inv.names, g, names)) ||
      (input.aiGoods === 'add' && invoice.filter((inv) => sameFigures(inv.row, g)).length === 1);
    if (input.aiGoods !== 'add') {
      if (input.aiGoods !== null || !input.model?.length) return { goods: input.invoice, sameAsInvoice: [] };
      const read = input.model.map((g) => goodsNameKeys(g.name));
      const named = new Set<string>();
      const sameAsInvoice: LeftOutLine[] = [];
      for (const t of input.typed) {
        const names = goodsNameKeys(t.name);
        if (!names.whole || named.has(names.whole) || carried(t, names)) continue;
        if (!read.some((m) => m.whole === names.whole || namesMeet(m, names))) continue;
        named.add(names.whole);
        sameAsInvoice.push({ ...t, why: 'typed' });
      }
      // …and a model line read off a PHOTO the Excel does not carry — by name,
      // or by a count and a weight equal to exactly one row's (a label read
      // in another script) — is named the same way: «Rasmda/yozuvda Excel’da
      // yo‘q tovar», never added (M3: a photo of the Excel's own goods would
      // count them twice). One name once.
      if (input.modelSawImages) {
        const typedNames = sameAsInvoice.map((t) => goodsNameKeys(t.name));
        for (const g of input.model) {
          const names = goodsNameKeys(g.name);
          if (!names.whole || named.has(names.whole) || carried(g, names)) continue;
          if (invoice.filter((inv) => sameFigures(inv.row, g)).length === 1) continue;
          if (typedNames.some((t) => namesMeet(t, names))) continue;
          named.add(names.whole);
          sameAsInvoice.push({ ...g, why: 'typed' });
        }
      } else if (input.otherMaterial) {
        // …and a model line read off a header-less sheet or the typed text,
        // which the Excel does not carry, is named the same way (§4.6) —
        // unless it is a row of the Excel restated: its count and weight, or
        // an equal count under names that do not contradict (a translation).
        // ONE row answers ONE line (review sheets-break-file-naming-length):
        // the rows the model repeated by name first, then — in a list as long
        // as the Excel's — the line at a place against the row at that place,
        // then any row not yet answered. «Exactly one row with that count»
        // named every translation of an invoice whose 300 came three times,
        // and «a list as long as the Excel's» passed every line of one —
        // another factory's two goods beside a two-row invoice went unsaid.
        const lines = input.model.map((g) => ({ g, names: goodsNameKeys(g.name) }));
        const claimed = new Set<number>();
        const claim = (at: number) => (at >= 0 && !claimed.has(at) ? (claimed.add(at), true) : false);
        const restates = (row: GoodsList[number], g: GoodsList[number]) => {
          const q = figureOf(g, 'quantity');
          return sameFigures(row, g) || (q !== null && figureOf(row, 'quantity') === q && !namesContradict(row.name, g.name));
        };
        const done = lines.map(({ g, names }) => {
          if (!names.whole || named.has(names.whole) || !carried(g, names)) return false;
          claim(invoice.findIndex((inv, k) => !claimed.has(k) && sameLine(inv.row, inv.names, g, names)));
          return true;
        });
        if (lines.length === invoice.length) {
          lines.forEach(({ g }, i) => {
            if (!done[i] && !claimed.has(i) && restates(invoice[i]!.row, g)) done[i] = claim(i);
          });
        }
        const typedNames = sameAsInvoice.map((t) => goodsNameKeys(t.name));
        lines.forEach(({ g, names }, i) => {
          if (done[i] || !names.whole || named.has(names.whole)) return;
          if (claim(invoice.findIndex((inv, k) => !claimed.has(k) && restates(inv.row, g)))) return;
          if (typedNames.some((t) => namesMeet(t, names))) return;
          named.add(names.whole);
          sameAsInvoice.push({ ...g, why: 'file' });
        });
      }
      return { goods: input.invoice, sameAsInvoice };
    }
    const extra = input.model ?? input.typed;
    // The add path is for what a MODEL-READ document holds (docs/IKKI-ESHIK.md
    // §1.2.2). When the model did not read (no key, the day's budget, a
    // timeout), nothing was model-read: the typed lines beside the Excel keep
    // today's rule — the Excel answers and a line it does not carry is NAMED,
    // never appended. Since the bot sets 'add' by itself, an outage otherwise
    // turned a typed restatement under another name into a second product
    // (as-built review FILES-3).
    const typedOnly = input.model === null;
    const addedWholes = new Set<string>();
    const leftOut = new Set<string>();
    const added: GoodsList = [];
    const sameAsInvoice: LeftOutLine[] = [];
    for (const g of extra) {
      const names = goodsNameKeys(g.name);
      if (!names.whole) continue;
      if (carried(g, names)) {
        // One reading is named once; two readings of one name with different
        // figures are both said.
        const reading = `${names.whole}|${LINE_FIGURES.map((f) => figureOf(g, f.field)).join('|')}`;
        if (leftOut.has(reading)) continue;
        leftOut.add(reading);
        sameAsInvoice.push({ ...g, why: 'same' });
        continue;
      }
      if (addedWholes.has(names.whole)) continue;
      addedWholes.add(names.whole);
      if (typedOnly) sameAsInvoice.push({ ...g, why: 'typed' });
      else added.push(g);
    }
    return { goods: [...input.invoice, ...added], sameAsInvoice };
  }
  if (input.model === null) return { goods: input.typed, sameAsInvoice: [] };
  return { goods: input.model.length > 0 ? input.model : input.typedLabelled, sameAsInvoice: [] };
}

/** Three names, each cut at 30, and a count of the rest — the whole sentence fits the summary's cut. */
function namedLines(lines: readonly { name: string }[]): string {
  const names = lines.slice(0, 3).map((g) => `«${g.name.length > 30 ? `${g.name.slice(0, 29)}…` : g.name}»`);
  const more = lines.length > 3 ? ` va yana ${lines.length - 3} ta` : '';
  return `${names.join(', ')}${more}`;
}

/**
 * The seller's word for the model's lines `pickGoods` left out as the Excel's
 * own (round-3 review, R3-C1): one line, printed on its own above the AI notes
 * (`IntakeState.notes`) and kept on the card's lenta. Null = none were left
 * out. A line `pickGoods` marked `typed` is not this sentence's
 * (`typedLeftOutNote`).
 */
export function sameAsInvoiceNote(lines: readonly (GoodsList[number] & { why?: LeftOutLine['why'] })[]): string | null {
  const same = lines.filter((g) => g.why !== 'typed' && g.why !== 'file');
  if (same.length === 0) return null;
  // No ⚠️ (docs/IKKI-ESHIK.md §1.2.4): taking the same goods once is the
  // designed outcome now, not a doubt the seller is asked about.
  return `📄 ${same.length} ta qator Excel’dagi bilan bir xil — bir marta olindi: ${namedLines(same)}.`;
}

/**
 * What the model's documents added beside an Excel list, on the add path
 * (docs/IKKI-ESHIK.md §1.2.4): how many new goods, and how many it read that
 * the Excel already had. «AI o‘qigan fayllar», never «PDF»: the model-read
 * file may be a photo or a header-less sheet. Null = the model did not read,
 * or read no goods. Pure.
 */
export function modelAddedNote(added: number, same: number): string | null {
  if (added > 0) {
    return `🤖 AI o‘qigan fayllardan ${added} ta yangi tovar qo‘shildi${same > 0 ? ` (${same} tasi Excel’da bor edi)` : ''}.`;
  }
  return same > 0 ? '🤖 AI o‘qigan fayllardagi tovarlar Excel’da bor.' : null;
}

/**
 * The seller's word for the typed lines left out because the Excel answers
 * for the goods (round-4 integration S-a) — they are NOT the Excel's, so
 * «bir xil» would be false of them. Null = none.
 */
export function typedLeftOutNote(lines: readonly LeftOutLine[]): string | null {
  const typed = lines.filter((g) => g.why === 'typed');
  if (typed.length === 0) return null;
  // Named, never added (docs/IKKI-ESHIK.md §1.2.2, M3): beside an Excel the
  // photos and the typed text keep today's rule — the Excel answers.
  return `Rasmda/yozuvda Excel’da yo‘q tovar: ${namedLines(typed)} — VED tekshiradi`;
}

/**
 * The seller's word for the model's lines read off material beside the Excel
 * that the Excel does not carry (docs/FAYL-OQISH.md §4.6) — named, never
 * added: the model read a header-less sheet or the typed text, and nothing
 * says the line is not the Excel's own under a word it does not share. Null =
 * none.
 */
export function fileLeftOutNote(lines: readonly LeftOutLine[]): string | null {
  const found = lines.filter((g) => g.why === 'file');
  if (found.length === 0) return null;
  return `AI fayldan yana ${namedLines(found)} ni topdi — ro‘yxatga qo‘shilmadi, VED ko‘radi`;
}

/**
 * The seller's word for the photographs and PDFs the reading could not load
 * back from storage (docs/SAKKIZ-R3.md K5, §2.6's words). Since K the
 * collection keeps attachment ids and the bytes are read back at «Bo‘ldi»; a
 * storage blip used to leave the model reading text alone under a prompt that
 * had promised it the photos, with nothing on the screen to say so. Null =
 * every file was read.
 */
export function filesMissingNote(missing: number, retry = false): string | null {
  if (missing <= 0) return null;
  // Where the table draws «🔄» for it (the AI door's first or seeded
  // collection, docs/FAYL-OQISH.md §2.5) the note IS the 🔄 sentence: a re-read
  // loads the files again, a re-send doubles them for the model (pdfimg-3 b).
  return retry
    ? `⚠️ ${missing} ta fayl saqlangan joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.`
    : `⚠️ ${missing} ta fayl o‘qilmadi — saqlangan joydan olib bo‘lmadi. Kerak bo‘lsa qayta yuboring.`;
}

/** At most this many photographs reach the model (his 1.4 b: twelve). */
export const MAX_INTAKE_IMAGES = 12;

/** At most this many PDFs, and this many bytes of them, reach the model. */
export const MAX_INTAKE_PDFS = 3;
export const MAX_INTAKE_PDF_BYTES = 12 * 1024 * 1024;

/**
 * What a file the seller forwarded IS, by its bytes (#284's rule — never the
 * name alone), so each kind reaches the reader that can read it.
 *
 * `image` covers a photo sent AS A FILE — the sharpest copy a seller has
 * (WeChat originals, a scan from the office PC) — which used to be stored and
 * shown to nobody (the diagnosis' cause 2). An ISO-media file (`ftyp`) may be
 * HEIC, which this server's image library cannot decode: the caller tries it
 * and says so in words when it fails. `sheet` = let the spreadsheet reader
 * decide (XLSX, Excel 97, an HTML or XML table, a CSV).
 */
export type IntakeFileKind = 'image' | 'isomedia' | 'video' | 'archive' | 'pdf' | 'docx' | 'sheet';

/** The ISO-media brands of a still picture: HEIC (tried, often refused) and AVIF. */
const PICTURE_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)$/;

export function intakeFileKind(
  body: Buffer,
  isPhoto: boolean,
  fileName: string,
  mime: string | null,
): IntakeFileKind {
  if (isPhoto) return 'image';
  const ascii = (from: number, to: number) => body.subarray(from, to).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image';
  if (body[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image';
  if (ascii(0, 4) === 'GIF8') return 'image';
  if (ascii(0, 4) === 'II*\u0000' || ascii(0, 4) === 'MM\u0000*') return 'image';
  // ISO media is a HEIC photo OR a phone video (mp4, mov): the brand says.
  if (ascii(4, 8) === 'ftyp') return PICTURE_BRANDS.test(ascii(8, 12)) ? 'isomedia' : 'video';
  if (/\.docx?$/i.test(fileName) || /wordprocessingml|msword/i.test(mime ?? '')) return 'docx';
  // An archive is a zip like an xlsx — named, so it is not «a broken Excel».
  if (/\.(zip|rar|7z)$/i.test(fileName) || /zip|rar|7z-compressed/i.test(mime ?? '')) return 'archive';
  return 'sheet';
}

/**
 * Which bot door this COLLECTION is (docs/IKKI-ESHIK.md §0.3): a first
 * collection's by its own flag; an add collection's by its request's
 * (`AmendBase.door`); a seeded one's by its source's (`seedDoor`, written at
 * the open). Null = a request from before the doors, or a collection
 * hydrated from before them — TODAY's table and words (§0.2). Pure.
 *
 * Here, beside `IntakeState`, so the READING asks it too: the raw `ai` flag is
 * true on every add collection of a NULL request (`collectionAiOf(null,
 * true)`), and a reading that coded rows by the flag put the model's guess on
 * a legacy table that does not mark it «(AI taklifi)» — and asked the law
 * unit of the guess (as-built review DOORS-1).
 */
export function collectionDoor(
  state: Pick<IntakeState, 'ai' | 'amend' | 'seed' | 'seedDoor'>,
): 'plain' | 'ai' | null {
  if (state.amend) return state.amend.door ?? null;
  if (state.seed !== null) return state.seedDoor ?? null;
  return state.ai ? 'ai' : 'plain';
}

// The store moved to calc-store.ts (docs/SAKKIZ-R3.md K3); these four keep
// every importer's import.
export { activeIntake, endIntake, startIntake, updateIntake } from './calc-store';

/** No bytes to read — a collection of text alone, or a caller that loads none. */
const NO_FILES: IntakeFiles = { images: [], pdfs: [], missing: 0 };

/**
 * Read the collected material with the model, then keep whatever the person
 * typed for anything it could not find.
 *
 * The manual layer is not a fallback for a broken key — it is the truth
 * beside the model's reading: a staff member who typed «5 kub» meant it,
 * and a model that missed it must not erase it.
 *
 * The bytes the model reads come from storage (`files`, `loadIntakeFiles`):
 * the collection keeps attachment ids, never a Buffer (docs/SAKKIZ-R3.md
 * K4/K5). `answered` is what this reading cost: the reading job bills it
 * the moment the model answered (docs/SAKKIZ-R3.md §7.2.10). A leash
 * (`timeoutMs`) of nothing is no call at all — the job's wall clock had no
 * room left — and reads as the «timeout» failure, in words.
 */
export async function analyzeCollected(
  state: IntakeState,
  files: IntakeFiles = NO_FILES,
  opts: { timeoutMs?: number } = {},
): Promise<IntakeState & { answered: import('../../wms/calc/intake-ai').AnsweredUsage[] }> {
  const { analyzeIntake } = await import('../../wms/calc/intake-ai');
  const { parseManualFacts, readGoodsLines, totalWeightFrom } = await import('../../wms/calc/intake-manual');
  const text = state.material.join('\n');
  const invoice = state.invoiceGoods ?? [];
  // Beside goods rows already held — an Excel, a packing list's totals, a
  // request's stored lines — a typed line's figure is that line's, never the
  // shipment's (`goodsBeside`, as-built review CHAT-3 / CRITIC-2-NEW): «3: 150
  // kg», «Sumka 80 kg», «Shapka 50 dona 20 kg» outranked the packing list's
  // brutto (§1.2.5) and landed as the shipment's weight under a ✅.
  const goodsBeside = invoice.length > 0 || Boolean(state.fileTotals) || state.amend !== null || state.seed !== null;
  // The section decides whether a NETTO figure may stand for the total
  // (review PF-1): never where the bot asks the brutto.
  const manual = parseManualFacts(text, state.section, { goodsBeside });
  // The add door's kept rows (docs/SAKKIZ-R3.md §9.4): a stored request's
  // (`amend`), or a returned one carried into a new collection (`seed`).
  const kept: readonly GoodsList[number][] | null = state.amend?.items ?? state.seed ?? null;
  // The model codes the Excel's rows on the AI door (docs/IKKI-ESHIK.md
  // §3.1) — an add or seeded collection's own Excel rows too (review
  // PF-SPEC-6): they are NEW lines beside the request's rows, never the
  // request's own (those are shown as `requestGoods` and never coded here).
  // The DOOR decides, never the flag: an add or seeded collection on a NULL
  // request is today's, which never asked the model for codes (§0.2,
  // as-built review DOORS-1).
  const codeKnown = collectionDoor(state) === 'ai' && invoice.length > 0;

  // The day's budget gates the READING too — it is the most expensive call
  // on this path (Opus, with photographs). Over the cap the manual parser
  // answers, which is exactly what a keyless server has always had, and the
  // summary says so rather than looking like a model that found nothing.
  //
  // This collection's own earlier readings are IN the ledger: the reading job
  // bills each the moment the model answered (§7.2.10), so the ledger alone
  // counts them — subtracting them here as well counted each one twice.
  const { aiCalcBudgetLeft } = await import('../../wms/calc/ai-cost');
  const budgetLeft = await aiCalcBudgetLeft().catch(() => Number.POSITIVE_INFINITY);
  type Outcome = Awaited<ReturnType<typeof analyzeIntake>>;
  // A packing-shaped goods sheet keeps its own rows as text (`GoodsFileMeta.
  // text`): beside the numbered list they let the model code a row by its
  // specs, under the totals heading (docs/FAYL-OQISH.md §3.7, sheets-04 (3)).
  // Read here, never stored in `invoiceTexts` — and not when a branch already
  // put the very text there.
  const goodsFile = state.goodsFiles?.[0] ?? null;
  const goodsSheetText =
    codeKnown && goodsFile?.text && !state.invoiceTexts.some((t) => t.text === goodsFile.text)
      ? { text: goodsFile.text, cut: goodsFile.textCut ?? false, cellsCut: goodsFile.textCellsCut ?? false }
      : null;
  const read: Outcome =
    opts.timeoutMs !== undefined && opts.timeoutMs <= 0
      ? { ok: false, failure: 'timeout' }
      : budgetLeft <= 0
      ? { ok: false, failure: 'budget' }
      : await analyzeIntake({
          section: state.section,
          text,
          fileCount: state.fileCount,
          images: files.images,
          pdf: files.pdfs[0] ?? null,
          morePdfs: files.pdfs.slice(1),
          // The separate files are goods material; a mapped workbook's other
          // sheets are TOTALS only, under their own heading — in one block
          // with the files, an «add» answer had the model re-list the
          // workbook's own packing list (round-2 review, C2/C6). One budget
          // over both, cut on a line and said per text — the reader's own
          // cut included (round-1 a17, round-2 C1).
          sheets: state.sheetTexts,
          contextSheets: state.invoiceTexts,
          // Every name: `analyzeIntake` shows what fits its character budget
          // and counts the rest. On the AI door they are ALWAYS shown, numbered,
          // and the model codes them by number (docs/IKKI-ESHIK.md §3.1); the
          // goods it lists stay «only new goods».
          knownGoods: state.aiGoods === 'add' || codeKnown ? invoice.map((g) => g.name) : undefined,
          // A row with a code of its own is listed and never asked (PF-ADV-13).
          ...(codeKnown ? { codeKnown: true, knownCoded: invoice.map((g) => Boolean(g.tnvedCode?.trim())) } : {}),
          // …and the rows already on the request, so the model lists only NEW goods.
          ...(kept ? { requestGoods: kept.map((g) => g.name) } : {}),
          ...(goodsSheetText ? { goodsSheetText } : {}),
          // A cut keeps the goods it completed, and the collection carries
          // the cut (`aiCut`, docs/FAYL-OQISH.md §3.3): the AI door draws no
          // «✅ Tasdiqlash» over a reading that did not finish.
          salvage: true,
          // Absent: the reader's own leash (`INTAKE_TIMEOUT_MS`).
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        }).catch((err: unknown): Outcome => {
          logger.warn({ err }, 'intake analyze failed');
          return { ok: false, failure: 'network' };
        });
  // A stored file that did not load is a storage blip, which a re-read heals
  // (docs/FAYL-OQISH.md §2.5, pdfimg-3) — never «nothing to read» under a
  // prompt that said «📎 2 ta fayl qabul qilindi».
  const outcome: Outcome =
    !read.ok && read.failure === 'nothing_to_read' && files.missing > 0 ? { ...read, failure: 'files_missing' } : read;
  const ai = outcome.ok ? outcome : null;
  // What this reading left unread, as state (docs/FAYL-OQISH.md §10): the
  // table, the save branch, the landing and the sweep ask `aiReadingWhole`
  // of these, never of this job's locals. Written on EVERY reading, so a whole
  // re-read clears what a cut one left.
  const { fitSheetRows } = await import('../../wms/calc/intake-ai');
  const { SHEET_TEXT_BUDGET } = await import('../../wms/deals/goods-file');
  const sheetFit = fitSheetRows([...state.sheetTexts, ...state.invoiceTexts].map((t) => t.text.trim()), SHEET_TEXT_BUDGET);
  const stillPdfs = new Set(state.pdfs.map((p) => p.attachmentId));
  const unread: Pick<IntakeState, 'aiCut' | 'aiInputCut' | 'filesMissing' | 'unreadPdfs'> = {
    aiCut: outcome.ok && outcome.cut ? outcome.cut : null,
    // A goods sheet the model was not shown whole — the reader stopped
    // before its end, or the shared budget kept fewer rows than it has
    // (§1.1 f). The workbooks' other sheets are read for the totals only.
    aiInputCut: state.sheetTexts.some(
      (t, i) => t.text.trim() !== '' && (t.cut || (sheetFit.kept[i] ?? 0) < (sheetFit.total[i] ?? 0)),
    ),
    filesMissing: files.missing,
    // Refused once, skipped by every later reading (`loadIntakeFiles`) and
    // so still unread: the earlier ones stand beside this reading's own.
    unreadPdfs: [...new Set([...(state.unreadPdfs ?? []), ...(outcome.unreadPdfs ?? [])])].filter((id) => stillPdfs.has(id)),
  };

  // Typed facts win over read ones: the person is looking at the material.
  // A total the text writes TWO ways («1,200 kg») is asked, and the model —
  // which read the same ambiguous text — does not get to answer it either.
  const asked = (field: 'weightKg' | 'volumeM3') => manual.ambiguous.some((a) => a.field === field);
  // The codes the seller's own text states (as-built review FILES-6), each
  // with the goods line it was typed on (fix review FR-REGR-3): a model line
  // carrying one of them on HIS line carries the SELLER's code, read back —
  // not a proposal. The model copying the jacket's code onto the trousers is
  // a proposal for the trousers. Only the code nobody wrote for that line is
  // the model's (§3.1's step 4).
  const { codeIn } = await import('../../wms/calc/units');
  const typedCodes = typedCodeOwners(
    text.split(/\r?\n/).flatMap((l) => {
      const found = codeIn(l)?.code;
      return found ? [{ code: found, line: l }] : [];
    }),
    manual.goods ?? [],
  );
  const modelGoods = ai?.facts.goods ?? [];
  // Three sources, in the order of how EXACT they are (`pickGoods`).
  const picked = pickGoods({
    invoice,
    aiGoods: state.aiGoods,
    // A code on a model-read line is the model's PROPOSAL, never the row's own
    // (§3.1): the coding asks the memory and the book first — unless the
    // seller's own text states it.
    model: ai ? modelGoods.map((g) => modelCoded(g, typedCodes, modelGoods)) : null,
    typed: manual.goods ?? [],
    typedLabelled: readGoodsLines(text, { labelledOnly: true }),
    modelSawImages: files.images.length > 0,
    otherMaterial: text.trim() !== '' || state.invoiceTexts.some((t) => t.unmapped),
  });
  // The lines left out because the Excel answers are SAID, in the bot's own
  // notes, so the summary shows them beside the model's three and the card
  // keeps them (R3-C1; round 4, C-r1 nit and integration S-a).
  // …and the files the reading could not load back from storage (K5), said
  // rather than read past in silence.
  // …and, on the add path, what the model's documents added (§1.2.4): a
  // READING-time note, kept in `notes` (the receipt-time ones are `fileNotes`).
  const modelAdded =
    state.aiGoods === 'add' && ai && invoice.length > 0 && (ai.facts.goods ?? []).length > 0
      ? modelAddedNote(
          picked.goods.length - invoice.length,
          picked.sameAsInvoice.filter((g) => g.why === 'same').length,
        )
      : null;
  const notes = [
    modelAdded,
    sameAsInvoiceNote(picked.sameAsInvoice),
    typedLeftOutNote(picked.sameAsInvoice),
    fileLeftOutNote(picked.sameAsInvoice),
    // One sentence per fact (§2.5, critic-said-twice): a reading whose files
    // ALL failed to load says it as its failure (`files_missing`); beside
    // other material read, the note says it — with the «🔄» the AI door's
    // first or seeded table draws for it (§1.2), elsewhere today's words.
    outcome.ok || outcome.failure !== 'files_missing'
      ? filesMissingNote(files.missing, collectionDoor(state) === 'ai' && !state.amend)
      : null,
  ].filter((n): n is string => n !== null);
  // The model's codes for the Excel's rows, each by the index it was shown
  // with and re-checked against the row there (`withKnownCodes`) — under the
  // seller's answers, which go on top next.
  const coded = codeKnown && ai?.knownCodes ? withKnownCodes(picked.goods, invoice.map((g) => g.name), ai.knownCodes) : picked.goods;
  if (kept) {
    const { conflictOf } = await import('../../wms/calc/amend');
    const { volumeIsLinesSum } = await import('../../wms/calc/line-totals');
    return {
      ...addReading(
        state,
        // A coded line that IS a stored row is that row and carries nothing
        // onto it (`addReading` keeps the stored row); only the fresh ones keep
        // the model's proposal.
        { kept, picked: { ...picked, goods: coded }, manual, ai, outcome, notes, text },
        { conflictOf, volumeIsLinesSum, parseManualFacts, totalWeightFrom },
      ),
      ...unread,
    };
  }
  // A route the seller answered in the table goes above everything a reading
  // finds — unless the material AFTER the answer names another city, read
  // from that SLICE alone (`readRoute` has no offset form), so the very city
  // text the answer corrected cannot doubt it (docs/SAKKIZ-R3.md K15).
  const routeAnswer = state.routeAnswer ?? null;
  const routeSince =
    routeAnswer && state.material.length > routeAnswer.at.material
      ? parseManualFacts(state.material.slice(routeAnswer.at.material).join('\n'), state.section)
      : null;
  const route = answeredRoute(routeAnswer, routeSince);
  // The seller's per-line answers go back on top (P1.3) — a re-read after «➕
  // Yana ma'lumot» must not erase them — and where each landed is what the
  // collection keeps (`placeByName`'s write-back, regression-7).
  const placed = placeByName(coded, state.lineAnswers);
  // The totals in their rank (docs/IKKI-ESHIK.md §1.2.5): what the seller
  // typed, then what a packing list GAVE (`fileTotals` — its gross Σ, or a
  // net Σ the freight sections refuse as a brutto, `totalWeightFrom`), then
  // the model's reading; the table answer goes on top of all three below. A
  // figure the packing list gave is therefore never asked again.
  const fileTotals = state.fileTotals ?? loneFileTotals(state);
  // A figure two packing lists disagreed on is the VED's (review PF-ADV-8):
  // the model read both lists and its figure — their sum, as often as not —
  // must not land where the note promised «ikkalasi ham olinmadi».
  const clashed = (field: 'weightKg' | 'volumeM3') => fileTotals?.clash?.includes(field) ?? false;
  const fromModel = totalWeightFrom(state.section, manual, ai?.facts ?? null, asked('weightKg') || clashed('weightKg'));
  const fromFile =
    fileTotals && fileTotals.weightKg !== null
      ? totalWeightFrom(
          state.section,
          manual,
          { weightKg: fileTotals.weightKg, ...(fileTotals.weightNetto ? { weightNetto: true } : {}) },
          asked('weightKg'),
        )
      : null;
  const modelVolume = asked('volumeM3') || clashed('volumeM3') ? null : (ai?.facts.volumeM3 ?? null);
  const fileVolume = asked('volumeM3') ? null : (fileTotals?.volumeM3 ?? null);
  const reading: IntakeState['facts'] = {
    fromCity: route.fromCity ?? manual.fromCity ?? ai?.facts.fromCity ?? state.route?.fromCity ?? null,
    toCity: route.toCity ?? manual.toCity ?? ai?.facts.toCity ?? state.route?.toCity ?? null,
    ...(fromFile && fromFile.weightKg != null ? fromFile : fromModel),
    volumeM3: manual.volumeM3 ?? fileVolume ?? modelVolume,
    // …nor the lines' Σ (review P3-R2): the seller stated a cube, only not
    // which one — the totals question asks it, and the INSERT sums nothing.
    ...(asked('volumeM3') ? { volumeAmbiguous: true } : {}),
    goods: placed.goods,
  };
  // The seller's answer to the totals question goes back on top as well
  // (judge concurrency-4): «3500» typed after the brutto question is no
  // material, and only this keeps it across a re-read — unless what came
  // AFTER the answer states the figure otherwise (review CONC-2), which is
  // asked rather than outranked. The typed part after the answer is read on
  // its own: an old «1,200 kg» the answer settled must not hide a new figure.
  const at = state.totalsAnswer.at;
  const since =
    state.material.length > at.material
      ? parseManualFacts(text, state.section, {
          from: state.material.slice(0, at.material).reduce((n, m) => n + m.length + 1, 0),
          goodsBeside,
        })
      : { weightKg: null, volumeM3: null, ambiguous: [] };
  // A packing list's figure doubts the answer only when it came AFTER it
  // (§1.2.5, the `at` mark): one the seller had in front of him when he
  // answered is the very figure the answer corrected.
  const fileAfterAnswer = fileTotals !== null && fileTotals.at.files > at.files;
  const doubts = totalsDoubts(state.totalsAnswer, {
    now: { material: state.material.length, files: state.fileCount },
    since,
    reading: fileAfterAnswer
      ? reading
      : { weightKg: fromModel.weightKg ?? null, volumeM3: manual.volumeM3 ?? modelVolume },
  });
  const facts = factsWithAnswer(state.totalsAnswer, doubts, reading);
  return {
    ...state,
    facts,
    steps: ai?.steps ?? [],
    notes,
    aiUsed: Boolean(ai),
    aiFailure: outcome.ok ? null : outcome.failure,
    lineAnswers: placed.entries,
    // What the seller has answered is not asked again (review P3-3) — unless
    // later material doubts the answer, and then THAT is what is asked.
    ambiguousTotals: [...unansweredAmbiguity(manual.ambiguous, state.totalsAnswer), ...doubts],
    stage: 'review',
    // Every reading the model answered — a paid read that failed (cut,
    // refused, unreadable) included (r1-fix typed #21), each re-read its own
    // (2.9 c) — for the job's bill.
    answered: outcome.answered ?? [],
    ...unread,
  };
}

/**
 * The totals of a collection's ONE goods file, read at the reading (as-built
 * review FILES-4): a packing list sent alone states its brutto and its cube on
 * every row, and a lone first file writes no `fileTotals` at receipt — that
 * waits for an invoice, which hands them over (§1.2.2). With no second file
 * the figure was computed and thrown away, and the seller who sent FEWER
 * files was asked the brutto his file states (INT-10, his 4a). So, on a first
 * collection with no `fileTotals`, a lone, uncapped goods file holding every
 * row gives what the hand-over would: a packing list its `packingTotals` (a
 * net Σ flagged netto, which the freight sections refuse as a brutto); an
 * invoice its gross Σ alone, when it has a gross column (its lines' m³ are
 * the INSERT's to sum, as always). Read here and never
 * stored, so a later file — another factory's, or the shipment's packing list
 * — decides as it always has. Null = nothing to give. Pure.
 */
export function loneFileTotals(
  state: Pick<IntakeState, 'fileTotals' | 'goodsFiles' | 'invoiceGoods' | 'amend' | 'seed'>,
): IntakeState['fileTotals'] {
  if (state.fileTotals || state.amend || state.seed !== null) return null;
  const files = state.goodsFiles ?? [];
  const rows = state.invoiceGoods ?? [];
  const only = files.length === 1 ? files[0]! : null;
  if (!only || only.capped || rows.length === 0 || only.rows !== rows.length) return null;
  const totals =
    only.shape === 'packing'
      ? packingTotals(only, rows)
      : { weightKg: only.grossKg, weightNetto: false, volumeM3: null };
  if (totals.weightKg === null && totals.volumeM3 === null) return null;
  return {
    weightKg: totals.weightKg,
    volumeM3: totals.volumeM3,
    weightNetto: totals.weightKg !== null && totals.weightNetto,
    label: only.label,
    // The file's own receipt mark: an answer given with it in front of the
    // seller is not doubted by it (PF-ADV-9). Unknown = before everything.
    at: only.at ?? { material: 0, files: 0 },
  };
}

/**
 * Who typed a code: a goods line's name and figures, or null — a code typed on
 * a line naming no goods. `countShared`: another typed line has the same count,
 * so a count alone cannot tell which line a copied code belongs to.
 */
type CodeOwner = { names: NameKeys; quantity: number | null; weightKg: number | null; countShared: boolean } | null;

/**
 * The codes the seller's typed material states, by code (digits only), each
 * with the goods line it stands on (fix review FR-REGR-3): a typed goods line
 * carrying a code owns it; a code on a line no typed goods line is — «TNVED
 * 6201930000» under the list — is owned by nobody in particular (null). Pure.
 */
export function typedCodeOwners(
  lineCodes: readonly { code: string; line: string }[],
  typed: readonly GoodsList[number][],
): Map<string, CodeOwner[]> {
  const digits = (code: string) => code.replace(/\D/g, '');
  const out = new Map<string, CodeOwner[]>();
  const add = (code: string, owner: CodeOwner) => out.set(code, [...(out.get(code) ?? []), owner]);
  const owned = typed.flatMap((g) => {
    const code = g.tnvedCode?.trim();
    const quantity = g.quantity ?? null;
    const countShared = quantity !== null && typed.filter((t) => (t.quantity ?? null) === quantity).length > 1;
    return code
      ? [{ code: digits(code), key: goodsNameKey(g.name), owner: { names: goodsNameKeys(g.name), quantity, weightKg: g.weightKg ?? null, countShared } }]
      : [];
  });
  for (const o of owned) add(o.code, o.owner);
  for (const { code, line } of lineCodes) {
    const c = digits(code);
    const lineKey = goodsNameKey(line);
    if (!owned.some((o) => o.code === c && o.key !== '' && lineKey.includes(o.key))) add(c, null);
  }
  return out;
}

/**
 * A model-read line, its code marked as the model's proposal (§3.1) — unless
 * the seller's own typed material states that very code FOR THIS LINE
 * (`owners`): a typed goods line carrying it whose name meets this line's, or
 * whose count and weight are this line's; or a code typed on a line of its
 * own, when the model puts it on this one line alone. Then it is his, read
 * back, and stays on top of the memory and the book like any code a seller
 * typed (as-built review FILES-6). A code the seller wrote for the jacket and
 * the model copied onto the trousers is the trousers' proposal (fix review
 * FR-REGR-3). A code read off a document cannot be told from the model's
 * guess and stays a proposal (PF-ADV-16). Pure.
 */
function modelCoded(
  g: GoodsList[number],
  owners: ReadonlyMap<string, readonly CodeOwner[]>,
  read: readonly GoodsList[number][],
): GoodsList[number] {
  const code = g.tnvedCode?.trim();
  if (!code) return g;
  const digits = code.replace(/\D/g, '');
  const names = goodsNameKeys(g.name);
  const alone = () => read.filter((r) => r.tnvedCode?.replace(/\D/g, '') === digits).length === 1;
  const his = (owners.get(digits) ?? []).some((o) =>
    o === null
      ? alone()
      : o.names.whole === names.whole ||
        namesMeet(o.names, names) ||
        // The figures name the line when the names cannot (a translation):
        // count AND weight, or the count alone only when no other typed line
        // shares it — «Kurtka 6201930000 100 dona / Shim 100 dona» must not
        // hand the jacket's code to the trousers (check after the fixes' review).
        (o.quantity !== null &&
          o.quantity === (g.quantity ?? null) &&
          (o.weightKg !== null && g.weightKg != null ? o.weightKg === g.weightKg : !o.countShared)),
  );
  return his ? g : { ...g, tnvedSource: 'model' };
}

/**
 * The model's codes for the Excel's rows (`known_codes`, docs/IKKI-ESHIK.md
 * §3.1), put on the rows as the model's proposal. `names` is the list the
 * model was shown, in the order shown; each code names its row by INDEX into
 * it, and is re-checked against the row there — the `pickImportRows` idiom:
 * a row that is not there, is not the row that was shown, is a stored row
 * (the VED's), or already has a code of its own takes nothing. Pure.
 */
export function withKnownCodes(
  goods: GoodsList,
  names: readonly string[],
  codes: readonly KnownCode[],
): GoodsList {
  if (codes.length === 0) return goods;
  const out = [...goods];
  for (const { index, code } of codes) {
    const row = out[index];
    if (!row || row.itemId) continue;
    if (row.name.trim() !== (names[index] ?? '').trim()) continue;
    if (row.tnvedCode?.trim()) continue;
    out[index] = { ...row, tnvedCode: code, tnvedSource: 'model' };
  }
  return out;
}

/** A collected row as the one coding function reads it: a model's code is step 4, any other the row's own. */
function codingRowOf(g: GoodsList[number]): CodingRow {
  const model = g.tnvedSource === 'model';
  return {
    name: g.name,
    own: model ? null : (g.tnvedCode ?? null),
    ownSource: model ? null : (g.tnvedSource ?? null),
    model: model ? (g.tnvedCode ?? null) : null,
  };
}

/** The row with the code the coding chose, and where it came from. */
function withCoded(g: GoodsList[number], c: CodedRow): GoodsList[number] {
  if (!c.code || !c.source) return g;
  return { ...g, tnvedCode: c.code, tnvedSource: c.source };
}

/**
 * The reading codes the rows (docs/IKKI-ESHIK.md §3.1), by the ONE function
 * `openCalcRequest` asks before its INSERT (`row-coding.ts`): the row's own
 * code, the sealed memory, the exact-key book, the model's proposal — so the
 * table asks the law's unit of the code the card will carry. A stored row
 * (the add door's, `itemId`) is the VED's and is left as it is.
 *
 * Run by the reading job on the POOL, after the model and the bill and before
 * the table's laws are read. It never throws into the settle: past its own
 * budget, or on any error, the reading keeps the codes it already has — the
 * Excel's own and the model's — and says so in the log. Deterministic over
 * the dictionaries, so a retry codes identically.
 */
export async function codeCollectedGoods<S extends IntakeState>(
  state: S,
  /** `timeoutMs`: the reading job's `INTAKE_CODING_BUDGET_MS`, part of its pinned time sum. */
  opts: { timeoutMs: number; lookups?: CodingLookups },
): Promise<S> {
  const goods = state.facts.goods ?? [];
  const at = goods.flatMap((g, i) => (g.itemId ? [] : [i]));
  if (at.length === 0) return state;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { codeRows } = await import('../../wms/calc/row-coding');
    const asked = codeRows(at.map((i) => codingRowOf(goods[i]!)), opts.lookups);
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs);
    });
    const coded = await Promise.race([asked, late]);
    if (!coded) {
      logger.warn({ rows: at.length }, '[calc-intake] coding past its budget — the codes the reading has stand');
      return state;
    }
    const next = [...goods];
    at.forEach((i, k) => {
      next[i] = withCoded(goods[i]!, coded[k]!);
    });
    return { ...state, facts: { ...state.facts, goods: next } };
  } catch (err) {
    logger.warn({ err }, '[calc-intake] rows not coded — the codes the reading has stand');
    return state;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The add door's reading (docs/SAKKIZ-R3.md §9.4) — an add collection's, and a
 * returned request's seeded one. The rows already on the request are KEPT;
 * the reading only adds:
 *  - a line the reading finds that IS a kept row read again (`sameGoodsLine`:
 *    the same whole name, or a name it answers to with figures that agree) is
 *    that row, never a second one priced twice — and when it states a figure
 *    the stored row has otherwise or not at all, it is the row's CONFLICT
 *    (law-money-5): never written on its own — and since his 1a
 *    (docs/IKKI-ESHIK.md §1.1) never asked either: the stored figure stands,
 *    the file's goes on the card for the VED («faylda 200 dona, so‘rovda 300
 *    — VED hal qiladi»). A wide match whose figures disagree is no match:
 *    another factory's line, a NEW line;
 *  - totals and cities are NOT read from new material (§0.1(2)): a top-up's
 *    packing list may state its own totals or the whole truck's, and nobody
 *    can tell which. The stored ones stand, a table answer goes on top, and an
 *    answer is still judged against what the NEW material states (CONC-2).
 */
function addReading(
  state: IntakeState,
  r: {
    kept: readonly GoodsList[number][];
    picked: PickedGoods;
    manual: ReturnType<typeof import('../../wms/calc/intake-manual').parseManualFacts>;
    ai: { facts: import('../../wms/calc/intake').CalcFacts; steps: string[] } | null;
    outcome: { ok: boolean; failure?: import('../../wms/calc/intake').AiReadFailure; answered?: import('../../wms/calc/intake-ai').AnsweredUsage[] };
    notes: string[];
    text: string;
  },
  deps: AddReadingDeps,
): IntakeState & { answered: import('../../wms/calc/intake-ai').AnsweredUsage[] } {
  const { kept, picked, manual, ai, outcome, text } = r;
  const notes = [...r.notes];
  const fresh: GoodsList = [];
  const conflicts: IntakeState['conflicts'] = [];
  const restated: { name: string; figures: { read: number; unit: string }[] }[] = [];
  // Keyed once, as `pickGoods` keys its invoice (fix review DRILL-1):
  // `sameGoodsLine` keys BOTH names on every call, so a 500-line Excel over a
  // 1000-row request was a million keyings — 12 s of the one process.
  const keptKeyed = kept.map((k) => ({ row: k, names: goodsNameKeys(k.name) }));
  for (const read of picked.goods) {
    const readNames = goodsNameKeys(read.name);
    const match = keptKeyed.find((k) => sameLine(k.row, k.names, read, readNames))?.row;
    if (!match) {
      fresh.push(read);
      continue;
    }
    // Only a STORED row can carry a conflict (it needs the row's item id). A
    // seeded collection's row is a plain line, kept as `pickGoods` keeps an
    // invoice's — and, like `pickGoods`' left-out lines, a re-read that states
    // another figure is NAMED, never dropped in silence: a corrected «Sumka —
    // 500 dona» for a request the VED returned for its count must not land
    // as the very 300 it was returned for, unsaid.
    if (!state.amend || !match.itemId) {
      const differs = deps.conflictOf(match, read);
      if (differs.length > 0) restated.push({ name: match.name, figures: differs.map((c) => ({ read: c.read, unit: c.unit })) });
      continue;
    }
    for (const c of deps.conflictOf(match, read)) {
      if (conflicts.some((x) => x.itemId === match.itemId && x.field === c.field)) continue;
      const before = state.conflicts.find((x) => x.itemId === match.itemId && x.field === c.field);
      // A re-read REPLACES a conflict; an answer stands only while the read figure does.
      conflicts.push({
        itemId: match.itemId,
        seq: match.seq ?? 0,
        field: c.field,
        unit: c.unit,
        stored: c.stored,
        read: c.read,
        // Never asked (his 1a, docs/IKKI-ESHIK.md §1.1): the stored figure
        // stands and the file's goes to the VED — R3 interp 9's unanswered
        // default, written. An answer a hydrated collection already holds
        // stands only while the read figure does.
        choice: before && before.read === c.read ? before.choice : 'ved',
      });
    }
  }
  const amend = state.amend;
  const sum = amend ? deps.volumeIsLinesSum(amend.volumeM3, amend.items) : false;
  const stored = amend
    ? { fromCity: amend.fromCity, toCity: amend.toCity, weightKg: amend.weightKg, volumeM3: sum ? null : amend.volumeM3 }
    : {
        fromCity: state.facts.fromCity ?? null,
        toCity: state.facts.toCity ?? null,
        weightKg: state.facts.weightKg ?? null,
        volumeM3: state.facts.volumeM3 ?? null,
      };
  const routeAnswer = state.routeAnswer ?? null;
  const routeSince =
    routeAnswer && state.material.length > routeAnswer.at.material
      ? deps.parseManualFacts(state.material.slice(routeAnswer.at.material).join('\n'), state.section)
      : null;
  const route = answeredRoute(routeAnswer, routeSince);
  // A stored row's ✅ is the VED's word about its group, not a goods fact.
  const keptRows: GoodsList = kept.map((k) => {
    const row: GoodsList[number] & { confirmed?: boolean } = { ...k };
    delete row.confirmed;
    return row;
  });
  // The table's answers back on top by the ONE placement rule (§8.2.8,
  // §9.4): a stored row's answer finds its row by item id first, never by
  // position — and where each landed is what the collection keeps.
  const placed = placeByName([...keptRows, ...fresh], state.lineAnswers);
  const reading: IntakeState['facts'] = {
    fromCity: route.fromCity ?? stored.fromCity,
    toCity: route.toCity ?? stored.toCity,
    weightKg: stored.weightKg,
    volumeM3: stored.volumeM3,
    // A stored row's weight is its own — never one copied from the brutto.
    lineWeightsStated: true,
    ...(amend ? { totalsStored: !sum } : {}),
    goods: placed.goods,
  };
  // What the NEW material states, never the stored totals (they are no
  // statement made after the answer): only it can doubt a table answer.
  const said = deps.totalWeightFrom(state.section, manual, ai?.facts ?? null, false);
  const at = state.totalsAnswer.at;
  const since =
    state.material.length > at.material
      ? deps.parseManualFacts(text, state.section, {
          from: state.material.slice(0, at.material).reduce((n, m) => n + m.length + 1, 0),
          // The request's stored rows are a goods list: a typed line's figure is the line's.
          goodsBeside: true,
        })
      : { weightKg: null, volumeM3: null, ambiguous: [] };
  const doubts = totalsDoubts(state.totalsAnswer, {
    now: { material: state.material.length, files: state.fileCount },
    since,
    reading: { weightKg: said.weightKg ?? null, volumeM3: manual.volumeM3 ?? ai?.facts.volumeM3 ?? null },
  });
  const facts = factsWithAnswer(state.totalsAnswer, doubts, reading);
  const restatedNote = seedRestatedNote(restated);
  if (restatedNote) notes.unshift(restatedNote);
  return {
    ...state,
    facts,
    conflicts,
    steps: ai?.steps ?? [],
    notes,
    aiUsed: Boolean(ai),
    aiFailure: outcome.ok ? null : (outcome.failure ?? 'network'),
    lineAnswers: placed.entries,
    ambiguousTotals: doubts,
    stage: 'review',
    answered: outcome.answered ?? [],
  };
}

/** «40 juft», «12 m³» — a re-read figure in its own unit, for a sentence. */
const RESTATED_UNIT: Record<string, string> = { dona: 'dona', kg: 'kg', m3: 'm³', m2: 'm²', juft: 'juft', litr: 'litr', sm3: 'sm³' };

/**
 * The seller's word for the lines a SEEDED collection (a returned request's
 * re-send) read again with another figure than its row: kept as the row, and
 * NAMED with the figure read, for him to answer the row if it is the right
 * one. Null = none. Pure.
 */
export function seedRestatedNote(lines: readonly { name: string; figures: readonly { read: number; unit: string }[] }[]): string | null {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, 3).map((l) => {
    const name = l.name.length > 30 ? `${l.name.slice(0, 29)}…` : l.name;
    const figures = l.figures.map((f) => `${Number(f.read.toFixed(3))} ${RESTATED_UNIT[f.unit] ?? f.unit}`).join(', ');
    return `«${name}» (faylda ${figures})`;
  });
  const more = lines.length > 3 ? ` va yana ${lines.length - 3} ta` : '';
  return `⚠️ ${lines.length} ta qator so‘rovdagi bilan bir xil, lekin boshqa son bilan o‘qildi — so‘rovdagi qoldi: ${shown.join(', ')}${more}. Fayldagi to‘g‘ri bo‘lsa, shu qatorga javob yozing.`;
}

/** What the add reading needs of wms — handed in, platform never imports wms statically. */
interface AddReadingDeps {
  conflictOf: typeof import('../../wms/calc/amend').conflictOf;
  volumeIsLinesSum: typeof import('../../wms/calc/line-totals').volumeIsLinesSum;
  parseManualFacts: typeof import('../../wms/calc/intake-manual').parseManualFacts;
  totalWeightFrom: typeof import('../../wms/calc/intake-manual').totalWeightFrom;
}

/** Is this chat a member of staff who may use «Hisoblatish»? Everyone is
 * (owner's answer 3) — the only question is whether they are staff at all. */
export async function mayCollect(chatId: bigint): Promise<boolean> {
  return (await staffForChat(chatId)) !== null;
}
