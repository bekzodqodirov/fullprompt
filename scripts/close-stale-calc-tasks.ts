import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { closeStaleCalcTasks, staleCalcTasks } from '../src/modules/wms/calc/stale-tasks';

/**
 * One-off cleanup for the owner's item 5 (the rule itself lives in
 * `wms/calc/stale-tasks.ts`, where it can be tested):
 *
 *   pnpm close-stale-calc-tasks          # counts them and prints, changes nothing
 *   pnpm close-stale-calc-tasks --apply  # closes them
 */
const apply = process.argv.includes('--apply');

async function main() {
  const stale = await staleCalcTasks();
  console.log(`open tasks on finished calculations: ${stale.length}`);
  for (const row of stale.slice(0, 10)) {
    console.log(`  ${row.dueAt?.toISOString().slice(0, 10) ?? '—'}  ${row.title.slice(0, 60)}`);
  }
  if (stale.length > 10) console.log(`  … and ${stale.length - 10} more`);
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to close them.');
    return;
  }
  if (stale.length === 0) return;
  console.log(`closed: ${await closeStaleCalcTasks()}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
