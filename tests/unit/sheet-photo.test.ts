import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { SHEET_PHOTO_PX, fitInBox, sheetPhoto, sheetPhotoKey } from '@/modules/wms/documents/sheet-photo';

/**
 * His «packing list sklad excellarida rasimlar … hira korinyabti»
 * (2026-10-21): the three sheets that carry photographs embedded the 200-px
 * list thumbnail, compressed twice, squeezed into a fixed box.
 */

const src = (p: string) => readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'wms', p), 'utf8');
const SHEETS = ['documents/packing-photos-xlsx.ts', 'documents/agent-xlsx.ts', 'reports/stock-xlsx.ts'];

describe('a photograph in a spreadsheet', () => {
  it('the documents take the 800-px copy, the original when there is none', () => {
    expect(sheetPhotoKey({ thumb800Key: 'a.thumb800.webp', storageKey: 'a.jpg' })).toBe('a.thumb800.webp');
    expect(sheetPhotoKey({ thumb800Key: null, storageKey: 'a.jpg' })).toBe('a.jpg');
    expect(SHEET_PHOTO_PX.document).toBe(800);
  });

  it('keeps its proportions inside the cell box', () => {
    expect(fitInBox({ width: 800, height: 600 })).toEqual({ width: 78, height: 59 });
    expect(fitInBox({ width: 600, height: 800 })).toEqual({ width: 54, height: 72 });
  });

  it('is a JPEG no longer than asked, its size reported', async () => {
    const sharp = (await import('sharp')).default;
    const big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#c33' } }).jpeg().toBuffer();
    const out = await sheetPhoto(big, SHEET_PHOTO_PX.document);
    expect([out.width, out.height]).toEqual([800, 600]);
    expect(out.buffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('all three sheets go through it — none embeds the 200-px thumbnail or a fixed box any more', () => {
    for (const file of SHEETS) {
      const text = src(file);
      expect(text, file).toContain('sheetPhoto(bytes, SHEET_PHOTO_PX.');
      expect(text, file).toContain('fitInBox(');
      expect(text, file).not.toContain('thumb200Key');
      expect(text, file).not.toContain('ext: { width: 78, height: 72 }');
    }
  });

  it('all three sheets are STORED, never deflated — JPEG does not shrink, the CPU was the cost (the review)', () => {
    for (const file of SHEETS) {
      const text = src(file);
      const writes = text.match(/\.writeBuffer\([^)]*\)/g) ?? [];
      expect(writes, file).toEqual([".writeBuffer({ zip: { compression: 'STORE' } })"]);
    }
  });

  it('a STORED workbook is still a workbook exceljs reads back, photo included', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a3' } }).jpeg().toBuffer();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S');
    sheet.addRow(['Стол', 5]);
    const imageId = workbook.addImage({ buffer: jpeg as unknown as ExcelJS.Buffer, extension: 'jpeg' });
    sheet.addImage(imageId, { tl: { col: 2, row: 0 }, ext: { width: 64, height: 48 } });
    const stored = Buffer.from(await workbook.xlsx.writeBuffer({ zip: { compression: 'STORE' } }));
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(stored as unknown as ArrayBuffer);
    expect(back.worksheets[0]!.getRow(1).values).toEqual([undefined, 'Стол', 5]);
    expect(back.model.media).toHaveLength(1);
  });
});
