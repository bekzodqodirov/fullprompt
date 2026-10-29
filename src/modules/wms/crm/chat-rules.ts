import { and, asc, eq, inArray, not, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  attachments,
  clients,
  leadStages,
  leads,
  tgAccounts,
  tgChatRules,
  tgMessages,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { getStorage } from '../../platform/files/storage';
import { logger } from '../../platform/logger';
import { boundViaSql, isMachineBinding, isWorkAccount, leadForChat, phonelessLeadForChat } from './chat-lead';
import {
  isTelegramOfficialPeer,
  OFFICIAL_ROUND_ID_CEILING,
  TELEGRAM_OFFICIAL_PEER_IDS,
  type ChatRule,
} from './telegram-import';

/**
 * The chats a person has said yes or no to.
 *
 * Owner: "shunda feature qo'sh — qaysi chatlarni qo'shish kerak va qaysini
 * qo'shmaslik." The automatic phone match stays; this is what sits on top of
 * it, in both directions.
 *
 * Everything here is per MANAGER. The same Telegram user is a client in one
 * person's phone and a friend in another's, and a decision in one account must
 * never silently apply to somebody else's.
 */

export class ChatRuleError extends Error {}

/** A rule's chat is one of Telegram's own accounts (a rule is only ever a private chat). */
export const officialChat = (peerId: bigint) => isTelegramOfficialPeer({ id: peerId, isPrivate: true });

/**
 * `officialChat` over a STORED peer id, in SQL — for the lists that must not
 * offer one of Telegram's own accounts as somebody to answer about: the tray
 * (`listCandidates`) and the AI's «📵» card sweep (agent jobs `strangerCards`).
 * Both excluded 777000 alone, so «Verification Codes» (489000, a bank's login
 * code), left pending by the card's own `noteStranger` before the classifiers
 * learned the rest, was listed and carded (the 2026-10-29 review). The same
 * ids and the same bound as the live predicate, from one list; Telegram's
 * `support` flag is on no stored row, so an account known only by it is
 * fenced where the live line sees it (the classifiers), not here.
 */
export function officialPeerSql(peerId: AnyColumn | SQL): SQL {
  const named = sql.join(
    TELEGRAM_OFFICIAL_PEER_IDS.map((id) => sql`${id.toString()}::bigint`),
    sql`, `,
  );
  return sql`(${peerId} IN (${named}) OR (${peerId} > 0 AND ${peerId} < ${OFFICIAL_ROUND_ID_CEILING.toString()}::bigint AND ${peerId} % 1000 = 0))`;
}

/*
 * Telegram's own service chat (777000 — login codes, «new login», limitation
 * notices) — and since the 2026-10-29 review every other account of
 * Telegram's own (`isTelegramOfficialPeer`) — is no customer under any answer. The classifiers have refused to
 * keep it since the AI sotuvchi round, but a tray rule written BEFORE that
 * (a scan's `pending`, even a decision) is still a row these doors can be
 * pressed on, and every one of them that makes a chat a card's —
 * `decideChat`'s include, «Yangi lid», «Chatni qo'shish» — would start
 * keeping a stream of login codes the agent then reads. Each refuses it in
 * words (`service_chat`) before writing anything; «hech qachon» stays open,
 * because that is the right answer and what the cleanup script writes.
 */

/**
 * The rules the import and the listener consult, keyed by peer — with the
 * two facts `decideIncoming` needs about a lead binding the listener made by
 * itself (chat-lead `phonelessLeadForChat`): that nobody decided it
 * (`machine` — the 0139 mark, `isMachineBinding`; round 113's website rule
 * has the same shape and is a door's answer), and whether its lead is still
 * open (`leadOpen`).
 */
export async function rulesFor(managerUserId: string): Promise<Map<bigint, ChatRule>> {
  const rows = await ruleRows(eq(tgChatRules.managerUserId, managerUserId));
  return new Map(rows.map((r) => [r.peerId, toChatRule(r)]));
}

/**
 * ONE chat's rule, in `rulesFor`'s own shape — for the listener's map after a
 * line the work number's door refused (chat-lead `phonelessLeadForChat`
 * answered null): the refusal is about this chat alone, so its entry is read
 * again and not the account's whole book of rules. That re-read ran once per
 * LINE of a chat a person's ↩ holds on the tray (the second 2026-10-29
 * review) — every rule of the account, for the same answer each time.
 */
export async function chatRuleFor(managerUserId: string, peerId: bigint): Promise<ChatRule | undefined> {
  const [row] = await ruleRows(and(eq(tgChatRules.managerUserId, managerUserId), eq(tgChatRules.peerId, peerId))!);
  return row ? toChatRule(row) : undefined;
}

function ruleRows(where: SQL) {
  return db
    .select({
      peerId: tgChatRules.peerId,
      decision: tgChatRules.decision,
      clientId: tgChatRules.clientId,
      clientCode: clients.clientCode,
      leadId: tgChatRules.leadId,
      decidedBy: tgChatRules.decidedBy,
      boundVia: boundViaSql,
      leadStageKind: leadStages.kind,
    })
    .from(tgChatRules)
    .leftJoin(clients, eq(tgChatRules.clientId, clients.id))
    .leftJoin(leads, eq(tgChatRules.leadId, leads.id))
    .leftJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(where);
}

function toChatRule(r: Awaited<ReturnType<typeof ruleRows>>[number]): ChatRule {
  return {
    peerId: r.peerId,
    decision: r.decision as ChatRule['decision'],
    clientId: r.clientId,
    clientCode: r.clientCode,
    leadId: r.leadId,
    machine: isMachineBinding(r),
    leadOpen: r.leadId ? r.leadStageKind === 'open' : undefined,
  };
}

export interface CandidateInput {
  peerId: bigint;
  title: string;
  phone: string | null;
}

/**
 * Record what a scan found, without answering anything.
 *
 * Called only by `pnpm tg-scan`, which a manager runs against their own
 * account. It refreshes the label on rows that already exist — a person may
 * have changed their Telegram name since the last scan, and deciding from a
 * stale name is deciding about the wrong person — but it never touches
 * `decision`: an answer already given is not a question to ask again.
 */
export async function recordCandidates(
  managerUserId: string,
  found: CandidateInput[],
): Promise<{ added: number; refreshed: number }> {
  if (found.length === 0) return { added: 0, refreshed: 0 };
  const existing = await db
    .select({ peerId: tgChatRules.peerId })
    .from(tgChatRules)
    .where(
      and(
        eq(tgChatRules.managerUserId, managerUserId),
        inArray(
          tgChatRules.peerId,
          found.map((f) => f.peerId),
        ),
      ),
    );
  const known = new Set(existing.map((e) => e.peerId));

  for (const item of found) {
    if (known.has(item.peerId)) {
      await db
        .update(tgChatRules)
        .set({ peerTitle: item.title, peerPhone: item.phone })
        .where(
          and(
            eq(tgChatRules.managerUserId, managerUserId),
            eq(tgChatRules.peerId, item.peerId),
          ),
        );
      continue;
    }
    await db.insert(tgChatRules).values({
      managerUserId,
      peerId: item.peerId,
      decision: 'pending',
      peerTitle: item.title,
      peerPhone: item.phone,
    });
  }
  return { added: found.length - known.size, refreshed: known.size };
}

export interface CandidateRow {
  id: string;
  peerId: string;
  managerUserId: string;
  managerName: string;
  decision: string;
  title: string | null;
  phone: string | null;
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  leadId: string | null;
  leadName: string | null;
  /** The account is «Ish raqami» — where the tray may open a lead for a hidden number (`openLeadForChat`). */
  workAccount: boolean;
}

/**
 * The chats waiting for an answer, or already answered.
 *
 * `managerUserId` narrows it to one person's account, and the screen passes
 * the VIEWER's own id unless they are allowed to see everybody's. That is the
 * whole privacy design of this feature: a scan puts the NAMES of a manager's
 * unmatched chats — their family, their friends — in a table, and the only
 * people who should read that list are the manager themselves and the owner.
 */
export async function listCandidates(filter: {
  managerUserId?: string;
  decision?: 'pending' | 'include' | 'exclude';
}): Promise<CandidateRow[]> {
  const where = [
    // Never on the tray, whatever an old scan or the «📵» card's own rule
    // recorded: none of Telegram's own accounts (`officialPeerSql`) has an
    // answer but «never», and the cleanup script gives that one. The badge
    // (`pendingCount`) counts through here, so it drops out of both.
    not(officialPeerSql(tgChatRules.peerId)),
    filter.managerUserId ? eq(tgChatRules.managerUserId, filter.managerUserId) : undefined,
    filter.decision ? eq(tgChatRules.decision, filter.decision) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: tgChatRules.id,
      peerId: tgChatRules.peerId,
      managerUserId: tgChatRules.managerUserId,
      managerName: users.fullName,
      decision: tgChatRules.decision,
      title: tgChatRules.peerTitle,
      phone: tgChatRules.peerPhone,
      clientId: tgChatRules.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      leadId: tgChatRules.leadId,
      leadName: leads.name,
      workAccount: sql<boolean>`coalesce(${tgAccounts.workAccount}, false)`,
    })
    .from(tgChatRules)
    .innerJoin(users, eq(tgChatRules.managerUserId, users.id))
    .leftJoin(clients, eq(tgChatRules.clientId, clients.id))
    .leftJoin(leads, eq(tgChatRules.leadId, leads.id))
    // One account per manager (`tg_accounts.manager_user_id` is unique), so the join adds no row.
    .leftJoin(tgAccounts, eq(tgAccounts.managerUserId, tgChatRules.managerUserId))
    .where(and(...where))
    .orderBy(asc(tgChatRules.peerTitle));

  // `peerId` is a bigint and this crosses to a client component; it goes as a
  // string, because JSON has no bigint and a silent precision loss on a
  // Telegram id would point a decision at the wrong person.
  return rows.map((r) => ({ ...r, peerId: r.peerId.toString() }));
}

