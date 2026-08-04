import { z } from 'zod';
import { pairDevice, TrackingError } from '@/modules/wms/tracking/devices';

/**
 * Driver app → server: exchange the trip's pair code for a token.
 * Deliberately UNAUTHENTICATED (the phone has no account) — the 6-character
 * single-use code shown on the batch card is the credential.
 */
const bodySchema = z.object({
  pairCode: z.string().min(4).max(12),
  platform: z.enum(['android', 'other']).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'bad_request' }, { status: 400 });

  try {
    const result = await pairDevice(parsed.data.pairCode, parsed.data.platform ?? 'android');
    return Response.json(result);
  } catch (err) {
    if (err instanceof TrackingError) {
      return Response.json({ error: err.code }, { status: err.code === 'bad_code' ? 404 : 409 });
    }
    throw err;
  }
}
