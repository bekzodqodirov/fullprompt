import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, pgClient } from '@/modules/platform/db/client';
import { permissions, rolePermissions, roles } from '@/modules/platform/db/schema';
import { calcControlScopeFor, calcRegistrySight, mayReadCalcRegistry } from '@/modules/wms/calc/control-scope';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import { pricingSight } from '@/modules/wms/finance/pricing-view';

/**
 * Who sees the two icons (0119), over the matrix HE edits with checkboxes —
 * read from the database, every seeded role plus an invented one, because
 * the exclusion is a property of the grants and not of a list in the code
 * (#790's lesson: a permission fix is half-verified until a role that is
 * not the admin is walked through it).
 *
 * The page's three gates, each asked as the page asks it:
 *   · reaching «Narx» at all — `pricingSight(permissions, internal)`;
 *   · the cost and margin columns — `sight === 'full'`;
 *   · the deal's client price and upsale — `upsaleScopeFor(actor) === 'all'`;
 * and the icon's own: 🧮 only behind `calcRegistrySight(actor)`. 📈 follows the
 * page itself — a past truck's price is the figure the VED types there.
 */
type Perms = Set<string>;
const actorOf = (codes: Perms) => ({ permissions: codes });

async function seededRoles(): Promise<Map<string, Perms>> {
  const rows = await db
    .select({ role: roles.code, perm: permissions.code })
    .from(roles)
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId));
  const out = new Map<string, Perms>();
  for (const r of rows) {
    const set = out.get(r.role) ?? new Set<string>();
    if (r.perm) set.add(r.perm);
    out.set(r.role, set);
  }
  // Invented: somebody given the money book and nothing else.
  out.set('invented_finance_manage_only', new Set(['finance.manage']));
  return out;
}

/** What the pricing page would draw for this person on an ordinary (not internal) truck. */
function pageFor(codes: Perms) {
  const sight = pricingSight(codes, false);
  const reach = sight !== 'none';
  return {
    reach,
    cost: reach && sight === 'full',
    dealPrice: reach && upsaleScopeFor(actorOf(codes)) === 'all',
    history: reach,
    sheet: reach && calcRegistrySight(actorOf(codes)) !== null,
  };
}

afterAll(async () => {
  await pgClient.end();
});

describe('the icons across every role the database holds', () => {
  it('the matrix is the seeded one (a fence that reads nothing proves nothing)', async () => {
    const matrix = await seededRoles();
    for (const code of ['super_admin', 'admin', 'accountant', 'ved_manager', 'logist', 'sales_manager']) {
      expect(matrix.has(code), code).toBe(true);
    }
  });

  it('the named people, as the owner described them (19, 26a)', async () => {
    const matrix = await seededRoles();
    expect(pageFor(matrix.get('accountant')!)).toEqual({
      reach: true,
      cost: true,
      dealPrice: true,
      history: true,
      sheet: true,
    });
    // The VED: the page, both icons, the calculation's total — and never a
    // cost, a margin, a client price or an upsale (law 4, Q19).
    expect(pageFor(matrix.get('ved_manager')!)).toEqual({
      reach: true,
      cost: false,
      dealPrice: false,
      history: true,
      sheet: true,
    });
    for (const role of ['sales_manager', 'logist', 'warehouse_operator', 'viewer']) {
      if (!matrix.has(role)) continue;
      expect(pageFor(matrix.get(role)!).reach, role).toBe(false);
    }
    // The money book alone opens the page and its costs, but not a calculation.
    expect(pageFor(matrix.get('invented_finance_manage_only')!)).toMatchObject({ reach: true, sheet: false });
  });

  it('LAWS over every role: the sheet is the registry\'s audience, and the VED never sees a client price', async () => {
    const matrix = await seededRoles();
    for (const [role, codes] of matrix) {
      const page = pageFor(codes);
      // 🧮 ⇔ the registry's door, on the page.
      expect(page.sheet, role).toBe(page.reach && mayReadCalcRegistry(actorOf(codes)));
      // A holder of ved.docs without finance.reports is the VED of law 4.
      if (codes.has('ved.docs') && !codes.has('finance.reports')) {
        expect(page.dealPrice, role).toBe(false);
        expect(page.cost, role).toBe(false);
      }
      // Whoever the bot asks (ved.docs ∪ finance.reports) can open the screen it links to.
      const asked = codes.has('ved.docs') || codes.has('finance.reports');
      expect(calcControlScopeFor(actorOf(codes)) !== 'none', role).toBe(asked);
    }
  });

  it('the AI door asks the page\'s own questions — finance.manage, the card, the sight', () => {
    const route = readFileSync('src/app/api/pricing/similar/[lotId]/route.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(route).toMatch(/permissions\.has\('finance\.manage'\)/);
    expect(route).toMatch(/mayOpenBatchCard\(actor, head\.batch\)/);
    expect(route).toMatch(/pricingSight\(actor\.permissions, head\.internal\) === 'none'/);
    expect(route).toMatch(/private, no-store/);
  });

  it('a history row carries no cost, margin or tannarx for the VED to read (Q19)', async () => {
    const source = readFileSync('src/modules/wms/finance/price-history.ts', 'utf8');
    const body = /export interface PriceHistoryRow \{([\s\S]*?)\n\}/.exec(source)![1]!;
    const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
    expect(fields.length).toBeGreaterThan(10);
    for (const f of fields) expect(f).not.toMatch(/cost|margin|tannarx|landed|profit|floor|upsale/i);
    // And the read never touches the cost ledger.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/cost_allocations|cost_entries|calc_offers|quoted_amount/);
  });

  it('ai_calc_passes: a «similar» pass has no request, every other kind has one', async () => {
    const refused = async (kind: string, requestId: string | null) => {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO ai_calc_passes (kind, request_id, model, input_tokens, output_tokens)
            VALUES (${kind}, ${requestId}::uuid, 'test', 1, 1)`);
          throw new Error('rollback');
        });
        return 'ok';
      } catch (err) {
        const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
        return (err as Error).message === 'rollback' ? 'ok' : String(code);
      }
    };
    const anyRequest = (await db.execute<{ id: string }>(sql`SELECT id::text AS id FROM calc_requests LIMIT 1`))[0]?.id;
    expect(await refused('similar', null)).toBe('ok');
    expect(await refused('pick', null)).toBe('23514');
    if (anyRequest) {
      expect(await refused('similar', anyRequest)).toBe('23514');
      expect(await refused('pick', anyRequest)).toBe('ok');
    } else {
      // A fresh database may hold no request at all; the null half is the one
      // the page's own writer can reach, and it is asserted above.
      expect(await refused('similar', '00000000-0000-0000-0000-000000000001')).toBe('23514');
    }
  });
});
