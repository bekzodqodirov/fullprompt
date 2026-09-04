/**
 * The PDF font pipeline, pinned from both ends (round 112, #881).
 *
 * Every PDF this codebase draws embeds ONE font: a HarfBuzz subset of
 * NotoSansSC (`cjkSubsetFor`) with its GSUB table cut out, embedded with
 * `subset: false`. MEASURED in pdfium (Chrome, every Android viewer): with
 * GSUB present, every digit is drawn at a full-width advance — «GS7 7 7»,
 * «B-0 0 0 0 6 6» — on the offer sheet, the act and the crate label, while
 * the PDF's own /W widths stay right, so nothing that reads the PDF can see
 * it. And `subset: true` is the fontkit subsetter #103 removed for emitting
 * fonts that printers dropped. So:
 *   1. the cut is a directory rewrite that changes nothing else (checked
 *      table by table against HarfBuzz's own output);
 *   2. the premise holds — HarfBuzz DOES emit GSUB, or the cut is moot;
 *   3. what a builder actually embeds carries no GSUB (the FontFile2
 *      stream of a real PDF, inflated and read);
 *   4. no embed site in src/ passes `subset: true` to a custom font.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import subsetFont from 'subset-font';
import { describe, expect, it } from 'vitest';
import { buildOfferPdf } from '@/modules/wms/calc/offer-pdf';
import { cjkSubsetFor, dropSfntTable } from '@/modules/wms/labels/cjk-font';

interface SfntRecord {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

function sfntDirectory(buf: Uint8Array): SfntRecord[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint16(4);
  const out: SfntRecord[] = [];
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    out.push({
      tag: String.fromCharCode(buf[at]!, buf[at + 1]!, buf[at + 2]!, buf[at + 3]!),
      checksum: dv.getUint32(at + 4),
      offset: dv.getUint32(at + 8),
      length: dv.getUint32(at + 12),
    });
  }
  return out;
}

const tags = (buf: Uint8Array) => sfntDirectory(buf).map((r) => r.tag);

function wholeFileSum(buf: Uint8Array): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sum = 0;
  for (let i = 0; i + 4 <= buf.byteLength; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}

type Probe = {
  numGlyphs: number;
  glyphForCodePoint: (cp: number) => { id: number };
};
const probe = (buf: Uint8Array) => fontkit.create(Buffer.from(buf)) as unknown as Probe;

const SAMPLE = 'GS777 B-000066 24.08.2026 0123456789 女式夹克 Ўзбекистон';

async function rawSubset(): Promise<Buffer> {
  const full = await readFile(path.join(process.cwd(), 'src/assets/fonts/NotoSansSC-Regular.ttf'));
  return subsetFont(full, SAMPLE, { targetFormat: 'truetype' });
}

describe('dropSfntTable', () => {
  it('HarfBuzz emits GSUB (the premise) and the cut removes exactly that table', async () => {
    const raw = await rawSubset();
    expect(tags(raw)).toContain('GSUB');
    const cut = dropSfntTable(raw, 'GSUB');
    expect(tags(cut)).not.toContain('GSUB');
    expect(tags(cut)).toEqual(tags(raw).filter((t) => t !== 'GSUB'));
    // Tag order is the directory's binary-search contract.
    expect(tags(cut)).toEqual([...tags(cut)].sort());
  });

  it('every surviving table is byte-identical, checksum included', async () => {
    const raw = await rawSubset();
    const cut = dropSfntTable(raw, 'GSUB');
    const before = new Map(sfntDirectory(raw).map((r) => [r.tag, r]));
    for (const r of sfntDirectory(cut)) {
      const was = before.get(r.tag)!;
      expect(r.length).toBe(was.length);
      expect(r.checksum).toBe(was.checksum);
      expect(r.offset % 4).toBe(0);
      const a = Buffer.from(cut.subarray(r.offset, r.offset + r.length));
      const b = Buffer.from(raw.subarray(was.offset, was.offset + was.length));
      // head differs in checksumAdjustment alone (bytes 8-11).
      if (r.tag === 'head') {
        a.writeUInt32BE(0, 8);
        b.writeUInt32BE(0, 8);
      }
      expect(a.equals(b), `table ${r.tag}`).toBe(true);
    }
    expect(cut.byteLength % 4).toBe(0);
    expect(wholeFileSum(cut)).toBe(0xb1b0afba);
  });

  it('the cut font parses and maps every character to the same glyph', async () => {
    const raw = await rawSubset();
    const cut = dropSfntTable(raw, 'GSUB');
    const a = probe(raw);
    const b = probe(cut);
    expect(b.numGlyphs).toBe(a.numGlyphs);
    for (const ch of SAMPLE) {
      const cp = ch.codePointAt(0)!;
      expect(b.glyphForCodePoint(cp).id).toBe(a.glyphForCodePoint(cp).id);
    }
    // Digits and CJK really are IN the subset — the round's whole point.
    for (const ch of '0123456789女式夹克') expect(b.glyphForCodePoint(ch.codePointAt(0)!).id).not.toBe(0);
  });

  it('is the identity on a font that lacks the table', async () => {
    const raw = await rawSubset();
    const cut = dropSfntTable(raw, 'GSUB');
    expect(dropSfntTable(cut, 'GSUB')).toBe(cut);
    expect(dropSfntTable(raw, 'ZZZZ')).toBe(raw);
  });
});

describe('what a PDF actually embeds', () => {
  it('cjkSubsetFor returns a font with no GSUB', async () => {
    const bytes = await cjkSubsetFor(['女式夹克', 'GS777']);
    expect(tags(bytes)).not.toContain('GSUB');
    expect(tags(bytes)).toEqual(expect.arrayContaining(['glyf', 'cmap', 'hmtx', 'head']));
  });

  it('the offer sheet\'s FontFile2 stream carries no GSUB', async () => {
    const pdf = await buildOfferPdf(
      {
        clientPriceUsd: 4820,
        volumeM3: 7,
        weightKg: 675.7,
        section: 'podklyuch',
        fromCity: 'Yiwu',
        toCity: 'Toshkent',
        validUntil: new Date('2026-09-10T00:00:00Z'),
        clientName: 'Alisher aka',
        clientCode: 'GS777',
        clientPhone: '+998 90 123 45 67',
        docNo: 'B-000066',
        offeredAt: new Date('2026-08-24T09:30:00Z'),
        managerName: 'Dilnoza Karimova',
        managerPhone: '+998 90 000 00 09',
        items: [{ seq: 1, label: '女式夹克', quantity: 120, unit: 'dona', weightKg: 240.5, volumeM3: 1.8 }],
      },
      'ru',
    );
    // pdf-lib packs the font DESCRIPTOR into an object stream, so the
    // `/FontFile2 n 0 R` reference is not readable as text; the font file
    // itself is a plain stream. Walk every stream, inflate, keep the sfnt ones.
    const text = Buffer.from(pdf).toString('latin1');
    const fonts: Uint8Array[] = [];
    for (const m of text.matchAll(/\d+ 0 obj\n<<([^]*?)>>\nstream\r?\n/g)) {
      const dict = m[1]!;
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? NaN);
      if (!Number.isFinite(length)) continue;
      const dataAt = m.index! + m[0].length;
      const raw = pdf.subarray(dataAt, dataAt + length);
      let body: Uint8Array;
      try {
        body = dict.includes('/FlateDecode') ? inflateSync(raw) : raw;
      } catch {
        continue;
      }
      const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      if (body.byteLength > 12 && dv.getUint32(0) === 0x00010000) fonts.push(body);
    }
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(tags(font)).toContain('glyf');
      expect(tags(font)).not.toContain('GSUB');
    }
  });
});

describe('embed sites', () => {
  const SITES = [
    'src/modules/wms/calc/offer-pdf.ts',
    'src/modules/wms/documents/handover-act.ts',
    'src/modules/wms/labels/renderer.ts',
  ];

  it('every custom-font embedFont in src/ passes subset: false', () => {
    let customSites = 0;
    for (const file of SITES) {
      const src = readFileSync(path.join(process.cwd(), file), 'utf8');
      for (const m of src.matchAll(/embedFont\(([^)]*)\)/g)) {
        const args = m[1]!;
        if (args.startsWith('StandardFonts.')) continue;
        customSites += 1;
        expect(args, `${file}: ${m[0]}`).toMatch(/\{ subset: false \}/);
      }
      expect(src).toContain('cjkSubsetFor(');
    }
    // Four today: offer sheet, act, box labels, crate label. A fifth builder
    // joins this list or it is not fenced.
    expect(customSites).toBe(4);
  });
});
