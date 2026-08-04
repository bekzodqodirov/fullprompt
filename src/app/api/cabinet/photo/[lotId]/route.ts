import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { attachments, receiptLots, receipts } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { authenticateCabinet, initDataFrom } from '@/modules/wms/client-cabinet/miniapp';

/**
 * A lot's photographs, for the client who owns that lot.
 *
 * Deliberately NOT modelled on the staff route (`/api/attachments/[id]`),
 * which checks only that SOME staff session exists and has no per-record
 * authorization at all. Copying its shape here would have let any linked
 * client read any other client's photographs by changing an id in a URL.
 *
 * So ownership is proved in the query itself: the lot must belong to a receipt
 * whose client is one of the clients this CHAT is linked to. There is no path
 * where a caller-supplied id decides what is returned.
 *
 * The thumbnail is preferred over the original for size — and because the
 * originals still carry their EXIF, which can include where a photograph was
 * taken. That is the warehouse's business, not the customer's.
 */
export async function GET(request: Request, { params }: { params: Promise<{ lotId: string }> }) {
  const auth = await authenticateCabinet(initDataFrom(request));
  if (!auth.ok) return new Response(auth.reason, { status: auth.status });

  const { lotId } = await params;
  const owned = await db
    .select({ id: receiptLots.id })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(receiptLots.id, lotId),
        inArray(receipts.clientId, auth.clients.map((c) => c.id)),
      ),
    )
    .limit(1);
  // Not "forbidden" — from this client's side the lot simply does not exist.
  if (owned.length === 0) return new Response('Not found', { status: 404 });

  const url = new URL(request.url);
  const index = Math.max(0, Number(url.searchParams.get('i') ?? 0));
  const photos = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'receipt_lot'),
        eq(attachments.entityId, lotId),
        eq(attachments.kind, 'photo'),
      ),
    )
    .orderBy(attachments.createdAt);
  const photo = photos[index];
  if (!photo) return new Response('Not found', { status: 404 });

  const key = photo.thumb800Key ?? photo.storageKey;
  try {
    const body = await getStorage().get(key);
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': photo.thumb800Key ? 'image/jpeg' : (photo.contentType ?? 'image/jpeg'),
        // Private: a shared cache must never hold one client's cargo photo.
        'cache-control': 'private, max-age=3600',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
