import { eq, sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';
import { batchSeqCode, batchSeqPrefix, readCounter } from '../codes';
import { firstNameOf, namesWornBy, numberHolderOf, type NumberHolder } from './former-codes';

/*
 * «Bekor qilingan partiya raqami» — whether a cancelled truck's number comes
 * back (the owner's 4a 5a 7a, docs/NARX-VA-RAQAM.md §2.2 + §3.2). The READ
 * half: the rule one number at a time (`numberVerdict`), asked by the writer
 * (`releaseTrailingCodes`, batches/rename.ts — `batches.code` keeps its one
 * writer) before and under its locks, and by the cancelled truck's card to say
 * DURABLY what happened to its number (`batchNumberState`) — the cancel dialog
 * that heard the answer is unmounted by the very refresh the cancel causes.
 *
 * «Trailing, never left, never at the agent»: number N of prefix P comes back
 * only while it is the counter's top and its holder (former-codes.ts
 * `numberHolderOf`) is cancelled, never departed, never ticked «agentga
 * yuborildi», and P-pad(N) is no name a truck wore on the road. Anything else
 * stops the walk, and says why in words.
 */

/** Why a number did not come back — a sentence each in `batches.number.kept` (fenced). */
export const NUMBER_KEPT = [
  'newer',
  'agent',
  'left',
  'renamed_left',
  'unworn',
  'no_counter',
  'prefix',
  'pending',
  'busy',
  'error',
] as const;
export type NumberKeptWhy = (typeof NUMBER_KEPT)[number];

/** What one number's holder makes of it — the walk and the card both ask this. */
export type NumberVerdict =
  | { ok: true; holder: NumberHolder }
  | { ok: false; why: 'newer' | 'agent' | 'left' | 'renamed_left' | 'unworn'; holder: NumberHolder | null };

export async function numberVerdict(handle: Db | Tx, code: string): Promise<NumberVerdict> {
  const holder = await numberHolderOf(handle, code);
  // A number the counter passed and nobody holds: a test-deleted truck, a
  // hand-moved counter. Stop — giving it out could be giving out what the
  // owner already counted.
  if (!holder) return { ok: false, why: 'unworn', holder: null };
  // A live truck holds it: «YW-011 allaqachon ochilgan» (his 5a). A live
  // truck renamed away that has LEFT counts in his count under its new name.
  if (holder.status !== 'cancelled') {
    return { ok: false, why: holder.departed && !holder.wears ? 'renamed_left' : 'newer', holder };
  }
  // Cancelled after it left (the annul, receipts/annul.ts): it is a real
  // journey and keeps its number (§2.5).
  if (holder.departed) return { ok: false, why: holder.wears ? 'left' : 'renamed_left', holder };
  // His 7a: the agent holds papers under this number — now, or once.
  if (holder.atAgent) return { ok: false, why: 'agent', holder };
  // A belt: a name that reached the road is never another truck's.
  if (holder.roadFormer) return { ok: false, why: 'renamed_left', holder };
  return { ok: true, holder };
}

/** The number a minted name carries under TODAY's prefix — the exact string, never a parse (§2.2). */
export function numberOfCode(prefix: string, code: string): number | null {
  const head = `${prefix}-`.toUpperCase();
  const upper = code.toUpperCase();
  if (!upper.startsWith(head)) return null;
  const tail = upper.slice(head.length);
  if (!/^\d+$/.test(tail)) return null;
  const n = Number(tail);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return batchSeqCode(prefix, n).toUpperCase() === upper ? n : null;
}

/**
 * The numbers the give-back released FROM this truck, in the order it freed
 * them — `null` when it released none. Each release writes one audit row
 * (`after.released`, only `releaseTrailingCodes` writes it) and that row
 * names the number it freed (`after.number`): the plate case included, where
 * the name did not change and only the counter moved, and a truck that wore
 * another truck's vacated number, where its BORN name is not what came back
 * (review C1 — the card used to print `firstNameOf` and said a live
 * colleague's number had returned). A row from before `number` was written
 * names nothing and the caller falls back to the born name.
 */
export async function releasedNumbersOf(handle: Db | Tx, batchId: string): Promise<string[] | null> {
  const rows = (await handle.execute(sql`
    SELECT a.after->>'number' AS number FROM audit_log a
     WHERE a.entity_type = 'batch' AND a.entity_id = ${batchId}::uuid AND a.action = 'update'
       AND (a.after->>'released') = 'true'
     ORDER BY a.id ASC
  `)) as unknown as { number: string | null }[];
  const list = [...rows];
  if (list.length === 0) return null;
  return [...new Set(list.map((row) => row.number).filter((n): n is string => typeof n === 'string' && n !== ''))];
}

/**
 * The number a cancelled truck HOLDS, by the holder rule and never by a guess
 * from its history (review C1): the name it wears when that is a mint string
 * of today's prefix that `numberHolderOf` gives to THIS truck (a cancelled
 * wearer of a live colleague's vacated number does not hold it — review M6);
 * else, of the mint strings it ever renamed away from, the highest that
 * `numberHolderOf` still gives to THIS truck — the walk from the top meets
 * that one first; else its born name, which is the old answer and the one
 * the «another truck holds it now» and «prefix» branches below read.
 */
async function heldNumberOf(handle: Db | Tx, batchId: string, prefix: string, wears: string): Promise<string> {
  if (numberOfCode(prefix, wears) !== null && (await numberHolderOf(handle, wears))?.id === batchId) return wears;
  const minted = (await namesWornBy(handle, batchId))
    .map((name) => ({ name, n: numberOfCode(prefix, name) }))
    .filter((c): c is { name: string; n: number } => c.n !== null)
    .sort((a, b) => b.n - a.n);
  for (const candidate of minted) {
    if ((await numberHolderOf(handle, candidate.name))?.id === batchId) return candidate.name;
  }
  return (await firstNameOf(handle, batchId)) ?? wears;
}

/** The card's line — durable, read from the truck's own rows. */
export type NumberState =
  /**
   * Every number the give-back freed from this truck — usually one; two when
   * it held a vacated one too. `taken`, only when there is one: those of them
   * a truck has since carried on the road under a rename — burned for good
   * (no mint will hand them out), named by that truck as it is called now.
   * `agent`, likewise: those a truck has since worn while its papers went to
   * the agent — the mint passes over them too (review M5).
   */
  | { kind: 'returned'; numbers: string[]; taken?: { number: string; name: string }[]; agent?: string[] }
  | { kind: 'kept'; why: NumberKeptWhy; number?: string; name?: string };

/** How far the explainer walks from the counter's top before it says «newer» — a busy prefix's top is live. */
const EXPLAIN_WALK = 200;

/**
 * What became of a cancelled truck's number — `null` for a truck that is not
 * cancelled. Read-only, on the POOL, the same predicate the writer asks: a
 * truck the give-back renamed (or released from its plate) says «Raqami
 * qaytarildi» and names the numbers its release rows freed (and, of those,
 * any a truck has since carried on the road: `taken`); any other says
 * «Raqam qaytmadi» and the reason that stands NOW — the first number from the
 * counter's top down that does not come back, or the truck's own (the number
 * it HOLDS, `heldNumberOf`). `pending` is a truck the rule would release that
 * no walk has yet (the release ran into a lock, or failed): the next cancel
 * on the prefix, or the dry-run script's `--apply`, frees it — unless a new
 * truck of the prefix is opened first, which passes over it for good.
 */
export async function batchNumberState(batchId: string): Promise<NumberState | null> {
  const [row] = await db
    .select({
      id: batches.id,
      code: batches.code,
      status: batches.status,
      departedAt: batches.departedAt,
      whCode: warehouses.code,
      batchPrefix: warehouses.batchPrefix,
    })
    .from(batches)
    .innerJoin(warehouses, eq(warehouses.id, batches.originWarehouseId))
    .where(eq(batches.id, batchId));
  if (!row || row.status !== 'cancelled') return null;
  const released = await releasedNumbersOf(db, batchId);
  if (released) {
    const numbers = released.length ? released : [(await firstNameOf(db, batchId)) ?? row.code];
    // «Keyingi mashinaga beriladi» is a promise about the MINT, so it is read
    // live and not from the release row (review RVF3-2): a number given back
    // and then worn on the road by another truck under a hand rename is a
    // road former name, which no mint ever hands out again. The verdict's
    // holder is then the truck that carried it (`numberHolderOf`'s road-first
    // rule), by the name it wears now. A holder BORN with it got it from the
    // mint — the promise kept, whatever it is called on the road since
    // (review M3). And a number the agent has since had papers under is one
    // the mint passes over (review M5): the verdict says 'agent' for it.
    const taken: { number: string; name: string }[] = [];
    const agent: string[] = [];
    for (const number of numbers) {
      const verdict = await numberVerdict(db, number);
      const holder = verdict.holder;
      if (holder && holder.id !== batchId && holder.born) continue;
      if (holder && holder.id !== batchId && holder.roadFormer) taken.push({ number, name: holder.code });
      else if (!verdict.ok && verdict.why === 'agent') agent.push(number);
    }
    return {
      kind: 'returned',
      numbers,
      ...(taken.length ? { taken } : {}),
      ...(agent.length ? { agent } : {}),
    };
  }
  const prefix = batchSeqPrefix({ code: row.whCode, batchPrefix: row.batchPrefix });
  const held = await heldNumberOf(db, batchId, prefix, row.code);
  if (row.departedAt) return { kind: 'kept', why: 'left', number: held };

  const n = numberOfCode(prefix, held);
  if (n === null) return { kind: 'kept', why: 'prefix', number: held };
  const top = await readCounter(db, 'batch_seq', prefix);
  if (top === null) return { kind: 'kept', why: 'no_counter', number: held };
  // Below its own number, unreleased: nothing walking down from the top will
  // ever reach it, and the mint walks past a name a truck still wears.
  if (top < n) return { kind: 'kept', why: 'error', number: held };

  // The numbers above it, top first: the first that does not come back is
  // what keeps this one.
  for (let m = top, walked = 0; m > n; m -= 1, walked += 1) {
    const above = batchSeqCode(prefix, m);
    if (walked >= EXPLAIN_WALK) return { kind: 'kept', why: 'newer', number: held, name: batchSeqCode(prefix, top) };
    const verdict = await numberVerdict(db, above);
    if (verdict.ok) continue;
    if (verdict.why === 'unworn') return { kind: 'kept', why: 'unworn', number: above };
    if (verdict.why === 'renamed_left') return { kind: 'kept', why: 'renamed_left', number: above, name: verdict.holder?.code };
    // A live truck — or a cancelled one that keeps its own number — sits
    // above: «YW-011 allaqachon ochilgan».
    return { kind: 'kept', why: 'newer', number: held, name: verdict.holder?.code ?? above };
  }

  const own = await numberVerdict(db, batchSeqCode(prefix, n));
  // Another truck holds this number now (one renamed to it by hand after
  // this one let it go before departure): a live one is «allaqachon
  // ochilgan»; one that carried it away on the road, or wears it with papers
  // at the agent, says so — the dry run's own words for that number
  // (review M4).
  if (own.holder && own.holder.id !== batchId) {
    const why = !own.ok && (own.why === 'renamed_left' || own.why === 'agent') ? own.why : 'newer';
    return { kind: 'kept', why, number: held, name: own.holder.code };
  }
  if (!own.ok) return { kind: 'kept', why: own.why, number: held, name: own.holder?.code };
  return { kind: 'kept', why: 'pending', number: held };
}

/**
 * One number that is NOT a truck that left under it — what the dry run reads
 * to him (his 7a, §3.2.7). `cancelled` is a cancelled truck that never left
 * (`atAgent` when its papers went); the rest are the verdict's own words.
 */
export type GapKind = 'cancelled' | 'renamed_left' | 'renamed_waiting' | 'unworn' | 'left_cancelled';

export interface NumberGap {
  number: string;
  kind: GapKind;
  /** The holder's name now, where it differs from the number. */
  name?: string;
  atAgent?: boolean;
}

export interface PrefixReport {
  prefix: string;
  counter: number;
  /** Every active or retired warehouse whose sequence this is TODAY — one prefix may be two warehouses'. */
  warehouses: string[];
  /** The highest `P-<digits>` a truck wears now, as the mint built it. */
  highestCode: string | null;
  /**
   * Cancelled, never departed, wearing a name in this prefix — `released`
   * when the give-back already returned its number (a «… (bekor)» name).
   */
  cancelled: { code: string; createdAt: Date; atAgent: boolean; released: boolean }[];
  gaps: NumberGap[];
  /** What `--apply` would give back: the trailing walk, read-only, the writer's own verdict. */
  wouldReturn: string[];
  /**
   * What stops that walk (review C5): the first number from the top that does
   * not come back, by the verdict's own reason; `'empty'` when nothing is
   * left below it (the counter is 0, or every number down to 1 comes back);
   * `null` only when the walk was cut at `REPORT_NUMBERS`. The dry run says
   * it in his words — it printed one fixed sentence for every reason.
   */
  stoppedBy: { why: NumberKeptWhy; number: string; name?: string } | 'empty' | null;
}

/** A prefix's numbers checked one by one at most this far down; a longer history is cut and said. */
const REPORT_NUMBERS = 2000;

/**
 * The dry run behind `scripts/batch-raqam.ts` (his 7a, docs/NARX-VA-RAQAM.md
 * §2.3 + §3.2.7): EVERY `batch_seq` counter row, an old prefix's included —
 * a prefix changed on /admin/warehouses leaves its counter and its trucks
 * behind, and iterating today's prefixes alone would never list them. Per
 * prefix: the counter, the warehouses that use it today, the highest code
 * worn, the cancelled never-departed trucks, every number from 1 to the top
 * that is not a truck that left under it — labelled by the SAME verdict the
 * give-back asks — and the trailing numbers `--apply` would return. Gaps in
 * the middle are listed and stay (his 7a). Read-only.
 */
export async function batchNumberReport(only?: readonly string[]): Promise<PrefixReport[]> {
  // `only` narrows it to some prefixes — a test's own, so it never walks
  // every counter a shared database has collected.
  const narrow = only && only.length ? sql` AND scope_key IN (${sql.join(only.map((p) => sql`${p}`), sql`, `)})` : sql``;
  const counters = (await db.execute(sql`
    SELECT scope_key, value FROM counters WHERE kind = 'batch_seq'${narrow} ORDER BY scope_key
  `)) as unknown as { scope_key: string; value: string | number }[];
  const whs = await db
    .select({ code: warehouses.code, batchPrefix: warehouses.batchPrefix, active: warehouses.active })
    .from(warehouses)
    .orderBy(warehouses.code);
  const out: PrefixReport[] = [];
  for (const row of [...counters]) {
    const prefix = row.scope_key;
    const counter = Number(row.value);
    // LIKE with the prefix escaped (`!`): a prefix is free text, and `_` and
    // `%` are its own characters here. The JS check is the exact mint string.
    const like = `${prefix.toUpperCase().replace(/[!%_]/g, (ch) => `!${ch}`)}-%`;
    const worn = (await db.execute(sql`
      SELECT b.code, b.status, b.created_at::text AS created_at, (b.departed_at IS NOT NULL) AS departed,
             (b.sent_to_agent_at IS NOT NULL OR EXISTS (
                SELECT 1 FROM audit_log t
                 WHERE t.entity_type = 'batch' AND t.entity_id = b.id AND (t.after->>'sentToAgent') = 'true'
             )) AS at_agent,
             EXISTS (
               SELECT 1 FROM audit_log r
                WHERE r.entity_type = 'batch' AND r.entity_id = b.id AND r.action = 'update'
                  AND (r.after->>'released') = 'true'
             ) AS released
        FROM batches b WHERE upper(b.code) LIKE ${like} ESCAPE '!'
    `)) as unknown as {
      code: string;
      status: string;
      created_at: string;
      departed: boolean;
      at_agent: boolean;
      released: boolean;
    }[];
    let highest: { n: number; code: string } | null = null;
    for (const truck of [...worn]) {
      const n = numberOfCode(prefix, truck.code);
      if (n !== null && (!highest || n > highest.n)) highest = { n, code: truck.code };
    }
    const cancelled = [...worn]
      .filter((truck) => truck.status === 'cancelled' && !truck.departed)
      .map((truck) => ({
        code: truck.code,
        createdAt: new Date(truck.created_at),
        atAgent: truck.at_agent === true,
        released: truck.released === true,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const gaps: NumberGap[] = [];
    const wouldReturn: string[] = [];
    let stoppedBy: PrefixReport['stoppedBy'] = null;
    let trailing = true;
    let m = counter;
    for (let walked = 0; m >= 1 && walked < REPORT_NUMBERS; m -= 1, walked += 1) {
      const code = batchSeqCode(prefix, m);
      const verdict = await numberVerdict(db, code);
      if (verdict.ok) {
        if (trailing) wouldReturn.push(code);
        gaps.push({
          number: code,
          kind: 'cancelled',
          ...(verdict.holder.wears ? {} : { name: verdict.holder.code }),
          atAgent: false,
        });
        continue;
      }
      if (trailing) stoppedBy = { why: verdict.why, number: code, ...(verdict.holder ? { name: verdict.holder.code } : {}) };
      trailing = false;
      const holder = verdict.holder;
      if (verdict.why === 'unworn') gaps.push({ number: code, kind: 'unworn' });
      else if (verdict.why === 'agent') {
        gaps.push({ number: code, kind: 'cancelled', atAgent: true, ...(holder?.wears ? {} : { name: holder?.code }) });
      } else if (verdict.why === 'renamed_left') gaps.push({ number: code, kind: 'renamed_left', name: holder?.code });
      else if (verdict.why === 'left') gaps.push({ number: code, kind: 'left_cancelled' });
      else if (holder && !holder.wears) gaps.push({ number: code, kind: 'renamed_waiting', name: holder.code });
      // A live truck wearing its own number is no gap.
    }
    // The walk ran out of numbers, not into one that stays.
    if (trailing && m < 1) stoppedBy = 'empty';
    out.push({
      prefix,
      counter,
      warehouses: whs
        .filter((wh) => batchSeqPrefix(wh) === prefix)
        .map((wh) => (wh.active ? wh.code : `${wh.code} (o‘chirilgan)`)),
      highestCode: highest?.code ?? null,
      cancelled,
      gaps: gaps.reverse(),
      wouldReturn,
      stoppedBy,
    });
  }
  return out;
}
