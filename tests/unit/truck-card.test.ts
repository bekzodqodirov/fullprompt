import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import {
  BATCH_TABS,
  batchTabHref,
  batchTabsFor,
  mayOpenBatchCosts,
  mayOpenBatchPricing,
  mayOpenBatchVed,
  type BatchTab,
} from '@/modules/wms/batches/card-door';
import { pricingSight } from '@/modules/wms/finance/pricing-view';

/**
 * The truck card's tabs (docs/CARD-TABS.md): ONE predicate per tab, asked by
 * the tab's page AND by the card's strip — so a drawn tab never bounces and a
 * tab a page admits is never hidden (rule 2, #1023's «a link that bounces is
 * worse than no link»).
 *
 * Two halves. Over the SEEDED roles, the tabs each person is offered — the
 * matrix is his to edit with checkboxes, so the literal lists below are the
 * shape the design was agreed on, and a change to the seed that moves one is
 * a change somebody must look at. And over the SOURCE: every tab page asks
 * exactly its tab's predicate and the card's two-ends door, and the strip
 * draws what `batchTabsFor` answers and nothing else.
 */

const ROLES = Object.keys(ROLE_MATRIX) as RoleCode[];
const PAGES = 'src/app/(protected)/batches/[id]';
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function actor(role: RoleCode) {
  return {
    id: `user-${role}`,
    permissions: new Set<string>(ROLE_MATRIX[role]),
    warehouseScoped: WAREHOUSE_SCOPED_ROLES.includes(role),
    warehouseIds: [] as string[],
  };
}

/** The page file that `batchTabHref` points a tab at. */
function pageOf(tab: BatchTab): string {
  const rest = batchTabHref('ID', tab).replace(/^\/batches\/ID/, '');
  return `${PAGES}${rest}/page.tsx`;
}

describe('the tabs each seeded role is offered', () => {
  const ALL: BatchTab[] = [...BATCH_TABS];
  const SHELF: BatchTab[] = ['tarkib', 'yuklash', 'mashina'];
  const expected: Record<RoleCode, BatchTab[]> = {
    super_admin: ALL,
    admin: ALL,
    // Plans the truck and enters its bills; never the client's price.
    logist: ['tarkib', 'yuklash', 'xarajat', 'bojxona', 'mashina'],
    // Prices trucks (#108) — through the price-only view (Q19).
    ved_manager: ALL,
    warehouse_manager: SHELF,
    warehouse_operator: SHELF,
    sales_manager: SHELF,
    accountant: ['tarkib', 'yuklash', 'xarajat', 'narx', 'mashina'],
    viewer: ['tarkib', 'yuklash', 'xarajat', 'mashina'],
  };

  it('matches the design’s table, role by role', () => {
    for (const role of ROLES) {
      expect(batchTabsFor(actor(role), false), role).toEqual(expected[role]);
    }
  });

  it('a leg inside China is never priced, so the VED — who sees prices and never costs — loses «Narx» there', () => {
    expect(batchTabsFor(actor('ved_manager'), true)).not.toContain('narx');
    // Whoever reads the whole money keeps it: on an internal leg it is the cost page (C1a).
    expect(batchTabsFor(actor('accountant'), true)).toContain('narx');
    expect(batchTabsFor(actor('super_admin'), true)).toContain('narx');
  });

  it('every predicate is the page’s own rule, for every role and both kinds of leg', () => {
    for (const role of ROLES) {
      const who = actor(role);
      for (const internal of [false, true]) {
        const tabs = batchTabsFor(who, internal);
        expect(tabs.includes('xarajat'), `${role} xarajat`).toBe(mayOpenBatchCosts(who.permissions));
        expect(tabs.includes('bojxona'), `${role} bojxona`).toBe(mayOpenBatchVed(who.permissions));
        // The pricing page redirects exactly when its sight is 'none'.
        expect(tabs.includes('narx'), `${role} narx ${internal}`).toBe(
          pricingSight(who.permissions, internal) !== 'none',
        );
        expect(mayOpenBatchPricing(who.permissions, internal)).toBe(tabs.includes('narx'));
        // The card door is the only door of the other three.
        for (const tab of ['tarkib', 'yuklash', 'mashina'] as const) expect(tabs).toContain(tab);
      }
    }
  });
});

