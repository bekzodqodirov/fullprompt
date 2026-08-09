import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { leadStages, leads, tgAccounts, tgMessages } from '../../platform/db/schema';
import { phoneDigits } from '../../platform/clients/phone';
import type { AuditContext } from '../../platform/audit/service';
import { createLead } from './service';
import { leadNameForChat } from './unknown-chat';

/**
 * The lead a stranger's conversation belongs to.
 *
 * The widening the owner asked for («ha shuni qil lid ochilsin») has one
 * rule that matters more than the minting: DO NOT MINT TWICE. The same
 * person messages, then rings, then messages again from a second Telegram
 * account on the same number — a funnel with three cards for one человек is
 * worse than the silence it replaced. So an OPEN lead already carrying that
 * number always wins, and the calls round's matcher is the precedent: it
 * looks the number up among open leads before it writes anything.
 */

/** Does this lead's phone mean the same person as the chat's? (#111, last 9.) */
function samePhone(a: string | null, b: string): boolean {
  const left = phoneDigits(a ?? '');
  const right = phoneDigits(b);
  if (left.length < 9 || right.length < 9) return false;
  return left.slice(-9) === right.slice(-9);
}

/** Is this connected account a work number? Personal is the default (0064). */
export async function isWorkAccount(managerUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ work: tgAccounts.workAccount })
    .from(tgAccounts)
    .where(eq(tgAccounts.managerUserId, managerUserId))
    .limit(1);
  return row?.work ?? false;
}

/**
 * Find the open lead for this number, or mint one owned by the manager whose
 * account the conversation arrived on.
 *
 * Ordered oldest-first when several match, which is the rule round 67b had to
 * put on three other reads: an unordered pick among duplicates is a different
 * answer on different days, and here it would move a conversation between
 * cards.
 */
export async function leadForChat(
  managerUserId: string,
  peer: { phone: string; title: string | null },
  ctx: AuditContext,
): Promise<string> {
  const open = await db
    .select({ id: leads.id, phone: leads.phone })
    .from(leads)
    .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
    .where(and(eq(leadStages.kind, 'open'), sql`${leads.phone} IS NOT NULL`))
    .orderBy(asc(leads.createdAt), asc(leads.id));

  const existing = open.find((row) => samePhone(row.phone, peer.phone));
  if (existing) return existing.id;

  const lead = await createLead(
    {
      name: leadNameForChat(peer.title, peer.phone),
      phone: peer.phone,
      // The manager whose Telegram it is owns the lead: they are the one who
      // already has the conversation open on their phone.
      ownerId: managerUserId,
    },
    { ...ctx, actorId: ctx.actorId ?? managerUserId },
  );
  return lead.id;
}

/**
 * A converted lead's kept conversation follows the person onto their new
 * code — the lead card keeps showing it (`lead_id` stays), the client card
 * gains it. The exact twin of `rekeyLeadCalls`, and deliberately so: the two
 * halves of «what do we have on this person» must not drift apart.
 */
export async function rekeyLeadChats(leadId: string, clientId: string) {
  await db
    .update(tgMessages)
    .set({ clientId })
    .where(and(eq(tgMessages.leadId, leadId), isNull(tgMessages.clientId)));
}

/**
 * The conversation rows that belong to a lead rather than to a client.
 *
 * Viewer-scoped by the caller, like every other Telegram read — this returns
 * the rows, never the permission to see them.
 */
export async function chatRowsForLead(leadId: string, limit = 100) {
  return db
    .select()
    .from(tgMessages)
    .where(eq(tgMessages.leadId, leadId))
    .orderBy(desc(tgMessages.sentAt))
    .limit(limit);
}
