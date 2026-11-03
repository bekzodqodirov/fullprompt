import {
  INBOUND_SOURCE_KEYS,
  isAgentSource,
  landInboundLead,
  sourceWebhookSecret,
} from '@/modules/wms/crm/inbound';
import {
  parseInboundPayload,
  refWithoutSecret,
  secretFrom,
  secretMatches,
} from '@/modules/wms/crm/inbound-webhook';
import { logger } from '@/modules/platform/logger';

/**
 * One door for every advertising platform that posts to a URL of our choosing.
 *
 * `POST /api/leads/in/google`, `/api/leads/in/tiktok`, `/api/leads/in/sayt` —
 * Google Ads lead form extensions (and therefore YouTube lead forms), a
 * connector standing in front of TikTok, and the owner's own website all speak
 * the same two shapes and differ only in where they put the key. One endpoint
 * with a secret per SOURCE, so switching a channel off is one button and does
 * not touch any other channel.
 *
 * Three rules, each of them a lesson from the Meta door (round 83):
 *
 *  - **404 when the source has no secret.** An unconfigured door must not
 *    exist. A key comparison against a null secret is the `undefined ===
 *    undefined` failure in another costume.
 *  - **Never throw.** `timingSafeEqual` throws on a length mismatch and every
 *    platform here reads a 500 as «send it again», so a crash becomes a retry
 *    loop nobody can stop from this side.
 *  - **One constant answer.** Created, joined, recognised as a client, or
 *    dropped at the cap all leave with the same body, because a public
 *    endpoint that answers differently for a number already in the client book
 *    is a way to walk a list and learn who our customers are (#600).
 *
 * The client-finding agent's door (`agent`, docs/AGENT-FEED.md §1) keeps the
 * one constant answer for every OUTCOME, but not for a landing that failed:
 * there it answers 503. The 200 was a promise the arrival was recorded, and
 * the agent believed it — a push lost to a bad minute was never re-sent and
 * never flagged, and when the throw came after the lead's INSERT the lead
 * stood unannounced and outside the agent's outcomes (review, 2026-10-24).
 * The agent is ours and retries on a schedule we wrote, so the retry loop the
 * second rule fears is bounded there; a retry of an arrival that WAS recorded
 * meets the replay fence and is answered 200. Every other door keeps the 200.
 */

/** The agent's own door, after its landing (or the key lookup) failed: retry later. */
const UNAVAILABLE = () =>
  new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** What every caller is told, whatever actually happened. */
const OK = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function POST(request: Request, ctx: { params: Promise<{ source: string }> }) {
  const { source } = await ctx.params;
  if (!(INBOUND_SOURCE_KEYS as readonly string[]).includes(source)) {
    return new Response('Not found', { status: 404 });
  }

  let secret: string | null;
  try {
    secret = await sourceWebhookSecret(source);
  } catch (err) {
    // Nothing is checked yet. The agent, which SENDS its key in the header,
    // is told to come back — the GET feeds' rule (agent-feed-door.ts); a
    // caller with no header, and every other door, fail as they always did.
    if (isAgentSource(source) && request.headers.get('x-gsr-key')) {
      logger.error({ err, source }, '[leads-in] key lookup failed');
      return UNAVAILABLE();
    }
    throw err;
  }
  if (!secret) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Unreadable and unauthenticated: nothing here says who sent it, so it
    // gets the same nothing an unconfigured door gives.
    return new Response('Not found', { status: 404 });
  }

  if (!secretMatches(secretFrom(body, request.headers.get('x-gsr-key')), secret)) {
    // 404 rather than 403: a wrong key and a door that does not exist are the
    // same fact to anybody who is not supposed to be here.
    logger.warn({ source }, '[leads-in] bad key');
    return new Response('Not found', { status: 404 });
  }

  const fields = parseInboundPayload(body);
  try {
    const result = await landInboundLead({
      channel: 'webhook',
      sourceKey: source,
      externalId: fields.externalId,
      // Whatever names the campaign, kept whole and unread so a platform we
      // have never seen still leaves a trail — MINUS the key, which Google
      // puts in the body and which must never reach a table the arrivals
      // screen reads or a backup nobody can recall.
      ref: refWithoutSecret(body),
      name: fields.name,
      phone: fields.phone,
      note: fields.note,
      company: fields.company,
      fields: fields.fields,
    });
    logger.info({ source, outcome: result.outcome, reason: result.reason }, '[leads-in] landed');
  } catch (err) {
    // The sender must not learn that our database is having a bad minute, and
    // must not be told to retry into it either — the arrival is lost, loudly,
    // in our own log. Answering 500 would have Google re-post for hours. The
    // agent's door is the exception above: it IS told, and retries.
    logger.error({ err, source }, '[leads-in] landing failed');
    if (isAgentSource(source)) return UNAVAILABLE();
  }
  return OK();
}
