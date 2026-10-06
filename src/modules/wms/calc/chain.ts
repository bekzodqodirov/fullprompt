import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { likeNeedle } from '../search/query';
import type { InternalNoteSight } from './control-scope';
import { answerCreditSql, creditsSql, isAnswerSql, sealCreditSql } from './credit';
import { itemNameNorm } from './memory';
import type { CalcSectionName } from './pricing';

/**
 * The correction CHAIN — what «V2» actually counts.
 *
 * The owner: «qayta hisoblaganda V1 turibti, V2 bo'lib chiqishi kerak
 * emasmi? eski narxlar tarixi bo'lishi kerak emasmidi?» Both halves have one
 * cause. `calc_requests.current_version_no` counts seals OF ONE REQUEST, and a
 * correction is a NEW request (`recalcFromSealed`, never a re-open — the
 * clock, the sweep and the manual «Bajarildi» must not re-arm against a
 * locked price). So every correction is born at 0, seals at 1, and reads
 * «V1». The column was copied from load plans, where a plan IS re-submitted on
 * the same row and v2 is real; here the counter is measuring the wrong noun.
 *
 * MEASURED before deciding: `current_version_no` has exactly two readers in
 * the tree, both inside the seal's own UPDATE … RETURNING, and nothing ever
 * clears `completed_at`, so the column can only hold 0 or 1. Nothing selects
 * on `version_no` across requests either — every money rule keys on
 * `request_id`, `version_id` or `supersedes_request_id` (checked by grep, not
 * hoped). Which is what makes DERIVING the number safe: the printed «V2»
 * changes, and nothing any of them select changes with it.
 *
 * The number is the rank among the chain's SEALED versions, by seal time —
 * not the chain's depth. A chain can hold a priceless link (sealed → handed
 * back → sealed again), and depth would call the last one V3 when two prices
 * ever existed. And it is NOT stored: a copied counter can disagree with the
 * graph and nothing can tell (#528's shape, a pair rule in one direction),
 * and a backfill would make a sealed column mean two things depending on when
 * its row was written. The graph already knows; the old prices were never
 * lost — `calc_versions` is never deleted — they had no screen. No migration.
 *
 * «Stands» is decided by the EDGE (a child request exists), never by rank
 * position — `notSupersededSql`'s own rule, which the offer and upsale money
 * already obey. Two sealed siblings off one parent both stand, which is true
 * and is the only visible sign of a fork; `recalcFromSealed` now refuses to
 * mint one.
 */

/**
 * How a request's correction ENDED — the one column every «stands» word
 * reads (review ved-correctness-15/16): the chain chip, the sheet's status
 * and the registry's answer rows.
 *
 *   - `open`     — a correction is being written («qayta hisoblanmoqda»);
 *   - `sealed`   — it sealed («V{n} bilan almashtirilgan»);
 *   - `answered` — it ended with a Готово price («o'rniga umumiy narx»);
 *   - `returned` — it was handed back («tuzatish qaytarildi»);
 *   - `unpriced` — it closed with no price at all.
 *
 * `recalc_open` used to be «a child with no version», so a correction that
 * ended in Готово or a hand-back read «qayta hisoblanmoqda» for ever. In every
 * state but none the parent no longer STANDS — the edge supersedes, which is
 * `notSupersededSql`'s own rule and what the money already obeys.
 */
export type ChildState = 'open' | 'sealed' | 'answered' | 'returned' | 'unpriced';

/** The direct child's ending, over a parent id expression; NULL with no child.
 * 0096's partial UNIQUE index allows one child per parent — the ORDER BY is a
 * belt for rows from before it. */
export function childStateSql(parentId: SQL): SQL {
  return sql`(
    SELECT CASE
             WHEN c.completed_at IS NULL THEN 'open'
             WHEN EXISTS (SELECT 1 FROM calc_versions cv WHERE cv.request_id = c.id) THEN 'sealed'
             WHEN ${isAnswerSql('c')} THEN 'answered'
             WHEN c.completed_via = 'returned' THEN 'returned'
             ELSE 'unpriced'
           END
      FROM calc_requests c
     WHERE c.supersedes_request_id = ${parentId}
     ORDER BY c.requested_at DESC
     LIMIT 1
  )`;
}

