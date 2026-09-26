import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { clientTagOptions, splitTags } from '@/modules/platform/clients/service';
import {
  audienceChats,
  audienceSchema,
  mayBroadcast,
  recentBroadcasts,
  type Audience,
} from '@/modules/platform/broadcast/service';
import { ageOn, birthdaysOn } from '@/modules/platform/broadcast/birthdays';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { PageHeader } from '@/components/ui/page';
import { AutoRefresh } from '@/components/auto-refresh';
import { BroadcastComposer } from './composer';

/**
 * «Telegram xabar» — the office writing to its clients through the bot (his
 * item 6, 2026-09-26). One GET form draws the audience from the words on the
 * client cards (trade, cargo kinds, language, seller) or from codes typed
 * outright, and the page says how many chats that is BEFORE anything is
 * written; the composer below sends to exactly that. Today's birthdays sit
 * on top with a link that fills the codes box with one client.
 *
 * The super admin's alone (his 6a), asked by `mayBroadcast` here and in the
 * action.
 */
const list = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : []).map((v) => v.trim()).filter(Boolean);

export default async function BroadcastPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayBroadcast(actor)) redirect('/');
  const t = await getTranslations('broadcast');
  const format = await getFormatter();
  const params = await searchParams;

  // Every value read back out of the URL is validated (#514): a garbage
  // manager id or language is dropped, never a 500.
  const parsed = audienceSchema.safeParse({
    sectors: list(params.soha),
    cargoKinds: list(params.yuk),
    locales: list(params.til).filter((v) => ['uz', 'ru', 'en'].includes(v)),
    managerId: typeof params.hodim === 'string' && params.hodim ? params.hodim : undefined,
    codes: splitTags(typeof params.kod === 'string' ? params.kod : ''),
    query: typeof params.q === 'string' && params.q.trim() ? params.q.trim().slice(0, 100) : undefined,
  });
  const audience: Audience = parsed.success
    ? parsed.data
    : { sectors: [], cargoKinds: [], locales: [], codes: [] };

  const today = tashkentDay();
  const [chats, tags, managers, recent, birthdays] = await Promise.all([
    audienceChats(audience),
    clientTagOptions(),
    salesManagerOptions(),
    recentBroadcasts(),
    birthdaysOn(today),
  ]);
  const running = recent.some((b) => !b.finishedAt);
  const filtered =
    audience.sectors.length + audience.cargoKinds.length + audience.locales.length + audience.codes.length > 0 ||
    Boolean(audience.managerId) ||
    Boolean(audience.query);

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader icon="chat" title={t('title')} />
      {running && <AutoRefresh ms={5_000} />}

      {birthdays.length > 0 && (
        <section className="card space-y-1 !p-3" data-testid="broadcast-birthdays">
          <p className="font-semibold">🎂 {t('birthdaysToday')}</p>
          <ul className="space-y-1 text-sm">
            {birthdays.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-bold">{b.clientCode}</span>
                <span className="min-w-0 truncate">{b.name}</span>
                {ageOn(b.birthday, today) && (
                  <span className="text-xs text-ink-500">{t('age', { n: ageOn(b.birthday, today)! })}</span>
                )}
                <Link
                  href={`/admin/xabarlar?kod=${encodeURIComponent(b.clientCode)}`}
                  className="ml-auto text-xs font-semibold text-brand-700"
                  data-testid="broadcast-congratulate"
                >
                  🎉 {t('congratulate')} →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The audience: one GET form, so the choice is in the address bar. */}
      <form className="card space-y-3 !p-3" data-testid="broadcast-audience">
        <p className="font-semibold">👥 {t('audience')}</p>
        <label className="block text-sm">
          <span className="label">🔎 {t('search')}</span>
          <input
            name="q"
            type="search"
            className="input"
            defaultValue={audience.query ?? ''}
            placeholder={t('searchPlaceholder')}
            data-testid="broadcast-search"
          />
        </label>
        <label className="block text-sm">
          <span className="label">{t('codes')}</span>
          <input
            name="kod"
            className="input"
            defaultValue={audience.codes.join(', ')}
            placeholder="GS123, GS456"
            data-testid="broadcast-codes"
          />
        </label>
        {tags.sectors.length > 0 && (
          <fieldset className="text-sm">
            <legend className="label">{t('sectors')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {tags.sectors.map((v) => (
                <label key={v} className="chip chip-neutral cursor-pointer gap-1">
                  <input type="checkbox" name="soha" value={v} defaultChecked={audience.sectors.includes(v)} />
                  {v}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {tags.cargoKinds.length > 0 && (
          <fieldset className="text-sm">
            <legend className="label">{t('cargoKinds')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {tags.cargoKinds.map((v) => (
                <label key={v} className="chip chip-neutral cursor-pointer gap-1">
                  <input type="checkbox" name="yuk" value={v} defaultChecked={audience.cargoKinds.includes(v)} />
                  {v}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="text-sm">
            <legend className="label">{t('language')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {(['uz', 'ru', 'en'] as const).map((v) => (
                <label key={v} className="chip chip-neutral cursor-pointer gap-1">
                  <input type="checkbox" name="til" value={v} defaultChecked={audience.locales.includes(v)} />
                  {v.toUpperCase()}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm">
            <span className="label">{t('seller')}</span>
            <select name="hodim" className="input" defaultValue={audience.managerId ?? ''}>
              <option value="">{t('anySeller')}</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-secondary">
            {t('apply')}
          </button>
          {filtered && (
            <Link href="/admin/xabarlar" className="text-sm text-brand-700">
              {t('clear')}
            </Link>
          )}
        </div>
        <p className="text-sm font-semibold" data-testid="broadcast-count">
          {filtered ? t('countFiltered', { n: chats.length }) : t('countAll', { n: chats.length })}
        </p>
      </form>

      {/* Who is found is who gets it — each one a tick the office can take
          off before writing (his item 4: «topib habar yozish imkoni»). */}
      <BroadcastComposer
        audience={audience}
        recipients={chats.map((c) => ({ code: c.clientCode, name: c.clientName }))}
      />

      {recent.length > 0 && (
        <section className="card !p-3" data-testid="broadcast-history">
          <p className="font-semibold">🕘 {t('history')}</p>
          <ul className="mt-2 space-y-2 text-sm">
            {recent.map((b) => (
              <li key={b.id} className="border-b border-line pb-2 last:border-0">
                <p className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs text-ink-500">
                    {format.dateTime(new Date(b.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                  <span className="font-mono text-xs">
                    {t('progress', { sent: b.sent, failed: b.failed, total: b.total })}
                  </span>
                  {!b.finishedAt && <span className="chip chip-warn">⏳ {t('sending')}</span>}
                </p>
                {b.body && <p className="line-clamp-2 whitespace-pre-line text-ink-700">{b.body}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
