import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { retireTaskCopies } from '../src/modules/platform/notifications/retire-tasks';
import {
  calcGhostTasks,
  cancelCalcGhostTasks,
  closeStaleCalcTasks,
  staleCalcTasks,
} from '../src/modules/wms/calc/stale-tasks';

/**
 * One-off cleanup for the owner's item 5 (the rules live in
 * `wms/calc/stale-tasks.ts`, where they can be tested):
 *
 *   pnpm close-stale-calc-tasks                   # counts them and prints, changes nothing
 *   pnpm close-stale-calc-tasks --apply           # closes them (the meaning he was told)
 *   pnpm close-stale-calc-tasks --ghosts          # lists the release ghosts, changes nothing
 *   pnpm close-stale-calc-tasks --ghosts --apply  # cancels the ghosts — only on his word
 *
 * The ghosts have their OWN flag (review data-migration-5): a second plain
 * `--apply` must keep doing nothing, as he was told on 2026-09-19, and must
 * never start closing tasks he never saw listed.
 *
 * The Telegram copies of what changed are retired AFTER the statement and
 * AWAITED here, before the pool closes — the one caller allowed to wait on
 * them (review telegram-mechanics-7).
 */
const apply = process.argv.includes('--apply');
const ghosts = process.argv.includes('--ghosts');

async function main() {
  if (ghosts) {
    const rows = await calcGhostTasks();
    console.log(`open calc tasks no request points at (release ghosts): ${rows.length}`);
    for (const row of rows) {
      console.log(
        `  ${row.createdAt.toISOString().slice(0, 10)}  ${row.authorName ?? '—'} → ${row.assigneeName ?? '—'}  ${row.title.slice(0, 60)}`,
      );
    }
    if (!apply) {
      console.log('\nDRY RUN — nothing changed. Re-run with --ghosts --apply to cancel them («Navbatga qaytarildi»).');
      return;
    }
    if (rows.length === 0) return;
    const cancelled = await cancelCalcGhostTasks();
    await retireTaskCopies({ taskIds: cancelled, outcome: 'cancelled' });
    console.log(`cancelled: ${cancelled.length}`);
    return;
  }

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
  const closed = await closeStaleCalcTasks();
  await retireTaskCopies({ taskIds: closed, outcome: 'done' });
  console.log(`closed: ${closed.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
