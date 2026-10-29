import { agentFeedResponse } from '@/modules/wms/crm/agent-feed-door';

/**
 * What became of every arrival the client-finding agent pushed: the ledger
 * outcome, the lead's stage and reason, the first contact — never a name,
 * phone, note, owner or price. Keyset-paged through `cursor`. The door, the
 * codes and the body are `agent-feed-door.ts` and docs/AGENT-FEED.md §3.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return agentFeedResponse(request, 'outcomes');
}
