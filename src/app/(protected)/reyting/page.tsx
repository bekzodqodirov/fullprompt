import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { PageHeader } from '@/components/ui/page';
import { ratingScreen } from '@/modules/wms/staff/rating';
import { deltaText, kgText, kub, monthName, windowLabel, type RatingView } from '@/modules/wms/staff/rating-text';
import type { Standing } from '@/modules/wms/staff/rating-math';

/**
 * «Haftalik reyting» (0134) — the Saturday post, live: the week running now,
 * the last closed week, and the month so far, each per seller in kub · kg ·
 * prixod. The SAME function as the group's post (`ratingViewFor`, over the
 * KPI's own `stampedCargo`), so the screen and the group cannot disagree.
 *
 * A login is the door, the group's own audience: kub is not money (no
 * profit, no KPI dollars, no client), and every colleague reads the group.
 */
export const dynamic = 'force-dynamic';

const MEDAL = ['🥇', '🥈', '🥉'];

function Table({ rows, me, testId }: { rows: (Standing & { before?: number | null })[]; me: string; testId: string }) {
  return (
    <ol className="divide-y divide-line" data-testid={testId}>
      {rows.map((r) => (
        <li
          key={r.userId}
          className={`flex flex-wrap items-baseline gap-x-2 py-1.5 text-sm ${r.userId === me ? 'font-semibold' : ''}`}
          data-testid={`${testId}-row`}
        >
          <span className="w-7 shrink-0 text-center">{r.rank <= 3 ? MEDAL[r.rank - 1] : `${r.rank}.`}</span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{r.name}</span>
          <span className="font-mono tabular-nums">
            {kub(r.m3)} kub · {kgText(r.kg)} kg · {r.receipts}
            {r.before !== undefined ? <span className="text-ink-500">{deltaText(r.m3, r.before)}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function WeekCard({
  title,
  view,
  me,
  testId,
  empty,
  goalWords,
}: {
  title: string;
  view: RatingView;
  me: string;
  testId: string;
  empty: string;
  goalWords: string | null;
}) {
  return (
    <section className="card space-y-2" data-testid={testId}>
      <h2 className="section-title">{title}</h2>
      <p className="text-xs text-ink-500">{windowLabel(view.from, view.to)}</p>
      {view.rows.length === 0 ? <p className="text-sm text-ink-500">{empty}</p> : null}
      <Table rows={view.rows} me={me} testId={`${testId}-table`} />
      <p className="text-sm">
        <span className="font-semibold">Σ</span>{' '}
        <span className="font-mono tabular-nums">
          {kub(view.team.m3)} kub · {kgText(view.team.kg)} kg · {view.team.receipts}
        </span>
      </p>
      {goalWords ? <p className="text-sm" data-testid={`${testId}-goal`}>{goalWords}</p> : null}
    </section>
  );
}

export default async function RatingPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('rating');
  const header = <PageHeader icon="report" title={t('title')} />;

  let data: Awaited<ReturnType<typeof ratingScreen>> | null = null;
  try {
    data = await ratingScreen();
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[rating] screen: server behind');
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {header}
        <p className="card text-sm text-bad">{t('serverBehind')}</p>
      </div>
    );
  }
  const { running, closed, month } = data;
  const goal = running.goalM3;
  const goalWords =
    goal === null
      ? null
      : running.team.m3 >= goal
        ? t('goalDone', { goal: kub(goal) })
        : t('goalProgress', { done: kub(running.team.m3), goal: kub(goal) });
  const monthTeam = month.rows.reduce((s, r) => s + r.m3, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {header}
      <p className="text-sm text-ink-600">{t('intro')}</p>
      <WeekCard
        title={t('running')}
        view={running}
        me={actor.id}
        testId="rating-running"
        empty={t('empty')}
        goalWords={goalWords}
      />
      <WeekCard title={t('closed')} view={closed} me={actor.id} testId="rating-closed" empty={t('empty')} goalWords={null} />
      <section className="card space-y-2" data-testid="rating-month">
        <h2 className="section-title">{t('month', { month: monthName(month.month) })}</h2>
        {month.rows.length === 0 ? <p className="text-sm text-ink-500">{t('empty')}</p> : null}
        <Table rows={month.rows} me={actor.id} testId="rating-month-table" />
        <p className="text-sm">
          <span className="font-semibold">Σ</span> <span className="font-mono tabular-nums">{kub(monthTeam)} kub</span>
        </p>
      </section>
      <p className="text-xs text-ink-500">{t('footnote')}</p>
    </div>
  );
}
