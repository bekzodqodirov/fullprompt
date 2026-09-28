import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «umuman» includes Telegram (owner's Q19, 2026-09-25). A message that
 * carries the kassa, a profit or a tannarx picks its recipients from law 4's
 * grants — `finance.reports` / `finance.expenses` — or by name, and never
 * from a grant the VED holds: `finance.manage`, `finance.view`,
 * `costs.enter_batch`, `reports.all_warehouses`. Green the day it was
 * written (nothing sends to those lists), so this is the rule for the next
 * writer. An entry here needs a reason.
 */
const VED_GRANTS = ['finance.manage', 'finance.view', 'costs.enter_batch', 'reports.all_warehouses'];
const ALLOWED: Record<string, string> = {
  // 0114: the request's audience is exactly the people who may DECIDE it —
  // every `finance.debt_override` holder's grant set is rebuilt from the
  // editable grants and asked `mayGrantDebt`, so `finance.view` is READ as
  // part of «whose ledger may this person read», never used as an audience
  // of its own. The message carries no kassa, profit or tannarx.
  'src/modules/wms/issue/approvals.ts': 'recipients = mayGrantDebt over the debt_override holders',
};

const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('no Telegram audience is picked by a grant the VED holds', () => {
  it('src/ never asks usersWithPermission for one of them', () => {
    const offenders: string[] = [];
    for (const path of globSync('src/**/*.{ts,tsx}')) {
      if (ALLOWED[path]) continue;
      const source = stripComments(readFileSync(path, 'utf8'));
      for (const grant of VED_GRANTS) {
        if (source.includes(`usersWithPermission('${grant}')`)) offenders.push(`${path}: ${grant}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
