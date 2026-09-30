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
import { reroutedAwayFor } from '@/modules/wms/batches/reroute';

export default async function UnloadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('scan.unload')) redirect('/');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) notFound();
  const t = await getTranslations('unloading');
  // The warehouse the truck was taken from (the reroute round): its staff
  // opened this screen from a link or a home row that is now stale, and a
  // bare 404 says nothing. The sentence names where the truck goes now; the
  // card itself stays closed to them (stated). Asked only of somebody the
  // card's door would refuse, so nobody else pays the read.
  const away = mayOpenBatchCard(actor, batch) ? null : await reroutedAwayFor(actor, 'scan.unload', batch);
  if (away) {
    const tn = await getTranslations('nav');
    return (
      <div className="mx-auto max-w-lg space-y-3">
        <div className="mb-2 flex items-baseline gap-2">
          <PageHeader icon="inbox" title={t('title')} />
          <span className="font-mono font-extrabold text-brand-700">{batch.code}</span>
        </div>
        <p
          role="alert"
          data-testid="unload-rerouted"
          className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad"
        >
          {t('batchRerouted', { to: away.toCode })}
        </p>
        <Link href="/" className="btn-secondary w-full">
          ← {tn('home')}
        </Link>
      </div>
    );
  }
  // The card's own door (origin OR destination in scope): the snapshot this
  // screen fetches was scoped, the page — its truck code — was not.
  if (!mayOpenBatchCard(actor, batch)) notFound();

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
