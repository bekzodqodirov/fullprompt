import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sellerReportScopeFor } from '@/modules/wms/crm/seller-report-scope';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import type { Actor } from '@/modules/platform/rbac/authorize';

/**
 * «Tannarx korinmasin sotuvchiga» (owner, 2026-08-25) — the whole law of the
 * seller report, tested three ways: the door per seeded role, the own
 * SHAPE's inability to carry a cost, and the own CODE PATH's inability to
 * compute one.
 */
const actorWith = (perms: string[]): Actor =>
  ({ id: 'test', permissions: new Set(perms) }) as unknown as Actor;

const roleActor = (role: keyof typeof ROLE_MATRIX) => actorWith([...ROLE_MATRIX[role]]);

describe('who reads the seller report', () => {
  it('walks every seeded role through the door', () => {
    // The exclusion is a property of the matrix the owner edits — test the
    // MATRIX, not two hand-picked roles (#790's lesson).
    expect(sellerReportScopeFor(roleActor('accountant'))).toBe('all');
    // The seller reads their own, and only volume/revenue.
    expect(sellerReportScopeFor(roleActor('sales_manager'))).toBe('own');
    // The VED computes floors all day and reads client money never (law 4).
    expect(sellerReportScopeFor(roleActor('ved_manager'))).toBe('none');
    // The logist holds crm.leads but is nobody's sales manager — offering
    // them the report would offer a permanently empty row.
    expect(sellerReportScopeFor(roleActor('logist'))).toBe('none');
    expect(sellerReportScopeFor(roleActor('warehouse_operator'))).toBe('none');
    expect(sellerReportScopeFor(roleActor('viewer'))).toBe('none');
  });
});

describe('the own path cannot produce a cost', () => {
  const SRC = readFileSync('src/modules/wms/crm/seller-report.ts', 'utf8');

  it('nothing below the OWN marker names a cost source', () => {
    // The split is structural: the seller's function must not be able to
    // compute a profit even by a later edit's mistake. The marker line is
    // the fence's anchor — moving it without moving the rule turns this red.
    const marker = SRC.indexOf('/* OWN ');
    expect(marker).toBeGreaterThan(0);
    // Comments stripped first, or the rule's own prose mints the match the
    // way #725's sentence minted a pooled function called `for`.
    const own = SRC.slice(marker)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(own).not.toContain('profitByClient');
    expect(own).not.toContain('costEntries');
    expect(own).not.toContain('costAllocations');
  });

  it('the own return type carries no cost-derived property', () => {
    // SellerOwnRow = SellerCargo, and SellerCargo's members are the fence:
    // a profitUsd added there would surface on the seller's card.
    const cargo = SRC.slice(SRC.indexOf('export interface SellerCargo'));
    const body = cargo.slice(0, cargo.indexOf('}'));
    expect(body).not.toMatch(/profit|cost|margin/i);
  });

  it('the screen gates the table on the scope, not on a permission it re-invents', () => {
    const page = readFileSync('src/app/(protected)/reports/sotuvchilar/page.tsx', 'utf8');
    expect(page).toContain('sellerReportScopeFor(actor)');
    expect(page).toContain("if (scope === 'none') redirect('/')");
    // The profit table renders only from the all-shape's own data.
    expect(page).not.toContain('own.profitUsd');
  });
});
