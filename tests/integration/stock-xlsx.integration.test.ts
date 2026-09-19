import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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

describe('the stock XLSX carries the photographs', () => {
  const KEY = `test/stock-xlsx-${MEASURED}.jpg`;
  let attachmentId: string | null = null;

  beforeAll(async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    await getStorage().put(KEY, jpeg, 'image/jpeg');
    const uploader = await db.query.users.findFirst({ columns: { id: true } });
    if (!uploader) return;
    const [row] = await db
      .insert(attachments)
      .values({
        entityType: 'receipt_lot',
        entityId: MEASURED,
        kind: 'photo',
        storageKey: KEY,
        fileName: 'box.jpg',
        contentType: 'image/jpeg',
        sizeBytes: jpeg.length,
        uploadedBy: uploader.id,
      })
      .returning({ id: attachments.id });
    attachmentId = row?.id ?? null;
  });

  afterAll(async () => {
    // An attachment is CONFIGURATION for anything that counts them (#183).
    if (attachmentId) await db.delete(attachments).where(eq(attachments.id, attachmentId));
    await getStorage().delete(KEY);
  });

  it('embeds the lot photo and grows only the row that has one', async () => {
    // #494: a fixture that quietly failed to build would make every
    // assertion below vacuous — say so instead of passing.
    expect(attachmentId, 'the photo fixture did not insert').toBeTruthy();
    const { buffer } = await buildStockXlsx({
      lines: [line({ id: MEASURED }), line({ id: UNMEASURED })],
      arrivalCodes: new Map(),
      cols: undefined,
      locale: 'uz',
      can: () => true,
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Stock')!;

    // #494: one image, and it belongs to the lot that has the attachment.
    expect(sheet.getImages(), 'no picture reached the sheet').toHaveLength(1);
    expect(sheet.getImages()[0]!.range.tl.nativeRow, 'the photo is on the wrong row').toBe(1);
    expect(sheet.getRow(2).height, 'the row with a photo must make room').toBe(60);
    expect(sheet.getRow(3).height, 'a row with no photo must NOT be 60pt tall').not.toBe(60);
  });

  it('a screen with 📷 unticked fetches no bytes at all', async () => {
    expect(attachmentId, 'the photo fixture did not insert').toBeTruthy();
    /**
     * The picture count is the WRONG oracle here and the first version of this
     * test used it: `photoCol >= 0` already refuses to place an image in a
     * column that is not on the sheet, so stripping the download gate left the
     * proof GREEN (#166). What the gate is FOR is the traffic — 450 rows is
     * 450 reads out of MinIO for a column nobody asked for — so the assertion
     * is the read count, which is the thing that costs.
     */
    const reads = vi.spyOn(getStorage(), 'get');
    try {
      const { buffer } = await buildStockXlsx({
        lines: [line({ id: MEASURED })],
        arrivalCodes: new Map(),
        // Every column the screen offers EXCEPT the photo.
        cols: 'code,product,boxes,perBoxKg,stockKg,stockM3,density,note,whCode,partiya,receivedAt',
        locale: 'uz',
        can: () => true,
      });
      expect(reads, 'the photo bytes were downloaded for a hidden column').not.toHaveBeenCalled();
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = book.getWorksheet('Stock')!;
      expect(sheet.getImages()).toHaveLength(0);
      // The XYZ column is export-only and stays whatever the screen hides.
      expect([...headers(sheet).keys()]).toContain('XYZ (sm)');
    } finally {
      reads.mockRestore();
    }
  });
});
