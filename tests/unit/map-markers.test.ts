import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The two map renderers must draw the SAME truck, in the same place (owner,
 * round 109 after the deploy: «mashinalar iconkasini ozgartirmabsan va
 * mashinalar iconi bn soni alohida turibti»).
 *
 * Which renderer a person sees depends on the SERVER — the basemap file —
 * so a marker fixed in one and not the other is a fix half the company
 * cannot see. Source-shape because the Leaflet half cannot run here or in
 * CI: it needs the basemap tiles, and its geometry lives in a string of
 * HTML that only a browser resolves.
 */

const LEAFLET = readFileSync('src/app/(protected)/map/leaflet-corridor.tsx', 'utf8');
const SVG = readFileSync('src/app/(protected)/map/tracking-map.tsx', 'utf8');

/** The lorry silhouette, drawn once and copied nowhere else. */
const LORRY = 'M35 5 H17 V11 H12 L6 17 V22 H35 Z';

describe('the map markers', () => {
  it('draw the same lorry in both renderers', () => {
    expect(LEAFLET).toContain(LORRY);
    expect(SVG).toContain(LORRY);
  });

  it('anchor the truck label so it cannot displace the icon', () => {
    // MEASURED before the fix: the code was a BLOCK above the svg, and
    // Tailwind's preflight makes `svg` display:block — so the lorry sat
    // 24 px left and 18 px BELOW its own coordinate while the label floated
    // over open map. Absolute positioning is what keeps the icon on the road.
    const truckIcon = LEAFLET.slice(LEAFLET.indexOf('for (const tr of trucks)', LEAFLET.indexOf('L.divIcon')));
    const html = truckIcon.slice(truckIcon.indexOf('html:'), truckIcon.indexOf('iconSize'));
    expect(html).toContain('position:absolute');
  });

  it('give the truck an icon box the size of its lorry, anchored at its centre', () => {
    // The three numbers must agree or Leaflet puts the marker somewhere the
    // truck is not: the wrapper's box, the declared iconSize, and the anchor.
    expect(LEAFLET).toContain('width:38px;height:28px');
    expect(LEAFLET).toContain('iconSize: [38, 28]');
    expect(LEAFLET).toContain('iconAnchor: [19, 14]');
  });

  it('keep the warehouse count on the icon, not in the label box', () => {
    // Round 109's first half, and the reason the warehouses read correctly
    // while the trucks did not: the badge is positioned against an
    // inline-block wrapping the icon, never against the wider label box.
    expect(LEAFLET).toContain('position:relative;display:inline-block;line-height:0');
    expect(LEAFLET).toContain('top:-6px;right:-9px');
  });
});
