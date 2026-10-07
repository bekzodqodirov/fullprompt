import postgres from 'postgres';
import { normalizeName } from '@/modules/wms/customs/import-parse';

/**
 * What «m9zzz-baza-statistika» mints and gives back, in one place so the
 * mint and the cleanup cannot disagree about which rows are the spec's
 * (yuk-tekshiruv-fixture's shape).
 *
 * Two READY customs batches — `BS<digits>.xlsx` (the quarter that answers:
 * dated up to TODAY, the C6 clamp's own ceiling, uploaded now) and
 * `BS<digits>-oldingi.xlsx` (the previous quarter) — over the one code
 * 6702900000, whose PP-3818 heading pins kilograms («20 %, min $0.7/kg»), so
 * the default tab is deterministic.
 *
 * CONFIGURATION WARNING (#183): while they live, these batches are what
 * EVERY save in the suite fills its bazas from. The spec's last test is the
 * cleanup, and `cleanupEarlier` sweeps a crashed run's batches at the top of
 * this spec AND of m9zu — which runs first and would otherwise lose its own
 * upload to a leaked batch dated today, for ever (D6).
 */

export const CODE = '6702900000';

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

/** The lead the spec's walk creates — named by the run so a crashed run's
 * request can be found again by `cleanupEarlier`. */
export const leadNameOf = (marker: string) => `Baza statistika e2e ${marker}`;

export interface Run {
  marker: string;
  /** The quartile rows' name — never what the auto-fill lands on. */
  plastic: string;
  /** The four name-matched rows («Искусственные цветы» finds them). */
  flowers: string;
  turkish: string;
}

export interface Minted {
  currentId: string;
  previousId: string;
}

export function newRun(): Run {
  const marker = `BS${String(Date.now()).slice(-7)}`;
  return {
    marker,
    plastic: `Прочие изделия из пластмасс ${marker}`,
    flowers: `Искусственные цветы из полиэстера ${marker}`,
    turkish: `Ткани хлопчатобумажные ${marker}`,
  };
}

type Row = { name: string; unit: 'kg' | 'dona'; price: string; w: string | null; origin: string; ago: number };

