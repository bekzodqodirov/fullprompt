import { redirect } from 'next/navigation';
import { desc } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { db } from '@/modules/platform/db/client';
import { staffGroupPosts } from '@/modules/platform/db/schema';
import { getSetting } from '@/modules/platform/settings/service';
import { PageHeader } from '@/components/ui/page';
import { activeStaffGroup, knownStaffGroups, type StaffGroup } from '@/modules/platform/telegram/staff-group';
import { groupMediaList } from '@/modules/platform/telegram/staff-group-posts';
import { htmlToPlain } from '@/modules/platform/telegram/format';
import { GoalForm, GroupButton, MediaUpload } from './group-panel';

/**
 * «Jamoa guruhi» (0134, the owner, 2026-10-20) — which Telegram group the bot
 * praises people in, the GIFs it rotates, the team's weekly goal, and what it
 * said there. Its own gate (#198) and every action's; the reads are caught so
 * a half-applied deploy (no 0134) says so in words instead of a white page.
 */
export const dynamic = 'force-dynamic';

const STATUS_CHIP: Record<string, string> = {
  pending: 'chip chip-neutral',
  sending: 'chip chip-warn',
  sent: 'chip chip-good',
  failed: 'chip chip-bad',
  skipped: 'chip chip-neutral',
};

const KINDS = ['client', 'won', 'first_cargo', 'rating', 'champion', 'test'] as const;
const STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;

function present(g: StaffGroup): boolean {
  return g.status !== 'left' && g.status !== 'kicked';
}

