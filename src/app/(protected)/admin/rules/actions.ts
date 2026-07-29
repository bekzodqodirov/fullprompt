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
    actionType,
    actionConfig,
  });
  if (!parsed.success) return { error: 'validation' };
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
