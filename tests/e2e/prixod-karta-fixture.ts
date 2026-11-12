import postgres from 'postgres';

/**
 * Two prixods for the card's layout specs (docs/PRIXOD-KARTA.md), minted by
 * SQL and removed by SQL: a CLAIMED one of two lots whose totals are literals
 * a person can add on paper, and an OWNERLESS one whose marking is the worst
 * string the field takes — fifty characters with no space in it.
 *
 * Nothing here is configuration (#183): no stage, no setting, no role. The
 * specs press only openers, so no audit row is written and every row minted
 * can be deleted again — `clean` is called from a final TEST, never from an
 * `afterAll` (a page there has neither baseURL nor login, round 57).
 */

export interface KartaRun {
  /** Run-scoped: the client's code, and the prefix of every number and code. */
  prefix: string;
}

/** 12.5 + 0.3 kg and 0.75 + 0.0005 m³ over 3 + 2 cartons — the sums the card must print. */
export const KARTA_TOTAL = { boxes: 5, kg: '12.8', m3: '0.7505' } as const;
/** Sixty characters, with spaces: it wraps. */
export const KARTA_GOODS = 'Ayollar uchun qishki kurtka kapyushonli issiq astarli qora L';
/** Fifty characters, no space: it must BREAK or it widens the page. */
export const kartaMarking = (run: KartaRun) => `${run.prefix}MANIKEN-AL-№7-`.padEnd(50, 'X').slice(0, 50);

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export async function mintKarta(run: KartaRun): Promise<{ claimedId: string; ownerlessId: string; lotAId: string }> {
  const sql = database();
  try {
    return await sql.begin(async (tx) => {
      const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
      const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
      if (!owner || !yw) throw new Error('the demo lacks the owner or YW');
      const [client] = await tx<{ id: string }[]>`
        INSERT INTO clients (id, client_code, name)
        VALUES (gen_random_uuid(), ${run.prefix}, ${`Karta mijozi ${run.prefix}`}) RETURNING id`;
      const prixod = async (suffix: string, clientId: string | null, marking: string | null) => {
        const [receipt] = await tx<{ id: string }[]>`
          INSERT INTO receipts (id, number, warehouse_id, client_id, unclaimed_marking, status, confirmed_at, created_by, source_note)
          VALUES (gen_random_uuid(), ${`${run.prefix}-${suffix}`}, ${yw.id}, ${clientId}, ${marking}, 'confirmed', now(), ${owner.id}, ${run.prefix})
          RETURNING id`;
        return receipt!.id;
      };
      const lot = async (receiptId: string, seq: number, name: string, boxes: number, kg: string, m3: string) => {
        const letter = String.fromCharCode(64 + seq);
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO receipt_lots (id, receipt_id, seq, letter, dims_mode, product_name_zh, product_name_ru, box_count, total_weight_kg, total_volume_m3)
          VALUES (gen_random_uuid(), ${receiptId}, ${seq}, ${letter}, 'mixed', '测试货', ${name}, ${boxes}, ${kg}, ${m3})
          RETURNING id`;
        for (let i = 1; i <= boxes; i += 1) {
          await tx`
            INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
            VALUES (gen_random_uuid(), ${row!.id}, ${`${run.prefix}${suffixOf(receiptId)}${letter}${i}`}, ${i}, 'in_stock', ${yw.id})`;
        }
        return row!.id;
      };
      const claimedId = await prixod('C', client!.id, null);
      const lotAId = await lot(claimedId, 1, KARTA_GOODS, 3, '12.500', '0.7500');
      await lot(claimedId, 2, 'Qo‘lqop', 2, '0.300', '0.0005');
      const ownerlessId = await prixod('U', null, kartaMarking(run));
      await lot(ownerlessId, 1, 'Maniken', 1, '4.000', '0.1000');
      return { claimedId, ownerlessId, lotAId };
    });
  } finally {
    await sql.end();
  }
}

/** A short, unique tail for a carton code — the receipt's own id. */
const suffixOf = (receiptId: string) => receiptId.slice(-4).toUpperCase();

export async function cleanKarta(run: KartaRun): Promise<number> {
  const sql = database();
  try {
    return await sql.begin(async (tx) => {
      const lots = await tx<{ id: string }[]>`
        SELECT l.id FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id WHERE r.source_note = ${run.prefix}`;
      const lotIds = lots.map((l) => l.id);
      if (lotIds.length > 0) {
        await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
        await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
        await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
      }
      await tx`DELETE FROM receipts WHERE source_note = ${run.prefix}`;
      await tx`DELETE FROM clients WHERE client_code = ${run.prefix}`;
      const [left] = await tx<{ n: number }[]>`
        SELECT (SELECT count(*) FROM receipts WHERE source_note = ${run.prefix})::int
             + (SELECT count(*) FROM clients WHERE client_code = ${run.prefix})::int AS n`;
      return left?.n ?? 0;
    });
  } finally {
    await sql.end();
  }
}
