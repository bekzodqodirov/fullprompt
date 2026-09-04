import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import subsetFont from 'subset-font';

/**
 * CJK font for PDFs (labels, handover act, the offer sheet). fontkit's own
 * subsetter emits broken fonts for Noto Sans SC (CFF and TTF alike — glyphs
 * silently vanish on print, the owner's "no product name on stickers" bug,
 * #103), so we subset ourselves with HarfBuzz (subset-font) to exactly the
 * characters a document uses and embed the result with `subset: false` —
 * every PDF builder in this codebase, no exceptions (`pdf-embed.test.ts`).
 *
 * ONE table is cut out of HarfBuzz's output before it is embedded: GSUB.
 * MEASURED (round 112, #881): pdfium — Chrome's viewer and every Android PDF
 * renderer — draws each DIGIT set with this font at a full-width advance
 * when the embedded file carries that table: «GS7 7 7», «B-0 0 0 0 6 6»,
 * «2 4 .0 8 .2 0 2 6» on the offer sheet, the handover act and the crate
 * label. The /W widths in the PDF were always right, so nothing that reads
 * the PDF could measure it; only a raster could. vhea/vmtx, GPOS and BASE
 * were each stripped in turn and are innocent — GSUB alone is the cause, and
 * a PDF renderer has no business reading it: the text is already shaped and
 * positioned by the PDF, so a substitution table is a shaper's input that
 * here can only be misread. The cut is a table-directory rewrite
 * (`dropSfntTable`), never a second subsetter — the glyphs, metrics and cmap
 * stay the bytes HarfBuzz wrote, which is what has printed for a year.
 * Re-subsetting with fontkit (`subset: true`) also drops GSUB and also drew
 * correctly here, and was refused: it is exactly the subsetter #103 removed
 * for producing fonts that printers dropped, and a thermal printer is not
 * something this container can measure.
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
  const subset = await subsetFont(await fullFontBytes(), [...chars].join(''), {
    targetFormat: 'truetype',
  });
  const cut = dropSfntTable(subset, 'GSUB');
  return Buffer.from(cut.buffer, cut.byteOffset, cut.byteLength);
}

const SFNT_HEADER = 12;
const SFNT_RECORD = 16;
/** The sfnt whole-file checksum constant: sum(file) ≡ this once `head.checksumAdjustment` is right. */
const SFNT_CHECKSUM_MAGIC = 0xb1b0afba;

/**
 * Return `font` without the sfnt table `tag`; the same bytes when it carries
 * none. A pure directory rewrite: surviving tables keep their data and their
 * recorded checksum byte for byte and are re-packed in the order they stood,
 * 4-byte aligned; the directory keeps tag order (the spec's binary-search
 * contract) and its search fields are recomputed; `head.checksumAdjustment`
 * is recomputed over the new file, so a validator finds nothing to say.
 */
export function dropSfntTable(font: Uint8Array, tag: string): Uint8Array {
  const src = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numTables = src.getUint16(4);
  const records: { tag: string; checksum: number; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = SFNT_HEADER + i * SFNT_RECORD;
    records.push({
      tag: String.fromCharCode(font[at]!, font[at + 1]!, font[at + 2]!, font[at + 3]!),
      checksum: src.getUint32(at + 4),
      offset: src.getUint32(at + 8),
      length: src.getUint32(at + 12),
    });
  }
  const kept = records.filter((r) => r.tag !== tag);
  if (kept.length === records.length) return font;

  const dirSize = SFNT_HEADER + kept.length * SFNT_RECORD;
  const placed = new Map<string, number>();
  let cursor = dirSize;
  for (const r of [...kept].sort((a, b) => a.offset - b.offset)) {
    placed.set(r.tag, cursor);
    cursor += (r.length + 3) & ~3;
  }
  const out = new Uint8Array(cursor);
  const dst = new DataView(out.buffer);
  out.set(font.subarray(0, 4), 0);
  const entrySelector = Math.floor(Math.log2(kept.length));
  const searchRange = 2 ** entrySelector * SFNT_RECORD;
  dst.setUint16(4, kept.length);
  dst.setUint16(6, searchRange);
  dst.setUint16(8, entrySelector);
  dst.setUint16(10, kept.length * SFNT_RECORD - searchRange);
  kept.forEach((r, i) => {
    const at = SFNT_HEADER + i * SFNT_RECORD;
    const to = placed.get(r.tag)!;
    for (let k = 0; k < 4; k++) out[at + k] = r.tag.charCodeAt(k);
    dst.setUint32(at + 4, r.checksum);
    dst.setUint32(at + 8, to);
    dst.setUint32(at + 12, r.length);
    out.set(font.subarray(r.offset, r.offset + r.length), to);
  });

  const headAt = placed.get('head');
  if (headAt !== undefined) {
    // Zero the adjustment, sum the whole (4-byte-multiple) file, write the complement.
    dst.setUint32(headAt + 8, 0);
    let sum = 0;
    for (let i = 0; i < out.length; i += 4) sum = (sum + dst.getUint32(i)) >>> 0;
    dst.setUint32(headAt + 8, (SFNT_CHECKSUM_MAGIC - sum) >>> 0);
  }
  return out;
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