export default async function StaffGroupPage() {
  const actor = await getActor();
  if (!actor?.permissions.has('admin.settings.manage')) redirect('/');
  const t = await getTranslations('staffGroup');
  const format = await getFormatter();
  const header = <PageHeader icon="chat" title={t('title')} />;

  let data: {
    active: StaffGroup | null;
    known: StaffGroup[];
    media: Awaited<ReturnType<typeof groupMediaList>>;
    posts: (typeof staffGroupPosts.$inferSelect)[];
    goal: number;
  } | null = null;
  try {
    const [active, known, media, posts, goal] = await Promise.all([
      activeStaffGroup(),
      knownStaffGroups(),
      groupMediaList(),
      db.select().from(staffGroupPosts).orderBy(desc(staffGroupPosts.createdAt)).limit(20),
      getSetting('staff_rating_goal_m3'),
    ]);
    data = { active, known, media, posts, goal: Number(goal) || 0 };
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[staff-group] panel: server behind');
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {header}
        <p className="card text-sm text-bad" data-testid="staff-group-behind">
          {t('serverBehind')}
        </p>
      </div>
    );
  }
  const { active, known, media, posts, goal } = data;
  const others = known.filter((g) => !g.activeFrom && present(g) && g.addedByUserId);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {header}
      <p className="text-sm text-ink-600">{t('intro')}</p>

      <section className="card space-y-2" data-testid="staff-group-status">
        {active ? (
          <>
            <p className="font-semibold text-good [overflow-wrap:anywhere]" data-testid="staff-group-connected">
              {t('connected', { title: active.title || active.chatId.toString() })}
            </p>
            <p className="text-xs text-ink-600">
              {t('facts', {
                members: active.memberCount ?? 0,
                since: format.dateTime(active.activeFrom!, { dateStyle: 'medium' }),
              })}
            </p>
            {active.canPost === false ? (
              <p className="text-xs text-bad [overflow-wrap:anywhere]" data-testid="staff-group-cannot-post">
                {t('cannotPost', { error: active.lastError ?? '—' })}
              </p>
            ) : null}
            <p className="text-xs text-ink-600">{t('everyoneReads')}</p>
            <div className="flex flex-wrap items-start gap-2">
              <GroupButton kind="test" label={t('test')} okText={t('testOk')} testId="staff-group-test" primary />
              <GroupButton kind="rating" label={t('ratingNow')} okText={t('ratingNowOk')} testId="staff-group-rating-now" />
              <GroupButton
                kind="champion"
                label={t('championNow')}
                okText={t('ratingNowOk')}
                testId="staff-group-champion-now"
              />
              <GroupButton
                kind="disconnect"
                label={t('disconnect')}
                confirm={t('disconnectConfirm')}
                testId="staff-group-disconnect"
              />
            </div>
          </>
        ) : (
          <>
            <p className="font-semibold" data-testid="staff-group-not-connected">
              {t('notConnected')}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-600">
              <li>{t('step1')}</li>
              <li>{t('step2')}</li>
              <li>{t('step3')}</li>
            </ol>
          </>
        )}
        {others.length > 0 ? (
          <div className="space-y-2 border-t border-line pt-2">
            <p className="text-xs font-semibold text-ink-600">{t('otherGroups')}</p>
            {others.map((g) => (
              <div key={g.chatId.toString()} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{g.title || g.chatId.toString()}</span>
                <GroupButton
                  kind="connect"
                  arg={g.chatId.toString()}
                  label={t('connect')}
                  confirm={t('connectConfirm', { title: g.title || g.chatId.toString() })}
                  testId={`staff-group-connect-${g.chatId.toString()}`}
                />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card space-y-2" data-testid="staff-group-media">
        <h2 className="section-title">{t('mediaTitle')}</h2>
        <p className="text-xs text-ink-600">{t('mediaHint')}</p>
        {media.length === 0 ? <p className="text-sm text-ink-500">{t('mediaNone')}</p> : null}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {media.map((m) => (
            <li key={m.id} className="space-y-1 rounded-lg border border-line p-2" data-testid="staff-group-media-item">
              {m.contentType === 'video/mp4' ? (
                <video
                  src={`/api/attachments/${m.id}`}
                  className="h-28 w-full rounded object-cover"
                  muted
                  loop
                  autoPlay
                  playsInline
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/attachments/${m.id}`} alt={m.fileName} className="h-28 w-full rounded object-cover" />
              )}
              <p className="truncate text-2xs text-ink-500">{m.fileName}</p>
              <GroupButton
                kind="deleteMedia"
                arg={m.id}
                label={t('mediaDelete')}
                confirm={t('mediaDeleteConfirm')}
                testId={`staff-group-media-delete-${m.id}`}
              />
            </li>
          ))}
        </ul>
        <MediaUpload />
      </section>

      <section className="card space-y-2" data-testid="staff-group-goal-section">
        <h2 className="section-title">{t('goalTitle')}</h2>
        <p className="text-xs text-ink-600">{t('goalHint')}</p>
        <GoalForm initial={goal} />
      </section>

      <section className="card space-y-2" data-testid="staff-group-posts">
        <h2 className="section-title">{t('postsTitle')}</h2>
        {posts.length === 0 ? <p className="text-sm text-ink-500">{t('postsNone')}</p> : null}
        <ul className="space-y-2">
          {posts.map((p) => {
            const kind = (KINDS as readonly string[]).includes(p.kind) ? p.kind : 'test';
            const status = (STATUSES as readonly string[]).includes(p.status) ? p.status : 'pending';
            return (
              <li key={p.id} className="space-y-1 border-b border-line pb-2 text-sm last:border-0" data-testid="staff-group-post">
                <p className="flex flex-wrap items-center gap-2">
                  <span className={STATUS_CHIP[status]}>{t(`status.${status}` as 'status.sent')}</span>
                  <span className="font-semibold">{t(`kind.${kind}` as 'kind.client')}</span>
                  <span className="text-xs text-ink-500">
                    {format.dateTime(p.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </p>
                <p className="line-clamp-2 text-xs text-ink-600 [overflow-wrap:anywhere]">{htmlToPlain(p.html)}</p>
                {p.skipReason ? (
                  <p className="text-xs text-ink-500">{t(`skip.${p.skipReason}` as 'skip.no_group')}</p>
                ) : null}
                {p.status === 'failed' ? (
                  <div className="space-y-1">
                    <p className="text-xs text-bad [overflow-wrap:anywhere]">
                      {p.lastError === 'ambiguous_send' || p.lastError === 'stuck_sending'
                        ? t('maybeSent')
                        : t('lastError', { error: p.lastError ?? '—' })}
                    </p>
                    <GroupButton kind="retry" arg={p.id} label={t('retry')} testId={`staff-group-retry-${p.id}`} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
