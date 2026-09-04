import type { Readable } from 'node:stream';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { customsImportBatches, customsImportRows } from '../../platform/db/schema';
import { getStorage } from '../../platform/files/storage';
import { logger } from '../../platform/logger';
import {
  FIELD_LABELS,
  parseRow,
  priceDrift,
  readHeader,
  type ParsedImportRow,
  type SkipReason,
} from './import-parse';

/**
 * The quarterly customs dump, ingested (docs/VED-IMPORT-AI.md sub-round A).
 *
 * His file is ~500k declaration rows and the owner's own sentence about it
 * was «sistemamiz tez ishlashi kerak», so nothing here runs in a request:
 * the route stores the bytes and enqueues, and this module is what the
 * background worker calls. The parse is STREAMING — a Buffer of 80 MB plus
 * an in-memory workbook is the container's memory twice over.
 */

/** Rows per INSERT. Big enough that 500k rows is 500 statements, small
 * enough that one bad chunk is a small loss and the pool is never held. */
const CHUNK = 1_000;
/**
 * How often the parse says it is alive — on a WALL CLOCK, not every N rows.
 *
 * It used to be every 20,000 rows, and that is why two stuck imports were
 * indistinguishable from two slow ones: a file with fewer rows than one step
 * showed «0» from the first second to the last, and a file that died on row
 * three showed exactly the same. Ten seconds answers the only question the
 * person at the screen has — is it moving — for every file size there is.
 */
const HEARTBEAT_MS = 10_000;

/**
 * How long a batch may go quiet before the sweep calls it dead.
 *
 * Generous against the measurement rather than against a guess: 500,000 rows
 * parse in 83 seconds here and the beat is every ten, so a live import is
 * never more than seconds behind. Fifteen minutes is what a container
 * restart, a deploy or a full disk looks like.
 */
export const IMPORT_STALE_MS = 15 * 60_000;

export interface ImportOutcome {
  rowCount: number;
  skipped: number;
  skipReasons: Partial<Record<SkipReason, number>>;
  periodFrom: string | null;
  periodTo: string | null;
}

export class CustomsImportError extends Error {
  constructor(
    readonly reason: 'missing_columns' | 'no_rows' | 'unreadable' | 'in_use',
    readonly detail?: string,
  ) {
    super(reason);
  }
}

/** A sheet row as an array of cells — what both readers hand over. */
type RowCells = unknown[];

/**
 * Walk the stored file row by row.
 *
 * xlsx goes through exceljs's STREAM reader (the repo's other nine call
 * sites all build workbooks in memory, which is right for a 40-row report
 * and impossible here); csv is split by line, because the customs service
 * also exports that and the owner may send either.
 */
async function* streamRows(storageKey: string, fileName: string): AsyncGenerator<RowCells> {
  const storage = getStorage();
  const stream = await storage.getStream(storageKey);

  /**
   * A source that dies is a HANG, not an error — and that is the whole
   * reason «читается» could mean nothing.
   *
   * exceljs pipes this stream into unzipper, and node does NOT forward an
   * error across `pipe()`: the reader simply stops producing entries and the
   * parse waits for ever, with no row counter moving and nothing in the log.
   * Worse on the local driver, where `createReadStream` reports a missing
   * file asynchronously and nobody is listening: an unhandled 'error' on a
   * Readable is an uncaught exception, which takes the whole app process
   * down rather than one import.
   *
   * So the source's failure is raced against every row. Measured: reading a
   * key that does not exist used to hang until the test's own timeout and
   * escape as an uncaught exception; it now refuses, with the reason.
   */
  let sourceFailed!: (err: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    sourceFailed = reject;
  });
  // Marked handled up front — nobody awaits it until the first race, and an
  // early rejection would otherwise be an unhandled rejection warning.
  failed.catch(() => {});
  stream.on('error', (err: unknown) =>
    sourceFailed(err instanceof Error ? err : new Error(String(err))),
  );

  const inner = /\.csv$/i.test(fileName) ? csvRows(stream) : xlsxRows(stream);
  const it = inner[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await Promise.race([it.next(), failed]);
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // Destroy FIRST, and never AWAIT the generator's own close.
    //
    // Measured: closing the exceljs reader while it is parked on a stream
    // that will produce no more bytes never resolves, so awaiting it turned
    // the refusal back into the hang it was supposed to replace — the same
    // silence one layer down. Tearing the source down is what lets that
    // cleanup finish, and whether it ever does is no longer this parse's
    // business.
    stream.destroy();
    void Promise.resolve(it.return?.(undefined)).catch(() => {});
  }
}

