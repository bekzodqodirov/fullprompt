import Link from 'next/link';
import { and, desc, eq, gte, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { notifications, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

async function weekTotals(telegramOnly: SQL) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  return db
    .select({ status: notifications.status, n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(telegramOnly, gte(notifications.createdAt, weekAgo)))
    .groupBy(notifications.status);
}

/**
 * Spec §11: "failures visible in admin" — Telegram delivery log with a
 * problems-first filter (send errors being retried, muted/unlinked rows).
 */
export default async function NotificationDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const actor = await getActor();
  if (!actor?.permissions.has('admin.audit.browse')) redirect('/');
  const t = await getTranslations('notifDelivery');
  const format = await getFormatter();
  const { view: rawView } = await searchParams;
  const view = rawView === 'all' ? 'all' : 'problems';

  const telegramOnly = eq(notifications.channel, 'telegram');
  const problems = or(
    eq(notifications.status, 'failed'),
    and(eq(notifications.status, 'pending'), isNotNull(notifications.error)),
    eq(notifications.status, 'muted'),
  )!;
  const where: SQL = view === 'problems' ? and(telegramOnly, problems)! : telegramOnly;

  const rows = await db
    .select({
      id: notifications.id,
      createdAt: notifications.createdAt,
      type: notifications.type,
      status: notifications.status,
      error: notifications.error,
      sentAt: notifications.sentAt,
      userName: users.fullName,
    })
    .from(notifications)
    .innerJoin(users, eq(notifications.userId, users.id))
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(200);

  const totals = await weekTotals(telegramOnly);
  const count = (status: string) => Number(totals.find((r) => r.status === status)?.n ?? 0);

  const badge = (status: string) =>
    status === 'sent'
      ? 'bg-green-100 text-green-800'
      : status === 'pending'
        ? 'bg-yellow-100 text-yellow-800'
        : status === 'failed'
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-600';

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-bold">🔔 {t('title')}</h1>
        <span className="flex gap-1 text-sm">
          <Link
            href="?view=problems"
            className={`rounded px-2 py-0.5 font-semibold ${view === 'problems' ? 'bg-blue-700 text-white' : 'bg-gray-100'}`}
          >
            {t('problems')}
          </Link>
          <Link
            href="?view=all"
            className={`rounded px-2 py-0.5 font-semibold ${view === 'all' ? 'bg-blue-700 text-white' : 'bg-gray-100'}`}
          >
            {t('all')}
          </Link>
        </span>
      </div>

      <p className="text-sm text-gray-600">
        {t('week')}: ✅ {count('sent')} · ⏳ {count('pending')} · ❌ {count('failed')} · 🔕{' '}
        {count('muted')}
      </p>

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <th className="p-2">{t('when')}</th>
                <th className="p-2">{t('user')}</th>
                <th className="p-2">{t('type')}</th>
                <th className="p-2">{t('status')}</th>
                <th className="p-2">{t('error')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100 last:border-0">
                  <td className="p-2 text-xs">
                    {format.dateTime(row.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="max-w-32 truncate p-2">{row.userName}</td>
                  <td className="p-2 font-mono text-xs">{row.type}</td>
                  <td className="p-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${badge(row.status)}`}>
                      {t(`statuses.${row.status}`)}
                    </span>
                  </td>
                  <td className="max-w-48 truncate p-2 text-xs text-gray-600" title={row.error ?? ''}>
                    {row.error ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-gray-500">{t('empty')}</p>}
      </div>
      <p className="text-xs text-gray-400">{t('note')}</p>
    </div>
  );
}
