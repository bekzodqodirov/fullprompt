import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, leadStages, leads, tgAccounts, tgChatRules, tgMessages } from '../../platform/db/schema';
import { phoneDigits } from '../../platform/clients/phone';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { logger } from '../../platform/logger';
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
 * always written. `tray`: «Lid ochish» on «Qaysi chatlar» for a hidden number
 * on a WORK account — the answer a person gives once a ↩ there has taken the
 * listener's own binding back (the 2026-10-29 review: the work number no
 * longer re-binds over a person's ↩, so the tray must be able to say «lid»).
 */
export type PhonelessVia = 'agent_stranger' | 'work_account' | 'tray';

const PHONELESS_NOTE: Record<PhonelessVia, string> = {
  agent_stranger: 'Telegram: raqami yashirin — AI sotuvchining «📵» kartasidan ochildi.',
  work_account: 'Telegram: raqami yashirin — ish raqamiga yozdi, lid o‘zi ochildi.',
  tray: 'Telegram: raqami yashirin — «Qaysi chatlar»dan lid sifatida ochildi.',
};

/**
 * The listener's mark on its OWN lead binding (0139, `bound_via`), read
 * through the row's jsonb: the column is SQL-only this release (the schema's
 * note on `tgChatRules`), so a server one migration behind reads NULL — «no
 * machine binding» — and never answers 42703. Inside a select FROM
 * `tg_chat_rules` the table's name is its row.
 */
export const boundViaSql = sql<string | null>`to_jsonb(${tgChatRules})->>'bound_via'`;

/** The one value 0139's CHECK admits — written by `phonelessLeadForChat`'s machine door and nobody else. */
const WORK_ACCOUNT_BINDING = 'work_account';

/**
 * Whether 0139 has landed — asked by the one writer of the mark, never by a
 * reader (they read NULL). Held once true: a ledger does not go backwards. A
 * false answer is asked again next time, because the listener does not wait
 * for `migrate` and may be a few seconds ahead of it on deploy morning.
 */
