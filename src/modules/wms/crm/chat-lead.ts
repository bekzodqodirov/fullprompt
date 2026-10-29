import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
 * A rule row no PERSON wrote: a question the listener or a scan left
 * (`pending` with no `decided_by` — `noteStranger`, `recordCandidates`), or
 * the listener's own lead binding (`include` on a lead with no `decided_by` —
 * this file's work-number door). A person's answer always carries who gave
 * it: the tray's ↩ included (`decideChat` writes `decided_by` on «pending»
 * too). The 2026-10-29 review: «any row means somebody decided» turned a
 * known client's chat into a lead for good once his own «📵» card's question
 * was standing.
 */
export function nobodyDecided(rule: { decision: string; decidedBy: string | null; clientId: string | null }): boolean {
  return rule.decidedBy === null && rule.clientId === null && (rule.decision === 'pending' || rule.decision === 'include');
}

/** The machine door found the chat is a client's after all — nothing it wrote may stay. */
class KeptOnClient extends Error {}

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
 * Which lead, in the order the phone path finds one: the rule's own while it
 * is OPEN; else the open lead the chat's own stored rows are on (a ↩ on the
 * tray took the rule back); else an open lead ANOTHER account's chat with the
 * same Telegram user is on — a user id is global, as a phone number is, and
 * the phone path joins two managers' chats with one person onto one lead
 * (the 2026-10-29 review: one customer writing to two work numbers got two
 * cards); else a new one. A closed lead is never reused: a lost lead writing
 * again is a new enquiry (round 79) — the rule is rebound to the new one.
 *
 * The machine door (`work_account`) does not write over a person's answer: a
 * chat somebody marked «hech qachon», or bound to a client, since the
 * listener read its rules answers null and nothing is minted — the caller
 * decides the line again on fresh rules. Nor over the phone book: a chat
 * nobody decided whose rows are a client's is that client's
 * (`keptClientOfChat`). A person's press (`agent_stranger`) is itself the
 * answer and takes the chat whatever the rule said.
 *
 * Its binding is the MACHINE's (`decided_by` NULL, read as `ChatRule.machine`):
 * nobody decided it, so `decideIncoming` lets it stand only on a work number,
 * while its lead is open, and until the book claims the chat. A press is a
 * person's and is recorded as theirs.
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
  const machine = input.via === 'work_account';
  const where = and(eq(tgChatRules.managerUserId, input.managerUserId), eq(tgChatRules.peerId, input.peerId));
  // Every later line of the chat asks this until the listener's rules are
  // read again: an already-bound chat whose lead is still open is one indexed
  // read, not a transaction. A committed include is final here — a person
  // changing it meanwhile is the stale-rules race every listener rule has.
  const [bound] = await db
    .select({
      decision: tgChatRules.decision,
      decidedBy: tgChatRules.decidedBy,
      clientId: tgChatRules.clientId,
      leadId: tgChatRules.leadId,
      leadKind: leadStages.kind,
    })
    .from(tgChatRules)
    .leftJoin(leads, eq(leads.id, tgChatRules.leadId))
    .leftJoin(leadStages, eq(leadStages.id, leads.stageId))
    .where(where);
  if (bound?.decision === 'include' && bound.leadId && bound.leadKind === 'open') return bound.leadId;
  // A client's chat whose number Telegram has since hidden is that client's,
  // not a new lead's (`keptClientOfChat`) — the machine door mints nothing
  // over it; `ownerOfVerdict` files the line on the client.
  if (machine && (!bound || nobodyDecided(bound)) && (await keptClientOfChat(input.managerUserId, input.peerId))) return null;
  const stageId = await defaultStageId();
  try {
    return await db.transaction(async (tx) => {
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
      const openKind = async (leadId: string) => {
        const [row] = await tx
          .select({ kind: leadStages.kind })
          .from(leads)
          .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
          .where(eq(leads.id, leadId));
        return row?.kind === 'open';
      };
      const ruleLead = rule.leadId && (await openKind(rule.leadId)) ? rule.leadId : null;
      if (rule.decision === 'include' && ruleLead) return ruleLead;
      if (machine && (rule.decision === 'exclude' || (rule.decision === 'include' && rule.clientId))) return null;
      if (machine && nobodyDecided(rule)) {
        // The book's answer, under the lock: the pre-check above ran on the
        // pool before it, and a row it may have inserted must not outlive a
        // refusal — the tray would ask about a client's chat.
        const [newest] = await tx
          .select({ clientId: tgMessages.clientId })
          .from(tgMessages)
          .where(and(eq(tgMessages.managerUserId, input.managerUserId), eq(tgMessages.peerId, input.peerId)))
          .orderBy(desc(tgMessages.sentAt), desc(tgMessages.tgMessageId))
          .limit(1);
        if (newest?.clientId) throw new KeptOnClient();
      }

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
        .orderBy(desc(tgMessages.sentAt), desc(tgMessages.tgMessageId))
        .limit(1);
      // The same Telegram user on a colleague's account: their rule's lead, or
      // the lead their stored rows are on (a visible-number lead has no rule).
      // The rows are asked per account, through the (manager, peer) prefix of
      // the messages' unique index — `peer_id` alone has no index.
      let elsewhere: string | null = null;
      if (!ruleLead && !onRows) {
        const others = (await tx.select({ id: tgAccounts.managerUserId }).from(tgAccounts))
          .map((a) => a.id)
          .filter((id) => id !== input.managerUserId);
        if (others.length > 0) {
          const [byRule] = await tx
            .select({ id: leads.id, createdAt: leads.createdAt })
            .from(tgChatRules)
            .innerJoin(leads, eq(leads.id, tgChatRules.leadId))
            .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
            .where(
              and(
                inArray(tgChatRules.managerUserId, others),
                eq(tgChatRules.peerId, input.peerId),
                eq(tgChatRules.decision, 'include'),
                eq(leadStages.kind, 'open'),
              ),
            )
            .orderBy(asc(leads.createdAt), asc(leads.id))
            .limit(1);
          const [byRows] = await tx
            .select({ id: leads.id, createdAt: leads.createdAt })
            .from(tgMessages)
            .innerJoin(leads, eq(leads.id, tgMessages.leadId))
            .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
            .where(and(inArray(tgMessages.managerUserId, others), eq(tgMessages.peerId, input.peerId), eq(leadStages.kind, 'open')))
            .orderBy(asc(leads.createdAt), asc(leads.id))
            .limit(1);
          // Oldest first, the phone path's own order (round 67b).
          const pick = [byRule, byRows]
            .filter((row): row is { id: string; createdAt: Date } => Boolean(row))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
          elsewhere = pick?.id ?? null;
        }
      }
      // A lead the rule still names (the «📵» door has always reused it) comes first.
      let leadId = ruleLead ?? onRows?.id ?? elsewhere;
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
          // Nobody decided the listener's binding — the marker `ChatRule.machine` reads.
          decidedBy: machine ? null : actor.actorId,
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
  } catch (err) {
    if (err instanceof KeptOnClient) return null;
    throw err;
  }
}

/**
 * The client a hidden number's chat was ALREADY kept on — by the phone it
 * showed before its owner hid it from this account (Telegram's privacy
 * setting; the user id, and so the chat, stays the same), or by the lead it
 * was won from. Only for a chat no PERSON decided on the tray
 * (`nobodyDecided`: no rule row, a question the «📵» card or a scan left, or
 * the listener's own lead binding): those rows came from the phone
 * classifier, or from a person winning the lead onto the client. A
 * rule-derived client a ↩ took back is history, not identity, and is not
 * followed here. Without this, the first hidden line of a known client on a
 * work number would mint a «Telegram» lead and bind the chat to it.
 *
 * Filing is not proof: the agent's fence asks its own question of these
 * rows (`chatIdentity` — a chat whose rows came through a lead proves itself
 * like a rule's, K9).
 */
export async function keptClientOfChat(
  managerUserId: string,
  peerId: bigint,
): Promise<{ clientId: string; clientCode: string } | null> {
  const [rule] = await db
    .select({ decision: tgChatRules.decision, decidedBy: tgChatRules.decidedBy, clientId: tgChatRules.clientId })
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, managerUserId), eq(tgChatRules.peerId, peerId)));
  if (rule && !nobodyDecided(rule)) return null;
  // Telegram dates a line to the SECOND, so a burst ties: its own message id
  // (which only grows within a chat) breaks it, or «the newest row» is a
  // different row on different days (round 67b) — the line after the number
  // showed would lose to the one before.
  const [newest] = await db
    .select({ clientId: tgMessages.clientId })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, managerUserId), eq(tgMessages.peerId, peerId)))
    .orderBy(desc(tgMessages.sentAt), desc(tgMessages.tgMessageId))
    .limit(1);
  if (!newest?.clientId) return null;
  const [client] = await db
    .select({ id: clients.id, clientCode: clients.clientCode })
    .from(clients)
    .where(eq(clients.id, newest.clientId));
  return client ? { clientId: client.id, clientCode: client.clientCode } : null;
}

