import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Who hears that a seal carries a concession — the owner's «4c» (round 112):
 * the owner, the seller whose job it is, the accountant. Nobody else.
 *
 * Source-shape, because `announceSeal` runs after `sealCalc`'s transaction
 * and sends through `notifyStaffTelegram`, which no integration test can
 * observe without a Telegram account; and because the defect it guards was
 * one line naming the wrong permission. Before this round the notice went to
 * `finance.debt_override` holders — a set borrowed from the handover-debt
 * approval that includes EVERY seller and every warehouse manager — so one
 * seller's discount was company news.
 */
const SRC = readFileSync('src/modules/wms/calc/workspace.ts', 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function body(name: string): string {
  const at = code.indexOf(`async function ${name}(`);
  expect(at, `${name} must exist`).toBeGreaterThan(-1);
  const rest = code.slice(at);
  return rest.slice(0, rest.indexOf('\n}\n') + 3);
}

describe('the discount notice', () => {
  const audience = body('discountAudience');
  const announce = body('announceSeal');

  it('goes to the owner, the accountant and the requester — through one helper', () => {
    expect(audience).toContain("usersWithRoles(['super_admin', 'admin'])");
    expect(audience).toContain("usersWithRoles(['accountant'])");
    expect(audience).toContain('requestedBy');
    expect(announce).toContain('discountAudience(');
  });

  it('reaches the ORIGINAL seller on a correction, whose requester is the admin who pressed recalc', () => {
    expect(audience).toContain('supersedesRequestId');
  });

  it('never again asks the debt-override holders, who include every seller', () => {
    expect(announce).not.toContain("usersWithPermission('finance.debt_override')");
    expect(audience).not.toContain('finance.debt_override');
  });
});
