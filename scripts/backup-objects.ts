/**
 * Copy the object store off this machine, by hand: `pnpm backup-objects`.
 *
 * The same code the nightly job runs. Worth having as a command because the
 * FIRST run is not like the others — there are tens of thousands of files
 * waiting and the run is bounded by a wall clock, so the backlog is drained
 * over several passes. Run it, watch the number go down, run it again.
 */
import 'dotenv/config';
import { runObjectBackup } from '../src/modules/platform/backup/objects';

async function main() {
  const result = await runObjectBackup();
  if (!result.ok) {
    console.error(`❌ fayllar zaxirasi xato: ${result.error}`);
    process.exit(1);
  }
  if (result.skipped) {
    console.log('⚠️  zaxira manzili sozlanmagan (.env) — fayllar faqat shu diskda turibdi');
    process.exit(0);
  }
  const mb = (result.bytes / 1024 / 1024).toFixed(1);
  console.log(`✅ ${result.where}: ${result.copied} ta fayl ko‘chirildi (${mb} MB)`);
  if (result.failed) console.log(`   ${result.failed} tasi bo‘lmadi — ertaga qayta uriniladi`);
  if (result.stoppedBecause) console.log(`   to‘xtash sababi: ${result.stoppedBecause}`);
  console.log(`   qolgani: ${result.remaining} ta fayl`);
  process.exit(0);
}

void main();