/**
 * Answer one chat.
 *
 * `include` demands a client, and so does the table — the check is in the
 * schema as well as here, because `tg_messages.client_id` is NOT NULL and a
 * rule without a client would promise a message a home it does not have.
 *
 * Audited like every other decision that changes what the company keeps: who
 * said this chat was a client's, and when.
 */
export async function decideChat(
  input: {
    id: string;
    decision: 'include' | 'exclude' | 'pending';
    clientId?: string | null;
  },
  ctx: AuditContext,
): Promise<void> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, input.id));
  if (!rule) throw new ChatRuleError('chat_rule_not_found');
  if (input.decision === 'include' && officialChat(rule.peerId)) {
    throw new ChatRuleError('service_chat');
  }

  const clientId = input.decision === 'include' ? (input.clientId ?? null) : null;
  if (input.decision === 'include' && !clientId) throw new ChatRuleError('client_required');
  if (clientId) {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    if (!client) throw new ChatRuleError('client_not_found');
  }

  await db
    .update(tgChatRules)
    .set({
      decision: input.decision,
      clientId,
      // This is the CLIENT door. Answering here always retires a lead pointer
      // set by the other one — a chat that belongs to GS777 does not also
      // belong to the lead it was opened as, and «hech qachon» belongs to
      // nobody. Leaving it would make the listener store onto a lead the
      // screen no longer shows.
      leadId: null,
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    .where(eq(tgChatRules.id, input.id));

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: input.id,
    action: 'update',
    before: { decision: rule.decision, clientId: rule.clientId, leadId: rule.leadId },
    after: { decision: input.decision, clientId, leadId: null },
  });

  await withdrawAgentRepliesOf(rule);
  if (input.decision === 'include') await pullForAgent(rule, ctx);
}