/** The customs service exports csv too, and the owner may send either. */
async function* csvRows(stream: Readable): AsyncGenerator<RowCells> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += String(chunk);
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== '') yield splitCsvLine(line);
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer.trim() !== '') yield splitCsvLine(buffer.replace(/\r$/, ''));
}

/**
 * xlsx through exceljs's STREAM reader — the repo's other nine call sites
 * all build workbooks in memory, which is right for a 40-row report and
 * impossible here (500,000 rows measured at 774 MB even streaming).
 */
async function* xlsxRows(stream: Readable): AsyncGenerator<RowCells> {
  const ExcelJS = (await import('exceljs')).default;
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    entries: 'emit',
    sharedStrings: 'cache',
    worksheets: 'emit',
  });
  // NOT `break` after the first sheet — measured, and it leaked 57 MB.
  //
  // exceljs SPOOLS a worksheet to a temp file whenever the sheet entry
  // precedes `sharedStrings` in the zip, which is how Excel itself writes
  // one, and it deletes that file only after the sheet has been yielded to
  // COMPLETION (`tempFileCleanupCallback()` after `yield* _parseWorksheet`).
  // Breaking out leaves the reader suspended mid-yield, so the callback never
  // runs — and a generator's `return()` executes `finally` blocks only, of
  // which it has none, so nothing else can reach it either. MEASURED in a
  // long-lived process: one 150,000-row import left **57 MB** in /tmp and it
  // was still there three seconds later; the container's own exit is what
  // cleans it, and the app container runs for weeks between deploys. On a
  // 500,000-row quarter that is ~190 MB per upload, on a VPS where the
  // photographs, Postgres and the dumps already share one disk — and a /tmp
  // with no room is itself one of the ways a parse dies with nothing written
  // down, which is the whole subject of 0095.
  //
  // So the loop RUNS OUT rather than breaking, and the rule «one sheet» is
  // kept by not yielding the others' rows. The cost is walking a second
  // sheet's XML for nothing, on a file that is not supposed to have one.
  let sheet = 0;
  for await (const worksheet of reader) {
    sheet++;
    for await (const row of worksheet) {
      // The dump is one sheet; a second one would be somebody else's file.
      if (sheet > 1) continue;
      // exceljs's values array is 1-based with a hole at [0].
      const values = row.values as unknown[];
      yield Array.isArray(values) ? values.slice(1).map(cellText) : [];
    }
  }
}

/** exceljs hands back rich text / formula results / hyperlinks as objects. */
function cellText(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
    if (v.result !== undefined) return v.result;
    if (v.text !== undefined) return v.text;
    return null;
  }
  return value;
}