/**
 * Every request with the root of its chain. Recursion from the roots down, so
 * a fork's siblings share a root; capped in depth because the walk is over a
 * live table and a cycle, however impossible by construction, would otherwise
 * be a hang in a screen.
 */
function treeSql(): SQL {
  return sql`
    tree AS (
      SELECT id, id AS root_id, 0 AS depth
        FROM calc_requests
       WHERE supersedes_request_id IS NULL
      UNION ALL
      SELECT r.id, t.root_id, t.depth + 1
        FROM calc_requests r
        JOIN tree t ON r.supersedes_request_id = t.id
       WHERE t.depth < 64
    ),
    ranked0 AS (
      SELECT v.id            AS version_id,
             v.request_id,
             t.root_id,
             v.sealed_at,
             v.sealed_by,
             v.valid_until,
             v.section,
             v.total_usd,
             v.per_m3_usd,
             v.per_kg_usd,
             v.discount_usd,
             v.band_override_min,
             row_number() OVER (PARTITION BY t.root_id ORDER BY v.sealed_at, v.id)::int AS quote_no,
             EXISTS (
               SELECT 1 FROM calc_requests c WHERE c.supersedes_request_id = v.request_id
             ) AS superseded,
             (${childStateSql(sql.raw('v.request_id'))}) IS NOT DISTINCT FROM 'open' AS recalc_open,
             ${childStateSql(sql.raw('v.request_id'))} AS child_state
        FROM calc_versions v
        JOIN tree t ON t.id = v.request_id
    ),
    ranked AS (
      SELECT rk0.*,
             (
               SELECT min(nx.quote_no)
                 FROM ranked0 nx
                 JOIN calc_requests c ON c.id = nx.request_id
                WHERE c.supersedes_request_id = rk0.request_id
             ) AS superseded_by_no
        FROM ranked0 rk0
    )`;
}

export interface ChainVersion {
  versionId: string;
  requestId: string;
  /** The rank among the chain's sealed versions — what «V2» prints. */
  quoteNo: number;
  sealedAt: Date;
  sealedByName: string | null;
  section: CalcSectionName;
  totalUsd: number;
  /** A child request exists — the edge, not the rank. */
  superseded: boolean;
  /** The child that replaced it, when it has sealed. */
  supersededByNo: number | null;
  /** A child exists and is still OPEN: a correction is being written. */
  recalcOpen: boolean;
  /** How the direct child ended — null with no child (`ChildState`). */
  childState: ChildState | null;
  expired: boolean;
}

type RankedRow = {
  version_id: string;
  request_id: string;
  root_id: string;
  /** `db.execute` hands timestamptz back as TEXT («2026-09-04 21:30:44+00»),
   * not as a Date — `history.ts`'s own idiom, measured before this was
   * typed: a string compared to a Date is never «expired» and
   * `format.dateTime` on it is a FORMATTING_ERROR on every row. */
  sealed_at: string;
  sealed_by_name: string | null;
  valid_until: string;
  section: string;
  total_usd: string;
  per_m3_usd: string | null;
  per_kg_usd: string | null;
  discount_usd: string | null;
  band_override_min: string | null;
  quote_no: number;
  superseded: boolean;
  recalc_open: boolean;
  superseded_by_no: number | null;
  child_state: ChildState | null;
};

function toChain(r: RankedRow, now: Date): ChainVersion {
  return {
    versionId: r.version_id,
    requestId: r.request_id,
    quoteNo: Number(r.quote_no),
    sealedAt: new Date(r.sealed_at),
    sealedByName: r.sealed_by_name,
    section: r.section as CalcSectionName,
    totalUsd: Number(r.total_usd),
    superseded: r.superseded,
    supersededByNo: r.superseded_by_no === null ? null : Number(r.superseded_by_no),
    recalcOpen: Boolean(r.recalc_open),
    childState: r.child_state ?? null,
    expired: new Date(r.valid_until).getTime() < now.getTime(),
  };
}

/**
 * The whole chain a request belongs to, oldest seal first.
 *
 * One query, both directions: up to the root, then everything under it. This
 * is what the workspace prints under a sealed price and what the card prints
 * as «Oldingi: V1 …» — the old price is a document at a URL, not a number.
 */
