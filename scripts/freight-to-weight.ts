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
  console.log(`re-based to weight: ${result.done}; already moved or voided: ${result.skipped}`);
  const codes = new Map(bills.map((b) => [b.id, b.truckCode ?? '—']));
  for (const row of result.splits) {
    if (row.split !== 'split') {
      // Saved by weight but on no carton yet: the nightly sweep re-splits it,
      // and the count check below still reads 0 (the basis moved).
      console.log(`  ${codes.get(row.id)}  ${row.id}: ${row.split ?? 'not split'} — nightly sweep will retry`);
    }
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
