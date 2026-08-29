import { and, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { db } from '@/modules/platform/db/client';
import {
  clients,
  clientTransactions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayAnnul } from '@/modules/wms/receipts/annul';
import { BulkAnnulForm, type BulkRow } from './bulk-form';

export const dynamic = 'force-dynamic';

const REGISTRY_CAP = 200;

/**
 * Anulirovka — the registry of voided cargo and the owner's cleanup tool
 * (2026-08-26: «anulirovat qilingan yuklarni ro'yxati tursin … menda
 * productionni o'zida test datalar kirgazib tashlaganman»).
 *
 * READ gate = admin.audit.browse (it is an audit surface; admin + super_admin
 * hold it, nobody warehouse-scoped does, and the hub tile never teases a role
 * the page would bounce). The ANNUL half renders only for `mayAnnul` — the
 * owner's role — and the action refuses everybody else anyway (#531).
 */
export default async function AnnulRegistryPage({
  searchParams,
}: {
  searchParams: Promise<{ mijoz?: string }>;
}) {
  const actor = await getActor();
  if (!actor?.permissions.has('admin.audit.browse')) redirect('/');
  const t = await getTranslations('annul');
  const tc = await getTranslations('common');
  const format = await getFormatter();
  const canAnnul = mayAnnul(actor);
  const { mijoz } = await searchParams;

  // ---- the cleanup half: one client's confirmed receipts, pickable
  let searchClient: { id: string; clientCode: string; name: string } | null = null;
  let bulkRows: BulkRow[] = [];
  if (canAnnul && mijoz?.trim()) {
    const [row] = await db
      .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
      .from(clients)
      .where(ilike(clients.clientCode, mijoz.trim()))
      .limit(1);
    searchClient = row ?? null;
    if (row) {
      const list = await db
        .select({
          id: receipts.id,
          number: receipts.number,
          receivedAt: receipts.receivedAt,
          boxCount: sql<number>`coalesce(sum(${receiptLots.boxCount}), 0)`,
          volumeM3: sql<string>`coalesce(sum(${receiptLots.totalVolumeM3}), 0)`,
          weightKg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg}), 0)`,
          goods: sql<string>`coalesce(string_agg(coalesce(${receiptLots.productNameRu}, ${receiptLots.productNameZh}), ', '), '')`,
        })
        .from(receipts)
        .leftJoin(receiptLots, eq(receiptLots.receiptId, receipts.id))
        .where(and(eq(receipts.clientId, row.id), eq(receipts.status, 'confirmed')))
        .groupBy(receipts.id)
        .orderBy(desc(receipts.receivedAt))
        .limit(100);
      bulkRows = list.map((r) => ({
        id: r.id,
        number: r.number ?? '—',
        receivedAt: r.receivedAt ? format.dateTime(r.receivedAt, { dateStyle: 'short' }) : '—',
        boxCount: Number(r.boxCount),
        volumeM3: Number(r.volumeM3).toFixed(3),
        weightKg: Number(r.weightKg).toFixed(1),
        goods: r.goods,
      }));
    }
  }

  // ---- the registry half: every voided receipt, newest first
  const voidedBy = sql<string>`(select full_name from ${users} u where u.id = ${receipts.voidedBy})`;
  const registry = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      voidedAt: receipts.voidedAt,
      voidReason: receipts.voidReason,
      warehouseCode: warehouses.code,
      clientId: receipts.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      voidedByName: voidedBy,
      boxCount: sql<number>`coalesce((select sum(rl.box_count) from ${receiptLots} rl where rl.receipt_id = ${receipts.id}), 0)`,
      volumeM3: sql<string>`coalesce((select sum(rl.total_volume_m3) from ${receiptLots} rl where rl.receipt_id = ${receipts.id}), 0)`,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(receipts.status, 'voided'))
    .orderBy(desc(receipts.voidedAt))
    .limit(REGISTRY_CAP);
  const [totalRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(receipts)
    .where(eq(receipts.status, 'voided'));
  const total = Number(totalRow?.total ?? 0);

  // The client's LIVE money, per distinct client on the page — the done/
  // not-done checklist: it drains to 0 as he voids rows on the ledger. ALL
  // live rows deliberately, never a per-receipt heuristic — a charge names no
  // receipt and a payment only its kassa, and «0» must never read as «clean»
  // while test money stands in a cash box.
  const clientIds = [...new Set(registry.map((r) => r.clientId).filter((x): x is string => !!x))];
  const moneyRows = clientIds.length
    ? await db
        .select({
          clientId: clientTransactions.clientId,
          n: sql<number>`count(*)`,
          balance: sql<string>`coalesce(sum(case when ${clientTransactions.type} = 'charge' then ${clientTransactions.amountUsd} else -${clientTransactions.amountUsd} end), 0)`,
        })
        .from(clientTransactions)
        .where(
          and(inArray(clientTransactions.clientId, clientIds), isNull(clientTransactions.voidedAt)),
        )
        .groupBy(clientTransactions.clientId)
    : [];
  const money = new Map(moneyRows.map((r) => [r.clientId, { n: Number(r.n), balance: Number(r.balance) }]));

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-bold">{t('registryTitle')}</h1>

      {canAnnul && (
        <section className="card space-y-3 !p-4" data-testid="annul-bulk">
          <h2 className="font-bold">{t('bulkTitle')}</h2>
          <p className="text-sm text-ink-500">{t('bulkHint')}</p>
          <form className="flex gap-2" method="get">
            <input
              name="mijoz"
              className="input flex-1"
              placeholder={t('clientCode')}
              defaultValue={mijoz ?? ''}
              data-testid="bulk-annul-client"
            />
            <button type="submit" className="btn-secondary shrink-0">
              {tc('search')}
            </button>
          </form>
          {mijoz?.trim() &&
            (searchClient ? (
              <>
                <p className="text-sm">
                  <span className="font-mono font-bold">{searchClient.clientCode}</span> ·{' '}
                  {searchClient.name}
                </p>
                {bulkRows.length ? (
                  <BulkAnnulForm
                    rows={bulkRows}
                    labels={{
                      reason: t('reason'),
                      button: t('bulkButton'),
                      // The {n} stays literal for the client to fill at press
                      // time — braces passed as a runtime VALUE (#520's sidestep).
                      confirm: t('bulkConfirm', { n: '{n}' }),
                      done: t('bulkDone'),
                      refused: t('bulkRefused'),
                      errors: {
                        annul_forbidden: t('forbidden'),
                        box_on_active_plan: t('onActivePlan'),
                        reason_required: t('reasonRequired'),
                        not_found: t('notFound'),
                        validation: t('reasonRequired'),
                      },
                    }}
                  />
                ) : (
                  <p className="text-sm text-ink-500">{t('noReceipts')}</p>
                )}
                <p className="text-xs text-ink-500">{t('deactivateHint')}</p>
              </>
            ) : (
              <p className="text-sm text-bad">{t('clientNotFound')}</p>
            ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-bold">
          {t('listTitle')}{' '}
          <span className="text-sm font-normal text-ink-500">
            {registry.length < total
              ? t('listCap', { shown: registry.length, total })
              : total}
          </span>
        </h2>
        {registry.length === 0 ? (
          <p className="text-ink-500">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-ink-500">
                  <th className="py-1.5 pr-2">{t('colWhen')}</th>
                  <th className="py-1.5 pr-2">{t('colReceipt')}</th>
                  <th className="py-1.5 pr-2">{t('colClient')}</th>
                  <th className="py-1.5 pr-2">{t('colCargo')}</th>
                  <th className="py-1.5 pr-2">{t('colWho')}</th>
                  <th className="py-1.5 pr-2">{t('colMoney')}</th>
                </tr>
              </thead>
              <tbody>
                {registry.map((row) => {
                  const m = row.clientId ? money.get(row.clientId) : undefined;
                  return (
                    <tr key={row.id} className="border-t border-line align-top" data-testid="annul-row">
                      <td className="whitespace-nowrap py-1.5 pr-2 text-ink-500">
                        {row.voidedAt ? format.dateTime(row.voidedAt, { dateStyle: 'short' }) : '—'}
                      </td>
                      <td className="py-1.5 pr-2">
                        <a className="font-mono font-semibold underline" href={`/receipts/${row.id}`}>
                          {row.number ?? '—'}
                        </a>
                        <span className="text-ink-500"> · {row.warehouseCode}</span>
                        {row.voidReason && (
                          <div className="max-w-[16rem] truncate text-xs text-ink-500">{row.voidReason}</div>
                        )}
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className="font-mono">{row.clientCode ?? '—'}</span>
                        <div className="max-w-[10rem] truncate text-xs text-ink-500">{row.clientName ?? ''}</div>
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-2">
                        📦 {Number(row.boxCount)} · {Number(row.volumeM3).toFixed(2)} m³
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-2 text-ink-500">{row.voidedByName ?? '—'}</td>
                      <td className="whitespace-nowrap py-1.5 pr-2">
                        {row.clientId && m && m.n > 0 ? (
                          <a className="font-semibold text-warn underline" href={`/finance/${row.clientId}`}>
                            {m.n} · ${m.balance.toFixed(2)}
                          </a>
                        ) : (
                          <span className="text-good">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
