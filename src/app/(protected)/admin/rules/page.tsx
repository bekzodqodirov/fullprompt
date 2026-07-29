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
    if (rule.triggerType === 'lead_stage') {
      return `${t('triggerLeadStage')}: ${leadNames.get(rule.triggerStageId ?? '') ?? '—'}`;
    }
    if (rule.triggerType === 'deal_stage') {
      return `${t('triggerDealStage')}: ${dealNames.get(rule.triggerStageId ?? '') ?? '—'}`;
    }
    const event = rule.triggerEvent ?? '';
    return (RULE_EVENTS as readonly string[]).includes(event)
      ? t(`events.${event}` as 'events.ReceiptConfirmed')
      : event;
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
          leadStages={leadStages.map((s) => ({ id: s.id, name: s.name }))}
          dealStages={dealStages.map((s) => ({ id: s.id, name: s.name }))}
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
