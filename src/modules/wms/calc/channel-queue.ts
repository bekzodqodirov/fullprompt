import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  deals,
  leads,
  priceChannelPosts,
  users,
} from '@/modules/platform/db/schema';
import { logger } from '@/modules/platform/logger';
import { enqueue } from '@/modules/platform/jobs/boss';
import { getSetting } from '@/modules/platform/settings/service';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { clipText } from '@/modules/platform/telegram/format';
import { connectedChannel } from '@/modules/platform/telegram/price-channel';
import { childStateSql, quoteNoFor, type ChildState } from './chain';
import { answerCreditSql, isAnswerSql, sealCreditSql } from './credit';
import { itemNameNorm } from './memory';
import {
  codeCandidates,
  fitGoods,
  nfkc,
  pickPerUnit,
  scrubIdentity,
  type ChannelPostView,
  type ChannelSection,
  type PostKind,
  type SkipReason,
} from './channel-post';

/**
 * The price channel's LEDGER side (the owner's F, 2026-10-07): a given price
 * becomes ONE `price_channel_posts` row, decided at queue time, and the post's
 * projection is built here from the price's own record.
 *
 * Everything runs on the POOL after the price's transaction has committed —
 * the seal and Готово call this from their own catch (#714/#472: a channel
 * that cannot be told must never undo a price). The hooks are the fast path;
 * `queueMissedPrices` is the net the drain casts every minute, because a
 * ledger must not depend on a process surviving the seconds after a commit.
 */

export const JOB_PRICE_CHANNEL = 'price-channel.drain';

/**
 * Run the drain soon. Synchronous, never awaited by a door; a server with no
 * token (dev, CI) never starts pg-boss for this.
 */
export function kickPriceChannel(): void {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  void enqueue(JOB_PRICE_CHANNEL, {}).catch((err: unknown) =>
    logger.warn({ err }, '[price-channel] drain not queued'),
  );
}

export interface QueueInput {
  kind: PostKind;
  requestId: string;
  versionId?: string;
}

/**
 * Claim the price's one row — the claim IS the write (0082's rule): the
 * `dedupe_key` is UNIQUE and CHECKed to mean exactly this price, so a retried
 * hook, the net, a double Готово and two drains all land on ONE row.
 *
 * The decision is made now: a discounted or band-overridden seal is NOT
 * posted (F3 a — his «4c»: the sealed total is net of the discount, and an
 * override prices freight at a density the cargo does not have), and with no
 * channel connected nothing is ever posted later — connecting starts from the
 * NEXT price, never a backlog.
 */
export async function queuePriceChannelPost(input: QueueInput): Promise<'pending' | SkipReason | 'exists'> {
  let skip: SkipReason | null = null;
  if (input.kind === 'seal') {
    if (!input.versionId) throw new Error('queuePriceChannelPost: a seal needs its version');
    const [v] = await db
      .select({ discountUsd: calcVersions.discountUsd, bandOverrideMin: calcVersions.bandOverrideMin })
      .from(calcVersions)
      .where(eq(calcVersions.id, input.versionId))
      .limit(1);
    if (!v) return 'exists';
    if (Number(v.discountUsd) > 0) skip = 'discount';
    else if (v.bandOverrideMin !== null) skip = 'band_override';
  }
  const channel = await connectedChannel();
  if (!skip && !channel) skip = 'no_channel';
  const dedupeKey = input.kind === 'seal' ? `seal:${input.versionId}` : `answer:${input.requestId}`;
  const inserted = await db
    .insert(priceChannelPosts)
    .values({
      kind: input.kind,
      requestId: input.requestId,
      versionId: input.kind === 'seal' ? input.versionId! : null,
      dedupeKey,
      chatId: channel ? channel.chatId : null,
      status: skip ? 'skipped' : 'pending',
      skipReason: skip,
    })
    .onConflictDoNothing({ target: priceChannelPosts.dedupeKey })
    .returning({ id: priceChannelPosts.id });
  if (inserted.length === 0) return 'exists';
  if (!skip) kickPriceChannel();
  return skip ?? 'pending';
}

/**
 * THE NET — prices whose hook never ran (a crash between the commit and the
 * hook, a deploy in that second). Bounded by the connected channel's
 * `connected_at`, which is what keeps «no backlog» true, and by the 24-hour
 * stale horizon (anything older is skipped anyway). Read over the two indexes
 * that exist for exactly these columns (0086's `sealed_at`, 0124's answers).
 */
