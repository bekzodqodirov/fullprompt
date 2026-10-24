import { getTranslations } from 'next-intl/server';
import { accountStatuses } from '@/modules/wms/crm/telegram-accounts';
import { secondsBehind, type BridgeState } from '@/modules/wms/crm/telegram-live';
import { pausedAccounts } from '@/modules/wms/agent/web-page';
import { ClearPauseButton } from './clear-pause-button';

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

export async function TelegramBridgeStatus({
  viewer,
}: {
  /** Who is reading — the pause's «Tekshirdim» is drawn for the account's own manager and the super_admin role. */
  viewer?: { id: string; roles: readonly string[] };
} = {}) {
  const now = new Date();
  const accounts = await accountStatuses(now);
  if (accounts.length === 0) return null;

  const t = await getTranslations('crm');
  /**
   * A PAUSED account (0136, review regression-11): Telegram said the account
   * is limited (PEER_FLOOD, a restriction, a freeze), and every send from it
   * — the CRM's human replies included — waits until a person who looked
   * says so. A heartbeat cannot show it (the listener is alive and running),
   * so it is its own red line under the account, with the «Tekshirdim» for
   * whoever may clear it. The fold stays SHUT (his round-98 word: «boshidan
   * folded turishi kerak»); the summary line carries the alarm instead — red,
   * and counting the paused accounts — exactly as it does for a signed-out one.
   */
  const paused = await pausedAccounts();
  const mayClear = (managerUserId: string) =>
    viewer !== undefined && (viewer.id === managerUserId || viewer.roles.includes('super_admin'));
  const pausedHere = accounts.filter((a) => paused.has(a.id));

  /**
   * One line, not one banner per phone.
   *
   * The owner, with three accounts connected: «ulangan ishchilar ro'yhati
   * juda katta joy olyabti bunday bolmasin» — and his screenshot showed three
   * full-width coloured bars stacked above the search box, which is the whole
   * top of a phone screen spent on something that is fine on most days. The
   * fold idiom of this codebase (chat-menu, ThreadManagers) applies exactly:
   * a summary that states the worst thing, and the detail one tap away.
   *
   * It used to open ITSELF for a signed-out account, on the reasoning that a
   * job hidden behind a fold waits a week. The owner overruled it from his own
   * screen (round 98: «ulangan akkauntlar ro'yxati boshidan folded turishi
   * kerak») — one manager had been signed_out for days, so the panel stood
   * open on EVERY visit, which is the round-91 complaint reborn. The alarm
   * does not need the fold: the summary line itself goes red and counts the
   * broken accounts, so the job still shouts — it just does it in one line.
   */
  const needsAction = accounts.filter((a) => a.state === 'signed_out');
  const unwell = accounts.filter((a) => a.state !== 'live');
  const worst: BridgeState = needsAction.length > 0 ? 'signed_out' : unwell.length > 0 ? 'stale' : 'live';

  return (
    <details className="text-sm" data-testid="tg-bridge">
      <summary
        className={`flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 rounded-xl px-3 py-1.5 ${
          pausedHere.length > 0 ? TONE.signed_out : TONE[worst]
        }`}
        data-testid={`tg-bridge-${worst}`}
      >
        {pausedHere.length > 0 && (
          <span className="font-bold" data-testid="tg-bridge-paused">
            ⛔ {t('bridgePausedCount', { n: pausedHere.length })}
          </span>
        )}
        <span className="font-semibold">
          {worst === 'live'
            ? t(BRIDGE_LABELS.live as 'bridgeLive')
            : t(BRIDGE_LABELS[worst] as 'bridgeLive')}
        </span>
        <span className="min-w-0 flex-1 truncate opacity-80">
          {/* «3 ta akkaunt» when all is well, «1 / 3» when it is not: the
              number a reader needs is how many are broken, out of how many. */}
          {worst === 'live'
            ? t('bridgeAccounts', { n: accounts.length })
            : `${unwell.length} / ${accounts.length}`}
        </span>
      </summary>

      <div className="mt-1.5 space-y-1" data-testid="tg-bridge-detail">
        {accounts.map((account) => {
          const behind = secondsBehind(account.lastSeenAt, now);
          const pause = paused.get(account.id);
          return (
            <div
              key={account.id}
              className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-xl px-3 py-1.5 ${TONE[account.state]}`}
              data-testid={`tg-bridge-account-${account.state}`}
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
              {!account.keyOpens && (
                <span className="text-xs font-bold">{t('bridgeKeyBroken')}</span>
              )}
              {pause && (
                <div
                  className="mt-1 flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-bad/15 px-2 py-1.5 text-bad"
                  data-testid="tg-bridge-pause"
                >
                  <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                    ⛔ {t('bridgePaused')}
                    {pause.pauseReason ? `: ${pause.pauseReason}` : ''}
                  </span>
                  {mayClear(account.managerUserId) && <ClearPauseButton accountId={account.id} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
