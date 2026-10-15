import postgres from 'postgres';

/**
 * What the two «yo'nalish» specs (the reroute round) borrow and give back, in
 * one place so the mint and the cleanup cannot disagree about what a truck
 * left behind.
 *
 * A truck of the spec's OWN, never «whatever is in transit»: in CI's order a
 * later spec may have unloaded m3's truck, and a test that looks for one and
 * skips itself green proves nothing. Minted in SQL, with no cartons, so the
 * only rows a press leaves are the reroute's own: its `BatchRerouted` events,
 * the notifications the drain fanned them out to, and the audit rows (which
 * stay — audit_log refuses DELETE).
 */

export const PASSWORD = 'demo1234';
export const LOGIST = '+998900000003';
export const VED = '+998900000004';
export const KA_OPERATOR = '+998900000008';

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and drop this spec’s trucks');
  return postgres(url, { max: 1, onnotice: () => {} });
}

let minted = 0;

/** YW → `destCode`, departed a day ago, on the road. */
export async function mintTruck(sql: postgres.Sql, destCode: string): Promise<{ id: string; code: string }> {
  minted += 1;
  // A per-run counter beside the clock: two trucks minted in one millisecond
  // must not share a code (#598's lesson), and the counter goes at the END of
  // a string nothing slices.
  const code = `YN${String(Date.now()).slice(-7)}${minted}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
    SELECT gen_random_uuid(), ${code}, o.id, d.id, 'in_transit', now() - interval '24 hours', u.id
    FROM warehouses o, warehouses d, users u
    WHERE o.code = 'YW' AND d.code = ${destCode} AND u.phone = ${LOGIST}
    RETURNING id`;
  if (!row) throw new Error(`the demo has no YW, ${destCode} or logist to mint the truck from`);
  return { id: row.id, code };
}

export async function warehouseId(sql: postgres.Sql, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM warehouses WHERE code = ${code}`;
  if (!row) throw new Error(`the demo has no ${code}`);
  return row.id;
}

export async function localeOf(sql: postgres.Sql, phone: string): Promise<string> {
  const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${phone}`;
  return row!.locale;
}

/**
 * The trucks, their events and the notifications those events fanned out to.
 *
 * The drain CLAIMS an event (stamping `processed_at`) before it inserts that
 * event's notifications, so «processed» is not «done»: a delete that runs in
 * that gap loses to the foreign key. Wait for every event to be claimed, then
 * delete in one transaction and retry a refusal — never leave a truck behind
 * (#183: a rerouted truck is on every later spec's /transit and map).
 */
export async function dropTrucks(sql: postgres.Sql, ids: string[]) {
  if (ids.length === 0) return;
  for (let i = 0; i < 30; i += 1) {
    const [open] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events WHERE entity_id = ANY(${ids}::uuid[]) AND processed_at IS NULL`;
    if (open!.n === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  let last: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await sql.begin(async (tx) => {
        await tx`
          DELETE FROM notifications
          WHERE event_id IN (SELECT id FROM events WHERE entity_id = ANY(${ids}::uuid[]))`;
        await tx`DELETE FROM events WHERE entity_id = ANY(${ids}::uuid[])`;
        await tx`DELETE FROM batches WHERE id = ANY(${ids}::uuid[])`;
      });
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw last;
}
