import 'dotenv/config';

/**
 * «Bekor qilingan partiyalarning raqamlari» — his 7a (docs/NARX-VA-RAQAM.md
 * §2.3 + §3.2.7): the list read to him BEFORE anything is given back, then
 * only the TRAILING cancelled, never-departed numbers come back. On the
 * server, after the deploy:
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/batch-raqam.ts          # lists, changes nothing
 *   docker compose run --rm migrate pnpm exec tsx scripts/batch-raqam.ts --apply  # gives the trailing ones back
 *
 * Through `migrate` (the runner image has no pnpm, no tsx and no source) and
 * deliberately NOT a package.json script: a changed package.json re-runs the
 * image's install, which needs npm's registry on deploy morning (#1228).
 *
 * One block per COUNTER ROW (`counters` kind `batch_seq`), an old prefix's
 * included, with every warehouse that uses the prefix today — two warehouses
 * with one prefix share one sequence, so a give-back may rename the other
 * warehouse's cancelled truck (stated). The dry run opens every session READ
 * ONLY (`default_transaction_read_only`, zavod-tekshir's way); `--apply`
 * calls the cancel's own writer (`releaseTrailingCodes`) once per prefix and
 * prints what it gave back, read from what it returned — never the
 * prediction. Its audit rows carry no actor: the script is nobody's press.
 */

const apply = process.argv.includes('--apply');

function readOnlyUrl(url: string | undefined): string {
  const base = url ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev';
  return `${base}${base.includes('?') ? '&' : '?'}default_transaction_read_only=on`;
}

/** One gap in his words — «30: 01A777BA nomi bilan jo‘nagan». */
function gapLine(g: { number: string; kind: string; name?: string; atAgent?: boolean }): string {
  const named = g.name ? ` (hozir ${g.name})` : '';
  switch (g.kind) {
    case 'cancelled':
      return g.atAgent
        ? `${g.number}: bekor qilingan, hujjatlari agentga yuborilgan — raqami saqlanadi${named}`
        : `${g.number}: bekor qilingan, yo‘lga chiqmagan${named}`;
    case 'renamed_left':
      return `${g.number}: ${g.name ?? '?'} nomi bilan jo‘nagan`;
    case 'renamed_waiting':
      return `${g.number}: ${g.name ?? '?'} nomi bilan, hali jo‘namagan`;
    case 'left_cancelled':
      return `${g.number}: yo‘lga chiqqan, keyin bekor qilingan — raqami saqlanadi`;
    default:
      return `${g.number}: hech kim olmagan`;
  }
}

async function main() {
  // Before the first import of the client: the pool is built from the URL.
  if (!apply) process.env.DATABASE_URL = readOnlyUrl(process.env.DATABASE_URL);
  const { pgClient } = await import('../src/modules/platform/db/client');
  const { batchNumberReport } = await import('../src/modules/wms/batches/batch-number');
  const { releaseTrailingCodes } = await import('../src/modules/wms/batches/rename');
  try {
    const report = await batchNumberReport();
    if (report.length === 0) {
      console.log('Hisoblagich yo‘q — hali birorta partiya raqami berilmagan.');
      return;
    }
    let returnable = 0;
    for (const p of report) {
      console.log(`\n=== ${p.prefix} — hisoblagich ${p.counter} · eng katta nom: ${p.highestCode ?? '—'}`);
      console.log(`    ishlatadigan skladlar: ${p.warehouses.length ? p.warehouses.join(', ') : '— (eski prefiks, hozir hech qaysi sklad ishlatmaydi)'}`);
      if (p.cancelled.length) {
        console.log('    bekor qilingan, jo‘namagan mashinalar:');
        for (const c of p.cancelled) {
          const notes = [
            c.released ? 'raqami allaqachon qaytarilgan' : null,
            c.atAgent ? 'hujjatlari agentga yuborilgan' : null,
          ].filter(Boolean);
          console.log(`      ${c.code} · ${c.createdAt.toISOString().slice(0, 10)}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
        }
      }
      if (p.gaps.length) {
        console.log('    1 dan tepagacha sanoqdan tushgan raqamlar:');
        for (const g of p.gaps) console.log(`      ${gapLine(g)}`);
      } else {
        console.log('    sanoqda bo‘sh joy yo‘q');
      }
      console.log(
        `    --apply qaytaradi: ${p.wouldReturn.length ? p.wouldReturn.join(', ') : '— (oxirgi raqam yo‘lga chiqqan yoki ochiq mashinada)'}`,
      );
      returnable += p.wouldReturn.length;
    }
    if (!apply) {
      console.log(
        `\nDRY RUN — hech narsa o‘zgarmadi. Qaytadigan raqamlar: ${returnable}. Ro‘yxatni o‘qib bo‘lgach --apply bilan qayta ishga tushiring.`,
      );
      return;
    }
    console.log('\n--apply:');
    for (const p of report) {
      if (p.wouldReturn.length === 0) continue;
      const walk = await releaseTrailingCodes(p.prefix, { actorId: null });
      console.log(
        `  ${p.prefix}: qaytdi ${walk.released.length ? walk.released.join(', ') : '—'} · to‘xtadi: ${walk.stop.why}${walk.stop.number ? ` (${walk.stop.number})` : ''}`,
      );
      if (walk.stop.why === 'busy' || walk.stop.why === 'error') process.exitCode = 1;
    }
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
