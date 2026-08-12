import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { leadIntakes, leadSources, leadStages, leads, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { logger } from '../../platform/logger';
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
  'other',
] as const;
export type InboundSourceKey = (typeof INBOUND_SOURCE_KEYS)[number];

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
   */
  channel: 'form' | 'meta' | 'telegram' | 'webhook';
  /** Validated against the allowlist; anything else becomes 'other'. */
  sourceKey?: string | null;
  /** Meta's leadgen id — the idempotency key. Absent for a form post. */
  externalId?: string | null;
  /** Whatever names the campaign: {utm} or {form_id, ad_id, page_id}. */
  ref?: Record<string, unknown> | null;
  name?: string | null;
  phone?: string | null;
  note?: string | null;
  /** The form's own questions as pairs — the tarjimon's raw material (0074). */
  fields?: { key: string; value: string }[] | null;
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

const trim = (value: string | null | undefined, max: number) =>
  (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

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
): Promise<{ id: string; ownerId: string | null } | null> {
  const digits = inboundPhoneDigits(phone);
  if (!digits) return null;
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
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

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
export async function landInboundLead(arrival: InboundArrival): Promise<InboundResult> {
  const phone = inboundPhoneDigits(arrival.phone);
  const name = trim(arrival.name, 120);
  const note = trim(arrival.note, 1000);
  const sourceKey: string = (INBOUND_SOURCE_KEYS as readonly string[]).includes(
    arrival.sourceKey ?? '',
  )
    ? arrival.sourceKey!
    : 'other';

  // Capped, normalized, secret-named keys dropped — what of the form's own
  // questions is worth keeping and worth showing the mapping screen.
  const pairs = capturePairs(arrival.fields);

  const record = async (
    outcome: InboundOutcome,
    extra: { reason?: string; leadId?: string; clientId?: string; assignedUserId?: string },
  ) => {
    await db
      .insert(leadIntakes)
      .values({
        channel: arrival.channel,
        externalId: arrival.externalId ?? null,
        sourceKey,
        ref: arrival.ref ?? null,
        phone,
        name,
        outcome,
        reason: extra.reason ?? null,
        fields: pairs,
        leadId: extra.leadId ?? null,
        clientId: extra.clientId ?? null,
        assignedUserId: extra.assignedUserId ?? null,
      })
      // The SECOND delivery of the same advert lead is refused by the database
      // rather than by a check somebody can forget: Meta re-sends until it
      // gets a 200, and a form page reloads.
      .onConflictDoNothing();
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
          eq(leadIntakes.externalId, arrival.externalId),
        ),
      )
      .limit(1);
    if (seen) return { outcome: 'dropped', reason: 'replay' };
  }

  // The ceilings, asked BEFORE anything is created and counted over the
  // arrivals ledger rather than over `leads` — a flood that was correctly
  // dropped still has to count towards the next one, or the cap is escapable
  // by making every attempt look like a duplicate.
  const capped =
    (phone && (await inboundCount({ phone, sinceMs: DAY_MS })) >= PHONE_CAP_PER_DAY) ||
    (await inboundCount({ sourceKey, sinceMs: DAY_MS })) >= SOURCE_CAP_PER_DAY;
  if (capped) {
    await record('dropped', { reason: 'capped' });
    return { outcome: 'dropped', reason: 'capped' };
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
      await record('client', { clientId: client.id });
      return { outcome: 'client', clientId: client.id };
    }
  }

  // (1) The same person, still open. Joined rather than duplicated — and the
  // OWNER is left alone: whoever is already working this enquiry keeps it.
  if (phone) {
    const open = await inboundMatch(phone);
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
      await record('joined', { leadId: open.id, assignedUserId: open.ownerId ?? undefined });
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
  const { ownerId } = await routeInboundOwner({ sourceKey, text: [name, note], volumeM3 });
  const lead = await createLead(
    {
      // `leadSchema` wants two characters and an advert may send none.
      name: name ?? `${sourceKey} · ${phone ?? '—'}`,
      phone: arrival.phone ?? '',
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
      nextActionAt: new Date().toISOString().slice(0, 10),
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
  await record('created', { leadId: lead.id, assignedUserId: ownerId ?? undefined });
  return { outcome: 'created', leadId: lead.id };
}

/** What the note says on the card. The source is the useful half. */
function inboundNote(sourceKey: string, text: string): string {
  return [`📣 ${sourceKey}`, text].filter(Boolean).join('\n');
}

/** How many arrivals a source produced in a window — for the caps and reports. */
export async function inboundCount(where: {
  phone?: string | null;
  sourceKey?: string | null;
  sinceMs: number;
}): Promise<number> {
  const since = new Date(Date.now() - where.sinceMs);
  const conditions = [gt(leadIntakes.createdAt, since)];
  if (where.phone) conditions.push(eq(leadIntakes.phone, where.phone));
  if (where.sourceKey) conditions.push(eq(leadIntakes.sourceKey, where.sourceKey));
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
