import Link from 'next/link';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  costTypes,
  currencies,
  deals,
  receiptLots,
  receipts,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { CostPanel } from '@/components/cost-panel';
import { getActor } from '@/modules/platform/rbac/authorize';
import { HistoryTab } from '@/components/history-tab';
import { PhotoGallery } from '@/components/photo-gallery';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { VoidReceiptForm } from './void-form';
import { AnnulReceiptForm } from './annul-form';
import { annulPreview, mayAnnul } from '@/modules/wms/receipts/annul';
import { AssignClient } from './assign-client';
import { LotEditForm } from './lot-edit-form';
import { CompositionPanel } from './composition-panel';
import {
  compositionsFor,
  isPaperDocument,
  lotTrucksFor,
  mayWriteComposition,
  oneGoodPrefillFor,
} from '@/modules/wms/receipts/lot-composition';
import { isStale, tarkibLabel } from '@/modules/wms/receipts/composition-math';
import { MarkLostForm, type LostBoxOption } from './mark-lost-form';
import { DealLink } from './deal-link';
import { ownDealOf } from '@/modules/wms/finance/truck-deal';
import { receiptHasCompensation } from '@/modules/wms/finance/compensation-follow';
import { receiptPickupInfo, stopOptionsForWarehouse } from '@/modules/wms/pickups/service';
import { ReceiptPickupControl } from '@/app/(protected)/zavod/pickup-forms';
import { CalcLink } from './calc-link';
import { calcLinkOptions } from '@/modules/wms/calc/link';
import { calcControlScopeFor } from '@/modules/wms/calc/control-scope';
import { MoveReceipt } from './move-receipt';
import { ReturnToSender } from './return-to-sender';
import { canWriteDeal, openDealsForClient, withCargo } from '@/modules/wms/deals/service';
import { mayEditDealTerms } from '@/modules/wms/deals/door';
import { BackLink } from '@/components/back-link';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { PrintLabels } from '@/components/print-labels';
import { TasksPanel } from '@/components/tasks-panel';
import { mayReadReceipt } from '@/modules/wms/receipts/read-door';
import { mayAttachReceiptFile } from '@/modules/wms/receipts/files-door';
import { DOCUMENT_PHOTO } from '@/components/photo-grades';
import { listPartners } from '@/modules/wms/partners/service';
import { maySeeStaffMoney, payerView } from '@/modules/wms/partners/staff';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { tillOptionsFor } from '@/modules/wms/costing/till-props';
import { costSightFor, tillView } from '@/modules/wms/costing/cost-sight';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { costEntriesFor } from '@/modules/wms/costing/service';
import { lotQrState } from '@/modules/wms/labels/qrless';
import { canEditReceipt, mayCorrectReceived, mayEditReceiptAt, mayFlipQrSkip, qrSwitchPlaces } from '@/modules/wms/receipts/edit';
import { QrSkipToggle } from './qr-skip-toggle';
import { dayIn } from '@/modules/platform/time/tashkent';
import { isBackdated, receivedDayBounds } from '@/modules/wms/receipts/received-day';
import { palletDoorsFor } from '@/modules/wms/crates/service';
import { ReceivedEditForm } from './received-edit-form';
import { canLogInSql } from '@/modules/platform/users/login';
import { lotCheckViewsFor, mayCheckLot, type LotCheckView } from '@/modules/wms/receipts/lot-check';
import { telegramPhoneUrl } from '@/modules/platform/telegram/map-link';
import { LotCheckPanel } from './lot-check-panel';
import { clientAskCardFor } from '@/modules/wms/receipts/client-confirm';
import { ClientAskPanel } from './client-ask-panel';
import { isServerBehind } from '@/modules/platform/db/errors';
import { mayReadThread } from '@/modules/wms/crm/thread-door';
import { threadReadMarks } from '@/modules/wms/crm/thread';
import { CargoThread } from '@/components/cargo-thread';
import { ThreadSeen } from '@/components/thread-seen';
import { receiptLoadView } from '@/modules/wms/ftl/read';
import { mayRevertFtl } from '@/modules/wms/ftl/door';
import { LoadModeBlock } from './load-mode-block';
import { calcWorkspaceHref } from '@/modules/wms/calc/card-door';
import { Panel } from '@/components/panel';
import { receiptTotals, trimMeasure } from '@/modules/wms/receipts/card-totals';