/** Minimal CSV: quoted fields with doubled quotes, comma or semicolon. */
function splitCsvLine(line: string): string[] {
  const sep = line.split(';').length > line.split(',').length ? ';' : ',';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * «I am still reading» — one small UPDATE, on the wall clock.
 *
 * It carries the row counter too, so the screen's number moves for a file of
 * any size. The two are one write on purpose: a heartbeat that agreed with a
 * counter written somewhere else would be a second place to get it wrong.
 */
async function beat(batchId: string, rowCount: number, skipped: number): Promise<void> {
  await db
    .update(customsImportBatches)
    .set({ rowCount, skippedRows: skipped, heartbeatAt: new Date() })
    .where(eq(customsImportBatches.id, batchId));
}

/**
 * Parse the stored file into `customs_import_rows` and settle the batch.
 *
 * Idempotent by wipe-and-redo: pg-boss retries a thrown job, so the batch's
 * own rows are deleted first — the batch id is the claim, and a half-written
 * quarter must never be added to a re-run's rows.
 */
export async function runCustomsImport(input: {
  batchId: string;
  storageKey: string;
  fileName: string;
}): Promise<ImportOutcome> {
  const { batchId, storageKey, fileName } = input;
  await db.delete(customsImportRows).where(eq(customsImportRows.batchId, batchId));
  // The first beat is BEFORE a byte is read, and it matters most: opening
  // the stored file is itself something that can hang (a storage blip, a
  // network read of 80 MB). Without it a batch would look dead for the
  // fifteen minutes the sweep waits, and a retry after a container restart
  // would be reaped before it had done anything wrong.
  await beat(batchId, 0, 0);

  let header: ReturnType<typeof readHeader>['index'] | null = null;
  let rowCount = 0;
  let skipped = 0;
  const skipReasons: Partial<Record<SkipReason, number>> = {};
  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  let driftChecked = 0;
  let driftSum = 0;
  let pending: ParsedImportRow[] = [];
  let lastBeat = Date.now();

  const flush = async () => {
    if (pending.length === 0) return;
    await db.insert(customsImportRows).values(
      pending.map((r) => ({
        batchId,
        tnvedCode: r.tnvedCode,
        name: r.name,
        nameNorm: r.nameNorm,
        unit: r.unit,
        pricePerUnitUsd: r.pricePerUnitUsd.toFixed(4),
        weightPerUnitKg: r.weightPerUnitKg === null ? null : r.weightPerUnitKg.toFixed(4),
        nettoKg: r.nettoKg === null ? null : r.nettoKg.toFixed(3),
        customsValueUsd: r.customsValueUsd === null ? null : r.customsValueUsd.toFixed(2),
        declaredAt: r.declaredAt,
        sender: r.sender,
        originCountry: r.originCountry,
      })),
    );
    pending = [];
  };

  for await (const cells of streamRows(storageKey, fileName)) {
    if (!header) {
      const found = readHeader(cells);
      if (found.missing.length > 0) {
        // Not every sheet starts on row 1 — keep looking until a row carries
        // the required headers, and only give up at the end of the file.
        if (Object.keys(found.index).length === 0) continue;
        // A row that matched SOME headers but not the required ones is the
        // header row of a file we cannot use: name what is absent.
        throw new CustomsImportError(
          'missing_columns',
          found.missing.map((f) => FIELD_LABELS[f]).join(', '),
        );
      }
      header = found.index;
      continue;
    }

    const parsed = parseRow(cells, header);
    if (!parsed.ok) {
      skipped++;
      skipReasons[parsed.reason] = (skipReasons[parsed.reason] ?? 0) + 1;
      continue;
    }
    const row = parsed.row;
    if (row.declaredAt) {
      if (!periodFrom || row.declaredAt < periodFrom) periodFrom = row.declaredAt;
      if (!periodTo || row.declaredAt > periodTo) periodTo = row.declaredAt;
    }
    // The self-check: on kg rows the per-unit price should be the customs
    // value over the netto weight. Sampled, never enforced — it says whether
    // the column still means what it meant when this was written.
    if (driftChecked < 100) {
      const drift = priceDrift(row);
      if (drift !== null) {
        driftChecked++;
        driftSum += drift;
      }
    }
    pending.push(row);
    rowCount++;
    if (pending.length >= CHUNK) await flush();
    if (Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      await beat(batchId, rowCount, skipped);
    }
  }
  await flush();

  if (!header) throw new CustomsImportError('missing_columns', 'sarlavha qatori topilmadi');
  if (rowCount === 0) throw new CustomsImportError('no_rows');

  if (driftChecked > 0) {
    const avg = driftSum / driftChecked;
    logger.info(
      { batchId, driftChecked, avgDrift: Number(avg.toFixed(4)) },
      '[customs-import] per-kg price vs value/netto drift',
    );
  }

  await db
    .update(customsImportBatches)
    .set({
      status: 'ready',
      rowCount,
      skippedRows: skipped,
      periodFrom,
      periodTo,
      error: null,
      heartbeatAt: new Date(),
    })
    .where(eq(customsImportBatches.id, batchId));

  return { rowCount, skipped, skipReasons, periodFrom, periodTo };
}

/** Mark a batch failed with a sentence the admin can act on. */
export async function failCustomsImport(batchId: string, message: string): Promise<void> {
  await db
    .update(customsImportBatches)
    .set({ status: 'failed', error: message.slice(0, 500) })
    .where(eq(customsImportBatches.id, batchId));
}

/**
 * Fail every batch that stopped saying it was alive.
 *
 * The backstop for the failures the worker's own catch can never see. A
 * process killed mid-parse — out of memory, a deploy, a disk with no room
 * left for the sheet exceljs spools to /tmp — reaches no catch, and pg-boss
 * forgets a job once its retries are spent. Both left the row claiming
 * «processing» for ever, on a screen that offers no button on a processing
 * row: two files uploaded on 2026-09-04 were, between them, unremovable.
 *
 * `uploaded_at` is the fallback clock for batches minted before 0095 — and
 * for the one window where a beat has genuinely not happened yet, which
 * cannot outlast the first ten seconds of a live parse.
 *
 * Returns how many it settled, so a quiet sweep says nothing at all.
 */
export async function sweepStuckImports(staleMs = IMPORT_STALE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE customs_import_batches
       SET status = 'failed',
           error = ${'to‘xtab qoldi — faylni qayta yuklang'}
     WHERE status = 'processing'
       AND COALESCE(heartbeat_at, uploaded_at) < ${cutoff}::timestamptz
    RETURNING id
  `);
  if (rows.length > 0) {
    logger.error({ count: rows.length }, '[customs-import] stuck batches failed by the sweep');
  }
  return rows.length;
}

export async function listImportBatches(limit = 20) {
  return db
    .select()
    .from(customsImportBatches)
    .orderBy(desc(customsImportBatches.uploadedAt))
    .limit(limit);
}

/**
 * The batch every suggestion reads: the newest one that finished.
 *
 * His answer 2b — imports accumulate and the newest READY one is the truth;
 * a batch still processing must never half-price a calculation.
 */
export async function newestReadyBatchId(): Promise<string | null> {
  const [row] = await db
    .select({ id: customsImportBatches.id })
    .from(customsImportBatches)
    .where(eq(customsImportBatches.status, 'ready'))
    .orderBy(desc(customsImportBatches.uploadedAt))
    .limit(1);
  return row?.id ?? null;
}

/** How many calculation rows are priced off this import's declarations. */
export async function importBatchUsage(batchId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM calc_request_items i
      JOIN customs_import_rows r ON r.id = i.import_row_id
     WHERE r.batch_id = ${batchId}::uuid
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Delete a batch and its rows — a FAILED one always, a READY one only while
 * nothing is priced off it.
 *
 * Both halves are real. The wrong file gets uploaded (last quarter's, a
 * colleague's, the same one twice) and until it is removed every suggestion
 * in the company reads it — so a batch nobody has taken a price from must be
 * removable. Once a calculation HAS taken one, the batch is that price's
 * provenance and deleting it would leave the row with no answer to «where
 * did this come from», which is the whole reason `import_row_id` exists.
 *
 * Asked in the SERVICE and not only on the screen (#531): a hand-posted id
 * never passes a button.
 */
export async function deleteImportBatch(batchId: string): Promise<void> {
  const [batch] = await db
    .select({ status: customsImportBatches.status })
    .from(customsImportBatches)
    .where(eq(customsImportBatches.id, batchId))
    .limit(1);
  if (!batch) return;
  if (batch.status !== 'failed' && (await importBatchUsage(batchId)) > 0) {
    throw new CustomsImportError('in_use');
  }
  await db.delete(customsImportBatches).where(eq(customsImportBatches.id, batchId));
}

/** How many rows a ready batch holds per code — the screen's «bor» line. */
export async function batchCodeCount(batchId: string, tnvedCode: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customsImportRows)
    .where(and(eq(customsImportRows.batchId, batchId), eq(customsImportRows.tnvedCode, tnvedCode)));
  return Number(row?.n ?? 0);
}
