import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Balans on deploy morning, READ-ONLY (U03, the owner's Q16 A):
 *
 *   pnpm balans-hisobot
 *
 * On the server it runs through `migrate` (the runner image has no pnpm):
 *   docker compose run --rm migrate pnpm balans-hisobot
 *
 * The new line «narxi hali yozilmagan yukka sarflangan» moves Sof holat on
 * the morning it deploys, and several other Balans lines move with it (0101's
 * kassas on costs, the queue, 0103-0106). The owner is told each line's
 * figure, never «Sof holat moved by X» — and the figure must come from HIS
 * data, which exists nowhere but his server. So this prints, from the same
 * functions the page reads:
 *
 *   - every Balans line and the net;
 *   - the line and its arithmetic under BOTH card-price rules (his (i) as
 *     built, and the netting switch he is asked about);
 *   - the cargo handed over before the ban (out of the line, a figure only
 *     this report can print — the page never reads that history);
 *   - everything left out, and the facts his (i) question needs.
 *
 * It writes nothing: every session it opens starts READ ONLY
 * (`default_transaction_read_only`, a connection parameter on the URL), so
 * even a reader that tried to write would be refused by Postgres. Run it
 * after the migrate step and before he opens the Balans; he pastes the output
 * into the chat.
 */

function readOnlyUrl(url: string | undefined): string {
  const base = url ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev';
  return `${base}${base.includes('?') ? '&' : '?'}default_transaction_read_only=on`;
}

const usd = (value: number) =>
  `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  // Before the first import of the client: the pool is built from the URL.
  process.env.DATABASE_URL = readOnlyUrl(process.env.DATABASE_URL);
  const { pgClient, db } = await import('../src/modules/platform/db/client');
  const { sql } = await import('drizzle-orm');
  const { companyBalance, unpricedCargoMoney, kassaRatesToday } = await import('../src/modules/wms/accounting/reports');
  const { balanceLines } = await import('../src/modules/wms/accounting/balance-lines');
  const { unplacedCostSince } = await import('../src/modules/wms/costing/service');
  const { unpricedGate } = await import('../src/modules/wms/finance/unpriced');
  const { tashkentMinute } = await import('../src/modules/platform/time/tashkent');
  const uz = JSON.parse(readFileSync(path.join(process.cwd(), 'messages', 'uz.json'), 'utf8')).accounting as Record<
    string,
    string
  >;
  try {
    const [ledger] = (await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)) as unknown as {
      n: number;
    }[];
    const [readOnly] = (await db.execute(sql`SHOW default_transaction_read_only`)) as unknown as {
      default_transaction_read_only: string;
    }[];
    const gate = await unpricedGate();
    console.log('BALANS HISOBOTI — faqat o‘qish, hech narsa o‘zgarmaydi');
    console.log(`  vaqt: ${tashkentMinute(new Date())} (Toshkent) · migratsiyalar: ${ledger?.n} · read only: ${readOnly?.default_transaction_read_only}`);
    console.log(
      `  topshirishdagi taqiq: ${
        gate.state === 'on' ? `yoqilgan, ${tashkentMinute(gate.since)} dan` : gate.state === 'off' ? 'O‘CHIQ' : 'NOTO‘G‘RI (yopiq ishlaydi)'
      }`,
    );

    const t0 = Date.now();
    const balance = await companyBalance();
    const balanceMs = Date.now() - t0;
    console.log(`\n— Balans qatorlari (sahifa shu raqamlarni ko‘rsatadi; o‘qish ${(balanceMs / 1000).toFixed(1)} s) —`);
    for (const line of balanceLines(balance, { cash: '', cargo: '' })) {
      console.log(`  ${(uz[line.key] ?? line.key).padEnd(56)} ${usd(line.value)}`);
    }
    console.log(`  ${(uz.balNet ?? 'Sof holat').padEnd(56)} ${usd(balance.netUsd)}`);
    console.log(`  (bu qatorsiz Sof holat: ${usd(balance.netUsd - balance.unpricedCargoUsd)})`);

    const [since, rates] = await Promise.all([unplacedCostSince(), kassaRatesToday()]);
    const ratedCurrencies = [...rates].filter(([, rate]) => rate !== null && rate > 0).map(([code]) => code);
    const read = async (cardRule: 'exclude' | 'net') => {
      const start = Date.now();
      const result = await unpricedCargoMoney({ since, ratedCurrencies, gate, cardRule, history: 'all' });
      return { ...result, ms: Date.now() - start };
    };
    const a = await read('exclude');
    const c = await read('net');

    const arithmetic = (label: string, m: typeof a) => {
      console.log(`\n  ${label}: ${usd(m.lineUsd)}   (o‘qish ${(m.ms / 1000).toFixed(1)} s)`);
      console.log(`    Jami sarflangan ${usd(m.grossUsd)}: Xitoyda yoki yo‘lda ${usd(m.awayUsd)} · O‘zbekiston omborida ${usd(m.stockUsd)} · ruxsat bilan narxsiz topshirilgan ${usd(m.issuedUsd)}`);
      console.log(`    − kartadagi narx tufayli chiqqan: ${usd(m.cardUsd)}`);
      console.log(`    − boshqa mashinadagi narx: ${usd(m.elsewhereUsd)}`);
      console.log(`    = ${usd(m.lineUsd)}  (${m.prixods} ta prixod)`);
    };
    console.log(`\n— «${uz.balUnpricedCargo ?? 'Narxi hali yozilmagan yukka sarflangan'}» —`);
    arithmetic('a) Hozirgidek (siz aytgandek: kartadagi narx o‘sha kungacha kelgan yukni chiqaradi)', a);
    arithmetic('c) Kartadagi summa miqdoricha, faqat o‘sha sanagacha kelgan yukdan (almashtirish tugmasi)', c);
    console.log(`\n  c) − a) = ${usd(c.lineUsd - a.lineUsd)}`);
    console.log(
      `  (i) savoli uchun: kartadagi narxi yukdan keyin yozilgan mijozlar — ${a.cardClients} ta; ularning kartadagi narxlari ${usd(
        a.cardPriceUsd,
      )}; a) qoidasida qatordan chiqqan xarajat ${usd(a.cardUsd)}`,
    );

    console.log('\n— Qatorga kirmaganlar —');
    const left = [
      ['Egasiz yuk', `${usd(a.unclaimed.usd)} (${a.unclaimed.prixods} ta prixod)`],
      ['Kassa sanog‘idan oldingi eski xarajat', `${a.oldNoKassa.count} ta, ${usd(a.oldNoKassa.usd)}`],
      ['Kursi yo‘q kassadan to‘langan', `${a.tillUnrated.count} ta, ${usd(a.tillUnrated.usd)}`],
      ['Kontragent ko‘rsatilgan, qarzi yozilmagan', `${a.noDebt.count} ta, ${usd(a.noDebt.usd)}`],
      ['Zavod reysi, prixodga bog‘lanmagan', `${a.pickupNoBox.count} ta, ${usd(a.pickupNoBox.usd)}`],
      ['Hech bir karobkaga tushmagan', `${a.noBox.count} ta, ${usd(a.noBox.usd)}`],
      ['Kursi yo‘q xarajat', `${a.unconverted} ta`],
      [
        'Taqiqdan oldin narxsiz topshirilgan yuk',
        a.issuedBeforeGate ? `${usd(a.issuedBeforeGate.usd)} (${a.issuedBeforeGate.prixods} ta prixod)` : '—',
      ],
    ] as const;
    for (const [label, value] of left) console.log(`  ${label.padEnd(44)} ${value}`);
    // The page reads with the ban cut and the report with all history: both
    // must give the same line, or the page and this output disagree.
    if (Math.abs(a.lineUsd - balance.unpricedCargoUsd) > 0.005) {
      console.log(`\n  ⚠ Sahifa bilan farq: sahifa ${usd(balance.unpricedCargoUsd)}, hisobot ${usd(a.lineUsd)}`);
    }
    console.log('\nREAD ONLY — hech narsa o‘zgartirilmadi.');
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
