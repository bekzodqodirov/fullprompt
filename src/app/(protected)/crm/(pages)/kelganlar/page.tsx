import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inboundDoors, intakesBySource, recentIntakes } from '@/modules/wms/crm/inbound';
import { funnelReport } from '@/modules/wms/crm/service';
import { PageHeader, Section } from '@/components/ui/page';
import { Panel } from '@/components/panel';
import { MetaLine } from '@/components/board-meta';
import { getBotUsername } from '@/modules/platform/telegram/bot';
import { InboundDoors, type DoorView } from './doors';

/**
 * Everything an advert sent us, including what it did NOT turn into.
 *
 * This is the screen `lead_intakes` exists for. The funnel can only show
 * leads, so the day an advert produces nothing it looks exactly like the day
 * nobody clicked — and the difference between «no enquiries» and «twenty
 * enquiries that were all the same number» is the difference between a bad
 * campaign and a broken form. Every arrival is here with what became of it.
 *
 * Gated on `crm.manage`, the same door as the funnel's own settings: the
 * ledger names people who are not leads and not clients, and reading it is a
 * supervision job, not a selling one.
 */

const OUTCOME_CLASS: Record<string, string> = {
  created: 'chip-good',
  joined: 'chip-neutral',
  client: 'chip-neutral',
  dropped: 'chip-warn',
};

export default async function ArrivalsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.manage')) redirect('/crm');
  const t = await getTranslations('crm');
  const [rows, doorRows, arrivals, funnel, botName] = await Promise.all([
    recentIntakes(100),
    inboundDoors(),
    intakesBySource(),
    funnelReport(),
    // The cached getMe the client card already uses — inventing an env var for
    // a name the bot can be asked for is a second source of truth.
    getBotUsername(),
  ]);

  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  const doors: DoorView[] = doorRows.map((door) => ({
    key: door.key,
    name: door.name,
    formUrl: `${appUrl}/ariza?manba=${door.key}`,
    // The bot's third door only exists once the bot has a name to link to.
    botUrl: botName ? `https://t.me/${botName}?start=ad_${door.key}` : null,
    webhookUrl: `${appUrl}/api/leads/in/${door.key}`,
    secret: door.secret,
  }));

  /**
   * Arrivals and money, per source, joined in JS over two grouped queries.
   *
   * The two halves answer different questions and neither replaces the other:
   * ARRIVALS counts what the advert actually sent, including the twenty copies
   * of one number that became nothing, while WON counts what it earned. A
   * source with many arrivals and no leads is a broken form; few arrivals and
   * good money is a channel to spend more on.
   */
  const byKey = new Map(arrivals.map((row) => [row.sourceKey, row]));
  const results = doors
    .map((door) => {
      const arrival = byKey.get(door.key);
      const funnelRow = funnel.sources.find((row) => row.name === door.name);
      return {
        key: door.key,
        name: door.name,
        arrivals: arrival?.arrivals ?? 0,
        dropped: arrival?.dropped ?? 0,
        won: funnelRow?.won ?? 0,
        winRate: funnelRow?.winRate ?? 0,
        wonUsd: funnelRow?.wonUsd ?? 0,
      };
    })
    .filter((row) => row.arrivals > 0 || row.won > 0)
    .sort((a, b) => b.wonUsd - a.wonUsd || b.arrivals - a.arrivals);

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-4xl">
      <PageHeader icon="target" title={t('arrivals')} />

      <Panel title={`🔗 ${t('doors')}`} testId="doors-panel">
        <p className="mb-2 text-xs text-ink-500">{t('doorsHint')}</p>
        <InboundDoors doors={doors} canManage={actor.permissions.has('admin.settings.manage')} />
      </Panel>

      {results.length > 0 && (
        <Section title={t('sourceResult')}>
          <ul className="space-y-2" data-testid="source-results">
            {results.map((row) => (
              <li key={row.key} className="card space-y-0 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                    {row.name}
                  </span>
                  {/* The only mono line on the row, as every card in this app
                      spends money (#578): identity is bold, money is mono. */}
                  <span className="shrink-0 font-mono text-sm tabular-nums">
                    {row.wonUsd ? `$${row.wonUsd.toLocaleString('ru-RU')}` : '—'}
                  </span>
                </div>
                <MetaLine
                  parts={[
                    t('sourceArrivals', { n: row.arrivals }),
                    row.dropped ? t('sourceDropped', { n: row.dropped }) : null,
                    t('sourceWon', { n: row.won }),
                    row.winRate ? `${row.winRate}%` : null,
                  ]}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {rows.length === 0 ? (
        <p className="card text-sm text-ink-500">{t('arrivalsEmpty')}</p>
      ) : (
        // A LIST, not a table. Six columns needed 620 px and the phone showed
        // the first three — so «what became of it», the one thing this screen
        // exists to answer, was the part off the right-hand edge. The board
        // cards' vocabulary instead: identity and verdict on one line, every
        // small fact on the muted row under it (#578).
        <ul className="space-y-2" data-testid="arrivals-rows">
          {rows.map((row) => {
            // The card it became, when it became one. A dropped arrival has
            // nowhere to go, and saying so is the point of the row.
            const href = row.leadId
              ? `/crm/leads/${row.leadId}`
              : row.clientId
                ? `/admin/clients/${row.clientId}`
                : null;
            return (
              <li key={row.id} className="card space-y-0 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                    {href ? (
                      <Link href={href} className="link">
                        {row.name ?? row.phone ?? '—'}
                      </Link>
                    ) : (
                      (row.name ?? row.phone ?? '—')
                    )}
                  </span>
                  <span className={`shrink-0 ${OUTCOME_CLASS[row.outcome] ?? 'chip-neutral'}`}>
                    {t(`arrivalsOutcome_${row.outcome}` as 'arrivalsOutcome_created')}
                  </span>
                </div>
                <MetaLine
                  parts={[
                    `${row.createdAt.toLocaleDateString('ru-RU')} ${row.createdAt.toLocaleTimeString(
                      'ru-RU',
                      { hour: '2-digit', minute: '2-digit' },
                    )}`,
                    row.sourceKey,
                    row.channel,
                    row.phone,
                    row.ownerName,
                    row.reason,
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
