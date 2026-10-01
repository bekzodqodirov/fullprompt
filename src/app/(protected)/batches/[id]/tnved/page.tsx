import Link from 'next/link';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { attachments, receipts } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayOpenBatchCard, mayOpenBatchVed } from '@/modules/wms/batches/card-door';
import { loadBatchHead } from '@/modules/wms/batches/card-head';
import { batchCustomsRows } from '@/modules/wms/partners/customs';
import { listPartners } from '@/modules/wms/partners/service';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { batchTnvedProducts } from '@/modules/wms/tnved/batch-lots';
import { paperStampFor } from '@/modules/wms/receipts/lot-composition';
import { receiptsReadableBy } from '@/modules/wms/receipts/read-door';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { Panel } from '@/components/panel';
import { setSentToAgentAction } from '../../batch-actions-server';
import { BatchCard, batchTabMetadata } from '../batch-card';
import { CustomsCleared } from '../customs-cleared';
import { CustomsFirm } from '../customs-firm';
import { CustomsPerReceipt } from '../customs-per-receipt';
import { TnvedEditor } from './tnved-editor';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return batchTabMetadata((await params).id, 'bojxona');
}

/**
 * «Bojxona» — the truck's papers, its customs and the ТНВЭД codes of what it
 * declares (docs/CARD-TABS.md): the VED's tab. It was the card's two rail
 * panels plus this page, a door away (Phase 1.5); the page is the tab now and
 * the panels are on it, papers first (the quick buttons), the editor last
 * (the widest thing).
 *
 * The door is `ved.docs ∨ plans.manage` AND the card's own two-ends scope,
 * which this page never asked: a scoped holder could open any truck's codes
 * by typing its address.
 */
