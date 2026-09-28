import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { addOfficeMinutes, officeClock } from '../../platform/time/office-hours';

/**
 * «Has anybody contacted this advert lead yet?» — asked ONCE, here (0113, the
 * owner's 5a: «15 minutdan keyin ham bog'lanilmasa menga eslatma»).
 *
 * Three readers ask the same sentence and none may restate it (#513): the
 * minute sweep's STAMP (when was the first contact), its CLAIM (is there
 * still none, so the owner is told), and the «📞 Bog'landim» button's
 * «already recorded» check. A second copy of this rule is the day the owner
 * is reminded about a lead the report says was called in two minutes.
 *
 * Contact is what the system can SEE a person do, never a machine:
 *  1. a CALL on the lead — outgoing, or incoming and answered (a missed ring
 *     is not a conversation) — with two minutes for a phone whose clock runs
 *     early; any colleague's, because the customer was reached either way;
 *  2. a Telegram message SENT to the lead's chat, by whoever's account;
 *  3. a NOTE on the lead — but only by the person the lead is for (its owner,
 *     or the seller the arrival was handed to; anybody when it is nobody's).
 *     The owner's own «@Aziz qo'ng'iroq qil» written after the reminder is a
 *     note about the lead, not a conversation with it (design judge, 5), and
 *     the landing's own note has no author at all. The ONE note that counts
 *     from anybody is the «📞 Bog'landim» button's own (`CONTACT_NOTE`): it
 *     is written only after the button's door — `crm.leads` and the ✓'s
 *     ownership rule — let the presser through, and that door admits the
 *     office answering for a lead whose seller has left (the office is who
 *     that push went to);
 *  4. a STAGE move on the lead, by that same responsible person;
 *  5. the follow-up CLEARED — «✓ Bajarildi» on /bugun, which round 102 made
 *     mean «I called» — by that same person too. Its door is not one door:
 *     the ✏️ form's stage change clears the date as well (`clearsFollowUp`),
 *     and that form is gated on `crm.leads` alone, so «anybody it let
 *     through» would count a colleague's form move that the same move on the
 *     board does not — one act, two answers (#513). «Ertaga» writes a DATE
 *     and is a postponement, so only an explicit `null` counts.
 * An owner change alone is not contact: handing a lead on is not talking to it.
 *
 * Everything is measured from `since` — the arrival's own moment — so a
 * conversation from before a person wrote AGAIN does not answer the new
 * message (a joined arrival that lands inside a live conversation is kept out
 * of the clock at landing instead, `contactedRecently`).
 */

export const CONTACT_KINDS = ['call', 'telegram', 'note', 'stage', 'followup'] as const;

/**
 * What the lenta says a «📞 Bog'landim» press was — the note it writes, and
 * the one note the rule below accepts from whoever pressed. Lives beside the
 * rule that reads it, so the button and the rule cannot drift apart.
 */
export const CONTACT_NOTE = '📞 Bog‘lanildi (Telegram tugmasi)';
export type ContactKind = (typeof CONTACT_KINDS)[number];

/**
 * How long to wait for the lead owner's calls app before believing «nobody
 * called». The phone uploads its log every fifteen minutes, so a call made at
 * minute three can reach us at minute eighteen; while the owner's paired phone
 * has not reported since the reminder fell due, the claim waits for it — at
 * most this long, because a phone that died must not silence the owner's
 * reminder for ever.
 */
export const DEVICE_GRACE_MINUTES = 30;

/** A joined re-enquiry inside a conversation this fresh gets no clock of its own. */
export const JOINED_FRESH_CONTACT_HOURS = 24;

/** How far back the reminder reaches — an arrival older than this is history. */
export const REMIND_WITHIN_HOURS = 24;

/**
 * When the 15 minutes START: the arrival itself inside the office day, the
 * next opening outside it. Independent of the reminder's minutes on purpose
 * (design judge, 12): the report measures from here, and switching the
 * reminder off must not move anybody's numbers.
 */
export function contactClockFrom(arrivedAt: Date): Date {
  return officeClock(arrivedAt);
}

