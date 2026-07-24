/** Manual backup fire drill: `pnpm restore-test`. Same code as the weekly job. */
import 'dotenv/config';
import { runRestoreTest } from '../src/modules/platform/backup/restore-test';

async function main() {
  const result = await runRestoreTest();
  if (result.ok) {
    console.log(`✅ restore test o‘tdi: ${result.file}`);
    for (const [table, n] of Object.entries(result.counts)) {
      console.log(`   ${table}: ${n} qator`);
    }
  } else {
    console.error(`❌ restore test xato: ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
