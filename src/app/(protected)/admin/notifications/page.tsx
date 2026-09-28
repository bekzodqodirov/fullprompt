import Link from 'next/link';
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { notifications, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { BotDownLine } from '@/components/system-signals';
import {
  problemSince,
  telegramBotState,
  telegramProblemSql,
  type TelegramBotState,
} from '@/modules/platform/notifications/service';

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
 * problems-first filter.
 *
 * «Muammolar» is `telegramProblemSql` over the same week, and nothing else
 * (B9): the home screen's «yuborilmagan 37» links here, and it used to land
 * on a list with its own predicate — `muted` in it, no window — so the 37
 * became 300 rows nobody could reconcile (#513). Muted rows are by-design
 * settlements (a person's own mute, no linked chat, deactivated), so they
 * have a tab of their own instead of hiding among the failures.
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
  const view = rawView === 'all' ? 'all' : rawView === 'muted' ? 'muted' : 'problems';
  const tk = await getTranslations('kuzatuv');

  const telegramOnly = eq(notifications.channel, 'telegram');
  const where: SQL =
    view === 'problems'
      ? telegramProblemSql(problemSince())
      : view === 'muted'
        ? and(telegramOnly, eq(notifications.status, 'muted'))!
        : telegramOnly;
  const bot = await telegramBotState().catch((): TelegramBotState | null => null);

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
      ? 'bg-good/15 text-good'
      : status === 'pending'
        ? 'bg-yellow-100 text-yellow-800'
        : status === 'failed'
          ? 'bg-bad/15 text-bad'
          : 'bg-surface-sunken text-ink-700';

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <div className="flex flex-wrap items-baseline gap-2">
        <PageHeader icon="alert" title={t('title')} />
        <span className="flex gap-1 text-sm">
          <Link
            href="?view=problems"
            className={`rounded px-2 py-0.5 font-semibold ${view === 'problems' ? 'bg-brand-600 text-white' : 'bg-surface-sunken'}`}
          >
            {t('problems')}
          </Link>
          <Link
            href="?view=muted"
            className={`rounded px-2 py-0.5 font-semibold ${view === 'muted' ? 'bg-brand-600 text-white' : 'bg-surface-sunken'}`}
          >
            {tk('mutedTab')}
          </Link>
          <Link
            href="?view=all"
            className={`rounded px-2 py-0.5 font-semibold ${view === 'all' ? 'bg-brand-600 text-white' : 'bg-surface-sunken'}`}
          >
            {t('all')}
          </Link>
        </span>
      </div>

      {/* The bot's own state, above the rows it explains (B9). */}
      <BotDownLine state={bot} />

      <p className="text-sm text-ink-700">
        {t('week')}: ✅ {count('sent')} · ⏳ {count('pending')} · ❌ {count('failed')} · 🔕{' '}
        {count('muted')}
      </p>

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('when')}</th>
                <th className="p-2">{t('user')}</th>
                <th className="p-2">{t('type')}</th>
                <th className="p-2">{t('status')}</th>
                <th className="p-2">{t('error')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
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
                  <td className="max-w-48 truncate p-2 text-xs text-ink-700" title={row.error ?? ''}>
                    {row.error ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-ink-500">{t('empty')}</p>}
      </div>
      <p className="text-xs text-ink-400">{t('note')}</p>
    </div>
  );
}