export async function chainOf(requestId: string, now = new Date()): Promise<ChainVersion[]> {
  const rows = await db.execute<RankedRow>(sql`
    WITH RECURSIVE up AS (
      SELECT id, supersedes_request_id, 0 AS depth FROM calc_requests WHERE id = ${requestId}::uuid
      UNION ALL
      SELECT r.id, r.supersedes_request_id, u.depth + 1
        FROM calc_requests r JOIN up u ON r.id = u.supersedes_request_id
       WHERE u.depth < 64
    ),
    ${treeSql()}
    SELECT rk.*, u.full_name AS sealed_by_name
      FROM ranked rk
      LEFT JOIN users u ON u.id = rk.sealed_by
     WHERE rk.root_id = (SELECT id FROM up WHERE supersedes_request_id IS NULL LIMIT 1)
     ORDER BY rk.sealed_at, rk.version_id
  `);
  return rows.map((r) => toChain(r, now));
}

/**
 * `chainOf` for MANY requests in ONE query (0119) — the deal's calculation
 * sheet and the Telegram ask print a «V2» per request, and a query per request
 * is #432's shape on a list. Each request id maps to its whole chain, oldest
 * seal first, exactly what `chainOf` answers for it alone (a test says so).
 */
export async function chainVersionsFor(
  requestIds: string[],
  now = new Date(),
): Promise<Map<string, ChainVersion[]>> {
  const ids = [...new Set(requestIds)].filter(Boolean);
  const out = new Map<string, ChainVersion[]>();
  if (ids.length === 0) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await db.execute<RankedRow & { start_id: string }>(sql`
    WITH RECURSIVE up AS (
      SELECT id AS start_id, id, supersedes_request_id, 0 AS depth
        FROM calc_requests WHERE id IN (${list})
      UNION ALL
      SELECT u.start_id, r.id, r.supersedes_request_id, u.depth + 1
        FROM calc_requests r JOIN up u ON r.id = u.supersedes_request_id
       WHERE u.depth < 64
    ),
    roots AS (SELECT DISTINCT start_id, id AS root_id FROM up WHERE supersedes_request_id IS NULL),
    ${treeSql()}
    SELECT ro.start_id::text AS start_id, rk.*, u.full_name AS sealed_by_name
      FROM roots ro
      JOIN ranked rk ON rk.root_id = ro.root_id
      LEFT JOIN users u ON u.id = rk.sealed_by
     ORDER BY rk.sealed_at, rk.version_id
  `);
  for (const id of ids) out.set(id, []);
  for (const r of rows) out.get(r.start_id)?.push(toChain(r, now));
  return out;
}

/** The printed number for ONE version, or null when it has none (never sealed). */
export async function quoteNoFor(versionId: string): Promise<number | null> {
  const rows = await db.execute<{ quote_no: number }>(sql`
    WITH RECURSIVE ${treeSql()}
    SELECT quote_no FROM ranked WHERE version_id = ${versionId}::uuid
  `);
  return rows[0] ? Number(rows[0].quote_no) : null;
}

export type RegistryKind = 'sealed' | 'answer';

export interface RegistryFilters {
  /** ISO dates, already validated by the screen. */
  from?: string | null;
  to?: string | null;
  section?: CalcSectionName | null;
  /** «Kim» — the CREDIT holder (a sealer or an answerer), validated as a uuid. */
  personId?: string | null;
  /** «Turi» — sealed versions, Готово answers, or both (null). */
  kind?: RegistryKind | null;
  /** Free text over client code / client name / deal code / the GOODS, and
   * the lead name only when `leadNamesReadable`. */
  q?: string | null;
  /** Whether the reader may see lead NAMES on a calc surface — `crm.leads ||
   * ved.docs` (§10). Every row here is a calc card by construction, so the
   * VED reads the name of the job he priced; the accountant (neither) keeps
   * reading «Lid», and a name the reader may not see must not be searchable
   * either, or the search box becomes the back door (#514). */
  leadNamesReadable: boolean;
}

interface RegistryCard {
  entityType: 'deal' | 'lead';
  entityId: string;
  /** Deal: «GS777 · Bobur». Lead: its name, or null when the reader may not. */
  cardLabel: string | null;
  dealCode: string | null;
  /** The lead's owner — what `calcCardHref` asks `mayOpenLead` with. */
  leadOwnerId: string | null;
}