export default async function BatchTnvedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tarkib?: string }>;
}) {
  const { id } = await params;
  const { tarkib } = await searchParams;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayOpenBatchVed(actor.permissions)) redirect('/');
  const head = await loadBatchHead(id);
  if (!head) notFound();
  if (!mayOpenBatchCard(actor, head.batch)) notFound();
  const { batch } = head;
  const t = await getTranslations('batches');
  const ttn = await getTranslations('tnved');
  const format = await getFormatter();
  const canVehicle = actor.permissions.has('batches.vehicle_info');

  // Retired firms included on purpose: a firm retired after it cleared this
  // truck must not drop out of the picker — a select whose value matches no
  // option silently shows the FIRST one, which here reads «as the truck
  // says». New rows are offered the live firms only.
  const allPartners = await listPartners({ includeInactive: true, includeStaff: maySeeStaffMoney(actor.permissions) });
  const customsRows = await batchCustomsRows(id);
  const customsChosen = new Set(
    [batch.customsPartnerId, ...customsRows.map((row) => row.partnerId)].filter(
      (value): value is string => value !== null,
    ),
  );
  const customsPartners = allPartners
    .filter((row) => (row.typeCode === 'customs' && row.active) || customsChosen.has(row.id))
    .map((row) => ({ id: row.id, name: row.name }));
  // What the collapsed panel says out loud: which firm clears this truck, and
  // how many prixods answer for themselves (round 43).
  const customsOwnAnswers = customsRows.filter((row) => !row.fromBatch).length;
  const customsBadge = [
    // The stamp goes on the FOLD's face, because a collapsed panel with
    // nothing on it is invisible whatever it holds — round 43's own lesson,
    // learned on this very panel.
    batch.customsClearedAt ? '✅' : null,
    batch.customsByClient
      ? t('customsByClient')
      : (customsPartners.find((row) => row.id === batch.customsPartnerId)?.name ?? '—'),
    customsOwnAnswers > 0 ? `+${customsOwnAnswers}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const batchFiles = await db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      contentType: attachments.contentType,
      kind: attachments.kind,
    })
    .from(attachments)
    .where(and(eq(attachments.entityType, 'batch'), eq(attachments.entityId, id)));

  // The editor's rows — the list the header counts «TNVED kodsiz» from.
  const products = await batchTnvedProducts(id, batch.departedAt !== null);
  const lotIds = products.flatMap((row) => row.lotIds);
  const photoRows = lotIds.length
    ? await db
        .select({
          entityId: attachments.entityId,
          photoId: sql<string>`(array_agg(${attachments.id} ORDER BY ${attachments.createdAt}))[1]`,
        })
        .from(attachments)
        .where(
          and(
            eq(attachments.entityType, 'receipt_lot'),
            inArray(attachments.entityId, lotIds),
            eq(attachments.kind, 'photo'),
          ),
        )
        .groupBy(attachments.entityId)
    : [];
  const photoByLot = new Map(photoRows.map((r) => [r.entityId, r.photoId]));
  // Lot tarkibi: the prixods behind the rows, FILTERED by the receipt read
  // door first — a scoped reader of this tab outlives `cargoNearActor` once
  // the cartons move on, and a client's invoice file NAME often carries the
  // client and an amount. A link to a prixod the person cannot open is not
  // drawn (#1023: a link that bounces is worse than no link).
  const receiptIds = [...new Set(products.flatMap((row) => row.lots.map((chip) => chip.receiptId)))];
  const receiptRows = receiptIds.length
    ? await db
        .select({ id: receipts.id, warehouseId: receipts.warehouseId, number: receipts.number })
        .from(receipts)
        .where(inArray(receipts.id, receiptIds))
    : [];
  const readable = await receiptsReadableBy(actor, receiptRows);
  const firstLine = new Set<string>();
  const rows = products.map(({ lotIds: ofProduct, ...row }) => {
    const firstOfLot = row.line ? !firstLine.has(row.line.lotId) : false;
    if (row.line) firstLine.add(row.line.lotId);
    return {
      ...row,
      photoId: ofProduct.map((lotId) => photoByLot.get(lotId)).find(Boolean) ?? null,
      lots: row.lots.map((chip) => ({ ...chip, readable: readable.has(chip.receiptId) })),
      line: row.line ? { ...row.line, readable: readable.has(row.line.receiptId), firstOfLot } : undefined,
    };
  });
  // A save elsewhere (the receipt card) replaces every line id and bumps the
  // revision: the key re-seeds the editor instead of leaving it posting dead
  // ids for ever.
  const editorKey = rows.map((row) => (row.line ? `${row.line.rowKey}@${row.line.rev}` : row.lotId)).join('|');
  const readableReceipts = receiptRows.filter((r) => readable.has(r.id));
  const receiptDocs = readableReceipts.length
    ? await db
        .select({
          id: attachments.id,
          fileName: attachments.fileName,
          contentType: attachments.contentType,
          kind: attachments.kind,
          receiptId: attachments.entityId,
        })
        .from(attachments)
        .where(
          and(
            eq(attachments.entityType, 'receipt'),
            inArray(
              attachments.entityId,
              readableReceipts.map((r) => r.id),
            ),
          ),
        )
    : [];
  const docsByReceipt = readableReceipts
    .map((r) => ({ ...r, files: receiptDocs.filter((d) => d.receiptId === r.id) }))
    .filter((r) => r.files.length > 0);
  const labelOfReceipt = new Map(products.flatMap((row) => row.lots.map((chip) => [chip.receiptId, chip.label.split('-')[0]] as const)));
  const tk = await getTranslations('tarkib');
  const stamp = !batch.sentToAgentAt ? await paperStampFor(batch.id) : '';
  const loaded = batch.departedAt !== null || batch.status === 'loading';

  return (
    <BatchCard head={head} actor={actor} active="bojxona">
      <section id="hujjatlar" className="card max-w-3xl scroll-mt-20 space-y-2">
        <h2 className="text-lg font-bold">📑 {t('vedDocs')}</h2>
        <div className="flex flex-wrap gap-2">
          <a href={`/api/batches/${batch.id}/invoice`} target="_blank" className="btn-secondary flex-1 whitespace-nowrap px-3">
            ⬇️ {t('invoice')}
          </a>
          {/* The photo packing list replaced the draft one in practice
              (owner); the generator stays reachable at /api/batches/[id]/packing. */}
          {loaded && (
            <a href={`/api/batches/${batch.id}/packing-photos`} target="_blank" className="btn-secondary flex-1 whitespace-nowrap px-3">
              ⬇️ 📷 {t('packingPhotos')}
            </a>
          )}
        </div>
        {/* The papers that travel with the truck. Same fence as the card
            itself — a declaration is not more secret than the manifest. */}
        <div className="border-t border-line pt-2">
          <p className="section-title">📎 {t('documents')}</p>
          <AttachmentsPanel
            entityType="batch"
            entityId={batch.id}
            initial={batchFiles}
            editable={actor.permissions.has('ved.docs') || canVehicle}
          />
        </div>
        {tarkib === 'yangilandi' && !batch.sentToAgentAt && (
          <p className="rounded-lg bg-warn/10 p-2 text-sm font-semibold text-warn" data-testid="tnved-paper-moved">
            ⚠ {tk('paperMoved')}
          </p>
        )}
        {tarkib === 'band' && (
          <p className="rounded-lg bg-warn/10 p-2 text-sm font-semibold text-warn" data-testid="tnved-tick-busy">
            ⚠ {tk('errors.busy')}
          </p>
        )}
        {actor.permissions.has('ved.docs') && (
          <form action={setSentToAgentAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            {/* What the page showed and the compositions it was drawn with —
                the tick freezes exactly these or refuses (lot tarkibi, 7a). */}
            <input type="hidden" name="want" value={batch.sentToAgentAt ? 'unsent' : 'sent'} />
            <input type="hidden" name="paperStamp" value={stamp} />
            <button
              type="submit"
              data-testid="tnved-sent-toggle"
              className={`w-full rounded-lg border-2 border-dashed p-2.5 text-sm font-semibold ${batch.sentToAgentAt ? 'border-green-500 bg-good/10 text-good' : 'border-line-strong text-ink-700'}`}
            >
              {batch.sentToAgentAt
                ? `✅ ${t('sentToAgent')}: ${format.dateTime(new Date(batch.sentToAgentAt), { dateStyle: 'short' })}`
                : `📤 ${t('markSentToAgent')}`}
            </button>
          </form>
        )}
        {docsByReceipt.length > 0 && (
          <div className="border-t border-line pt-2">
            <Panel
              title={`📎 ${tk('receiptDocs')}`}
              badge={tk('receiptDocsCount', { n: docsByReceipt.reduce((sum, r) => sum + r.files.length, 0) })}
              testId="receipt-docs"
            >
              <div className="space-y-2 px-3 pb-3">
                {docsByReceipt.map((r) => (
                  <div key={r.id}>
                    <Link href={`/receipts/${r.id}`} className="text-sm font-semibold text-brand-700 underline">
                      {labelOfReceipt.get(r.id) ?? '?'} · {r.number}
                    </Link>
                    <AttachmentsPanel entityType="receipt" entityId={r.id} initial={r.files} editable={false} />
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        )}
      </section>

      {/* Rastamojka has a panel of its own, and it is deliberately NOT inside
          the papers. It shipped there, folded inside another fold, and the
          owner reported the feature as missing — a collapsed panel with
          nothing on its face is invisible whatever it holds (round 43). The
          badge names the firm on the collapsed card, so the answer to "who is
          clearing this truck" needs no tap at all. */}
      <div className="max-w-3xl">
        <Panel title={`🛃 ${t('customs')}`} badge={customsBadge} testId="batch-customs-panel">
          <CustomsFirm
            batchId={batch.id}
            partnerId={batch.customsPartnerId}
            byClient={batch.customsByClient}
            partners={customsPartners}
            canEdit={actor.permissions.has('ved.docs')}
          />
          {/* His third case: inside one truck some clients clear their own
              cargo and we clear the rest, so the answer lives per prixod
              with the truck's as the default. */}
          <CustomsPerReceipt
            batchId={batch.id}
            rows={customsRows}
            partners={customsPartners}
            canEdit={actor.permissions.has('ved.docs')}
          />
          {/* The one thing in the system that knows a declaration cleared —
              which is what splits «O'zbekistonga kirdi» from «Rastamojka
              tugadi» on the customer's own timeline (owner: «ha rastamojka
              tugadi tugmasini qo'sh»). */}
          <CustomsCleared
            batchId={batch.id}
            clearedAt={batch.customsClearedAt}
            canEdit={actor.permissions.has('ved.docs')}
          />
        </Panel>
      </div>

      {/* Not inside a card: the editor's rows ARE cards, and a card in a card
          took 32 px off a 360 px phone the editor's buttons needed. */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">🏷 {ttn('title')}</h2>
        {rows.length === 0 ? <p className="text-sm text-ink-500">{ttn('empty')}</p> : <TnvedEditor key={editorKey} batchId={id} rows={rows} />}
      </section>
    </BatchCard>
  );
}
