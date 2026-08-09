import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader, Section } from '@/components/ui/page';
import { Panel } from '@/components/panel';
import {
  RULE_EVENTS,
  listRules,
  type RuleRow,
} from '@/modules/platform/automation/service';
import { conditionsSchema, ruleBoard } from '@/modules/platform/automation/conditions';
import { listStages as listLeadStages } from '@/modules/wms/crm/service';
import { listStages as listDealStages } from '@/modules/wms/deals/service';
import { RuleForm } from './rule-form';
import { RuleList, type RuleView } from './rule-list';

/**
 * Phase 7: the owner writes «when X, do Y» on a form and the system starts
 * doing it. The screen shows every rule as the sentence it is, with how many
 * times it has actually fired — a rule that never fires is a typo, and the
 * counter is how the owner finds out.
 */
export default async function RulesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('admin.settings.manage')) redirect('/');

  const t = await getTranslations('automation');
  const [rules, leadStages, dealStages, people] = await Promise.all([
    listRules(),
    listLeadStages(),
    listDealStages(),
    db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(eq(users.active, true))
      .orderBy(asc(users.fullName)),
  ]);

  const leadNames = new Map(leadStages.map((s) => [s.id, s.name]));
  const dealNames = new Map(dealStages.map((s) => [s.id, s.name]));
  const userNames = new Map(people.map((p) => [p.id, p.name]));

  const triggerLabel = (rule: RuleRow): string => {
    const stageName =
      (ruleBoard(rule.triggerType) === 'lead' ? leadNames : dealNames).get(
        rule.triggerStageId ?? '',
      ) ?? '—';
    switch (rule.triggerType) {
      case 'lead_stage':
        return `${t('triggerLeadStage')}: ${stageName}`;
      case 'deal_stage':
        return `${t('triggerDealStage')}: ${stageName}`;
      case 'lead_stale':
      case 'deal_stale':
        return `${t(
          rule.triggerType === 'lead_stale' ? 'triggerLeadStale' : 'triggerDealStale',
        )}: ${stageName} · ${t('staleFor', { days: rule.staleDays ?? 0 })}`;
      default: {
        const event = rule.triggerEvent ?? '';
        return (RULE_EVENTS as readonly string[]).includes(event)
          ? t(`events.${event}` as 'events.ReceiptConfirmed')
          : event;
      }
    }
  };

  /**
   * A rule that quietly filters is a rule the owner will one day accuse of
   * not working, so the conditions are printed on the row that says what it
   * does — not hidden behind an edit screen this page does not have.
   */
  const conditionLabel = (rule: RuleRow): string | null => {
    const parsed = conditionsSchema.safeParse(rule.conditions ?? []);
    if (!parsed.success || parsed.data.length === 0) return null;
    return parsed.data
      .map((cond) => {
        const field = t(`fields.${cond.field}` as 'fields.amount');
        const op = t(`ops.${cond.op}` as 'ops.eq');
        return cond.op === 'empty' || cond.op === 'not_empty'
          ? `${field} ${op}`
          : `${field} ${op} ${cond.value}`;
      })
      .join(' · ');
  };
  const actionLabel = (rule: RuleRow): string => {
    const config = rule.actionConfig as Record<string, unknown>;
    if (rule.actionType === 'create_task') {
      const assignee =
        config.assignee === 'owner'
          ? t('assigneeOwner')
          : config.assignee === 'actor'
            ? t('assigneeActor')
            : (userNames.get(String(config.assignee)) ?? '—');
      return `${t('actionTask')} «${String(config.title ?? '')}» → ${assignee}`;
    }
    const names = Array.isArray(config.userIds)
      ? config.userIds.map((id) => userNames.get(String(id)) ?? '—').join(', ')
      : '';
    return `${t('actionNotify')} → ${names}`;
  };

  const views: RuleView[] = rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    active: rule.active,
    triggerLabel: triggerLabel(rule),
    conditionLabel: conditionLabel(rule),
    actionLabel: actionLabel(rule),
    fireCount: rule.fireCount,
    lastFiredAt: rule.lastFiredAt ? rule.lastFiredAt.toISOString().slice(0, 16).replace('T', ' ') : null,
  }));

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader icon="target" back={{ href: '/admin', label: t('backToAdmin') }} title={t('title')} />
      <p className="text-sm text-ink-500">{t('intro')}</p>

      <Panel title={`➕ ${t('newRule')}`} testId="new-rule-panel" open={rules.length === 0}>
        <RuleForm
          leadStages={leadStages.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))}
          dealStages={dealStages.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))}
          events={[...RULE_EVENTS]}
          users={people}
        />
      </Panel>

      <Section title={t('listTitle')}>
        <RuleList rules={views} />
      </Section>
    </div>
  );
}
