import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
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

/**
 * Uzbek Cyrillic's own four letters, written the way Uzbek Latin writes them.
 *
 * MEASURED in NotoSansSC-Regular.ttf: **ў Ў қ Қ ғ Ғ ҳ Ҳ all have glyph id 0**,
 * along with 30 other characters inside the 0x400-0x45F block `BASE_CHARS`
 * claims to cover — so the subset asks for them, gets nothing, and
 * `drawText` draws `.notdef`. A customer named «Ўктам» printed as blanks on
 * the offer sheet and on the handover act, with no error raised anywhere.
 * Russian proper is unaffected (А-Яа-я and Ё both have glyphs).
 *
 * Transliterating is the honest repair rather than dropping: a name printed
 * in Latin is READ, a row of blanks is not, and this is the standard mapping
 * the country's own Latin alphabet uses. The apostrophe is ASCII U+0027 on
 * purpose — U+02BC, the letter the orthography actually specifies, is glyph 0
 * in this font too.
 */
const CYRILLIC_FALLBACK: Record<string, string> = {
  'Ў': "O'", 'ў': "o'", 'Қ': 'Q', 'қ': 'q', 'Ғ': "G'", 'ғ': "g'", 'Ҳ': 'H', 'ҳ': 'h',
};

let cachedProbe: { layout: (text: string) => { glyphs: { id: number }[] } } | null = null;

/**
 * A cleaner for everything a PDF draws — `await` it once, then call it as
 * often as the document needs.
 *
 * Two steps back and forth: it has to read the font file, and the draw loops
 * that use it are synchronous by nature (`line()` closes over a mutable
 * cursor). So the await is paid once per document, beside the subsetting the
 * document already awaits, and the returned function is plain.
 *
 * Names reach these documents from the client book and from Telegram display
 * names, so they can hold anything at all — an emoji in a display name is
 * ordinary, and every emoji is glyph 0 here. Dropping it prints a name with a
 * gap; drawing it prints a name with a box. The first is honest. The labels
 * this codebase writes itself are forbidden emoji at the source
 * (`calc/offer.ts`), so only imported text can reach this path.
 */
export async function pdfTextCleaner(): Promise<(text: string) => string> {
  if (!cachedProbe) {
    cachedProbe = fontkit.create(await fullFontBytes()) as unknown as typeof cachedProbe;
  }
  const font = cachedProbe!;
  return (text: string) => {
    let out = '';
    for (const ch of text) {
      const swap = CYRILLIC_FALLBACK[ch];
      if (swap !== undefined) {
        out += swap;
        continue;
      }
      if (ch === '\n' || ch === '\t' || font.layout(ch).glyphs.every((g) => g.id !== 0)) {
        out += ch;
      }
    }
    return out;
  };
}
