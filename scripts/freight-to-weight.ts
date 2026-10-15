import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { liveFreightBills, rollbackFreightBills } from '../src/modules/wms/costing/freight-rollback';

/**
 * The yo'lkira-tarifi rollback (docs/YOLKIRA-TAQSIMOT.md §8.8, §10):
 *
 *   docker compose run --rm migrate pnpm freight-to-weight          # lists, changes nothing
 *   docker compose run --rm migrate pnpm freight-to-weight --apply  # every live freight bill → weight
 *
 * Run BEFORE going below migration 0132: the older code refuses the basis
 * 'freight', so a live freight bill would be a row nothing can split. Only
 * the basis, its frozen column and the shares move — never the amount, the
 * dollars, the payer or the kassa. Through `migrate` (round 84): the app
 * image has no pnpm and no source.
 */
const apply = process.argv.includes('--apply');

async function main() {
  const bills = await liveFreightBills();
  console.log(`live freight-basis bills: ${bills.length}`);
  for (const bill of bills) {
    const shares = bill.shares.length ? bill.shares.map((s) => `${s.label} $${s.usd.toFixed(2)}`).join(', ') : 'NOT SPLIT';
    console.log(`  ${bill.truckCode ?? '—'}  ${bill.typeName}  ${bill.amount} ${bill.currency}  →  ${shares}`);
  }
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to split them by weight.');
    return;
  }
  const result = await rollbackFreightBills(bills.map((b) => b.id));
  console.log(`re-based to weight: ${result.done}; skipped (voided or changed meanwhile — run again to be sure): ${result.skipped}`);
  const codes = new Map(bills.map((b) => [b.id, b.truckCode ?? '—']));
  for (const row of result.splits) {
    if (row.split === 'split') continue;
    // The basis moved (the count check reads 0) but the money is on no
    // carton yet: only a FAILED split heals by itself; «nothing» (no cargo
    // with a weight) and «unconverted» (no rate) wait for a person.
    const why =
      row.split === 'pending' ? 'the split failed — the nightly sweep retries it' : `${row.split ?? 'not split'} — needs a person`;
    console.log(`  ${codes.get(row.id)}  ${row.id}: ${why}`);
  }
  if (result.failed.length) {
    console.error(`FAILED: ${result.failed.length} (the rest were moved)`);
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