describe('each tab page asks its own tab’s door', () => {
  it('every tab has a page at the address the strip links to', () => {
    for (const tab of BATCH_TABS) expect(existsSync(join(process.cwd(), pageOf(tab))), tab).toBe(true);
  });

  it('…which renders the card with ITS tab lit, titles itself by it, and asks the two-ends door before anything', () => {
    for (const tab of BATCH_TABS) {
      const src = strip(read(pageOf(tab)));
      expect(src, tab).toContain(`active="${tab}"`);
      expect(src, tab).toContain(`batchTabMetadata((await params).id, '${tab}')`);
      const door = src.indexOf('if (!mayOpenBatchCard(actor, head.batch)) notFound();');
      expect(door, `${tab}: the card door`).toBeGreaterThan(0);
      // The door is asked before the card is drawn.
      expect(src.indexOf('<BatchCard'), tab).toBeGreaterThan(door);
    }
  });

  it('the money and the papers ask the SAME predicates the strip asks', () => {
    const costs = strip(read(pageOf('xarajat')));
    expect(costs).toContain("if (!mayOpenBatchCosts(actor.permissions)) redirect('/');");
    const ved = strip(read(pageOf('bojxona')));
    expect(ved).toContain("if (!mayOpenBatchVed(actor.permissions)) redirect('/');");
    // The pricing page decides by its sight — the strip's predicate is that
    // sight's «not none» (asserted over every role above).
    const price = strip(read(pageOf('narx')));
    expect(price).toContain('const sight = pricingSight(actor.permissions, internal);');
    expect(price).toContain("if (sight === 'none') redirect(`/batches/${id}`);");
    expect(price).toContain('const internal = head.internal;');
  });

  it('no tab page keeps a permission redirect of its own beside its door', () => {
    for (const tab of BATCH_TABS) {
      const src = strip(read(pageOf(tab)));
      const redirects = [...src.matchAll(/if \(([^)]*(?:\([^)]*\))?[^)]*)\) redirect\('\/'\);/g)].map((m) => m[1]);
      const allowed: Record<BatchTab, string[]> = {
        tarkib: [],
        yuklash: [],
        xarajat: ['!mayOpenBatchCosts(actor.permissions)'],
        // pricingSight is 'none' without finance.manage, so this is the
        // same rule, asked early (before the head is read).
        narx: ["!actor.permissions.has('finance.manage')"],
        bojxona: ['!mayOpenBatchVed(actor.permissions)'],
        mashina: [],
      };
      expect(redirects, tab).toEqual(allowed[tab]);
    }
  });

  it('the scan screens, a door away, ask the card’s door too', () => {
    for (const screen of ['load', 'unload']) {
      const src = strip(read(`${PAGES}/${screen}/page.tsx`));
      expect(src, screen).toContain('if (!mayOpenBatchCard(actor, batch)) notFound();');
    }
  });
});

describe('the strip and the header', () => {
  const card = strip(read(`${PAGES}/batch-card.tsx`));

  it('the strip draws what batchTabsFor answers and nothing else', () => {
    expect(card).toContain('const tabs = batchTabsFor(actor, head.internal);');
    expect(card).not.toMatch(/BATCH_TABS\s*\.(map|filter|forEach)/);
  });

  it('each «Qolgan ishlar» chip asks the door of the tab it links to', () => {
    const push = (testid: string) => {
      const at = card.indexOf(`testid: '${testid}'`);
      expect(at, testid).toBeGreaterThan(0);
      // The nearest `if (` above the push is its gate.
      return card.slice(card.lastIndexOf('if (', at), at);
    };
    expect(push('batch-todo-no-costs')).toContain('costDoor');
    expect(card).toContain('const costDoor = mayOpenBatchCosts(actor.permissions);');
    expect(card.slice(card.lastIndexOf('if (mayOpenBatchVed', card.indexOf("testid: 'batch-todo-tnved'")))).toMatch(
      /^if \(mayOpenBatchVed\(actor\.permissions\)/,
    );
    // «Agentga yuborilmagan» is pressed only by ved.docs (the button is
    // theirs), a subset of the tab's door.
    expect(push('batch-todo-agent')).toContain("actor.permissions.has('ved.docs')");
    expect(push('batch-todo-agent')).toContain('batchDocsPending(id)');
  });

  it('the header’s money figures are behind their tabs’ doors (Q19: no cost to the VED)', () => {
    expect(card).toContain("const costSheet = costDoor ? await soft('cost sheet', () => batchCostSheet(id, costSightFor(actor))) : null;");
    expect(card).toContain('const sight = pricingSight(actor.permissions, head.internal);');
    expect(card).toContain('full ? batchLandedCostByLot(id) : Promise.resolve(new Map<string, LotLandedCost>())');
  });
});
