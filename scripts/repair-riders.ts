import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { applyRiderRepair, riderRepairPlan } from '../src/modules/wms/costing/rider-repair';

/**
 * One-off re-split for allocations written before the rider rule (audit
 * U17/U25/U18; the rule lives in `wms/costing/rider-repair.ts`, where it can
 * be tested):
 *
 *   pnpm repair-riders          # counts what would move, changes nothing
 *   pnpm repair-riders --apply  # re-splits those trucks' costs
 *
 * Only the per-box shares move — the dollars are frozen (R1), so the P&L, the
 * partner debts and the kassa stay exactly where they are; past trucks'
 * tannarx and «Partiya foydasi» do move, and that is the correction.
 */
const apply = process.argv.includes('--apply');

async function main() {
  const plan = await riderRepairPlan();
  console.log(`trucks carrying a carton found back at their origin: ${plan.leftBehind.length}`);
  for (const row of plan.leftBehind.slice(0, 20)) {
    console.log(`  ${row.code}  ${row.boxes} box(es), $${row.usd.toFixed(2)} of its costs still on them`);
  }
  console.log(`trucks a carton came off without a load scan: ${plan.rogue.length}`);
  for (const row of plan.rogue.slice(0, 20)) console.log(`  ${row.code}  ${row.boxes} box(es)`);
  console.log(`prixod grid cells stamped with a truck: ${plan.stampedCells.length}`);
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to re-split them.');
    return;
  }
  const done = await applyRiderRepair(plan);
  console.log(`re-split: ${done.trucks} trucks, ${done.entries} cost entries`);
  // Every failure is named and the rest still ran; the exit code says it,
  // so a rerun is known to be owed.
  if (done.failed.length) {
    const codes = new Map([...plan.leftBehind, ...plan.rogue].map((row) => [row.batchId, row.code]));
    console.error(`FAILED: ${done.failed.length} (the rest were re-split)`);
    for (const row of done.failed) {
      const truck = codes.get(row.batchId) ?? row.batchId;
      console.error(`  truck ${truck}${row.entryId ? ` cell ${row.entryId}` : ''}: ${row.message}`);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