/**
 * The rule doors' first hook into the AI sotuvchi (final review K7, ident fix
 * F1/F11): a decision that makes the chat somebody else's — the tray's «↩»,
 * «Shaxsiy», another client, «Yangi lid» from a stale tab, a card's «Chatni
 * qo'shish» — takes back the agent's replies written for whoever it was,
 * asked of the chat's identity AFTER the write by the ✅'s own rule (drafts
 * `withdrawMovedReplies`, context `bindMoved`): the same person — a phone
 * sibling, the client a won lead became — keeps everything, exactly as the
 * ✅ would let it through. Without it the web tray's undo left an approval
 * held for the morning to go out with the old client's name and codes into a
 * chat bound to nobody, and the send step's own identity check compares the
 * stored rows, which still name that client.
 *
 * After the rule is written, so a ✅ pressed in between asks the NEW rule
 * (decide.ts re-asks the chat's identity) or — committed before it — is
 * cancelled here (drafts first, then the waiting rows). Best-effort: the
 * decision stands whatever the agent's tables say, and on a server one
 * migration behind they are not there at all.
 */
async function withdrawAgentRepliesOf(rule: { id?: string; managerUserId: string; peerId: bigint }): Promise<void> {
  try {
    const { agentTablesReady } = await import('../agent/config');
    if (!(await agentTablesReady())) return;
    const { withdrawMovedReplies } = await import('../agent/drafts');
    await withdrawMovedReplies({
      managerUserId: rule.managerUserId,
      peerId: rule.peerId,
      why: 'identity_changed: the chat was decided again on the tray',
      note: '↩ Chat qayta hal qilindi — bu javob ketmaydi.',
    });
  } catch (err) {
    logger.warn({ err, ruleId: rule.id, peerId: String(rule.peerId) }, '[chat-rules] agent replies not withdrawn');
  }
}

