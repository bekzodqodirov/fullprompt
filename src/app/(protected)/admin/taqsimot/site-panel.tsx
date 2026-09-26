'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Copyable } from '../../crm/(pages)/kelganlar/doors';
import { saveSiteTeamsAction, type RoutingFormState } from './actions';

/**
 * «Saytdan so'rovlar» (round 113): who answers which website stream, what the
 * website is told right now, and what became of the last visitors.
 *
 * One card per PERSON, stacked, with the three teams as wrapping chips — a
 * table of name + status + three boxes + a username + a load does not fit a
 * 328 px column, and a row wider than the phone rescales the whole page
 * (#400). No box is ever disabled (a disabled box posts nothing and a save
 * would read it as «remove», #171); each card posts its own id, and only the
 * posted ids are written.
 */

export type SiteStatus = 'verified' | 'blind' | 'typed' | 'none' | 'stale';

export interface SitePersonView {
  id: string;
  name: string;
  teams: string[];
  typedUsername: string;
  units: number;
  status: SiteStatus;
  handle: string | null;
  outdated: boolean;
  /** Ticked for the website, or holding a connected Telegram — shown first. */
  featured: boolean;
}

export interface SiteNextView {
  team: string;
  username: string | null;
  name: string | null;
  units: number | null;
  widened: boolean;
}

export interface SiteOfferView {
  id: string;
  at: string;
  team: string;
  topic: string | null;
  username: string;
  offeredName: string;
  tookName: string | null;
  state: 'lead' | 'client' | 'waiting' | 'blind';
  leadId: string | null;
  leadName: string | null;
  clientId: string | null;
  clientCode: string | null;
}

const TEAMS = ['cargo', 'buying', 'general'] as const;

const STATUS_TONE: Record<SiteStatus, string> = {
  verified: 'text-good',
  blind: 'text-warn',
  typed: 'text-warn',
  none: 'text-ink-500',
  stale: 'text-bad',
};

