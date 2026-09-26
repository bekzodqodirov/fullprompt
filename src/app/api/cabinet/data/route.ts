import { authenticateCabinet, cabinetPayload, initDataFrom } from '@/modules/wms/client-cabinet/miniapp';
import { linkPhoneSiblings } from '@/modules/wms/client-cabinet/service';

/**
 * Everything the client's cabinet shows, in one authenticated call.
 *
 * `no-store` because it is somebody's cargo and somebody's debt: a proxy or a
 * service worker holding this would show one client another's page after a
 * device is handed over, which is the failure the whole phone-verification
 * flow exists to prevent.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const initData = initDataFrom(request);
  let auth = await authenticateCabinet(initData);
  if (!auth.ok) {
    return Response.json({ error: auth.reason }, { status: auth.status });
  }
  // The person's other codes join their own cabinet (a shared phone is the
  // same person) — then the door is asked again, so the page shows them now.
  if ((await linkPhoneSiblings(auth.chatId).catch(() => 0)) > 0) {
    auth = await authenticateCabinet(initData);
    if (!auth.ok) return Response.json({ error: auth.reason }, { status: auth.status });
  }
  return Response.json(await cabinetPayload(auth), {
    headers: { 'cache-control': 'no-store, private' },
  });
}