export async function queueMissedPrices(): Promise<number> {
  const channel = await connectedChannel();
  if (!channel?.connectedAt) return 0;
  const since = channel.connectedAt.toISOString();
  const seals = await db.execute<{ version_id: string; request_id: string }>(sql`
    SELECT v.id::text AS version_id, v.request_id::text AS request_id
      FROM calc_versions v
     WHERE v.sealed_at >= greatest(${since}::timestamptz, now() - interval '24 hours')
       AND NOT EXISTS (SELECT 1 FROM price_channel_posts p WHERE p.dedupe_key = 'seal:' || v.id::text)
     ORDER BY v.sealed_at
     LIMIT 20`);
  const answers = await db.execute<{ id: string }>(sql`
    SELECT r.id::text AS id
      FROM calc_requests r
     WHERE r.completed_at >= greatest(${since}::timestamptz, now() - interval '24 hours')
       AND ${isAnswerSql('r')}
       AND NOT EXISTS (SELECT 1 FROM price_channel_posts p WHERE p.dedupe_key = 'answer:' || r.id::text)
     ORDER BY r.completed_at
     LIMIT 20`);
  let queued = 0;
  for (const s of seals) {
    if ((await queuePriceChannelPost({ kind: 'seal', requestId: s.request_id, versionId: s.version_id })) !== 'exists') queued += 1;
  }
  for (const a of answers) {
    if ((await queuePriceChannelPost({ kind: 'answer', requestId: a.id })) !== 'exists') queued += 1;
  }
  if (queued > 0) logger.info({ queued }, `[price-channel] net queued ${queued}`);
  return queued;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asSection(s: string | null): ChannelSection | null {
  return s === 'yolkira' || s === 'rastamojka' || s === 'podklyuch' ? s : null;
}

function asCurrency(c: string | null): 'USD' | 'UZS' | 'CNY' {
  return c === 'UZS' || c === 'CNY' ? c : 'USD';
}

/**
 * The identity the goods names must not carry — the card's PEOPLE (names,
 * company, phones), split into words by the scrub, and the card's own CODES
 * (its deal's, its client's), removed whole. Codes stay out of the word list:
 * split on «-», `B-000124` left a stray «B» in every post. Held in locals,
 * never returned (F4 a).
 */
async function forbiddenFor(
  entityType: string,
  entityId: string,
): Promise<{ forbidden: string[]; ownCodes: string[] }> {
  const forbidden: string[] = [];
  const ownCodes: string[] = [];
  const addClient = async (clientId: string | null) => {
    if (!clientId) return;
    const [c] = await db
      .select({ code: clients.clientCode, name: clients.name, phones: clients.phones })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!c) return;
    ownCodes.push(c.code);
    forbidden.push(c.name, ...(Array.isArray(c.phones) ? (c.phones as unknown[]).map(String) : []));
  };
  if (entityType === 'deal') {
    const [d] = await db
      .select({ code: deals.code, clientId: deals.clientId })
      .from(deals)
      .where(eq(deals.id, entityId))
      .limit(1);
    if (d) {
      ownCodes.push(d.code);
      await addClient(d.clientId);
    }
  } else {
    const [l] = await db
      .select({ name: leads.name, company: leads.company, phone: leads.phone, clientId: leads.clientId })
      .from(leads)
      .where(eq(leads.id, entityId))
      .limit(1);
    if (l) {
      forbidden.push(l.name, l.company ?? '', l.phone ?? '');
      await addClient(l.clientId);
    }
  }
  const kept = (list: string[]) => list.filter((s) => s.trim() !== '');
  return { forbidden: kept(forbidden), ownCodes: kept(ownCodes) };
}

/**
 * What OTHER clients these names carry, read from the data — because a code
 * opens onto a client wherever it was minted: a manual `444`, a Kashgar
 * marking imported as a code, one minted under an older prefix (the setting is
 * editable), and an unclaimed marking, which is free text and has no shape.
 *
 * Both reads run on the POOL after the price's commit (this whole builder
 * does), so #714 does not apply. Codes go through `clients_code_unique` with
 * `inArray` — a JS array bound into raw SQL is not a postgres array. The
 * markings are ONE statement over ONE bound haystack: a receipt's marking is
 * a needle inside the names, which no index answers, and «no status filter»
 * because ⌘K's lot search by marking has none either.
 */
