import { and, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcRequests, clients, deals, leads } from '../../platform/db/schema';
import { chatCalcChains, chatIdentity, type CalcChain, type ChatIdentity } from './context';
import { missingChatFiles, missingFilesNote } from './calc-files';
import { machineMayTouch } from './machine-owner';
import type { CalcSubmitFacts } from './auto-gate';
import type { ComposedAction } from './types';

/**
 * «Hisoblatishni o'zi yuboradi» — what the machine must know before it lands a calculation by itself (SPEC-P2-v2
 * §1.1, §1.5). Read by the auto layer's facts (`autoFactsFor`, at the scheduling AND at the press) and by the landing
 * itself (decide `landCalc`: the hand-back loop's card). His ✅ is never gated by these: they are what keeps the
 * MACHINE off a job a person would want to look at first.
 *
 * Every read is pooled and outside any transaction (#714).
 */

export type CalcSubmitAction = Extract<ComposedAction, { type: 'calc_submit' }>;

/** «14 kun ichida shu yuk uchun hisoblatish bor» (MAP Q10 ⭐): a second request of the same section inside it waits. */
export const CALC_RECENT_MS = 14 * 24 * 60 * 60_000;

/**
 * The hand-back loop (§1.5, ⭐ §7 Q13): the chat holds a linked chain of this section whose NEWEST member the VED
 * handed back («Qaytarish») and nothing newer — the customer's answer is that request's missing information, so the
 * submit lands ON THAT REQUEST'S CARD (no new deal, no new lead) and is linked under the same root. Only a card this
 * chat's landing would itself reach: the client's own deal, or — for a chat with no client — the chat's own lead. A
 * returned request sitting anywhere else (a lead since won into this client) is no loop: the submit lands as any
 * other, and the 14-day rule judges it.
 */
export interface HandBackLoop {
  /** The returned request. */
  requestId: string;
  /** Its chain's root — the new request's link names it (`linkFor` and the context then see ONE chain). */
  rootRequestId: string;
  card: { kind: 'deal' | 'lead'; id: string; label: string | null };
}

export function handBackLoopOf(
  chains: readonly CalcChain[],
  section: string,
  identity: Pick<ChatIdentity, 'clientId' | 'leadId'>,
): HandBackLoop | null {
  const returned = chains
    .filter((c) => c.section === section && c.status === 'returned')
    .sort((a, b) => b.newestRequestedAt.getTime() - a.newestRequestedAt.getTime());
  for (const c of returned) {
    const fits =
      c.entityType === 'deal'
        ? identity.clientId !== null && c.dealClientId === identity.clientId
        : c.entityType === 'lead' && identity.clientId === null && c.entityId === identity.leadId;
    if (fits) return { requestId: c.newestId, rootRequestId: c.root, card: { kind: c.entityType as 'deal' | 'lead', id: c.entityId, label: c.cardLabel } };
  }
  return null;
}

/**
 * The facts, read now, with the lines the CARD carries for the two a person decides on knowing them (the waited
 * duplicate and the file the VED will not get). `holderId` is the account the reply leaves from — the draft's
 * `manager_user_id`, which the gate's `agentOn` already ties to the config's holder.
 */
