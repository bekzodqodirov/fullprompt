import { enqueue } from '@/modules/platform/jobs/boss';
import { JOB_META_LEAD } from '@/modules/wms/crm/meta-jobs';
import { leadgenEventsFrom, metaConfig, verifyMetaSignature } from '@/modules/wms/crm/meta-leads';
import { logger } from '@/modules/platform/logger';

/**
 * Meta's webhook for Lead Ads.
 *
 * Two rules run this file. **404 when unconfigured**: without all three
 * secrets there is nothing here, and answering the verification handshake from
 * a server that holds no token would let anybody subscribe their own page to
 * our funnel. And **answer 200 fast**: Meta re-delivers until it gets one, so
 * the work happens in a job, not in the request — a slow Graph call here means
 * the same lead arriving three more times while the first is still being read.
 */

export async function GET(request: Request) {
  const config = metaConfig();
  if (!config) return new Response('Not found', { status: 404 });

  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode !== 'subscribe' || token !== config.verifyToken) {
    return new Response('Forbidden', { status: 403 });
  }
  // Meta wants the challenge echoed as plain text, verbatim.
  return new Response(challenge ?? '', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

export async function POST(request: Request) {
  const config = metaConfig();
  if (!config) return new Response('Not found', { status: 404 });

  // The RAW bytes. Parsing and re-serialising cannot produce the string the
  // signature was computed over.
  const raw = await request.text();
  if (!verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'), config.appSecret)) {
    return new Response('Forbidden', { status: 403 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Signed by Meta and unreadable: answering 200 stops a retry loop that
    // could never succeed.
    logger.warn('[meta-leads] signed body was not JSON');
    return new Response('ok', { status: 200 });
  }

  const events = leadgenEventsFrom(body);
  for (const event of events) {
    try {
      await enqueue(JOB_META_LEAD, { ...event });
    } catch (err) {
      // One bad enqueue must not lose the rest of the batch, and must not turn
      // into a non-200 that makes Meta re-send the ones already queued.
      logger.error({ err, leadgenId: event.leadgenId }, '[meta-leads] enqueue failed');
    }
  }
  if (events.length) logger.info({ n: events.length }, '[meta-leads] queued');
  return new Response('ok', { status: 200 });
}
