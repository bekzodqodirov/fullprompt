import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { AUTO_SEND_CATEGORIES } from '@/modules/wms/agent/auto-categories';
import { AUTO_PER_DAY_MAX } from '@/modules/wms/agent/auto-send';
import { agentRunning, mayRunAgent, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { LESSON_LIMITS } from '@/modules/wms/agent/lesson-rules';
import { webLessons } from '@/modules/wms/agent/lessons';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { readSendCaps, SEND_CAP_BOUNDS } from '@/modules/wms/agent/send-caps';
import { SITE_TARIFF } from '@/modules/wms/agent/site-estimate';
import { currentTariffFingerprint, tariffUnconfirmed } from '@/modules/wms/agent/tariff-watch';
import { AGENT_PAGE } from '@/modules/wms/agent/web-door';
import { cancellable } from '@/modules/wms/agent/web-thread';
import {
  agentRules,
  agentToday,
  autoPanel,
  openCalcsFor,
  ownerAccountState,
  ownerCandidates,
  pageDrawsSend,
  tariffMismatchSeen,
  userName,
  webDrafts,
  webKbFacts,
  webStats,
  type AutoPanel,
  type AutoSentRow,
  type WebDraft,
  type WebViewer,
} from '@/modules/wms/agent/web-page';
import { PageHeader } from '@/components/ui/page';
import { AgentCancelButton } from '@/components/agent-cancel-button';
import { ClearPauseButton } from '@/components/clear-pause-button';
import { agentSendAtLabel } from '@/components/agent-waiting-bubble';
import {
  AutoArmButtons,
  AutoBadButton,
  AutoCategoriesForm,
  AutoPerDayForm,
  AviaRateForm,
  DraftActions,
  FactEditor,
  FactForm,
  LessonButton,
  LessonEditor,
  ModeSwitch,
  NumbersForm,
  OwnerPicker,
  RememberButtons,
  RetireButton,
  SendCapsForm,
  SessionConfirm,
  TariffConfirmButton,
  StyleApprove,
} from './agent-ui';
import {
  AGENT_SECTIONS,
  PAUSE_KIND_KEYS,
  autoDisarmKey,
  SCOPE_KEYS,
  SECTION_KEYS,
  categoryKey,
  sectionOf,
  sourceKey,
  type AgentSection,
} from './labels';
import type { PauseKind } from '@/modules/wms/crm/telegram-guard';

/**
 * The AI sotuvchi's page (docs/AI-SOTUVCHI.md §17.12, review build-13): ONE
 * route, five parts — what waits for his ✅, what the agent asked HIM, what
 * it may state as fact, what he taught it («Saboqlar», 0148), and the switches.
 *
 * The door is `mayRunAgent` (fit-11): the configured owner — whose working
 * account is «bir admin va sotuvchi», not necessarily a super_admin — or the
 * super_admin ROLE. Inside, a draft is decided by its ACCOUNT HOLDER alone
 * (leak-5): a super_admin reads every card and is told whose decision it is,
 * and no ✅ is drawn for him. Reading another account's cards and customer
 * facts is the Telegram supervision view's (`seesAllTg`, final review K10) —
 * a configured owner without it reads his own account's only.
 *
 * A draft's card is the bot's card (`renderDraftCard` over the stored row),
 * so the two doors read the same words — in Uzbek, as the bot writes them.
 * The page's own chrome is in the reader's language.
 */
export const dynamic = 'force-dynamic';

function tashkentWhen(d: Date): string {
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tashkent',
  });
}

const STRIP = 'grid grid-cols-2 gap-1 rounded-xl bg-surface-sunken p-1 sm:grid-cols-5';

type T = Awaited<ReturnType<typeof getTranslations<'agentAi'>>>;

