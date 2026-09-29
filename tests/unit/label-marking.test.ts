import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { codeFontFor, labelRenderer, type LabelData } from '@/modules/wms/labels/renderer';

/**
 * An unclaimed carton's sticker prints its MARKING, and since the factory
 * barcode was retired (DECISIONS #1224) the marking is where a factory's own
 * text code goes — numbers, a name, letters, in whatever script the factory
 * writes. Helvetica cannot encode Cyrillic, Chinese or «№», and pdf-lib does
 * not draw a box for them: it THROWS «WinAnsi cannot encode», so one such
 * lot made the whole sheet a 500 (measured before the fix, all four below).
 */

const base: Omit<LabelData, 'clientCodeWithLetter'> = {
  warehouseCode: 'YW',
  dateLocal: '29.09.2026',
  receiptNumber: 'YW-R-0001',
  unclaimed: true,
  productZh: '女士夹克',
  productRu: 'Ўзбек куртка',
  boxSeq: 1,
  boxTotal: 3,
  weightKg: '12.5',
  dimsCm: '50×40×30',
  shortCode: 'YW26-000123',
};

describe('the box label with a factory marking', () => {
  it('prints a Cyrillic, Chinese or «№» marking instead of failing the sheet', async () => {
    for (const code of ['ЗАВОД 12-A', '义乌工厂 A08-A', 'NIKE №5-A', 'ЎРИК-A']) {
      const pdf = await labelRenderer.render([{ ...base, clientCodeWithLetter: code }]);
      expect(pdf.byteLength, code).toBeGreaterThan(1000);
    }
  });

  it('keeps a client code in Helvetica Bold and moves only what it cannot encode', async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fonts = {
      bold,
      cjk: 'cjk' as never,
      clean: (text: string) => text.replace('Ў', "O'"),
      winAnsi: new Set(bold.getCharacterSet()),
    };
    expect(codeFontFor(fonts, 'GS777-A')).toEqual({ font: bold, text: 'GS777-A' });
    expect(codeFontFor(fonts, '444MANIKEN-AL-B')).toEqual({ font: bold, text: '444MANIKEN-AL-B' });
    expect(codeFontFor(fonts, 'ЎРИК-A')).toEqual({ font: 'cjk', text: "O'РИК-A" });
    expect(codeFontFor(fonts, '义乌-A').font).toBe('cjk');
  });
});
