import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, leadStages, leads, tgAccounts, tgChatRules, tgMessages } from '../../platform/db/schema';
import { phoneDigits } from '../../platform/clients/phone';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { createLead, defaultStageId, insertLeadTx } from './service';
import type { LiveVerdict } from './telegram-live';
import { leadNameForChat, PHONELESS_LEAD_NAME } from './unknown-chat';

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
 *
 * A hidden number (`phone: null`, his «1 a» on a work number, 2026-10-29)
 * has no number to look an open lead up by, so it goes by the CHAT
 * (`phonelessLeadForChat`) — and may answer null: the chat was answered on
 * the tray («hech qachon», or a client's) since the listener read its rules,
 * and a machine does not write over a person's answer.
 */
export async function leadForChat(
  managerUserId: string,
  peer: { phone: string; title: string | null },
  ctx: AuditContext,
): Promise<string>;
export async function leadForChat(
  managerUserId: string,
  peer: { phone: string | null; title: string | null; peerId: bigint },
  ctx: AuditContext,
): Promise<string | null>;
export async function leadForChat(
  managerUserId: string,
  peer: { phone: string | null; title: string | null; peerId?: bigint },
  ctx: AuditContext,
): Promise<string | null> {
  const phone = (peer.phone ?? '').trim();
  if (!phone) {
    if (peer.peerId === undefined) throw new Error('leadForChat: a hidden number is found by its chat — peerId is required');
    return phonelessLeadForChat({ managerUserId, peerId: peer.peerId, title: peer.title, via: 'work_account' }, ctx);
  }

  const open = await db
    .select({ id: leads.id, phone: leads.phone })
    .from(leads)
    .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
    .where(and(eq(leadStages.kind, 'open'), sql`${leads.phone} IS NOT NULL`))
    .orderBy(asc(leads.createdAt), asc(leads.id));

  const existing = open.find((row) => samePhone(row.phone, phone));
  if (existing) return existing.id;

  const lead = await createLead(
    {
      name: leadNameForChat(peer.title, phone),
      phone,
      // The manager whose Telegram it is owns the lead: they are the one who
      // already has the conversation open on their phone.
      ownerId: managerUserId,
    },
    { ...ctx, actorId: ctx.actorId ?? managerUserId },
  );
  return lead.id;
}

/**
 * Who opened a hidden-number lead — its note on the card, and the reason on
 * the tray rule's audit row. The «📵» card's words are the ones that door has
 * always written.
 */
export type PhonelessVia = 'agent_stranger' | 'work_account';

const PHONELESS_NOTE: Record<PhonelessVia, string> = {
  agent_stranger: 'Telegram: raqami yashirin — AI sotuvchining «📵» kartasidan ochildi.',
  work_account: 'Telegram: raqami yashirin — ish raqamiga yozdi, lid o‘zi ochildi.',
};

/**
 * The ONE hidden-number minting, shared by both doors that may open such a
 * lead: the AI's «📵» card («🆕 Yangi lid», his Q18 ⭐ — a person's press) and
 * a work number's own line (his «1 a», 2026-10-29 — the listener).
 *
 * There is no number to look an open lead up by, which is the rule
 * `leadForChat` keeps from minting twice — so the chat's tray rule (one per
 * manager and peer, `tg_chat_rules_unique_idx`) is that fence, held FOR
 * UPDATE for the whole mint: two lines of one burst, a reconnect's catch-up
 * meeting the live handler, a redelivered press — whoever comes second waits
 * for the first to commit and finds the lead it wrote on the rule. The rule
 * row is made (pending) first when the chat never had one, so even the very
 * first line has a row to lock; it commits as `include`, never as a pending
 * row the stranger-card sweep would ask about.
 *
 * When the rule has no lead — a ↩ on the tray took it back to «pending» — the
 * chat's own stored rows name the lead it was on: an OPEN one is the same
 * person and is taken again, as an open lead with the number is on the other
 * path. A closed one is not reused: a lost lead writing again is a new
 * enquiry (round 79).
 *
 * The machine door (`work_account`) does not write over a person's answer: a
 * chat somebody marked «hech qachon», or bound to a client, since the
 * listener read its rules answers null and nothing is minted — the caller
 * decides the line again on fresh rules. A person's press (`agent_stranger`)
 * is itself the answer and takes the chat whatever the rule said.
 *
 * Named by `leadNameForChat` (title, else @username, else the placeholder —
 * never the chat id); owned, like every chat lead, by the manager whose
 * account it is; the stage resolved BEFORE the transaction (#714). Audited
 * twice like `createLead` plus the tray's own decision: the lead's create
 * row, and the rule's change with the door's reason.
 */
export async function phonelessLeadForChat(
  input: { managerUserId: string; peerId: bigint; title: string | null; via: PhonelessVia },
  ctx: AuditContext,
): Promise<string | null> {
  const actor = { ...ctx, actorId: ctx.actorId ?? input.managerUserId };
  const where = and(eq(tgChatRules.managerUserId, input.managerUserId), eq(tgChatRules.peerId, input.peerId));
  // Every later line of the chat asks this until the listener's rules are
  // read again (ten minutes): an already-bound chat is one indexed read, not
  // a transaction. A committed include is final here — a person changing it
  // meanwhile is the stale-rules race every listener rule has.
  const [bound] = await db.select({ decision: tgChatRules.decision, leadId: tgChatRules.leadId }).from(tgChatRules).where(where);
  if (bound?.decision === 'include' && bound.leadId) return bound.leadId;
  // A client's chat whose number Telegram has since hidden is that client's,
  // not a new lead's (`keptClientOfChat`) — the machine door mints nothing
  // over it; `ownerOfVerdict` files the line on the client.
  if (!bound && input.via === 'work_account' && (await keptClientOfChat(input.managerUserId, input.peerId))) return null;
  const stageId = await defaultStageId();
  return db.transaction(async (tx) => {
    await tx
      .insert(tgChatRules)
      .values({
        managerUserId: input.managerUserId,
        peerId: input.peerId,
        decision: 'pending',
        peerTitle: input.title?.slice(0, 200) ?? null,
        peerPhone: null,
      })
      .onConflictDoNothing({ target: [tgChatRules.managerUserId, tgChatRules.peerId] });
    const [rule] = await tx.select().from(tgChatRules).where(where).for('update');
    if (!rule) return null;
    if (rule.decision === 'include' && rule.leadId) return rule.leadId;
    if (input.via === 'work_account' && (rule.decision === 'exclude' || (rule.decision === 'include' && rule.clientId))) return null;

    const [onRows] = await tx
      .select({ id: leads.id })
      .from(tgMessages)
      .innerJoin(leads, eq(leads.id, tgMessages.leadId))
      .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
      .where(
        and(
          eq(tgMessages.managerUserId, input.managerUserId),
          eq(tgMessages.peerId, input.peerId),
          eq(leadStages.kind, 'open'),
        ),
      )
      .orderBy(desc(tgMessages.sentAt))
      .limit(1);
    // A lead the rule still names (the «📵» door has always reused it) comes first.
    let leadId = rule.leadId ?? onRows?.id ?? null;
    if (!leadId) {
      // The name Telegram shows now, else the one the rule kept from earlier.
      const fresh = leadNameForChat(input.title, null);
      const name = fresh !== PHONELESS_LEAD_NAME ? fresh : leadNameForChat(rule.peerTitle, null);
      const lead = await insertLeadTx(
        tx,
        { name, ownerId: input.managerUserId, note: PHONELESS_NOTE[input.via] },
        actor,
        stageId,
      );
      await writeAudit(tx, actor, {
        entityType: 'lead',
        entityId: lead.id,
        action: 'create',
        after: { name, phone: null, stageId },
      });
      leadId = lead.id;
    }
    await tx
      .update(tgChatRules)
      .set({
        decision: 'include',
        leadId,
        clientId: null,
        // The label refreshed like a scan refreshes it: deciding from a stale name is deciding about the wrong person.
        peerTitle: input.title?.slice(0, 200) ?? rule.peerTitle,
        decidedBy: actor.actorId,
        decidedAt: new Date(),
      })
      .where(eq(tgChatRules.id, rule.id));
    await writeAudit(tx, actor, {
      entityType: 'tg_chat_rule',
      entityId: rule.id,
      action: 'update',
      before: { decision: rule.decision, clientId: rule.clientId, leadId: rule.leadId },
      after: { decision: 'include', clientId: null, leadId, reason: `${input.via}_phoneless` },
    });
    return leadId;
  });
}

/**
 * The client a hidden number's chat was ALREADY kept on — by the phone it
 * showed before its owner hid it from this account (Telegram's privacy
 * setting; the user id, and so the chat, stays the same). Only for a chat no
 * person ever decided on the tray (no rule row): those rows came from the
 * phone classifier, which is proof (agent `chatIdentity`). A rule-derived
 * client a ↩ took back is history, not identity, and is not followed here.
 * Without this, the first hidden line of a known client on a work number
 * would mint a «Telegram» lead and bind the chat to it for good — a rule
 * outranks the phone match even once the number shows again.
 */
export async function keptClientOfChat(
  managerUserId: string,
  peerId: bigint,
): Promise<{ clientId: string; clientCode: string } | null> {
  const [rule] = await db
    .select({ id: tgChatRules.id })
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, managerUserId), eq(tgChatRules.peerId, peerId)));
  if (rule) return null;
  const [newest] = await db
    .select({ clientId: tgMessages.clientId })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, managerUserId), eq(tgMessages.peerId, peerId)))
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  if (!newest?.clientId) return null;
  const [client] = await db
    .select({ id: clients.id, clientCode: clients.clientCode })
    .from(clients)
    .where(eq(clients.id, newest.clientId));
  return client ? { clientId: client.id, clientCode: client.clientCode } : null;
}

