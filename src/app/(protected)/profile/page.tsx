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
        <p className="text-sm text-gray-600">{user.phone}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">{t('devices')}</h2>
        {devices.map((device) => (
          <div key={device.id} className="card flex items-center gap-3 !p-3 text-sm">
            <div>
              <span className="font-semibold">{device.deviceLabel}</span>
              {device.id === user.sessionId && (
                <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                  {t('thisDevice')}
                </span>
              )}
              <div className="text-xs text-gray-500">
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
          <p className="font-semibold text-green-700">{t('telegramLinked')}</p>
        ) : (
          <form action={createTelegramLinkAction}>
            <button type="submit" className="btn-primary">
              ✈️ {t('telegramConnect')}
            </button>
            {telegramLink?.status === 'pending' && (
              <p className="mt-1 text-sm text-gray-500">{t('telegramPending')}</p>
            )}
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">🔕 {t('notifTitle')}</h2>
        <p className="text-sm text-gray-500">{t('notifHint')}</p>
        <form action={setNotificationMutesAction} className="card space-y-3 !p-3 text-sm">
          <label className="flex min-h-10 items-center gap-3 font-semibold">
            <input type="checkbox" name="mute_all" defaultChecked={mutes.all} className="h-5 w-5" />
            {t('notifMuteAll')}
          </label>
          <div className="space-y-2 border-t border-gray-100 pt-2">
            <label className="flex min-h-10 items-center gap-3">
              <input type="checkbox" name="mute_digest" defaultChecked={mutes.groups.digest} className="h-5 w-5" />
              📊 {t('notifMuteDigest')}
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

      <p className="text-center text-xs text-gray-400">build: {process.env.NEXT_PUBLIC_BUILD_AT}</p>
    </div>
  );
}