/** A SEALED version on the registry — what the list has always printed. */
export interface RegistrySealedRow extends ChainVersion, RegistryCard {
  kind: 'sealed';
  perM3Usd: number | null;
  perKgUsd: number | null;
  discountUsd: number;
  bandOverrideMin: number | null;
}

/**
 * A Готово ANSWER on the registry (the owner's 8a) — never V-ranked, never
 * per-unit money (it is one typed figure in its own currency), and never a
 * recomputed customs sum. Its keys are pinned by `calc-history-registry.test.ts`.
 */
export interface RegistryAnswerRow extends RegistryCard {
  kind: 'answer';
  requestId: string;
  answeredAt: Date;
  answeredByName: string | null;
  section: CalcSectionName | null;
  amount: number;
  currency: string | null;
  /** What the seller was told («Sotuvchiga izoh»). */
  sellerNote: string | null;
  /** The VED's own note — fetched ONLY with an InternalNoteSight; null both
   * when it was not fetched and when an old answer has none. */
  internalNote: string | null;
  /** The same edge words as a sealed row's chip (one vocabulary, #513). */
  superseded: boolean;
  supersededByNo: number | null;
  recalcOpen: boolean;
  childState: ChildState | null;
}

export type RegistryRow = RegistrySealedRow | RegistryAnswerRow;

/** How many rows the screen draws; the counts say what it did not. */
export const REGISTRY_CAP = 200;

/** The one predicate the rows AND the counts share (#513). */
function registryWhere(f: RegistryFilters): SQL {
  const conds: SQL[] = [sql`TRUE`];
  // Tashkent's days (R5): a price at 02:00 on the 1st belongs to the 1st, not the 31st.
  if (f.from) conds.push(sql`reg.at >= ((${f.from}::date)::timestamp AT TIME ZONE 'Asia/Tashkent')`);
  if (f.to) conds.push(sql`reg.at < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tashkent')`);
  if (f.section) conds.push(sql`reg.section = ${f.section}`);
  if (f.personId) conds.push(sql`reg.person_id = ${f.personId}::uuid`);
  if (f.kind) conds.push(sql`reg.kind = ${f.kind}`);
  const q = (f.q ?? '').trim();
  if (q) {
    const needle = likeNeedle(q);
    const parts: SQL[] = [
      sql`cl.client_code ILIKE ${needle}`,
      sql`cl.name ILIKE ${needle}`,
      sql`d.code ILIKE ${needle}`,
      // The GOODS (7a): the request's own items on `name_norm` — the column
      // 0096 indexes with a trigram GIN, normalised the way the writers do.
      sql`EXISTS (
        SELECT 1 FROM calc_request_items gi
         WHERE gi.request_id = reg.request_id
           AND gi.name_norm LIKE ${likeNeedle(itemNameNorm(q))}
      )`,
    ];
    // A TNVED PREFIX — four digits and up, the shortest heading the law
    // prices by — on the item's code or its group's.
    const digits = q.replace(/\s+/g, '');
    if (/^\d{4,10}$/.test(digits)) {
      parts.push(sql`EXISTS (
        SELECT 1 FROM calc_request_items ti
          LEFT JOIN calc_groups tg ON tg.id = ti.group_id
         WHERE ti.request_id = reg.request_id
           AND (ti.tnved_code LIKE ${`${digits}%`} OR tg.tnved_code LIKE ${`${digits}%`})
      )`);
    }
    if (f.leadNamesReadable) parts.push(sql`l.name ILIKE ${needle}`);
    conds.push(sql`(${sql.join(parts, sql` OR `)})`);
  }
  return sql.join(conds, sql` AND `);
}

/**
 * The two row kinds under ONE shape (§4, review ved-correctness-17): a sealed
 * version is priced at `sealed_at` by `sealed_by`, an answer at
 * `completed_at` by `completed_by` — the credit rule's own two clocks
 * (`credit.ts`). `tree` gives an answer its root, so «jobs» counts chains of
 * BOTH kinds.
 *
 * The internal note is selected only when a sight is handed in; without one
 * the SQL names NULL and the column is never read (review access-money-10).
 */
