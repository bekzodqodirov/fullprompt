import Link from 'next/link';
import { asc, eq, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  costTypes,
  currencies,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { isServerBehind } from '@/modules/platform/db/errors';
import { PageHeader } from '@/components/ui/page';
import { CostPanel } from '@/components/cost-panel';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { listPartners } from '@/modules/wms/partners/service';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import {
  isOpenStatus,
  listFactories,
  loadPickup,
  ownerLinesOf,
  mayReadPickup,
  PICKUP_WRITE,
  pickupCandidates,
} from '@/modules/wms/pickups/service';
import { pickupEstimate } from '@/modules/wms/pickups/eta';
import {
  AddStopForm,
  AnswerLineButtons,
  ClosePickupForm,
  CollectForm,
  LinkReceiptButtons,
  NoCostControl,
  PickupButtons,
  PickupHeaderForm,
  RemoveStopButton,
  StopLinesForm,
} from '../pickup-forms';
import { maySeeStaffMoney, payerView } from '@/modules/wms/partners/staff';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { tillOptionsFor } from '@/modules/wms/costing/till-props';
import { costSightFor, tillView } from '@/modules/wms/costing/cost-sight';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { costEntriesFor } from '@/modules/wms/costing/service';

export const dynamic = 'force-dynamic';

export default async function PickupCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const actor = await getActor();
  if (!actor) redirect('/login');
  const loaded = await loadPickup(id).catch((err: unknown) => {
    if (isServerBehind(err)) return 'behind' as const;
    throw err;
  });
  if (loaded === 'behind') {
    const tb = await getTranslations('pickups');
    return (
      <p className="card mx-auto max-w-3xl text-sm text-warn" data-testid="pickups-server-behind">
        ⚠ {tb('serverBehind')}
      </p>
    );
  }
  if (!loaded) notFound();
  const { pickup, dest, stops, createdByName, closedByName, noCostByName } = loaded;
  if (!mayReadPickup(actor, pickup.destWarehouseId)) notFound();

  const t = await getTranslations('pickups');
  const format = await getFormatter();
  const canWrite = actor.permissions.has(PICKUP_WRITE);
  // Two different questions (his 2a): a CLOSED trip takes no more logistics —
  // no stop, no line, no «olindi», no prixod attached — while its MONEY stays
  // open, because the truck's bill arrives when it arrives.
  const open = isOpenStatus(pickup.status);
  const live = pickup.status !== 'cancelled';
  const canCost = actor.permissions.has('costs.enter_batch') && inScope(actor, pickup.destWarehouseId);

  // The one reader every cost card lists from (Q19 D1): a VED who holds
  // `costs.enter_batch` reads the entries he typed and the TYPES of the rest.
  const { entries: costs, others: costOthers } = await costEntriesFor({ pickupId: id }, costSightFor(actor));
  const tcost = await getTranslations('costing');
  const costMeta = canCost
    ? {
        types: await db
          .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
          .from(costTypes)
          .where(eq(costTypes.active, true)),
        currencies: (
          await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
        ).map((c) => c.code),
        partners: (await listPartners({ includeStaff: maySeeStaffMoney(actor.permissions) })).map((row) => ({ id: row.id, name: row.name })),
      }
    : null;
  const candidates = open && canCost ? await pickupCandidates(id) : [];
  const factories = canWrite && open ? await listFactories() : [];
  // Every live cost, the reader's own AND the ones he may only count: a VED
  // who typed none must not be told the truck has no bill.
  const costCount = costs.length + costOthers.count;
  const came = pickup.status === 'arrived' || pickup.status === 'closed';
  const stamps = stops.length
    ? await db
        .select()
        .from(attachments)
        .where(inArray(attachments.entityId, stops.map((s) => s.id)))
        .orderBy(asc(attachments.createdAt))
    : [];

  // The estimate: where the truck should be and when it should be here, as
  // a RANGE (the legs' hours are a public router's car time stretched for a
  // lorry, an assumption, not a promise).
  const { position, eta } = pickupEstimate(stops);
  const unplaced = stops.filter((s) => s.factory.lat === null);
  const linkedCount = stops.reduce((a, s) => a + s.receipts.filter((r) => !r.voided).length, 0);
  const tz = 'Asia/Tashkent';
  const when = (value: Date | number) =>
    format.dateTime(new Date(value), { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader
        icon="truck"
        title={<span className="font-mono">{pickup.code}</span>}
        subtitle={`${t(`status.${pickup.status}`)} · → ${dest.code}`}
        back={{ href: '/zavod', label: t('title') }}
      />
      <div className="card space-y-1 text-sm" data-testid="pickup-facts">
        <p>
          <span className="text-ink-500">{t('destination')}:</span> {dest.code} — {dest.name}
        </p>
        {(pickup.vehiclePlate || pickup.driverName || pickup.driverPhone) && (
          <p>
            <span className="text-ink-500">{t('driver')}:</span> {pickup.vehiclePlate} {pickup.driverName}{' '}
            {pickup.driverPhone && (
              <a className="text-brand-700 underline" href={`tel:${pickup.driverPhone}`}>
                {pickup.driverPhone}
              </a>
            )}
          </p>
        )}
        {pickup.plannedOn && (
          <p>
            <span className="text-ink-500">{t('plannedOn')}:</span> {pickup.plannedOn}
          </p>
        )}
        {pickup.note && <p className="whitespace-pre-line text-ink-700">📝 {pickup.note}</p>}
        {canWrite && live && (
          <PickupHeaderForm
            pickupId={pickup.id}
            closed={pickup.status === 'closed'}
            initial={{
              destWarehouseId: pickup.destWarehouseId,
              vehiclePlate: pickup.vehiclePlate ?? '',
              driverName: pickup.driverName ?? '',
              driverPhone: pickup.driverPhone ?? '',
              plannedOn: pickup.plannedOn ?? '',
              note: pickup.note ?? '',
            }}
          />
        )}
        <p className="text-xs text-ink-500">
          {createdByName} · {when(pickup.createdAt)}
        </p>
        {pickup.status === 'closed' && pickup.closedAt && (
          <p data-testid="pickup-closed" className="rounded bg-surface-sunken px-2 py-1">
            {pickup.closeKind === 'auto'
              ? `✅ ${t('closedAuto', { at: when(pickup.closedAt) })}`
              : `🔒 ${t('closedManual', { at: when(pickup.closedAt), who: closedByName ?? '—', reason: pickup.closeReason ?? '' })}`}
          </p>
        )}
        {open && eta && position && (
          <p data-testid="pickup-eta" className="rounded bg-surface-sunken px-2 py-1">
            🧭 {t('etaLine', { from: when(eta.from), to: when(eta.to) })}{' '}
            <span className="text-xs text-ink-500">({t('estimate')})</span>
          </p>
        )}
        {open && unplaced.length > 0 && (
          <p className="text-xs text-warn">
            ⚠ {t('unplaced', { names: unplaced.map((s) => s.factory.name).join(', ') })}
          </p>
        )}
        {pickup.status === 'closed' && costCount > 0 && linkedCount === 0 && (
          <p data-testid="pickup-cost-no-cargo" className="font-semibold text-warn">
            ⚠ {t('costNoCargoLong')}
          </p>
        )}
        {came && costCount === 0 && !pickup.noCostAt && (
          <p data-testid="pickup-no-cost" className="font-semibold text-warn">
            ⚠ {t('noCostLong')}
          </p>
        )}
        {open && mayReadBatches(actor.permissions) && (
          <Link href={`/map?zr=${pickup.id}`} className="inline-block text-brand-700 underline" data-testid="pickup-map-link">
            🗺 {t('onMap')}
          </Link>
        )}
      </div>

      {stops.map((stop) => (
        <section key={stop.id} className="card space-y-2" data-testid="pickup-stop">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="font-semibold">
              {stop.seq}. {stop.factory.name}
            </h2>
            {stop.collectedAt ? (
              <span className="chip chip-good" data-testid="stop-collected">
                ✓ {t('collectedAt', { at: when(stop.collectedAt) })}
              </span>
            ) : (
              <span className="chip chip-neutral">{t('notCollected')}</span>
            )}
          </div>
          <p className="text-xs text-ink-500">
            {[stop.factory.address, stop.factory.phone, stop.factory.wechat && `WeChat: ${stop.factory.wechat}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {stop.stampNote && <p className="text-xs">🖋 {stop.stampNote}</p>}
          <ul className="divide-y divide-line text-sm">
            {stop.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-baseline gap-x-2 py-1" data-testid="stop-line">
                <span className="font-mono font-semibold">{line.clientCode ?? line.marking}</span>
                {/* The goods may break anywhere, and the counts take their own
                    line on a phone: a one-word Chinese or Uzbek name used to
                    run INTO «zavod: 5» at 360 px (seen in the screenshot). */}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line.goods}</span>
                <span className="basis-full text-xs text-ink-700 sm:basis-auto">
                  {t('factoryShort')}: {line.factoryBoxes}
                  {line.driverBoxes !== null && (
                    <span className={line.driverBoxes !== line.factoryBoxes ? 'font-semibold text-warn' : ''}>
                      {' '}
                      · {t('driverShort')}: {line.driverBoxes}
                    </span>
                  )}
                  {line.volumeM3 !== null && ` · ${line.volumeM3} m³`}
                  {line.weightKg !== null && ` · ${line.weightKg} kg`}
                </span>
                {line.receipts.map((r) => (
                  <Link key={r.id} href={`/receipts/${r.id}`} className="text-xs text-brand-700 underline" data-testid="line-receipt">
                    ✓ {r.number}
                  </Link>
                ))}
                {line.receipts.length === 0 && stop.collectedAt && (
                  <span className="text-xs text-ink-500" data-testid="line-waiting">
                    {pickup.status === 'closed' ? t('lineNotReceived') : t('lineWaiting')}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {stop.unmatched.length > 0 && (
            <div className="space-y-1 text-xs" data-testid="stop-unmatched">
              <p className="text-ink-500">{t('unmatched')}:</p>
              {stop.unmatched.map((r) => {
                // The lines this prixod could be: its owner's first, else any
                // line of the stop (a marking received under a client code).
                const own = ownerLinesOf(stop.lines, r);
                const choices = (own.length ? own : stop.lines).map((l) => ({ id: l.id, goods: l.goods }));
                return (
                  <p key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link href={`/receipts/${r.id}`} className="text-brand-700 underline">
                      {r.number}
                    </Link>
                    <span className="font-mono">{r.clientCode ?? r.unclaimedMarking}</span>
                    {canCost && live && choices.length > 0 && (
                      <AnswerLineButtons receiptId={r.id} stopId={stop.id} lines={choices} />
                    )}
                  </p>
                );
              })}
            </div>
          )}
          {canWrite && live && !stop.collectedAt && stop.lines.length > 0 && (
            <CollectForm
              stopId={stop.id}
              lines={stop.lines.map((l) => ({
                id: l.id,
                label: `${l.clientCode ?? l.marking} ${l.goods}`,
                factoryBoxes: l.factoryBoxes,
              }))}
            />
          )}
          {canWrite && open && stop.receipts.every((r) => r.voided) && (
            <StopLinesForm
              stopId={stop.id}
              initial={stop.lines.map((l) => ({
                owner: l.clientCode ?? l.marking ?? '',
                goods: l.goods,
                factoryBoxes: String(l.factoryBoxes),
                volumeM3: l.volumeM3 === null ? '' : String(l.volumeM3),
                weightKg: l.weightKg === null ? '' : String(l.weightKg),
              }))}
            />
          )}
          <AttachmentsPanel
            entityType="pickup_stop"
            entityId={stop.id}
            initial={stamps
              .filter((f) => f.entityId === stop.id)
              .map((f) => ({ id: f.id, fileName: f.fileName, contentType: f.contentType, kind: f.kind }))}
            editable={canWrite && open}
          />
          {canWrite && open && !stop.collectedAt && stop.receipts.length === 0 && stops.length > 1 && (
            <RemoveStopButton stopId={stop.id} />
          )}
        </section>
      ))}

      {canWrite && open && stops.length < 6 && factories.length > 0 && (
        <div className="card">
          <AddStopForm pickupId={pickup.id} factories={factories.map((f) => ({ id: f.id, label: f.name }))} />
        </div>
      )}

      <section className="card space-y-2" data-testid="pickup-costs">
        <h2 className="font-semibold">💰 {t('costs')}</h2>
        <p className="text-xs text-ink-500">{t('costHint', { n: linkedCount })}</p>
        <CostPanel
          scope="pickup"
          freight={null}
          targetId={pickup.id}
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
          costTypes={costMeta?.types ?? []}
          currencies={costMeta?.currencies ?? []}
          clientOptions={[
            ...new Map(
              stops
                .flatMap((s) => s.lines)
                .filter((l) => l.clientId && l.clientCode)
                .map((l) => [l.clientId!, { id: l.clientId!, clientCode: l.clientCode! }]),
            ).values(),
          ]}
          defaultCurrency={costMeta?.currencies.includes('CNY') ? 'CNY' : 'USD'}
          canVoid={Boolean(canCost && live)}
          canAdd={Boolean(canCost && live)}
          today={tashkentDay()}
          canUnmerge={mayPickTill(actor.permissions)}
          tillOptions={await tillOptionsFor(actor.permissions)}
          partnerOptions={costMeta?.partners ?? []}
        />
        {costOthers.count > 0 && (
          <p className="text-xs text-ink-500" data-testid="cost-others">
            🔒 {tcost('othersEntered', { count: costOthers.count, types: costOthers.types.join(' · ') })}
          </p>
        )}
        {canCost && came && costCount === 0 && (
          <NoCostControl
            pickupId={pickup.id}
            marked={pickup.noCostAt && pickup.noCostReason ? { reason: pickup.noCostReason, byName: noCostByName } : null}
          />
        )}
      </section>

      {candidates.length > 0 && (
        <section className="card space-y-2" data-testid="pickup-candidates">
          <h2 className="font-semibold">📎 {t('candidatesTitle')}</h2>
          <p className="text-xs text-ink-500">{t('candidatesHint')}</p>
          <ul className="space-y-1 text-sm">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/receipts/${c.id}`} className="font-mono text-brand-700 underline">
                  {c.number}
                </Link>
                <span className="font-mono">{c.clientCode ?? c.unclaimedMarking}</span>
                {c.declined && (
                  <span className="text-xs font-semibold text-warn" data-testid="candidate-declined">
                    ⚠ {t('declinedAtDoor')}
                  </span>
                )}
                <LinkReceiptButtons receiptId={c.id} stops={c.stops} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {canWrite && open && (
        <PickupButtons
          pickupId={pickup.id}
          canArrive={pickup.status !== 'arrived'}
          canCancel={costCount === 0 && linkedCount === 0}
        />
      )}
      {/* Two terminal buttons with overlapping meaning on a trip where
          nothing happened would make the wrong one easy: an untouched trip is
          CANCELLED; «yopish» is for a trip that moved (a stop collected, a
          prixod linked, a cost) — the judge's floor finding. */}
      {canWrite &&
        open &&
        (costCount > 0 || linkedCount > 0 || stops.some((st) => st.collectedAt)) && (
          <ClosePickupForm
            pickupId={pickup.id}
            offerNoCost={canCost && costCount === 0}
            pendingCandidates={candidates.length}
          />
        )}
    </div>
  );
}
