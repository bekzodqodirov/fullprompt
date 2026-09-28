import { asc, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, costTypes, currencies, receiptLots, receipts } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { batchCostEntryCount, batchCostSheet, batchScopeCostByType, receiptCostMatrix } from '@/modules/wms/costing/service';
import { batchLots } from '@/modules/wms/batches/lots';
import { mayOpenBatchCard, mayOpenBatchCosts } from '@/modules/wms/batches/card-door';
import { loadBatchHead } from '@/modules/wms/batches/card-head';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { listPartners } from '@/modules/wms/partners/service';
import { CostPanel } from '@/components/cost-panel';
import { ReceiptCostGrid, type GridReceiptRow } from '../receipt-cost-grid';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { tillOptionsFor } from '@/modules/wms/costing/till-props';
import { costSightFor, tillView } from '@/modules/wms/costing/cost-sight';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { BatchCard, batchTabMetadata } from '../batch-card';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return batchTabMetadata((await params).id, 'xarajat');
}

/**
 * «Xarajatlar» — the truck card's money going OUT (docs/CARD-TABS.md): the
 * truck's own bills first (the CostPanel the card used to carry), then
 * «Расходы по приходам», the accountant's grid (round 47, owner's item 8:
 * «kichkina joyga katta narsa tiqilgan — butun ekranga sig'adigan qilib»).
 *
 * The grid is a spreadsheet: one row per prixod, one column per expense type,
 * and a truck with twelve receipts and six cost types is 72 input boxes. It
 * keeps the tab's full width — nothing sits beside it.
 *
 * Same permission as entering a batch cost, because that is exactly what a
 * saved cell becomes; the cargo-scope check is the batch card's own rule.
 */
