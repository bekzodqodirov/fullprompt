import { readFile } from 'node:fs/promises';
import path from 'node:path';
import subsetFont from 'subset-font';

/**
 * CJK font for PDFs (labels, handover act). fontkit's own subsetter emits
 * broken fonts for Noto Sans SC (CFF and TTF alike — glyphs silently vanish
 * on print, the owner's "no product name on stickers" bug), so we subset
 * ourselves with HarfBuzz (subset-font) to exactly the characters a document
 * uses and embed the result with `subset: false`.
 */

let cachedFullFont: Buffer | null = null;
async function fullFontBytes(): Promise<Buffer> {
  if (!cachedFullFont) {
    cachedFullFont = await readFile(
      path.join(process.cwd(), 'src/assets/fonts/NotoSansSC-Regular.ttf'),
    );
  }
  return cachedFullFont;
}

// Always include printable ASCII, the full Cyrillic block (ru + uz Cyrillic)
// and common punctuation, so static document text never loses a glyph — only
// CJK varies per document.
const BASE_CHARS = (() => {
  let s = '№—–«»…·×';
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  for (let c = 0x400; c <= 0x45f; c++) s += String.fromCharCode(c);
  return s;
})();

/** Build a valid embedded-ready font covering every character in `texts`. */
export async function cjkSubsetFor(texts: (string | null | undefined)[]): Promise<Buffer> {
  const chars = new Set<string>(BASE_CHARS);
  for (const text of texts) {
    if (!text) continue;
    for (const ch of text) chars.add(ch);
  }
  return subsetFont(await fullFontBytes(), [...chars].join(''), {
    targetFormat: 'truetype',
  });
}
