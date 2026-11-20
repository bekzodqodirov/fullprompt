import { db } from '../../platform/db/client';
import { agentSignals } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { actorGrants } from '../../platform/rbac/authorize';
import { agentToliq1aReady, mayRunAgent, type AgentConfig } from './config';
import { designated, type AgentTopic } from './designations';
import { AGENT_PAGE } from './web-door';

/**
 * The AI page as a link a Telegram line can carry — absolute, on its own last line, which the drain turns into a
 * «↗️ Ochish» button (staff-html `takeOwnLink`); `section` opens one of its tabs.
 */
export function agentPageUrl(section?: string): string {
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/u, '');
  return `${appUrl}${AGENT_PAGE}${section ? `?bolim=${section}` : ''}`;
}

/**
 * Of these people, who may open the AI page — its own door, `mayRunAgent`, asked of each person's grants the way a
 * job asks of a person with no session (`actorGrants`). J17: a line that tells somebody to open the page, or links
 * to it, goes only to those the page admits — the deputy he designated reads the counts and is never sent to a door
 * that bounces (asked of him: ⭐ the page stays the holder's and the super_admins').
 */
export async function agentPageReaders(userIds: readonly string[], config: Pick<AgentConfig, 'ownerUserId'> | null): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of new Set(userIds)) {
    const grants = await actorGrants(id);
    if (mayRunAgent({ id, roles: grants.roles }, config)) out.add(id);
  }
  return out;
}

/**
 * A signal about ONE chat, said ONCE (stage 1a §4.5): the claim is the row (`agent_signals.dedupe_key`, unique over
 * the whole table — #599, the row IS the claim), and the copies to the people designated for the topic are queued in
 * the SAME transaction, so a claim never stands without its copies and no copy goes without its claim.
 *
 * Not the system watch's `platform/diagnostics/signals.ts` (0115's state rows, «exists while the fault stands») —
 * two files of this name from stage 1a on, and they do not merge: this one is a fact about a CHAT, written once and
 * kept; that one is the system's own state, written and deleted.
 *
 * Each copy carries the chat it is about by both keys the purge finds an `AgentSignal` by (`managerUserId`,
 * `peerId` — purge.ts `chatCardsWhere`, J15): its copies sit on the rows of the colleagues he designated, so a purged
 * chat blanks every one of them, never only the account holder's.
 */

export interface SignalInput {
  topic: AgentTopic;
  managerUserId: string;
  peerId: bigint;
  leadId: string | null;
  clientId: string | null;
  /** What was said, as data — counts and measures, never a customer's words. */
  facts: Record<string, unknown>;
  /** Once per this key, ever (e.g. `big_cargo:<manager>:<peer>:<Monday>` — once per chat per week). */
  dedupeKey: string;
}

/**
 * Claim the signal and queue its copies — the recipients and each one's text read BEFORE the transaction
 * (`designated()` reads the pool, #714), the claim and the rows inside it, the drain kicked after the commit.
 * One migration behind 0151 nothing is claimed and nothing is sent (no row could hold the «once»): logged, quiet.
 * `claimed` false = already said under this key, or not ready.
 */
export async function sendSignal(
  input: SignalInput,
  textFor: (recipientId: string) => Promise<string> | string,
): Promise<{ claimed: boolean; queued: number }> {
  if (!(await agentToliq1aReady())) {
    logger.info({ topic: input.topic }, '[agent] signal not sent — the server is one migration behind');
    return { claimed: false, queued: 0 };
  }
  const recipients = await designated(input.topic);
  const copies: { userId: string; text: string }[] = [];
  for (const userId of recipients) copies.push({ userId, text: await textFor(userId) });
  const out = await db.transaction(async (tx) => {
    const claim = await tx
      .insert(agentSignals)
      .values({
        topic: input.topic,
        managerUserId: input.managerUserId,
        peerId: input.peerId,
        leadId: input.leadId,
        clientId: input.clientId,
        facts: input.facts,
        dedupeKey: input.dedupeKey,
      })
      .onConflictDoNothing({ target: agentSignals.dedupeKey })
      .returning({ id: agentSignals.id });
    if (claim.length === 0) return { claimed: false, queued: 0 };
    let queued = 0;
    for (const copy of copies) {
      queued += await queueStaffTelegram(tx, {
        userIds: [copy.userId],
        type: 'AgentSignal',
        text: copy.text,
        extra: { managerUserId: input.managerUserId, peerId: String(input.peerId) },
      });
    }
    return { claimed: true, queued };
  });
  if (out.queued > 0) await kickTelegramDrain();
  return out;
}
