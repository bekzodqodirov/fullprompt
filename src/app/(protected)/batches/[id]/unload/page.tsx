import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { UnloadScreen } from './unload-screen';
import { PageHeader } from '@/components/ui/page';
import { mayCountMove } from '@/modules/wms/scanning/count-door';
import { batchTabHref, mayOpenBatchCard } from '@/modules/wms/batches/card-door';

export default async function UnloadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('scan.unload')) redirect('/');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) notFound();
  // The card's own door (origin OR destination in scope): the snapshot this
  // screen fetches was scoped, the page — its truck code — was not.
  if (!mayOpenBatchCard(actor, batch)) notFound();
  const t = await getTranslations('unloading');

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-2 flex items-baseline gap-2">
        <PageHeader icon="inbox" title={t('title')} />
        <Link href={`/batches/${id}`} className="font-mono font-extrabold text-brand-700">
          {batch.code}
        </Link>
      </div>
      {/* The office's count door lives on the truck card's unloading tab
          (0112, decision 2): the phone only gets a way there, and only for
          whoever holds it. */}
      <UnloadScreen
        batchId={id}
        countHref={mayCountMove(actor, batch.destWarehouseId) ? `${batchTabHref(id, 'yuklash')}#count-accept` : undefined}
      />
    </div>
  );
}
