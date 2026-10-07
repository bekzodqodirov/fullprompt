import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { PageHeader } from '@/components/ui/page';
import { CHANNEL_RIGHTS, RIGHT_FLAGS, VET_VERDICTS } from '@/modules/platform/telegram/price-channel-rules';
import { channelPanel, type ChannelPanelData, type PanelChat } from '@/modules/wms/calc/channel-panel';
import { FAIL_REASONS, type PostStatus } from '@/modules/wms/calc/channel-post';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import { ChannelButton, InviteLink } from './channel-panel';

/**
 * «Narx kanali» (the owner's F, 2026-10-07) — where the staff's price channel
 * is connected and watched: whether it is safe (private, no strangers, the bot
 * can post), the join link to hand out, what was posted and what was not, and
 * who the bot let in and took out.
 *
 * Its own gate (#198) and every action's; each read is caught so a
 * half-applied deploy (no 0128) says so in words instead of a white page.
 */
export const dynamic = 'force-dynamic';

/** Status chips through a literal map — Tailwind compiles only classes it can see. */
const STATUS_CHIP: Record<PostStatus, string> = {
  pending: 'chip chip-neutral',
  sending: 'chip chip-warn',
  sent: 'chip chip-good',
  failed: 'chip chip-bad',
  skipped: 'chip chip-neutral',
};

type T = Awaited<ReturnType<typeof getTranslations<'priceChannel'>>>;

/** The chat row's `last_error`, in words: a vet code, a channel refusal, or Telegram's raw sentence. */
function chatErrorWords(t: T, raw: string | null): string | null {
  if (!raw) return null;
  const [code, ...rest] = raw.split(':');
  const detail = rest.join(':');
  if (code === 'has_members') return t('vet.has_members', { count: Number(detail) || 0 });
  if (code === 'vet_failed') return t('vet.vet_failed', { error: detail || '—' });
  if ((VET_VERDICTS as readonly string[]).includes(code ?? '')) return t(`vet.${code}` as 'vet.public');
  if (code === 'channel_refused') return t('lastError', { error: detail || '—' });
  return t('lastError', { error: raw });
}

function ChatFacts({ chat, t }: { chat: PanelChat; t: T }) {
  const words = chatErrorWords(t, chat.lastError);
  return (
    <div className="space-y-1 text-sm">
      <p className="font-semibold [overflow-wrap:anywhere]">
        {chat.title || '—'} <span className="font-mono text-2xs text-ink-500">{chat.chatId}</span>
      </p>
      <p className="text-xs text-ink-600">
        {t('rights')}:{' '}
        {CHANNEL_RIGHTS.map((r) => (
          <span key={r} className="mr-2 inline-block" data-testid={`price-channel-right-${r}`}>
            {chat.rights[RIGHT_FLAGS[r]] ? '✅' : '❌'} {t(`right.${r}` as 'right.post')}
          </span>
        ))}
      </p>
      {chat.missing.length > 0 ? (
        <p className="text-xs text-warn">
          {t('rightsMissing', { list: chat.missing.map((r) => t(`right.${r}` as 'right.post')).join(', ') })}
        </p>
      ) : null}
      {chat.admins.length > 0 ? (
        <p className="text-xs text-ink-600 [overflow-wrap:anywhere]">{t('admins', { names: chat.admins.join(', ') })}</p>
      ) : null}
      {words ? (
        <p className="text-xs text-bad [overflow-wrap:anywhere]" data-testid="price-channel-chat-error">
          {words}
        </p>
      ) : null}
    </div>
  );
}