export function SitePanel({
  people,
  next,
  offers,
  contract,
  counters,
}: {
  people: SitePersonView[];
  next: SiteNextView[];
  offers: SiteOfferView[];
  contract: { url: string; origins: string[]; fallback: string[] };
  counters: { answered: number; nobody: number; refused: number };
}) {
  const t = useTranslations('routing');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<RoutingFormState, FormData>(
    saveSiteTeamsAction,
    {},
  );
  const featured = people.filter((p) => p.featured);
  const others = people.filter((p) => !p.featured);

  const status = (person: SitePersonView) => {
    const handle = person.handle ?? '';
    switch (person.status) {
      case 'verified':
        return t('site.statusVerified', { handle });
      case 'blind':
        return t('site.statusBlind', { handle });
      case 'typed':
        return t('site.statusTyped', { handle });
      case 'stale':
        return t('site.statusStale');
      default:
        return t('site.statusNone');
    }
  };

  const card = (person: SitePersonView) => (
    <div
      key={person.id}
      className="space-y-1.5 rounded-xl border border-line p-2"
      data-testid="site-person"
    >
      <input type="hidden" name="person" value={person.id} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="min-w-0 truncate font-semibold">{person.name}</span>
        <span className="text-xs text-ink-500">{t('site.load', { n: person.units })}</span>
      </div>
      <p className={`text-xs ${STATUS_TONE[person.status]}`} data-testid="site-person-status">
        {status(person)}
      </p>
      {person.outdated && (
        <p className="break-words text-xs font-semibold text-bad">{t('site.listenerOutdated')}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {TEAMS.map((team) => (
          <label
            key={team}
            className="flex min-h-11 items-center gap-2 rounded-full border border-line px-3 text-sm"
          >
            <input
              type="checkbox"
              name={`team:${person.id}`}
              value={team}
              defaultChecked={person.teams.includes(team)}
              className="h-5 w-5 shrink-0"
              data-testid={`site-team-${team}`}
            />
            {t(`site.teams.${team}`)}
          </label>
        ))}
      </div>
      <input
        name={`username:${person.id}`}
        defaultValue={person.typedUsername ? `@${person.typedUsername}` : ''}
        placeholder="@username"
        aria-label={t('site.usernameLabel')}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="input"
        data-testid="site-username"
      />
    </div>
  );

  return (
    <section className="card space-y-3" data-testid="site-panel">
      <h2 className="font-semibold">🌐 {t('site.title')}</h2>
      <p className="text-xs text-ink-500">{t('site.hint')}</p>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          {t('site.next')}
        </p>
        <ul className="space-y-0.5 text-sm" data-testid="site-next">
          {next.map((line) => (
            <li key={line.team} className="flex flex-wrap gap-x-1.5">
              <span className="font-medium">{t(`site.teams.${line.team}` as 'site.teams.cargo')} →</span>
              {line.username ? (
                <span>
                  <span className="font-mono">@{line.username}</span>
                  <span className="text-ink-500">
                    {' '}
                    · {line.name} · {t('site.load', { n: line.units ?? 0 })}
                    {line.widened ? ` · ${t('site.nextWidened')}` : ''}
                  </span>
                </span>
              ) : (
                <span className="text-warn">{t('site.nextNobody')}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <form action={formAction} className="space-y-2" data-testid="site-form">
        <p className="text-xs text-ink-500">
          {t('site.teamsHint')} {t('site.usernameHint')}
        </p>
        {featured.map(card)}
        {others.length > 0 && (
          <details className="rounded-xl border border-line p-2">
            <summary className="cursor-pointer text-sm font-semibold text-ink-500">
              {t('site.others', { n: others.length })}
            </summary>
            <div className="mt-2 space-y-2">{others.map(card)}</div>
          </details>
        )}
        {state.error && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {t(`site.errors.${state.error}` as 'site.errors.forbidden')}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          data-testid="site-save"
          className="btn-primary w-full disabled:opacity-50"
        >
          {pending ? tc('loading') : state.ok ? `✅ ${t('site.saved')}` : tc('save')}
        </button>
      </form>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          {t('site.recent')}
        </p>
        {offers.length === 0 ? (
          <p className="text-sm text-ink-500">{t('site.recentEmpty')}</p>
        ) : (
          <ul className="divide-y divide-line text-sm" data-testid="site-offers">
            {offers.map((offer) => (
              <li key={offer.id} className="space-y-0.5 py-1.5">
                <div className="flex flex-wrap gap-x-1.5">
                  <span className="text-ink-500">{offer.at}</span>
                  <span>{t(`site.teams.${offer.team}` as 'site.teams.cargo')}</span>
                  {offer.topic && <span className="text-ink-500">· {offer.topic}</span>}
                  <span className="font-mono">→ @{offer.username}</span>
                </div>
                <p className="text-xs">
                  {offer.state === 'lead' && offer.leadId && (
                    <Link href={`/crm/leads/${offer.leadId}`} className="text-good underline">
                      ✔ {offer.leadName ?? '—'}
                    </Link>
                  )}
                  {offer.state === 'client' && offer.clientId && (
                    <Link href={`/admin/clients/${offer.clientId}`} className="text-good underline">
                      ✔ {t('site.offerClient', { code: offer.clientCode ?? '—' })}
                    </Link>
                  )}
                  {offer.state === 'waiting' && (
                    <span className="text-ink-500">⏳ {t('site.offerWaiting')}</span>
                  )}
                  {offer.state === 'blind' && (
                    <span className="text-warn">📵 {t('site.offerBlind')}</span>
                  )}
                  {offer.tookName && offer.tookName !== offer.offeredName && (
                    <span className="text-ink-500">
                      {' '}
                      · {t('site.offerTook', { name: offer.tookName })}
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <details className="rounded-xl border border-line p-2">
        <summary className="cursor-pointer text-sm font-semibold text-ink-500">
          {t('site.contract')}
        </summary>
        <div className="mt-2 space-y-1.5">
          <Copyable label={t('site.contractUrl')} value={contract.url} />
          <Copyable label={t('site.contractOrigins')} value={contract.origins.join(' ')} />
          <Copyable
            label={t('site.contractFallback')}
            value={contract.fallback.map((u) => `@${u}`).join(' ')}
          />
          <p className="text-xs text-ink-500" data-testid="site-counters">
            {t('site.counters', counters)}
          </p>
        </div>
      </details>
    </section>
  );
}
