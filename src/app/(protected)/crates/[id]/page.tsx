import { asc, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  costEntries,
  costTypes,
  crates,
  receiptLots,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { dissolveCrateAction, updateCrateAction } from '../actions';
import { BackLink } from '@/components/back-link';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { TasksPanel } from '@/components/tasks-panel';

/** Crate detail: contents, measured dims, label, dissolve (spec 6.2). */
export default async function CrateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crates.manage')) redirect('/');
  const t = await getTranslations('crates');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const rows = await db
    .select({ crate: crates, clientCode: clients.clientCode, clientName: clients.name, whCode: warehouses.code })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .where(eq(crates.id, id))
    .limit(1);
  const hit = rows[0];
  if (!hit) notFound();
  const { crate, clientCode, clientName, whCode } = hit;

  const members = await db
    .select({
      box: boxes,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(boxes.crateId, id))
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));

  const byLot = new Map<string, typeof members>();
  for (const m of members) {
    const key = `${m.letter}·${m.productNameZh}`;
    byLot.set(key, [...(byLot.get(key) ?? []), m]);
  }

  const files = await db
    .select()
    .from(attachments)
    .where(eq(attachments.entityId, id))
    .orderBy(asc(attachments.createdAt));

  const costs = await db
    .select({ entry: costEntries, typeName: costTypes.name })
    .from(costEntries)
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .where(eq(costEntries.crateId, id));

  const active = crate.status === 'active';

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/crates" label={t('title')} />
      <div className="card space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="font-mono text-xl font-extrabold text-brand-700">{crate.code}</h1>
          <span className="rounded bg-surface-sunken px-2 py-0.5 text-xs font-semibold">
            {crate.kind === 'karkas' ? t('karkas') : t('yashik')}
          </span>
          {!active && (
            <span className="rounded bg-bad/15 px-2 py-0.5 text-xs font-semibold text-bad">
              {t('dissolved')}
            </span>
          )}
          <span className="ml-auto text-sm text-ink-500">
            {whCode} · {format.dateTime(crate.createdAt, { dateStyle: 'short' })}
          </span>
        </div>
        <p>
          <span className="font-mono font-extrabold">{clientCode}</span>{' '}
          <span className="text-ink-700">{clientName}</span>
          <span className="ml-2 font-semibold">{members.length} 📦</span>
        </p>
        {crate.note && <p className="text-sm text-ink-700">📝 {crate.note}</p>}
        {costs.map(({ entry, typeName }) => (
          <p key={entry.id} className="text-sm">
            💰 {typeName}:{' '}
            <span className="font-semibold">
              {entry.amount} {entry.currency}
            </span>
          </p>
        ))}
        {active && (
          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={`/api/crates/${crate.id}/label`}
              target="_blank"
              className="btn-primary flex-1 whitespace-nowrap px-4"
            >
              🖨 {t('printLabel')}
            </a>
            <form
              action={dissolveCrateAction}
              className="flex-1"
            >
              <input type="hidden" name="crateId" value={crate.id} />
              <button type="submit" className="btn-danger w-full whitespace-nowrap px-4">
                ⛏ {t('dissolve')}
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="card space-y-2">
        <h2 className="text-lg font-bold">{t('contents')}</h2>
        {[...byLot.entries()].map(([key, lotMembers]) => (
          <div key={key} className="rounded-lg border border-line p-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-lg font-extrabold text-brand-700">
                {lotMembers[0]!.letter ?? '·'}
              </span>
              <span className="truncate">
                {lotMembers[0]!.productNameZh}
                {lotMembers[0]!.productNameRu && (
                  <span className="text-ink-500"> ({lotMembers[0]!.productNameRu})</span>
                )}
              </span>
              <span className="ml-auto text-sm font-semibold">{lotMembers.length} 📦</span>
            </div>
            <p className="mt-1 font-mono text-xs text-ink-500">
              {lotMembers.map((m) => m.box.shortCode).join(', ')}
            </p>
          </div>
        ))}
      </div>

      {active && (
        <form action={updateCrateAction} className="card space-y-2">
          <h2 className="text-lg font-bold">📐 {t('measured')}</h2>
          <input type="hidden" name="crateId" value={crate.id} />
          <div className="grid grid-cols-4 gap-1.5">
            <input name="lengthCm" aria-label="L" className="input-cell !h-10 text-center" inputMode="numeric" placeholder="L" defaultValue={crate.lengthCm ?? ''} />
            <input name="widthCm" aria-label="W" className="input-cell !h-10 text-center" inputMode="numeric" placeholder="W" defaultValue={crate.widthCm ?? ''} />
            <input name="heightCm" aria-label="H" className="input-cell !h-10 text-center" inputMode="numeric" placeholder="H" defaultValue={crate.heightCm ?? ''} />
            <input name="weightKg" aria-label="kg" className="input-cell !h-10 text-center" inputMode="decimal" placeholder="kg" defaultValue={crate.weightKg ?? ''} />
          </div>
          <input name="note" aria-label={t('note')} className="input" placeholder={`📝 ${t('note')}`} defaultValue={crate.note ?? ''} />
          <button type="submit" className="btn-secondary w-full">
            {tc('save')}
          </button>
        </form>
      )}

      <div className="card">
        <h2 className="mb-2 text-lg font-bold">📷 {t('photos')}</h2>
        <AttachmentsPanel
          entityType="crate"
          entityId={crate.id}
          initial={files.map((f) => ({
            id: f.id,
            fileName: f.fileName,
            contentType: f.contentType,
            kind: f.kind,
          }))}
          editable={active}
        />
      </div>

      <TasksPanel
        entityType="crate"
        entityId={crate.id}
        revalidate={`/crates/${crate.id}`}
      />

      <CustomFieldsPanel
        entityType="crate"
        entityId={crate.id}
        revalidate={`/crates/${crate.id}`}
      />
    </div>
  );
}
