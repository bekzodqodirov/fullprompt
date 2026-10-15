import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * «Zavoddan kelgan yuk ikki marta qabul qilinganmi» — the owner's item 7
 * (docs/ZAVOD-YOPISH.md §7), READ-ONLY. On the server, after the 0133 deploy:
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/zavod-tekshir.ts
 *
 * Deliberately NOT a package.json script: any package.json edit re-downloads
 * every package on the next deploy (#1228), for a command run a handful of
 * times. The lists are `pickups/double-received.ts`, integration-tested; this
 * file only prints them, in Uzbek, for the owner to read before anyone says
 * «tuzatildi».
 *
 * It writes nothing: every session it opens starts READ ONLY
 * (`default_transaction_read_only`, a connection parameter on the URL —
 * balance-report's way), so even a reader that tried to write would be
 * refused by Postgres. Exit 0 whether or not it finds anything: a found row
 * is a question for a person, not a failure.
 */

function readOnlyUrl(url: string | undefined): string {
  const base = url ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev';
  return `${base}${base.includes('?') ? '&' : '?'}default_transaction_read_only=on`;
}

/** The repo's own migration count, when the source is beside us (the migrate image has it). */
function repoMigrations(): number | null {
  try {
    return readdirSync(path.join(process.cwd(), 'src', 'modules', 'platform', 'db', 'migrations')).filter((f) =>
      f.endsWith('.sql'),
    ).length;
  } catch {
    return null;
  }
}

async function main() {
  // Before the first import of the client: the pool is built from the URL.
  process.env.DATABASE_URL = readOnlyUrl(process.env.DATABASE_URL);
  const { pgClient, db } = await import('../src/modules/platform/db/client');
  const { sql } = await import('drizzle-orm');
  const { tashkentMinute } = await import('../src/modules/platform/time/tashkent');
  const check = await import('../src/modules/wms/pickups/double-received');
  type CheckReceipt = import('../src/modules/wms/pickups/double-received').CheckReceipt;
  type CheckLine = import('../src/modules/wms/pickups/double-received').CheckLine;

  // The trip's state in the words the /zavod screen prints (`pickups.status.*`
  // in the uz bundle), never the stored code.
  const statusWord = (() => {
    try {
      const uz = JSON.parse(readFileSync(path.join(process.cwd(), 'messages', 'uz.json'), 'utf8')) as {
        pickups?: { status?: Record<string, string> };
      };
      const words = uz.pickups?.status ?? {};
      return (status: string) => (words[status] ?? status).toLowerCase();
    } catch {
      return (status: string) => status;
    }
  })();
  const closeWord = (kind: string | null) => (kind === 'auto' ? 'o‘zi' : kind === 'manual' ? 'qo‘lda' : '—');
  const when = (d: Date | null) => (d ? tashkentMinute(d) : '—');
  const receiptText = (r: CheckReceipt) =>
    [
      `prixod ${r.number ?? r.id.slice(0, 8)}`,
      when(r.confirmedAt),
      `${r.boxes} karobka`,
      `sklad ${r.warehouseCode}`,
      check.ownerLabel(r),
      r.goods ?? '',
      r.voided ? 'BEKOR QILINGAN' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const lineText = (l: CheckLine) =>
    [
      `${l.pickupCode} (${statusWord(l.pickupStatus)})`,
      `${l.stopSeq}-zavod: ${l.factoryName}`,
      `ega: ${check.ownerLabel(l)}`,
      l.goods,
      `zavod soni ${l.factoryBoxes}${l.driverBoxes !== null ? `, haydovchi ${l.driverBoxes}` : ''}`,
      `→ ${l.destCode}`,
    ].join(' · ');
  const heading = (title: string, count: number, more: boolean) =>
    console.log(`\n${title}\n  — ${count === 0 ? 'topilmadi' : `${count} ta${more ? ` (faqat birinchi ${check.CHECK_LIMIT} tasi; yana bor)` : ''}`}`);

  try {
    const [ledger] = (await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)) as unknown as {
      n: number;
    }[];
    const [readOnly] = (await db.execute(sql`SHOW default_transaction_read_only`)) as unknown as {
      default_transaction_read_only: string;
    }[];
    const repo = repoMigrations();
    console.log('ZAVOD REYSI TEKSHIRUVI — faqat o‘qish, hech narsa o‘zgarmaydi');
    console.log(
      `  vaqt: ${tashkentMinute(new Date())} (Toshkent) · migratsiyalar: ${ledger?.n}${
        repo !== null ? ` (repoda ${repo})` : ''
      } · read only: ${readOnly?.default_transaction_read_only}`,
    );
    if (repo !== null && ledger && ledger.n !== repo) {
      console.log('  ⚠ Migratsiyalar repodagidan kam — avval `docker compose run --rm migrate`, keyin qayta yurgizing.');
    }

    const result = await check.zavodCheck();

    const twice = result.answeredTwice;
    heading('1. Bitta qatorni bir nechta tirik prixod qabul qilgan — yuk ikki marta qabul qilingan bo‘lishi mumkin', twice.rows.length, twice.more);
    for (const row of twice.rows) {
      console.log(`  • ${lineText(row.line)}`);
      const total = row.receipts.reduce((sum, r) => sum + r.boxes, 0);
      for (const r of row.receipts) console.log(`      ${receiptText(r)}`);
      console.log(`      jami ${total} karobka, zavod bergani ${row.line.factoryBoxes}`);
    }

    const owed = result.owedLines;
    heading('2. Ochiq reyslar — qabul qilinmagan qatorlar (qabul qiling yoki «Reysni yopish» bilan sababi yozib yoping)', owed.rows.length, owed.more);
    for (const row of owed.rows) {
      const state = [
        row.collectedAt ? `olindi ${when(row.collectedAt)}` : '«Olindi» bosilmagan',
        row.arrivedAt ? `yetib keldi ${when(row.arrivedAt)}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`  • ${lineText(row.line)} · ${state}`);
      for (const r of row.candidates) console.log(`      biriktiring, qayta qabul qilmang: ${receiptText(r)}`);
    }
    const openAnswered = result.openAnswered;
    if (openAnswered.rows.length) {
      console.log(
        `\n  Hamma qatori qabul qilingan, lekin hali ochiq (o‘zi yopilishi kerak edi): ${openAnswered.rows.length} ta${
          openAnswered.more ? '+' : ''
        }`,
      );
      for (const t of openAnswered.rows) {
        console.log(`  • ${t.pickupCode} (${statusWord(t.pickupStatus)}) → ${t.destCode} · ${t.lines} qator`);
      }
    }

    const links = result.unansweringLinks;
    heading('3. Reysga bog‘langan, lekin hech bir qatorga javob bermaydigan prixodlar', links.rows.length, links.more);
    const why = {
      open: 'egasining qatori hali ochiq — bog‘lanish eslab qolinmagan (deploy oynasi?)',
      answered: 'egasining qatorini boshqa prixod qabul qilgan — ikkinchi qabulmi?',
      none: 'qatorlarda bu ega yo‘q — zavoddan ortiqcha yuk',
    } as const;
    for (const row of links.rows) {
      console.log(
        `  • ${row.pickupCode} (${statusWord(row.pickupStatus)}) · ${row.stopSeq}-zavod: ${row.factoryName} → ${row.destCode}`,
      );
      console.log(`      ${receiptText(row.receipt)}`);
      console.log(`      ${why[row.ownerLine]}`);
    }

    const again = result.receivedAgain;
    heading(
      `4. Qator qabul qilingandan keyin o‘sha egadan reysga bog‘lanmagan prixod (oxirgi ${check.RECEIVED_AGAIN_DAYS} kun) — ikkinchi marta qabul qilinganmi?`,
      again.rows.length,
      again.more,
    );
    for (const row of again.rows) {
      console.log(`  • ${lineText(row.line)}`);
      console.log(`      qatorni qabul qilgan: ${receiptText(row.answeredBy)}`);
      console.log(`      keyin kelgan:         ${receiptText(row.receipt)}`);
    }

    const money = result.costWithoutCargo;
    heading('5. Yopilgan reys: xarajat bor, lekin tirik prixod yo‘q — pul hech bir karobkaga tushmagan', money.rows.length, money.more);
    for (const row of money.rows) {
      const usd = row.costUsd === null ? 'dollarga o‘girilmagan' : `$${row.costUsd.toFixed(2)}`;
      console.log(
        `  • ${row.pickupCode} → ${row.destCode} · ${row.factories || '—'} · yopildi ${when(row.closedAt)} (${closeWord(
          row.closeKind,
        )}) · xarajat: ${row.costs.join(', ')} (${usd}) · bekor qilingan prixodlar: ${row.voidedLinked}`,
      );
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
