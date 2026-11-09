import { eq, sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';
import { batchSeqCode, batchSeqPrefix, readCounter } from '../codes';
import { firstNameOf, numberHolderOf, type NumberHolder } from './former-codes';

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
 * Did the give-back release this truck's number? Its one audit row says so
 * (`after.released`, written only by `releaseTrailingCodes`) — the plate case
 * included, where the name did not change and only the counter moved.
 */
export async function auditSaysReleased(handle: Db | Tx, batchId: string): Promise<boolean> {
  const rows = (await handle.execute(sql`
    SELECT 1 FROM audit_log a
     WHERE a.entity_type = 'batch' AND a.entity_id = ${batchId}::uuid AND a.action = 'update'
       AND (a.after->>'released') = 'true'
     LIMIT 1
  `)) as unknown as unknown[];
  return [...rows].length > 0;
}

/** The card's line — durable, read from the truck's own rows. */
export type NumberState =
  | { kind: 'returned'; number: string }
  | { kind: 'kept'; why: NumberKeptWhy; number?: string; name?: string };

/** How far the explainer walks from the counter's top before it says «newer» — a busy prefix's top is live. */
const EXPLAIN_WALK = 200;

/**
 * What became of a cancelled truck's number — `null` for a truck that is not
 * cancelled. Read-only, on the POOL, the same predicate the writer asks: a
 * truck the give-back renamed (or released from its plate) says «Raqami
 * qaytarildi»; any other says «Raqam qaytmadi» and the reason that stands
 * NOW — the first number from the counter's top down that does not come
 * back, or the truck's own. `pending` is a truck the rule would release that
 * no walk has yet (the release ran into a lock, or failed): the next cancel
 * on the prefix, or the dry-run script's `--apply`, frees it.
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
  const first = (await firstNameOf(db, batchId)) ?? row.code;
  if (await auditSaysReleased(db, batchId)) return { kind: 'returned', number: first };
  if (row.departedAt) return { kind: 'kept', why: 'left', number: first };

  const prefix = batchSeqPrefix({ code: row.whCode, batchPrefix: row.batchPrefix });
  const n = numberOfCode(prefix, first);
  if (n === null) return { kind: 'kept', why: 'prefix', number: first };
  const top = await readCounter(db, 'batch_seq', prefix);
  if (top === null) return { kind: 'kept', why: 'no_counter', number: first };
  // Below its own number, unreleased: nothing walking down from the top will
  // ever reach it, and the mint walks past a name a truck still wears.
  if (top < n) return { kind: 'kept', why: 'error', number: first };

  // The numbers above it, top first: the first that does not come back is
  // what keeps this one.
  for (let m = top, walked = 0; m > n; m -= 1, walked += 1) {
    const above = batchSeqCode(prefix, m);
    if (walked >= EXPLAIN_WALK) return { kind: 'kept', why: 'newer', number: first, name: batchSeqCode(prefix, top) };
    const verdict = await numberVerdict(db, above);
    if (verdict.ok) continue;
    if (verdict.why === 'unworn') return { kind: 'kept', why: 'unworn', number: above };
    if (verdict.why === 'renamed_left') return { kind: 'kept', why: 'renamed_left', number: above, name: verdict.holder?.code };
    // A live truck — or a cancelled one that keeps its own number — sits
    // above: «YW-011 allaqachon ochilgan».
    return { kind: 'kept', why: 'newer', number: first, name: verdict.holder?.code ?? above };
  }

  const own = await numberVerdict(db, batchSeqCode(prefix, n));
  // Another truck holds this number now (one renamed to it by hand after
  // this one let it go before departure).
  if (own.holder && own.holder.id !== batchId) {
    return { kind: 'kept', why: 'newer', number: first, name: own.holder.code };
  }
  if (!own.ok) return { kind: 'kept', why: own.why, number: first, name: own.holder?.code };
  return { kind: 'kept', why: 'pending', number: first };
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
  /** Cancelled, never departed, wearing a name in this prefix — the give-back's candidates. */
  cancelled: { code: string; createdAt: Date; atAgent: boolean }[];
  gaps: NumberGap[];
  /** What `--apply` would give back: the trailing walk, read-only, the writer's own verdict. */
  wouldReturn: string[];
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
             )) AS at_agent
        FROM batches b WHERE upper(b.code) LIKE ${like} ESCAPE '!'
    `)) as unknown as { code: string; status: string; created_at: string; departed: boolean; at_agent: boolean }[];
    let highest: { n: number; code: string } | null = null;
    for (const truck of [...worn]) {
      const n = numberOfCode(prefix, truck.code);
      if (n !== null && (!highest || n > highest.n)) highest = { n, code: truck.code };
    }
    const cancelled = [...worn]
      .filter((truck) => truck.status === 'cancelled' && !truck.departed)
      .map((truck) => ({ code: truck.code, createdAt: new Date(truck.created_at), atAgent: truck.at_agent === true }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const gaps: NumberGap[] = [];
    const wouldReturn: string[] = [];
    let trailing = true;
    for (let m = counter, walked = 0; m >= 1 && walked < REPORT_NUMBERS; m -= 1, walked += 1) {
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
    });
  }
  return out;
}