/**
 * The rule doors' second hook into the AI sotuvchi (2026-10-29): a stranger
 * answered — «Bu mijoz» or «Yangi lid» — on the account the AI speaks from
 * asks the listener for the chat's last day (`tg_peer_pulls`), exactly as the
 * bot's stranger card has since it shipped. Until somebody answers nothing a
 * stranger wrote is stored (round 79), so without it the burst that prompted
 * the answer — the opening question — was never stored and never drafted:
 * the AI woke only on the customer's NEXT message, and answered that one
 * without the question before it.
 *
 * Only an answer to a chat still IN QUESTION (`pending` before the write — a
 * re-decided chat was being kept already, or was somebody's «never»), only on
 * the account the AI is running from (any other account keeps round 79's
 * «future only»), only when the person answering IS that account's holder —
 * the bot's stranger card answers only to him, and the tray's
 * `admin.settings.manage` holders, who may answer every account's row, do
 * not get to reach back a day into his own Telegram with it (the review of
 * this fix) — and through the bot's own `queuePull`, whose open-pull unique
 * index makes the bot's press and this one a single pull. After the rule is
 * written, so the listener's pull reads the NEW rule. Best-effort, like the
 * withdrawal: the decision stands whatever happens here.
 */
async function pullForAgent(rule: { id?: string; managerUserId: string; peerId: bigint; decision: string }, ctx: AuditContext): Promise<void> {
  if (rule.decision !== 'pending' || ctx.actorId !== rule.managerUserId) return;
  try {
    const { agentRunning, agentTablesReady, readAgentConfig } = await import('../agent/config');
    if (!(await agentTablesReady())) return;
    const config = await readAgentConfig();
    if (!agentRunning(config) || config.ownerUserId !== rule.managerUserId) return;
    const { queuePull } = await import('../agent/bot-door');
    await queuePull(rule.managerUserId, rule.peerId, ctx.actorId);
  } catch (err) {
    logger.warn({ err, ruleId: rule.id, peerId: String(rule.peerId) }, '[chat-rules] agent pull not queued');
  }
}

/**
 * The third answer the tray could not give: «this is business, but they are
 * nobody yet».
 *
 * 0064 taught the listener to open a lead by itself on a WORK number; on a
 * personal one it asks instead, and the only answers on offer were a client
 * from the book and «never». A person writing in for the first time is
 * neither — which is the exact case the owner reported as invisible.
 *
 * It goes through `leadForChat`, so the rule that matters most is inherited
 * rather than restated: an OPEN lead already carrying this number wins, and
 * pressing twice does not mint twice. The lead is owned by the manager whose
 * account the chat is in, not by whoever pressed — the owner reading his
 * staff's tray must not collect their leads.
 *
 * Future only, exactly like «Qo'shish» for a client: this attaches the chat,
 * it does not import what was said before the press. Round 79's promise was
 * that nothing is stored until somebody answers, and reaching backwards
 * through Telegram for the history is a separate decision — taken for ONE
 * account only, the one the AI speaks from, on its holder's own press
 * (`pullForAgent`): its opening question is the thing the AI must answer.
 */