function registryCte(noteSight: InternalNoteSight | null): SQL {
  const note = noteSight ? sql.raw('a.answer_internal_note') : sql.raw('NULL::text');
  return sql`
    ${treeSql()},
    reg AS (
      SELECT 'sealed'::text      AS kind,
             rk.version_id::text AS row_id,
             rk.request_id,
             rk.root_id,
             ${sealCreditSql('rk').at}     AS at,
             ${sealCreditSql('rk').person} AS person_id,
             rk.valid_until,
             rk.section,
             rk.total_usd,
             rk.per_m3_usd,
             rk.per_kg_usd,
             rk.discount_usd,
             rk.band_override_min,
             rk.quote_no,
             rk.superseded,
             rk.recalc_open,
             rk.superseded_by_no,
             rk.child_state,
             NULL::numeric       AS answer_amount,
             NULL::text          AS answer_currency,
             NULL::text          AS answer_note,
             NULL::text          AS internal_note
        FROM ranked rk
      UNION ALL
      SELECT 'answer'::text,
             a.id::text,
             a.id,
             t.root_id,
             ${answerCreditSql('a').at},
             ${answerCreditSql('a').person},
             NULL::timestamptz,
             a.section,
             NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
             NULL::int,
             EXISTS (SELECT 1 FROM calc_requests c WHERE c.supersedes_request_id = a.id),
             (${childStateSql(sql.raw('a.id'))}) IS NOT DISTINCT FROM 'open',
             (
               SELECT min(nx.quote_no)
                 FROM ranked nx
                 JOIN calc_requests c ON c.id = nx.request_id
                WHERE c.supersedes_request_id = a.id
             ),
             ${childStateSql(sql.raw('a.id'))},
             a.answer_amount,
             a.answer_currency,
             a.answer_note,
             ${note}
        FROM calc_requests a
        JOIN tree t ON t.id = a.id
       WHERE ${isAnswerSql('a')}
    )`;
}

/** The joins the predicate and the rows both read from. */
function registryFromSql(): SQL {
  return sql`
    FROM reg
    JOIN calc_requests r ON r.id = reg.request_id
    LEFT JOIN users u ON u.id = reg.person_id
    LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
    LEFT JOIN clients cl ON cl.id = d.client_id
    LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id`;
}

type RegistryDbRow = {
  kind: RegistryKind;
  row_id: string;
  request_id: string;
  root_id: string;
  at: string;
  person_id: string | null;
  person_name: string | null;
  valid_until: string | null;
  section: string | null;
  total_usd: string | null;
  per_m3_usd: string | null;
  per_kg_usd: string | null;
  discount_usd: string | null;
  band_override_min: string | null;
  quote_no: number | null;
  superseded: boolean;
  recalc_open: boolean;
  superseded_by_no: number | null;
  child_state: ChildState | null;
  answer_amount: string | null;
  answer_currency: string | null;
  answer_note: string | null;
  internal_note: string | null;
  entity_type: 'deal' | 'lead';
  entity_id: string;
  client_code: string | null;
  client_name: string | null;
  deal_code: string | null;
  lead_name: string | null;
  lead_owner_id: string | null;
};

/**
 * The history — every sealed version AND every Готово answer, newest price
 * first, capped (the owner's 8a, which reverses his 1A of 2026-09-04: «the
 * SAME history, chip «✍️ umumiy narx»»).
 *
 * ONE ROW PER PRICE, not per request and not per card: a corrected job
 * appears once per price it ever had, which is the question the owner asked.
 * Filters run in SQL over the SAME predicate as the counts, because a filter
 * over an already-capped fetch answers «not found» about rows it never
 * fetched (/stock's lesson).
 */
