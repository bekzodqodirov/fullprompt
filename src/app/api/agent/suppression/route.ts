import { agentFeedResponse } from '@/modules/wms/crm/agent-feed-door';

/**
 * The client-finding agent's «never propose these» list: hashed phone tails of
 * the client book and of the leads lost «Qayta qilinmasin». Full (no `since`)
 * or delta (`since=<ISO>`), keyset-paged through `cursor`. The door, the codes
 * and the body are `agent-feed-door.ts` and docs/AGENT-FEED.md §3.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return agentFeedResponse(request, 'suppression');
}