export async function openLeadForChat(
  ruleId: string,
  ctx: AuditContext,
  opts: { phoneless?: 'agent_stranger' } = {},
): Promise<{ leadId: string }> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  if (!rule) throw new ChatRuleError('chat_rule_not_found');
  // Ahead of the phone: 777000 may well show one (42777), and a lead on it is
  // a funnel card whose «conversation» is a login code.
  if (officialChat(rule.peerId)) throw new ChatRuleError('service_chat');
  const phone = (rule.peerPhone ?? '').trim();
  // A hidden number, by name: the AI sotuvchi's «📵» card (his Q18 ⭐,
  // `phoneless`), and the tray of a WORK number (his «1 a» — there a hidden
  // stranger is a customer; the tray says so once a person's ↩ has taken the
  // listener's own binding back, which the work number no longer re-binds
  // over, the 2026-10-29 review). A PERSONAL number's tray keeps the old
  // refusal: a lead nobody can ring is a row with a name in it.
  const phonelessVia = phone ? null : (opts.phoneless ?? ((await isWorkAccount(rule.managerUserId)) ? 'tray' : null));
  if (!phone && !phonelessVia) throw new ChatRuleError('chat_no_phone');

  let leadId: string;
  if (phone) {
    leadId = await leadForChat(rule.managerUserId, { phone, title: rule.peerTitle }, ctx);
    await db
      .update(tgChatRules)
      .set({
        decision: 'include',
        leadId,
        clientId: null,
        decidedBy: ctx.actorId,
        decidedAt: new Date(),
      })
      .where(eq(tgChatRules.id, ruleId));

    await writeAudit(db, ctx, {
      entityType: 'tg_chat_rule',
      entityId: ruleId,
      action: 'update',
      before: { decision: rule.decision, clientId: rule.clientId, leadId: rule.leadId },
      after: { decision: 'include', clientId: null, leadId },
    });
  } else {
    // The one hidden-number minting (chat-lead `phonelessLeadForChat`): the
    // rule's own lead is the fence against a second press, and it writes the
    // rule and its audit row itself, in the same transaction as the lead. A
    // person's press is the answer, so it never comes back empty.
    const minted = await phonelessLeadForChat(
      { managerUserId: rule.managerUserId, peerId: rule.peerId, title: rule.peerTitle, via: phonelessVia! },
      ctx,
    );
    if (!minted) throw new ChatRuleError('chat_rule_not_found');
    leadId = minted;
  }
  await withdrawAgentRepliesOf(rule);
  await pullForAgent(rule, ctx);
  return { leadId };
}

/** The placeholder a hidden-number lead is named by — its home is `unknown-chat`, beside the naming rule. */
export { PHONELESS_LEAD_NAME } from './unknown-chat';

/**
 * «Chatni qo'shish» from a card, the other end of the owner's loop.
 *
 * The tray asks about a chat and hands it a card; this asks about a CARD and
 * hands it a chat — `managersWhoTalkedTo` found the number on somebody's
 * account, and this is the press that starts keeping that conversation.
 *
 * `managerUserId` is the VIEWER's own id and is never taken from the form: a
 * match names a colleague so the person creating the card knows who to ask,
 * and round 20's fence says knowing a conversation exists is not permission
 * to open it. Attaching somebody else's chat would do exactly that, on their
 * behalf, without them ever pressing anything.
 *
 * Future only, like every other include: this decides what is kept from now
 * on. What was said before the press is `pnpm tg-import`'s business.
 */
export async function attachPeerToCard(
  input: {
    peerId: bigint;
    managerUserId: string;
    clientId?: string | null;
    leadId?: string | null;
  },
  ctx: AuditContext,
): Promise<void> {
  // No card may own it, so the question of WHICH card does not arise. The
  // upsert below would otherwise turn a stale `pending` (or a person's
  // «never») into an include in one press.
  if (officialChat(input.peerId)) throw new ChatRuleError('service_chat');
  const clientId = input.clientId ?? null;
  const leadId = input.leadId ?? null;
  // The CHECK says the same thing in the database; saying it here too is what
  // turns a constraint violation into a sentence somebody can act on.
  if (!clientId && !leadId) throw new ChatRuleError('owner_required');

  const [row] = await db
    .insert(tgChatRules)
    .values({
      managerUserId: input.managerUserId,
      peerId: input.peerId,
      decision: 'include',
      clientId,
      leadId,
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [tgChatRules.managerUserId, tgChatRules.peerId],
      set: {
        decision: 'include',
        clientId,
        leadId,
        decidedBy: ctx.actorId,
        decidedAt: new Date(),
      },
    })
    .returning({ id: tgChatRules.id });

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: row!.id,
    action: 'update',
    after: { decision: 'include', clientId, leadId, reason: 'attached_from_card' },
  });
  await withdrawAgentRepliesOf({ id: row!.id, managerUserId: input.managerUserId, peerId: input.peerId });
}