/** Where a kept line goes, and the word the listener's log prints for it. */
export interface ChatOwner {
  clientId: string | null;
  leadId: string | null;
  label: string;
}

/**
 * Whose card a STORED verdict's line goes on — asked by the listener's live
 * line and by its catch-up, which used to restate the three branches each:
 * a known client; a chat attached to a lead by hand (0065); a stranger on a
 * work number, whose lead is found or minted here (0064, and a hidden number
 * since his «1 a»).
 *
 * A hidden number whose chat was already kept on a client by the phone it
 * once showed stays on that client (`keptClientOfChat`).
 *
 * Null only for a hidden number whose chat a person answered otherwise since
 * the listener read its rules (`phonelessLeadForChat`): the line is not
 * stored, the caller re-reads the rules, and the answer decides the next line
 * — on the account the AI speaks from that answer's own pull fetches the day
 * back (chat-rules `pullForAgent`).
 */
export async function ownerOfVerdict(
  verdict: Extract<LiveVerdict, { store: true }>,
  managerUserId: string,
  ctx: AuditContext,
): Promise<ChatOwner | null> {
  if ('openLead' in verdict) {
    if (verdict.peer.phone === null) {
      const kept = await keptClientOfChat(managerUserId, verdict.peer.peerId);
      if (kept) return { clientId: kept.clientId, leadId: null, label: kept.clientCode };
    }
    const leadId = await leadForChat(managerUserId, verdict.peer, ctx);
    return leadId ? { clientId: null, leadId, label: 'LID' } : null;
  }
  // Somebody answered «Lid ochish» on the tray (0065). The lead is already
  // there — nothing to mint, nothing to name.
  if ('leadId' in verdict) return { clientId: null, leadId: verdict.leadId, label: 'LID' };
  return { clientId: verdict.clientId, leadId: null, label: verdict.clientCode };
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