async function identitiesIn(names: readonly string[]): Promise<{ knownCodes: Set<string>; markings: string[] }> {
  const candidates = codeCandidates(names);
  const known =
    candidates.length === 0
      ? []
      : await db.select({ code: clients.clientCode }).from(clients).where(inArray(clients.clientCode, candidates));
  // The names as typed AND as the scrub reads them (NFKC), so a full-width
  // spelling finds the marking too; `lower` on BOTH sides in SQL, so the
  // database's own ctype decides the case once.
  const haystack = [...names, ...names.map(nfkc)].join('\n');
  const rows =
    haystack.trim() === ''
      ? []
      : await db.execute<{ marking: string }>(sql`
          SELECT DISTINCT r.unclaimed_marking AS marking
            FROM receipts r
           WHERE r.unclaimed_marking IS NOT NULL
             AND char_length(btrim(r.unclaimed_marking)) >= 3
             AND strpos(lower(${haystack}), lower(btrim(r.unclaimed_marking))) > 0`);
  return { knownCodes: new Set(known.map((k) => k.code)), markings: rows.map((r) => r.marking) };
}

/** Up to six scrubbed, distinct goods names in the request's own order, and how many more there were. */
async function goodsFor(
  requestId: string,
  card: { forbidden: string[]; ownCodes: string[] },
): Promise<{ goods: string[]; goodsMore: number }> {
  const items = await db
    .select({ name: calcRequestItems.name })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, requestId))
    .orderBy(asc(calcRequestItems.seq));
  const codePrefix = String((await getSetting('client_code_prefix')) ?? '').trim();
  const { knownCodes, markings } = await identitiesIn(items.map((i) => i.name));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of items) {
    const clean = clipText(
      scrubIdentity(item.name, { forbidden: card.forbidden, ownCodes: card.ownCodes, codePrefix, knownCodes, markings }),
      40,
    );
    if (!clean) continue;
    const key = itemNameNorm(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(clean);
  }
  return { goods: names.slice(0, 6), goodsMore: Math.max(0, names.length - 6) };
}

export interface BuiltPost {
  view: ChannelPostView;
  /** No correction has started or ended, and the price's validity has not passed. */
  standing: boolean;
  /** The parent request a correction replaces (for the reply target). */
  parentRequestId: string | null;
}

/**
 * The post's projection, from the price's OWN record (D5): the amount is
 * ALWAYS `calc_versions.total_usd` / `calc_requests.answer_amount` — never the
 * card's quoted amount, which after a released offer holds the CLIENT price
 * (printing it would publish the seller's upsale). Never the seller's note to
 * the VED, never the VED's notes.
 */
