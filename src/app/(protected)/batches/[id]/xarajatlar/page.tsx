import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { payerView } from '@/modules/wms/partners/staff';
import { getActor } from '@/modules/platform/rbac/authorize';
import { batchCostEntryCount, batchCostSheet, batchScopeCostByType, receiptCostMatrix } from '@/modules/wms/costing/service';
import { batchLots } from '@/modules/wms/batches/lots';
import { mayOpenBatchCard, mayOpenBatchCosts } from '@/modules/wms/batches/card-door';
import { loadBatchHead } from '@/modules/wms/batches/card-head';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { CostPanel } from '@/components/cost-panel';
import { ReceiptCostGrid, type GridReceiptRow } from '../receipt-cost-grid';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { costSightFor, tillView } from '@/modules/wms/costing/cost-sight';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { BatchCard, batchTabMetadata } from '../batch-card';
import { mayEnterBatchCost } from '@/modules/wms/costing/cost-door';
import { costPanelOptions } from '@/modules/wms/costing/cost-entry';
import { explainFreightBills } from '@/modules/wms/costing/freight-offer';

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
  // The ADD door (SARFLAR §8.5), the one the action asks: a cancelled truck
  // keeps its 🗑 (the void stays `canEnter`) and loses every «＋».
  const mayAdd = mayEnterBatchCost(actor, batch);

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
  // ONE reader for what the panel and the grid offer (SARFLAR §2), shared
  // with the general entry page: the types in one order (a column order the
  // database happens to return can move between two sessions typing the same
  // sheet, #524), and — only for a reader who may add — the counterparties,
  // the kassas and the truck's RIDERS, which unloading does not empty.
  const options = await costPanelOptions(actor, id, { mayEnter: mayAdd });
  const types = options.types;
  const currencyCodes = options.currencies;
  const partnerOptions = options.partners;

  // Q19 (owner, 2026-09-25): the VED lists only the entries he typed, and
  // the truck's total and per-unit cost come back null for him — everybody's
  // entries beside this truck's kg/m³ are the tannarx one division away.
  const costSheet = await batchCostSheet(id, costSightFor(actor));
  // Each freight bill explained over its own copy (docs/YOLKIRA-TAQSIMOT.md §7.4).
  const freightRows = await explainFreightBills(
    costSheet.entries.map(({ entry, hasShare }) => ({ ...entry, hasShare })),
    actor,
  );
  // «Rasxodini yozmading» (owner, 2026-09-24): a truck that has LEFT with
  // nothing attributed to it — no bill of its own, no stamped grid cell.
  const ownCostCount = batch.departedAt ? await batchCostEntryCount(id) : null;
  const tills = options.tills;

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
          entries={costSheet.entries.map(({ entry, typeName, clientCode, partnerName, partnerIsStaff, accountName }) => ({
            id: entry.id,
            typeName,
            amount: entry.amount,
            currency: entry.currency,
            amountUsd: entry.amountUsd,
            costDate: entry.costDate,
            allocationBasis: entry.allocationBasis,
            note: entry.note,
            clientCode,
            freight: freightRows.get(entry.id) ?? null,
            // A truck's own bill; the per-prixod grid's stamped cells are not (E2).
            rebasable: entry.scope === 'batch',
            costTypeId: entry.costTypeId,
            ...payerView(actor.permissions, { partnerName, partnerIsStaff }),
            ...tillView(actor.permissions, { accountId: entry.accountId, accountName, mergedExpenseId: entry.mergedExpenseId }),
          }))}
          costTypes={types}
          currencies={currencyCodes}
          clientOptions={options.clients}
          defaultCurrency={currencyCodes.includes('CNY') ? 'CNY' : 'USD'}
          // A truck's bill is the road unless said otherwise (§8.5) — the same
          // default /kiritish proposes for the same truck.
          defaultTypeCode="freight"
          canVoid={canEnter}
          canAdd={mayAdd}
          today={tashkentDay()}
          canUnmerge={mayPickTill(actor.permissions)}
          tillOptions={tills}
          partnerOptions={partnerOptions}
          freight={options.freight}
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
            canEdit={mayAdd}
            partners={partnerOptions}
            tills={tills}
            ownOnly={sight.ownOnly !== null}
            freightTypeIds={options.freight?.typeFlags.freightTypeIds ?? []}
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