function DraftCard({ d, viewerId, t }: { d: WebDraft; viewerId: string; t: T }) {
  return (
    <article className="card space-y-2" data-testid="agent-draft" data-draft-id={d.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-ink-500">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t('holderLine', { name: d.holderName, when: tashkentWhen(d.createdAt) })}
        </span>
        {d.chatHref && (
          <Link href={d.chatHref} className="font-semibold text-brand-700 underline" data-testid="agent-open-chat">
            {t('openChat')}
          </Link>
        )}
      </div>
      <pre
        className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-900 [overflow-wrap:anywhere]"
        data-testid="agent-card-text"
      >
        {d.cardText}
      </pre>
      <DraftActions
        draftId={d.id}
        digest={d.digest}
        body={d.body}
        holder={d.managerUserId === viewerId}
        holderName={d.holderName}
        canSend={pageDrawsSend(d)}
        waitingInChat={d.waitingInChat}
        autoWaiting={d.autoWaiting}
      />
      {/* «📝 Tuzatish» wherever the words are the machine's — for everybody the page admits; only the holder's
          lesson on a reply still waiting also rewrites it (spec SPEC-P1-v2 §3.1, §3.4). ONE expression before and
          after his save: the save marks the reply as being rewritten (`teach` false) and revalidates, and its answer
          — which older lesson fell out of the prompt — lives in this component's state: unmounted, it was on
          screen for a fifth of a second. While rewriting, the place stays and only the opener goes. */}
      {(d.teach || d.lessonRewriting) && (
        <LessonButton draftId={d.id} teach={d.teach} rewrites={d.lessonRewrites && d.managerUserId === viewerId} />
      )}
    </article>
  );
}

function Empty({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="card text-center text-sm text-ink-500" data-testid={testId}>
      {text}
    </p>
  );
}

function Line({ label, value, tone = '' }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
      <span className="text-ink-500">{label}</span>
      <span className={`font-semibold tabular-nums [overflow-wrap:anywhere] ${tone}`}>{value}</span>
    </div>
  );
}

export default async function AgentPage({ searchParams }: { searchParams: Promise<{ bolim?: string }> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const config = await readAgentConfig();
  // Own gate (#198): the configured owner or the super_admin ROLE.
  if (!mayRunAgent(actor, config)) redirect('/');
  const section = sectionOf((await searchParams).bolim);
  const t = await getTranslations('agentAi');
  const tcrm = await getTranslations('crm');

  const header = (subtitle: string) => (
    <PageHeader
      icon="chat"
      back={{ href: '/suhbatlar', label: tcrm('conversations') }}
      title={`🤖 ${t('title')}`}
      subtitle={subtitle}
    />
  );

  // 0138 has not landed: the page exists (the menu offers it to a
  // super_admin), the agent does not — say so, never a 42P01.
  if (!config) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        {header(t('stateOff'))}
        <p className="card text-sm text-warn" data-testid="agent-not-ready">
          {t('notReady')}
        </p>
      </div>
    );
  }

  const running = agentRunning(config);
  const [drafts, owner] = await Promise.all([webDrafts(actor), ownerAccountState(config.ownerUserId)]);
  const counts: Record<AgentSection, number> = {
    kutilmoqda: drafts.pending.length,
    savollar: drafts.questions.length + drafts.remember.length,
    bilimlar: 0,
    saboqlar: 0,
    sozlamalar: 0,
  };
  const settingsAlarm = owner?.pausedAt != null || (running && (owner?.connected === false || owner?.listenerBehind === true));

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {header(running ? t('stateRunning') : t('stateOff'))}

      {owner?.pausedAt && (
        <div className="card space-y-1 border-bad/40 bg-bad/10 text-bad" data-testid="agent-paused-banner">
          <p className="font-bold">⛔ {t('pausedTitle')}</p>
          <p className="text-sm [overflow-wrap:anywhere]">
            {owner.pausedKind ? t(PAUSE_KIND_KEYS[owner.pausedKind as PauseKind] as 'pause.peer_flood') : ''}
            {owner.pauseReason ? ` — ${owner.pauseReason}` : ''} · {tashkentWhen(owner.pausedAt)}
          </p>
          {(actor.id === config.ownerUserId || actor.roles.includes('super_admin')) && (
            <ClearPauseButton accountId={owner.accountId} />
          )}
        </div>
      )}

      <nav aria-label={t('title')} className={STRIP} data-testid="agent-tabs">
        {AGENT_SECTIONS.map((key) => {
          const lit = key === section;
          const n = counts[key];
          return (
            <Link
              key={key}
              href={key === 'kutilmoqda' ? AGENT_PAGE : `${AGENT_PAGE}?bolim=${key}`}
              data-testid={`agent-tab-${key}`}
              aria-current={lit ? 'page' : undefined}
              className={`flex min-h-11 min-w-0 flex-wrap items-center justify-center gap-x-1.5 rounded-lg px-2 py-1 text-center text-sm font-semibold ${
                lit ? 'bg-surface-raised text-ink-900 shadow-card' : 'text-ink-700 hover:bg-surface-raised/60'
              }`}
            >
              {t(SECTION_KEYS[key] as 'section.kutilmoqda')}
              {n > 0 && <span className="rounded-full bg-warn/15 px-1.5 text-xs font-bold text-warn">{n}</span>}
              {key === 'sozlamalar' && settingsAlarm && <span className="text-bad">⚠</span>}
            </Link>
          );
        })}
      </nav>

      {section === 'kutilmoqda' && (
        <>
          <section className="space-y-2" data-testid="agent-pending">
            {drafts.pending.length === 0 ? (
              <Empty text={running ? t('pendingEmpty') : t('pendingEmptyOff')} testId="agent-pending-empty" />
            ) : (
              drafts.pending.map((d) => <DraftCard key={d.id} d={d} viewerId={actor.id} t={t} />)
            )}
          </section>
          {drafts.waiting.length > 0 && (
            <section className="space-y-2" data-testid="agent-waiting-list">
              <h2 className="section-title">{t('waitingTitle')}</h2>
              {drafts.waiting.map((d) => {
                const at = d.outbox ? agentSendAtLabel(d.outbox.nextStepAt) : null;
                return (
                  <article key={d.id} className="card space-y-2" data-testid="agent-waiting-draft">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-brand-700">
                      <span>{at ? tcrm('agentWaitingAt', { time: at }) : tcrm('agentSending')}</span>
                      {d.outbox && d.managerUserId === actor.id && cancellable(d.outbox) && (
                        <AgentCancelButton outboxId={d.outbox.id} />
                      )}
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-sm text-ink-900 [overflow-wrap:anywhere]">
                      {d.cardText}
                    </pre>
                    {d.teach && <LessonButton draftId={d.id} teach rewrites={false} />}
                  </article>
                );
              })}
            </section>
          )}
        </>
      )}

      {section === 'savollar' && (
        <>
          <p className="text-sm text-ink-500">{t('questionsHint')}</p>
          <section className="space-y-2" data-testid="agent-questions">
            {drafts.questions.length === 0 ? (
              <Empty text={t('questionsEmpty')} testId="agent-questions-empty" />
            ) : (
              drafts.questions.map((d) => <DraftCard key={d.id} d={d} viewerId={actor.id} t={t} />)
            )}
          </section>
          {drafts.remember.length > 0 && (
            <section className="space-y-2" data-testid="agent-remember">
              <h2 className="section-title">{t('rememberTitle')}</h2>
              <p className="text-sm text-ink-500">{t('rememberHint')}</p>
              {drafts.remember.map((d) => (
                <article key={d.id} className="card space-y-2" data-testid="agent-remember-draft">
                  <pre className="whitespace-pre-wrap font-sans text-sm text-ink-900 [overflow-wrap:anywhere]">
                    {d.cardText}
                  </pre>
                  {d.managerUserId === actor.id ? (
                    <RememberButtons draftId={d.id} armToken={d.kbArmToken} />
                  ) : (
                    <p className="text-xs text-ink-500">{t('notHolder', { name: d.holderName })}</p>
                  )}
                  {d.teach && <LessonButton draftId={d.id} teach rewrites={false} />}
                </article>
              ))}
            </section>
          )}
        </>
      )}

      {section === 'bilimlar' && <KnowledgeSection t={t} config={config} viewer={actor} />}

      {section === 'saboqlar' && <LessonsSection t={t} />}

      {section === 'sozlamalar' && (
        <SettingsSection
          t={t}
          config={config}
          running={running}
          actor={actor}
          owner={owner}
        />
      )}
    </div>
  );
}