/**
 * The listener's own lead binding, taken back: the phone book has claimed the
 * chat (`LiveVerdict.retiresMachineRule`). Only a binding NOBODY decided — a
 * person's answer is never deleted by a machine. The chat then has no rule at
 * all, which is what it would have had if Telegram had shown the number from
 * the first line: the book files it, and a later hidden line goes where its
 * rows are (`keptClientOfChat`). The lead it was on stays on the funnel with
 * its lines — closing a card is a person's call. Audited with the reason.
 */
export async function retireMachineBinding(managerUserId: string, peerId: bigint, ctx: AuditContext): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gone = await tx
      .delete(tgChatRules)
      .where(
        and(
          eq(tgChatRules.managerUserId, managerUserId),
          eq(tgChatRules.peerId, peerId),
          eq(tgChatRules.decision, 'include'),
          isNull(tgChatRules.decidedBy),
          isNull(tgChatRules.clientId),
        ),
      )
      .returning({ id: tgChatRules.id, leadId: tgChatRules.leadId });
    const row = gone[0];
    if (!row) return false;
    await writeAudit(tx, { ...ctx, actorId: ctx.actorId ?? managerUserId }, {
      entityType: 'tg_chat_rule',
      entityId: row.id,
      action: 'delete',
      before: { decision: 'include', clientId: null, leadId: row.leadId },
      after: { reason: 'book_match' },
    });
    return true;
  });
}

