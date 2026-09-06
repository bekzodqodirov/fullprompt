import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { getSessionUser, listSessions } from '@/modules/platform/auth/session';
import { logoutAction, logoutOtherDevicesAction } from '@/modules/platform/auth/actions';
import { createTelegramLinkAction, telegramLinkStatus } from '@/modules/platform/telegram/actions';
import { groupsFromList } from '@/modules/platform/notifications/mutes';
import { currentCallsApk } from '@/modules/wms/calls/apk';
import { callDevicesFor } from '@/modules/wms/calls/service';
import { setNotificationMutesAction } from './actions';
import { CallRecorderSection } from './call-recorder';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Icon } from '@/components/ui/icon';

export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const t = await getTranslations('profile');
  const tc = await getTranslations('common');
  const tNav = await getTranslations('nav');
  const tn = await getTranslations('notes');
  const format = await getFormatter();
  // Everything below the name is a PANEL, and this page is now the only way
  // out of the app. A panel that throws used to cost a screen; it would now
  // cost the session — and the one morning this codebase has watched a page
  // 500 was a deploy where the schema was ahead of the code (#472), which is
  // exactly when somebody wants to sign in as somebody else. The error still
  // goes to the log; only the panel is lost.
  const panel = async <T,>(load: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load;
    } catch (err) {
      console.error('[profile]', err);
      return fallback;
    }
  };
  const devices = await panel(listSessions(user.id), []);
  const telegramLink = await panel(telegramLinkStatus(user.id), null);
  const callDevices = await panel(callDevicesFor(user.id), []);
  const callsApk = await panel(currentCallsApk(), null);
  const userRow = await panel(
    db.query.users.findFirst({
      columns: { mutedNotificationTypes: true },
      where: eq(users.id, user.id),
    }),
    undefined,
  );
  const mutes = groupsFromList(userRow?.mutedNotificationTypes);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      {/* Signing out is HERE now, not in the app bar (owner: «logoutni profil
          ichiga kirgaz»). It belongs beside the name it ends the session of,
          and it is the same card «Boshqa qurilmalardan chiqish» already
          answers for further down. `nav.logout` is reused — the words exist in
          all four bundles and a second key for the same button is how a
          locale ends up missing one (#163). */}
      <div className="card flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{user.fullName}</p>
          <p className="text-sm text-ink-700">{user.phone}</p>
        </div>
        <form action={logoutAction}>
          <button type="submit" className="btn-secondary" data-testid="profile-logout">
            <Icon name="logout" /> {tNav('logout')}
          </button>
        </form>
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

      <CallRecorderSection
        devices={callDevices.map((d) => ({
          id: d.id,
          label: d.label,
          pairCode: d.pairCode,
          paired: !d.pairCode && !!d.pairedAt,
          lastSeenAt: d.lastSeenAt
            ? format.dateTime(d.lastSeenAt, { dateStyle: 'short', timeStyle: 'short' })
            : null,
          calls: Number(d.calls),
        }))}
        labels={{
          title: t('callRecTitle'),
          hint: t('callRecHint'),
          add: t('callRecAdd'),
          codeHint: t('callRecCodeHint'),
          lastSeen: t('lastSeen'),
          callCount: t('callRecCount'),
          remove: t('callRecRemove'),
          notPaired: t('callRecNotSeen'),
          downloadApk: t('callRecApp'),
        }}
        apkVersion={callsApk?.version ?? null}
      />

      {/* The door for everyone whose curated menu does not carry it — a
          warehouse hand READS zametkalar in the bot, and this is where they
          come to link that bot in the first place. */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">📌 {tn('title')}</h2>
        <p className="text-sm text-ink-500">{tn('hint')}</p>
        <Link href="/zametkalar" className="btn-secondary" data-testid="profile-notes">
          {tn('title')}
        </Link>
      </section>

      <section className="space-y-2" data-testid="profile-telegram">
        <h2 className="text-lg font-bold">{t('telegram')}</h2>
        {telegramLink?.status === 'linked' ? (
          <>
            <p className="font-semibold text-good">{t('telegramLinked')}</p>
            {/* The door that was missing: a person whose Telegram changed —
                a new phone, a new account, a chat that is now somebody
                else's — had no way to move the link from the web at all.
                The old chat keeps receiving until the new one takes over,
                so pressing this by accident costs nothing. */}
            <p className="text-sm text-ink-500">{t('telegramReconnectHint')}</p>
            <form action={createTelegramLinkAction}>
              <button
                type="submit"
                data-testid="profile-telegram-reconnect"
                className="btn-secondary"
              >
                ✈️ {t('telegramReconnect')}
              </button>
            </form>
          </>
        ) : (
          <form action={createTelegramLinkAction}>
            <button type="submit" data-testid="profile-telegram-connect" className="btn-primary">
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