/**
 * When the owner is reminded: `minutes` of OFFICE time after the clock —
 * pushed into the morning when it would fall at night. Null when the
 * reminder is switched off (0 minutes).
 */
export function contactDueAt(clock: Date, minutes: number): Date | null {
  return minutes > 0 ? addOfficeMinutes(clock, minutes) : null;
}

/**
 * The evidence rows `(at, kind, by)` for one lead since a moment — THE rule,
 * as a derived table. Every column reference is given by the caller as an
 * explicit SQL expression (`i.lead_id`, a bound id…), never interpolated
 * from a drizzle column, because a correlated subquery binds an unqualified
 * name to its own table (#128).
 */
export function contactEvidenceSql(o: {
  leadId: SQL;
  since: SQL;
  /** The lead's CURRENT owner. */
  ownerId: SQL;
  /** Whom the arrival was handed to (`lead_intakes.assigned_user_id`). */
  assignedId: SQL;
}): SQL {
  const responsible = (actor: SQL) =>
    sql`((${o.ownerId} IS NULL AND ${o.assignedId} IS NULL) OR ${actor} = ${o.ownerId} OR ${actor} = ${o.assignedId})`;
  return sql`(
    SELECT cl.started_at AS at, 'call'::text AS kind, cl.user_id AS by
      FROM call_logs cl
     WHERE cl.lead_id = ${o.leadId}
       AND (cl.direction = 'out' OR cl.duration_sec > 0)
       AND cl.started_at >= ${o.since} - interval '2 minutes'
    UNION ALL
    SELECT tm.sent_at, 'telegram'::text, tm.manager_user_id
      FROM tg_messages tm
     WHERE tm.lead_id = ${o.leadId}
       AND tm.direction = 'out'
       AND tm.sent_at >= ${o.since}
    UNION ALL
    SELECT ca.created_at, 'note'::text, ca.created_by
      FROM crm_activities ca
     WHERE ca.entity_type = 'lead'
       AND ca.entity_id = ${o.leadId}
       AND ca.created_by IS NOT NULL
       AND ca.created_at >= ${o.since}
       AND (${responsible(sql`ca.created_by`)} OR (ca.kind = 'call' AND ca.note = ${CONTACT_NOTE}))
    UNION ALL
    SELECT al.created_at, 'stage'::text, al.actor_id
      FROM audit_log al
     WHERE al.entity_type = 'lead'
       AND al.entity_id = ${o.leadId}
       AND al.action = 'update'
       AND al.actor_id IS NOT NULL
       AND al.created_at >= ${o.since}
       AND al.after ? 'stageId'
       AND ${responsible(sql`al.actor_id`)}
    UNION ALL
    SELECT al.created_at, 'followup'::text, al.actor_id
      FROM audit_log al
     WHERE al.entity_type = 'lead'
       AND al.entity_id = ${o.leadId}
       AND al.action = 'update'
       AND al.actor_id IS NOT NULL
       AND al.created_at >= ${o.since}
       AND al.after -> 'nextActionAt' = 'null'::jsonb
       AND ${responsible(sql`al.actor_id`)}
  )`;
}

/** The rule over an arrival `i` joined to its lead `l` — the sweep's shape. */
const ARRIVAL_EVIDENCE = contactEvidenceSql({
  leadId: sql`i.lead_id`,
  since: sql`i.created_at`,
  ownerId: sql`l.owner_id`,
  assignedId: sql`i.assigned_user_id`,
});

/**
 * The same rule over an EARLIER arrival `e` on the same lead — the claim's
 * «has the owner already been told about this wait» (below).
 */
const EARLIER_EVIDENCE = contactEvidenceSql({
  leadId: sql`e.lead_id`,
  since: sql`e.created_at`,
  ownerId: sql`l.owner_id`,
  assignedId: sql`e.assigned_user_id`,
});

/** The FIRST contact for arrival `i` (a LATERAL body): earliest wins. */
export function firstContactSql(): SQL {
  return sql`(SELECT ev.at, ev.kind, ev.by FROM ${ARRIVAL_EVIDENCE} ev ORDER BY ev.at, ev.kind LIMIT 1)`;
}

