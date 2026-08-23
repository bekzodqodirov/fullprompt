import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The doors around a client price, pinned as SOURCE SHAPE.
 *
 * Every one of them calls `getActor`/`authorize`, so no integration test can
 * press any of them — a service-level test of a form-fed path proves the
 * service and not the system, which #531 recorded and rounds 90 and 98 each
 * had to restate. So the wiring is read as text, with comments stripped
 * first: my own sentence explaining why a gate changed must not satisfy an
 * assertion about the gate (#725, and it caught this file's sibling once).
 */
const read = (p: string) => readFileSync(p, 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const PAGE = read('src/app/(protected)/upsale/page.tsx');
const ACTIONS = read('src/app/(protected)/upsale/actions.ts');
const FORM = read('src/app/(protected)/upsale/pay-form.tsx');
const SCOPE = read('src/modules/wms/calc/upsale-scope.ts');
const SERVICE = read('src/modules/wms/calc/upsale-service.ts');
const NAV = read('src/modules/platform/rbac/nav.ts');

describe('the upsale screen’s own door', () => {
  it('refuses the VED outright rather than rendering them an empty table', () => {
    expect(code(PAGE)).toContain('upsaleScopeFor(actor)');
    expect(code(PAGE)).toContain("if (scope === 'none') redirect('/')");
  });

  it('catches its own reads so deploy morning is a sentence, not a digest', () => {
    expect(code(PAGE)).toContain('isServerBehind(err)');
  });

  it('offers the pay form only to somebody who may both spend and see', () => {
    // Either grant alone is the wrong door: `finance.expenses` alone would let
    // anyone who may spend money read every seller's earnings, and the scope
    // alone would let a read-only analyst press pay.
    expect(code(PAGE)).toContain("actor.permissions.has('finance.expenses')");
    expect(code(PAGE)).toContain("scope === 'all'");
  });
});

describe('the actions re-derive every gate', () => {
  it('paying asks for BOTH powers, server-side', () => {
    const body = code(ACTIONS).slice(code(ACTIONS).indexOf('export async function payUpsaleAction'));
    expect(body).toContain("actor.permissions.has('finance.expenses')");
    expect(body).toContain("upsaleScopeFor(actor) !== 'all'");
  });

  it('allowing a below-floor price asks law 4’s own predicate', () => {
    const body = code(ACTIONS).slice(code(ACTIONS).indexOf('export async function releaseOfferAction'));
    expect(body).toContain('mayApproveBelowFloor(actor)');
  });
});

describe('the amount is the server’s', () => {
  it('the form posts WHICH jobs, never how much', () => {
    // A typed figure is how a screen says «$340 paid» while $200 leaves the
    // till. The total on screen is rendered from the ticks.
    expect(code(FORM)).toContain('payUpsaleAction(picked');
    expect(code(FORM)).not.toContain('amount:');
  });

  it('and the service derives it from the payable rule itself', () => {
    const body = code(SERVICE).slice(code(SERVICE).indexOf('export async function payUpsale'));
    expect(body).toContain('payableOffersSql()');
    expect(body).toContain('payout_expense_id IS NULL');
  });

  it('the claim sets all four payout columns in ONE statement', () => {
    // `calc_offers_payout_pair_check` says paid is all four or none, and it
    // caught the first version of this function writing them in two steps.
    const claim = code(SERVICE).slice(code(SERVICE).indexOf('UPDATE calc_offers o'));
    for (const col of ['payout_expense_id =', 'payout_at =', 'payout_by =', 'payout_usd =']) {
      expect(claim.slice(0, 600)).toContain(col);
    }
  });
});

describe('law 4 in the menu', () => {
  it('the route is offered to the seller and the accountant, never to the VED', () => {
    // Comments stripped and the slice bounded by the NEXT entry: a 400-char
    // window ran into `/hisoblash`, whose permissions are `ved.docs` — the
    // assertion was reading the neighbour's door, which is worse than useless
    // because it would have passed for the wrong reason too.
    const nav = code(NAV);
    const at = nav.indexOf("href: '/upsale'");
    expect(at).toBeGreaterThan(-1);
    const next = nav.indexOf('href:', at + 10);
    const spec = nav.slice(at, next > 0 ? next : at + 400);
    expect(spec).toContain("permissions: ['finance.reports', 'crm.leads']");
    expect(spec).not.toContain('ved.docs');
  });

  it('and the predicate it mirrors excludes the VED for the measured reason', () => {
    // `seesAllMoney` is finance.manage || clients.manage, and ved_manager
    // holds finance.manage — so the obvious predicate answers TRUE for
    // exactly the person law 4 excludes.
    expect(code(SCOPE)).toContain("has('finance.reports')");
    expect(code(SCOPE)).not.toContain("has('finance.manage')");
  });
});