/**
 * «AI qoidalari» (§17.14 e): what the agent follows that is not a fact — the
 * truck's minimum, avia's minimum, time and rate, rail, the certificate. Every
 * number is `agentRules`, i.e. the constant or the config the agent itself
 * reads; the avia rate is the one editable here (the page's own door, the
 * owner or the super_admin role, is `setAviaRate`'s too).
 */
function RulesCard({ t, config }: { t: T; config: AgentConfig }) {
  const rules = agentRules(config);
  const { avia, truckMin } = rules;
  return (
    <section className="card space-y-2" data-testid="agent-rules">
      <h2 className="section-title">{t('rulesTitle')}</h2>
      <p className="text-xs text-ink-500">{t('rulesHint')}</p>
      <ul className="space-y-1.5 text-sm [overflow-wrap:anywhere]">
        <li data-testid="agent-rule-truck">🚚 {t('ruleTruckMin', { m3: truckMin.m3, kg: truckMin.kg })}</li>
        <li data-testid="agent-rule-avia">
          ✈️ {t('ruleAviaMin', { kg: avia.minKg, min: avia.daysMin, max: avia.daysMax })}
        </li>
        <li data-testid="agent-rule-avia-kg">📦 {t('ruleAviaActualKg')}</li>
        <li data-testid="agent-rule-avia-rate">
          💵 {t('ruleAviaRate')}:{' '}
          <span className="font-semibold">
            {avia.usdPerKg === null ? t('ruleAviaRateNone') : t('ruleAviaRateValue', { rate: avia.usdPerKg })}
          </span>
          {avia.setAt && (
            <span className="text-xs text-ink-500"> · {t('ruleAviaRateSetAt', { when: tashkentWhen(avia.setAt) })}</span>
          )}
        </li>
        <li data-testid="agent-rule-rail">🚆 {t('ruleRail')}</li>
        <li data-testid="agent-rule-certificate">📄 {t('ruleCertificate')}</li>
      </ul>
      <AviaRateForm current={avia.usdPerKg} />
    </section>
  );
}

