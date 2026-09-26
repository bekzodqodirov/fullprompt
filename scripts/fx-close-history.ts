import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { applyFxHistory, fxHistoryPlan } from '../src/modules/wms/finance/fx-history';

/**
 * The kurs farqi history on deploy morning (0103; the rule lives in
 * `wms/finance/fx-history.ts`, where it can be tested):
 *
 *   pnpm fx-close-history          # prints what would close, changes nothing
 *   pnpm fx-close-history --apply  # closes the CLIENTS' residues the system owns
 *
 * On the server it runs through `migrate` (the runner image has no pnpm):
 *   docker compose run --rm migrate pnpm fx-close-history
 *
 * If it is never run, the same residues close at each client's next ledger
 * write — the script only makes that happen before the warehouse opens.
 * Firms' residues are counted and never applied: a person closes them on
 * «Buxgalteriya → Kurs qoldiqlari».
 */
const apply = process.argv.includes('--apply');

async function main() {
  const plan = await fxHistoryPlan();
  const { byState, months, firstChecks } = plan.clients;
  console.log('CLIENTS — accounts back at 0 in their own currency with dollars left over:');
  console.log(`  closed by the system (auto): ${byState.auto.count}, Σ residue $${byState.auto.usd.toFixed(2)}`);
  console.log(`  to check first (a same-size dollar row exists): ${byState.check.count}, Σ $${byState.check.usd.toFixed(2)}`);
  console.log(`  closable by hand: ${byState.closable.count}, Σ $${byState.closable.usd.toFixed(2)}`);
  console.log('  P&L effect of the auto closes by month (+ = gain):');
  for (const [month, usd] of Object.entries(months).sort()) console.log(`    ${month}  ${usd >= 0 ? '+' : '−'}$${Math.abs(usd).toFixed(2)}`);
  for (const row of firstChecks) {
    console.log(`  check: ${row.code ?? ''} ${row.name} ${row.currency} zero on ${row.anchorDate}, residue $${row.residueUsd.toFixed(2)}`);
  }
  const partners = plan.partners.byState;
  console.log(
    `FIRMS (never applied here): auto ${partners.auto}, check ${partners.check}, closable ${partners.closable}, already closed by hand ${partners.hand}`,
  );
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to close the clients\' «auto» residues.');
    return;
  }
  const done = await applyFxHistory(plan);
  console.log(`closed: ${done.rows} residue(s) on ${done.clients} client account(s)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
