import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { offTheOneColumn, resplitApply, resplitPlan, resplitStored, sameShares } from '../src/modules/wms/costing/freight-resplit';

/**
 * His 2b's one-shot re-split (docs/YOLKIRA-TAQSIMOT.md §15.5). The dry run is
 * read-only and lists only the bills the lot grain would change — «0 ta hisob
 * o'zgaradi» is the expected answer on his server:
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/freight-resplit.ts          # lists, changes nothing
 *   docker compose run --rm migrate pnpm exec tsx scripts/freight-resplit.ts --apply  # re-splits them by lot
 *
 * Not a package.json command on purpose: a changed package.json re-runs the
 * image's install, which needs npm's registry on deploy morning (#1228).
 */
const apply = process.argv.includes('--apply');
const money = (rows: { label: string; usd: number }[]) =>
  rows.length ? rows.map((r) => `${r.label} $${r.usd.toFixed(2)}`).join(', ') : '—';
const verdictWords = (row: { verdict: string; heldLots: string[]; after: { label: string; usd: number }[] }) =>
  row.verdict === 'split' ? money(row.after) : row.verdict === 'held' ? `HELD (${row.heldLots.join(', ') || 'copy'})` : row.verdict;

async function main() {
  const plan = await resplitPlan();
  // Only the bills whose stored shares the lot grain would change (judge
  // J25): run after the deploy, an unchanged bill — one saved by the new
  // code — must not read as work to do.
  const moving = plan.filter((r) => r.moves);
  console.log(`live freight-basis bills: ${plan.length} · would change: ${moving.length}`);
  if (moving.length === 0) {
    console.log('0 ta hisob o‘zgaradi — nothing to re-split.');
    return;
  }
  for (const row of moving) {
    console.log(`  ${row.truckCode ?? '—'}  ${row.amount} ${row.currency}  ${money(row.before)}  →  ${verdictWords(row)}`);
    if (offTheOneColumn(row)) {
      // Re-split on its OWN frozen column (3a) — the grain is code, the prices are the copy's.
      console.log(`    re-split on its own frozen column «${row.zone}»; to move it onto the one table use «Bo'lish usuli ✎» on its row`);
    }
  }
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to re-split them by lot.');
    return;
  }
  const ids = moving.map((r) => r.id);
  const result = await resplitApply(ids);
  // What was WRITTEN, read back from the allocations — never the prediction.
  const stored = await resplitStored(ids);
  console.log(`\nre-split: ${result.done}`);
  for (const row of moving) {
    const verdict = result.verdicts.get(row.id);
    if (verdict === undefined) continue;
    const now = stored.get(row.id) ?? [];
    const drift = verdict !== row.verdict || (verdict === 'split' && !sameShares(now, row.after));
    console.log(`  ${row.truckCode ?? '—'}  stored now: ${verdict === 'split' ? money(now) : verdict ?? 'gone'}${drift ? '  ⚠ changed since the list was read — run the dry run again' : ''}`);
  }
  if (result.failed.length) {
    console.error(`FAILED: ${result.failed.length} (the rest were re-split)`);
    for (const row of result.failed) console.error(`  ${row.id}: ${row.message}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
