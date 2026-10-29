import { json } from '../../platform/http/json';
import { logger } from '../../platform/logger';
import { AGENT_SOURCE_KEY, sourceWebhookSecret } from './inbound';
import { secretMatches } from './inbound-webhook';
import {
  clampLimit,
  decodeCursor,
  HASH_RULE,
  outcomesPage,
  parseSince,
  saltIdFor,
  suppressionPage,
} from './agent-feed';

/**
 * The door both agent feeds stand behind (`GET /api/agent/suppression`,
 * `GET /api/agent/outcomes`) — one rule for both routes, so they cannot drift
 * apart about who may read (#513). docs/AGENT-FEED.md §3.
 *
 * The POST door's two rules, unchanged (`api/leads/in/[source]`): **404 when
 * the `agent` source has no key** (the door is off — `undefined === undefined`
 * must never read as a match) and **404 for a wrong key**, because to anybody
 * who is not supposed to be here those are the same fact. The key is the
 * `agent` source's own webhook secret in the `X-GSR-Key` header, never in the
 * query string (a URL lands in proxy logs).
 *
 * Past the key the caller IS the agent, so it may be told the truth: 400 with
 * a code for a cursor or `since` it sent wrong (a bug on its side, not worth
 * retrying), 503 when we are down (it backs off and comes back). Never a
 * stack, never a 500 — Next's own error page carries no JSON. A database that
 * fails BEFORE the key could be checked is a 503 too — but only to a caller
 * that SENT a key: answering 404 there would trip the agent's breaker and
 * tell the owner his key is wrong, while to a caller with no key at all a 503
 * says «this feed exists, and its database is down right now» (review, sec
 * lens). Without a key it is the same 404 as every other refusal.
 */

export type AgentFeed = 'suppression' | 'outcomes';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const notFound = () => new Response('Not found', { status: 404 });

export async function agentFeedResponse(request: Request, feed: AgentFeed): Promise<Response> {
  const unavailable = (err: unknown) => {
    logger.error({ err, feed }, '[agent-feed] failed');
    return json(request, { error: 'unavailable' }, { status: 503, headers: NO_STORE });
  };

  const sent = request.headers.get('x-gsr-key');
  let secret: string | null;
  try {
    secret = await sourceWebhookSecret(AGENT_SOURCE_KEY);
  } catch (err) {
    if (!sent) {
      logger.error({ err, feed }, '[agent-feed] failed');
      return notFound();
    }
    return unavailable(err);
  }
  if (!secret) return notFound();
  if (!secretMatches(sent, secret)) {
    logger.warn({ feed }, '[agent-feed] bad key');
    return notFound();
  }

  const q = new URL(request.url).searchParams;
  const cursor = decodeCursor(q.get('cursor'));
  const since = parseSince(q.get('since'));
  if (cursor === 'invalid' || since === 'invalid') {
    return json(
      request,
      { error: cursor === 'invalid' ? 'bad_cursor' : 'bad_since' },
      { status: 400, headers: NO_STORE },
    );
  }
  const limit = clampLimit(q.get('limit'));

  try {
    if (feed === 'suppression') {
      const page = await suppressionPage({ secret, since, cursor, limit });
      return json(
        request,
        {
          mode: since ? 'delta' : 'full',
          generated_at: new Date().toISOString(),
          salt_id: saltIdFor(secret),
          rule: HASH_RULE,
          entries: page.entries,
          next: page.next,
          resume: page.resume,
        },
        { headers: NO_STORE },
      );
    }
    const page = await outcomesPage({ since, cursor, limit });
    return json(
      request,
      {
        generated_at: new Date().toISOString(),
        rows: page.rows,
        next: page.next,
        resume: page.resume,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return unavailable(err);
  }
}
