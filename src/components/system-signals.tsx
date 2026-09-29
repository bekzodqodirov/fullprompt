import Link from 'next/link';
import type { ReactNode } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Actor } from '@/modules/platform/rbac/authorize';
import {
  TELEGRAM_BACKLOG_MINUTES,
  telegramBotState,
  type TelegramBotState,
} from '@/modules/platform/notifications/service';
import { mayReadSystemErrors, recentErrorCount } from '@/modules/platform/diagnostics/errors';
import { diskSignals, type DiskSignal } from '@/modules/platform/diagnostics/signals';
import { parseDiskDetail } from '@/modules/platform/backup/disk';

/**
 * The system's own state on the owner's home (B9): is the bot delivering,
 * did the server throw, is a disk filling. Rendered INSIDE the admin
 * dashboard's «Signallar» block, beside «yuborilmagan», and each part asks
 * the gate of the screen it links to — the bot line `admin.audit.browse`
 * (/admin/notifications), the error count the super admin role
 * (/admin/xatolar), the disk `admin.settings.manage` (the /admin backup panel).
 *
 * Every read here soft-fails to nothing: the home is the one screen a broken
 * subsystem must not take down with it.
 */

type RowProps = {
  href: string;
  label: string;
  dot?: 'good' | 'warn' | 'bad';
  children: ReactNode;
};

/** «14:02» today, «27.09.26, 14:02» on another day — the moment it began. */
function sinceLabel(since: Date, format: Awaited<ReturnType<typeof getFormatter>>, now: Date): string {
  const recent = now.getTime() - since.getTime() < 20 * 3_600_000;
  return format.dateTime(since, recent ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * The red sentence about the bot, or nothing. One home for the words, read by
 * the dashboard and the /admin/notifications banner, so the two say the same
 * thing about the same state. Never delivered through the bot — the bot is
 * what died.
 */
export async function BotDownLine({
  state,
  href,
  now = new Date(),
}: {
  state: TelegramBotState | null;
  href?: string;
  now?: Date;
}) {
  if (!state?.down) return null;
  const t = await getTranslations('kuzatuv');
  const format = await getFormatter();
  const parts: string[] = [];
  if (state.refused) parts.push(t('botRefused', { since: sinceLabel(new Date(state.refused.since), format, now) }));
  else if (state.noToken) parts.push(t('botNoToken'));
  else {
    const minutes = state.oldestPendingAt
      ? Math.max(TELEGRAM_BACKLOG_MINUTES, Math.floor((now.getTime() - state.oldestPendingAt.getTime()) / 60_000))
      : TELEGRAM_BACKLOG_MINUTES;
    parts.push(t('botBacklog', { minutes }));
  }
  if (state.waiting > 0) parts.push(t('botWaiting', { n: state.waiting }));
  if (state.clientWaiting > 0) parts.push(t('botClientsWaiting', { n: state.clientWaiting }));
  const body = (
    <>
      <span className="font-bold">🔴 {parts.join(' · ')}</span>
      {state.refused?.detail && (
        <span className="block text-2xs opacity-80">{t('botDetail', { detail: state.refused.detail })}</span>
      )}
    </>
  );
  const box =
    'block rounded-lg border border-bad/40 bg-bad/10 px-2 py-1.5 text-xs text-bad [overflow-wrap:anywhere]';
  return href ? (
    <Link href={href} className={`${box} hover:bg-bad/15`} data-testid="bot-down">
      {body}
    </Link>
  ) : (
    <p className={box} data-testid="bot-down">
      {body}
    </p>
  );
}

const DISK_WORD = {
  one: 'diskOne',
  db: 'diskDb',
  photos: 'diskPhotos',
} as const;

/** The rows for the dashboard's signals block. `Row` is the dashboard's own. */
export async function SystemSignals({
  actor,
  Row,
}: {
  actor: Actor;
  Row: (props: RowProps) => ReactNode;
}) {
  const perms = actor.permissions;
  const [bot, errors, disks] = await Promise.all([
    perms.has('admin.audit.browse') ? telegramBotState().catch((): TelegramBotState | null => null) : null,
    mayReadSystemErrors(actor) ? recentErrorCount().catch((): number | null => null) : null,
    perms.has('admin.settings.manage') ? diskSignals().catch((): DiskSignal[] => []) : [],
  ]);
  const t = await getTranslations('kuzatuv');
  // The disk only speaks once a step is crossed; a quiet disk is no row.
  const filling = disks
    .filter((d) => d.level >= 80)
    .map((d) => ({ ...d, parsed: parseDiskDetail(d.detail) }));
  return (
    <>
      <BotDownLine state={bot} href="/admin/notifications" />
      {filling.map((disk) => (
        <Row
          key={disk.key}
          href="/admin"
          label={`${t('homeDisk')} · ${t(DISK_WORD[disk.parsed?.key ?? (disk.key === 'disk:photos' ? 'photos' : 'db')])}`}
          dot={disk.level >= 90 ? 'bad' : 'warn'}
        >
          <span className={disk.level >= 90 ? 'font-bold text-bad' : 'font-bold text-warn'}>
            {disk.parsed?.usedPct ?? disk.level}%
          </span>
        </Row>
      ))}
      {errors !== null && (
        <Row href="/admin/xatolar" label={t('homeErrors')} dot={errors > 0 ? 'warn' : 'good'}>
          <span className={errors > 0 ? 'font-bold text-warn' : 'text-good'} data-testid="adm-errors">
            {errors}
          </span>
        </Row>
      )}
    </>
  );
}
