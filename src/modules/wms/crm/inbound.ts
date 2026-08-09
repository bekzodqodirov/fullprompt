import { and, count, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  leadIntakes,
  leadSources,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '../../platform/db/schema';
import { addActivity, createLead } from './service';
import { activeClientsByPhone } from '../client-cabinet/service';

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
  channel: 'form' | 'meta' | 'telegram';
  /** Validated against the allowlist; anything else becomes 'other'. */
  sourceKey?: string | null;
  /** Meta's leadgen id — the idempotency key. Absent for a form post. */
  externalId?: string | null;
  /** Whatever names the campaign: {utm} or {form_id, ad_id, page_id}. */
  ref?: Record<string, unknown> | null;
  name?: string | null;
  phone?: string | null;
  note?: string | null;
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
 * Whose turn it is — «navbat bilan hammaga» (the owner).
 *
 * Fewest inbound leads in the window, and the longest since their last one
 * breaks a tie. No stored pointer: a counter would have to be kept correct
 * when somebody joins, leaves or is off sick, and the leads themselves already
 * know. Somebody who has never had one sorts first, which is what makes a new
 * seller's first day work.
 *
 * The rota is an explicit opt-in COLUMN on the role (`inbound_rota`, following
 * round 23's `warehouse_scoped`), NOT `salesManagerOptions()` — that one
 * answers «who may be shown in a dropdown» and deliberately re-adds people who
 * have been deactivated, which is the last thing an advert lead should find.
 */
export async function nextInboundOwner(): Promise<string | null> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({
      id: users.id,
      n: sql<number>`count(${leads.id})`,
      last: sql<Date | null>`max(${leads.inboundAt})`,
    })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .leftJoin(
      leads,
      and(eq(leads.ownerId, users.id), isNotNull(leads.inboundAt), gt(leads.inboundAt, since)),
    )
    .where(and(eq(users.active, true), eq(roles.inboundRota, true)))
    .groupBy(users.id)
    // NULLS FIRST is the whole point: a seller with no inbound lead yet is at
    // the front of the queue, not sorted arbitrarily among the rest.
    .orderBy(sql`count(${leads.id}) asc, max(${leads.inboundAt}) asc nulls first`)
    .limit(1);
  return rows[0]?.id ?? null;
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

  // (2) A new one, to whoever's turn it is.
  const ownerId = await nextInboundOwner();
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
