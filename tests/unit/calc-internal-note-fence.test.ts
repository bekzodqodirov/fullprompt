import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The VED's internal note never reaches a seller (the owner's 9a: «ichki izoh
 * — faqat VEDlar uchun»; docs/VED-TARIX.md §5, §11, review access-money-10).
 *
 * The audience is NARROWER than the calc registry's: the accountant reads the
 * history and never the note, so the fence works on EXPRESSIONS and not on
 * files — the column may be selected in exactly three places (the writer, the
 * sighted reader, the registry's sighted branch) and every other mention of
 * it in src is a failure. Comments stripped first (#725).
 */
const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(join(ROOT, rel), 'utf8'));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const COLUMN = /answer_internal_note|answerInternalNote\b/;

describe('the internal note column is touched in three places', () => {
  const where = walk(SRC)
    .filter((file) => COLUMN.test(strip(readFileSync(file, 'utf8'))))
    .map((file) => relative(ROOT, file))
    .sort();

  it('the schema, the service (writer + sighted reader) and the registry — nothing else', () => {
    expect(where).toEqual(
      [
        'src/modules/platform/db/schema/wms.ts',
        'src/modules/wms/calc/chain.ts',
        'src/modules/wms/calc/service.ts',
      ].sort(),
    );
  });

  it('the registry selects it ONLY under the minted sight', () => {
    const chain = read('src/modules/wms/calc/chain.ts');
    const hits = chain.match(/answer_internal_note/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(chain).toContain("noteSight ? sql.raw('a.answer_internal_note') : sql.raw('NULL::text')");
    // …and the row carries it only under the same sight.
    expect(chain).toContain('internalNote: opts.noteSight ? r.internal_note : null');
  });

  it('the service reads it only in the reader that REQUIRES the sight', () => {
    const service = read('src/modules/wms/calc/service.ts');
    const reads = service.match(/calcRequests\.answerInternalNote/g) ?? [];
    expect(reads).toHaveLength(1);
    const reader = service.slice(service.indexOf('export async function calcInternalNoteFor('));
    expect(reader.slice(0, 400)).toMatch(/_sight: InternalNoteSight,?\s*\)/);
    expect(reader.slice(0, 400)).toContain('calcRequests.answerInternalNote');
  });
});

describe('the Готово door keeps it off the seller’s side', () => {
  const service = read('src/modules/wms/calc/service.ts');
  const finish = service.slice(
    service.indexOf('export async function finishCalcRequest('),
    service.indexOf('export async function completeCalcForDeal('),
  );

  it('the CARD’s audit row carries the figure and not the note', () => {
    const card = finish.slice(finish.indexOf('entityType: row.entityType'));
    const after = card.slice(card.indexOf('after:'), card.indexOf('}', card.indexOf('after:')) + 1);
    expect(after).toContain('calcDone');
    expect(after).not.toMatch(/internal/i);
  });

  it('the seller’s CalcDone push does not carry it', () => {
    const push = finish.slice(finish.indexOf("type: 'CalcDone'"));
    const text = push.slice(0, push.indexOf('exceptUserId'));
    expect(text).not.toMatch(/internal/i);
  });
});

describe('no seller-facing surface names it', () => {
  // The panel on the seller's card, the offer text and PDF, the sheet the
  // accountant reads, the goods route, the karta, and the lenta.
  const FILES = [
    'src/components/calc-panel.tsx',
    'src/modules/wms/calc/offer.ts',
    'src/modules/wms/calc/offer-pdf.ts',
    'src/modules/wms/calc/sheet.ts',
    'src/components/calc-sheet.tsx',
    'src/app/api/calc/registry/[requestId]/goods/route.ts',
    'src/app/(protected)/hisoblash/[id]/karta/page.tsx',
    'src/components/client-feed.tsx',
  ];
  it.each(FILES)('%s', (file) => {
    expect(read(file)).not.toMatch(/internalNote|internal_note|calcInternalNote/i);
  });
});