export async function registryRows(
  f: RegistryFilters,
  opts: { noteSight: InternalNoteSight | null; now?: Date },
): Promise<RegistryRow[]> {
  const now = opts.now ?? new Date();
  const rows = await db.execute<RegistryDbRow>(sql`
    WITH RECURSIVE ${registryCte(opts.noteSight)}
    SELECT reg.*, u.full_name AS person_name,
           r.entity_type, r.entity_id,
           cl.client_code, cl.name AS client_name, d.code AS deal_code, l.name AS lead_name,
           l.owner_id::text AS lead_owner_id
    ${registryFromSql()}
    WHERE ${registryWhere(f)}
    ORDER BY reg.at DESC, reg.row_id DESC
    LIMIT ${REGISTRY_CAP}
  `);
  return rows.map((r) => {
    const card: RegistryCard = {
      entityType: r.entity_type,
      entityId: r.entity_id,
      cardLabel:
        r.entity_type === 'deal'
          ? [r.client_code, r.client_name].filter(Boolean).join(' · ') || null
          : f.leadNamesReadable
            ? r.lead_name
            : null,
      dealCode: r.deal_code,
      leadOwnerId: r.lead_owner_id,
    };
    if (r.kind === 'answer') {
      return {
        kind: 'answer',
        ...card,
        requestId: r.request_id,
        // Raw-execute timestamps are TEXT (#923/#925).
        answeredAt: new Date(r.at),
        answeredByName: r.person_name,
        section: (r.section as CalcSectionName | null) ?? null,
        amount: Number(r.answer_amount),
        currency: r.answer_currency,
        sellerNote: r.answer_note,
        internalNote: opts.noteSight ? r.internal_note : null,
        superseded: Boolean(r.superseded),
        supersededByNo: r.superseded_by_no === null ? null : Number(r.superseded_by_no),
        recalcOpen: Boolean(r.recalc_open),
        childState: r.child_state ?? null,
      } satisfies RegistryAnswerRow;
    }
    const base = toChain(
      {
        version_id: r.row_id,
        request_id: r.request_id,
        root_id: r.root_id,
        sealed_at: r.at,
        sealed_by_name: r.person_name,
        valid_until: r.valid_until ?? r.at,
        section: r.section ?? 'podklyuch',
        total_usd: r.total_usd ?? '0',
        per_m3_usd: r.per_m3_usd,
        per_kg_usd: r.per_kg_usd,
        discount_usd: r.discount_usd,
        band_override_min: r.band_override_min,
        quote_no: Number(r.quote_no ?? 0),
        superseded: r.superseded,
        recalc_open: r.recalc_open,
        superseded_by_no: r.superseded_by_no,
        child_state: r.child_state,
      },
      now,
    );
    return {
      kind: 'sealed',
      ...base,
      ...card,
      perM3Usd: r.per_m3_usd === null ? null : Number(r.per_m3_usd),
      perKgUsd: r.per_kg_usd === null ? null : Number(r.per_kg_usd),
      discountUsd: Number(r.discount_usd ?? 0),
      bandOverrideMin: r.band_override_min === null ? null : Number(r.band_override_min),
    } satisfies RegistrySealedRow;
  });
}

/**
 * Three counts over the registry's own predicate, each NAMED (#913): JOBS
 * (distinct chains, both kinds), VERSIONS (sealed rows) and ANSWERS (Готово
 * rows). A corrected job is two rows and one job, and «N ta hisob-kitob»
 * printed alone reads as the other number. The cap sentence fires when
 * versions + answers outnumber the rows drawn (review ved-correctness-17).
 */
export async function registryCounts(
  f: RegistryFilters,
): Promise<{ versions: number; answers: number; jobs: number }> {
  const rows = await db.execute<{ versions: number; answers: number; jobs: number }>(sql`
    WITH RECURSIVE ${registryCte(null)}
    SELECT count(*) FILTER (WHERE reg.kind = 'sealed')::int AS versions,
           count(*) FILTER (WHERE reg.kind = 'answer')::int AS answers,
           count(DISTINCT reg.root_id)::int AS jobs
    ${registryFromSql()}
    WHERE ${registryWhere(f)}
  `);
  return {
    versions: Number(rows[0]?.versions ?? 0),
    answers: Number(rows[0]?.answers ?? 0),
    jobs: Number(rows[0]?.jobs ?? 0),
  };
}

/**
 * «Kim» — the people who ever earned a CREDIT of either kind (replaces
 * `registrySealers`; the old `?ved=` keeps meaning the same person). The
 * filter's options come from the credit rule itself, so a name in the picker
 * is always somebody the list can show (#171: a value the form cannot render
 * disappears on the next submit).
 */
