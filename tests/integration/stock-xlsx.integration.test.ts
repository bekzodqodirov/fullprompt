import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '@/modules/platform/db/client';
import { attachments } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { buildStockXlsx, type StockSheetLine } from '@/modules/wms/reports/stock-xlsx';

/**
 * The Ostatka sheet says what the warehouse measured — and shows it.
 *
 * Owner, 2026-09-19: «excelda yuk haqidagi malumotlarda XYZ korinmas ekan
 * umumiy hajm korinar ekan faqat shuni qosh va rasimlari bn qoyilgan bolsin
 * excelda. Agar xyz kirgizilmagan bolsa … xyz qatori bosh qolsin.»
 *
 * The builder takes its rows as DATA, which is why this file can state the
 * blank-XYZ rule without seeding a receipt: the interesting behaviour is the
 * spreadsheet, so the test reads the bytes back the way m3-planning reads the
 * packing list's.
 */

const CAP_NOTE = /^📷/;

function line(over: Partial<StockSheetLine['lot']> & { id: string }): StockSheetLine {
  return {
    lot: {
      receiptId: '00000000-0000-0000-0000-0000000000ff',
      letter: 'A',
      productNameZh: '玩具',
      productNameRu: 'Игрушки',
      boxCount: 10,
      totalWeightKg: '200.0000',
      totalVolumeM3: '5.0000',
      boxLengthCm: null,
      boxWidthCm: null,
      boxHeightCm: null,
      note: null,
      ...over,
    },
    receivedAt: new Date('2026-09-01T00:00:00Z'),
    marking: null,
    whCode: 'YW',
    whId: '00000000-0000-0000-0000-0000000000aa',
    clientCode: 'GS500',
    inStock: 10,
  };
}

const MEASURED = '11111111-1111-1111-1111-111111111111';
const UNMEASURED = '22222222-2222-2222-2222-222222222222';
/**
 * TWO prixods, two lots each, and each prixod's general photograph shared by
 * its own two rows. That shape is not decoration — see the fixture's note.
 */
const RECEIPT = '00000000-0000-0000-0000-0000000000ff';
const RECEIPT2 = '00000000-0000-0000-0000-0000000000ee';
const LOT_B = '33333333-3333-3333-3333-333333333333';
const LOT_C = '44444444-4444-4444-4444-444444444444';
const LOT_D = '55555555-5555-5555-5555-555555555555';

async function build(lines: StockSheetLine[]) {
  const { buffer } = await buildStockXlsx({
    lines,
    arrivalCodes: new Map(),
    cols: undefined,
    locale: 'uz',
    can: () => true,
  });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return book.getWorksheet('Stock')!;
}

/** Header text → its 1-based column number. */
function headers(sheet: ExcelJS.Worksheet): Map<string, number> {
  const out = new Map<string, number>();
  (sheet.getRow(1).values as (string | undefined)[]).forEach((value, i) => {
    if (typeof value === 'string') out.set(value, i);
  });
  return out;
}

describe('the stock XLSX', () => {
  it('carries an XYZ column and a photo column', async () => {
    const sheet = await build([line({ id: MEASURED })]);
    const head = headers(sheet);
    expect([...head.keys()], 'the XYZ column is missing').toContain('XYZ (sm)');
    expect([...head.keys()].some((h) => CAP_NOTE.test(h)), 'the 📷 column is missing').toBe(true);
  });

  it('prints the measurements a lot carries', async () => {
    const sheet = await build([
      line({ id: MEASURED, boxLengthCm: 40, boxWidthCm: 30, boxHeightCm: 25 }),
    ]);
    const at = headers(sheet).get('XYZ (sm)')!;
    expect(sheet.getRow(2).getCell(at).value).toBe('40×30×25');
  });

  it('leaves XYZ EMPTY when only the total volume and weight were entered', async () => {
    // His own rule. The wizard lets an operator type the cube instead of the
    // three sides, so this row is complete data — not missing data.
    const sheet = await build([line({ id: UNMEASURED })]);
    const at = headers(sheet).get('XYZ (sm)')!;
    const value = sheet.getRow(2).getCell(at).value;
    expect(value === null || value === undefined || value === '').toBe(true);
    // …and the cube it replaces is still there, so the row is not just blank.
    const m3 = headers(sheet).get('m³')!;
    expect(Number(sheet.getRow(2).getCell(m3).value)).toBeCloseTo(5, 3);
  });

  it('refuses a half-measured lot rather than printing «40×30×»', async () => {
    const sheet = await build([line({ id: MEASURED, boxLengthCm: 40, boxWidthCm: 30 })]);
    const at = headers(sheet).get('XYZ (sm)')!;
    const value = sheet.getRow(2).getCell(at).value;
    expect(value === null || value === undefined || value === '').toBe(true);
  });
});

