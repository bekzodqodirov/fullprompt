/** Manual backup: `pnpm backup`. Same code as the nightly 02:00 job. */
import 'dotenv/config';
import { runBackup } from '../src/modules/platform/backup/run';

async function main() {
  const result = await runBackup();
  if (result.ok) {
    console.log(`✅ backup: ${result.file} (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);
    if (result.pruned.length) console.log(`🧹 eski nusxalar o‘chirildi: ${result.pruned.join(', ')}`);
  } else {
    console.error(`❌ backup xato: ${result.error}`);
    process.exit(1);
  }
}

void main();
