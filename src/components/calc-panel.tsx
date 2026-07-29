import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/panel';
import { formatDue } from '@/modules/platform/tasks/service';
import { openCalcCounts, openCalcFor, vedPeople } from '@/modules/wms/calc/service';
import { CalcForm } from './calc-form';

/**
 * The hisoblash corner of a deal or lead card (round 28).
 *
 * Two states, never both: a live request is a BANNER — who has it, since
 * when, until when, red once late — because a second «give it to VED» while
 * the first is unanswered is a duplicate the service refuses anyway; no live
 * request is the FORM.
 */
export async function CalcPanel({
  entityType,
  entityId,
  revalidate,
  defaultItems = 1,
}: {
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
  defaultItems?: number;
}) {
  const t = await getTranslations('calc');
  const open = await openCalcFor(entityType, entityId);

  if (open) {
    const late = open.late;
    return (
      <section
        className={`card space-y-1 text-sm ${late ? 'border-bad/40 bg-bad/5' : ''}`}
        data-testid="calc-open"
      >
        <p className="section-title">🧮 {t('title')}</p>
        <p className={late ? 'font-semibold text-bad' : ''}>
          {late ? `🔴 ${t('late')}` : `⏱ ${t('inProgress')}`} — {open.assigneeName} (
          {open.itemCount})
        </p>
        <p className="text-xs text-ink-500">
          {t('askedAt')}: {formatDue(open.requestedAt, false)} · {t('dueBy')}:{' '}
          {formatDue(open.dueAt, false)}
        </p>
      </section>
    );
  }

  const [people, counts] = await Promise.all([vedPeople(), openCalcCounts()]);
  return (
    <Panel title={`🧮 ${t('title')}`} testId="calc-panel">
      <CalcForm
        entityType={entityType}
        entityId={entityId}
        revalidate={revalidate}
        people={people.map((person) => ({ ...person, open: counts.get(person.id) ?? 0 }))}
        defaultItems={defaultItems}
      />
    </Panel>
  );
}
