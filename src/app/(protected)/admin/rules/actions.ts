'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  AutomationError,
  deleteRule,
  ruleSchema,
  saveRule,
  setRuleActive,
} from '@/modules/platform/automation/service';

export interface RuleFormState {
  ok?: boolean;
  error?: string;
}

/** Every refusal the schema raises that has words in all four bundles. */
const KNOWN_REFUSALS = [
  'trigger_target_required',
  'stale_days_required',
  'condition_field_invalid',
  'action_config_invalid',
] as const;
const isKnownRefusal = (message: string): message is (typeof KNOWN_REFUSALS)[number] =>
  (KNOWN_REFUSALS as readonly string[]).includes(message);

/**
 * Gated like the settings screen, not with a freshly minted permission code:
 * a new code would reach the owner's own customised roles only by hand
 * (#170), and "who may change how the system behaves" already has an answer.
 */
async function ctx() {
  const actor = await authorize('admin.settings.manage');
  return { actorId: actor.id, ...(await requestMeta()) };
}

const num = (value: FormDataEntryValue | null): number | null => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The condition rows arrive as three parallel lists and are zipped by
 * POSITION, which is only sound because every box in a row posts — the value
 * input is read-only, never disabled, exactly so this alignment holds (#171).
 * A row whose field never made it is dropped rather than guessed at; the
 * service validates the field name again against the trigger's board.
 */
const conditionsFrom = (form: FormData) => {
  const fields = form.getAll('condField').map(String);
  const ops = form.getAll('condOp').map(String);
  const values = form.getAll('condValue').map(String);
  return fields
    .map((field, i) => ({ field, op: ops[i] ?? '', value: values[i] ?? '' }))
    .filter((row) => row.field && row.op);
};

export async function saveRuleAction(
  _prev: RuleFormState,
  form: FormData,
): Promise<RuleFormState> {
  const actionType = String(form.get('actionType') ?? '');
  const actionConfig =
    actionType === 'create_task'
      ? {
          title: String(form.get('taskTitle') ?? ''),
          assignee: String(form.get('assignee') ?? ''),
          dueDays: num(form.get('dueDays')),
          priority: num(form.get('priority')) ?? 2,
        }
      : {
          userIds: form.getAll('notifyUser').map(String).filter(Boolean),
          text: String(form.get('notifyText') ?? ''),
        };
  const parsed = ruleSchema.safeParse({
    name: String(form.get('name') ?? ''),
    triggerType: String(form.get('triggerType') ?? ''),
    triggerStageId: String(form.get('stageId') ?? '') || null,
    triggerEvent: String(form.get('event') ?? '') || null,
    staleDays: num(form.get('staleDays')),
    conditions: conditionsFrom(form),
    actionType,
    actionConfig,
  });
  if (!parsed.success) {
    // The schema's own refusals are CODES with words of their own — «say how
    // many days» is a fixable complaint, «check the fields» is a shrug. Only
    // the codes the bundles name are passed through, so a zod internal message
    // can never reach `t()` and throw at render (#163).
    const code = parsed.error.issues.map((issue) => issue.message).find(isKnownRefusal);
    return { error: code ?? 'validation' };
  }
  try {
    await saveRule(parsed.data, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof AutomationError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/rules');
  return { ok: true };
}

export async function toggleRuleAction(id: string, active: boolean): Promise<RuleFormState> {
  try {
    await setRuleActive(id, active, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof AutomationError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/rules');
  return { ok: true };
}

export async function deleteRuleAction(id: string): Promise<RuleFormState> {
  try {
    await deleteRule(id, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof AutomationError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/rules');
  return { ok: true };
}