export async function registryPeople(): Promise<{ id: string; name: string }[]> {
  const rows = await db.execute<{ id: string; name: string }>(sql`
    WITH credits AS (${creditsSql()})
    SELECT DISTINCT u.id::text AS id, u.full_name AS name
      FROM credits c JOIN users u ON u.id = c.person_id
     ORDER BY u.full_name
  `);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export interface RegistryGoods {
  count: number;
  /** The first three names, by the request's own order. */
  first: string[];
}

/**
 * «3 tovar: klaviatura, sichqoncha, …» for a page of rows — ONE grouped
 * query, never one per row (#432). A closed request's items are frozen
 * (every writer refuses `already_closed`), so for a sealed version they ARE
 * the breakdown's goods, and for an answer they are the only goods there are.
 */
export async function registryGoods(requestIds: string[]): Promise<Map<string, RegistryGoods>> {
  const ids = [...new Set(requestIds)].filter(Boolean);
  const out = new Map<string, RegistryGoods>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ request_id: string; n: number; first: string[] | null }>(sql`
    SELECT i.request_id::text AS request_id,
           count(*)::int AS n,
           (array_agg(i.name ORDER BY i.seq))[1:3] AS first
      FROM calc_request_items i
     WHERE i.request_id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     GROUP BY i.request_id
  `);
  for (const r of rows) out.set(r.request_id, { count: Number(r.n), first: r.first ?? [] });
  return out;
}

/**
 * Is this request a REGISTRY row — a sealed version or a Готово answer?
 *
 * The goods route answers 404 for anything else (review access-money-21):
 * an open, returned or never-priced job is not on any screen the accountant
 * can open, so a route that took any id would be the #514 back door into
 * goods and bazas no list of his shows.
 */
export async function isRegistryRequest(requestId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT (
      EXISTS (SELECT 1 FROM calc_versions v WHERE v.request_id = r.id)
      OR ${isAnswerSql('r')}
    ) AS ok
      FROM calc_requests r
     WHERE r.id = ${requestId}::uuid
  `);
  return Boolean(rows[0]?.ok);
}

export interface ChainLink {
  kind: RegistryKind;
  requestId: string;
  at: Date;
  byName: string | null;
  /** Sealed only — answers are never V-ranked. */
  quoteNo: number | null;
  /** Sealed: the USD total. Answer: the typed amount in its own currency. */
  amount: number;
  currency: string;
}

/**
 * The whole chain a request belongs to, BOTH kinds, in price-moment order
 * (review ved-correctness-7): seals with their V number, answers as «✍️
 * umumiy narx». `chainOf` stays seal-only — the card's «Oldingi» line and the
 * sheet's `previous` print V numbers, and an answer has none (stated).
 */
export async function chainLinksOf(requestId: string): Promise<ChainLink[]> {
  const rows = await db.execute<{
    kind: RegistryKind;
    request_id: string;
    at: string;
    by_name: string | null;
    quote_no: number | null;
    total_usd: string | null;
    answer_amount: string | null;
    answer_currency: string | null;
  }>(sql`
    WITH RECURSIVE up AS (
      SELECT id, supersedes_request_id, 0 AS depth FROM calc_requests WHERE id = ${requestId}::uuid
      UNION ALL
      SELECT r.id, r.supersedes_request_id, u.depth + 1
        FROM calc_requests r JOIN up u ON r.id = u.supersedes_request_id
       WHERE u.depth < 64
    ),
    ${registryCte(null)}
    SELECT reg.kind, reg.request_id::text AS request_id, reg.at, u.full_name AS by_name,
           reg.quote_no, reg.total_usd, reg.answer_amount, reg.answer_currency
      FROM reg
      LEFT JOIN users u ON u.id = reg.person_id
     WHERE reg.root_id = (SELECT id FROM up WHERE supersedes_request_id IS NULL LIMIT 1)
     ORDER BY reg.at, reg.row_id
  `);
  return rows.map((r) => ({
    kind: r.kind,
    requestId: r.request_id,
    at: new Date(r.at),
    byName: r.by_name,
    quoteNo: r.kind === 'sealed' && r.quote_no !== null ? Number(r.quote_no) : null,
    amount: Number(r.kind === 'sealed' ? r.total_usd : r.answer_amount),
    currency: r.kind === 'sealed' ? 'USD' : (r.answer_currency ?? ''),
  }));
}