export default async function PriceChannelPage() {
  const actor = await getActor();
  if (!actor?.permissions.has('admin.settings.manage')) redirect('/');
  const t = await getTranslations('priceChannel');
  const tCalc = await getTranslations('calc');
  const format = await getFormatter();

  let data: ChannelPanelData | null = null;
  try {
    data = await channelPanel();
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[price-channel] panel: server behind');
  }

  const header = <PageHeader icon="chat" title={t('title')} />;
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {header}
        <p className="card text-sm text-bad" data-testid="price-channel-behind">
          {t('serverBehind')}
        </p>
      </div>
    );
  }

  const noPolling = process.env.TELEGRAM_POLLING === '0' && !!process.env.TELEGRAM_BOT_TOKEN;
  const { connected } = data;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {header}
      <p className="text-sm text-ink-600">{t('intro')}</p>

      <section className="card space-y-2" data-testid="price-channel-status">
        {connected ? (
          <>
            <p className="font-semibold text-good" data-testid="price-channel-connected">
              {t('connected', { title: connected.title || connected.chatId })}
            </p>
            <ChatFacts chat={connected} t={t} />
            <ChannelButton
              kind="disconnect"
              label={t('disconnect')}
              confirm={t('disconnectConfirm')}
              testId="price-channel-disconnect"
            />
          </>
        ) : (
          <>
            <p className="font-semibold" data-testid="price-channel-not-connected">
              {t('notConnected')}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="price-channel-setup">
              <li>{t('setup1')}</li>
              <li>{t('setup2')}</li>
              <li>{t('setup3')}</li>
              <li>{t('setup4')}</li>
            </ol>
          </>
        )}
        {data.pause ? (
          <p className="text-sm text-warn" data-testid="price-channel-paused">
            {t(`paused.${data.pause}` as 'paused.no_bot')}
          </p>
        ) : null}
        {noPolling ? <p className="text-sm text-warn">{t('noPolling')}</p> : null}
      </section>

      {connected ? (
        <section className="card space-y-2" data-testid="price-channel-invite">
          <h2 className="font-semibold">{t('linkTitle')}</h2>
          {connected.inviteLink ? (
            <InviteLink value={connected.inviteLink} />
          ) : (
            <p className="text-sm text-ink-500">{t('noLink')}</p>
          )}
          <p className="text-xs text-ink-600">{t('linkNote')}</p>
          <ChannelButton kind="newLink" label={t('newLink')} testId="price-channel-new-link" />
        </section>
      ) : null}

      {data.others.length > 0 ? (
        <section className="card space-y-3" data-testid="price-channel-others">
          <h2 className="font-semibold">{t('otherChats')}</h2>
          {data.others.map((chat) => (
            <div key={chat.chatId} className="space-y-2 border-t border-line pt-2 first:border-0 first:pt-0">
              <ChatFacts chat={chat} t={t} />
              <ChannelButton
                kind="connect"
                arg={chat.chatId}
                label={t('connect')}
                primary
                testId="price-channel-connect"
              />
            </div>
          ))}
        </section>
      ) : null}

      <section className="card space-y-2" data-testid="price-channel-queue">
        <h2 className="font-semibold">{t('queue')}</h2>
        {data.posts.length === 0 ? (
          <p className="text-sm text-ink-500">—</p>
        ) : (
          <ul className="space-y-2">
            {data.posts.map((p) => {
              const failWords =
                p.status === 'failed' && p.lastError
                  ? (FAIL_REASONS as readonly string[]).includes(p.lastError)
                    ? t(`fail.${p.lastError}` as 'fail.stuck_sending')
                    : t('lastError', { error: p.lastError })
                  : null;
              const sectionKey =
                p.section && p.section in SECTION_LABELS
                  ? SECTION_LABELS[p.section as keyof typeof SECTION_LABELS]
                  : null;
              return (
                <li key={p.id} className="space-y-1 text-sm" data-testid="price-channel-post">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className={STATUS_CHIP[p.status]}>{t(`status.${p.status}` as 'status.sent')}</span>
                    <span>{t(`kind.${p.kind}` as 'kind.seal')}</span>
                    {sectionKey ? <span>{tCalc(sectionKey as 'sections.podklyuch')}</span> : null}
                    {p.quoteNo !== null ? <span className="font-mono">V{p.quoteNo}</span> : null}
                    <span className="text-2xs text-ink-500">
                      {format.dateTime(p.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </p>
                  {p.status === 'skipped' && p.skipReason ? (
                    <p className="text-xs text-ink-600">{t(`skip.${p.skipReason}` as 'skip.stale')}</p>
                  ) : null}
                  {p.status === 'pending' && p.lastError ? (
                    <p className="text-xs text-warn [overflow-wrap:anywhere]">{t('lastError', { error: p.lastError })}</p>
                  ) : null}
                  {failWords ? (
                    <div className="space-y-1">
                      <p className="text-xs text-bad [overflow-wrap:anywhere]">{failWords}</p>
                      <ChannelButton kind="retry" arg={p.id} label={t('retry')} testId="price-channel-retry" />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {data.staleCount > 0 ? <p className="text-xs text-ink-600">{t('staleCount', { count: data.staleCount })}</p> : null}
        {data.unmarkedCount > 0 ? (
          <p className="text-xs text-warn">{t('unmarked', { count: data.unmarkedCount })}</p>
        ) : null}
      </section>

      <section className="card space-y-2" data-testid="price-channel-members">
        <p className="font-semibold">{t('members', { count: data.members })}</p>
        <p className="text-xs text-ink-600">{t('membersNote')}</p>
        {data.removals.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {data.removals.map((r, i) => (
              <li key={`${r.name}-${i}`} className="[overflow-wrap:anywhere]">
                {r.name} · {t(`removed.${r.reason}` as 'removed.left')} ·{' '}
                {format.dateTime(r.at, { dateStyle: 'short', timeStyle: 'short' })}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