export async function calcSubmitFacts(input: {
  managerUserId: string;
  peerId: bigint;
  action: Pick<CalcSubmitAction, 'section' | 'facts'>;
  /** The draft being judged — its own earlier landing never counts against it. */
  draftId: string | null;
  now: Date;
}): Promise<{ facts: CalcSubmitFacts; cardNotes: string[] }> {
  const holderId = input.managerUserId;
  const identity = await chatIdentity(input.managerUserId, input.peerId);
  const unproven = !(identity.cargoAllowed || (identity.clientId === null && identity.leadId !== null));
  const chains = await chatCalcChains(input.managerUserId, input.peerId);
  const loop = handBackLoopOf(chains, input.action.section, identity);

  // The landing's card: the loop's, else the chat's client (a deal is minted for it) or the chat's lead.
  let foreign = true;
  let leadTarget: string | null = null;
  if (loop?.card.kind === 'deal') {
    const [d] = await db
      .select({ ownerId: deals.ownerId, sellerId: clients.salesManagerId })
      .from(deals)
      .innerJoin(clients, eq(clients.id, deals.clientId))
      .where(eq(deals.id, loop.card.id));
    foreign = !d || !machineMayTouch({ kind: 'deal', ownerId: d.ownerId, clientSellerId: d.sellerId }, holderId);
  } else if (loop?.card.kind === 'lead' || (!loop && identity.clientId === null && identity.leadId !== null)) {
    leadTarget = loop?.card.id ?? identity.leadId;
    const [l] = await db.select({ ownerId: leads.ownerId }).from(leads).where(eq(leads.id, leadTarget!));
    foreign = !l || !machineMayTouch({ kind: 'lead', ownerId: l.ownerId }, holderId);
  } else if (identity.clientId !== null) {
    const [c] = await db.select({ sellerId: clients.salesManagerId }).from(clients).where(eq(clients.id, identity.clientId));
    foreign = !c || !machineMayTouch({ kind: 'client', sellerId: c.sellerId }, holderId);
  }

  // What the queue would say at the press — certain then, so a fact now (C8's rule).
  const { calcOpenRefusal, leadTakesJobs } = await import('../calc/service');
  const { landingItems } = await import('../calc/intake');
  const refused =
    (leadTarget !== null && !(await leadTakesJobs(leadTarget))) ||
    (await calcOpenRefusal(holderId, landingItems(input.action.facts).length)) !== null;

  // The 14-day rule (MAP Q10 ⭐) — never on the hand-back loop, which answers the very request it would count.
  const since = new Date(input.now.getTime() - CALC_RECENT_MS);
  const section = input.action.section;
  const recentChain = loop
    ? null
    : (chains.find((c) => c.section === section && (c.status === 'open' || c.newestRequestedAt.getTime() >= since.getTime())) ?? null);
  let recentLabel: string | null = recentChain?.cardLabel ?? null;
  let recent = recentChain !== null;
  if (!loop && !recent) {
    // (i) any request of this section on the landing's card created within the window, whoever asked — a
    // colleague's job on the client's deal, the seat's own bot «Hisoblatish» included.
    const clientIds = identity.clientId !== null ? [...new Set([identity.clientId, ...identity.codes.map((c) => c.id)])] : [];
    const onCard =
      clientIds.length > 0
        ? await db
            .select({ code: deals.code })
            .from(calcRequests)
            .innerJoin(deals, and(eq(calcRequests.entityType, 'deal'), eq(deals.id, calcRequests.entityId)))
            .where(and(inArray(deals.clientId, clientIds), eq(calcRequests.section, section), gte(calcRequests.requestedAt, since)))
            .limit(1)
        : leadTarget !== null
          ? await db
              .select({ code: leads.name })
              .from(calcRequests)
              .innerJoin(leads, and(eq(calcRequests.entityType, 'lead'), eq(leads.id, calcRequests.entityId)))
              .where(and(eq(leads.id, leadTarget), eq(calcRequests.section, section), gte(calcRequests.requestedAt, since)))
              .limit(1)
          : [];
    if (onCard[0]) {
      recent = true;
      recentLabel = onCard[0].code;
    }
  }

  const missing = await missingChatFiles(input.managerUserId, input.peerId, input.draftId);
  const cardNotes: string[] = [];
  if (recent) {
    // His ✅ on a waited duplicate lands as today (a coded client gets a NEW deal per request) — said, so he decides
    // knowing it (§1.1, regress 7 (b)).
    cardNotes.push(`🧮 14 kun ichida shu chatdan hisoblatish bor${recentLabel ? ` (${recentLabel})` : ''}: ✅ yangi so‘rov ochadi.`);
  }
  const filesNote = missingFilesNote(missing);
  if (filesNote) cardNotes.push(filesNote);
  return { facts: { unproven, foreign, refused, recent, fileMissing: missing.length > 0 }, cardNotes };
}