/**
 * EVERY photograph of the prixod line (owner, 2026-09-19: «usha prixotdagi
 * hamma rasim kerak boladi»), and the trap that makes it hard.
 *
 * The fixture is the smallest one that can see the trap: TWO rows of the same
 * receipt, one of them carrying its own lot photograph, and a general
 * receipt-level photograph shared by both. That sharing is what arms exceljs
 * 4.4.0's `drawingRelsHash` defect — it writes at `drawing.rels.length` and
 * reads at `medium.imageId`, so a second placement of one image with another
 * in between silently takes the WRONG relationship and the sheet draws a
 * different photograph. The two fixture images therefore have different
 * SHAPES (40×40 and 80×20), which survives the resize, so the test can read
 * the file back and say which picture actually landed in which cell.
 */
/**
 * EVERY photograph of the prixod line (owner, 2026-09-19: «usha prixotdagi
 * hamma rasim kerak boladi»), and the trap that makes it hard.
 *
 * **The fixture's shape is the whole test.** exceljs 4.4.0 keeps
 * `drawingRelsHash` in two key spaces inside one array
 * (`worksheet-xform.js:226-231`): it WRITES at `drawing.rels.length` and
 * READS at `medium.imageId` when the previous placement carried the same
 * image. Placing one image twice with another in between mints an EXTRA
 * relationship, which shifts the two spaces out of step — and the next image
 * that IS repeated back-to-back then reads a relationship belonging to
 * somebody else's photograph. The sheet draws the wrong picture, silently.
 *
 * Reaching that needs two prixods, each with a general photograph shared by
 * its own two rows: [P1,G] [P2,G] [X] [X]. My first fixture was one prixod
 * with three photographs on one row, and the red proof stayed GREEN on it —
 * evidence about the fixture, not about the code (#166).
 *
 * The four images have four different SHAPES, which survive the resize, so
 * the test can read the file back and say which photograph landed where.
 */
