import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayCountMove } from '@/modules/wms/scanning/count-door';
import { batchTabHref, mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { LoadingScreen } from './loading-screen';

export default async function LoadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('scan.load')) redirect('/');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) notFound();
  // The card's own door (origin OR destination in scope): the snapshot this
  // screen fetches was scoped, the page — its truck code — was not.
  if (!mayOpenBatchCard(actor, batch)) notFound();
  const t = await getTranslations('loading');
  // «Sanab yuklash» lives on the truck card's loading tab (0112, Q3): the
  // admin and the logist standing at this truck get a door to it, operators
  // nothing new.
  const countHref =
    ['forming', 'loading'].includes(batch.status) && mayCountMove(actor, batch.originWarehouseId)
      ? `${batchTabHref(id, 'yuklash')}#count-load`
      : undefined;

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-2 flex items-baseline gap-2">
        <h1 className="text-xl font-bold">📱 {t('title')}</h1>
        <Link href={`/batches/${id}`} className="font-mono font-extrabold text-brand-700">
          {batch.code}
        </Link>
      </div>
      <LoadingScreen batchId={id} countHref={countHref} />
    </div>
  );
}
