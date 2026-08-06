import { z } from 'zod';
import { CallsError, pairCallDevice } from '@/modules/wms/calls/service';

/**
 * Calls app → server: exchange a /profile pair code for a token.
 * Deliberately UNAUTHENTICATED (the phone holds no session) — the
 * 6-character single-use code the hodim reads off their own profile is the
 * credential, and it binds the device to THAT user.
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
    const result = await pairCallDevice(parsed.data.pairCode, parsed.data.platform ?? 'android');
    return Response.json(result);
  } catch (err) {
    if (err instanceof CallsError) {
      return Response.json({ error: err.code }, { status: 404 });
    }
    throw err;
  }
}