export async function buildChannelPostView(row: {
  kind: PostKind;
  requestId: string;
  versionId: string | null;
}): Promise<BuiltPost | null> {
  const seller = alias(users, 'seller');
  const [req] = await db
    .select({
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      section: calcRequests.section,
      weightKg: calcRequests.weightKg,
      volumeM3: calcRequests.volumeM3,
      supersedes: calcRequests.supersedesRequestId,
      completedAt: calcRequests.completedAt,
      sellerName: seller.fullName,
      childState: sql<ChildState | null>`${childStateSql(sql`${calcRequests}.id`)}`,
    })
    .from(calcRequests)
    .innerJoin(seller, eq(seller.id, calcRequests.requestedBy))
    .where(eq(calcRequests.id, row.requestId))
    .limit(1);
  if (!req) return null;

  let view: ChannelPostView;
  if (row.kind === 'seal') {
    if (!row.versionId) return null;
    const rows = await db.execute<{
      total_usd: string;
      per_kg_usd: string | null;
      per_m3_usd: string | null;
      weight_kg: string | null;
      volume_m3: string | null;
      valid_until_ms: string;
      sealed_at_ms: string;
      section: string;
      freight_per_kg: boolean | null;
      ved_name: string | null;
    }>(sql`
      SELECT v.total_usd::text AS total_usd, v.per_kg_usd::text AS per_kg_usd, v.per_m3_usd::text AS per_m3_usd,
             v.weight_kg::text AS weight_kg, v.volume_m3::text AS volume_m3,
             (extract(epoch FROM v.valid_until) * 1000)::bigint::text AS valid_until_ms,
             (extract(epoch FROM v.sealed_at) * 1000)::bigint::text AS sealed_at_ms,
             v.section, v.freight_per_kg, ved.full_name AS ved_name
        FROM calc_versions v
        LEFT JOIN users ved ON ved.id = ${sealCreditSql('v').person}
       WHERE v.id = ${row.versionId}::uuid`);
    const v = rows[0];
    if (!v) return null;
    const section = asSection(v.section);
    view = {
      kind: 'seal',
      section,
      quoteNo: await quoteNoFor(row.versionId),
      day: tashkentDay(new Date(Number(v.sealed_at_ms))),
      validUntilDay: tashkentDay(new Date(Number(v.valid_until_ms))),
      goods: [],
      goodsMore: 0,
      weightKg: num(v.weight_kg),
      volumeM3: num(v.volume_m3),
      amount: Number(v.total_usd),
      currency: 'USD',
      perUnit: pickPerUnit({
        section,
        bandPerKg: v.freight_per_kg,
        perKg: num(v.per_kg_usd),
        perM3: num(v.per_m3_usd),
        currency: 'USD',
      }),
      sellerName: req.sellerName,
      vedName: v.ved_name,
      replacesQuoteNo: null,
      isCorrection: req.supersedes !== null,
    };
  } else {
    const rows = await db.execute<{
      amount: string;
      currency: string | null;
      completed_ms: string;
      ved_name: string | null;
    }>(sql`
      SELECT r.answer_amount::text AS amount, r.answer_currency AS currency,
             (extract(epoch FROM r.completed_at) * 1000)::bigint::text AS completed_ms,
             ved.full_name AS ved_name
        FROM calc_requests r
        LEFT JOIN users ved ON ved.id = ${answerCreditSql('r').person}
       WHERE r.id = ${row.requestId}::uuid AND ${isAnswerSql('r')}`);
    const a = rows[0];
    if (!a) return null;
    const amount = Number(a.amount);
    const currency = asCurrency(a.currency);
    const weightKg = num(req.weightKg);
    const volumeM3 = num(req.volumeM3);
    const section = asSection(req.section);
    const days = Number(await getSetting('quote_valid_days')) || 0;
    const completed = new Date(Number(a.completed_ms));
    view = {
      kind: 'answer',
      section,
      quoteNo: null,
      day: tashkentDay(completed),
      validUntilDay: days > 0 ? tashkentDay(new Date(completed.getTime() + days * 86_400_000)) : null,
      goods: [],
      goodsMore: 0,
      weightKg,
      volumeM3,
      amount,
      currency,
      // Rounded like the seal's own columns (round4 kg, round2 m³).
      perUnit: pickPerUnit({
        section,
        bandPerKg: null,
        perKg: weightKg && weightKg > 0 ? Math.round((amount / weightKg) * 10_000) / 10_000 : null,
        perM3: volumeM3 && volumeM3 > 0 ? Math.round((amount / volumeM3) * 100) / 100 : null,
        currency,
      }),
      sellerName: req.sellerName,
      vedName: a.ved_name,
      replacesQuoteNo: null,
      isCorrection: req.supersedes !== null,
    };
  }

  const card = await forbiddenFor(req.entityType, req.entityId);
  const { goods, goodsMore } = await goodsFor(row.requestId, card);
  view.goods = goods;
  view.goodsMore = goodsMore;

  if (req.supersedes) {
    const [parentVersion] = await db
      .select({ id: calcVersions.id })
      .from(calcVersions)
      .where(eq(calcVersions.requestId, req.supersedes))
      .orderBy(desc(calcVersions.sealedAt))
      .limit(1);
    view.replacesQuoteNo = parentVersion ? await quoteNoFor(parentVersion.id) : null;
  }

  const today = tashkentDay();
  const standing = req.childState === null && (view.validUntilDay === null || view.validUntilDay >= today);
  return { view: fitGoods(view), standing, parentRequestId: req.supersedes };
}

/** The seller's goods PHOTOS (F5 a) — images on the request's materials note, oldest first, at most ten. */
export async function postPhotosFor(requestId: string): Promise<
  { storageKey: string; thumb800Key: string | null; contentType: string; sizeBytes: number }[]
> {
  return db
    .select({
      storageKey: attachments.storageKey,
      thumb800Key: attachments.thumb800Key,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .innerJoin(crmActivities, eq(crmActivities.id, attachments.entityId))
    .innerJoin(calcRequests, eq(calcRequests.noteId, crmActivities.id))
    .where(
      and(
        eq(calcRequests.id, requestId),
        eq(attachments.entityType, 'crm_activity'),
        like(attachments.contentType, 'image/%'),
      ),
    )
    .orderBy(asc(attachments.createdAt))
    .limit(10);
}
