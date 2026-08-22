/** Manual backup fire drill: `pnpm restore-test`. Same code as the weekly job. */
import 'dotenv/config';
import { runRestoreTest } from '../src/modules/platform/backup/restore-test';

async function main() {
  const result = await runRestoreTest();
  if (!result.ok) {
    console.error(`❌ restore test xato: ${result.error}`);
    process.exit(1);
  }
  if (result.mode === 'header') {
    // Not a pass and not a failure: this machine has no pg_restore, so the
    // dump was inspected rather than restored. docs/BACKUP.md has the manual
    // drill to run from a machine that does.
    console.log(`⚠️  ${result.note}`);
    console.log(`   fayl: ${result.file}`);
    process.exit(0);
  }
  console.log(`✅ restore test o‘tdi: ${result.file}`);
  for (const [table, n] of Object.entries(result.counts)) {
    console.log(`   ${table}: ${n} qator`);
  }
  process.exit(0);
}

void main();