async function KnowledgeSection({ t, config, viewer }: { t: T; config: AgentConfig; viewer: WebViewer }) {
  // A customer's fact is seen by whoever may read that chat (K10, `factSeenBySql`).
  const { facts, retired } = await webKbFacts(viewer);
  return (
    <>
      <RulesCard t={t} config={config} />
      <p className="text-sm text-ink-500">{t('knowledgeHint')}</p>
      <FactForm />
      <section className="space-y-2" data-testid="agent-facts">
        {facts.length === 0 ? (
          <Empty text={t('factsEmpty')} testId="agent-facts-empty" />
        ) : (
          facts.map((f) => (
            <article key={f.id} className="card space-y-1" data-testid="agent-fact">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className={f.scope === 'general' ? 'chip chip-brand' : 'chip chip-neutral'}>
                  {t(SCOPE_KEYS[f.scope] as 'scope.general')}
                </span>
                {f.owner && <span className="font-semibold [overflow-wrap:anywhere]">{f.owner}</span>}
                <span className="chip chip-neutral">{t(sourceKey(f.source) as 'source.seed')}</span>
                <span className="text-ink-500">{t('factUses', { n: f.usesCount })}</span>
                <span className="ml-auto">
                  <RetireButton factId={f.id} />
                </span>
              </div>
              {f.question && <p className="text-sm font-semibold [overflow-wrap:anywhere]">{f.question}</p>}
              <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{f.answer}</p>
              <FactEditor factId={f.id} question={f.question} answer={f.answer} />
            </article>
          ))
        )}
      </section>
      {retired > 0 && <p className="text-xs text-ink-500">{t('factsRetired', { n: retired })}</p>}
    </>
  );
}

/** A lesson's place, by colour — literal classes, so Tailwind sees them. */
const LESSON_CHIP = {
  in: 'chip chip-brand',
  left: 'chip chip-warn',
  off: 'chip chip-neutral',
  unconfirmed: 'chip chip-warn',
} as const;

/**
 * «Saboqlar» (0148, spec SPEC-P1-v2 §3.6): what he taught the AI with «📝 Tuzatish» — every lesson, newest first,
 * each marked by whether the prompt carries it today («promptda»), fell past the cap («sig'madi»), is switched off,
 * or was typed in the bot and never confirmed. The cap and what a lesson costs are said here, where he decides how
 * many to keep; a new lesson is given on a card, where the mistake is.
 */
async function LessonsSection({ t }: { t: T }) {
  const data = await webLessons();
  // 0148 has not landed: there are no lessons and the prompt reads none — said, never a 42P01.
  if (!data) {
    return (
      <p className="card text-sm text-warn" data-testid="agent-lessons-not-ready">
        {t('lessonsNotReady')}
      </p>
    );
  }
  const stateOf = (l: (typeof data.lessons)[number]) => (!l.confirmed ? 'unconfirmed' : !l.active ? 'off' : l.inPrompt ? 'in' : 'left');
  const LABEL = { in: t('lessonInPrompt'), left: t('lessonLeft'), off: t('lessonOff'), unconfirmed: t('lessonUnconfirmed') } as const;
  return (
    <>
      <p className="text-sm text-ink-500">{t('lessonsHint')}</p>
      <section className="card space-y-1" data-testid="agent-lessons-cap">
        <p className="text-sm font-semibold" data-testid="agent-lessons-count">
          {t('lessonsCount', { n: data.inPrompt, max: LESSON_LIMITS.promptCount, chars: data.chars, maxChars: LESSON_LIMITS.promptChars })}
        </p>
        <p className="text-xs text-ink-500">{t('lessonsCost', { max: LESSON_LIMITS.promptCount, maxChars: LESSON_LIMITS.promptChars })}</p>
      </section>
      <section className="space-y-2" data-testid="agent-lessons">
        {data.lessons.length === 0 ? (
          <Empty text={t('lessonsEmpty')} testId="agent-lessons-empty" />
        ) : (
          data.lessons.map((l) => {
            const state = stateOf(l);
            return (
              <article key={l.id} className="card space-y-1" data-testid="agent-lesson" data-lesson-id={l.id}>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className={LESSON_CHIP[state]} data-testid="agent-lesson-state" data-state={state}>
                    {LABEL[state]}
                  </span>
                  <span className="min-w-0 text-ink-500 [overflow-wrap:anywhere]">
                    {t('lessonBy', { name: l.createdByName, when: tashkentWhen(l.createdAt) })}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]" data-testid="agent-lesson-text-shown">
                  {l.text}
                </p>
                {state === 'unconfirmed' && <p className="text-xs text-warn">{t('lessonUnconfirmedHint')}</p>}
                {state === 'left' && <p className="text-xs text-warn">{t('lessonLeftHint')}</p>}
                <LessonEditor lessonId={l.id} text={l.text} active={l.active} confirmed={l.confirmed} />
              </article>
            );
          })
        )}
      </section>
    </>
  );
}