export default async function BatchCostGridPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canEnter = actor.permissions.has('costs.enter_batch');
  if (!mayOpenBatchCosts(actor.permissions)) redirect('/');
  const t = await getTranslations('batches');
  const tc = await getTranslations('common');
  const tcost = await getTranslations('costing');

  const head = await loadBatchHead(id);
  if (!head) notFound();
  if (!mayOpenBatchCard(actor, head.batch)) notFound();
  const { batch } = head;

  // The goods, not only the prixod number (owner, 2026-09-24: «jadval rasxod
  // kiritadigan joyda tovar nomi, karobka soni va rasmi kerak»). The ROW
  // stays the prixod — a cost entry is receipt-scope, and the receipt card,
  // voidReceipt's money guard and the annul all key on it — the lots ride
  // inside it as lines.
  const gridRows = groupLotsByReceipt(await batchLots(id));
  // Q19 D1: the VED's cells carry what HE typed, and a colleague's only as
  // «✍ written» — the sheet's sums beside the truck's kg are its tannarx.
  const sight = costSightFor(actor);
  const [matrix, batchScope] = await Promise.all([
    receiptCostMatrix(
      gridRows.map((row) => row.receiptId),
      id,
      sight,
    ),
    batchScopeCostByType(id, sight),
  ]);
  const existing = Object.fromEntries(matrix);
  const types = await db
    .select({ id: costTypes.id, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true))
    // A column order the database happens to return is a column order that
    // can move between two sessions typing the same sheet (#524).
    .orderBy(asc(costTypes.createdAt), asc(costTypes.code));
  const currencyCodes = (
    await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
  ).map((row) => row.code);
  // Same list the CostPanel offers: who settled this, when it was not us.
  const partnerOptions = canEnter
    ? (await listPartners({ includeStaff: maySeeStaffMoney(actor.permissions) })).map((row) => ({ id: row.id, name: row.name }))
    : [];

  // Q19 (owner, 2026-09-25): the VED lists only the entries he typed, and
  // the truck's total and per-unit cost come back null for him — everybody's
  // entries beside this truck's kg/m³ are the tannarx one division away.
  const costSheet = await batchCostSheet(id, costSightFor(actor));
  // «Rasxodini yozmading» (owner, 2026-09-24): a truck that has LEFT with
  // nothing attributed to it — no bill of its own, no stamped grid cell.
  const ownCostCount = batch.departedAt ? await batchCostEntryCount(id) : null;
  const panelTypes = await db
    .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true));
  // The clients whose cargo is on the truck NOW — who a truck bill may name.
  const panelClients = await db
    .selectDistinct({ id: clients.id, clientCode: clients.clientCode })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(boxes.currentBatchId, id));
  const tills = await tillOptionsFor(actor.permissions);

  return (
    <BatchCard head={head} actor={actor} active="xarajat">
      <section className="card space-y-2">
        <h2 className="text-lg font-bold">💰 {t('costs')}</h2>
        {ownCostCount === 0 && (
          <p className="text-sm font-semibold text-warn" data-testid="batch-no-costs">
            ⚠️ {t('noCostsWarn')}
          </p>
        )}
        <CostPanel
          scope="batch"
          targetId={batch.id}
          entries={costSheet.entries.map(({ entry, typeName, clientCode, partnerName, accountName }) => ({
            id: entry.id,
            typeName,
            amount: entry.amount,
            currency: entry.currency,
            amountUsd: entry.amountUsd,
            costDate: entry.costDate,
            allocationBasis: entry.allocationBasis,
            note: entry.note,
            clientCode,
            partnerName,
            ...tillView(actor.permissions, { accountId: entry.accountId, accountName, mergedExpenseId: entry.mergedExpenseId }),
          }))}
          costTypes={panelTypes}
          currencies={currencyCodes}
          clientOptions={panelClients}
          defaultCurrency={currencyCodes.includes('CNY') ? 'CNY' : 'USD'}
          canEdit={canEnter}
          today={tashkentDay()}
          canUnmerge={mayPickTill(actor.permissions)}
          tillOptions={tills}
          partnerOptions={partnerOptions}
        />
        {/* What colleagues wrote here, for a reader who sees only their
            own entries: the TYPES and never a sum, so «Rastamojka» is not
            typed a second time by somebody who cannot see it (Q19 D1). */}
        {costSheet.others.count > 0 && (
          <p className="text-xs text-ink-500" data-testid="cost-others">
            🔒 {tcost('othersEntered', { count: costSheet.others.count, types: costSheet.others.types.join(' · ') })}
          </p>
        )}
        {costSheet.totalUsd !== null && costSheet.entries.length > 0 && (
          <p className="border-t border-line pt-2 text-sm">
            <b>Σ ${costSheet.totalUsd}</b>
            {costSheet.usdPerKg !== null && (
              <span className="text-ink-700">
                {' '}· ${costSheet.usdPerKg}/kg · ${costSheet.usdPerM3}/m³ ({costSheet.boxCount} 📦,{' '}
                {costSheet.kg} kg, {costSheet.m3} m³)
              </span>
            )}
            {costSheet.unconverted > 0 && (
              <span className="ml-2 rounded bg-orange-100 px-1.5 text-xs font-semibold text-orange-800">
                ⚠️ {costSheet.unconverted}
              </span>
            )}
          </p>
        )}
      </section>

      <section className="space-y-3" data-testid="receipt-grid-section">
        <h2 className="text-lg font-bold">🧾 {t('receiptGridTitle')}</h2>
        <p className="text-sm text-ink-500">{t('receiptGridHint')}</p>
        {gridRows.length === 0 ? (
          <p className="card text-sm text-ink-500">{tc('empty')}</p>
        ) : (
          <ReceiptCostGrid
            batchId={id}
            rows={gridRows}
            types={types}
            existing={existing}
            batchScope={Object.fromEntries(batchScope)}
            dealLinks={canWriteDeal(actor.permissions)}
            currencies={currencyCodes}
            defaultCurrency="USD"
            today={tashkentDay()}
            canEdit={canEnter}
            partners={partnerOptions}
            tills={tills}
            ownOnly={sight.ownOnly !== null}
          />
        )}
      </section>
    </BatchCard>
  );
}

/**
 * The truck's lots folded into one row per prixod, in the lots' own order
 * (client code, unclaimed last, then prixod number). The row's photo is its
 * first lot's goods, else the carton — this screen asks «what is it», which
 * is /stock's question and not the loader's.
 */
function groupLotsByReceipt(lots: Awaited<ReturnType<typeof batchLots>>): GridReceiptRow[] {
  const rows = new Map<string, GridReceiptRow>();
  for (const lot of lots) {
    let row = rows.get(lot.receiptId);
    if (!row) {
      row = {
        receiptId: lot.receiptId,
        number: lot.receiptNumber,
        clientCode: lot.clientCode,
        marking: lot.marking,
        dealId: lot.dealId,
        dealCode: lot.dealCode,
        photoId: null,
        boxes: 0,
        kg: 0,
        m3: 0,
        lots: [],
      };
      rows.set(lot.receiptId, row);
    }
    row.photoId ??= lot.goodsPhotoId ?? lot.boxPhotoId;
    row.boxes += lot.onBatch;
    row.kg = Math.round((row.kg + lot.kg) * 10) / 10;
    row.m3 = Math.round((row.m3 + lot.m3) * 1000) / 1000;
    row.lots.push({
      letter: lot.letter,
      name: lot.productNameRu ? `${lot.productNameZh} · ${lot.productNameRu}` : lot.productNameZh,
      onBatch: lot.onBatch,
      lotBoxCount: lot.lotBoxCount,
    });
  }
  return [...rows.values()];
}
