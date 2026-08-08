import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_ADMIN_SECTION, isActive, isAdminSectionPage } from '@/components/ui/nav-active';
import { HUB_DOORS, openDoors } from '@/app/(protected)/admin/hub-doors';

/**
 * Round 75, the owner's item 3: "adminstrativnoedagi klientini glavniga
 * chiqaz".
 *
 * He had asked once before and the client book was moved into the Sotuv
 * group — and he asked again, because moving the TILE did not change what
 * the screen says about itself. Three things did: the «← Boshqaruv» link the
 * admin layout drew on it, its tile on the administration hub, and the
 * prefix match that lit «Boshqaruv» in the sidebar and the ••• sheet at the
 * same time as «Mijozlar».
 *
 * The behaviour half calls the real functions (#166). The source half exists
 * because both versions WORK — nothing about the rendered page can tell you
 * whether the hub still offers a second door.
 */

const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('a page that only lives under /admin is not an admin page', () => {
  it('lights «Mijozlar» and not «Boshqaruv» on the client book', () => {
    // The red-proof target: strip the borrowed-section branch from isActive
    // and these two go true — both menu rows highlighted at once.
    expect(isActive('/admin/clients', '/admin')).toBe(false);
    expect(isActive('/admin/clients/2f1a-…', '/admin')).toBe(false);
    expect(isActive('/admin/clients/new', '/admin')).toBe(false);
    // …while the row it IS on stays lit.
    expect(isActive('/admin/clients', '/admin/clients')).toBe(true);
    expect(isActive('/admin/clients/2f1a-…', '/admin/clients')).toBe(true);
  });

  it('still lights «Boshqaruv» for every real administration screen', () => {
    for (const path of ['/admin', '/admin/warehouses', '/admin/trucks', '/admin/roles']) {
      expect(isActive(path, '/admin')).toBe(true);
      expect(isAdminSectionPage(path)).toBe(true);
    }
    expect(isAdminSectionPage('/admin/clients')).toBe(false);
    expect(isAdminSectionPage('/admin/clients/2f1a-…')).toBe(false);
    // Not an /admin path at all.
    expect(isAdminSectionPage('/stock')).toBe(false);
  });

  it('keeps the two rules the highlight already had', () => {
    // `/stock` matches `/stock/abc`, `/` only matches itself.
    expect(isActive('/stock/abc', '/stock')).toBe(true);
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/stock', '/')).toBe(false);
    // A shared prefix that is not a path segment must not match.
    expect(isActive('/stockroom', '/stock')).toBe(false);
  });
});

describe('the client book is offered once, from Sotuv', () => {
  it('is not a door on the administration hub', () => {
    // The real list, not a copy of it (#166).
    expect(HUB_DOORS.map((door) => door.href)).not.toContain('/admin/clients');
    // …and every door that IS there is a real /admin page.
    for (const door of HUB_DOORS) expect(door.href.startsWith('/admin/')).toBe(true);
  });

  it('leaves nobody a «← Boshqaruv» link back to the page they are on', () => {
    // `/admin` walks a one-door visitor straight through, so the way back
    // must be drawn from the SAME list the hub counts — the logist has
    // exactly one door since the client book left, and the accountant has
    // had one since the hub was built.
    const layout = read('src/app/(protected)/admin/layout.tsx');
    // Anchored on the ASSIGNMENT, not on the word: the first version of this
    // matched the surviving `import { openDoors }` line and stayed green with
    // the layout back to answering the question itself.
    expect(layout).toMatch(/const hasHub =\s*openDoors\(/);
    const oneDoor = openDoors((code) => code === 'plans.manage');
    expect(oneDoor).toHaveLength(1);
    const many = openDoors(() => true);
    expect(many.length).toBeGreaterThan(1);
  });

  it('draws no «← Boshqaruv» link on itself', () => {
    // Source-shape: the link is client-side and its absence on one subtree
    // is not something a render test of the layout would notice.
    const back = read('src/app/(protected)/admin/admin-back.tsx');
    expect(back).toContain('isAdminSectionPage');
  });

  it('leaves the route and its gate exactly where they were', () => {
    // A URL is not access. The layout's client branch is the only reason a
    // sales manager can open a client card from their own call list, and
    // the client links already sitting in staff Telegram history point here.
    const layout = read('src/app/(protected)/admin/layout.tsx');
    expect(layout).toContain('canClients');
    expect(NOT_ADMIN_SECTION).toEqual(['/admin/clients']);
  });
});
