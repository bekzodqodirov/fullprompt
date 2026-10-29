import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { leadIntakes, leadSources, leadStages, leads, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { logger } from '../../platform/logger';
import { clipUnits, storableJson, storableText } from '../../platform/text/clip';
import { listFields, setFieldValues } from '../../platform/fields/service';
import { addActivity, createLead, CrmError } from './service';
import { activeClientsByPhone } from '../client-cabinet/service';
import { routeInboundOwner } from './routing';
import {
  applyFieldMap,
  capturePairs,
  listFieldMap,
  MAPPABLE_FIELD_TYPES,
  parseYesNo,
  textVolume,
} from './field-map';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { announceArrival, type LandedArrival } from './inbound-notify';
import { AGENT_SOURCE_KEY, isAgentSource } from './agent-source';
import { isSuppressedTail, noContactReasons } from './agent-feed';

export { AGENT_SOURCE_KEY, isAgentSource } from './agent-source';

/**
 * A lead that arrived by itself — from an advert, the public form, or the bot.
 *
 * ONE door for all three, because everything that is hard here is the same
 * whichever way the person came in: is this somebody we already know, whose
 * turn is it, and is this the fourth copy of a form somebody is hammering.
 *
 * The rule that shapes the whole file: **a stranger's request must never tell
 * the stranger anything.** Created, joined, dropped and rate-limited all leave
 * by the same door with the same words — a public surface that answers
 * differently for a phone already in the client book is a way to walk a number
 * list and learn who our customers are, which is exactly the fence
 * `ingestCalls` keeps for the calls app.
 */

/** The keys an advert may name. Anything else is recorded and not believed. */
export const INBOUND_SOURCE_KEYS = [
  /** Meta's own webhook: an advert whose surface the payload does not name. */
  'meta',
  'instagram',
  'facebook',
  'telegram',
  'tiktok',
  'google',
  'sayt',
  /**
   * A lead a MACHINE found (the client-finding agent), not one a person sent.
   * The only key whose arrivals are also read back (/api/agent/*), whose
   * phone is checked against the client book and the «Qayta qilinmasin»
   * leads before it may become a lead, whose owner reminder is off — and
   * which only its own webhook may claim (`inboundSourceKey`).
   * docs/AGENT-FEED.md.
   */
  'agent',
  'other',
] as const;
export type InboundSourceKey = (typeof INBOUND_SOURCE_KEYS)[number];

/**
 * The source an arrival is recorded under: one of the allowlist, else
 * `other` — and `agent` only through the WEBHOOK channel. `/ariza?manba=agent`
 * or a bot link `ad_agent` is a person, and a person must not inherit the
 * machine's belt (a client asking through the form would be dropped in
 * silence), its unreminded clock, or a row in the agent's outcomes. Every door
 * lands through `landInboundLead`, so this one line covers the form, the bot
 * and anything added later.
 */
export function inboundSourceKey(raw: string | null | undefined, channel: InboundArrival['channel']): string {
  if (!(INBOUND_SOURCE_KEYS as readonly string[]).includes(raw ?? '')) return 'other';
  if (isAgentSource(raw) && channel !== 'webhook') return 'other';
  return raw!;
}

/**
 * The source the public form (`/ariza?manba=…`) offers: a key it knows, and
 * `sayt` for anything else — `agent` included, because nobody filling in a
 * form is the machine, and before the agent's key existed `?manba=agent` was
 * an unknown word the page turned into «Sayt». It still is (review,
 * regression lens).
 */
export function formSourceKey(asked: string): string {
  return (INBOUND_SOURCE_KEYS as readonly string[]).includes(asked) && !isAgentSource(asked)
    ? asked
    : 'sayt';
}

/**
 * How long an open lead stays "the same enquiry".
 *
 * Somebody who fills the form twice in a week is one lead; the same person
 * asking again in three months is a new job, and joining it onto a stale card
 * would hide it from whoever is meant to call today.
 */
export const INBOUND_JOIN_DAYS = 30;

/**
 * The two caps. A public door with no ceiling is a way to fill the funnel with
 * junk faster than anybody can delete it, and the sales team's screen is the
 * thing that breaks.
 *
 * Per PHONE, because a person filling the form four times in a day is somebody
 * hammering a button, not four enquiries. Per SOURCE, as the blunt stop: the
 * owner's own capacity answer was ~100 leads a day, so 200 from one advert in
 * 24 hours is a fault, not a good day. A capped arrival is still RECORDED —
 * that is how «the advert produced nothing today» gets an answer — and the
 * sender is told the same words as everybody else.
 */
export const PHONE_CAP_PER_DAY = 3;
export const SOURCE_CAP_PER_DAY = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One arrival, whatever brought it. */
export interface InboundArrival {
  /**
   * `webhook` is deliberately its own channel and not `form`: one was typed by
   * a person on our own page, the other was posted by a platform — and only
   * the second can be misconfigured, which is the first thing anybody debugging
   * an advert wants to see in the arrivals ledger.
   *
   * `site` (round 113) is a website visitor who wrote to a manager's Telegram
   * carrying the tag the website was handed — its external id is that tag.
   */
  channel: 'form' | 'meta' | 'telegram' | 'webhook' | 'site';
  /** Validated against the allowlist; anything else becomes 'other'. */
  sourceKey?: string | null;
  /** Meta's leadgen id — the idempotency key. Absent for a form post. */
  externalId?: string | null;
  /** Whatever names the campaign: {utm} or {form_id, ad_id, page_id}. */
  ref?: Record<string, unknown> | null;
  name?: string | null;
  phone?: string | null;
  note?: string | null;
  /** The sender's firm (`company` / `firma` on the plain webhook) — the lead card's own column. */
  company?: string | null;
  /** The form's own questions as pairs — the tarjimon's raw material (0074). */
  fields?: { key: string; value: string }[] | null;
  /**
   * Whose this arrival already IS (round 113): the manager the website visitor
   * is talking to on Telegram. The taqsimot does not run — re-routing a
   * conversation somebody is in the middle of would hand the lead to a person
   * who cannot see the chat.
   */
  ownerId?: string | null;
  /**
   * A lead this person is already known by without a phone number — the same
   * Telegram user, attached to an open lead on somebody's account. Joined like
   * the phone match below, and checked first: a website visitor's number is
   * usually hidden, and without this every visit would be a fresh lead.
   */
  knownLeadId?: string | null;
}

export type InboundOutcome = 'created' | 'joined' | 'client' | 'dropped';

export interface InboundResult {
  outcome: InboundOutcome;
  leadId?: string;
  clientId?: string;
  /** Why nothing was created — never shown to the caller, only recorded. */
  reason?: string;
}

/** The app's phone identity: the last nine digits, everywhere. */
export function inboundPhoneDigits(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/**
 * Whitespace collapsed, then cut at `max` UTF-16 units — the budget it always
 * had — never through an emoji, with NUL and lone halves made U+FFFD. Every
 * value cut here reaches postgres somewhere — the name in `createLead`'s
 * INSERT and audit row and the seller's push, the note in the lenta and the
 * push — and a half emoji (jsonb) or a NUL (text and jsonb) was refused AFTER
 * the lead's own INSERT: an orphan lead, no ledger row, an open replay fence,
 * and on the public form a lead the daily caps never counted (reviews,
 * 2026-10-24; #1106's rule). `clipUnits` keeps every spelling the old
 * `slice` stored.
 */
const trim = (value: string | null | undefined, max: number) =>
  clipUnits((value ?? '').replace(/\s+/g, ' ').trim(), max) || null;

/**
 * `lead_sources.key` → id. NEVER mints a row.
 *
 * A URL parameter that could create dictionary entries is a way for anybody to
 * fill the owner's funnel settings with junk — configuration left behind is
 * worse than data (#183). An unknown key resolves to the `other` row, and if
 * even that is absent the lead simply has no source.
 */
export async function sourceIdForKey(key: string | null): Promise<string | null> {
  const wanted: string = (INBOUND_SOURCE_KEYS as readonly string[]).includes(key ?? '')
    ? key!
    : 'other';
  const [row] = await db
    .select({ id: leadSources.id })
    .from(leadSources)
    .where(eq(leadSources.key, wanted))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The ONE open lead this phone already has, if there is exactly one.
 *
 * Deliberately NOT `similarLeads` (round 79): that one also matches on an
 * exact NAME when no phone was typed, which is right when a seller is reading
 * the names and deciding, and catastrophic for a machine — a stranger posting
 * `{name: 'Aziz'}` would write into a real customer's card.
 *
 * Ambiguity refuses: two open leads on one number is a mess a person has to
 * look at, and picking one of them silently is how the wrong seller gets the
 * call. Open stages only — a lost lead coming back IS a new enquiry.
 */
export async function inboundMatch(
  phone: string,
  /**
   * The bot's stranger join keeps its own clause: only a lead not yet won
   * onto a code (`client_id` NULL) — a coded person's request is the
   * per-request rule's (docs/UCH-BAND.md §2; judge product-11: the stranger
   * join asks THIS rule rather than restating it).
   */
  opts: { unboundOnly?: boolean } = {},
): Promise<{ id: string; ownerId: string | null } | null> {
  const digits = inboundPhoneDigits(phone);
  if (!digits) return null;
  // A lead ABOUT a colleague's client (0136) carries that client's phone;
  // a stranger's message or an advert from the same person is not that
  // lead's enquiry, and joining it would hand it to the wrong seller (judge
  // deploy-4). Asked first, on the pool; one migration behind it is absent.
  const { leadAboutReady } = await import('./lead-about');
  const aboutOn = await leadAboutReady();
  const open = await db
    .select({ id: leadStages.id })
    .from(leadStages)
    .where(eq(leadStages.kind, 'open'));
  if (open.length === 0) return null;

  const since = new Date(Date.now() - INBOUND_JOIN_DAYS * 86_400_000);
  const rows = await db
    .select({ id: leads.id, ownerId: leads.ownerId })
    .from(leads)
    .where(
      and(
        sql`right(regexp_replace(coalesce(${leads.phone}, ''), '[^0-9]', '', 'g'), 9) = ${digits}`,
        inArray(
          leads.stageId,
          open.map((row) => row.id),
        ),
        gt(leads.updatedAt, since),
        opts.unboundOnly ? sql`${leads}.client_id IS NULL` : undefined,
        aboutOn ? sql`NOT EXISTS (SELECT 1 FROM lead_about_client la WHERE la.lead_id = ${leads}.id)` : undefined,
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** A lead by id, if it still stands on an OPEN stage — `inboundMatch`'s shape. */
async function openLeadById(id: string): Promise<{ id: string; ownerId: string | null } | null> {
  const [row] = await db
    .select({ id: leads.id, ownerId: leads.ownerId })
    .from(leads)
    .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
    .where(and(eq(leads.id, id), eq(leadStages.kind, 'open')))
    .limit(1);
  return row ?? null;
}

/**
 * An external id longer than this many UTF-8 bytes MAY be refused by the
 * ledger's unique index (`lead_intakes_external_idx`, 0066): a btree row
 * holds at most 2,704 bytes, and postgres compresses the id first, so a
 * repetitive id of 50 KB fits while 2,685 random bytes do not (measured,
 * 2026-10-24: 2,684 taken on every channel but `telegram`, 2,680 there). At
 * or under it an id is always taken, so its own spelling is the only one it
 * can be stored under. Google's lead ids, Meta's leadgen ids, the bot's
 * `tg:<chat>:<message>`, the website's tags and the agent's
 * `cs:<uuid>:<yyyymm>` are all under a hundred.
 */
export const INDEX_SAFE_ID_BYTES = 2048;

/**
 * The spelling an id is stored under when the index refused its own:
 * `sha256:` and the hex digest of its UTF-8 bytes. Deterministic, so a
 * retry meets the replay fence and two different ids stay two; null for an
 * id the index always takes. The id as `storableText` already made it.
 */
export function oversizeIdSpelling(id: string): string | null {
  if (Buffer.byteLength(id, 'utf8') <= INDEX_SAFE_ID_BYTES) return null;
  return `sha256:${createHash('sha256').update(id, 'utf8').digest('hex')}`;
}

/** Every spelling an arrival with this id may stand in the ledger under — what the replay fences ask. */
export function externalIdSpellings(id: string): string[] {
  const hashed = oversizeIdSpelling(id);
  return hashed ? [id, hashed] : [id];
}

/** Postgres's «program limit exceeded» — here, an index row bigger than a btree holds. */
function isProgramLimit(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '54000';
}

/**
 * Has this exact arrival landed before? (Q5 a.) The bot's advert contact is
 * keyed by its Telegram message (`tg:<chat>:<message>`), and a redelivered
 * contact must be thanked again without landing a second enquiry. Served by
 * the partial unique index on (channel, external_id).
 */
export async function inboundLanded(channel: InboundArrival['channel'], externalId: string): Promise<boolean> {
  const spellings = externalIdSpellings(storableText(externalId));
  const rows = await db.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM lead_intakes
     WHERE channel = ${channel}
       AND external_id IN (${sql.join(
         spellings.map((spelling) => sql`${spelling}`),
         sql`, `,
       )}) LIMIT 1`);
  return rows.length > 0;
}

/** The deliveries of one `(channel, external id)` in flight, newest last — `landInboundLead`'s chain. */
const landing = new Map<string, Promise<unknown>>();

/**
 * Land an arrival.
 *
 * The order is the design: a known CLIENT first (their enquiry belongs on the
 * card that holds their cargo and their money, not on a fresh lead), then an
 * open lead on the same number, then a new lead. Every branch writes a
 * `lead_intakes` row, including the ones that create nothing — a lead row
 * cannot record a lead that was deliberately not created, and «why did the
 * advert produce nothing today» has to be answerable.
 */
export async function landInboundLead(sent: InboundArrival): Promise<InboundResult> {
  // The id as postgres will store it (a text column turns a lone half into
  // U+FFFD on the wire and refuses NUL), so the chain below and the replay
  // fence agree with the ledger about which deliveries are one: a NUL in it
  // used to make the fence's own SELECT throw on every retry, for ever. An id
  // too long for the ledger's index is stored under its hash instead
  // (`record`), and the fence asks both spellings (`externalIdSpellings`).
  const arrival = sent.externalId ? { ...sent, externalId: storableText(sent.externalId) } : sent;
  if (!arrival.externalId) return landOnce(arrival);
  // One delivery of an id at a time. The replay fence below is a SELECT at the
  // start and the ledger's ON CONFLICT at the end, so two deliveries of one id
  // IN FLIGHT both passed the SELECT and both created a lead — the database
  // kept one ledger row and the other lead stood unannounced, unclocked and in
  // nobody's outcomes (review, 2026-10-24: measured with the first delivery
  // held on a lock). A sender re-sends exactly when the first try is slow: the
  // agent after its read timeout, a platform that did not get its 200 in
  // time. Chained here, the second waits and then meets the fence as a
  // replay. «Here» is this module instance: a production bundle may hold more
  // than one copy of this file, but every channel that carries an id lands
  // through ONE caller — `webhook` the route, `meta` the Meta worker (pg-boss,
  // in the app process), `telegram` the cabinet bot — so each channel's
  // deliveries meet in one map (third review). The form carries no id; the site door in
  // tg-listen keeps its own `serialised`, and the unique index still stands
  // behind all of it across processes.
  const key = `${arrival.channel}\u0000${arrival.externalId}`;
  const before = landing.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(() => landOnce(arrival));
  landing.set(key, mine);
  try {
    return await mine;
  } finally {
    // Only the last in the chain clears it, so a third delivery still queues.
    if (landing.get(key) === mine) landing.delete(key);
  }
}

/** `landInboundLead`'s body: one delivery, after any earlier one of the same id has settled. */
async function landOnce(arrival: InboundArrival): Promise<InboundResult> {
  const phone = inboundPhoneDigits(arrival.phone);
  const name = trim(arrival.name, 120);
  const note = trim(arrival.note, 1000);
  const sourceKey = inboundSourceKey(arrival.sourceKey, arrival.channel);

  // Capped, normalized, secret-named keys dropped — what of the form's own
  // questions is worth keeping and worth showing the mapping screen.
  const pairs = capturePairs(arrival.fields);
  const refText = storedRef(arrival.ref);

  /** One INSERT of the ledger row under one spelling of the id — `record` below decides which. */
  const insertIntake = async (
    outcome: InboundOutcome,
    extra: { reason?: string; leadId?: string; clientId?: string; assignedUserId?: string },
    externalId: string | null,
  ): Promise<string | null> => {
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO lead_intakes
        (channel, external_id, source_key, ref, phone, name, outcome, reason,
         fields, lead_id, client_id, assigned_user_id)
      VALUES (${arrival.channel}, ${externalId}, ${sourceKey},
              ${refText}::jsonb,
              ${phone}, ${name}, ${outcome}, ${extra.reason ?? null},
              ${pairs ? JSON.stringify(pairs) : null}::jsonb,
              ${extra.leadId ?? null}::uuid, ${extra.clientId ?? null}::uuid,
              ${extra.assignedUserId ?? null}::uuid)
      -- The SECOND delivery of the same advert lead is refused by the
      -- database rather than by a check somebody can forget: Meta re-sends
      -- until it gets a 200, and a form page reloads.
      ON CONFLICT DO NOTHING
      RETURNING id`);
    return rows[0]?.id ?? null;
  };

  /**
   * The ledger row. Answers its id, or null when the database refused it as
   * a second copy — and only a row that came back may be announced, so the
   * replay race cannot push one lead twice.
   *
   * RAW SQL on today's columns only (0113, design judge 2): drizzle's insert
   * names EVERY column its schema knows, so once the contact-clock columns
   * are in the schema a drizzle insert refuses the whole arrival on a
   * database one migration behind — deploy morning (#472) — and this row is
   * the replay fence: without it Meta's retry passes the check below and a
   * SECOND lead is created. The clock is a separate UPDATE that may fail.
   *
   * An id the unique index refuses for its size (54000, `INDEX_SAFE_ID_BYTES`)
   * is written again under its hash — the fences ask both spellings. Every id
   * the index takes keeps the spelling it always had; the refused one used to
   * throw here, after the lead and its lenta note (fourth review, 2026-10-24).
   */
  const record = async (
    outcome: InboundOutcome,
    extra: { reason?: string; leadId?: string; clientId?: string; assignedUserId?: string },
  ): Promise<string | null> => {
    const own = arrival.externalId ?? null;
    try {
      return await insertIntake(outcome, extra, own);
    } catch (err) {
      const hashed = own ? oversizeIdSpelling(own) : null;
      if (!hashed || !isProgramLimit(err)) throw err;
      logger.warn(
        { channel: arrival.channel, bytes: Buffer.byteLength(own!, 'utf8') },
        '[inbound] external id too long for the ledger index; stored as its sha256',
      );
      return insertIntake(outcome, extra, hashed);
    }
  };

  /**
   * Tell a person (0113). After the ledger row, in a catch of its own: what
   * a public door ANSWERS must never depend on Telegram, and a throw here
   * would otherwise be logged as the landing failing — which it did not.
   */
  const announce = async (
    landed: Pick<LandedArrival, 'intakeId' | 'outcome' | 'leadId' | 'clientId' | 'ownerId'> & {
      volumeM3?: number | null;
    },
  ) => {
    try {
      await announceArrival({
        ...landed,
        channel: arrival.channel,
        sourceKey,
        name,
        phone: trim(arrival.phone, 40),
        note,
        volumeM3: landed.volumeM3 ?? null,
      });
    } catch (err) {
      logger.error({ err, intakeId: landed.intakeId }, '[inbound] notify failed');
    }
  };

  // Nothing to work with. Recorded anyway — a run of these is what a broken
  // advert form looks like from here.
  if (!phone && !name) {
    await record('dropped', { reason: 'no_contact' });
    return { outcome: 'dropped', reason: 'no_contact' };
  }

  if (arrival.externalId) {
    const [seen] = await db
      .select({ id: leadIntakes.id })
      .from(leadIntakes)
      .where(
        and(
          eq(leadIntakes.channel, arrival.channel),
          inArray(leadIntakes.externalId, externalIdSpellings(arrival.externalId)),
        ),
      )
      .limit(1);
    if (seen) return { outcome: 'dropped', reason: 'replay' };
  }

  // A machine-found lead the belt below cannot CHECK must not reach a seller:
  // with no phone of nine digits it is neither ruled out as a client nor as a
  // «Qayta qilinmasin» number (review, feed lens). The agent refuses such a
  // candidate itself; this is the ERP's last line. After the replay fence, so
  // a re-send writes no second row.
  if (isAgentSource(sourceKey) && !phone) {
    await record('dropped', { reason: 'no_phone' });
    return { outcome: 'dropped', reason: 'no_phone' };
  }

  // The ceilings, asked BEFORE anything is created and counted over the
  // arrivals ledger rather than over `leads` — a flood that was correctly
  // dropped still has to count towards the next one, or the cap is escapable
  // by making every attempt look like a duplicate. The per-phone count is per
  // FAMILY: the agent's arrivals count only against the agent, everybody
  // else's only against everybody else — three agent pushes on one number
  // (three firms sharing a phone) must not stop that person's own enquiry
  // through the form for a day (review, sec lens). Every door that is not the
  // agent counts exactly what it counted before the agent existed.
  const capped =
    (phone &&
      (await inboundCount({ phone, sinceMs: DAY_MS, agent: isAgentSource(sourceKey) })) >=
        PHONE_CAP_PER_DAY) ||
    (await inboundCount({ sourceKey, sinceMs: DAY_MS })) >= SOURCE_CAP_PER_DAY;
  if (capped) {
    await record('dropped', { reason: 'capped' });
    return { outcome: 'dropped', reason: 'capped' };
  }

  // The agent's belt (docs/AGENT-FEED.md). The agent holds the suppression
  // feed, so reaching this line means its copy was stale: the arrival is
  // recorded as `suppressed` — the outcomes feed tells it to pull again — and
  // NOBODY is told. A client's manager must not hear «a machine found your
  // client on OLX», and a «Qayta qilinmasin» number must not reach a seller
  // again by any road. Wider than step (0) below on purpose: an INACTIVE
  // client is still ours. Adverts and the public form keep today's behaviour:
  // a client's question still lands on the client's card.
  if (isAgentSource(sourceKey) && phone && (await isSuppressedTail(phone, await noContactReasons()))) {
    await record('dropped', { reason: 'suppressed' });
    return { outcome: 'dropped', reason: 'suppressed' };
  }

  const sourceId = await sourceIdForKey(sourceKey);
  const text = note ?? '';

  // (0) Already a customer. Their question belongs on the card that carries
  // their cargo and their balance; a second lead for a coded client is a
  // parallel history nobody reads.
  if (phone) {
    const known = await activeClientsByPhone(phone);
    if (known.length === 1) {
      const client = known[0]!;
      await addActivity(
        {
          entityType: 'client',
          entityId: client.id,
          kind: 'note',
          note: inboundNote(sourceKey, text),
        },
        { actorId: null },
        { system: true },
      );
      const intakeId = await record('client', { clientId: client.id });
      if (intakeId) {
        await announce({
          intakeId,
          outcome: 'client',
          clientId: client.id,
          ownerId: client.salesManagerId ?? null,
        });
      }
      return { outcome: 'client', clientId: client.id };
    }
  }

  // (1) The same person, still open. Joined rather than duplicated — and the
  // OWNER is left alone: whoever is already working this enquiry keeps it.
  // A person known by their Telegram rather than their number first, then
  // by the number.
  const knownOpen = arrival.knownLeadId ? await openLeadById(arrival.knownLeadId) : null;
  if (knownOpen || phone) {
    const open = knownOpen ?? (await inboundMatch(phone!));
    if (open) {
      await addActivity(
        {
          entityType: 'lead',
          entityId: open.id,
          kind: 'note',
          note: inboundNote(sourceKey, text),
        },
        { actorId: null },
        { system: true },
      );
      // `addActivity` does not touch the lead, and both boards order and cap by
      // `updated_at` — so without this the second enquiry would be invisible
      // exactly where somebody is looking for it.
      await db.update(leads).set({ updatedAt: new Date() }).where(eq(leads.id, open.id));
      const intakeId = await record('joined', {
        leadId: open.id,
        assignedUserId: open.ownerId ?? undefined,
      });
      if (intakeId) {
        await announce({ intakeId, outcome: 'joined', leadId: open.id, ownerId: open.ownerId });
      }
      return { outcome: 'joined', leadId: open.id };
    }
  }

  // The tarjimon (round 97). Loaded only when the arrival actually carried
  // questions; the two lookups are one indexed read each. The mapped kub wins
  // for routing, and a volume typed into free text («25 kub yuk bor» on
  // /ariza) is the fallback — good enough to pick whose phone rings, and
  // deliberately NOT good enough to print on the card as a fact.
  const mappableFields = pairs
    ? (await listFields('lead')).filter((f) => MAPPABLE_FIELD_TYPES.has(f.type))
    : [];
  const mapped = applyFieldMap(
    pairs,
    pairs ? await listFieldMap() : [],
    new Set(mappableFields.map((f) => f.id)),
  );
  const volumeM3 = mapped.volumeM3 ?? textVolume(name, note);

  // (2) A new one, to whoever's turn it is. The taqsimot rules run FIRST
  // (round 96) and only for this branch on purpose: a client's question and a
  // joined enquiry already have their people, and re-routing them would take
  // work off whoever is mid-conversation.
  const { ownerId } = arrival.ownerId
    ? { ownerId: arrival.ownerId }
    : await routeInboundOwner({ sourceKey, text: [name, note], volumeM3 });
  const lead = await createLead(
    {
      // `leadSchema` wants two characters and an advert may send none.
      name: name ?? `${sourceKey} · ${phone ?? '—'}`,
      // As sent — the card keeps the spelling — but storable: it is the
      // INSERT's own column (text, refuses NUL) and rides into the create's
      // audit row (jsonb, refuses a lone half too).
      phone: storableText(arrival.phone ?? ''),
      // The agent's firm onto the card's own column, at `leadSchema`'s
      // ceiling. The agent's only: every other door keeps a posted `company`
      // as the note line and question pair it always was (review, regression
      // lens), and the agent's copy is in its note too, so a JOINED push
      // still shows it.
      company: isAgentSource(sourceKey) ? (trim(arrival.company, 200) ?? undefined) : undefined,
      sourceId: sourceId ?? '',
      ownerId: ownerId ?? '',
      // `note` deliberately left empty. What the person WROTE goes on the
      // lenta below, the same place the second and the tenth message go — a
      // record split between two fields depending on which message it was is
      // the kind of thing nobody notices until they are looking for something
      // that is in the other one. The note field stays the seller's own
      // summary to write after the call.
      // Booked for TODAY, which is the whole point of paying for the advert:
      // a lead nobody rings on the day it arrives is money already spent. It
      // is the only field here a person did not send, and it is what puts the
      // card on the owner's `/bugun` — or on everybody's, when the rotation is
      // empty and the lead has no owner.
      nextActionAt: tashkentDay(),
    },
    { actorId: null },
    { system: true },
  );
  await db.update(leads).set({ inboundAt: new Date() }).where(eq(leads.id, lead.id));

  // The structured copies of mapped answers. In a catch of their own, because
  // every value here came off a public form: a target field's pattern rule, a
  // coercion refusal — none of it may abort the landing, or the arrival dies
  // BEFORE its ledger row and the replay fence opens (the design review's
  // blocker). A failure degrades to note-only, which the lenta already holds.
  try {
    const quoted: { quotedVolumeM3?: string; quotedWeightKg?: string } = {};
    // toFixed = quoteValues' own canonical spelling (#503), and the parser has
    // already refused anything numeric(12,3) could not hold.
    if (mapped.volumeM3 !== null) quoted.quotedVolumeM3 = mapped.volumeM3.toFixed(3);
    if (mapped.weightKg !== null) quoted.quotedWeightKg = mapped.weightKg.toFixed(3);
    if (Object.keys(quoted).length) {
      await db.update(leads).set(quoted).where(eq(leads.id, lead.id));
    }
    if (mapped.custom.length) {
      const typeById = new Map(mappableFields.map((f) => [f.id, f.type]));
      const raw: Record<string, unknown> = {};
      for (const entry of mapped.custom) {
        if (typeById.get(entry.fieldId) === 'checkbox') {
          // «Ha» in any of the form's languages; an unreadable answer is
          // SKIPPED (absent key), never written as «no».
          const yes = parseYesNo(entry.value);
          if (yes !== null) raw[entry.fieldId] = yes;
        } else {
          raw[entry.fieldId] = entry.value;
        }
      }
      if (Object.keys(raw).length) {
        await setFieldValues(
          'lead',
          lead.id,
          raw,
          { actorId: null, ip: null, userAgent: null },
          { system: true },
        );
      }
    }
  } catch (err) {
    logger.error({ err, leadId: lead.id }, '[inbound] mapped answers not written; note keeps them');
  }

  await addActivity(
    { entityType: 'lead', entityId: lead.id, kind: 'note', note: inboundNote(sourceKey, text) },
    { actorId: null },
    { system: true },
  );
  const intakeId = await record('created', { leadId: lead.id, assignedUserId: ownerId ?? undefined });
  if (intakeId) {
    await announce({
      intakeId,
      outcome: 'created',
      leadId: lead.id,
      ownerId: ownerId ?? null,
      // The MAPPED kub only — the free-text guess routes, it is never printed.
      volumeM3: mapped.volumeM3,
    });
  }
  return { outcome: 'created', leadId: lead.id };
}

/**
 * The body as `lead_intakes.ref` stores it, decided BEFORE anything is
 * written. `storableJson` makes every string storable; what it cannot write —
 * a body nested thousands of levels deep overflows the serialiser's stack — is
 * kept as a marker, because the ref is a trail and the arrival is the record:
 * that throw came in `record()`, after the lead and its lenta note (third
 * review, 2026-10-24).
 */
function storedRef(ref: InboundArrival['ref']): string | null {
  if (!ref) return null;
  try {
    return storableJson(ref);
  } catch (err) {
    logger.warn({ err }, '[inbound] ref not storable; kept as a marker');
    return JSON.stringify({ _truncated: true });
  }
}

/** What the note says on the card. The source is the useful half. */
function inboundNote(sourceKey: string, text: string): string {
  return [`📣 ${sourceKey}`, text].filter(Boolean).join('\n');
}

/**
 * How many arrivals a source produced in a window — for the caps and reports.
 * `agent` splits the ledger in two families: true counts only the agent's
 * rows, false only everybody else's; absent counts all.
 */
export async function inboundCount(where: {
  phone?: string | null;
  sourceKey?: string | null;
  agent?: boolean;
  sinceMs: number;
}): Promise<number> {
  const since = new Date(Date.now() - where.sinceMs);
  const conditions = [gt(leadIntakes.createdAt, since)];
  if (where.phone) conditions.push(eq(leadIntakes.phone, where.phone));
  if (where.sourceKey) conditions.push(eq(leadIntakes.sourceKey, where.sourceKey));
  if (where.agent === true) conditions.push(eq(leadIntakes.sourceKey, AGENT_SOURCE_KEY));
  if (where.agent === false) conditions.push(ne(leadIntakes.sourceKey, AGENT_SOURCE_KEY));
  const [row] = await db
    .select({ n: count() })
    .from(leadIntakes)
    .where(and(...conditions));
  return Number(row?.n ?? 0);
}

/** The newest arrivals, for whoever watches the adverts. */
export async function recentIntakes(limit = 50) {
  return db
    .select({
      id: leadIntakes.id,
      channel: leadIntakes.channel,
      sourceKey: leadIntakes.sourceKey,
      name: leadIntakes.name,
      phone: leadIntakes.phone,
      outcome: leadIntakes.outcome,
      reason: leadIntakes.reason,
      leadId: leadIntakes.leadId,
      clientId: leadIntakes.clientId,
      ownerName: users.fullName,
      createdAt: leadIntakes.createdAt,
    })
    .from(leadIntakes)
    .leftJoin(users, eq(users.id, leadIntakes.assignedUserId))
    .orderBy(desc(leadIntakes.createdAt))
    .limit(limit);
}

/**
 * The webhook secret for one source, or null when that door does not exist.
 *
 * Read on every POST, deliberately not cached: turning a door off has to take
 * effect on the next request, not after a deploy. It is one indexed row.
 */
export async function sourceWebhookSecret(key: string): Promise<string | null> {
  const [row] = await db
    .select({ secret: leadSources.webhookSecret, active: leadSources.active })
    .from(leadSources)
    .where(eq(leadSources.key, key))
    .limit(1);
  // A retired source's door closes with it — the alternative is a key that
  // goes on accepting leads into a channel nobody looks at any more.
  return row && row.active ? (row.secret ?? null) : null;
}

/**
 * Mint (or clear) a source's webhook secret.
 *
 * The value is GENERATED, never taken from the caller: a key somebody types is
 * a key somebody reuses, and this one is pasted into a third party's settings
 * page where it will outlive everyone's memory of it. `create-admin`'s
 * alphabet, for the same reason — it gets read off a screen.
 */
export async function setSourceWebhookSecret(
  key: string,
  enabled: boolean,
  ctx: AuditContext,
): Promise<string | null> {
  const [source] = await db
    .select({ id: leadSources.id, name: leadSources.name })
    .from(leadSources)
    .where(eq(leadSources.key, key))
    .limit(1);
  if (!source) throw new CrmError('source_not_found');

  const secret = enabled ? mintWebhookSecret() : null;
  await db
    .update(leadSources)
    .set({ webhookSecret: secret })
    .where(eq(leadSources.id, source.id));
  // The secret itself is never audited — an audit row is readable by more
  // people than the settings screen is, and writing it there would put the
  // key somewhere it can never be taken back from.
  await writeAudit(db, ctx, {
    entityType: 'lead_source',
    entityId: source.id,
    action: 'update',
    after: { name: source.name, webhook: enabled ? 'on' : 'off' },
  });
  return secret;
}

/** No look-alike characters: this is read off a terminal and typed on a phone. */
const SECRET_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ34679';

function mintWebhookSecret(): string {
  const bytes = randomBytes(32);
  let out = '';
  for (const byte of bytes) out += SECRET_ALPHABET[byte % SECRET_ALPHABET.length];
  return out;
}

/**
 * How many arrivals each source produced, and how many became nothing.
 *
 * ONE grouped query, never a count per source (#432): the source list grows
 * with the owner's advertising, and a per-row aggregate on a report screen is
 * a list's length turning into a page load.
 *
 * This is the number the funnel cannot give. `funnelReport` counts LEADS, so
 * the day an advert sends twenty arrivals that were all the same number it
 * reads exactly like the day nobody clicked — and those are a broken form and
 * a bad campaign, which want opposite responses.
 */
export async function intakesBySource(sinceDays = 90) {
  const since = new Date(Date.now() - sinceDays * DAY_MS);
  const rows = await db
    .select({
      sourceKey: leadIntakes.sourceKey,
      arrivals: count(),
      dropped: sql<number>`count(*) FILTER (WHERE ${leadIntakes.outcome} = 'dropped')`,
    })
    .from(leadIntakes)
    .where(gt(leadIntakes.createdAt, since))
    .groupBy(leadIntakes.sourceKey);
  return rows.map((row) => ({
    sourceKey: row.sourceKey ?? 'other',
    arrivals: Number(row.arrivals),
    dropped: Number(row.dropped),
  }));
}

/**
 * Every door an advert can be pointed at, with its address.
 *
 * The owner cannot set up a campaign without the exact URL, and telling him in
 * chat means he loses it — so the screen holds them. Only sources whose `key`
 * the code actually understands are listed: a door we would answer 404 to is
 * worse than no door, because it looks like one.
 */
export async function inboundDoors() {
  const rows = await db
    .select({
      key: leadSources.key,
      name: leadSources.name,
      secret: leadSources.webhookSecret,
      sortOrder: leadSources.sortOrder,
    })
    .from(leadSources)
    .where(eq(leadSources.active, true))
    .orderBy(leadSources.sortOrder, leadSources.name);
  return rows
    .filter((row): row is typeof row & { key: string } =>
      Boolean(row.key) && (INBOUND_SOURCE_KEYS as readonly string[]).includes(row.key!),
    )
    .map((row) => ({ key: row.key, name: row.name, secret: row.secret ?? null }));
}
