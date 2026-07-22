import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSessionUser, listSessions } from '@/modules/platform/auth/session';
import { logoutOtherDevicesAction } from '@/modules/platform/auth/actions';
import { createTelegramLinkAction, telegramLinkStatus } from '@/modules/platform/telegram/actions';

export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const t = await getTranslations('profile');
  const format = await getFormatter();
  const devices = await listSessions(user.id);
  const telegramLink = await telegramLinkStatus(user.id);

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
    </div>
  );
}