let boundViaKnown = false;
export async function boundViaReady(): Promise<boolean> {
  if (boundViaKnown) return true;
  try {
    const rows = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = to_regclass('public.tg_chat_rules') AND attname = 'bound_via' AND NOT attisdropped
      ) AS ok`);
    boundViaKnown = rows[0]?.ok === true;
  } catch (err) {
    logger.warn({ err }, '[chat-lead] bound_via not checked');
    return false;
  }
  return boundViaKnown;
}

/** Tests: a server one migration behind, as far as this process knows. */
export function __forgetBoundViaReady(): void {
  boundViaKnown = false;
}

type RuleFacts = {
  decision: string;
  decidedBy: string | null;
  clientId: string | null;
  leadId: string | null;
  boundVia: string | null;
};

/**
 * The listener's own lead binding — and only it: an include on a lead, no
 * client, no `decided_by`, AND the mark only its door writes (`boundVia`).
 * The mark is the fact; the shape beside it is the belt (a person's write
 * always carries `decided_by`, so a mark a person wrote over is no machine's).
 * The shape alone is NOT the listener's: round 113's website door
 * (`landSiteTag`) has written exactly that shape since it shipped, with no
 * actor, and production holds such rows (the 2026-10-29 review's blocker).
 */
export function isMachineBinding(rule: RuleFacts): boolean {
  return (
    rule.boundVia === WORK_ACCOUNT_BINDING &&
    rule.decision === 'include' &&
    rule.decidedBy === null &&
    rule.clientId === null &&
    rule.leadId !== null
  );
}

/**
 * A rule row no PERSON wrote and no door answered: a question the listener or
 * a scan left (`pending` with no `decided_by` — `noteStranger`,
 * `recordCandidates`), or the listener's own lead binding
 * (`isMachineBinding`). A person's answer always carries who gave it: the
 * tray's ↩ included (`decideChat` writes `decided_by` on «pending» too). The
 * 2026-10-29 review: «any row means somebody decided» turned a known client's
 * chat into a lead for good once his own «📵» card's question was standing —
 * and «no `decided_by` means nobody» turned a WEBSITE visitor's rule into
 * nobody's.
 */
export function nobodyDecided(rule: RuleFacts): boolean {
  if (rule.decision === 'pending') return rule.decidedBy === null && rule.clientId === null;
  return isMachineBinding(rule);
}

/** The rule's columns plus its 0139 mark — what `nobodyDecided` reads. */
const ruleWithMark = { ...getTableColumns(tgChatRules), boundVia: boundViaSql };

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
 * chat somebody marked «hech qachon», bound to a client, or put back in
 * question with the tray's ↩ (a «pending» that carries who pressed it — the
 * 2026-10-29 review: the next hidden line re-bound it and erased the ↩) since
 * the listener read its rules answers null and nothing is minted — the caller
 * decides the line again on fresh rules, and the chat waits on the tray. Nor
 * over another door's binding (round 113's website rule), nor over the phone
 * book: a chat nobody decided whose rows are a client's is that client's
 * (`keptClientOfChat`). A person's press (`agent_stranger`, `tray`) is itself
 * the answer and takes the chat whatever the rule said — the listener's own
 * binding included, which it then records as the PERSON's.
 *
 * Its binding is the MACHINE's — `decided_by` NULL and the 0139 mark
 * `bound_via = 'work_account'` (`isMachineBinding`, read as
 * `ChatRule.machine`), written in the same transaction and by no other door:
 * nobody decided it, so `decideIncoming` lets it stand while its lead is open
 * and until the book claims the chat; once its lead is closed a personal
 * number asks about the chat afresh (`settlePassedChat`). A live «📵» card
 * still asking about the chat is closed once the binding commits
 * (`closeStrangerCardsFor`) — its question has been answered, by the switch.
 * A press is a person's and is recorded as theirs.
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
      boundVia: boundViaSql,
      leadKind: leadStages.kind,
    })
    .from(tgChatRules)
    .leftJoin(leads, eq(leads.id, tgChatRules.leadId))
    .leftJoin(leadStages, eq(leadStages.id, leads.stageId))
    .where(where);
  // The chat is on an open lead already. A PERSON's press over the listener's
  // own binding goes on: it is that person's answer now, and is written so.
  if (bound?.decision === 'include' && bound.leadId && bound.leadKind === 'open' && (machine || !isMachineBinding(bound))) {
    return bound.leadId;
  }
  // A person's answer, or another door's binding, is never the machine's to write over.
  if (machine && bound && !nobodyDecided(bound)) return null;
  // A client's chat whose number Telegram has since hidden is that client's,
  // not a new lead's (`keptClientOfChat`) — the machine door mints nothing
  // over it; `ownerOfVerdict` files the line on the client.
  if (machine && (await keptClientOfChat(input.managerUserId, input.peerId))) return null;
  // The machine's binding must carry its mark, or it would read as a door's
  // answer for good (never yielding to the book). One migration behind there
  // is no mark to write, so the door mints nothing until 0139 lands — the
  // line is passed over, the next one decided on the landed schema.
  const markable = await boundViaReady();
  if (machine && !markable) {
    logger.warn({ managerUserId: input.managerUserId }, '[chat-lead] 0139 not applied — a hidden number on a work number is not bound until it is');
    return null;
  }
  const stageId = await defaultStageId();
  try {
    const minted = await db.transaction(async (tx) => {
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
      const [rule] = await tx.select(ruleWithMark).from(tgChatRules).where(where).for('update');
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
      if (rule.decision === 'include' && ruleLead && (machine || !isMachineBinding(rule))) return { leadId: ruleLead, ruleId: rule.id, bound: false };
      // The same refusal under the lock: a ↩, a «never», a client or another
      // door's binding written since the pre-check is a person's answer.
      if (machine && !nobodyDecided(rule)) return null;
      if (machine) {
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
          // Nobody decided the listener's binding — a person's press is theirs.
          decidedBy: machine ? null : actor.actorId,
          decidedAt: new Date(),
        })
        .where(eq(tgChatRules.id, rule.id));
      // The mark `ChatRule.machine` reads, in the same transaction — the ONE
      // writer of `bound_via` (0139): set by the machine's binding, cleared by
      // a person's press over it.
      if (markable) {
        await tx.execute(sql`UPDATE tg_chat_rules SET bound_via = ${machine ? WORK_ACCOUNT_BINDING : null} WHERE id = ${rule.id}`);
      }
      await writeAudit(tx, actor, {
        entityType: 'tg_chat_rule',
        entityId: rule.id,
        action: 'update',
        before: { decision: rule.decision, clientId: rule.clientId, leadId: rule.leadId },
        after: { decision: 'include', clientId: null, leadId, reason: `${input.via}_phoneless` },
      });
      return { leadId, ruleId: rule.id, bound: true };
    });
    if (minted?.bound && machine) await closeStrangerCardsFor(input.managerUserId, minted.ruleId);
    return minted?.leadId ?? null;
  } catch (err) {
    if (err instanceof KeptOnClient) return null;
    throw err;
  }
}

/**
 * The «📵» card a personal number left standing for a chat the work number
 * has now bound by itself (the 2026-10-29 review): its question is answered —
 * by the switch — and a card that still offers «🆕 Yangi lid» about a chat
 * that already IS a lead reads as a press waiting to happen. Closed the way
 * every answered card is (bot-door `closeRuleCards`: `live: false`, its sent
 * copies edited). A press that still arrives on a copy is a person's answer
 * and wins over the binding (bot-door `strangerPress`). After the commit and
 * best-effort: the binding stands whatever the cards say, and one migration
 * behind the agent's tables are not there at all.
 */
async function closeStrangerCardsFor(managerUserId: string, ruleId: string): Promise<void> {
  try {
    const { agentTablesReady } = await import('../agent/config');
    if (!(await agentTablesReady())) return;
    const { closeStrangerCards } = await import('../agent/bot-door');
    await closeStrangerCards(managerUserId, ruleId, STRANGER_CARD_BOUND);
  } catch (err) {
    logger.warn({ err, ruleId }, '[chat-lead] stranger card not closed after the work number bound the chat');
  }
}

/** What a closed «📵» card says once the work number has opened the lead by itself. */
export const STRANGER_CARD_BOUND = '🆕 Ish raqamiga yozdi — lid o‘zi ochildi. Shaxsiy bo‘lsa «Qaysi chatlar»da o‘zgartiring.';

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
    .select({
      decision: tgChatRules.decision,
      decidedBy: tgChatRules.decidedBy,
      clientId: tgChatRules.clientId,
      leadId: tgChatRules.leadId,
      boundVia: boundViaSql,
    })
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
 * The listener's own lead binding, taken back — and only it (`isMachineBinding`,
 * restated here in SQL over the 0139 mark): a person's answer is never deleted
 * by a machine, and neither is another door's binding (round 113's website
 * rule has the same shape and no mark). Two reasons:
 *
 *  - `book_match` — the phone book has claimed the chat
 *    (`LiveVerdict.retiresMachineRule`). The chat then has no rule at all,
 *    which is what it would have had if Telegram had shown the number from
 *    the first line: the book files it, and a later hidden line goes where its
 *    rows are (`keptClientOfChat`);
 *  - `lead_closed` — its lead was won or lost and a PERSONAL number passed
 *    the chat's next INBOUND line over (`settlePassedChat`): a closed lead
 *    writing again is a new enquiry (round 79), and on a personal number a
 *    new stranger is a question — which the binding's row, kept, would stop
 *    anybody from ever asking (the stranger card wants a «pending» row, the
 *    tray lists one).
 *    Asked only of a lead that is closed IN the statement, not in the
 *    listener's ten-minute map.
 *
 * The lead it was on stays on the funnel with its lines — closing a card is
 * a person's call. Audited with the reason.
 */
export async function retireMachineBinding(
  managerUserId: string,
  peerId: bigint,
  ctx: AuditContext,
  reason: 'book_match' | 'lead_closed' = 'book_match',
): Promise<boolean> {
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
          sql`${boundViaSql} = ${WORK_ACCOUNT_BINDING}`,
          // Qualified by hand: a single-table statement renders drizzle's columns bare (#128).
          reason === 'lead_closed'
            ? sql`NOT EXISTS (SELECT 1 FROM leads l JOIN lead_stages s ON s.id = l.stage_id
                               WHERE l.id = tg_chat_rules.lead_id AND s.kind = 'open')`
            : undefined,
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
      after: { reason },
    });
    return true;
  });
}

/**
 * Whether «🚫 Shaxsiy» may take what is stored of a chat with it: there are
 * stored lines, and every one of them is on a LEAD — none on a client. Asked
 * by the stranger card's press (agent bot-door `strangerPress`) only for a
 * chat no person had answered (`nobodyDecided`): its lines were kept on the
 * listener's say-so — its own binding, a work number's lead by the number
 * while a personal number's question about the same chat still stood, or a
 * binding whose closed lead was retired (`settlePassedChat`) — and the press
 * that says «this chat is private» says so of them too (the 2026-10-29
 * review: «saqlanmaydi» answered while the lines stayed). A line on a client
 * is a client's history, which a press about a stranger is never the door
 * to delete: the tray's purge after «hech qachon» stays that (#388).
 */
export async function storedOnLeadsOnly(managerUserId: string, peerId: bigint): Promise<boolean> {
  const [row] = await db
    .select({
      lines: sql<number>`count(*)::int`,
      onClient: sql<number>`count(*) FILTER (WHERE ${tgMessages.clientId} IS NOT NULL)::int`,
    })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, managerUserId), eq(tgMessages.peerId, peerId)));
  return (row?.lines ?? 0) > 0 && row?.onClient === 0;
}

/**
 * A line the SWITCH passed over (`ask` — a visible stranger on a personal
 * number; `no_phone` — a hidden one), asked whether its chat is a new
 * stranger's again: the listener's own binding whose lead has CLOSED is
 * retired (`lead_closed`), so the chat is asked about on the tray, and on the
 * AI's account by a fresh «📵» card (`reopened` — its claim given back).
 *
 * The switch decides about NEW strangers only (his rule, the 2026-10-29
 * review), and what is NOT new is decided by a RULE, never by rows: the
 * listener's binding stands while its lead is open whatever the switch says
 * (`decideIncoming`), a person's or a door's answer as always. A visible
 * number a work number kept on its lead by the number (the phone path writes
 * no rule) is a personal number's tray question again — that question CAN be
 * asked, and the tray's «Lid ochish» files the chat on the same open lead
 * (`leadForChat` finds it by the number). The first cut kept such a chat by
 * its rows, which no tray lists and no «hech qachon» could stop, and kept it
 * while a question about it was still standing (the second review).
 *
 * An INBOUND line only: a closed lead WRITING again is the new enquiry, the
 * manager's own line is not — and its `reopened` would be spent, because the
 * card's note (`noteStranger`) is never asked about a line of his own (the
 * second review: the claim was not given back, the card never came).
 *
 * Nothing about the line is read or written here but which chat it is.
 */
export async function settlePassedChat(
  managerUserId: string,
  peerId: bigint,
  rule: { machine?: boolean; leadOpen?: boolean } | undefined,
  direction: 'in' | 'out',
  ctx: AuditContext,
): Promise<{ reopened: boolean }> {
  if (direction !== 'in' || rule?.machine !== true || rule.leadOpen !== false) return { reopened: false };
  return { reopened: await retireMachineBinding(managerUserId, peerId, ctx, 'lead_closed') };
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