/**
 * Stop taking a conversation that the phone rule DOES match.
 *
 * The other half of the owner's ask, and it was unreachable: `scanVerdict`
 * returns `'auto'` for anything the automatic rule already keeps, the scan
 * only records `'ask'` verdicts, and `recordCandidates` is the sole writer of
 * `tg_chat_rules` — so there was no route by which a matched chat could ever
 * be given an `exclude`. «Qo'shish» worked; «qo'shmaslik» did not.
 *
 * It is reachable from the conversation itself rather than from the list, and
 * that is the better place anyway: you are looking at the chat you are
 * deciding about, instead of judging a name on a page.
 *
 * Future only. It stops new messages being stored; what is already in
 * `tg_messages` stays, because deleting a client's conversation is a separate
 * decision with its own consequences — and this button must not quietly be
 * the one that takes it.
 */
export async function excludeChatForClient(
  input: { clientId: string; managerUserId: string; peerId: bigint },
  ctx: AuditContext,
): Promise<void> {
  const [row] = await db
    .insert(tgChatRules)
    .values({
      managerUserId: input.managerUserId,
      peerId: input.peerId,
      decision: 'exclude',
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
    })
    // A chat can already have a rule — most usefully a `pending` one from a
    // scan, or an `include` somebody is changing their mind about.
    .onConflictDoUpdate({
      target: [tgChatRules.managerUserId, tgChatRules.peerId],
      set: {
        decision: 'exclude',
        clientId: null,
        // …and the lead pointer with it (0065): «qo'shma» must leave the rule
        // owning nobody, or the listener would go on storing onto the lead.
        leadId: null,
        decidedBy: ctx.actorId,
        decidedAt: new Date(),
      },
    })
    .returning({ id: tgChatRules.id });

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: row!.id,
    action: 'update',
    after: { decision: 'exclude', clientId: input.clientId, reason: 'excluded_from_conversation' },
  });
}

/** How many chats are still waiting — for the badge on the screen. */
export async function pendingCount(managerUserId?: string): Promise<number> {
  const rows = await listCandidates({ managerUserId, decision: 'pending' });
  return rows.length;
}

/**
 * For each EXCLUDED chat whose phone matches a client in the book, the code it
 * matches (round 98, owner: «klient kodi bor chat olinmagan bo'lsa buni
 * bilishimiz uchun»). Excluding a chat is right for a friend or a wrong
 * number, but a chat carrying a real client's phone that was said no to is
 * probably a mistake, and the archive should say so rather than let it sit
 * unremarked. Phone identity is the app's usual last-nine (#598's rule).
 * One grouped query.
 */
export async function excludedBookMatches(
  rules: { id: string; phone: string | null }[],
): Promise<Map<string, string>> {
  const last9 = (raw: string | null) => {
    const d = (raw ?? '').replace(/[^0-9]/g, '');
    return d.length >= 9 ? d.slice(-9) : null;
  };
  const wanted = new Set(rules.map((r) => last9(r.phone)).filter(Boolean) as string[]);
  if (wanted.size === 0) return new Map();

  // The book is small (a couple of thousand rows) and `phones` is a jsonb
  // ARRAY, so the tail index lives in JS: build code-by-last-nine once, then
  // look each excluded chat up. One query, no per-row scan (#432).
  const book = await db
    .select({ code: clients.clientCode, phones: clients.phones })
    .from(clients)
    .where(eq(clients.active, true));
  const byTail = new Map<string, string>();
  for (const row of book) {
    for (const raw of Array.isArray(row.phones) ? row.phones : []) {
      const tail = last9(typeof raw === 'string' ? raw : null);
      if (tail && wanted.has(tail) && !byTail.has(tail)) byTail.set(tail, row.code);
    }
  }
  const out = new Map<string, string>();
  for (const rule of rules) {
    const tail = last9(rule.phone);
    const code = tail ? byTail.get(tail) : undefined;
    if (code) out.set(rule.id, code);
  }
  return out;
}

/**
 * Stored rows still standing behind each EXCLUDED chat — so the screen can
 * offer the purge only where there is something to purge, with the number
 * on the button. One grouped query for the whole list.
 */
