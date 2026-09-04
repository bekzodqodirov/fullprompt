import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OfferSheetItem } from '@/modules/wms/calc/offer-pdf';

/**
 * The customer's sheet (round 112) prints DESCRIPTORS and the offer's own
 * money rows — never the cost side.
 *
 * Two facts make this a fence rather than a comment. The obvious source for a
 * goods table is the sealed `breakdown` snapshot, and it carries `bazaUsd`
 * per item and duty/VAT/fee/customs per group — the company's cost, which
 * law 4 keeps off the customer's paper (#781, #790). And a per-row price
 * would DECOMPOSE the total: `freight_usd` and `freight_list_usd` are one
 * value at the seal, so showing parts hands the customer our list price and
 * the discount we were willing to give.
 */
const BUILDER = readFileSync('src/modules/wms/calc/offer-pdf.ts', 'utf8');
const ROUTE = readFileSync('src/app/api/calc/[versionId]/offer.pdf/route.ts', 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the goods table carries no money', () => {
  it('an item is a descriptor: no price, no baza, no rate — structurally', () => {
    // A compile-time fence: adding a money field to the item type makes this
    // object literal fail typecheck (`pnpm typecheck` types tests/).
    const item: OfferSheetItem = {
      seq: 1,
      label: 'x',
      quantity: 1,
      unit: null,
      weightKg: null,
      volumeM3: null,
    };
    const keys = Object.keys(item).sort();
    expect(keys).toEqual(['label', 'quantity', 'seq', 'unit', 'volumeM3', 'weightKg']);
    for (const key of keys) expect(key).not.toMatch(/usd|price|baza|duty|vat|fee|customs/i);
  });

  it('the route feeds the sheet from the request items, never from the sealed breakdown', () => {
    const route = code(ROUTE);
    expect(route).toContain('calcRequestItems');
    expect(route).not.toContain('breakdown');
    expect(route).not.toMatch(/bazaUsd|dutyPct|customsUsd/);
  });

  it('the builder draws the money rows from offerLines and nothing of the version', () => {
    const builder = code(BUILDER);
    expect(builder).toContain('offerLines(input, locale)');
    expect(builder).not.toMatch(/totalUsd|freightUsd|customsUsd|discountUsd|bazaUsd/);
  });
});

describe('every string on the sheet reaches the font subset', () => {
  // A glyph the subset lacks is a blank on the customer's paper with no error
  // anywhere (#788). The builder collects everything it will draw into ONE
  // list before embedding the font; this pins that the goods, the labels and
  // the callback line are in it.
  const builder = code(BUILDER);
  const subsetCall = builder.slice(builder.indexOf('cjkSubsetFor(['), builder.indexOf(']);', builder.indexOf('cjkSubsetFor([')));

  it.each([
    'company', 'address', 'phone', 'title', 'footer', 'date',
    'clientName', 'clientCode', 'clientPhone', 'docNo', 'managerName', 'managerPhone',
    'Object.values(labels)', 'items.flatMap', 'rows.flatMap',
  ])('%s is in the subset list', (needle) => {
    expect(subsetCall).toContain(needle);
  });

  it('every drawn string passes the cleaner first', () => {
    // The cleaner transliterates Uzbek Cyrillic and drops what the font
    // cannot draw. Each of these is drawn; each must be cleaned.
    for (const name of ['company', 'address', 'phone', 'title', 'footer']) {
      expect(builder).toMatch(new RegExp(`const ${name} = clean\\(`));
    }
    expect(builder).toContain('label: clean(i.label)');
    expect(builder).toContain('clean(L[k])');
  });
});
