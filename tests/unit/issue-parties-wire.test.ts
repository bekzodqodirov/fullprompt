import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ISSUABLE_STATUSES } from '@/modules/wms/issue/parties';

/**
 * The handover list and the box screen must agree about «issuable», and the
 * list's phone numbers must not be reachable by anyone who cannot hand cargo
 * over at that warehouse. Neither is visible in behaviour: a list built on a
 * wider predicate renders perfectly and opens onto an empty box screen, and an
 * ungated route answers every logged-in browser with the same JSON the screen
 * shows.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

describe('the handover list', () => {
  it('and the box screen read ONE definition of issuable', () => {
    expect([...ISSUABLE_STATUSES]).toEqual(['ready_for_pickup', 'in_stock']);
    const route = read('src/app/api/issue/list/route.ts');
    expect(route, 'the box list restates the statuses instead of importing them').toContain(
      'ISSUABLE_STATUSES',
    );
    expect(route, 'a literal status list is a second definition').not.toMatch(
      /\[\s*'ready_for_pickup'\s*,\s*'in_stock'\s*\]/,
    );
  });

  it('is gated on scan.issue AT the warehouse it names', () => {
    const route = read('src/app/api/issue/parties/route.ts');
    // The pair, not the permission alone: a uuid in the address bar must not
    // read another warehouse's customers and their phone numbers (#514).
    expect(route).toMatch(/authorize\('scan\.issue',\s*\{\s*warehouseId/);
    expect(route, 'a private list must not be cached').toContain('no-store');
  });

  it('never offers unclaimed cargo as somebody to hand over to', () => {
    // It is a LINK to the prixod. Selecting it would put the screen into a
    // state with no client to bill, no debt to check and nobody to sign.
    const screen = read('src/app/(protected)/issue/issue-screen.tsx');
    const unclaimed = screen.slice(screen.indexOf('issue-unclaimed') - 600);
    const row = unclaimed.slice(0, unclaimed.indexOf('</a>'));
    expect(row, 'the unclaimed row must not be a button').not.toContain('setClient(');
    expect(row).toContain('/receipts/');
  });

  it('asks ONE door whether a prixod may be read', () => {
    /**
     * The rule itself is proven behaviourally in
     * `tests/integration/receipt-door.integration.test.ts` — it had to be,
     * because this file's first version asserted the helper's NAME and stayed
     * green when the call was wrapped in `false &&` (#166, and #531: a rule
     * living inside a server component can only be grepped for). All that is
     * left here is that the page delegates and states nothing itself.
     */
    const page = read('src/app/(protected)/receipts/[id]/page.tsx');
    expect(page).toContain('mayReadReceipt(actor,');
    expect(page, 'the page must not restate the scope rule').not.toMatch(
      /inScope\(actor, receipt\.warehouseId\)|batches\.originWarehouseId/,
    );
  });

  it('draws the waiting list only while no client is chosen', () => {
    const screen = read('src/app/(protected)/issue/issue-screen.tsx');
    expect(screen).toMatch(/\{!client && \(\s*<section[^>]*data-testid="issue-parties"/);
  });
});
