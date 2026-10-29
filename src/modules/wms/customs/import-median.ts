import { sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import type { ImportUnit } from './import-parse';
import { codeScopeCtes, weightBandSql } from './import-stats-sql';
import type { CodeMedianUnit } from '../calc/estimate';

/**
 * The medians behind the bot's 📊 estimate (docs/SAKKIZ-R2.md §6.6) — one
 * code in one batch, in ONE statement.
 *
 * The statement stands on `codeScopeCtes`, the 📥 dialog's own scope: the
 * EXACT code, China only when the file names countries at all (D3). So the
 * median printed in the chat is the one the dialog prints as «50 %
 * (mediana)» for that row and unit — the VED who opens the row sees the
 * number the seller was told (pinned, customs-estimate.integration.test.ts).
 *
 * One statement per CODE, not per row: the per-piece bands of every dona row
 * of the code ride it as FILTERed pairs. The China-origin regex is this
 * read's costly part (~330 ms on a 130k-row code, import-stats-sql.ts), and a
 * statement per row paid it once per row.
 *
 * `percentile_disc` and nothing else — a price some declaration actually
 * carries, never an interpolated or averaged one (#1297): «Tanlash» in the
 * dialog can name the declaration standing at it.
 *
 * It runs on the `tx` it is handed and NOTHING here touches `db` or
 * `getSetting`: the caller's `underCeiling` transaction holds one of the pool's
 * ten connections, and a pool read inside it is #714's freeze.
 * `estimate-wire.test.ts` pins this body (tx-pool.test.ts does not scan
 * `underCeiling` callbacks).
 */
export async function readCodeMedians(
  tx: Tx,
  input: {
    batchId: string;
    tnvedCode: string;
    bands: readonly { key: string; lo: number; hi: number }[];
  },
): Promise<CodeMedianUnit[]> {
  // The band columns' aliases are `sql.raw` of a loop INTEGER and of nothing
  // else — a band key is data and never reaches the statement's text.
  const pairs = input.bands.map((b, i) => {
    const inBand = weightBandSql(sql`s.unit`, sql`s.w`, b);
    return sql`, (count(*) FILTER (WHERE ${inBand}))::int AS ${sql.raw(`b${i}_n`)},
               (percentile_disc(0.5) WITHIN GROUP (ORDER BY s.p) FILTER (WHERE ${inBand}))::text AS ${sql.raw(`b${i}_p50`)}`;
  });
  const rows = await tx.execute<Record<string, unknown>>(sql`
    WITH ${codeScopeCtes(input.batchId, input.tnvedCode)}
    SELECT s.unit,
           count(*)::int AS n,
           (percentile_disc(0.5) WITHIN GROUP (ORDER BY s.p))::text AS p50
           ${sql.join(pairs, sql``)}
      FROM scoped s
     GROUP BY s.unit
  `);
  // Prices travel as TEXT, the numeric's own digits, and are read once here.
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return Array.from(rows).map((r) => ({
    unit: r.unit as ImportUnit,
    n: Number(r.n ?? 0),
    p50: num(r.p50),
    bands: new Map(
      input.bands.map((b, i) => [b.key, { n: Number(r[`b${i}_n`] ?? 0), p50: num(r[`b${i}_p50`]) }]),
    ),
  }));
}
