import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { SEED_FACTS, seedKb, seededKeys } from '../src/modules/wms/agent/seed-kb';

/**
 * The AI sotuvchi's starting knowledge (docs/AI-SOTUVCHI.md §17.12) — the
 * reviewed list in `src/modules/wms/agent/seed-kb.ts`, no prices, no extras:
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-seed-kb.ts          # lists what is missing
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-seed-kb.ts --apply  # inserts it
 *
 * Idempotent by each fact's seed key: a re-run inserts nothing twice, and a
 * fact retired on «Suhbatlar → AI sotuvchi → Bilimlar» stays retired. Not a
 * package.json command on purpose (#1228).
 */

const USAGE = 'usage: pnpm exec tsx scripts/agent-seed-kb.ts [--apply]';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--apply')) {
    console.error(USAGE);
    return 2;
  }
  const apply = args.includes('--apply');
  const have = await seededKeys();
  const missing = SEED_FACTS.filter((f) => !have.has(f.key));
  console.log(`seed facts: ${SEED_FACTS.length} · already seeded: ${SEED_FACTS.length - missing.length} · missing: ${missing.length}`);
  for (const f of missing) console.log(`  + ${f.key}  ${f.question}`);
  if (missing.length === 0) return 0;
  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to insert them.');
    return 0;
  }
  const inserted = await seedKb(missing);
  console.log(`\ninserted: ${inserted.length}${inserted.length ? ` (${inserted.join(', ')})` : ''}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void pgClient.end());
