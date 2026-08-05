'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { canReadTg } from '@/modules/wms/crm/conversations';
import {
  SHARE_TEMPLATES_PERMISSION,
  TemplateError,
  deleteTemplate,
  saveTemplate,
} from '@/modules/wms/crm/templates';

export interface TemplateFormState {
  ok?: boolean;
  error?: string;
}

/**
 * The gate is the composer's: whoever may read a conversation may keep their
 * own canned replies for it. Publishing to the COMPANY is checked separately,
 * inside the service, against `admin.settings.manage` — no new permission code
 * was minted (#170: the seed skips a role an admin has edited, which would
 * leave a new code ungrantable on the owner's own database).
 */
async function run(work: (ctx: {
  actorId: string;
  canShare: boolean;
}) => Promise<unknown>): Promise<TemplateFormState> {
  const actor = await getActor();
  if (!actor || !canReadTg(actor)) return { error: 'forbidden' };
  const meta = await requestMeta();
  try {
    await work({
      actorId: actor.id,
      canShare: actor.permissions.has(SHARE_TEMPLATES_PERMISSION),
      ...meta,
    });
  } catch (err) {
    if (err instanceof TemplateError) return { error: err.code };
    throw err;
  }
  revalidatePath('/suhbatlar', 'layout');
  return { ok: true };
}

export async function saveTemplateAction(
  _prev: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const id = String(formData.get('id') ?? '');
  return run((ctx) =>
    saveTemplate(
      {
        ...(id ? { id } : {}),
        title: String(formData.get('title') ?? ''),
        body: String(formData.get('body') ?? ''),
        shared: formData.get('shared') === 'on',
        sortOrder: Number(formData.get('sortOrder') ?? 100) || 100,
      },
      ctx,
    ),
  );
}

export async function deleteTemplateAction(id: string): Promise<TemplateFormState> {
  return run((ctx) => deleteTemplate(id, ctx));
}