async function SettingsSection({
  t,
  config,
  running,
  actor,
  owner,
}: {
  t: T;
  config: AgentConfig;
  running: boolean;
  actor: { id: string; roles: readonly string[] };
  owner: Awaited<ReturnType<typeof ownerAccountState>>;
}) {
  const superAdmin = actor.roles.includes('super_admin');
  const [today, calcs, mismatch, stats, ownerName, candidates, auto, caps] = await Promise.all([
    agentToday(config),
    openCalcsFor(config.ownerUserId),
    tariffMismatchSeen(),
    webStats(),
    userName(config.ownerUserId),
    superAdmin ? ownerCandidates() : Promise.resolve([]),
    // Null one migration behind 0145: no panel, and the page is today's.
    autoPanel(actor, config.ownerUserId),
    // Today's constants one migration behind 0148 (`ready` false: no form).
    readSendCaps(),
  ]);
  // Asked only where 0148 has landed: one migration behind there is no ✅ to keep (the card is not drawn).
  const tariff = caps.ready
    ? { unconfirmed: await tariffUnconfirmed(new Date()), fingerprint: await currentTariffFingerprint() }
    : { unconfirmed: true, fingerprint: '' };
  const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)} %`);
  const holder = actor.id === config.ownerUserId;
  const proposal = config.styleGuideProposed?.trim() ?? '';
  const guide = config.styleGuide?.trim() ?? '';

  return (
    <div className="space-y-3" data-testid="agent-settings">
      <section className="card space-y-2" data-testid="agent-state">
        <h2 className="section-title">{t('stateTitle')}</h2>
        <Line
          label={t('stateLabel')}
          value={running ? `🤖 ${t('stateRunning')}` : `⏹ ${t('stateOff')}`}
          tone={running ? 'text-good' : 'text-ink-700'}
        />
        <Line label={t('ownerLabel')} value={ownerName ?? t('ownerNone')} />
        <Line
          label={t('sessionLabel')}
          value={config.sessionExclusiveAt ? `✅ ${tashkentWhen(config.sessionExclusiveAt)}` : t('sessionNotYet')}
          tone={config.sessionExclusiveAt ? 'text-good' : 'text-warn'}
        />
        {/* Said whenever an owner is set, not only while running: «is the
            listener current» is a question to answer BEFORE switching on. */}
        {/* A signed-out owner first: the listener runs only on connected accounts, so «not updated» would send him
            to rebuild a container that is fine (2026-11-14, his server). */}
        {owner && !owner.connected ? (
          <p className="text-sm font-semibold text-warn" data-testid="agent-owner-signed-out">
            ⚠ {t('ownerSignedOut')}
          </p>
        ) : (
          owner &&
          owner.listenerBehind && (
            <p className="text-sm font-semibold text-warn" data-testid="agent-listener-behind">
              ⚠ {t('listenerBehind')}
            </p>
          )
        )}
        {owner?.floodUntil && owner.floodActive && (
          <p className="text-sm text-warn">⏳ {t('floodUntil', { when: tashkentWhen(owner.floodUntil) })}</p>
        )}
        {running ? (
          <ModeSwitch running />
        ) : holder ? (
          <ModeSwitch running={false} />
        ) : (
          <p className="text-xs text-ink-500" data-testid="agent-on-holder-only">
            {t('onHolderOnly')}
          </p>
        )}
      </section>

      {auto && (
        <AutoSection
          t={t}
          auto={auto}
          viewerId={actor.id}
          holder={holder}
          mayDisarm={holder || superAdmin}
          running={running}
        />
      )}

      {!config.sessionExclusiveAt && config.ownerUserId && (
        <section className="card space-y-2" data-testid="agent-session">
          <h2 className="section-title">{t('sessionTitle')}</h2>
          <p className="text-sm text-ink-500">{t('sessionHint')}</p>
          <SessionConfirm />
        </section>
      )}

      {superAdmin && (
        <section className="card space-y-2" data-testid="agent-owner">
          <h2 className="section-title">{t('ownerTitle')}</h2>
          <p className="text-sm text-ink-500">{running ? t('ownerTurnOffFirst') : t('ownerHint')}</p>
          {!running && (
            <OwnerPicker
              options={[
                // The current owner whose Telegram has since disconnected is not a
                // candidate any more — still drawn, or the select would show
                // «not chosen» over an account that IS chosen.
                ...(config.ownerUserId && !candidates.some((c) => c.id === config.ownerUserId)
                  ? [{ id: config.ownerUserId, label: `${ownerName ?? '—'} · ${t('ownerDisconnected')}` }]
                  : []),
                ...candidates.map((c) => ({ id: c.id, label: `${c.name} · ${c.tgPhone}` })),
              ]}
              current={config.ownerUserId}
            />
          )}
        </section>
      )}

      <section className="card space-y-2" data-testid="agent-today">
        <h2 className="section-title">{t('todayTitle')}</h2>
        <Line label={t('todayRuns')} value={`${today.runs} / ${config.dailyDraftCap}`} tone={today.runs >= config.dailyDraftCap ? 'text-bad' : ''} />
        <Line label={t('todayDrafts')} value={today.drafts} />
        <Line
          label={t('todayTokens')}
          value={`${today.tokens.toLocaleString('ru-RU')} / ${config.dailyTokenCap.toLocaleString('ru-RU')}`}
          tone={today.tokens >= config.dailyTokenCap ? 'text-bad' : ''}
        />
        <Line
          label={t('todaySends')}
          // No ceiling before the first switch-on (the ramp counts from it).
          value={config.ownerUserId && config.startedAt ? `${today.sends} / ${today.sendCeiling}` : '—'}
          tone={config.ownerUserId && config.startedAt && today.sends >= today.sendCeiling ? 'text-bad' : ''}
        />
        {today.errors > 0 && <Line label={t('todayErrors')} value={today.errors} tone="text-warn" />}
        <Line
          label={t('openCalcs')}
          value={<span data-testid="agent-open-calcs">{`${calcs.open} / ${calcs.cap}`}</span>}
          tone={calcs.open >= calcs.cap ? 'text-bad' : ''}
        />
        {mismatch && (
          <p className="text-sm font-semibold text-warn" data-testid="agent-tariff-mismatch">
            ⚠ {t('tariffMismatch')}
          </p>
        )}
      </section>

      <section className="card space-y-2" data-testid="agent-numbers-card">
        <h2 className="section-title">{t('numbersTitle')}</h2>
        <NumbersForm
          humanPauseMin={config.humanPauseMin}
          dailyDraftCap={config.dailyDraftCap}
          dailyTokenCap={config.dailyTokenCap}
        />
      </section>

      {/* The account-protection limits (0148) — only where the side table exists; one migration behind, the constants. */}
      {caps.ready && (
        <section className="card space-y-2" data-testid="agent-caps">
          <h2 className="section-title">{t('capsTitle')}</h2>
          <p className="text-xs text-ink-500">
            {t('capsHint', {
              day: AGENT_LIMITS.perDay,
              hour: AGENT_LIMITS.perHour,
              dayMax: SEND_CAP_BOUNDS.day.max,
              hourMax: SEND_CAP_BOUNDS.hour.max,
            })}
          </p>
          <p className="text-sm" data-testid="agent-caps-now">
            {t('capsNow', { day: caps.dayCap, hour: caps.hourCap })}
          </p>
          <SendCapsForm stored={caps.stored} editable={holder || superAdmin} bounds={{ dayMax: SEND_CAP_BOUNDS.day.max, hourMax: SEND_CAP_BOUNDS.hour.max }} />
          {/* The China column he vouched for (0148, spec §1.6): estimate replies wait for his ✅ after it changes. */}
          <div className="space-y-1 border-t border-line pt-2" data-testid="agent-tariff">
            <p className="text-sm" data-testid="agent-tariff-state">
              {tariff.unconfirmed
                ? t('tariffUnconfirmed')
                : t('tariffConfirmed', { when: caps.tariffConfirmedAt ? tashkentWhen(caps.tariffConfirmedAt) : '—' })}
            </p>
            <p className="text-xs text-ink-500">{t('tariffHint', { date: SITE_TARIFF.validThrough.split('-').reverse().join('.') })}</p>
            {(holder || superAdmin) && <TariffConfirmButton seen={tariff.fingerprint} />}
          </div>
        </section>
      )}

      <section className="card space-y-2" data-testid="agent-stats">
        <h2 className="section-title">{t('statsTitle')}</h2>
        <p className="text-xs text-ink-500">{t('statsHint')}</p>
        <Line label={t('statsRate')} value={<span data-testid="agent-stats-rate">{pct(stats.rate)}</span>} />
        <Line label={t('statsDecided')} value={stats.decided} />
        <Line label={t('statsSentUnchanged')} value={stats.sentUnchanged} />
        <Line label={t('statsSentEdited')} value={stats.sentEdited} />
        <Line label={t('statsRejected')} value={stats.rejected} />
        <Line label={t('statsHimself')} value={stats.answeredHimself} />
        {stats.autoSent > 0 && <Line label={t('statsAutoSent')} value={stats.autoSent} />}
        {/* Written to his own answer or lesson (spec §3.7): approved unchanged by construction — never in the rate. */}
        {stats.ownerTriggered > 0 && <Line label={t('statsOwnerTriggered')} value={stats.ownerTriggered} />}
        <p className="pt-1 text-xs text-ink-500">
          {t('statsBeside', {
            superseded: stats.superseded,
            expired: stats.expired,
            notSent: stats.approvedNotSent,
            onTheWay: stats.onTheWay,
            price: stats.price,
            live: stats.live,
          })}
        </p>
        {Object.keys(stats.byCategory).length > 0 && (
          <div className="space-y-1 border-t border-line pt-2">
            {Object.entries(stats.byCategory).map(([category, c]) => (
              <Line
                key={category}
                label={t(categoryKey(category) as 'category.other')}
                value={`${pct(c.rate)} · ${c.sentUnchanged}/${c.decided}`}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card space-y-2" data-testid="agent-style">
        <h2 className="section-title">{t('styleTitle')}</h2>
        {guide ? (
          <>
            <p className="text-xs text-ink-500">
              {t('styleApprovedAt', { when: config.styleApprovedAt ? tashkentWhen(config.styleApprovedAt) : '—' })}
            </p>
            <pre className="whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]" data-testid="agent-style-guide">
              {guide}
            </pre>
          </>
        ) : (
          <p className="text-sm text-ink-500">{t('styleNone')}</p>
        )}
        {proposal && proposal !== guide ? (
          <div className="space-y-2 border-t border-line pt-2" data-testid="agent-style-proposal">
            <h3 className="text-sm font-bold">{t('styleProposed')}</h3>
            <pre className="whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]">{proposal}</pre>
            <StyleApprove />
          </div>
        ) : (
          <p className="text-xs text-ink-500">{t('styleHowTo')}</p>
        )}
      </section>

    </div>
  );
}

/** A machine-approved reply's place, by colour — literal classes, so Tailwind sees them (#1203's rule). */
const DELIVERY_TONE: Record<AutoSentRow['delivery'], string> = {
  sent: 'text-good',
  going: 'text-ink-700',
  unclear: 'text-warn',
};

/** «2 daqiqa» / «90 soniya» — the hold as he reads it. */
function holdWords(t: T, sec: number): string {
  return sec % 60 === 0 ? t('autoHoldMin', { n: sec / 60 }) : t('autoHoldSec', { n: sec });
}

/**
 * «🤖 O‘zi yuborish» (docs/AI-SOTUVCHI.md §18.3, his answer of 2026-11-11): a
 * layer over the shadow mode — whether it is armed and since when, why it was
 * last switched off, the numbers the press keeps, which kinds go by
 * themselves, today's count, and what the machine sent (with his 👎). Every
 * number is `autoPanel`'s, i.e. the rows the press and the gate write.
 */
function AutoSection({
  t,
  auto,
  viewerId,
  holder,
  mayDisarm,
  running,
}: {
  t: T;
  auto: AutoPanel;
  viewerId: string;
  holder: boolean;
  mayDisarm: boolean;
  running: boolean;
}) {
  const c = auto.config;
  const off = autoDisarmKey(c.disarmReason);
  return (
    <section className="card space-y-2" data-testid="agent-auto">
      <h2 className="section-title">🤖 {t('autoTitle')}</h2>
      <p className="text-xs text-ink-500">{t('autoHint')}</p>
      <Line
        label={t('autoStateLabel')}
        value={
          <span data-testid="agent-auto-state">
            {/* Armed on a number nothing can go from is never a green ✅ (fix pass B, C9): the line below says why. */}
            {c.armed
              ? `${auto.workAccount ? '✅' : '⚠'} ${t('autoArmedValue', { when: c.armedAt ? tashkentWhen(c.armedAt) : '—', name: auto.armedByName ?? '—' })}`
              : `⏹ ${t('autoOffValue')}`}
          </span>
        }
        tone={c.armed ? (auto.workAccount ? 'text-good' : 'text-warn') : 'text-ink-700'}
      />
      {!c.armed && off && c.disarmedAt && (
        <p className="text-xs text-ink-500 [overflow-wrap:anywhere]" data-testid="agent-auto-last-off">
          {t('autoLastOff', { reason: t(off as 'autoOff.manual'), when: tashkentWhen(c.disarmedAt) })}
        </p>
      )}
      <p className="text-xs text-ink-500" data-testid="agent-auto-numbers">
        {/* No daily count is said as such (0148, his «7 chegara qoyma») — never «at most 0 a day». */}
        {c.perDay === null
          ? t('autoNumbersNoCap', { hold: holdWords(t, c.holdSec), maxChars: c.maxChars, confidence: Math.round(c.minConfidence * 100) })
          : t('autoNumbers', {
              hold: holdWords(t, c.holdSec),
              perDay: c.perDay,
              maxChars: c.maxChars,
              confidence: Math.round(c.minConfidence * 100),
            })}
      </p>
      {/* Armed on a number that is not «Ish raqami» (fix pass B, C9): the gate refuses every reply — the switch
          must not read «yoqilgan» as if something could go. */}
      {c.armed && !auto.workAccount && (
        <p className="text-sm font-semibold text-warn [overflow-wrap:anywhere]" data-testid="agent-auto-not-work">
          ⚠ {t('autoArmedNotWork')}
        </p>
      )}
      {/* What arming would refuse, said BEFORE the press — and the button is not offered until it can arm. */}
      {!c.armed && holder && !running && (
        <p className="text-xs font-semibold text-warn" data-testid="agent-auto-needs-running">
          {t('autoNeedsRunning')}
        </p>
      )}
      {!c.armed && holder && !auto.workAccount && (
        <p className="text-xs font-semibold text-warn [overflow-wrap:anywhere]" data-testid="agent-auto-needs-work">
          {t('autoNeedsWork')}
        </p>
      )}
      <AutoArmButtons armed={c.armed} canArm={holder} canDisarm={mayDisarm} armBlocked={!running || !auto.workAccount} />
      <div className="border-t border-line pt-2">
        {/* «Narx» is a box only where 0148's CHECK admits it — one migration behind, the four. */}
        <AutoCategoriesForm
          current={c.categories}
          editable={holder}
          kinds={auto.fullReady ? AUTO_SEND_CATEGORIES : AUTO_SEND_CATEGORIES.filter((k) => k !== 'price')}
        />
      </div>
      {auto.fullReady && (
        <div className="border-t border-line pt-2">
          <AutoPerDayForm current={c.perDay} editable={holder} max={AUTO_PER_DAY_MAX} />
        </div>
      )}
      <p className="border-t border-line pt-2 text-sm [overflow-wrap:anywhere]" data-testid="agent-auto-today">
        {t('autoToday', { sent: auto.today.sent, paused: auto.today.paused, left: auto.today.left })}
        {auto.today.waiting > 0 ? ` · ${t('autoTodayWaiting', { n: auto.today.waiting })}` : ''}
        {/* «O‘zi yubordi» is what went (fix pass B, C6) — approved and still on its way, or not known to have
            arrived, said apart. */}
        {auto.today.going > 0 ? ` · ${t('autoTodayGoing', { n: auto.today.going })}` : ''}
        {auto.today.unclear > 0 ? ` · ${t('autoTodayUnclear', { n: auto.today.unclear })}` : ''}
      </p>
      <div className="space-y-2 border-t border-line pt-2" data-testid="agent-auto-sent">
        <h3 className="text-sm font-bold">{t('autoSentTitle')}</h3>
        {auto.sent.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="agent-auto-sent-empty">
            {t('autoSentEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {auto.sent.map((row) => (
              <li key={row.draftId} className="space-y-1 rounded-lg bg-surface-sunken p-2" data-testid="agent-auto-sent-row">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-ink-500">
                  <span className="min-w-0 font-semibold text-ink-700 [overflow-wrap:anywhere]">{row.customerLabel}</span>
                  <span>{tashkentWhen(row.pressedAt)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{row.text}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={`font-semibold ${DELIVERY_TONE[row.delivery]}`}
                    data-testid="agent-auto-delivery"
                    data-delivery={row.delivery}
                  >
                    {row.delivery === 'sent'
                      ? `✅ ${t('autoRowSent', { when: row.sentAt ? tashkentWhen(row.sentAt) : '—' })}`
                      : row.delivery === 'going'
                        ? `⏳ ${t('autoRowGoing')}`
                        : `❓ ${t('autoRowUnclear')}`}
                  </span>
                  {row.bad ? (
                    <span className="font-semibold text-bad" data-testid="agent-auto-marked-bad">
                      👎 {t('autoBadGiven')}
                    </span>
                  ) : (
                    row.managerUserId === viewerId && <AutoBadButton draftId={row.draftId} />
                  )}
                  {row.chatHref && (
                    <Link href={row.chatHref} className="ml-auto font-semibold text-brand-700 underline">
                      {t('openChat')}
                    </Link>
                  )}
                </div>
                {/* Why it was wrong — a lesson for every later reply; a reply that went is never rewritten. */}
                <LessonButton draftId={row.draftId} teach rewrites={false} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
