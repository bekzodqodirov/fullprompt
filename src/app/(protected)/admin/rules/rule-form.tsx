'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CONDITION_FIELDS,
  CONDITION_OPS,
  ruleBoard,
  type ConditionOp,
} from '@/modules/platform/automation/conditions';
import { RULE_PLACEHOLDERS } from '@/modules/platform/automation/placeholders';
import { saveRuleAction, type RuleFormState } from './actions';

/**
 * One rule on one form — trigger on the left of the sentence, action on the
 * right, exactly as the owner would say it out loud: «bitim falon bosqichga
 * o'tganda — falonchiga vazifa och». The visual node editor stays cut.
 *
 * Round 86 added the middle of that sentence («…va yuk 5 kubdan katta
 * bo'lsa…») and a second kind of «qachon» — the card that has been sitting
 * still. Conditions are drawn only for a trigger that HAS a card to ask
 * about: a warehouse event is about cargo, and offering it a «lead source»
 * box would be offering a rule that could never fire.
 */

export interface StageOption {
  id: string;
  name: string;
  /**
   * Stamped onto the option as `data-kind`, the vocabulary the boards already
   * use (#59). A rule on a LOST stage is legitimate — «when a deal is lost,
   * tell me» — so this picker offers every stage; what the attribute buys is
   * that a reader, human or spec, can tell WHICH is which without counting
   * positions in a funnel the owner names himself.
   */
  kind: string;
}
export interface UserOption {
  id: string;
  name: string;
}

type TriggerType = 'lead_stage' | 'deal_stage' | 'lead_stale' | 'deal_stale' | 'event';
interface ConditionRow {
  field: string;
  op: ConditionOp;
  value: string;
}

/** The two operators that ask about the box rather than about its contents. */
const noValue = (op: ConditionOp) => op === 'empty' || op === 'not_empty';

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
  const [triggerType, setTriggerType] = useState<TriggerType>('deal_stage');
  const [actionType, setActionType] = useState<'create_task' | 'notify'>('create_task');
  const [conditions, setConditions] = useState<ConditionRow[]>([]);

  const board = ruleBoard(triggerType);
  const stages = board === 'lead' ? leadStages : dealStages;
  const isStale = triggerType === 'lead_stale' || triggerType === 'deal_stale';
  const fields: readonly string[] = board ? CONDITION_FIELDS[board] : [];

  const patch = (index: number, part: Partial<ConditionRow>) =>
    setConditions((rows) => rows.map((row, i) => (i === index ? { ...row, ...part } : row)));

  /**
   * Switching the trigger drops the conditions rather than keeping fields the
   * new board cannot answer — the save would refuse them, and a silently
   * invalid row is worse than an empty list the owner refills.
   */
  const changeTrigger = (next: TriggerType) => {
    if (ruleBoard(next) !== board) setConditions([]);
    setTriggerType(next);
  };

  const placeholderHint = t('placeholderHint', {
    list: RULE_PLACEHOLDERS.map((p) => `{${p}}`).join(' '),
  });

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
          onChange={(e) => changeTrigger(e.target.value as TriggerType)}
          aria-label={t('triggerType')}
          data-testid="rule-trigger-type"
          className="input"
        >
          <option value="deal_stage">{t('triggerDealStage')}</option>
          <option value="lead_stage">{t('triggerLeadStage')}</option>
          <option value="deal_stale">{t('triggerDealStale')}</option>
          <option value="lead_stale">{t('triggerLeadStale')}</option>
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
              <option key={stage.id} value={stage.id} data-kind={stage.kind}>
                {stage.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {isStale && (
        <div className="space-y-1">
          <input
            name="staleDays"
            inputMode="numeric"
            defaultValue="3"
            placeholder={t('staleDays')}
            aria-label={t('staleDays')}
            data-testid="rule-stale-days"
            className="input"
          />
          <p className="text-xs text-ink-500">{t('staleHint')}</p>
        </div>
      )}

      {board && (
        <div className="space-y-1.5 rounded-xl border border-line p-2">
          <p className="text-xs font-semibold text-ink-500">{t('conditions')}</p>
          {conditions.map((row, index) => (
            <div
              key={index}
              // A rule of several conditions is three identical boxes per
              // condition; without a line between them the reader cannot see
              // where one ends.
              className={`flex items-start gap-1 ${index > 0 ? 'border-t border-line pt-1.5' : ''}`}
            >
              {/* One control per line (#421). Two side by side at 360 px
                  clipped the field to «Источни…» — and half the list starts
                  with the same word — then clipped the operator to «рав…».
                  Measured in `ru`, which is the default and the longest. */}
              <div className="grid flex-1 grid-cols-1 gap-1">
                <select
                  name="condField"
                  value={row.field}
                  onChange={(e) => patch(index, { field: e.target.value })}
                  aria-label={t('conditionField')}
                  data-testid="rule-cond-field"
                  className="input"
                >
                  {fields.map((field) => (
                    <option key={field} value={field}>
                      {t(`fields.${field}` as 'fields.amount')}
                    </option>
                  ))}
                </select>
                <select
                  name="condOp"
                  value={row.op}
                  onChange={(e) => patch(index, { op: e.target.value as ConditionOp })}
                  aria-label={t('conditionOp')}
                  data-testid="rule-cond-op"
                  className="input"
                >
                  {CONDITION_OPS.map((op) => (
                    <option key={op} value={op}>
                      {t(`ops.${op}` as 'ops.eq')}
                    </option>
                  ))}
                </select>
                <input
                  name="condValue"
                  value={row.value}
                  onChange={(e) => patch(index, { value: e.target.value })}
                  placeholder={t('conditionValue')}
                  aria-label={t('conditionValue')}
                  data-testid="rule-cond-value"
                  /**
                   * `empty` / `not_empty` ask about the box itself, so there
                   * is nothing to type and the box goes away — but by being
                   * HIDDEN, never `disabled`: a disabled input posts NOTHING
                   * (#171) while a `display:none` one still posts, and the
                   * three lists are zipped by position, so one silent gap
                   * would hand the next row somebody else's value. Greying it
                   * out was tried first and read as an ordinary empty box.
                   */
                  readOnly={noValue(row.op)}
                  className={noValue(row.op) ? 'hidden' : 'input'}
                />
              </div>
              <button
                type="button"
                onClick={() => setConditions((rows) => rows.filter((_, i) => i !== index))}
                aria-label={tc('delete')}
                className="btn shrink-0"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setConditions((rows) => [...rows, { field: fields[0] ?? '', op: 'eq', value: '' }])
            }
            data-testid="rule-cond-add"
            className="btn w-full"
          >
            ➕ {t('conditionAdd')}
          </button>
          <p className="text-xs text-ink-500">{t('conditionsHint')}</p>
        </div>
      )}

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
              {/* Nobody CAUSES a silence, so a time trigger has no «whoever did
                  it» to assign to — the option would be a rule that finds no
                  one every hour. */}
              {!isStale && <option value="actor">{t('assigneeActor')}</option>}
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
          {board && <p className="text-xs text-ink-500">{placeholderHint}</p>}
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
            className="input h-28 resize-none"
          />
          <p className="text-xs text-ink-500">{t('notifyHint')}</p>
          {board && <p className="text-xs text-ink-500">{placeholderHint}</p>}
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
