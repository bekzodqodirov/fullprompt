import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The admin dashboard must not live inside the role-flow branch (round 109,
 * the owner: «dashboard menda korinmadiku super adminda nega unday
 * bolyabti»). Round 107 drew it only when `buildHomeFlow` answered null,
 * and an admin who also carries a working role has a flow — so the one
 * person it was built for was the one person who never saw it.
 *
 * Source-shape on purpose: both arrangements COMPILE, both render for a
 * pure admin, and the difference shows only for an actor holding a working
 * role — which in a browser test means granting one, and a role is
 * CONFIGURATION every later spec would then inherit (#183).
 */

const SOURCE = readFileSync('src/app/(protected)/page.tsx', 'utf8');

/** The `{flow ? ( … )}` expression, by balancing braces from its opening. */
function flowBranch(source: string): string {
  const start = source.indexOf('{flow ? (');
  expect(start, 'the home screen must still branch on the role flow').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('the flow branch never closes');
}

describe('the admin dashboard on home', () => {
  it('is drawn on its own condition, not the flow’s', () => {
    expect(SOURCE).toContain('isAnalyst(actor) ? <AdminDashboard');
  });

  it('is not inside the role-flow branch', () => {
    // Anywhere in there — else-branch, or one of the five arms — and an
    // admin who also sells, receives or keeps the books loses it again.
    expect(flowBranch(SOURCE)).not.toContain('AdminDashboard');
  });
});
