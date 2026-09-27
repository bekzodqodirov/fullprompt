import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRATE_KINDS, CRATE_KIND_MARKER, crateMarker } from '@/modules/wms/labels/crate-kind';

/**
 * A pallet is a crate (0112, the owner's Q10 d), and its label says ПАЛЛЕТ.
 *
 * The PDF embeds a font SUBSET built from the strings it is told it will
 * draw; a glyph missing from that list prints as a blank box with no error
 * anywhere (#788). The subset used to be the literal 'ЯЩИК КАРКАС' — П, Л, Е
 * and Т are not in it — so the list must be built FROM the marker map.
 */

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the crate kind marker', () => {
  it('names every kind the schema allows', () => {
    expect([...CRATE_KINDS]).toEqual(['yashik', 'karkas', 'palet']);
    expect(crateMarker('palet')).toBe('ПАЛЛЕТ');
    expect(crateMarker('karkas')).toBe('КАРКАС');
    expect(crateMarker('yashik')).toBe('ЯЩИК');
    expect(crateMarker('nobody-knows')).toBe('ЯЩИК');
  });

  it('feeds the PDF font subset from the map, so every marker glyph is embedded', () => {
    const renderer = strip(readFileSync('src/modules/wms/labels/renderer.ts', 'utf8'));
    const call = /cjkSubsetFor\(\[([^\]]*)\]/.exec(renderer.slice(renderer.indexOf('renderCrateLabel')));
    expect(call, 'renderCrateLabel builds its subset').not.toBeNull();
    expect(call![1]).toContain('CRATE_KIND_MARKER');
    expect(call![1]).not.toMatch(/'ЯЩИК КАРКАС'/);
    // …and it DRAWS from the same map.
    expect(renderer).toMatch(/const marker = crateMarker\(label\.kind\)/);
    // Every glyph the markers need is a glyph the list carries.
    const subsetText = Object.values(CRATE_KIND_MARKER).join(' ');
    for (const marker of Object.values(CRATE_KIND_MARKER)) {
      for (const ch of marker) expect(subsetText).toContain(ch);
    }
  });

  it('prints the same marker on the phone print sheet', () => {
    const svg = strip(readFileSync('src/components/label-svg.tsx', 'utf8'));
    expect(svg).toContain('crateMarker(label.kind)');
    expect(svg).not.toMatch(/'КАРКАС'|'ЯЩИК'/);
  });
});
