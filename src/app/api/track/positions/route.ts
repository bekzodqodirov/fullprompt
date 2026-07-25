import {
  ingestPositions,
  positionBatchSchema,
  TrackingError,
} from '@/modules/wms/tracking/devices';

/**
 * Driver app → server: a batch of GPS fixes. The phone keeps them in its own
 * queue while offline (the whole China→UZ corridor has dead zones) and
 * flushes on reconnect, so re-sends must be harmless — they are, the ingest
 * ignores duplicates.
 */
export async function POST(request: Request) {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const parsed = positionBatchSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'bad_request' }, { status: 400 });

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