export default async function ReceiptDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tarkib?: string; from?: string; qaytish?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const { id } = await params;
  const { tarkib: tarkibLot, from: fromBatch, qaytish } = await searchParams;

  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, id) });
  if (!receipt) notFound();
  /**
   * The LIST is warehouse-filtered and this was not, so a uuid from a
   * colleague's link opened another warehouse's cargo.
   *
   * …OR the cargo is standing where the reader is (round 90's rule, now in
   * one home). `warehouse_id` is where the goods were RECEIVED and it never
   * moves, so without this half a Kashgar prixod whose cartons are now in
   * Andijan is unopenable by the Andijan operator — who can already see its
   * PHOTOGRAPHS, because the attachment gate learned exactly this rule in
   * round 90 and the page it hangs on did not. It is what makes the handover
   * screen's «egasi aniqlanmagan yuk» row a door rather than a dead end
   * (owner's 3.2a): naming the client is the one thing that must happen
   * there, and the person standing over the cargo is who knows.
   */
  if (!(await mayReadReceipt(actor, { id, warehouseId: receipt.warehouseId }))) notFound();

  const t = await getTranslations('receipts');
  const tf = await getTranslations('ftl');
  // LTL / FTL (0135). null = the server is one migration behind: nothing drawn.
  const loadView = await receiptLoadView(id);
  const ftlOffice = mayRevertFtl(actor);
  const tAny = await getTranslations();
  const tc = await getTranslations('common');
  const ta = await getTranslations('annul');
  const ts = await getTranslations('stock.statuses');
  const format = await getFormatter();

  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;
  const allWarehouses = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .orderBy(asc(warehouses.code));
  const client = receipt.clientId
    ? await db.query.clients.findFirst({ where: eq(clients.id, receipt.clientId) })
    : null;
  const lots = await db
    .select()
    .from(receiptLots)
    .where(eq(receiptLots.receiptId, id))
    .orderBy(asc(receiptLots.seq));

  const lotIds = lots.map((l) => l.id);
  const photoRows = lotIds.length
    ? await db
        .select({ id: attachments.id, fileName: attachments.fileName, entityId: attachments.entityId })
        .from(attachments)
        .where(inArray(attachments.entityId, lotIds))
    : [];
  const photosByLot = new Map<string, { id: string; fileName: string }[]>();
  for (const photo of photoRows) {
    photosByLot.set(photo.entityId, [...(photosByLot.get(photo.entityId) ?? []), photo]);
  }

  // The one reader every cost card lists from (Q19 D1): the VED reads the
  // entries he typed and the TYPES of the rest, never their amounts.
  const { entries: costs, others: costOthers } = await costEntriesFor({ receiptId: id }, costSightFor(actor));
  const tcost = await getTranslations('costing');
  const othersLine =
    costOthers.count > 0 ? (
      <p className="text-xs text-ink-500" data-testid="cost-others">
        🔒 {tcost('othersEntered', { count: costOthers.count, types: costOthers.types.join(' · ') })}
      </p>
    ) : null;
  const canEnterCosts = actor.permissions.has('costs.enter_receipt');
  const costMeta = canEnterCosts
    ? {
        types: await db
          .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
          .from(costTypes)
          .where(eq(costTypes.active, true)),
        currencies: (
          await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
        ).map((c) => c.code),
      }
    : null;

  const receiptFileRows = await db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      contentType: attachments.contentType,
      kind: attachments.kind,
      createdAt: attachments.createdAt,
      uploadedBy: attachments.uploadedBy,
    })
    .from(attachments)
    .where(and(eq(attachments.entityType, 'receipt'), eq(attachments.entityId, id)));
  const receiptFiles = receiptFileRows.map(({ id: fileId, fileName, contentType, kind }) => ({
    id: fileId,
    fileName,
    contentType,
    kind,
  }));
  // The reader's OWN uploads carry a ✕ whoever they are (0146): the delete
  // door has always let an uploader take their file back, and a seller who
  // sent the wrong invoice through the bot must not need the logist for it.
  const ownFileIds = receiptFileRows.filter((f) => f.uploadedBy === actor.id).map((f) => f.id);

  // Lot tarkibi (docs/LOT-TARKIBI.md §8): the paper compositions, the trucks
  // whose papers already went, and who may state one. The page has already
  // passed `mayReadReceipt`; the writer is the Bojxona tab's audience.
  const compositions = await compositionsFor(lotIds);
  const lotTrucks = await lotTrucksFor(db, lotIds);
  const mayCompose = mayWriteComposition(actor.permissions);
  // What every list calls a composed lot (docs/TARKIB-TUZATISH.md §3).
  const zhOf = new Map(lots.map((l) => [l.id, l.productNameZh]));
  const shownRu = new Map(
    [...compositions].flatMap(([lotId, c]) => {
      const label = tarkibLabel(c.lines, zhOf.get(lotId) ?? '');
      return label === null ? [] : [[lotId, label] as const];
    }),
  );
  // «Bitta tovar» — read only for the writer: the receipt card is opened by
  // warehouse staff too, and the prefill carries the memory's code.
  const oneGood = mayCompose && receipt.status === 'confirmed' ? await oneGoodPrefillFor(receipt, lots) : new Map();
  const citedDocs = new Set(
    [...compositions.values()].map((c) => c.attachment?.id).filter((id): id is string => id !== undefined),
  );
  const paperDocs = receiptFileRows
    .filter((f) => isPaperDocument(f, receipt))
    .map((f) => ({ id: f.id, fileName: f.fileName, removable: f.uploadedBy === actor.id && !citedDocs.has(f.id) }));
  // «Yuk ma'lumoti tekshirildi» (docs/YUK-TEKSHIRUV.md §6): every lot's
  // face from the lists' own sentence, and who may tick. Caught: the table
  // is minted this release (#472) — a card without its faces beats an error
  // page on a half-applied deploy.
  const lotChecks = await lotCheckViewsFor(lotIds).catch((err) => {
    console.warn('[lot-check] views unavailable', err instanceof Error ? err.message : err);
    return new Map<string, LotCheckView>();
  });
  const mayCheck = mayCheckLot(actor.permissions) && receipt.status === 'confirmed';
  // «📨 Mijozdan so'rash» (0144): ONE block for the prixod — the question is
  // one message about every lot. Null on a server whose 0144 has not landed,
  // for a reader who may not tick, and for cargo with no client: nothing of
  // it is drawn then. The button needs a linked chat and a lot still worth
  // asking about (his 4a); the last question's fate and a multi-lot dispute
  // are shown wherever the cargo stands.
  const askCard = mayCheck ? await clientAskCardFor(id, receipt.clientId) : null;
  const askDisputes = lots
    .map((lot) => ({ lotId: lot.id, answer: lotChecks.get(lot.id)?.client ?? null }))
    .filter((row) => row.answer?.verdict === 'no' && row.answer.ofOwner)
    .map((row) => ({ lotId: row.lotId, token: row.answer!.token }));
  const anyAskable = lots.some((lot) => lotChecks.get(lot.id)?.askable === true);
  // A question still waiting, as the service judged it on the database's own
  // clock: held by Telegram, or due long ago and still here (`ClientAskStatus`).
  const askDue = askCard?.status?.dueAt ?? null;
  const askWait = askCard?.status?.wait ?? 'soon';
  // The block is mounted wherever the client's side exists; `askShow` says
  // whether it has anything to draw (it keeps its own «✅ yopildi» otherwise).
  // The system's own question (his «1 b»): drawn while held or failed, and
  // once sent only while it is the newest question the client was sent — an
  // older one under a person's later «Mijozdan so'rash» is history.
  const auto = askCard?.auto ?? null;
  const autoDrawn =
    auto !== null &&
    (auto.state !== 'sent' ||
      !askCard?.status?.deliveredAt ||
      (auto.at !== null && auto.at.getTime() > askCard.status.deliveredAt.getTime()));
  const askShow = Boolean(askCard) && (anyAskable || askCard!.status !== null || askDisputes.length > 1 || autoDrawn);
  const askFace = askCard
    ? {
        canAsk: askCard.hasChat && anyAskable,
        noChat: !askCard.hasChat && anyAskable,
        // What a question sent NOW would ask (0146): the kilos and cubic
        // metres too, once the columns that remember them exist.
        full: askCard.full,
        status: askCard.status
          ? {
              state: askCard.status.status,
              // The OFFICE clock — the page's default, and the History tab's
              // under this block. In the warehouse's zone a question that
              // went out at 14:05 Tashkent read 17:05 on a Chinese prixod: a
              // time in the reader's future, and the one the ten-minute
              // «too soon» is judged by.
              when: askCard.status.deliveredAt ? format.dateTime(askCard.status.deliveredAt, { dateStyle: 'short', timeStyle: 'short' }) : null,
              by: askCard.status.askedBy,
              failure: askCard.status.failure,
              wait: askWait,
              waitAt: askDue && askWait !== 'soon' ? format.dateTime(askDue, { timeStyle: 'short' }) : null,
            }
          : null,
        disputes: askDisputes,
        auto:
          auto && autoDrawn
            ? {
                state: auto.state,
                // The office clock, as the person's line above it.
                at: auto.at
                  ? format.dateTime(auto.at, auto.state === 'waiting' ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' })
                  : null,
                failure: auto.failure,
              }
            : null,
      }
    : null;
  // The client's phones, for the person who rings: this reader has passed
  // `mayReadReceipt`, which is the staff bot's own «cargo in reach» rule for
  // showing a phone (bot/lookup.ts `maySeePhones`).
  const checkPhones =
    mayCheck && client
      ? (Array.isArray(client.phones) ? (client.phones as unknown[]) : [])
          .filter((phone): phone is string => typeof phone === 'string' && phone.trim() !== '')
          .map((phone) => ({ tel: phone.trim(), telegram: telegramPhoneUrl(phone) }))
      : [];
  // «← Ostatka»: a worklist row on /stock opens this card carrying the way
  // back, so the next unchecked prixod is one tap away — an installed app on
  // an iPhone has no browser back button. Only a /stock address is honoured.
  const backHref = qaytish && /^\/stock(\?|$)/.test(qaytish) ? qaytish : null;
  const fromTruck =
    fromBatch && tarkibLot
      ? ((lotTrucks.get(tarkibLot) ?? []).find((truck) => truck.batchId === fromBatch) ?? null)
      : null;

  // Who settled a cost is asked HERE too (owner: «skladchilar rasxodni
  // kiritganda kim tomondan berilgani yozilmayabti»). The warehouse enters
  // most of the money on a prixod, so the choice has to be where they are.
  const partnerOptions = canEnterCosts
    ? (await listPartners({ includeStaff: maySeeStaffMoney(actor.permissions) })).map((row) => ({ id: row.id, name: row.name }))
    : [];

  const canVoid = actor.permissions.has('receipts.void') && receipt.status === 'confirmed';
  // Anulirovka — the owner's cascade (annul.ts): the ROLE decides, and the
  // preview is computed server-side; what the form posts is an id and a
  // reason, never the numbers (#514).
  // Rendered for VOIDED receipts too, deliberately: (a) the success state
  // survives the revalidate (the server re-render must not unmount the
  // component that is holding the answer), and (b) the re-press on an
  // annulled receipt is the aftermath REPAIR door (#848).
  const canAnnul = mayAnnul(actor) && receipt.status !== 'draft';
  const preview = canAnnul ? await annulPreview(id) : null;
  // «Yaroqsiz» per box (owner, 2026-08-25): only cargo standing on a shelf is
  // offerable — the service refuses the rest anyway, but a select listing a
  // box the button cannot act on is a lie in a form (#171's cousin).
  const lostOptionsByLot = new Map<string, LostBoxOption[]>();
  if (canVoid && lotIds.length) {
    const liveBoxes = await db
      .select({ id: boxes.id, lotId: boxes.lotId, shortCode: boxes.shortCode, status: boxes.status })
      .from(boxes)
      .where(
        and(
          inArray(boxes.lotId, lotIds),
          inArray(boxes.status, ['in_stock', 'planned', 'ready_for_pickup']),
        ),
      )
      .orderBy(asc(boxes.seqInLot));
    for (const b of liveBoxes) {
      lostOptionsByLot.set(b.lotId, [
        ...(lostOptionsByLot.get(b.lotId) ?? []),
        { boxId: b.id, shortCode: b.shortCode, status: b.status },
      ]);
    }
  }
  const canPrint = actor.permissions.has('receipts.create');
  const canEdit = actor.permissions.has('receipts.edit') && receipt.status === 'confirmed';
  // «QR yopishtirilmadi» (0112): per lot, what the ordinary sheet would carry,
  // where the stickerless cartons stand, and whether the switch may move.
  const tq = await getTranslations('qrsiz');
  const tbusy = await getTranslations('countAccept');
  const qrState = await lotQrState(lotIds, actor);
  const anyPrintable = lots.some((lot) => (qrState.get(lot.id)?.printable ?? 0) > 0);
  // The action's door is `receipts.edit` AT the prixod's warehouse; the page
  // asks the same, or a destination-scoped person is drawn a switch that
  // answers «forbidden» (review of the fixes, cargo-r5).
  const mayToggleQr =
    canEdit && mayEditReceiptAt(actor, receipt.warehouseId) && canEditReceipt(actor, receipt, warehouse.timezone);
  // The switch is drawn only where the service would let it move — the same
  // predicate over the same places (review access-1).
  const qrFlippable = new Set(
    mayToggleQr
      ? (
          await Promise.all(
            lots.map(async (lot) =>
              mayFlipQrSkip(actor, await qrSwitchPlaces(db, lot.id, receipt.warehouseId)) ? lot.id : null,
            ),
          )
        ).filter((id): id is string => id !== null)
      : [],
  );
  const canAssign = actor.permissions.has('receipts.unclaimed.resolve') && receipt.status === 'confirmed';

  // Which job this cargo belongs to — shown, and correctable, from the cargo
  // itself. Only to somebody who may write deals: to everybody else a deal
  // code is a link into a screen they cannot open.
  const canLinkDeal = canWriteDeal(actor.permissions) && Boolean(receipt.clientId);
  // The factory truck it came off (0100): shown to everyone who opens the
  // card — the factory's phone is what a goods problem next month needs — and
  // correctable by whoever enters a truck's cost, because linking moves that
  // truck's money. Caught: the tables are minted this release (#472).
  const tp = await getTranslations('pickups');
  const pickupInfo = await receiptPickupInfo(receipt.pickupStopId).catch(() => null);
  const canLinkPickup =
    receipt.status === 'confirmed' &&
    !receipt.voidedAt &&
    // The warehouse fence is the ACTION's (authorize at the receipt's
    // warehouse): this page states no scope rule of its own.
    actor.permissions.has('costs.enter_batch');
  const pickupOptions = canLinkPickup
    ? await stopOptionsForWarehouse(receipt.warehouseId).catch(() => [])
    : [];
  const linkedDeal = receipt.dealId
    ? ((await db.query.deals.findFirst({ where: eq(deals.id, receipt.dealId) })) ?? null)
    : null;
  // «The prixod's deal» is the client's OWN (`ownDealOf`, finance/truck-deal.ts
  // — the rule the seller's «Prixod keldi» message reads the state by): a
  // client correction leaves `deal_id` on the old client's job, and the block
  // its «🔗 Bitim biriktirish» button opens must not print that job as linked.
  const ownDeal =
    linkedDeal && receipt.clientId && ownDealOf({ dealId: linkedDeal.id, dealClientId: linkedDeal.clientId }, receipt.clientId)
      ? linkedDeal
      : null;
  const foreignDeal = linkedDeal && !ownDeal ? linkedDeal : null;
  const dealOptions = canLinkDeal ? await openDealsForClient(receipt.clientId!) : [];
  // 0105: a compensation for this prixod's lost cargo follows it to another
  // deal — said under the picker BEFORE the press. Caught: the column is
  // minted this release (#472).
  const hasCompensation = canLinkDeal ? await receiptHasCompensation(db, id).catch(() => false) : false;
  // A deal that has since been won or lost is not in the open list, and
  // hiding it would hide the very mistake being corrected.
  // Phase E1: which CALCULATION priced this cargo. A separate door from the
  // deal picker above it and a separate audience — the deal is a sales fact,
  // the calculation is what the control screen measures.
  const mayLinkCalc = calcControlScopeFor(actor) !== 'none';
  // The calculations of the prixod's OWN deal — never of a deal a client
  // correction left it on (`ownDeal` above): a link to one of those measures
  // one customer's cargo against another customer's quote. The doors in
  // calc/link.ts refuse it too; this is what the cell offers.
  const calcOptions = mayLinkCalc ? await calcLinkOptions(ownDeal?.id ?? null) : [];
  const dealChoices =
    ownDeal && !dealOptions.some((d) => d.id === ownDeal.id)
      ? [
          // The deal this prixod is ON, even once it has left the open list —
          // hiding it would hide the mistake being corrected. It goes through
          // the same composer as the rest: it is the SELECTED option, so a
          // blank cargo line beside filled ones would read as a broken row.
          ...(await withCargo([ownDeal])),
          ...dealOptions,
        ]
      : dealOptions;

  // The office receipt (0112, Q9 b): who physically received it, who typed
  // it, and the real day — printed when any of them differs from «the person
  // who pressed, on the day they pressed», which is what every older row means.
  const to = await getTranslations('ofis');
  const backdated = isBackdated(receipt);
  const office = Boolean(receipt.receivedByUserId || receipt.receivedByName || backdated);
  const people = office
    ? await db
        .select({ id: users.id, name: users.fullName })
        .from(users)
        .where(inArray(users.id, [receipt.createdBy, ...(receipt.receivedByUserId ? [receipt.receivedByUserId] : [])]))
    : [];
  const nameOf = (userId: string | null) => people.find((person) => person.id === userId)?.name ?? '—';
  const receivedDay = dayIn(receipt.receivedAt, warehouse.timezone);
  // The correction door: the office, on the day the prixod was typed.
  const canCorrectReceived = mayCorrectReceived(actor, receipt, warehouse.timezone);
  const warehouseReceivers = canCorrectReceived
    ? await db
        .select({ id: users.id, name: users.fullName })
        .from(userWarehouses)
        .innerJoin(users, eq(users.id, userWarehouses.userId))
        .where(and(eq(userWarehouses.warehouseId, receipt.warehouseId), canLogInSql()))
        .orderBy(asc(users.fullName))
    : [];
  // «🧱 Palet qilish» per lot and warehouse (0112, Q10 d) — ONE grouped query.
  const palletDoors = receipt.status === 'confirmed' ? await palletDoorsFor(actor, lotIds) : [];

  // «❓ Savol-javob» (round 2, 0129 — E6 c, E7 b): the prixod's staff thread,
  // for the office and the staff of the warehouse where the cargo stands NOW.
  // The thread's door, not the card's: the card admits every seller and the
  // receiving warehouse for ever, the thread neither. A database a release
  // behind keeps the rest of the card.
  const cargoRef = { kind: 'receipt' as const, id };
  let cargoThread = false;
  try {
    cargoThread = await mayReadThread(actor, cargoRef);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
  }
  const readMarks = await threadReadMarks([...(cargoThread ? [cargoRef] : [])]);
  const tth = await getTranslations('threads');

  // The card's layout (docs/PRIXOD-KARTA.md §7): what each zone holds for
  // THIS reader. Every condition here is one a block has always had — the
  // round moved blocks, it opened and closed no door.
  const tl = await getTranslations('lotCheck');
  const totals = receiptTotals(lots);
  const showLoadRow = Boolean(loadView && (ftlOffice || (loadView.sellerId === actor.id && loadView.mode === 'ltl')));
  // …and drawn while a link stands even with nothing to offer, or a link left
  // over from another deal could never be cleared from the card.
  const showCalcRow = mayLinkCalc && (calcOptions.length > 0 || receipt.calcRequestId !== null);
  const showPickupRow = Boolean(pickupInfo || canLinkPickup);
  // Two independent stacks, never a 2×2 grid: «Hisob» hangs under the
  // «Bitim» whose calculations it lists, and a tall «Yuk turi» cannot open a
  // hole beside a short neighbour.
  const tiesLeft = canLinkDeal || showCalcRow;
  const tiesRight = showLoadRow || showPickupRow;
  // Who may ADD a file here: every reader of a confirmed, live prixod — the
  // bot's «📎 Fayl qo‘shish» rule, ONE predicate for both doors (the owner's
  // «4 b» of 2026-11-12, docs/PRIXOD-JAVOBLAR.md §3). Not `canEdit`: that one
  // also draws the ✏️ lot form, ✕ on lot photos and ✕ on everybody's files —
  // dead or wrong controls for a seller (#531).
  const mayAttach = mayAttachReceiptFile(receipt);
  // No card for a reader who cannot attach when there is nothing to list —
  // it was a heading over nothing (a voided prixod is the case left).
  const showFiles = mayAttach || receiptFiles.length > 0;
  const showCosts = costMeta !== null || costs.length > 0 || othersLine !== null;
  // What «Boshqa amallar» holds for this reader, named on its closed line:
  // a manager looking for «Bekor qilish» must not have to open a fold called
  // «other» to find out whether it is in there.
  const moreWords = [
    ...(canAssign && client ? [t('changeClient')] : []),
    ...(canVoid ? [t('moveReceipt')] : []),
    ...(canVoid && !canAnnul ? [t('voidBtn')] : []),
    ...(canAnnul && preview ? [ta('open')] : []),
  ];
  // A label that is inline on a phone («Mijoz: …», the 87 px card this
  // summary replaces) and a small caption above its value from `lg`.
  const factLabel =
    'font-semibold lg:mb-0.5 lg:block lg:text-2xs lg:font-bold lg:uppercase lg:tracking-[0.08em] lg:text-ink-500';

  return (
    // A flex column so that ONE class can reorder it for a phone: under `md`
    // the ties and everything after the lots carry `max-md:order-1`, and the
    // card reads summary → cargo → the rest. With the ties above the lots a
    // seller's first screen showed no cargo at all (measured: the first lot
    // at y≈725 of 741). DOM order is the desktop's.
    <div className="flex flex-col gap-4">
      <div>
        {backHref ? (
          <BackLink href={backHref} label={tAny('stock.title')} />
        ) : (
          <BackLink href="/receipts" label={t('title')} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">
          <span className="font-mono">{receipt.number}</span>
        </h1>
        <span
          className={`rounded px-2 py-0.5 text-sm font-semibold ${
            receipt.status === 'confirmed'
              ? 'bg-good/15 text-good'
              : receipt.status === 'voided'
                ? 'bg-bad/15 text-bad'
                : 'bg-surface-sunken'
          }`}
        >
          {t(`statuses.${receipt.status}`)}
        </span>
        {/* LTL / FTL (0135): the «Yuk turi» row below for whoever the door
            lets act — the office, or this prixod's own seller (FTL only, his
            2a); a chip for everybody else when it is FTL, nothing when it is
            LTL. The chip was a paragraph of its own between two cards. */}
        {!showLoadRow && loadView?.mode === 'ftl' && (
          <span className="chip chip-neutral" data-testid="receipt-ftl-chip">
            🚛 {tf('ftlLong')}
          </span>
        )}
        {canPrint && receipt.status === 'confirmed' && anyPrintable && (
          <div className="ml-auto w-44">
            <PrintLabels href={`/print/receipts/${id}`} label={t('reprint')} />
          </div>
        )}
      </div>

      {/* 1. What it is: whose, how much, when and where. ONE card. */}
      <section className="card !p-3 text-sm" data-testid="receipt-summary">
        <div className="grid gap-x-6 gap-y-1 lg:grid-cols-3">
          <div className="min-w-0">
            <p className="[overflow-wrap:anywhere]">
              <span className={factLabel}>
                {t('client')}
                <span className="lg:hidden">: </span>
              </span>
              {client ? (
                <>
                  <span className="font-mono font-extrabold text-brand-700">{client.clientCode}</span>
                  <span className="font-semibold"> — {client.name}</span>
                </>
              ) : (
                <>
                  <span className="font-bold text-warn">❓ {t('unclaimed')}</span>
                  {receipt.unclaimedMarking && (
                    <>
                      {' '}
                      {/* A marking is up to fifty characters with no space in
                          it (a factory's own code) — it must break, or it
                          widens the page: 424 px at 360 with thirty. */}
                      <span className="rounded bg-warn/10 px-2 py-0.5 font-mono font-bold text-warn [overflow-wrap:anywhere]">
                        {receipt.unclaimedMarking}
                      </span>
                    </>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="min-w-0">
            {/* NEW on the card: three lots were three sums in the reader's
                head. From the lots already read, in integer units. */}
            <p data-testid="receipt-total" data-boxes={totals.boxes} data-kg={totals.kg} data-m3={totals.m3}>
              <span className={factLabel}>
                {t('total')}
                <span className="lg:hidden">: </span>
              </span>
              <span className="font-semibold">
                {t('lotsCount', { n: totals.lots })} · {totals.boxes} 📦 · {totals.kg} kg · {totals.m3} m³
              </span>
            </p>
          </div>
          <div className="min-w-0 space-y-0.5">
            <p data-testid="receipt-received-date" data-day={receivedDay}>
              <span className={factLabel}>
                {t('date')}
                <span className="lg:hidden">: </span>
              </span>
              {/* A back-dated prixod carries a DAY: its noon is a filing
                  convention, printed in the warehouse's own zone. */}
              {backdated
                ? format.dateTime(receipt.receivedAt, { dateStyle: 'medium', timeZone: warehouse.timezone })
                : format.dateTime(receipt.receivedAt, { dateStyle: 'medium', timeStyle: 'short' })}{' '}
              · {warehouse.code}
            </p>
            {office && (
              <>
                <p data-testid="receipt-received-by" className="[overflow-wrap:anywhere]">
                  👤 <span className="font-semibold">{to('receivedBy')}: </span>
                  {receipt.receivedByName ?? nameOf(receipt.receivedByUserId ?? receipt.createdBy)}
                </p>
                <p data-testid="receipt-entered-by" className="text-xs text-ink-500 [overflow-wrap:anywhere]">
                  ✍️ {to('enteredBy')}: {nameOf(receipt.createdBy)} ·{' '}
                  {format.dateTime(receipt.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
              </>
            )}
            {canCorrectReceived && (
              <div className="pt-1">
                <ReceivedEditForm
                  receiptId={id}
                  day={receivedDay}
                  bounds={receivedDayBounds(receipt.createdAt, warehouse.timezone)}
                  receiver={
                    receipt.receivedByName
                      ? { kind: 'name', name: receipt.receivedByName }
                      : receipt.receivedByUserId
                        ? { kind: 'user', userId: receipt.receivedByUserId }
                        : null
                  }
                  me={{ id: actor.id, name: actor.fullName }}
                  receivers={warehouseReceivers}
                />
              </div>
            )}
          </div>
        </div>
        {receipt.sourceNote && (
          <p className="mt-2 border-t border-line pt-2 text-ink-700 [overflow-wrap:anywhere]">📝 {receipt.sourceNote}</p>
        )}
        {receipt.voidReason && (
          <p className="mt-2 border-t border-line pt-2 font-semibold text-bad [overflow-wrap:anywhere]">
            {t('voidReason')}: {receipt.voidReason}
          </p>
        )}
      </section>

      {/* 1a. Nobody's cargo: naming its owner is the one job this card has
          (his 3.2a — the handover screen's «egasi aniqlanmagan yuk» row is a
          door to exactly this), so it stays OPEN and sits at the top. On a
          claimed prixod the same form is a correction and lives in «Boshqa
          amallar». */}
      {canAssign && !client && (
        <section className="card space-y-3 border-warn/40 !p-3" data-testid="receipt-owner">
          <AssignClient receiptId={id} current={null} />
          <ReturnToSender receiptId={id} />
        </section>
      )}

      {/* 2. What it is tied to — ONE card where there were four. */}
      {(tiesLeft || tiesRight) && (
        <section
          className={`card grid gap-x-6 gap-y-3 !p-3 max-md:order-1 lg:items-start ${
            tiesLeft && tiesRight ? 'lg:grid-cols-2' : ''
          }`}
          data-testid="receipt-links"
        >
          {tiesLeft && (
            <div className="min-w-0 divide-y divide-line [&>*:first-child]:pt-0 [&>*:last-child]:pb-0 [&>*]:py-3">
              {canLinkDeal && (
                <DealLink
                  // Keyed on the STORED facts it draws: a client correction in
                  // «Boshqa amallar» revalidates this page without remounting
                  // the cell, and its select kept the old deal as its state —
                  // «Saqlash» over «— uzish» then sent that deal back and
                  // nothing happened (the merged card's review, XF-1).
                  key={`deal:${receipt.clientId ?? ''}:${receipt.dealId ?? ''}`}
                  receiptId={id}
                  current={ownDeal ? { id: ownDeal.id, code: ownDeal.code } : null}
                  options={dealChoices}
                  hasCompensation={hasCompensation}
                  foreign={foreignDeal ? { code: foreignDeal.code } : null}
                  // The seller's «🔗 Bitim biriktirish» button outlives the prixod it
                  // was sent about: a wrong prixod is voided and received again, and
                  // the button under the FIRST message still opens this cell — with
                  // the void's only marks (the status chip, the reason) scrolled
                  // under the sticky bar. So the cell says it itself.
                  voided={receipt.status === 'voided'}
                  newDealHref={
                    // Only for a CONFIRMED prixod — the form refuses any other
                    // (`bornWithVerdict`), and a link to a refusal is a dead end.
                    !ownDeal && receipt.status === 'confirmed' && mayEditDealTerms(actor.permissions)
                      ? `/bitimlar/new?client=${receipt.clientId}&prixod=${id}`
                      : null
                  }
                />
              )}
              {showCalcRow && (
                <CalcLink
                  key={`calc:${ownDeal?.id ?? ''}:${receipt.calcRequestId ?? ''}`}
                  receiptId={id}
                  currentId={receipt.calcRequestId}
                  currentHref={calcWorkspaceHref(actor, receipt.calcRequestId)}
                  confirmed={receipt.calcLinkConfirmedAt !== null}
                  options={calcOptions.map((o) => ({
                    requestId: o.requestId,
                    section: o.section,
                    sealedAt: o.sealedAt.toISOString().slice(0, 10),
                    volumeM3: o.volumeM3,
                    weightKg: o.weightKg,
                  }))}
                />
              )}
            </div>
          )}
          {tiesRight && (
            <div
              className={`min-w-0 divide-y divide-line [&>*:first-child]:pt-0 [&>*:last-child]:pb-0 [&>*]:py-3 ${
                tiesLeft ? 'max-lg:border-t max-lg:border-line max-lg:pt-3' : ''
              }`}
            >
              {showLoadRow && loadView && <LoadModeBlock receiptId={id} view={loadView} office={ftlOffice} />}
              {showPickupRow && (
                <div className="space-y-1.5 text-sm" data-testid="receipt-pickup">
                  <p className="section-title">🏭 {tp('title')}</p>
                  {pickupInfo ? (
                    <p className="[overflow-wrap:anywhere]">
                      <Link href={`/zavod/${pickupInfo.pickupId}`} className="font-mono text-brand-700 underline">
                        {pickupInfo.code}
                      </Link>{' '}
                      · {pickupInfo.seq}. {pickupInfo.factoryName}
                      {pickupInfo.factoryPhone && (
                        <>
                          {' '}
                          ·{' '}
                          <a className="text-brand-700 underline" href={`tel:${pickupInfo.factoryPhone}`}>
                            {pickupInfo.factoryPhone}
                          </a>
                        </>
                      )}
                      {pickupInfo.factoryWechat && ` · WeChat: ${pickupInfo.factoryWechat}`}
                    </p>
                  ) : (
                    // The cell's anatomy is label → value → control, so the
                    // value line stays (the select beside «Bitim» must start
                    // where this one does) — but as a dash: the row is drawn
                    // without a trip only for whoever may tie one, and their
                    // select already says «biriktirilmagan» in its empty option.
                    <p className="text-ink-500">—</p>
                  )}
                  {canLinkPickup && (
                    <ReceiptPickupControl
                      receiptId={id}
                      currentStopId={receipt.pickupStopId}
                      currentClosed={pickupInfo?.status === 'closed'}
                      options={[
                        ...(pickupInfo && !pickupOptions.some((o) => o.stopId === pickupInfo.stopId)
                          ? [
                              {
                                stopId: pickupInfo.stopId,
                                seq: pickupInfo.seq,
                                code: pickupInfo.code,
                                status: pickupInfo.status,
                                factoryName: pickupInfo.factoryName,
                              },
                            ]
                          : []),
                        ...pickupOptions,
                      ].map((o) => ({
                        stopId: o.stopId,
                        // A closed trip may be joined from here (a void-and-redo finds
                        // its truck again) — and says so.
                        label: `${o.status === 'closed' ? '🔒 ' : ''}${o.code} · ${o.seq}. ${o.factoryName}`,
                      }))}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* 3. The cargo. */}
      <section className="space-y-3" data-testid="receipt-lots">
        <h2 className="section-title">{t('lots')}</h2>
        {askFace && <ClientAskPanel receiptId={id} face={askFace} show={askShow} />}
        {lots.map((lot) => {
          const lotQr = qrState.get(lot.id);
          const shownName = shownRu.get(lot.id) ?? lot.productNameRu;
          const qrPrints = canPrint ? (lotQr?.printableAt ?? []) : [];
          const doors = palletDoors.filter((door) => door.lotId === lot.id);
          const lostOptions = lostOptionsByLot.get(lot.id) ?? [];
          // «Empty» from the members' own conditions — the write-off draws
          // nothing by itself when no carton is offerable.
          const hasActions =
            canEdit ||
            qrFlippable.has(lot.id) ||
            qrPrints.length > 0 ||
            doors.length > 0 ||
            (canVoid && lostOptions.length > 0);
          return (
            // ONE anatomy for every lot (§7.2): what it is → what can be done
            // to it → its two papers. `space-y-2` owns the spacing; the
            // members bring no margins of their own.
            <div key={lot.id} id={`lot-${lot.id}`} className="card scroll-mt-20 space-y-2 !p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-2xl font-extrabold leading-7 text-brand-700">{lot.letter}</span>
                <p className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                  <span data-testid="lot-name">
                    {lot.productNameZh}
                    {/* The Russian name SHOWN: the tarkib's, while one stands
                        (items 3-4 — the pure twin of `lotRuShownSql`, off the
                        compositions this page already holds); else the lot's own. */}
                    {shownName && <span className="font-normal text-ink-700"> ({shownName})</span>}
                  </span>
                </p>
                {/* The lot's print keeps its place and its size: the
                    operator's commonest press on a lot, and a missed tap on
                    it loads a document and opens the print dialog. */}
                {canPrint && receipt.status === 'confirmed' && (lotQr?.printable ?? 0) > 0 && (
                  <div className="w-28 shrink-0">
                    <PrintLabels
                      variant="secondary"
                      href={`/print/receipts/${id}?lotId=${lot.id}`}
                      label={lot.letter ?? ''}
                    />
                  </div>
                )}
              </div>
              {/* The client's ❌ that vetoes: the check block now follows
                  the row and the photographs, and an objection must still
                  lead the lot. On a line of its OWN, under the head: beside
                  the name it was a third unshrinkable member of that row —
                  letter, chip, print — and in Russian («Возражение клиента»)
                  the three were 2 px wider than a phone's card (362 in 360,
                  found by CI in the default locale; this container's demo
                  staff read Uzbek, where the word is shorter). */}
              {lotChecks.get(lot.id)?.client?.vetoes && (
                <p>
                  <span className="chip chip-bad" data-testid="lot-veto">
                    ❌ {tl('vetoChip')}
                  </span>
                </p>
              )}
              {/* Trimmed, never rounded (`trimMeasure`): the tarkib must sum
                  to these exactly, and «250.000» reads as a quarter of a
                  million in the default locale. */}
              <p className="text-sm text-ink-700" data-testid="lot-figures">
                {lot.boxCount} 📦 · {trimMeasure(lot.totalWeightKg)} kg · {trimMeasure(lot.totalVolumeM3)} m³
                {lot.dimsMode === 'uniform' &&
                  ` · ${lot.boxLengthCm}×${lot.boxWidthCm}×${lot.boxHeightCm} cm`}
              </p>
              {lot.note && <p className="text-sm italic text-ink-500 [overflow-wrap:anywhere]">📝 {lot.note}</p>}
              {lot.qrSkippedAt && (
                <p className="text-sm font-semibold text-warn" data-testid="lot-qrless">
                  {tq('since', { date: format.dateTime(lot.qrSkippedAt, { dateStyle: 'short' }) })}
                  {(lotQr?.qrlessLive ?? 0) > 0 && ` · ${tq('nowQrless', { n: lotQr!.qrlessLive })}`}
                  {(lotQr?.labelledLater ?? 0) > 0 && ` · ${tq('labelledLater', { done: lotQr!.labelledLater })}`}
                </p>
              )}
              {/* Everything that can be done to the LOT, in one row of one
                  button shape — it was six shapes in six places. FIXED
                  slots: a member that appears or leaves as a result of a
                  press (a pallet door emptied by a write-off) must not shift
                  the others, or React remounts them and the answer they are
                  holding is gone. Each opener is always drawn; what it opens
                  takes a line of its own under the row. */}
              {hasActions && (
                <div className="flex flex-wrap items-center gap-2" data-testid="lot-actions">
                  {canEdit && (
                    <LotEditForm
                      hasComposition={compositions.has(lot.id)}
                      // A tick or the client's own ✅ that holds now: the form
                      // says what a re-weigh does to it before the press.
                      vouched={(() => {
                        const view = lotChecks.get(lot.id);
                        return (
                          view?.person?.holds === true ||
                          (view?.client?.verdict === 'yes' && view.client.ofOwner && view.client.holds)
                        );
                      })()}
                      shownName={shownRu.get(lot.id) ?? null}
                      lot={{
                        lotId: lot.id,
                        dimsMode: lot.dimsMode,
                        productNameZh: lot.productNameZh,
                        productNameRu: lot.productNameRu ?? '',
                        boxCount: lot.boxCount,
                        boxLengthCm: lot.boxLengthCm,
                        boxWidthCm: lot.boxWidthCm,
                        boxHeightCm: lot.boxHeightCm,
                        boxWeightKg: lot.boxWeightKg,
                        totalWeightKg: lot.totalWeightKg,
                        totalVolumeM3: lot.totalVolumeM3,
                        note: lot.note,
                      }}
                    />
                  )}
                  {/* Beside «✏️»: the two corrections share one line of a phone (285 of
                      its 302 px); the stickers and the pallets follow. */}
                  {canVoid && (
                    <MarkLostForm receiptId={id} options={lostOptions} />
                  )}
                  {qrFlippable.has(lot.id) && (
                    <QrSkipToggle
                      lotId={lot.id}
                      letter={lot.letter ?? ''}
                      marked={lot.qrSkippedAt !== null}
                      canRemark={(lotQr?.labelledLater ?? 0) > 0}
                    />
                  )}
                  {qrPrints.length > 0 &&
                    qrPrints.map((at) => (
                      <a
                        key={`qr:${at.warehouseId}`}
                        href={`/print/qrsiz?warehouseId=${at.warehouseId}&lotId=${lot.id}`}
                        data-testid="lot-qr-print"
                        className="btn-secondary btn-sm"
                      >
                        {tq('printAt', { wh: at.code, n: at.n })}
                      </a>
                    ))}
                  {doors.length > 0 &&
                    doors.map((door) => (
                      <Link
                        key={`pallet:${door.warehouseId}`}
                        data-testid="lot-make-pallet"
                        href={door.href}
                        className="btn-secondary btn-sm"
                      >
                        🧱 {to('makePallet')} · {door.warehouseCode} · {door.free} 📦
                      </Link>
                    ))}
                </div>
              )}
              <PhotoGallery photos={photosByLot.get(lot.id) ?? []} deletable={canEdit} />
              {lotChecks.has(lot.id) && (
                <LotCheckPanel
                  receiptId={id}
                  lotId={lot.id}
                  face={(() => {
                    const view = lotChecks.get(lot.id)!;
                    return {
                      state: view.state,
                      askable: view.askable,
                      byDocument: view.byDocument,
                      documentStale: view.documentStale,
                      person: view.person
                        ? {
                            by: view.person.by,
                            // The OFFICE day, as the History under the card
                            // prints it: who vouched and when is the office's
                            // record, not a warehouse event. In the warehouse's
                            // zone a customer's evening press (after 21:00
                            // Tashkent) was dated tomorrow on a Chinese prixod.
                            day: tashkentDay(view.person.at),
                            token: view.person.token,
                            note: view.person.note,
                            holds: view.person.holds,
                            moved: view.person.moved,
                          }
                        : null,
                      client: view.client
                        ? {
                            verdict: view.client.verdict,
                            day: tashkentDay(view.client.at),
                            token: view.client.token,
                            holds: view.client.holds,
                            vetoes: view.client.vetoes,
                            ofOwner: view.client.ofOwner,
                            measures: view.client.measures,
                            measuresMoved: view.client.measuresMoved,
                            askedBy: view.client.askedBy,
                          }
                        : null,
                    };
                  })()}
                  seen={{
                    nameZh: lot.productNameZh,
                    // What the header above PRINTS — the tarkib's label while one
                    // is written: a person confirms the name they saw (§9.3).
                    nameRu: shownRu.get(lot.id) ?? lot.productNameRu ?? '',
                    boxCount: lot.boxCount,
                    clientId: receipt.clientId,
                    // The figures the lot's line above prints (0147): a tick
                    // vouches for the weight and the volume the person saw.
                    kg: lot.totalWeightKg,
                    m3: lot.totalVolumeM3,
                  }}
                  canWrite={mayCheck}
                  canRename={canEdit}
                  phones={checkPhones}
                />
              )}
              <CompositionPanel
                lot={{
                  id: lot.id,
                  label: `${client?.clientCode ?? receipt.unclaimedMarking ?? '?'}-${lot.letter ?? ''}`,
                  nameZh: lot.productNameZh,
                  boxCount: lot.boxCount,
                  kg: lot.totalWeightKg,
                  m3: lot.totalVolumeM3,
                }}
                receiptId={id}
                composition={(() => {
                  const c = compositions.get(lot.id);
                  return c
                    ? {
                        rev: c.rev,
                        seenBoxCount: c.seenBoxCount,
                        lines: c.lines,
                        attachment: c.attachment,
                        savedBy: c.savedBy,
                        savedDay: tashkentDay(c.savedAt),
                      }
                    : null;
                })()}
                stale={(() => {
                  const c = compositions.get(lot.id);
                  return c
                    ? isStale(c, { boxCount: lot.boxCount, kg: lot.totalWeightKg, m3: lot.totalVolumeM3 })
                    : false;
                })()}
                canWrite={mayCompose && receipt.status === 'confirmed'}
                canClearOnly={mayCompose && receipt.status !== 'confirmed'}
                oneGood={oneGood.get(lot.id) ?? null}
                documents={paperDocs}
                frozenTrucks={(lotTrucks.get(lot.id) ?? []).filter((truck) => truck.frozen).map((truck) => truck.code)}
                openOnLoad={tarkibLot === lot.id}
                from={fromTruck && tarkibLot === lot.id ? { batchId: fromTruck.batchId, code: fromTruck.code } : null}
              />
            </div>
          );
        })}
      </section>

      {/* 4. Its papers and its money — side by side from `lg`, and a card
          with no sibling takes the row. */}
      {(showFiles || showCosts) && (
        <div
          className={`grid gap-4 max-md:order-1 lg:items-start ${showFiles && showCosts ? 'lg:grid-cols-2' : ''}`}
        >
          {showFiles && (
            <section className="card min-w-0 space-y-2 !p-3" data-testid="receipt-files">
              <h2 className="text-base font-bold">{t('attachments')}</h2>
              {/* Keyed on its files: a document uploaded from the lot tarkibi
                  editor refreshes the page, and the panel re-seeds with it. */}
              <AttachmentsPanel
                key={receiptFiles.map((f) => f.id).join(',')}
                entityType="receipt"
                entityId={id}
                initial={receiptFiles}
                editable={canEdit}
                attachable={mayAttach}
                // A reader without `receipts.edit` adds PAPERS — the server stores
                // their pictures as files, never as a carton photo (§3.3) — so
                // they go at the document grade.
                photo={canEdit ? undefined : DOCUMENT_PHOTO}
                removableIds={ownFileIds}
                refreshWhenEmpty
              />
            </section>
          )}
          {showCosts && (
            <section className="card min-w-0 space-y-2 !p-3" data-testid="receipt-costs">
              <h2 className="text-base font-bold">{t('costs')}</h2>
              {costMeta ? (
                <CostPanel
                  scope="receipt"
                  freight={null}
                  targetId={id}
                  entries={costs.map(({ entry, hasShare, typeName, partnerName, partnerIsStaff, accountName }) => ({
                    id: entry.id,
                    typeName,
                    amount: entry.amount,
                    currency: entry.currency,
                    amountUsd: entry.amountUsd,
                    costDate: entry.costDate,
                    allocationBasis: entry.allocationBasis,
                    // Freight is a truck's own basis (docs/YOLKIRA-TAQSIMOT.md §4).
                    freight: null,
                    rebasable: false,
                    costTypeId: entry.costTypeId,
                    // Converted and on no box — any basis (`noShareSql`), the fact a truck's todo counts.
                    unsplit: entry.amountUsd !== null && !hasShare,
                    note: entry.note,
                    ...payerView(actor.permissions, { partnerName, partnerIsStaff }),
                    ...tillView(actor.permissions, { accountId: entry.accountId, accountName, mergedExpenseId: entry.mergedExpenseId }),
                  }))}
                  costTypes={costMeta.types}
                  currencies={costMeta.currencies}
                  clientOptions={client ? [{ id: client.id, clientCode: client.clientCode }] : []}
                  defaultCurrency={warehouse.country === 'CN' ? 'CNY' : 'USD'}
                  canVoid={receipt.status === 'confirmed'}
                  canAdd={receipt.status === 'confirmed'}
                  today={tashkentDay()}
                  canUnmerge={mayPickTill(actor.permissions)}
                  tillOptions={await tillOptionsFor(actor.permissions)}
                  partnerOptions={partnerOptions}
                />
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {costs.map(({ entry, typeName }) => (
                    <li key={entry.id} className="flex flex-wrap gap-2 py-2">
                      <span>{typeName}</span>
                      <span className="font-semibold">
                        {entry.amount} {entry.currency}
                      </span>
                      {entry.note && <span className="w-full text-xs text-ink-500">{entry.note}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {othersLine}
            </section>
          )}
        </div>
      )}

      {/* 5. The staff's conversation about this cargo, beside the folds.
          ONE wrapper whose class switches: the thread's slot and the folds'
          slot keep their places in the tree whichever is drawn, so a fold a
          person opened and the answer inside it («✅ ko'chirildi», the
          annul's own) survive the revalidation that follows the press. */}
      <div className={`grid gap-4 max-md:order-1 lg:items-start ${cargoThread ? 'lg:grid-cols-2' : ''}`}>
        {cargoThread ? (
          <CargoThread threadRef={cargoRef} viewer={actor} />
        ) : actor.warehouseScoped ? (
          // A SCOPED person the card admits and the thread does not: the
          // receiving warehouse after the cargo left, a scoped logist on such a
          // card — one sentence instead of a silently missing panel. An
          // unscoped non-reader (seller, VED, accountant) sees nothing (E7 b).
          <p className="text-xs text-ink-500" data-testid="cargo-thread-elsewhere">
            {tth('cargo.elsewhere')}
          </p>
        ) : null}
        <ThreadSeen refs={readMarks} />
        <div className="min-w-0 space-y-4">
          <TasksPanel
            entityType="receipt"
            entityId={id}
            revalidate={`/receipts/${id}`}
          />

          <CustomFieldsPanel
            entityType="receipt"
            entityId={id}
            revalidate={`/receipts/${id}`}
          />

          {/* The rare and the irreversible, in ONE fold: a correction of the
              owner, a move to another warehouse, the void. They stood open
              between the lots and the files on every card. FIXED slots, for
              the reason the wrapper gives. */}
          {moreWords.length > 0 && (
            <Panel
              testId="receipt-more"
              title={
                <>
                  ⚙️ {t('more')}
                  <span className="mt-0.5 block text-xs font-normal text-ink-500">{moreWords.join(' · ')}</span>
                </>
              }
            >
              {canAssign && client && <AssignClient receiptId={id} current={client.clientCode} />}
              {canVoid && (
                <MoveReceipt
                  receiptId={id}
                  currentWarehouseId={receipt.warehouseId}
                  warehouses={allWarehouses}
                />
              )}
              {/* The cascade SUBSUMES the plain void (same terminal state, plus the
                  money) — two forms with the same red vocabulary on one card would
                  be a coin-flip; the plain one stays for everyone below the role. */}
              {canVoid && !canAnnul && (
                <VoidReceiptForm
                  receiptId={id}
                  labels={{
                    reason: t('voidReason'),
                    button: t('voidBtn'),
                    errors: {
                      box_not_in_stock: t('voidBoxGone'),
                      receipt_has_costs: t('voidHasCosts'),
                      receipt_has_compensation: t('voidHasCompensation'),
                      busy_retry: tbusy('errors.busy_retry'),
                    },
                    // The slot is filled in the browser with the code the refusal
                    // names; passed as a VALUE so next-intl leaves the braces alone.
                    sharedCostOrphaned: t('voidSharedCost', { code: '{code}' }),
                  }}
                />
              )}

              {canAnnul && preview && (
                <AnnulReceiptForm
                  receiptId={id}
                  preview={{
                    boxLine: Object.entries(preview.boxesByStatus)
                      .map(([status, n]) => `${ts(status)}: ${n}`)
                      .join(' · '),
                    costLine: `${preview.liveCostEntries} × ≈ $${preview.liveCostUsd.toFixed(2)}`,
                    unconvertedCount: preview.unconvertedCostCount,
                    batchLines: preview.affectedBatches,
                    pendingPlanCount: preview.pendingPlanCount,
                    clientLiveTxCount: preview.clientLiveTxCount,
                    clientLedgerHref: receipt.clientId ? `/finance/${receipt.clientId}` : null,
                  }}
                  labels={{
                    open: ta('open'),
                    title: ta('title'),
                    boxes: ta('boxes'),
                    costs: ta('costs'),
                    unconverted: ta('unconverted'),
                    batches: ta('batches'),
                    willRetire: ta('willRetire'),
                    pendingPlans: ta('pendingPlans'),
                    clientMoney: ta('clientMoney'),
                    reason: t('voidReason'),
                    button: ta('button'),
                    confirm: ta('confirm'),
                    done: ta('done'),
                    errors: {
                      annul_forbidden: ta('forbidden'),
                      box_on_active_plan: ta('onActivePlan'),
                      cost_paid_from_till: ta('paidFromTill'),
                      cost_merged: ta('mergedCost'),
                      receipt_has_compensation: ta('hasCompensation'),
                      reason_required: ta('reasonRequired'),
                      not_found: ta('notFound'),
                      validation: ta('reasonRequired'),
                      busy_retry: tbusy('errors.busy_retry'),
                    },
                  }}
                />
              )}
            </Panel>
          )}
        </div>
      </div>

      <section className="max-md:order-1" data-testid="receipt-history">
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="receipt" entityId={id} />
      </section>
    </div>
  );
}
