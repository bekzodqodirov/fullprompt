import {
  callBatchSchema,
  callDeviceForToken,
  CallsError,
  ingestCalls,
} from '@/modules/wms/calls/service';

/**
 * The phone's call log, in batches. The server answers per call whether the
 * client book matched — `matched: false` means the number was looked at and
 * DROPPED, never stored (the hodim's personal calls are not the company's
 * data), and the app knows not to upload that call's audio.
 *
 * A revoked token is 410 GONE: the one answer that makes the app STOP.
 * A 401 is retried for ever — the driver fleet taught that (#289).
 */
export async function POST(request: Request) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  let device;
  try {
    device = await callDeviceForToken(token);
  } catch (err) {
    if (err instanceof CallsError) return Response.json({ error: 'revoked' }, { status: 410 });
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const parsed = callBatchSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'bad_request' }, { status: 400 });

  const verdicts = await ingestCalls(device, parsed.data);
  return Response.json({ verdicts });
}