/**
 * Stamp every recent clocked arrival with its first contact.
 *
 * The earliest evidence WINS, not the first one seen: a call log uploads
 * late carrying its real `started_at`, so a stage move stamped at minute
 * twelve is corrected to the call at minute four when the phone reports.
 * Arrivals of the last day are re-read for exactly that; an unstamped one is
 * looked at for a week, which is as long as «nobody ever called» stays a
 * question worth a query.
 *
 * `leadId` narrows it to one lead — the button's own press, so the ledger
 * says «contacted» before the next minute's sweep.
 */
export async function stampFirstContacts(now: Date = new Date(), leadId?: string): Promise<number> {
  const at = now.toISOString();
  const rows = await db.execute<{ id: string }>(sql`
    WITH found AS (
      SELECT i.id, fc.at, fc.kind, fc.by
        FROM lead_intakes i
        JOIN leads l ON l.id = i.lead_id
        CROSS JOIN LATERAL ${firstContactSql()} fc
       WHERE i.contact_clock_at IS NOT NULL
         AND i.contact_clock_at >= ${at}::timestamptz - interval '8 days'
         AND (i.created_at >= ${at}::timestamptz - interval '1 day'
              OR (i.contacted_at IS NULL AND i.created_at >= ${at}::timestamptz - interval '7 days'))
         ${leadId ? sql`AND i.lead_id = ${leadId}` : sql``}
    )
    UPDATE lead_intakes t
       SET contacted_at = found.at, contact_kind = found.kind, contacted_by = found.by
      FROM found
     WHERE t.id = found.id
       AND (t.contacted_at IS NULL OR found.at < t.contacted_at)
    RETURNING t.id`);
  return rows.length;
}

export interface UntouchedArrival {
  id: string;
  leadId: string;
  createdAt: string;
  /** When its clock started and when it fell due — the minutes it was held to. */
  clockAt: Date;
  dueAt: Date;
  /**
   * The owner was ALREADY reminded about this lead by an earlier sweep, and
   * nobody has reached it since: the row is settled, not re-announced.
   */
  told: boolean;
}

/**
 * Take the arrivals the owner must now hear about, so that no other sweep can.
 *
 * ONE statement (round 106's claim): `contact_alerted_at` is stamped by the
 * UPDATE that selects, under `FOR UPDATE … SKIP LOCKED`, so two overlapping
 * sweeps split the rows instead of both reminding. Claimed BEFORE the message
 * is written — a crash in between loses a reminder rather than sending one
 * twice, round 83's trade, stated.
 *
 * A row is due when its reminder time has come, it is not a day old, its lead
 * still exists (a deleted lead's arrival has `lead_id` NULL and the join drops
 * it) and is still open, nobody has been stamped, and — asked again here, in the same
 * statement — the rule still finds no contact, so a call that landed between
 * the stamp and the claim cannot be reminded about. The calls app gets its
 * grace: while the owner's live, paired phone has not reported since the
 * reminder fell due, the row waits, at most DEVICE_GRACE_MINUTES.
 *
 * ONE reminder per WAIT, not per arrival: a person who writes again while
 * their first message is still untouched gets an arrival — and a clock — of
 * their own, and the two fall due minutes apart, in different sweeps. The
 * second is claimed like any other (so it is settled and never looked at
 * again) but comes back `told` when an earlier arrival on the same lead, of
 * the same reminder window, was already announced by an EARLIER sweep and is
 * still untouched by the rule: the owner has this lead in a message already.
 * «Earlier sweep» is the statement's own snapshot — rows this statement
 * stamps are invisible to its subquery, so two arrivals due in the same
 * minute are both untold and share one message line.
 */
