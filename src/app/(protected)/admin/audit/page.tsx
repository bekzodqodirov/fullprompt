import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { db } from '@/modules/platform/db/client';
import { auditLog, users, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

/** Admin-only global audit browser with filters (spec 4.3b). */
export default async function AuditBrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await getActor();
  if (!actor?.permissions.has('admin.audit.browse')) redirect('/');

  const t = await getTranslations('audit');
  const format = await getFormatter();
  const params = await searchParams;

  // Malformed ?from/?to must not crash the page — ignore invalid dates.
  const parseDate = (value: string | undefined, suffix = '') => {
    if (!value) return null;
    const date = new Date(`${value}${suffix}`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const from = parseDate(params.from);
  const to = parseDate(params.to, 'T23:59:59');

  const conditions: SQL[] = [];
  if (params.user) conditions.push(eq(auditLog.actorId, params.user));
  if (params.entity) conditions.push(eq(auditLog.entityType, params.entity));
  if (from) conditions.push(gte(auditLog.createdAt, from));
  if (to) conditions.push(lte(auditLog.createdAt, to));

  const rows = await db
    .select({ entry: auditLog, actorName: users.fullName, warehouseCode: warehouses.code })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .leftJoin(warehouses, eq(auditLog.warehouseId, warehouses.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(200);

  const allUsers = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .orderBy(users.fullName);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('title')}</h1>

      <form className="card grid grid-cols-2 gap-3 md:grid-cols-5" method="get">
        <div>
          <label className="label" htmlFor="user">
            {t('filterUser')}
          </label>
          <select id="user" name="user" className="input" defaultValue={params.user ?? ''}>
            <option value="">—</option>
            {allUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="entity">
            {t('filterEntity')}
          </label>
          <input
            id="entity"
            name="entity"
            className="input"
            defaultValue={params.entity ?? ''}
            placeholder={t('filterEntityPlaceholder')}
          />
        </div>
        <div>
          <label className="label" htmlFor="from">
            {t('filterDateFrom')}
          </label>
          <input id="from" name="from" type="date" className="input" defaultValue={params.from} />
        </div>
        <div>
          <label className="label" htmlFor="to">
            {t('filterDateTo')}
          </label>
          <input id="to" name="to" type="date" className="input" defaultValue={params.to} />
        </div>
        <div className="flex items-end">
          <button type="submit" className="btn-primary w-full">
            {t('apply')}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="p-2">{t('when')}</th>
              <th className="p-2">{t('who')}</th>
              <th className="p-2">{t('action')}</th>
              <th className="p-2">{t('entity')}</th>
              <th className="p-2">{t('warehouse')}</th>
              <th className="p-2">{t('changes')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, actorName, warehouseCode }) => (
              <tr key={String(entry.id)} className="border-b border-gray-100 align-top">
                <td className="whitespace-nowrap p-2">
                  {format.dateTime(entry.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}
                </td>
                <td className="p-2 font-semibold">{actorName ?? t('system')}</td>
                <td className="p-2">{t(`actions.${entry.action}`)}</td>
                <td className="p-2 font-mono text-xs">
                  {entry.entityType}
                  <br />
                  {entry.entityId.slice(0, 8)}
                </td>
                <td className="p-2">{warehouseCode ?? '—'}</td>
                <td className="p-2">
                  {entry.after ? (
                    <pre className="max-w-xs overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-600">
                      {JSON.stringify(entry.after)}
                    </pre>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-4 text-sm text-gray-500">{t('noRows')}</p>}
      </div>
    </div>
  );
}
