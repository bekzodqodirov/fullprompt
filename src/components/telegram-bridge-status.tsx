import { getTranslations } from 'next-intl/server';
import { accountStatuses } from '@/modules/wms/crm/telegram-accounts';
import { secondsBehind, type BridgeState } from '@/modules/wms/crm/telegram-live';

/**
 * Whether messages are actually arriving — phase 3's one piece of screen.
 *
 * The failure this exists for is a quiet one. The bridge is a process on a
 * server; when it stops, nothing breaks, no page errors, no message says so.
 * The conversation list simply stops growing, and the first anyone knows is a
 * client asking why nobody answered. So the screen states the bridge's health
 * where the conversations are read, and states it as a HEARTBEAT rather than
 * as "a login exists": a stored session is configuration, not a connection.
 *
 * Nothing renders when no account has been set up, because until somebody runs
 * `pnpm tg-login` this is a feature that does not exist yet, and a permanent
 * grey box saying "not configured" is clutter on every visit (#183's spirit).
 */

/** Each state owns a colour. Lookup map — Tailwind cannot see a class built at runtime. */
const TONE: Record<BridgeState, string> = {
  live: 'bg-good/15 text-good',
  stale: 'bg-warn/15 text-warn',
  never: 'bg-warn/15 text-warn',
  stopped: 'bg-warn/15 text-warn',
  signed_out: 'bg-bad/15 text-bad',
};

/**
 * And a sentence — as a MAP, not a key built from the state at render time.
 *
 * A missing i18n key throws while rendering, in every locale (#163), and a
 * key that only exists as `\`bridge_${state}\`` is invisible to any check: the
 * locale test compares bundles against a source of truth in the code, and a
 * string it cannot see is a string it cannot verify. This map is that source
 * of truth, and `locales.test.ts` reads it.
 */
export const BRIDGE_LABELS: Record<BridgeState, string> = {
  live: 'bridgeLive',
  stale: 'bridgeStale',
  never: 'bridgeNever',
  stopped: 'bridgeStopped',
  signed_out: 'bridgeSignedOut',
};

export async function TelegramBridgeStatus() {
  const now = new Date();
  const accounts = await accountStatuses(now);
  if (accounts.length === 0) return null;

  const t = await getTranslations('crm');
  return (
    <div className="space-y-1.5" data-testid="tg-bridge">
      {accounts.map((account) => {
        const behind = secondsBehind(account.lastSeenAt, now);
        return (
          <div
            key={account.id}
            className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-xl px-3 py-1.5 text-sm ${TONE[account.state]}`}
            data-testid={`tg-bridge-${account.state}`}
          >
            <span className="font-semibold">
              {t(BRIDGE_LABELS[account.state] as 'bridgeLive')}
            </span>
            <span className="min-w-0 flex-1 truncate opacity-80">
              {account.managerName} · {account.tgPhone}
            </span>
            {/* Only when it is running: on a dead bridge the age of the last
                heartbeat is the misleading number, not the useful one. */}
            {account.state === 'live' && behind !== null && (
              <span className="text-xs opacity-70">{t('bridgeSeconds', { n: behind })}</span>
            )}
            {/* A key that no longer opens the stored session is a DIFFERENT
                problem from a dead session, and only this line separates them. */}
            {!account.keyOpens && <span className="text-xs font-bold">{t('bridgeKeyBroken')}</span>}
          </div>
        );
      })}
    </div>
  );
}