/** Where a kept line goes, and the word the listener's log prints for it. */
export interface ChatOwner {
  clientId: string | null;
  leadId: string | null;
  label: string;
  /** The chat's rule was written or taken back here — the listener's map is old. */
  rulesMoved: boolean;
}

/**
 * Whose card a STORED verdict's line goes on — asked by the listener's live
 * line and by its catch-up, which used to restate the three branches each:
 * a known client; a chat attached to a lead by hand (0065); a stranger on a
 * work number, whose lead is found or minted here (0064, and a hidden number
 * since his «1 a»).
 *
 * A hidden number whose chat was already kept on a client — by the phone it
 * once showed, or by the lead a person won onto the client — stays on that
 * client (`keptClientOfChat`). A known client whose chat the listener had
 * bound to a lead by itself takes the chat back (`retireMachineBinding`).
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
    const hidden = verdict.peer.phone === null;
    if (hidden) {
      const kept = await keptClientOfChat(managerUserId, verdict.peer.peerId);
      if (kept) return { clientId: kept.clientId, leadId: null, label: kept.clientCode, rulesMoved: false };
    }
    const leadId = await leadForChat(managerUserId, verdict.peer, ctx);
    // A hidden number goes through the chat's rule: the map that decided this
    // line did not have it bound to an open lead, and now it is.
    return leadId ? { clientId: null, leadId, label: 'LID', rulesMoved: hidden } : null;
  }
  // Somebody answered «Lid ochish» on the tray (0065), or the listener bound
  // the chat itself. The lead is already there — nothing to mint, nothing to name.
  if ('leadId' in verdict) return { clientId: null, leadId: verdict.leadId, label: 'LID', rulesMoved: false };
  const retired = verdict.retiresMachineRule ? await retireMachineBinding(managerUserId, verdict.row.peerId, ctx) : false;
  return { clientId: verdict.clientId, leadId: null, label: verdict.clientCode, rulesMoved: retired };
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