describe('the stock XLSX carries the photographs', () => {
  const KEYS = {
    p1: `test/stock-xlsx-p1-${MEASURED}.jpg`,
    p2: `test/stock-xlsx-p2-${MEASURED}.jpg`,
    g: `test/stock-xlsx-g-${MEASURED}.jpg`,
    x: `test/stock-xlsx-x-${MEASURED}.jpg`,
  };
  const made: string[] = [];
  let built = false;

  const square = (w: number, h: number) =>
    import('sharp').then((m) =>
      m
        .default({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } })
        .jpeg()
        .toBuffer(),
    );

  beforeAll(async () => {
    const uploader = await db.query.users.findFirst({ columns: { id: true } });
    if (!uploader) return;
    const add = async (
      key: string,
      bytes: Buffer,
      entityType: 'receipt_lot' | 'receipt',
      entityId: string,
    ) => {
      await getStorage().put(key, bytes, 'image/jpeg');
      const [row] = await db
        .insert(attachments)
        .values({
          entityType,
          entityId,
          kind: 'photo',
          storageKey: key,
          fileName: `${entityType}.jpg`,
          contentType: 'image/jpeg',
          sizeBytes: bytes.length,
          uploadedBy: uploader.id,
        })
        .returning({ id: attachments.id });
      if (row) made.push(row.id);
      return row?.id ?? null;
    };
    const ids = await Promise.all([
      add(KEYS.p1, await square(40, 40), 'receipt_lot', MEASURED),
      // 1000×500 on purpose: `thumb200Key` is NULL for every photo in this
      // container, so the builder falls back to the ORIGINAL — and must resize
      // it before embedding something drawn at 78×72 px.
      add(KEYS.p2, await square(1000, 500), 'receipt_lot', LOT_B),
      add(KEYS.g, await square(80, 20), 'receipt', RECEIPT),
      add(KEYS.x, await square(20, 80), 'receipt', RECEIPT2),
    ]);
    built = ids.every(Boolean);
  });

  afterAll(async () => {
    // An attachment is CONFIGURATION for anything that counts them (#183).
    if (made.length) await db.delete(attachments).where(inArray(attachments.id, made));
    for (const key of Object.values(KEYS)) await getStorage().delete(key);
  });

  /** The four rows: two of one prixod, two of another. */
  const FOUR = () => [
    line({ id: MEASURED, receiptId: RECEIPT }),
    line({ id: LOT_B, receiptId: RECEIPT }),
    line({ id: LOT_C, receiptId: RECEIPT2 }),
    line({ id: LOT_D, receiptId: RECEIPT2 }),
  ];

  /** Read the sheet back and resolve every placement to the image it DRAWS. */
  async function drawn(buffer: Buffer) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Stock')!;
    const sharp = (await import('sharp')).default;
    // The header reads '📷' normally and '📷 (N)' when the cap bit, so the
    // block is found by its PREFIX — an indexOf('📷') silently returns -1 on
    // the capped sheet and every column assertion then measures nothing.
    const base =
      (sheet.getRow(1).values as (string | undefined)[]).findIndex(
        (v) => typeof v === 'string' && v.startsWith('📷'),
      ) - 1;
    const out: { row: number; col: number; shape: string }[] = [];
    for (const image of sheet.getImages()) {
      const media = book.getImage(Number(image.imageId)) as unknown as { buffer: Buffer };
      const meta = await sharp(media.buffer).metadata();
      out.push({
        row: image.range.tl.nativeRow,
        col: image.range.tl.nativeCol - base,
        shape: `${meta.width}x${meta.height}`,
      });
    }
    return { sheet, base, placements: out.sort((a, b) => a.row - b.row || a.col - b.col) };
  }

  it('puts EVERY photo of the line on its row — the lot’s own first, then the prixod’s', async () => {
    // #494: a fixture that quietly failed to build would make every
    // assertion below vacuous — say so instead of passing.
    expect(built, 'the photo fixture did not insert').toBe(true);
    const { buffer, photos } = await buildStockXlsx({
      lines: FOUR(),
      arrivalCodes: new Map(),
      cols: undefined,
      locale: 'uz',
      can: () => true,
    });
    const { sheet, base, placements } = await drawn(buffer);
    expect(base, 'no photo column at all').toBeGreaterThan(0);

    expect(placements.map((p) => `${p.row}:${p.col}`)).toEqual([
      '1:0', // lot A's own photo
      '1:1', // …then its prixod's general one
      '2:0', // lot B's own
      '2:1', // …and the SAME general one
      '3:0', // lot C has none of its own — the second prixod's general
      '4:0', // …shared with lot D
    ]);
    expect(photos, 'the builder reports what it drew').toBe(6);

    // WHICH picture is in WHICH cell — the exceljs trap's own oracle.
    const shape = (row: number, col: number) =>
      placements.find((p) => p.row === row && p.col === col)!.shape;
    expect(shape(1, 0), 'the lot’s own photo leads the row').toBe('40x40');
    expect(shape(1, 1), 'the prixod’s general photo follows it').toBe('80x20');
    expect(shape(2, 0), 'a full-size photo is resized before it is embedded').toBe('200x100');
    expect(shape(2, 1), 'the same general photo, on the other lot of that prixod').toBe('80x20');
    expect(shape(3, 0), 'the SECOND prixod’s own general photo').toBe('20x80');
    expect(shape(4, 0), 'shared again — and NOT the first prixod’s picture').toBe('20x80');

    // Only a row that has a picture grows.
    expect(sheet.getRow(2).height).toBe(60);
  });

  it('opens as many 📷 columns as the fullest row needs — at the END of the sheet', async () => {
    const { buffer } = await buildStockXlsx({
      lines: FOUR(),
      arrivalCodes: new Map(),
      cols: undefined,
      locale: 'uz',
      can: () => true,
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Stock')!;
    const values = sheet.getRow(1).values as (string | undefined)[];
    const first = values.indexOf('📷');
    expect(first, 'no photo column at all').toBeGreaterThan(0);
    // Two photos on the fullest row → two columns, and they are the LAST
    // ones: a person reads the cargo before the pictures (both other photo
    // sheets in this codebase do the same).
    expect(sheet.columnCount).toBe(first + 1);
    expect(values.slice(first + 1).every((v) => v === '' || v === undefined)).toBe(true);
    // …with the code column pinned while the reader scrolls right into them.
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 1 });
  });

  /**
   * The owner's own report, the day it shipped: «excel fileda hech qanday
   * rasim korinmadi».
   *
   * The pictures were gated on `visible.has('photo')` — the screen's own
   * column tick — and every test in this file passed `cols: undefined`, which
   * is the ONE case where that gate is open. So the defect shipped green.
   *
   * `/stock` redirects a bare visit to a personal default view
   * (`stock/page.tsx:69-74`) and the ⬇️ XLSX link carries that view's `cols`,
   * so a single view saved without 📷 — which is exactly what a person saves,
   * because 450 thumbnails are what made that table slow on a phone (round
   * 68) — produced a sheet with no pictures, no 📷 column and no error, for
   * ever.
   *
   * The photographs are export-always now, like XYZ and «days in stock». This
   * test is the red proof: restore the gate and it fails.
   */
  it('carries the photographs even when the screen’s 📷 column is unticked', async () => {
    expect(built, 'the photo fixture did not insert').toBe(true);
    const { buffer, photos, visible } = await buildStockXlsx({
      lines: FOUR(),
      arrivalCodes: new Map(),
      // A saved view that names every column a person reads and not the 📷.
      cols: 'code,product,boxes,perBoxKg,stockKg,stockM3,whCode',
      locale: 'uz',
      can: () => true,
    });
    expect(photos, 'the screen’s tick silently emptied the sheet').toBe(6);
    const { sheet, base, placements } = await drawn(buffer);
    expect(base, 'no 📷 column at all').toBeGreaterThan(0);
    expect(placements.length, 'the pictures are not in the file').toBe(6);
    // The columns the view DID name still decide the rest of the sheet — this
    // is not a licence to ignore `?cols=`, only the photographs are exempt.
    const head = sheet.getRow(1).values as (string | undefined)[];
    expect(head.includes('kg/m³'), 'an unticked ordinary column came back').toBe(false);
    // …and the audit row must not claim the file has no photo column.
    expect(visible.has('photo'), 'the audit row would disagree with the file').toBe(true);
  });

  it('keeps ONE empty 📷 column when nothing on the sheet is photographed', async () => {
    const { buffer, photos } = await buildStockXlsx({
      // A lot of a prixod nobody photographed.
      lines: [line({ id: UNMEASURED, receiptId: '00000000-0000-0000-0000-0000000000dd' })],
      arrivalCodes: new Map(),
      cols: undefined,
      locale: 'uz',
      can: () => true,
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Stock')!;
    expect(photos).toBe(0);
    // The column is there, empty — not silently missing.
    expect((sheet.getRow(1).values as (string | undefined)[]).includes('📷')).toBe(true);
    expect(sheet.getImages()).toHaveLength(0);
  });

  it('says on the header that Excel’s Sort leaves the pictures behind', async () => {
    const { buffer } = await buildStockXlsx({
      lines: FOUR(),
      arrivalCodes: new Map(),
      cols: undefined,
      locale: 'uz',
      can: () => true,
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Stock')!;
    const first = (sheet.getRow(1).values as (string | undefined)[]).indexOf('📷');
    const note = sheet.getRow(1).getCell(first).note;
    expect(JSON.stringify(note), 'nothing warns that sorting moves the rows only').toContain(
      'Saralash',
    );
    // …and the header row repeats when the sheet is printed.
    expect(sheet.pageSetup.printTitlesRow).toBe('1:1');
  });

  it('stops at the column cap, keeps the first photos, and says how many did not fit', async () => {
    /**
     * The owner's data holds one photograph per lot today, so nothing a real
     * sheet can do reaches the shipped cap of eight — which is exactly why
     * the cap is injectable: an unreachable rule is an untested rule (#494).
     * At a cap of ONE, row 1 keeps its own photo and loses the prixod's.
     */
    const { buffer, photos, photosSkipped } = await buildStockXlsx({
      lines: FOUR(),
      arrivalCodes: new Map(),
      cols: undefined,
      locale: 'uz',
      can: () => true,
      photoColsCap: 1,
    });
    const { sheet, placements } = await drawn(buffer);
    expect(placements.map((p) => `${p.row}:${p.col}`)).toEqual(['1:0', '2:0', '3:0', '4:0']);
    expect(placements[0]!.shape, 'the lot’s OWN photo is the one kept').toBe('40x40');
    expect(photos).toBe(4);
    expect(photosSkipped, 'the two general photos of prixod 1 did not fit').toBe(2);
    const first = (sheet.getRow(1).values as (string | undefined)[]).indexOf('📷 (1)');
    expect(first, 'the header must say the cap bit').toBeGreaterThan(0);
    expect(JSON.stringify(sheet.getRow(1).getCell(first).note)).toContain('sig');
  });

  /**
   * The EXPORT-ONLY family, as one rule.
   *
   * Three columns do not follow the screen's tick — XYZ, «days in stock» and
   * the photographs — because `columns.ts` says why in its own words: a tick
   * keeps a phone-width table readable, and a sheet is read at a desk. The
   * photograph was the one that got this wrong (the gate that emptied the
   * owner's file), so the fence is the FAMILY and not the one member: a fourth
   * column added to it tomorrow is covered, and moving any of the three back
   * behind the tick turns this red.
   *
   * REPLACES a test that asserted the opposite — «a screen with 📷 unticked
   * fetches no bytes at all» — which pinned the defect as intended behaviour.
   * Its red proof went red for the gate and said nothing about whether the
   * gate belonged there.
   */
  it('keeps XYZ, «days in stock» and the photographs whatever the view hides', async () => {
    expect(built, 'the photo fixture did not insert').toBe(true);
    const { buffer } = await buildStockXlsx({
      lines: FOUR(),
      arrivalCodes: new Map(),
      // A view naming NONE of the three.
      cols: 'code,product,boxes,stockKg,stockM3,whCode',
      locale: 'uz',
      can: () => true,
    });
    const { sheet, placements } = await drawn(buffer);
    const head = [...headers(sheet).keys()];
    expect(head, 'XYZ is export-only').toContain('XYZ (sm)');
    expect(
      head.some((name) => name === '📷' || name.startsWith('📷 (')),
      'the photographs are export-only',
    ).toBe(true);
    expect(placements.length, 'a hidden tick emptied the pictures again').toBe(6);
    // …while an ordinary column the view left out stays out.
    expect(head, 'an ordinary hidden column came back').not.toContain('kg/m³');
  });
});