export async function claimUntouched(now: Date = new Date()): Promise<UntouchedArrival[]> {
  const at = now.toISOString();
  const rows = await db.execute<{
    id: string;
    lead_id: string;
    created_at: string;
    contact_clock_at: string;
    contact_due_at: string;
    told: boolean;
  }>(sql`
    WITH due AS (
       SELECT i.id,
              EXISTS (
                SELECT 1 FROM lead_intakes e
                 WHERE e.lead_id = i.lead_id
                   AND e.id <> i.id
                   AND e.contact_alerted_at IS NOT NULL
                   AND e.contacted_at IS NULL
                   AND e.created_at >= ${at}::timestamptz - make_interval(hours => ${REMIND_WITHIN_HOURS})
                   AND NOT EXISTS (SELECT 1 FROM ${EARLIER_EVIDENCE} ev)
              ) AS told
         FROM lead_intakes i
         JOIN leads l ON l.id = i.lead_id
         -- A lead already DECIDED (won, or lost by whoever) needs nobody to
         -- call it: a reminder about it is noise the owner learns to skip.
         JOIN lead_stages st ON st.id = l.stage_id AND st.kind = 'open'
        WHERE i.contact_clock_at IS NOT NULL
          AND i.contact_clock_at >= ${at}::timestamptz - interval '2 days'
          AND i.contact_due_at IS NOT NULL
          AND i.contact_due_at <= ${at}::timestamptz
          AND i.created_at >= ${at}::timestamptz - make_interval(hours => ${REMIND_WITHIN_HOURS})
          AND i.contacted_at IS NULL
          AND i.contact_alerted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${ARRIVAL_EVIDENCE} ev)
          AND (
            i.contact_due_at + make_interval(mins => ${DEVICE_GRACE_MINUTES}) <= ${at}::timestamptz
            OR NOT EXISTS (
              SELECT 1 FROM call_recorder_devices d
               WHERE d.user_id = l.owner_id
                 AND d.paired_at IS NOT NULL
                 AND d.revoked_at IS NULL
                 AND d.last_seen_at >= ${at}::timestamptz - interval '24 hours'
                 AND d.last_seen_at < i.contact_due_at
            )
          )
        FOR UPDATE OF i SKIP LOCKED
    )
    UPDATE lead_intakes t SET contact_alerted_at = ${at}::timestamptz
      FROM due
     WHERE t.id = due.id
    RETURNING t.id, t.lead_id, t.created_at, t.contact_clock_at, t.contact_due_at, due.told`);
  return rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    createdAt: String(r.created_at),
    clockAt: new Date(r.contact_clock_at),
    dueAt: new Date(r.contact_due_at),
    told: r.told === true,
  }));
}

/**
 * Did the person this lead is for already talk to it recently? A re-enquiry
 * landing inside a live conversation («a seller who spoke to them twenty
 * minutes ago», design judge, 10) is news for the seller and not a new
 * deadline — its arrival gets no clock, so it can neither remind nor count.
 */
export async function contactedRecently(
  leadId: string,
  ownerId: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - JOINED_FRESH_CONTACT_HOURS * 3_600_000).toISOString();
  const evidence = contactEvidenceSql({
    leadId: sql`${leadId}::uuid`,
    since: sql`${since}::timestamptz`,
    ownerId: sql`${ownerId}::uuid`,
    assignedId: sql`${ownerId}::uuid`,
  });
  const rows = await db.execute<{ hit: number }>(sql`SELECT 1 AS hit FROM ${evidence} ev LIMIT 1`);
  return rows.length > 0;
}

/**
 * Has the newest clocked arrival on this lead been contacted, by the stamp
 * or by the rule right now? The button's «already recorded» — the same
 * evidence, never a second reading of it.
 */
export async function alreadyContacted(leadId: string): Promise<boolean> {
  const rows = await db.execute<{ contacted: boolean }>(sql`
    SELECT (i.contacted_at IS NOT NULL OR EXISTS (SELECT 1 FROM ${ARRIVAL_EVIDENCE} ev)) AS contacted
      FROM lead_intakes i
      JOIN leads l ON l.id = i.lead_id
     WHERE i.lead_id = ${leadId}
       AND i.contact_clock_at IS NOT NULL
     ORDER BY i.created_at DESC
     LIMIT 1`);
  return rows[0]?.contacted === true;
}
