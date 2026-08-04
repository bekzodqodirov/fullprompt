import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { getSessionUser, listSessions } from '@/modules/platform/auth/session';
import { logoutOtherDevicesAction } from '@/modules/platform/auth/actions';
import { createTelegramLinkAction, telegramLinkStatus } from '@/modules/platform/telegram/actions';
import { groupsFromList } from '@/modules/platform/notifications/mutes';
import { setNotificationMutesAction } from './actions';
import { LocaleSwitcher } from '@/components/locale-switcher';

export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const t = await getTranslations('profile');
  const tc = await getTranslations('common');
  const format = await getFormatter();
  const devices = await listSessions(user.id);
  const telegramLink = await telegramLinkStatus(user.id);
  const userRow = await db.query.users.findFirst({
    columns: { mutedNotificationTypes: true },
    where: eq(users.id, user.id),
  });
  const mutes = groupsFromList(userRow?.mutedNotificationTypes);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      <div className="card">
        <p className="font-semibold">{user.fullName}</p>
        <p className="text-sm text-ink-700">{user.phone}</p>
      </div>

      {/* The language lives HERE on a phone: the app bar ran out of room when
          the «+» arrived, and squeezing every icon from 44 px to 33 px is a
          worse answer for a warehouse thumb than one extra tap for a control
          most people set once. It stays in the bar from `sm` up. */}
      <section className="card flex items-center justify-between gap-3 sm:hidden">
        <span className="text-sm font-semibold">{t('language')}</span>
        <LocaleSwitcher current={user.locale} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">{t('devices')}</h2>
        {devices.map((device) => (
          <div key={device.id} className="card flex items-center gap-3 !p-3 text-sm">
            <div>
              <span className="font-semibold">{device.deviceLabel}</span>
              {device.id === user.sessionId && (
                <span className="ml-2 rounded bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">
                  {t('thisDevice')}
                </span>
              )}
              <div className="text-xs text-ink-500">
                {device.ip ?? ''} · {t('lastSeen')}:{' '}
                {format.dateTime(device.lastSeenAt, { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            </div>
          </div>
        ))}
        <form action={logoutOtherDevicesAction}>
          <button type="submit" className="btn-secondary">
            {t('logoutOthers')}
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold">{t('telegram')}</h2>
        {telegramLink?.status === 'linked' ? (
          <p className="font-semibold text-good">{t('telegramLinked')}</p>
        ) : (
          <form action={createTelegramLinkAction}>
            <button type="submit" className="btn-primary">
              ✈️ {t('telegramConnect')}
            </button>
            {telegramLink?.status === 'pending' && (
              <p className="mt-1 text-sm text-ink-500">{t('telegramPending')}</p>
            )}
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">🔕 {t('notifTitle')}</h2>
        <p className="text-sm text-ink-500">{t('notifHint')}</p>
        <form action={setNotificationMutesAction} className="card space-y-3 !p-3 text-sm">
          <label className="flex min-h-10 items-center gap-3 font-semibold">
            <input type="checkbox" name="mute_all" defaultChecked={mutes.all} className="h-5 w-5" />
            {t('notifMuteAll')}
          </label>
          <div className="space-y-2 border-t border-line pt-2">
            <label className="flex min-h-10 items-center gap-3">
              <input type="checkbox" name="mute_digest" defaultChecked={mutes.groups.digest} className="h-5 w-5" />
              📊 {t('notifMuteDigest')}
            </label>
            <label className="flex min-h-10 items-center gap-3">
              <input type="checkbox" name="mute_tasks" defaultChecked={mutes.groups.tasks} className="h-5 w-5" />
              ✅ {t('notifMuteTasks')}
            </label>
            <label className="flex min-h-10 items-center gap-3">
              <input type="checkbox" name="mute_alerts" defaultChecked={mutes.groups.alerts} className="h-5 w-5" />
              🚨 {t('notifMuteAlerts')}
            </label>
            <label className="flex min-h-10 items-center gap-3">
              <input type="checkbox" name="mute_operations" defaultChecked={mutes.groups.operations} className="h-5 w-5" />
              📥 {t('notifMuteOps')}
            </label>
          </div>
          <button type="submit" className="btn-primary w-full">
            {tc('save')}
          </button>
        </form>
      </section>

      <p className="text-center text-xs text-ink-400">build: {process.env.NEXT_PUBLIC_BUILD_AT}</p>
    </div>
  );
}