export async function mint(sql: postgres.Sql, run: Run): Promise<Minted> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    if (!owner) throw new Error('the demo has no owner');
    // «Today» is the office's day: the batch must end exactly at the clamp's
    // ceiling, so no foreign batch can outrank it (a tie loses on upload time).
    const [today] = await tx<{ d: string }[]>`SELECT (now() AT TIME ZONE 'Asia/Tashkent')::date::text AS d`;
    const [current] = await tx<{ id: string }[]>`
      INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to, uploaded_at, row_count)
      VALUES (${`${run.marker}.xlsx`}, ${owner.id}, 'ready', ${today!.d}::date - 30, ${today!.d}::date, now(), 15)
      RETURNING id`;
    const [previous] = await tx<{ id: string }[]>`
      INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to, uploaded_at, row_count)
      VALUES (${`${run.marker}-oldingi.xlsx`}, ${owner.id}, 'ready', ${today!.d}::date - 130, ${today!.d}::date - 100,
              now() - interval '1 minute', 5)
      RETURNING id`;
    const china = '156-КИТАЙ';
    const rows: Row[] = [
      // The quartiles: p25 1.40, p50 2.40, p75 3.10 over the seven kg rows.
      { name: run.plastic, unit: 'kg', price: '1.40', w: null, origin: china, ago: 3 },
      { name: run.plastic, unit: 'kg', price: '2.40', w: null, origin: china, ago: 4 },
      { name: run.plastic, unit: 'kg', price: '3.10', w: null, origin: china, ago: 5 },
      // Named rows OFF the quartiles, so the auto-fill can never land on 2.40.
      { name: run.flowers, unit: 'kg', price: '1.10', w: null, origin: china, ago: 6 },
      { name: run.flowers, unit: 'kg', price: '1.80', w: null, origin: china, ago: 7 },
      { name: run.flowers, unit: 'kg', price: '2.90', w: null, origin: china, ago: 8 },
      { name: run.flowers, unit: 'kg', price: '4.00', w: null, origin: china, ago: 9 },
      // Not China: on the other-countries line, out of every series.
      { name: run.turkish, unit: 'kg', price: '9.00', w: null, origin: '792-ТУРЦИЯ', ago: 10 },
      { name: run.turkish, unit: 'kg', price: '9.50', w: null, origin: '792-ТУРЦИЯ', ago: 11 },
      // Six dona declarations with a weight per piece.
      ...['0.50', '0.60', '0.70', '0.80', '0.90', '1.00'].map((price, i) => ({
        name: run.plastic,
        unit: 'dona' as const,
        price,
        w: ['0.9', '1.0', '1.1', '1.2', '2.0', '0.4'][i]!,
        origin: china,
        ago: 12 + i,
      })),
    ];
    for (const r of rows) {
      await tx`
        INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd,
                                         weight_per_unit_kg, origin_country, declared_at)
        VALUES (${current!.id}, ${CODE}, ${r.name}, ${normalizeName(r.name)}, ${r.unit}, ${r.price}::numeric,
                ${r.w}::numeric, ${r.origin}, ${today!.d}::date - ${r.ago}::int)`;
    }
    // The previous quarter: median 2.10 over five China kg declarations.
    for (const price of ['1.90', '2.00', '2.10', '2.20', '2.30']) {
      await tx`
        INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd,
                                         origin_country, declared_at)
        VALUES (${previous!.id}, ${CODE}, ${run.plastic}, ${normalizeName(run.plastic)}, 'kg', ${price}::numeric,
                ${china}, ${today!.d}::date - 110)`;
    }
    return { currentId: current!.id, previousId: previous!.id };
  });
}

/** How many calculation rows are priced off a batch — `importBatchUsage`'s count. */
export async function usage(sql: postgres.Sql, batchId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM calc_request_items i
      JOIN customs_import_rows r ON r.id = i.import_row_id
     WHERE r.batch_id = ${batchId}`;
  return row!.n;
}

/**
 * Let go of the provenance THIS run's own request took from its batch — and
 * nothing else's: the request is found by the run's lead, by name.
 */
export async function releaseOwn(sql: postgres.Sql, marker: string, batchId: string): Promise<void> {
  await sql`
    UPDATE calc_request_items SET import_row_id = NULL
     WHERE request_id IN (
             SELECT r.id FROM calc_requests r JOIN leads l ON l.id = r.entity_id
              WHERE r.entity_type = 'lead' AND l.name = ${leadNameOf(marker)})
       AND import_row_id IN (SELECT id FROM customs_import_rows WHERE batch_id = ${batchId})`;
}

/**
 * A run that died before its cleanup test: every `BS<digits>[-oldingi].xlsx`
 * batch goes, once that run's own request has let go of it. One that a
 * FOREIGN row is still priced off stays — deleting it would strip a real
 * row's provenance through ON DELETE SET NULL.
 */
export async function cleanupEarlier(sql: postgres.Sql): Promise<void> {
  const earlier = await sql<{ id: string; file_name: string }[]>`
    SELECT id, file_name FROM customs_import_batches WHERE file_name ~ '^BS[0-9]+(-oldingi)?\\.xlsx$'`;
  for (const b of earlier) {
    await releaseOwn(sql, b.file_name.replace(/(-oldingi)?\.xlsx$/, ''), b.id);
    if ((await usage(sql, b.id)) === 0) await sql`DELETE FROM customs_import_batches WHERE id = ${b.id}`;
  }
}

/** What still carries the run's marker. */
export async function left(sql: postgres.Sql, run: Run): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM customs_import_batches WHERE file_name LIKE ${`${run.marker}%`}`;
  return row!.n;
}
