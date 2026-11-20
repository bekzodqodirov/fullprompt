import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AGENT_1A_BOUNDS } from '@/modules/platform/settings/service';
import { AGENT_TOPICS } from '@/modules/wms/agent/designations';
import type { AgentConfig } from '@/modules/wms/agent/config';
import { sampleView } from '@/modules/wms/agent/sample';
import { kimgaPanel, type KimgaTopic } from '@/modules/wms/agent/signal-page';
import { BigCargoForm, DesignationEditor, LivenessForm, SampleMarkButtons } from './signal-ui';

/**
 * Stage 1a's two sections of /suhbatlar/ai (§4.5), server components of their own — the page file is shared by four
 * packages, and a block of this one inside another's section would be a conflict in every merge. Read behind the
 * page's door (`mayRunAgent`); each control asks its own narrower one on the server.
 */

type T = Awaited<ReturnType<typeof getTranslations<'agentAi'>>>;

function TopicBlock({ t, topic, panel }: { t: T; topic: KimgaTopic; panel: Awaited<ReturnType<typeof kimgaPanel>> }) {
  const spec = AGENT_TOPICS[topic.topic];
  return (
    <section className="card space-y-2" data-testid={`agent-kimga-${topic.topic}`}>
      <h2 className="section-title">{t(spec.label as 'topic.supervisor')}</h2>
      <p className="text-xs text-ink-500">{t(spec.hint as 'topicHint.supervisor')}</p>
      {topic.stored.length > 0 ? (
        <ol className="space-y-1 text-sm" data-testid="agent-kimga-stored">
          {topic.stored.map((p, i) => (
            <li key={p.id} className="flex flex-wrap items-baseline gap-x-2" data-testid="agent-kimga-person">
              <span className="text-xs text-ink-500">{t('kimgaRank', { n: i + 1 })}</span>
              <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{p.name}</span>
              {p.unreachable && <span className="text-xs font-semibold text-warn">📵 {t('ownerDisconnected')}</span>}
              {p.noPage && (
                <span className="text-xs text-ink-500" data-testid="agent-kimga-no-page">
                  {t('kimgaNoPage')}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        topic.fallback && (
          <p className="text-sm text-warn [overflow-wrap:anywhere]" data-testid="agent-kimga-unset">
            {t('kimgaUnset', {
              names: topic.fallback.names.join(', ') || '—',
              source: t(topic.fallback.source === 'supervisor' ? 'kimgaSource.supervisor' : 'kimgaSource.alarm'),
            })}
          </p>
        )
      )}
      {panel.editable ? (
        <DesignationEditor
          topic={topic.topic}
          stored={topic.stored.map((p) => ({ id: p.id, name: p.name }))}
          candidates={panel.candidates}
          max={panel.max}
        />
      ) : (
        <p className="text-xs text-ink-500">{t('kimgaReadOnly')}</p>
      )}
      {topic.topic === 'big_cargo' && (
        <div className="border-t border-line pt-2">
          <BigCargoForm m3={panel.bigCargo.m3} words={panel.bigCargo.words} editable={panel.editable} max={AGENT_1A_BOUNDS.bigCargoM3Max} />
        </div>
      )}
      {topic.topic === 'supervisor' && (
        <div className="border-t border-line pt-2">
          <LivenessForm
            minutes={panel.livenessMinutes}
            editable={panel.livenessEditable}
            min={AGENT_1A_BOUNDS.livenessMin}
            max={AGENT_1A_BOUNDS.livenessMax}
          />
        </div>
      )}
    </section>
  );
}

/** «Kim javob beradi»: the holder's Telegram first (J28 — the cards go there), then one block per topic. */
export async function KimgaSection({
  viewer,
  config,
}: {
  viewer: { id: string; roles: readonly string[] };
  config: Pick<AgentConfig, 'ownerUserId'>;
}) {
  const t = await getTranslations('agentAi');
  const panel = await kimgaPanel(viewer, config);
  if (!panel.ready) {
    return (
      <p className="card text-sm text-warn" data-testid="agent-kimga-not-ready">
        {t('sampleNotReady')}
      </p>
    );
  }
  return (
    <div className="space-y-3" data-testid="agent-kimga">
      <p className="text-sm text-ink-500">{t('kimgaHint')}</p>
      {panel.holderReachable !== null && (
        <p
          className={`card text-sm [overflow-wrap:anywhere] ${panel.holderReachable ? '' : 'font-semibold text-warn'}`}
          data-testid="agent-kimga-holder"
        >
          {t('kimgaHolderReach', { state: panel.holderReachable ? t('kimgaReachOk') : `📵 ${t('ownerDisconnected')}` })}
        </p>
      )}
      {panel.topics.map((topic) => (
        <TopicBlock key={topic.topic} t={t} topic={topic} panel={panel} />
      ))}
    </div>
  );
}

/** «Kunlik tekshiruv»: the newest sample's replies, then the older ones still unmarked. */
export async function SampleSection({ viewer }: { viewer: { id: string; roles: readonly string[]; permissions?: ReadonlySet<string> } }) {
  const t = await getTranslations('agentAi');
  const view = await sampleView(viewer);
  if (!view.ready) {
    return (
      <p className="card text-sm text-warn" data-testid="agent-sample-not-ready">
        {t('sampleNotReady')}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="agent-sample">
      <p className="text-sm text-ink-500">{t('sampleHint')}</p>
      {view.olderUnmarked > 0 && <p className="text-xs font-semibold text-warn">{t('sampleOlder', { n: view.olderUnmarked })}</p>}
      {view.rows.length === 0 ? (
        <p className="card text-center text-sm text-ink-500" data-testid="agent-sample-empty">
          {t('sampleEmpty')}
        </p>
      ) : (
        view.rows.map((row) => (
          <article key={`${row.day}:${row.draftId}`} className="card space-y-2" data-testid="agent-sample-row" data-draft-id={row.draftId}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-ink-500">
              <span>{row.day.split('-').reverse().join('.')}</span>
              {row.chatHref && (
                <Link href={row.chatHref} className="font-semibold text-brand-700 underline">
                  {t('openChat')}
                </Link>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
              <span className="text-ink-500">{t('sampleCustomer')}: </span>
              {row.customer}
            </p>
            <p className="whitespace-pre-wrap text-sm font-semibold [overflow-wrap:anywhere]">
              <span className="font-normal text-ink-500">{t('sampleReply')}: </span>
              {row.reply}
            </p>
            {row.mark === 'good' ? (
              <p className="text-sm font-semibold text-good" data-testid="agent-sample-marked" data-mark="good">
                👍 {t('sampleMarkedGood')}
              </p>
            ) : row.mark === 'bad' ? (
              <p className="text-sm font-semibold text-bad" data-testid="agent-sample-marked" data-mark="bad">
                👎 {t('sampleMarkedBad')}
              </p>
            ) : (
              row.mayMark && <SampleMarkButtons day={row.day} draftId={row.draftId} />
            )}
          </article>
        ))
      )}
    </div>
  );
}
