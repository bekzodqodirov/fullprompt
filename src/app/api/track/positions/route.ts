import {
  ingestPositions,
  positionBatchSchema,
  TrackingError,
} from '@/modules/wms/tracking/devices';

/**
 * Driver app → server: a batch of GPS fixes. The phone keeps them in its own
 * queue while offline (the whole China→UZ corridor has dead zones) and
 * flushes on reconnect, so re-sends must be harmless — they are, the ingest
 * ignores duplicates. The answer carries `dropped` beside `accepted`; the
 * shipped app reads only the status.
 */
export async function POST(request: Request) {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // A 400 is the one answer the phone can never recover from (it keeps the
  // batch and re-sends it first every cycle), so it is said only about a body
  // that is not a batch at all — a single unreadable fix inside one is the
  // ingest's to drop (`readPosition`) — and it is LOGGED, because the driver's
  // screen shows nothing but «HTTP 400».
  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    console.warn('[track] 400 not json', text.length, 'bytes:', text.slice(0, 200));
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const parsed = positionBatchSchema.safeParse(body);
  if (!parsed.success) {
    console.warn('[track] 400 not a batch', JSON.stringify(parsed.error.issues.slice(0, 3)), text.slice(0, 200));
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  try {
    const result = await ingestPositions(token, parsed.data);
    return Response.json(result);
  } catch (err) {
    if (err instanceof TrackingError) {
      // 410 tells the app to stop the service and clear its token.
      const status = err.code === 'trip_finished' ? 410 : 401;
      return Response.json({ error: err.code }, { status });
    }
    throw err;
  }
}
