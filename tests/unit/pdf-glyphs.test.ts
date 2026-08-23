import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import { pdfTextCleaner } from '@/modules/wms/labels/cjk-font';

/**
 * What the PDF font can actually draw.
 *
 * `.notdef` raises nothing anywhere: a character the font lacks is a blank
 * box on a document a customer holds and a receiver signs, with no error in
 * any log. So the holes are MEASURED here against the font file itself,
 * rather than asserted from what the block ranges suggest — `BASE_CHARS`
 * asks for the whole of 0x400-0x45F and thirty of those have no glyph.
 */
const font = fontkit.create(
  readFileSync('src/assets/fonts/NotoSansSC-Regular.ttf'),
) as unknown as { layout: (t: string) => { glyphs: { id: number }[] } };

const drawable = (ch: string) => font.layout(ch).glyphs.every((g) => g.id !== 0);

describe('the font’s real coverage', () => {
  it('draws Russian and Latin, which is what most documents are', () => {
    for (const ch of 'ABCabcЯяЁёШщ0123456789$.,-') expect(drawable(ch)).toBe(true);
  });

  it('CANNOT draw any of Uzbek Cyrillic’s own four letters', () => {
    // The finding. If this ever goes green the font was replaced, and the
    // transliteration below is no longer the right repair.
    for (const ch of 'ЎўҚқҒғҲҳ') expect(drawable(ch)).toBe(false);
  });

  it('cannot draw an emoji, which is why the offer labels forbid them', () => {
    for (const ch of ['📦', '✅', '🧮']) expect(drawable(ch)).toBe(false);
  });
});

describe('the cleaner', () => {
  it('transliterates Uzbek Cyrillic instead of printing blanks', async () => {
    const clean = await pdfTextCleaner();
    expect(clean('Ўктам')).toBe("O'ктам");
    expect(clean("Ғанижон Ҳақбердиев")).toBe("G'анижон Hаqбердиев");
    // Every character it emits must be drawable, or the repair repairs nothing.
    for (const ch of clean('Ўктам Қаҳҳор')) expect(drawable(ch)).toBe(true);
  });

  it('drops what it cannot draw and cannot transliterate', async () => {
    const clean = await pdfTextCleaner();
    expect(clean('Ali 📦 aka')).toBe('Ali  aka');
    expect(clean('✅ Bekzod')).toBe(' Bekzod');
  });

  it('leaves ordinary text exactly as written', async () => {
    const clean = await pdfTextCleaner();
    const text = 'GSR GROUP — Иванов, 30 m3, $4 500.00';
    expect(clean(text)).toBe(text);
    expect(clean('bir\nikki')).toBe('bir\nikki');
  });
});