export async function excludedLeftovers(
  rules: { id: string; managerUserId: string; peerId: bigint }[],
): Promise<Map<string, number>> {
  if (rules.length === 0) return new Map();
  const out = new Map<string, number>();
  for (const rule of rules) {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tgMessages)
      .where(
        and(eq(tgMessages.managerUserId, rule.managerUserId), eq(tgMessages.peerId, rule.peerId)),
      );
    const n = Number(row?.n ?? 0);
    if (n > 0) out.set(rule.id, n);
  }
  return out;
}

/**
 * «Qo'shma» from the conversation itself, as the OWNER expects it to work
 * (his report, 2026-07-29: «qo'shma desa hali ham sistemada turibti»):
 * exclude the chat AND delete what was already stored, in one press. The
 * confirm on the button states both consequences before the press — the
 * two-step design (#388) survives on the «Qaysi chatlar» screen for rules
 * that were excluded without this button.
 */
export async function excludeAndPurgeChat(
  input: { clientId: string; managerUserId: string; peerId: bigint },
  ctx: AuditContext,
): Promise<{ messages: number; photos: number }> {
  await excludeChatForClient(input, ctx);
  const [rule] = await db
    .select({ id: tgChatRules.id })
    .from(tgChatRules)
    .where(
      and(
        eq(tgChatRules.managerUserId, input.managerUserId),
        eq(tgChatRules.peerId, input.peerId),
      ),
    );
  return purgeExcludedChat(rule!.id, ctx);
}

/**
 * The SEPARATE decision `excludeChatForClient` refused to take quietly:
 * delete what was already stored for an excluded chat — the messages and
 * the photographs that came with them.
 *
 * Explicit, per chat, and only AFTER the exclude: the rule row is the
 * proof somebody decided this conversation is not the company's to keep,
 * and this second press is them saying the past of it is not either.
 * Audited with the counts, because "who deleted a conversation and when"
 * is exactly the question the audit log exists for. Deliberately NOT
 * touched: `tg_outbox` — those are replies the COMPANY sent through its
 * own screens, a record of our side's actions, not of the excluded chat.
 */
export async function purgeExcludedChat(
  ruleId: string,
  ctx: AuditContext,
): Promise<{ messages: number; photos: number }> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  if (!rule) throw new ChatRuleError('chat_rule_not_found');
  // Only an excluded chat: purging an INCLUDED client's conversation is a
  // different (and refused) act — exclude it first, on the same screen.
  if (rule.decision !== 'exclude') throw new ChatRuleError('not_excluded');

  // The AI sotuvchi's copies of this chat go first (0138, review leak-9): its
  // drafts, runs, outbox rows, calc links, the facts born in it and the
  // cards' quoted text — «o'chirildi» must mean every copy.
  const { purgeAgentChat } = await import('../agent/purge');
  await purgeAgentChat(rule.managerUserId, rule.peerId);

  const rows = await db
    .select({ id: tgMessages.id })
    .from(tgMessages)
    .where(
      and(eq(tgMessages.managerUserId, rule.managerUserId), eq(tgMessages.peerId, rule.peerId)),
    );
  if (rows.length === 0) return { messages: 0, photos: 0 };
  const messageIds = rows.map((r) => r.id);

  // The photographs first: rows, then bytes. Storage deletion is
  // best-effort AFTER the rows are gone — an orphaned object in MinIO is
  // waste; a database row pointing at deleted bytes is a broken screen.
  const photoRows = await db
    .select({
      id: attachments.id,
      storageKey: attachments.storageKey,
      thumb200Key: attachments.thumb200Key,
      thumb800Key: attachments.thumb800Key,
    })
    .from(attachments)
    .where(
      and(eq(attachments.entityType, 'tg_message'), inArray(attachments.entityId, messageIds)),
    );
  if (photoRows.length > 0) {
    await db.delete(attachments).where(
      inArray(
        attachments.id,
        photoRows.map((p) => p.id),
      ),
    );
  }
  await db.delete(tgMessages).where(inArray(tgMessages.id, messageIds));

  const storage = getStorage();
  for (const photo of photoRows) {
    for (const key of [photo.storageKey, photo.thumb200Key, photo.thumb800Key]) {
      if (!key) continue;
      await storage.delete(key).catch(() => {});
    }
  }

  await writeAudit(db, ctx, {
    entityType: 'tg_chat_rule',
    entityId: ruleId,
    action: 'update',
    after: {
      purged: true,
      messages: messageIds.length,
      photos: photoRows.length,
    },
  });
  return { messages: messageIds.length, photos: photoRows.length };
}
