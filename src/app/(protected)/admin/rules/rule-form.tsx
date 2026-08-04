'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveRuleAction, type RuleFormState } from './actions';

/**
 * One rule on one form — trigger on the left of the sentence, action on the
 * right, exactly as the owner would say it out loud: «bitim falon bosqichga
 * o'tganda — falonchiga vazifa och». The visual node editor stays cut.
 */

export interface StageOption {
  id: string;
  name: string;
}
export interface UserOption {
  id: string;
  name: string;
}

export function RuleForm({
  leadStages,
  dealStages,
  events,
  users,
}: {
  leadStages: StageOption[];
  dealStages: StageOption[];
  events: string[];
  users: UserOption[];
}) {
  const t = useTranslations('automation');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<RuleFormState, FormData>(saveRuleAction, {});
  const [triggerType, setTriggerType] = useState<'lead_stage' | 'deal_stage' | 'event'>('deal_stage');
  const [actionType, setActionType] = useState<'create_task' | 'notify'>('create_task');

  const stages = triggerType === 'lead_stage' ? leadStages : dealStages;

  return (
    <form action={formAction} className="space-y-2" data-testid="rule-form">
      <input
        name="name"
        placeholder={t('name')}
        aria-label={t('name')}
        data-testid="rule-name"
        className="input"
      />

      <div className="grid grid-cols-2 gap-1.5">
        <select
          name="triggerType"
          value={triggerType}
          onChange={(e) => setTriggerType(e.target.value as typeof triggerType)}
          aria-label={t('triggerType')}
          data-testid="rule-trigger-type"
          className="input"
        >
          <option value="deal_stage">{t('triggerDealStage')}</option>
          <option value="lead_stage">{t('triggerLeadStage')}</option>
          <option value="event">{t('triggerEvent')}</option>
        </select>
        {triggerType === 'event' ? (
          <select name="event" aria-label={t('event')} data-testid="rule-event" className="input">
            {events.map((event) => (
              <option key={event} value={event}>
                {t(`events.${event}` as 'events.ReceiptConfirmed')}
              </option>
            ))}
          </select>
        ) : (
          <select name="stageId" aria-label={t('stage')} data-testid="rule-stage" className="input">
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <select
        name="actionType"
        value={actionType}
        onChange={(e) => setActionType(e.target.value as typeof actionType)}
        aria-label={t('actionType')}
        data-testid="rule-action-type"
        className="input"
      >
        <option value="create_task">{t('actionTask')}</option>
        <option value="notify">{t('actionNotify')}</option>
      </select>

      {actionType === 'create_task' ? (
        <div className="space-y-1.5">
          <input
            name="taskTitle"
            placeholder={t('taskTitle')}
            aria-label={t('taskTitle')}
            data-testid="rule-task-title"
            className="input"
          />
          <div className="grid grid-cols-3 gap-1.5">
            <select
              name="assignee"
              aria-label={t('assignee')}
              data-testid="rule-assignee"
              className="input col-span-1"
            >
              <option value="owner">{t('assigneeOwner')}</option>
              <option value="actor">{t('assigneeActor')}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <input
              name="dueDays"
              inputMode="numeric"
              placeholder={t('dueDays')}
              aria-label={t('dueDays')}
              data-testid="rule-due-days"
              className="input"
            />
            <select name="priority" aria-label={t('priority')} defaultValue="2" className="input">
              <option value="1">{t('priorityLow')}</option>
              <option value="2">{t('priorityNormal')}</option>
              <option value="3">{t('priorityHigh')}</option>
            </select>
          </div>
          <p className="text-xs text-ink-500">{t('taskHint')}</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
            {users.map((user) => (
              <label key={user.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="notifyUser" value={user.id} className="h-4 w-4" />
                {user.name}
              </label>
            ))}
          </div>
          <textarea
            name="notifyText"
            placeholder={t('notifyText')}
            aria-label={t('notifyText')}
            data-testid="rule-notify-text"
            rows={2}
            className="input resize-none"
          />
          <p className="text-xs text-ink-500">{t('notifyHint')}</p>
        </div>
      )}

      <button type="submit" disabled={pending} data-testid="save-rule" className="btn-primary w-full">
        {pending ? tc('loading') : state.ok ? '✅' : t('saveRule')}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}
    </form>
  );
}
