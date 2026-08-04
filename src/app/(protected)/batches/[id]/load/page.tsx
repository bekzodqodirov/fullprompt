import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { LoadingScreen } from './loading-screen';

export default async function LoadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('scan.load')) redirect('/');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) notFound();
  const t = await getTranslations('loading');

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-2 flex items-baseline gap-2">
        <h1 className="text-xl font-bold">📱 {t('title')}</h1>
        <Link href={`/batches/${id}`} className="font-mono font-extrabold text-brand-700">
          {batch.code}
        </Link>
      </div>
      <LoadingScreen batchId={id} />
    </div>
  );
}
