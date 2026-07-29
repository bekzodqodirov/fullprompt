import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { accountStatuses } from '@/modules/wms/crm/telegram-accounts';
import { secondsBehind } from '@/modules/wms/crm/telegram-live';
import { BRIDGE_LABELS } from '@/components/telegram-bridge-status';
import { ConnectForm } from './connect-form';

/**
 * «Telegram ulash» — round 21, the owner: «akkauntlarni sistemamizga
 * ulashni osonlashtirishimiz kerak».
 *
 * A manager connects their OWN Telegram here, in the three steps Telegram
 * itself asks for. What used to need the owner at a server terminal
 * (`pnpm tg-login`) is now the manager, their phone, and a minute; the
 * supervisor process picks the new account up on its next scan, so nothing
 * on the server is touched at all.
 */
export const dynamic = 'force-dynamic';

export default async function ConnectPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // The conversations gate: connecting an account is part of the same job.
  if (!actor.permissions.has('crm.leads') && !actor.permissions.has('clients.manage')) {
    redirect('/');
  }

  const t = await getTranslations('crm');
  // Their own account's state, when one exists — the screen doubles as
  // "is MY bridge alive", and reconnecting after a sign-out starts here too.
  const ownAccount = (await accountStatuses()).find((a) => a.managerUserId === actor.id) ?? null;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader
        icon="settings"
        back={{ href: '/suhbatlar', label: t('conversations') }}
        title={`✈️ ${t('connectTitle')}`}
      />
      <p className="text-sm text-ink-500">{t('connectIntro')}</p>

      <ConnectForm />

      {ownAccount && (
        <p className="text-xs text-ink-500">
          {t(BRIDGE_LABELS[ownAccount.state] as 'bridgeLive')} · {ownAccount.tgPhone}
          {ownAccount.state === 'live' &&
            secondsBehind(ownAccount.lastSeenAt, new Date()) !== null &&
            ` · ${t('bridgeSeconds', { n: secondsBehind(ownAccount.lastSeenAt, new Date())! })}`}
        </p>
      )}
    </div>
  );
}
